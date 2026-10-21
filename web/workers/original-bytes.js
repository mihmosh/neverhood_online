import { validateOriginalFiles } from '../lib/original-streaming-fs.js';

let index, address, cache, cacheError;
let active = 0;
let writes = Promise.resolve();
let protectedHashes = new Set(), cacheKeys = [], storedKeys = new Set();
const queue = [], pending = new Map();
const stats = { networkBytes: 0, networkRequests: 0, cacheHits: 0, corruptions: 0 };
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');

async function boundedBytes(response, length) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) !== length) throw new Error('Original block response length mismatch.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Original block response has no body.');
  const bytes = new Uint8Array(length);
  let at = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > length) throw new Error('Oversized original block response.');
      bytes.set(value, at); at += value.length;
    }
    if (at !== length) throw new Error('Truncated original block response.');
    return bytes;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function store(url, bytes) {
  const next = writes.catch(() => {}).then(() => globalThis.navigator?.locks?.request
    ? navigator.locks.request('neverhood-original-block-cache-write', async () => {
      if (cache) { cacheKeys = (await cache.keys()).map(request => request.url); storedKeys = new Set(cacheKeys); }
      return storeOne(url, bytes);
    }) : storeOne(url, bytes));
  writes = next;
  return next;
}

async function storeOne(url, bytes) {
  if (!cache || storedKeys.has(url)) return;
  let examined = 0;
  const candidates = cacheKeys.length;
  while ((storedKeys.size + 1) * index.blockSize > 256 * 1024 ** 2 && examined++ < candidates) {
    const oldest = cacheKeys.shift();
    if (protectedHashes.has(oldest.split('/').at(-1))) { cacheKeys.push(oldest); continue; }
    await cache.delete(oldest); storedKeys.delete(oldest);
  }
  if ((storedKeys.size + 1) * index.blockSize > 256 * 1024 ** 2) throw new Error('Protected originals fill the persistent cache budget.');
  await cache.put(url, new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }));
  storedKeys.add(url); cacheKeys.push(url);
  stats.cachedBytesUpperBound = storedKeys.size * index.blockSize;
}

async function block(name, number) {
  const file = index.files[name];
  if (!file || !Number.isSafeInteger(number) || number < 0 || number >= file.hashes.length) throw new Error('Invalid original block request.');
  const key = file.hashes[number];
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => {
    const url = new URL(`/.neverhood-original/${index.runtimeSHA256}/${key}`, address).href;
    const start = number * index.blockSize, length = Math.min(index.blockSize, file.bytes - start), end = start + length - 1;
    let response;
    try { response = await cache?.match(url); } catch (error) { cacheError = String(error); }
    if (response) {
      let bytes;
      try { bytes = await boundedBytes(response, length); } catch {}
      if (bytes && await digest(bytes) === key) { stats.cacheHits++; return bytes; }
      stats.corruptions++;
      await cache.delete(url).catch(() => {}); storedKeys.delete(url); cacheKeys = cacheKeys.filter(key => key !== url);
    }
    response = await fetch(new URL(file.url, address), { headers: { Range: `bytes=${start}-${end}` },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${file.bytes}`) throw new Error('Original server did not honor the exact byte range.');
    const bytes = await boundedBytes(response, length);
    stats.networkBytes += bytes.length; stats.networkRequests++;
    if (bytes.length !== length || await digest(bytes) !== key) throw new Error('Original block SHA256 mismatch.');
    try { await store(url, bytes); } catch (error) { cacheError = String(error); }
    return bytes;
  })().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

async function run(job) {
  const header = job.sab && new Int32Array(job.sab, 0, 8);
  try {
    const bytes = await block(job.name, job.index);
    if (header) {
      new Uint8Array(job.sab, 32).set(bytes);
      header[1] = bytes.length;
      Atomics.store(header, 0, 1);
    } else {
      const copy = bytes.slice();
      postMessage({ id: job.id, bytes: copy.buffer, stats, cacheError }, [copy.buffer]);
    }
  } catch (error) {
    if (header) {
      const bytes = new TextEncoder().encode(String(error.message || error)).subarray(0, index.blockSize);
      new Uint8Array(job.sab, 32).set(bytes); header[1] = bytes.length;
      Atomics.store(header, 0, -1);
    } else postMessage({ id: job.id, error: String(error.message || error), stats, cacheError });
  } finally { active--; drain(); }
}

function drain() {
  while (active < 4 && queue.length) { active++; run(queue.shift()); }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      index = validateOriginalFiles(data.index, data.address);
      address = data.address;
      try {
        cache = await caches.open('neverhood-verified-original-blocks-v1');
        cacheKeys = (await cache.keys()).map(request => request.url); storedKeys = new Set(cacheKeys);
        stats.cachedBytesUpperBound = storedKeys.size * index.blockSize;
      } catch (error) { cacheError = String(error); }
      postMessage({ id: data.id, ready: true, cacheError });
    } catch (error) { postMessage({ id: data.id, error: String(error.message || error) }); }
  } else if (index && data.type === 'protect') {
    protectedHashes = new Set(data.hashes);
  } else if (index && ['read', 'prefetch'].includes(data.type)) {
    if (data.type === 'read') queue.unshift(data); else queue.push(data);
    drain();
  }
};
