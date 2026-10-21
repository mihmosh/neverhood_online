import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const usage = 'Usage: node [--env-file=PRIVATE_ENV_PATH] seedvr2-replicate-probe.mjs inspect|run|papina --base PRIVATE_DIRECTORY [--allow-paid]';
const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { base: { type: 'string' }, 'allow-paid': { type: 'boolean', default: false }, help: { type: 'boolean' } }, allowPositionals: true });
if (values.help) {
  console.log(`${usage}\n--base defaults only to NEVERHOOD_SEEDVR2_PROBE_DIR. Token: REPLICATE_API_TOKEN environment only.\ninspect contacts the API without predictions; run/papina require --allow-paid (maximum 3/1 slots).\nNo mode is selected automatically. --help reads no experiment data and makes no network request.`);
  process.exit(0);
}
const mode = positionals[0];
if (positionals.length !== 1 || !['inspect', 'run', 'papina'].includes(mode)) throw new Error(usage);
if (mode !== 'inspect' && !values['allow-paid']) throw new Error('Paid prediction creation requires explicit --allow-paid; no request was sent.');
const configured = values.base || process.env.NEVERHOOD_SEEDVR2_PROBE_DIR;
if (!configured) throw new Error('Supply --base or NEVERHOOD_SEEDVR2_PROBE_DIR; there is no source-tree default.');
const base = resolve(configured);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const inside = (root, path) => path === root || path.startsWith(root + sep);
const resolvedBase = await realpath(base);
if (resolvedBase !== base || inside(repo, base) || base.split(sep).some(part => ['public', 'www', 'wwwroot', 'htdocs'].includes(part.toLowerCase()))) throw new Error('Base must be an existing canonical private directory outside source/public trees.');
// Reject symlinked write directories/files before any API call, including inspect.
async function privatePath(path) {
  if (!inside(base, path) || path === base) throw new Error('Path escapes private base');
  let current = path;
  while (current !== base) {
    try { if (await realpath(current) !== current) throw new Error('Symlinked experiment path is not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
  return path;
}
await privatePath(resolve(base, 'runs/model.json'));
for (const name of ['A-3b', 'B-7b', 'C-3b-colorfix', 'D-papina-7b']) {
  for (const file of ['request.json', 'prediction.json', 'output.mp4', 'result.json']) await privatePath(resolve(base, 'runs', name, file));
}
await privatePath(resolve(base, 'runs/summary.json'));
const token = process.env.REPLICATE_API_TOKEN;
if (!token) throw new Error('REPLICATE_API_TOKEN is missing; use the environment or node --env-file=PRIVATE_ENV_PATH. Never pass a token as an argument.');
const redact = text => String(text).replaceAll(token, '[REDACTED]').replace(/r8_[A-Za-z0-9_-]+/g, '[REDACTED]');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (path, value, exclusive = false) => writeFile(await privatePath(path), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const terminal = new Set(['succeeded', 'failed', 'canceled']);

async function api(path, options = {}) {
  if (!/^[a-zA-Z0-9_/?=&.-]+$/.test(path)) throw new Error('Unsafe API path');
  const response = await fetch(`https://api.replicate.com/v1/${path}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(75000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Replicate HTTP ${response.status}: ${redact(text).slice(0, 1200)}`);
  return JSON.parse(text);
}

async function inspect() {
  const model = await api('models/zsxkib/seedvr2');
  const version = model.latest_version;
  if (!version?.id || !version.openapi_schema) throw new Error('No usable model version');
  const metadata = { model: 'zsxkib/seedvr2', version: version.id, createdAt: new Date().toISOString(),
    inputSchema: version.openapi_schema.components.schemas.Input };
  await mkdir(resolve(base, 'runs'), { recursive: true, mode: 0o700 });
  const path = resolve(base, 'runs/model.json');
  let previous;
  try { previous = await readJSON(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && previous.version !== metadata.version) throw new Error('Pinned model changed; create a new experiment instead of mixing versions.');
  await save(path, metadata);
  console.log(JSON.stringify({ authenticated: true, model: metadata.model, version: metadata.version, inputs: Object.keys(metadata.inputSchema.properties) }, null, 2));
  return metadata;
}

async function downloadOutput(value, destination) {
  let url = new URL(value);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (url.protocol !== 'https:' || !(url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))) throw new Error('Unexpected output host');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { url = new URL(response.headers.get('location'), url); continue; }
    if (!response.ok) throw new Error(`Output download HTTP ${response.status}`);
    const limit = 128 * 1024 ** 2;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Output exceeds download budget');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > limit) throw new Error('Output exceeds download budget'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    await privatePath(destination);
    try {
      const existing = await readFile(destination);
      if (sha(existing) !== sha(bytes)) throw new Error('Refusing to replace a different existing output');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
    }
    return { file: destination, bytes: bytes.length, sha256: sha(bytes) };
  }
  throw new Error('Too many output redirects');
}

async function input() {
  const inputPath = resolve(base, 'input/input.mp4');
  const media = await readFile(inputPath);
  const sourceMetadata = await readJSON(resolve(base, 'input/source-metadata.json'));
  if (!Number.isSafeInteger(sourceMetadata.fps) || sourceMetadata.fps < 1 || sourceMetadata.fps > 120) throw new Error('Invalid source FPS');
  if (media.length > 4 * 1024 ** 2) throw new Error('Probe input exceeds the 4 MiB data-URL budget');
  if (sha(media) !== sourceMetadata.videos?.['input.mp4']?.sha256) throw new Error('Input video differs from source metadata');
  const sourceRoot = dirname(resolve(sourceMetadata.sourceManifest));
  if (inside(sourceRoot, base) || inside(sourceRoot, resolve(base, 'runs'))) throw new Error('Output must not be inside the source manifest directory');
  return { inputPath, media, sourceMetadata };
}

async function run() {
  const { inputPath, media, sourceMetadata } = await input();
  const model = await inspect();
  const configs = [
    { name: 'A-3b', model_variant: '3b', apply_color_fix: false },
    { name: 'B-7b', model_variant: '7b', apply_color_fix: false },
    { name: 'C-3b-colorfix', model_variant: '3b', apply_color_fix: true },
  ];
  const common = { seed: 314159, sample_steps: 1, cfg_scale: 1, sp_size: 1, fps: sourceMetadata.fps };
  const summary = { private: true, model: model.model, version: model.version, input: { file: inputPath, bytes: media.length, sha256: sha(media) },
    budget: { maximumPredictions: 3, cancelAfter: '3m', automaticFailedRetries: false }, common, results: [] };
  for (const config of configs) {
    const { name, ...settings } = config, directory = resolve(base, 'runs', name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const request = { version: model.version, input: { ...common, ...settings, media: `data:video/mp4;base64,${media.toString('base64')}` } };
    const requestDigest = sha(JSON.stringify(request));
    let prediction;
    try { prediction = await readJSON(resolve(directory, 'prediction.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const intentFile = resolve(directory, 'request.json');
    if (!prediction) {
      try {
        await stat(intentFile);
        throw new Error(`Previous creation intent for ${name} has no recorded ID. Inspect Replicate before retrying to avoid duplicate charges.`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await save(intentFile, { requestDigest, settings: { ...common, ...settings }, inputSHA256: summary.input.sha256, version: model.version, attemptedAt: new Date().toISOString() }, true);
      console.log(`${name}: creating one prediction (cancel-after 3 minutes)`);
      prediction = await api('predictions', { method: 'POST', headers: { Prefer: 'wait=60', 'Cancel-After': '3m' }, body: JSON.stringify(request) });
      await save(resolve(directory, 'prediction.json'), prediction);
    } else {
      const intent = await readJSON(intentFile);
      if (intent.requestDigest !== requestDigest) throw new Error('Existing prediction belongs to different settings/input');
    }
    const deadline = Date.now() + 210000;
    while (!terminal.has(prediction.status)) {
      if (Date.now() > deadline) {
        await api(`predictions/${prediction.id}/cancel`, { method: 'POST' });
        throw new Error(`Canceled ${name} after bounded wait`);
      }
      await delay(4000);
      prediction = await api(`predictions/${prediction.id}`);
      await save(resolve(directory, 'prediction.json'), prediction);
    }
    const record = { name, id: prediction.id, status: prediction.status, settings: { ...common, ...settings }, metrics: prediction.metrics,
      web: prediction.urls?.web, error: prediction.error };
    if (prediction.status === 'succeeded') {
      const output = typeof prediction.output === 'string' ? prediction.output : Array.isArray(prediction.output) ? prediction.output[0] : null;
      if (!output) throw new Error('Unexpected output schema');
      record.output = await downloadOutput(output, resolve(directory, 'output.mp4'));
    }
    summary.results.push(record);
    await save(resolve(base, 'runs/summary.json'), summary);
    console.log(`${name}: ${prediction.status}; GPU seconds ${prediction.metrics?.predict_time ?? 'unreported'}; ${prediction.id}`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function runPapina() {
  const { sourceMetadata: source, media } = await input();
  const model = await api('models/papina/seedvr2');
  const version = model.latest_version;
  if (!version?.id) throw new Error('No published papina version');
  const settings = { model_variant: '7b', seed: 314159, sample_steps: 1, cfg_scale: 1, sp_size: 1,
    fps: source.fps, apply_color_fix: false, resolution: 720, max_resolution: 1280 };
  const properties = version.openapi_schema?.components.schemas.Input.properties;
  if (!properties || !Object.keys(settings).every(key => properties[key]) || !properties.media) throw new Error('Papina input schema does not support the intended comparison');
  const directory = resolve(base, 'runs/D-papina-7b');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const request = { version: version.id, input: { ...settings, media: `data:video/mp4;base64,${media.toString('base64')}` } };
  const digest = sha(JSON.stringify(request)), intentFile = resolve(directory, 'request.json');
  let prediction;
  try { prediction = await readJSON(resolve(directory, 'prediction.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!prediction) {
    try { await stat(intentFile); throw new Error('Previous papina creation intent exists without an ID; inspect account before retrying.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await save(intentFile, { requestDigest: digest, model: 'papina/seedvr2', version: version.id, settings,
      inputSHA256: sha(media), attemptedAt: new Date().toISOString() }, true);
    console.log(JSON.stringify({ model: 'papina/seedvr2', version: version.id, settings, maximumNewPredictions: 1, cancelAfter: '3m' }, null, 2));
    prediction = await api('predictions', { method: 'POST', headers: { Prefer: 'wait=60', 'Cancel-After': '3m' }, body: JSON.stringify(request) });
    await save(resolve(directory, 'prediction.json'), prediction);
  } else if ((await readJSON(intentFile)).requestDigest !== digest) throw new Error('Existing papina job has a different input/version');
  const deadline = Date.now() + 210000;
  while (!terminal.has(prediction.status)) {
    if (Date.now() > deadline) { await api(`predictions/${prediction.id}/cancel`, { method: 'POST' }); throw new Error('Papina job canceled after bounded wait'); }
    await delay(4000);
    prediction = await api(`predictions/${prediction.id}`);
    await save(resolve(directory, 'prediction.json'), prediction);
  }
  const record = { name: 'D-papina-7b', model: 'papina/seedvr2', version: version.id, settings, inputSHA256: sha(media),
    id: prediction.id, status: prediction.status, metrics: prediction.metrics, web: prediction.urls?.web, error: prediction.error };
  if (prediction.status === 'succeeded') {
    const output = typeof prediction.output === 'string' ? prediction.output : Array.isArray(prediction.output) ? prediction.output[0] : null;
    if (!output) throw new Error('Unexpected papina output');
    record.output = await downloadOutput(output, resolve(directory, 'output.mp4'));
  }
  await save(resolve(directory, 'result.json'), record);
  console.log(JSON.stringify(record, null, 2));
  if (record.status !== 'succeeded') process.exitCode = 2;
}

(mode === 'inspect' ? inspect() : mode === 'run' ? run() : runPapina())
  .catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
