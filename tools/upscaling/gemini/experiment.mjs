import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const exists = async file => access(file).then(() => true, () => false);
const project = 'gen-lang-client-0665493034';
const modelIds = ['gemini-nano-banana-2.1', 'gemini-3-pro-image'];
const sourceHashes = [
  '6f3320b5cefe96d37ff5fff991e2d15c277e6d65e6e1d5d80f34b626617ef0a9',
  '67f70a2209a9a29c6a12da2657002745063920854d3485225d66d2a293896803',
];
const roles = 'The first attached image is SOURCE: the original game background and the ONLY authority for composition, geometry, object inventory, colors and lighting. Restore this image, not the reference photos. Return one restored background image, 4:3, without borders or text. Preserve the full field of view; no cropping, reframing, perspective correction, rotation, or added characters. Do not include commentary in the image.';
const referenceInstruction = 'The subsequent three attached images are BACKSTAGE MATERIAL REFERENCES ONLY. Use them solely to understand real handmade plasticine surface response and restrained tactile detail. Do not transfer their characters, objects, door designs, support wires, colors, lighting, camera angle or background geometry into SOURCE. SOURCE always wins any conflict.';
const preservation = 'Conservatively reconstruct the original stop-motion miniature at higher resolution. Preserve every silhouette, irregular edge, wall junction, doorway opening, button, ladder rung, ceiling feature and puzzle mark at the same normalized coordinates. Keep the original palette, illumination, shadow boundaries and dark areas. Preserve intentional asymmetry and handmade dents. Resolve compression and pixelation with plausible restrained clay texture only where supported by SOURCE; do not invent cracks, fingerprints, dust, fibers, props or markings. Do not beautify, straighten, smooth away original sculpting, relight or redesign. Retain negative space exactly. Fidelity takes priority over photographic detail.';

export function requestHashFor(job, projectId = project, location = 'global') {
  return sha(JSON.stringify({ project: projectId, location, model: job.model, prompt: job.prompt,
    attachments: job.attachments.map(a => ({ sha256: a.sha256, mimeType: a.mimeType, role: a.role, ...(a.label ? { label: a.label } : {}) })), settings: job.settings }));
}

export function makeJobs(rooms, prompts, references, settings, referenceModes = ['none', 'backstage']) {
  return rooms.flatMap(room => modelIds.flatMap(model => Object.entries(prompts).flatMap(([promptVariant, text]) => referenceModes.map(referenceMode => {
    const attachments = [room.source, ...(referenceMode === 'backstage' ? references : [])];
    const prompt = [roles, text, referenceMode === 'backstage' ? referenceInstruction : 'No material reference photos are attached.'].join('\n\n');
    const requestHash = requestHashFor({ model, prompt, attachments, settings });
    return { id: `${room.id}-${model}-${promptVariant}-${referenceMode}-${requestHash.slice(0, 12)}`, roomId: room.id, model, promptVariant, referenceMode, prompt, attachments, requestHash, settings };
  }))));
}

async function attachment(file, role, expectedHash) {
  const absolute = path.resolve(root, file);
  const bytes = await readFile(absolute);
  const hash = sha(bytes);
  if (expectedHash && hash !== expectedHash) throw Error(`Input hash mismatch: ${file}`);
  return { path: absolute, role, sha256: hash, bytes: bytes.length, mimeType: absolute.endsWith('.png') ? 'image/png' : 'image/jpeg' };
}

