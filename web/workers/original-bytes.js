import { validateOriginalFiles } from '../lib/original-streaming-fs.js';

let index, address, cache, cacheError;
let active = 0;
let writes = Promise.resolve();
let protectedHashes = new Set(), cacheKeys = [], storedKeys = new Set();
const queue = [], pending = new Map();
const stats = { networkBytes: 0, networkRequests: 0, cacheHits: 0, corruptions: 0 };
let loadingCanvas, loadingContext, loadingTimer;
let demandGroup;
const waits = new Map();
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');

function drawLoading() {
  if (!loadingContext) return;
  const ctx = loadingContext, { width, height } = loadingCanvas;
  ctx.clearRect(0, 0, width, height);
  if (!waits.size) return;
  const job = [...waits.values()].find(job => performance.now() >= job.showAfter);
  if (!job) return;
  job.shownAt ??= performance.now();
  const x = width / 2, y = height / 2;
  ctx.fillStyle = 'rgba(26, 19, 9, 0.91)'; ctx.fillRect(0, 0, width, height);
  const angle = performance.now() / 350;
  ctx.strokeStyle = '#d69340'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y - 40, 22, angle, angle + Math.PI * 1.5); ctx.stroke();
  ctx.fillStyle = '#f7ebd0'; ctx.textAlign = 'center'; ctx.font = '600 22px sans-serif';
  ctx.fillText('Loading game data', x, y + 16);
  ctx.font = '15px sans-serif';
  ctx.fillText(job.error ? 'Data is not ready yet. Retrying without restarting the game...' : 'The game will continue when the required data is verified.', x, y + 48, Math.max(1, width - 32));
  ctx.font = '13px monospace'; ctx.fillText(`${job.name} / block ${job.index + 1}`, x, y + 78);
  if (job.sab) Atomics.add(new Int32Array(job.sab, 0, 8), 3, 1);
}

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
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${file.bytes}`) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Original server did not honor the exact byte range.');
    }
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
  if (header && job.wait) { job.showAfter = performance.now() + 180; waits.set(job.sab, job); drawLoading(); }
  try {
    let bytes, attempts = 0;
    for (;;) {
      try { bytes = job.group ? await demandBlocks(job) : await block(job.name, job.index); break; }
      catch (error) {
        if (!job.wait) throw error;
        attempts++;
        job.error = String(error.message || error); drawLoading();
        postMessage({ event: 'waiting', id: job.id, name: job.name, index: job.index,
          attempts, error: String(error.message || error), stats, cacheError });
        if (header) Atomics.store(header, 2, attempts);
        await new Promise(resolve => setTimeout(resolve, Math.min(5000, 250 * 2 ** Math.min(attempts, 4))));
      }
    }
    if (header) {
      if (job.shownAt) await new Promise(resolve => setTimeout(resolve, Math.max(0, job.shownAt + 300 - performance.now())));
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
  } finally { if (header) { waits.delete(job.sab); drawLoading(); } active--; drain(); }
}

async function demandBlocks(job) {
  const { first, last, name } = job.group, file = index.files[name];
  if (name !== job.name || !file || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
      first < 0 || last >= file.hashes.length || first > job.index || last < job.index || last - first >= 512) throw new Error('Invalid demand resource window.');
  const key = `${name}/${first}/${last}`;
  let group = demandGroup;
  if (!group || group.key !== key) {
    group = { key, bytes: new Map(), delivered: new Set() }; demandGroup = group;
    group.ready = (async () => {
      let at = first;
      const fill = async () => {
        while (at <= last && !group.failed) { const number = at++; group.bytes.set(number, await block(name, number)); }
      };
      await Promise.all([fill(), fill()]);
      return group.bytes;
    })().catch(error => { group.failed = true; if (demandGroup === group) demandGroup = undefined; throw error; });
  }
  const bytes = await group.ready;
  if (!group.delivered.has(job.room)) {
    group.delivered.add(job.room);
    for (const [number, data] of bytes) {
      if (number === job.index) continue;
      const copy = data.slice();
      postMessage({ event: 'demand-block', name, index: number, room: job.room, bytes: copy.buffer, stats }, [copy.buffer]);
    }
  }
  stats.demandResourceBytes = [...bytes.values()].reduce((sum, block) => sum + block.length, 0);
  return bytes.get(job.index);
}

function drain() {
  while (active < 4 && queue.length) { active++; run(queue.shift()); }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'loading-canvas') {
    loadingCanvas = data.canvas;
    loadingContext = loadingCanvas.getContext('2d', { alpha: true, desynchronized: true });
    if (loadingTimer) clearInterval(loadingTimer);
    loadingTimer = setInterval(drawLoading, 100); drawLoading();
  } else if (data.type === 'loading-size' && loadingCanvas) {
    loadingCanvas.width = data.width; loadingCanvas.height = data.height; drawLoading();
  } else if (data.type === 'init') {
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
