import { createHash } from 'node:crypto';

const origin = new URL(process.argv[2] || 'https://nevehood-online.vercel.app');
if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Supply an HTTP(S) site origin without credentials.');

async function get(path, type) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (type && !response.headers.get('content-type')?.includes(type)) throw new Error(`${path}: incorrect Content-Type`);
  return response;
}

const home = await get('/', 'text/html');
for (const [name, value] of [['cross-origin-opener-policy', 'same-origin'], ['cross-origin-embedder-policy', 'require-corp']]) {
  if (home.headers.get(name) !== value) throw new Error(`Missing isolation header: ${name}`);
}
await get('/app.js', 'javascript');
await get('/player.html', 'text/html');
for (const [name, module] of [['runtime', 'scummvm'], ['extractor', 'innoextract']]) {
  const metadata = await (await get(`/${name}/${name}.json`, 'application/json')).json();
  if (!metadata.available || metadata.module !== `${module}.js` || metadata.wasm !== `${module}.wasm`) throw new Error(`${name}: invalid artifact descriptor`);
  const wasm = await (await get(`/${name}/${module}.wasm`, 'application/wasm')).arrayBuffer();
  if (!WebAssembly.validate(wasm)) throw new Error(`${name}: invalid WASM response`);
  console.log(`${name}: real WebAssembly available (${wasm.byteLength} bytes)`);
}
await get('/sources/index.html', 'text/html');
const manifest = await (await get('/sources/manifest.json', 'application/json')).json();
if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100) throw new Error('Invalid public source manifest');
let sourceBytes = 0;
for (const entry of manifest.files) {
  if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 32 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Unsafe source manifest entry');
  const response = await get(`/sources/${entry.name}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > entry.bytes) throw new Error(`${entry.name}: oversized source download`);
    hash.update(chunk);
  }
  if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error(`${entry.name}: source download integrity failure`);
  sourceBytes += bytes;
}
for (const path of ['/server.mjs', '/nonexistent-verification-file.wasm']) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(30000) });
  if (response.status !== 404) throw new Error(`${path}: expected static 404, got ${response.status}`);
}
console.log(`Verified ${manifest.files.length} public source downloads (${sourceBytes} bytes)`);
console.log(`Static deployment healthy: ${origin.origin}`);
