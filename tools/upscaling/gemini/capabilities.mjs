import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Only the fixed, non-inference requests below are allowed. Never accepts media or input URIs.
const project = 'gen-lang-client-0665493034';
const model = 'gemini-nano-banana-2.1';
const parent = `projects/${project}/locations/global`;
const modelPath = `${parent}/publishers/google/models/${model}`;
const root = fileURLToPath(new URL('../../../private-assets/upscaling/gemini-capabilities/', import.meta.url));
const run = `${root}${new Date().toISOString().replaceAll(':', '-')}/`;
const prompt = 'Preserve the source composition, silhouettes, materials, lighting, palette, and object identity. Improve clarity only; do not invent details.';
const json = value => `${JSON.stringify(value, null, 2)}\n`;
if (process.argv[2] !== '--probe-safe') throw new Error('Use --probe-safe for metadata, text countTokens, empty batch validation, and one short 60s cache attempt only.');
await mkdir(run, { recursive: true, mode: 0o700 });
const token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
  encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const results = [];
async function request(name, method, path, body) {
  const url = `https://aiplatform.googleapis.com/${path}`;
  await writeFile(`${run}${name}.request.json`, json({ method, url, body }), { mode: 0o600 });
  const startedAt = new Date().toISOString();
  const response = await fetch(url, { method, headers: {
    Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project, 'Content-Type': 'application/json',
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { text }; }
  const result = { name, startedAt, httpStatus: response.status, data };
  await writeFile(`${run}${name}.response.json`, json(result), { mode: 0o600 });
  results.push(result);
  console.log(json(result));
  return result;
}
await request('publisher-model', 'GET', `v1/publishers/google/models/${model}`);
const count = await request('count-tokens', 'POST', `v1/${modelPath}:countTokens`, {
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
});
// No source, destination, or instances: this intentionally invalid request cannot run inference.
for (const version of ['v1', 'v1beta1']) {
  const batch = await request(`empty-batch-${version}`, 'POST', `${version}/${parent}/batchPredictionJobs`, {
    displayName: 'capability-validation-no-inputs', model: `publishers/google/models/${model}`,
    inputConfig: { instancesFormat: 'jsonl', gcsSource: { uris: [] } },
    outputConfig: { predictionsFormat: 'jsonl' },
  });
  if (batch.httpStatus < 300) throw new Error('Unexpected empty batch acceptance; inspect saved response before any further work. No inference inputs were supplied.');
}
// At most 128 text tokens ($0.000192 standard input); no padding to meet cache minimums.
if (count.httpStatus === 200 && count.data.totalTokens <= 128) {
  const cache = await request('explicit-cache-60s', 'POST', `v1/${parent}/cachedContents`, {
    model: modelPath, displayName: 'capability-short-preservation-test', ttl: '60s',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  if (cache.httpStatus < 300 && cache.data.name) {
    if (!cache.data.name.startsWith(`${parent}/cachedContents/`)) throw new Error('Unexpected cache resource name');
    const deleted = await request('explicit-cache-delete', 'DELETE', `v1/${cache.data.name}`);
    if (deleted.httpStatus >= 300) throw new Error('Cache deletion failed; 60s TTL remains fallback.');
  }
}
await writeFile(`${run}summary.json`, json({ project, model, location: 'global', results }), { mode: 0o600 });
console.log(`Evidence: ${run}`);