async function buildPlan(textMaterial = false) {
  const historical = await readFile(new URL('prompts/room-background-original.txt', import.meta.url), 'utf8');
  const catalog = JSON.parse(await readFile(new URL('../references/backstage/catalog.json', import.meta.url), 'utf8'));
  const referenceIds = ['DrwmSLYX0AAqgBN', 'EPlcPUAVUAESfY7', 'EPlcPUHU4AAocYP'];
  const references = textMaterial ? [] : await Promise.all(referenceIds.map(id => {
    const entry = catalog.files.find(item => item.id === id);
    return attachment(`tools/upscaling/references/backstage/${entry.file}`, 'material-reference', entry.sha256);
  }));
  const rooms = await Promise.all(sourceHashes.map(async (hash, i) => {
    const source = await attachment(`private-assets/blobs/${hash.slice(0, 2)}/${hash}.png`, 'source-composition', hash);
    return { id: `Scene100${i + 1}`, sourcePath: source.path, source,
      baselinePath: path.resolve(root, `../neverhood-upscaling/data/room${i + 1}-hd/pack-v1/backgrounds/gemini.png`) };
  }));
  const settings = { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: '2K' } };
  const materialText = textMaterial ? await readFile(new URL('prompts/static-material-reference.txt', import.meta.url), 'utf8') : null;
  const prompts = textMaterial ? { 'text-material': `${preservation}\n\n${materialText}` }
    : { historical: historical.replaceAll('image_20.png', 'SOURCE'), preservation };
  const jobs = makeJobs(rooms, prompts, references, settings, textMaterial ? ['none'] : undefined);
  return { schemaVersion: 1, experimentId: textMaterial ? 'static-text-material-v1' : 'static-pilot-v1', project, location: 'global',
    design: textMaterial ? '2 rooms x 2 models x preservation plus detailed text-only material profile; SOURCE is the only image attachment; one sample per cell'
      : '2 rooms x 2 models x 2 prompts x 2 reference modes; one sample per cell; no provider batch or explicit context caching',
    ...(textMaterial ? { textMaterialProfile: { path: 'tools/upscaling/gemini/prompts/static-material-reference.txt', sha256: sha(materialText),
      descriptionScope: 'static scenery and materials only; no character or animation descriptions',
      observedReferencePhotos: catalog.files.map(({ id, sha256 }) => ({ id, sha256 })),
      referencePhotoAttachments: 0 } } : {}),
    historicalPromptSha256: sha(historical), historicalAdaptation: 'image_20.png replaced with SOURCE; shared source-role instruction added to both variants',
    rooms, references, jobs, maximumRequests: jobs.length, concurrency: 2,
    caveats: ['Single sample per condition cannot establish statistical significance.', '2K native images are experimental candidates, not exact 2560x1920 runtime replacements.', 'No automatic approval or runtime export.'] };
}

export function finalImage(images) {
  return images.filter(image => !image.thought && image.mimeType?.startsWith('image/')).at(-1);
}

export async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function validateAttempt(plan, job) {
  const attempt = job.authorizedAttempt;
  if (!attempt) return;
  const authorization = plan.retryAuthorization;
  if (!authorization?.id || !authorization.userMessageTime || !authorization.userInstruction ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(attempt.id ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(authorization.id) ||
      attempt.authorizationId !== authorization.id || job.attachments.length !== 1 ||
      attempt.sourceSha256 !== job.attachments[0].sha256 ||
      !authorization.allowedAttempts?.some(item => JSON.stringify(item) === JSON.stringify({
        id: attempt.id, roomId: job.roomId, sourceSha256: attempt.sourceSha256,
        priorRequestHash: attempt.priorRequestHash, priorResultPath: attempt.priorResultPath }))) {
    throw Error('Explicit retry authorization does not cover this exact attempt/source/prior request');
  }
}

export async function claimRequest(job, runDir, directory = path.join(root, 'private-assets/upscaling/gemini-request-ledger'), plan = {}) {
  await mkdir(directory, { recursive: true });
  validateAttempt(plan, job);
  let receipt;
  if (job.authorizedAttempt) {
    const attempt = job.authorizedAttempt;
    const prior = JSON.parse(await readFile(attempt.priorResultPath, 'utf8'));
    if (prior.requestHash !== attempt.priorRequestHash) throw Error('Authorized retry prior hash mismatch');
    const oldRequest = JSON.parse(await readFile(path.join(path.dirname(attempt.priorResultPath), 'request.json'), 'utf8'));
    if (oldRequest.attachments?.[0]?.sha256 !== attempt.sourceSha256 || oldRequest.roomId !== job.roomId) throw Error('Authorized retry prior source/room mismatch');
    const receipts = path.join(directory, 'authorizations');
    await mkdir(receipts, { recursive: true });
    receipt = path.join(receipts, `${plan.retryAuthorization.id}-${attempt.id}.json`);
    await freezeManifest(receipt, { schemaVersion: 1, authorization: plan.retryAuthorization,
      attempt, requestHash: job.requestHash, jobId: job.id, runDir });
  }
  const key = job.authorizedAttempt ? `${job.requestHash}-attempt-${sha(job.authorizedAttempt.id).slice(0, 16)}` : job.requestHash;
  const file = path.join(directory, `${key}.json`);
  try {
    const handle = await open(file, 'wx', 0o444);
    try { await handle.writeFile(json({ requestHash: job.requestHash, jobId: job.id, runDir,
      ...(receipt ? { authorizationReceipt: receipt, authorizedAttempt: job.authorizedAttempt } : {}),
      claimedAt: new Date().toISOString(), status: 'reserved-before-dispatch-never-repeat-an-unknown-outcome' })); await handle.sync(); }
    finally { await handle.close(); }
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

async function saveResponse(job, dir, body, metadata) {
  const images = [];
  for (const [ci, candidate] of (body.candidates ?? []).entries()) {
    for (const [pi, part] of (candidate.content?.parts ?? []).entries()) {
      if (!part.inlineData?.data) continue;
      const bytes = Buffer.from(part.inlineData.data, 'base64');
      const mimeType = part.inlineData.mimeType;
      const filename = `candidate-${ci}-part-${pi}${part.thought ? '-thought' : ''}.${mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'bin'}`;
      let dimensions;
      if (mimeType?.startsWith('image/')) {
        dimensions = JSON.parse(execFileSync('python3', ['-c', 'import sys,json,io; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps(list(im.size)))'], { input: bytes, encoding: 'utf8' }));
      }
      const image = { path: path.join(dir, filename), sha256: sha(bytes), mimeType, bytes: bytes.length, dimensions, thought: Boolean(part.thought), candidateIndex: ci, partIndex: pi };
      await atomicWrite(image.path, bytes);
      images.push(image);
      part.inlineData = { ...image, path: filename };
    }
  }
  await atomicWrite(path.join(dir, 'response.json'), json(body));
  const result = { id: job.id, model: job.model, status: !body.error && metadata.httpStatus !== 0 && (metadata.httpStatus === undefined || metadata.httpStatus >= 200 && metadata.httpStatus < 300) && finalImage(images) ? 'succeeded' : 'failed',
    ...(job.authorizedAttempt ? { authorizedAttempt: job.authorizedAttempt } : {}),
    ...metadata, completedAt: new Date().toISOString(), modelVersion: body.modelVersion,
    responseId: body.responseId, usage: body.usageMetadata, images, error: body.error,
    finishReasons: body.candidates?.map(c => c.finishReason), requestHash: job.requestHash };
  await atomicWrite(path.join(dir, 'result.json'), json(result));
  return result;
}

export async function recoverJob(job, runDir) {
  const dir = path.join(runDir, 'jobs', job.id);
  if (!await exists(path.join(dir, 'response-raw.json'))) return false;
  const previous = await readFile(path.join(dir, 'result.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (previous?.status === 'succeeded' || previous?.status === 'failed') return false;
  const request = JSON.parse(await readFile(path.join(dir, 'request.json'), 'utf8'));
  if (request.requestHash !== job.requestHash) throw Error('Recovery request hash mismatch');
  const metadata = await readFile(path.join(dir, 'response-metadata.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const body = JSON.parse(await readFile(path.join(dir, 'response-raw.json'), 'utf8'));
  await saveResponse(job, dir, body, { startedAt: previous?.startedAt, ...metadata, recoveredFromSavedRawResponse: true });
  return true;
}

export async function freezeManifest(file, plan) {
  try {
    const handle = await open(file, 'wx', 0o444);
    try { await handle.writeFile(json(plan)); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== json(plan)) throw Error('Existing experiment manifest differs');
  }
}

export function validatePilotJobs(jobs) {
  if (jobs.length !== 10 || new Set(jobs.map(job => job.requestHash)).size !== 10 ||
      new Set(jobs.map(job => job.attachments[0]?.sha256)).size !== 10 ||
      jobs.some(job => job.model !== 'gemini-nano-banana-2.1' || job.attachments.length !== 1 ||
        job.referenceMode !== 'none' || job.promptVariant !== 'preservation')) throw Error('Pilot budget/deduplication invariant failed');
}

export async function buildOpaquePlan(selection, previousJobs = []) {
  const templatePath = path.join(root, 'private-assets/upscaling/gemini-experiments/static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  if (selection.schemaVersion !== 1 || selection.rooms?.length !== 10) throw Error('Exactly 10 verified sources required');
  const seen = new Set();
  const rooms = selection.rooms.map(room => ({ ...room, sourcePath: path.resolve(root, room.sourcePath),
    source: { ...room.source, path: path.resolve(root, room.source.path) } }));
  for (const room of rooms) {
    const source = room.source;
    if (['Scene1001', 'Scene1002'].includes(room.id) || seen.has(room.id) || seen.has(source?.sha256)) throw Error('Duplicate or control source');
    seen.add(room.id); seen.add(source?.sha256);
    if (!room.provenance || !room.resourceId || !room.regions?.length || !source?.dimensions || source.dimensions[0] * 3 !== source.dimensions[1] * 4) throw Error(`Missing verified 4:3 provenance/profile: ${room.id}`);
    if (!path.resolve(source.path).startsWith(path.join(root, 'private-assets') + path.sep) || room.sourcePath !== source.path) throw Error('Sources must be private original images');
    if (source.role !== 'source-composition' || source.mimeType !== 'image/png' || sha(await readFile(source.path)) !== source.sha256) throw Error('Source hash or type mismatch');
  }
  const jobs = makeJobs(rooms, { preservation }, [], template.settings, ['none']).filter(job => job.model === template.model);
  validatePilotJobs(jobs);
  if (jobs.some(job => job.prompt !== template.prompt || previousJobs.some(old => old.requestHash === job.requestHash))) throw Error('Prompt mismatch or already processed request');
  const capabilityPath = path.join(root, 'private-assets/upscaling/gemini-capabilities/capability.json');
  const capabilityBytes = await readFile(capabilityPath);
  const capability = JSON.parse(capabilityBytes);
  if (capability.model !== template.model || capability.capabilities?.batch?.unsupportedOutputResolutions?.includes('2K') !== true) throw Error('Pilot transport decision requires selected-model 2K batch capability evidence');
  const controls = await Promise.all(['Scene1001', 'Scene1002'].map(async id => {
    const old = previousJobs.find(job => job.roomId === id && job.model === template.model && job.promptVariant === 'preservation' && job.referenceMode === 'none');
    if (!old) return { roomId: id, status: 'control-not-located' };
    const record = JSON.parse(await readFile(old.resultPath, 'utf8'));
    return { id: old.id, roomId: id, label: `${id}: existing selected-mode control; no new request`,
      sourcePath: old.attachments[0].path, path: finalImage(record.images)?.path,
      requestHash: old.requestHash, resultPath: old.resultPath };
  }));
  return { schemaVersion: 1, experimentId: 'opaque-pilot-v1', project, location: 'global',
    design: '10 new opaque original backgrounds; one candidate each; stop after pilot; no runtime promotion',
    transport: 'generateContent-limited-queue-not-official-batch', explicitCaching: false,
    rooms, references: [], jobs, controls, maximumRequests: 10, concurrency: 2,
    regionProfiles: { schemaVersion: 1, rooms: Object.fromEntries(rooms.map(room => [room.id, room.regions])) },
    selectionSha256: sha(JSON.stringify(selection)),
    sourceSelectionEvidence: { catalog: selection.catalog, sharedEvidence: selection.sharedEvidence,
      annotationsFrozenBeforeCandidates: selection.annotationsFrozenBeforeCandidates, problems: selection.problems },
    capabilityEvidence: { path: capabilityPath, sha256: sha(capabilityBytes) },
    implementation: { node: process.version, files: await Promise.all(['experiment.mjs', 'prepare-opaque-sources.mjs'].map(async name => {
      const file = path.join(root, 'tools/upscaling/gemini', name);
      return await exists(file) ? { path: file, sha256: sha(await readFile(file)) } : { path: file, status: 'not-used' };
    })) },
    caveats: ['Native output preserved without resizing or cropping.', 'No automatic approval; further generation requires separate user authorization.'] };
}

async function previousJobs() {
  const base = path.join(root, 'private-assets/upscaling/gemini-experiments');
  const jobs = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'opaque-pilot-v1' || entry.name.startsWith('opaque-pilot-v1-')) continue;
    const manifest = path.join(base, entry.name, 'experiment.json');
    if (!await exists(manifest)) continue;
    const plan = JSON.parse(await readFile(manifest, 'utf8'));
    for (const job of plan.jobs ?? []) jobs.push({ ...job, resultPath: path.join(base, entry.name, 'jobs', job.id, 'result.json') });
  }
  return jobs;
}

export async function runJob(plan, job, runDir, dependencies = {}) {
  validateAttempt(plan, job);
  const dir = path.join(runDir, 'jobs', job.id);
  const recordPath = path.join(dir, 'result.json');
  // A durable in-flight marker prevents re-paying for an interrupted/ambiguous call.
  if (await exists(recordPath)) {
    const previous = JSON.parse(await readFile(recordPath, 'utf8'));
    if (previous.requestHash !== job.requestHash) throw Error(`Existing result hash mismatch: ${job.id}`);
    console.log(JSON.stringify({ id: job.id, action: 'skip-existing', status: previous.status }));
    return;
  }
  await mkdir(dir, { recursive: true });
  const parts = [{ text: job.prompt }];
  for (const item of job.attachments) {
    const bytes = await readFile(item.path);
    if (sha(bytes) !== item.sha256) throw Error(`Attachment changed: ${item.path}`);
    parts.push({ text: item.label ?? (item.role === 'source-composition' ? 'SOURCE image:' : 'BACKSTAGE material reference only:') });
    parts.push({ inlineData: { mimeType: item.mimeType, data: bytes.toString('base64') } });
  }
  const token = dependencies.token ?? execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
    encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const startedAt = new Date().toISOString();
  await freezeManifest(path.join(dir, 'request.json'), job);
  try {
    const marker = await open(recordPath, 'wx', 0o600);
    try {
      await marker.writeFile(json({ id: job.id, model: job.model, status: 'in-flight-outcome-unknown', startedAt, requestHash: job.requestHash,
        reconciliation: 'Synchronous generateContent exposes no operation lookup; never resubmit an unknown outcome.' }));
      await marker.sync();
    } finally { await marker.close(); }
    const directory = await open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  const start = Date.now();
  let dispatched = false;
  try {
    // The shared path protects all entry points, including historical pilot commands.
    const ledger = dependencies.ledgerDir ?? (dependencies.fetch ? null : path.join(root, 'private-assets/upscaling/gemini-request-ledger'));
    if (ledger && !await claimRequest(job, runDir, ledger, plan)) {
      await atomicWrite(recordPath, json({ id: job.id, model: job.model, requestHash: job.requestHash,
        status: 'blocked-prior-submission', images: [], startedAt,
        error: 'Global request reservation exists; this invocation did not submit or retry the request' }));
      return;
    }
    dispatched = true;
    const response = await (dependencies.fetch ?? fetch)(`https://aiplatform.googleapis.com/v1/projects/${plan.project}/locations/${plan.location}/publishers/google/models/${job.model}:generateContent`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': plan.project, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: job.settings }),
      signal: AbortSignal.timeout(240_000),
    });
    const body = await response.json();
    // Retain the complete provider response before decoding any image parts.
    const metadata = { startedAt, durationMs: Date.now() - start, httpStatus: response.status };
    await atomicWrite(path.join(dir, 'response-metadata.json'), json(metadata));
    await atomicWrite(path.join(dir, 'response-raw.json'), json(body));
    const result = await saveResponse(job, dir, body, metadata);
    console.log(JSON.stringify({ id: job.id, status: result.status, httpStatus: response.status, durationMs: result.durationMs, finalImages: result.images.filter(i => !i.thought).length, error: body.error }));
  } catch (error) {
    const status = dispatched ? 'outcome-unknown' : 'blocked-pre-submission';
    await atomicWrite(recordPath, json({ id: job.id, model: job.model, status, startedAt, durationMs: Date.now() - start, error: error.message, requestHash: job.requestHash }));
    console.log(JSON.stringify({ id: job.id, status, error: error.message }));
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--execute', '--text-material', '--opaque-pilot'].includes(arg)) || args.includes('--opaque-pilot') && args.includes('--text-material')) throw Error('Usage: node experiment.mjs [--text-material|--opaque-pilot] [--execute]');
  const plan = args.includes('--opaque-pilot') ? await buildOpaquePlan(JSON.parse(await readFile(path.join(root, 'private-assets/upscaling/opaque-pilot-source-selection.json'), 'utf8')), await previousJobs()) : await buildPlan(args.includes('--text-material'));
  const planHash = sha(JSON.stringify(plan));
  // Fixed pilot slot prevents changed preparation metadata from creating another paid run.
  const runDir = path.join(root, 'private-assets/upscaling/gemini-experiments', args.includes('--opaque-pilot') ? plan.experimentId : `${plan.experimentId}-${planHash.slice(0, 12)}`);
  await mkdir(runDir, { recursive: true });
  const manifest = path.join(runDir, 'experiment.json');
  await freezeManifest(manifest, plan);
  if (args.includes('--opaque-pilot')) await freezeManifest(path.join(runDir, 'capability.json'), JSON.parse(await readFile(plan.capabilityEvidence.path, 'utf8')));
  console.log(JSON.stringify({ runDir, jobs: plan.jobs.length, execute: args.includes('--execute'), planHash }));
  if (!args.includes('--execute')) return;
  if (args.includes('--opaque-pilot')) validatePilotJobs(plan.jobs);
  let next = 0;
  await Promise.all(Array.from({ length: plan.concurrency }, async () => {
    while (next < plan.jobs.length) await runJob(plan, plan.jobs[next++], runDir);
  }));
  const results = await Promise.all(plan.jobs.map(async job => JSON.parse(await readFile(path.join(runDir, 'jobs', job.id, 'result.json'), 'utf8'))));
  const counts = results.reduce((total, result) => {
    total[result.status] = (total[result.status] ?? 0) + 1;
    return total;
  }, {});
  await writeFile(path.join(runDir, 'run-summary.json'), json({ planHash, project, counts, results }));
  console.log(JSON.stringify({ runDir, counts }));
  if (results.some(result => result.status !== 'succeeded')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
