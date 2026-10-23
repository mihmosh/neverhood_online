import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { ORIGINAL_BLOCK_BYTES, STOCK_RUNTIME_SHA256 } from '../web/lib/original-streaming-fs.js';

const address = 'https://release.test/streaming-index.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let importNumber = 0;

function fixture() {
  const source = new Map();
  const index = { version: 1, runtimeSHA256: STOCK_RUNTIME_SHA256, blockSize: ORIGINAL_BLOCK_BYTES,
    files: {}, bootstrap: [{ name: 'i.blb', index: 0 }], common: [],
    rooms: { '1000:0': { blocks: [], neighbors: [] } } };
  for (const [ordinal, name] of REQUIRED_FILES.entries()) {
    const bytes = Uint8Array.from({ length: ORIGINAL_BLOCK_BYTES * 2 + 43 }, (_, i) =>
      (i * 31 + (i >>> 8) * 7 + (i >>> 16) * 17 + ordinal * 29) & 255);
    source.set(name, bytes);
    index.files[name] = { bytes: bytes.length, sha256: sha256(bytes), url: `/original/${name}`,
      hashes: Array.from({ length: 3 }, (_, number) => sha256(bytes.subarray(
        number * ORIGINAL_BLOCK_BYTES, (number + 1) * ORIGINAL_BLOCK_BYTES))) };
  }
  return { index, source };
}

function cacheStorage() {
  const entries = new Map(), calls = { open: [], put: [], delete: [] };
  const key = request => typeof request === 'string' ? request : request.url;
  const cache = {
    async keys() { return [...entries.keys()].map(url => new Request(url)); },
    async match(request) { return entries.get(key(request))?.clone(); },
    async put(request, response) {
      calls.put.push(key(request));
      if (storage.quota) throw new DOMException('Test cache quota exhausted', 'QuotaExceededError');
      entries.set(key(request), response.clone());
    },
    async delete(request) { calls.delete.push(key(request)); return entries.delete(key(request)); },
  };
  const storage = { entries, calls, quota: false, cache,
    async open(name) { calls.open.push(name); return cache; } };
  return storage;
}

async function worker(t, { data = fixture(), storage = cacheStorage(), fetchResponse } = {}) {
  const messages = new Map(), waiters = new Map(), requests = [];
  const self = {};
  const replacements = { self, caches: storage, crypto: webcrypto,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer ?? [] });
      messages.set(copy.id, copy);
      waiters.get(copy.id)?.(copy);
    },
    async fetch(input, options) {
      const url = new URL(input), range = options.headers.Range;
      const name = url.pathname.split('/').at(-1);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert(match, 'worker must issue an explicit inclusive byte range');
      const start = Number(match[1]), end = Number(match[2]);
      const bytes = data.source.get(name).slice(start, end + 1);
      const request = { url: url.href, options, name, start, end, bytes };
      requests.push(request);
      if (fetchResponse) return fetchResponse(request);
      return response(request);
    } };
  const descriptors = Object.fromEntries(Object.keys(replacements).map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const name of Object.keys(replacements)) {
      if (descriptors[name]) Object.defineProperty(globalThis, name, descriptors[name]);
      else delete globalThis[name];
    }
  });
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  await import(`../web/workers/original-bytes.js?worker-test=${++importNumber}`);
  let nextId = 0;
  function request(message) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(id); reject(new Error(`Worker response ${id} timed out`)); }, 3000);
      waiters.set(id, value => { clearTimeout(timeout); waiters.delete(id); resolve(value); });
      Promise.resolve(self.onmessage({ data: { ...message, id } })).catch(error => {
        clearTimeout(timeout); waiters.delete(id); reject(error);
      });
    });
  }
  return { ...data, storage, requests, messages, request,
    send: message => self.onmessage({ data: message }),
    init: (index = data.index) => request({ type: 'init', index, address }),
    key(name, number) { return new URL(`/.neverhood-original/${data.index.runtimeSHA256}/${data.index.files[name].hashes[number]}`, address).href; },
    block(name, number) { return data.source.get(name).slice(number * ORIGINAL_BLOCK_BYTES, (number + 1) * ORIGINAL_BLOCK_BYTES); },
    async sab(name, number) {
      const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES), header = new Int32Array(sab, 0, 8);
      await self.onmessage({ data: { type: 'read', name, index: number, sab } });
      await until(() => Atomics.load(header, 0) !== 0);
      return { state: Atomics.load(header, 0), length: header[1], bytes: new Uint8Array(sab, 32, header[1]).slice() };
    } };
}

function response({ bytes, start, end }, { status = 206, headers = {}, body = bytes } = {}) {
  return new Response(body, { status, headers: {
    'Content-Range': `bytes ${start}-${end}/${ORIGINAL_BLOCK_BYTES * 2 + 43}`,
    'Content-Length': String(bytes.length), ...headers,
  } });
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'worker completion timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('consecutive demand reads reuse a complete verified resource window', async t => {
  const w = await worker(t);
  await w.init();
  const group = { name: 'i.blb', first: 0, last: 2 };
  const read = async number => {
    const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES), header = new Int32Array(sab, 0, 8);
    await w.send({ type: 'read', id: 900 + number, name: 'i.blb', index: number, sab, group, room: '2800:2', wait: true });
    await until(() => Atomics.load(header, 0) !== 0);
    assert.equal(header[0], 1);
    assert.deepEqual(new Uint8Array(sab, 32, header[1]), w.block('i.blb', number));
  };
  await read(0);
  await until(() => w.requests.length === 3);
  assert.equal(w.requests.length, 3);
  w.storage.cache.match = () => { throw new Error('a consecutive demand must not read disk again'); };
  await read(1); await read(2);
  assert.equal(w.requests.length, 3, 'no repeat network fetches for the same resource');
});

test('a stalled speculative neighbor cannot block the requested verified block', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = await worker(t, { fetchResponse: async request => {
    if (request.start === ORIGINAL_BLOCK_BYTES) await gate;
    return response(request);
  } });
  await w.init();
  const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES), header = new Int32Array(sab, 0, 8);
  try {
    await w.send({ type: 'read', id: 951, name: 'i.blb', index: 0, sab, wait: true,
      group: { name: 'i.blb', first: 0, last: 2 }, room: '1000:4' });
    await until(() => header[0] !== 0);
    assert.equal(header[0], 1);
    assert.deepEqual(new Uint8Array(sab, 32, header[1]), w.block('i.blb', 0));
  } finally { release(); }
  await until(() => w.requests.length === 3);
});

test('successive demand windows share the worker limit and drop obsolete speculative jobs', async t => {
  let release, inflight = 0, maximum = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const w = await worker(t, { fetchResponse: async request => {
    inflight++; maximum = Math.max(maximum, inflight);
    if (request.start > 0) await gate;
    inflight--; return response(request);
  } });
  await w.init();
  const headers = [];
  try {
    for (const [i, name] of REQUIRED_FILES.entries()) {
      const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES);
      headers.push(new Int32Array(sab, 0, 8));
      await w.send({ type: 'read', id: 1000 + i, name, index: 0, sab, wait: true,
        group: { name, first: 0, last: 2 }, room: '1000:4' });
      await until(() => headers.at(-1)[0] === 1);
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(maximum <= 4, `demand prefetch escaped the worker limit: ${maximum}`);
  } finally { release(); }
  await until(() => headers.every(header => header[0] === 1));
  await until(() => w.requests.filter(request => request.name === REQUIRED_FILES.at(-1)).length === 3);
  await until(() => inflight === 0);
  assert(maximum <= 4);
  assert(w.requests.length < REQUIRED_FILES.length * 3, 'obsolete queued neighbors must not be downloaded');
});

test('unavailable demanded data reports an error after bounded retries instead of waiting forever', async t => {
  const w = await worker(t, { fetchResponse() { throw new Error('HTTP 404 missing original'); } });
  await w.init();
  const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES), header = new Int32Array(sab, 0, 8);
  await w.send({ type: 'read', id: 952, name: 'i.blb', index: 0, sab, wait: true });
  await until(() => header[0] !== 0);
  assert.equal(header[0], -1);
  assert.equal(w.requests.length, 3);
  assert.match(new TextDecoder().decode(new Uint8Array(sab, 32, header[1])), /HTTP 404/);
});

test('a stalled demanded download publishes a terminal SAB error at its overall deadline', async t => {
  const w = await worker(t, { fetchResponse: () => new Promise(() => {}) });
  await w.init();
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES), header = new Int32Array(sab, 0, 8);
  await w.send({ type: 'read', id: 953, name: 'i.blb', index: 0, sab, wait: true });
  clock = 20001;
  t.mock.timers.tick(20000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(header[0], -1);
  assert.match(new TextDecoder().decode(new Uint8Array(sab, 32, header[1])), /timed out/);
});

test('loading stays transparent for short misses and appears only after the reveal delay', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = await worker(t, { fetchResponse: async request => { await gate; return response(request); } });
  await w.init();
  let paint, clock = 0, panels = 0;
  t.mock.method(globalThis, 'setInterval', callback => { paint = callback; return 0; });
  t.mock.method(performance, 'now', () => clock);
  const context = { clearRect() {}, fillRect() { panels++; }, beginPath() {}, arc() {}, stroke() {}, fillText() {} };
  await w.send({ type: 'loading-canvas', canvas: { width: 640, height: 480, getContext: () => context } });
  const sab = new SharedArrayBuffer(32 + ORIGINAL_BLOCK_BYTES), header = new Int32Array(sab, 0, 8);
  await w.send({ type: 'read', id: 950, name: 'i.blb', index: 0, sab, wait: true });
  await until(() => w.requests.length === 1);
  clock = 100; paint(); assert.equal(panels, 0);
  clock = 250; paint(); assert.equal(panels, 1);
  assert.equal(header[0], 0, 'native read is still waiting while loading is visible');
  clock = 600; release();
  await until(() => header[0] === 1);
  const previous = panels; paint();
  assert.equal(panels, previous, 'completed reads do not keep painting the loading panel');
});

test('original worker initializes a seven-file index and fetches exact full and final partial blocks', async t => {
  const w = await worker(t);
  assert.equal((await w.init()).ready, true);
  assert.deepEqual(w.storage.calls.open, ['neverhood-verified-original-blocks-v1']);
  const first = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
  assert.equal(first.error, undefined);
  assert.deepEqual(new Uint8Array(first.bytes), w.block('i.blb', 0));
  const last = await w.sab('i.blb', 2);
  assert.equal(last.state, 1); assert.equal(last.length, 43);
  assert.deepEqual(last.bytes, w.block('i.blb', 2));
  assert.deepEqual(w.requests.map(({ url, start, end }) => ({ url, start, end })), [
    { url: 'https://release.test/original/i.blb', start: 0, end: 65535 },
    { url: 'https://release.test/original/i.blb', start: 131072, end: 131114 },
  ]);
  for (const { options } of w.requests) {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
  }
  assert.equal(first.stats.networkRequests, 1);
  assert.equal(first.stats.networkBytes, ORIGINAL_BLOCK_BYTES);
  assert(w.storage.entries.has(w.key('i.blb', 2)));
});

test('original worker rejects an index whose original URL leaves the release origin', async t => {
  const w = await worker(t), invalid = structuredClone(w.index);
  invalid.files['i.blb'].url = 'https://untrusted.test/i.blb';
  const result = await w.init(invalid);
  assert.match(result.error, /origin/); assert.equal(result.ready, undefined);
  assert.equal(w.requests.length, 0); assert.equal(w.storage.calls.open.length, 0);
});

test('original worker reuses verified persistent blocks offline across fresh module instances', async t => {
  const data = fixture(), storage = cacheStorage();
  await t.test('cold fill', async t => {
    const w = await worker(t, { data, storage }); await w.init();
    const result = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
    assert.deepEqual(new Uint8Array(result.bytes), w.block('i.blb', 0));
    assert.equal(w.requests.length, 1);
  });
  await t.test('warm offline worker', async t => {
    const w = await worker(t, { data, storage, fetchResponse() { throw new Error('offline'); } });
    await w.init();
    const result = await w.sab('i.blb', 0);
    assert.equal(result.state, 1); assert.deepEqual(result.bytes, w.block('i.blb', 0));
    const prefetched = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
    assert.equal(prefetched.stats.cacheHits, 2); assert.equal(w.requests.length, 0);
    assert.equal(prefetched.stats.networkBytes, 0);
  });
});

test('original worker detects and repairs corrupt cached bytes before delivering them', async t => {
  const w = await worker(t), bad = w.block('i.blb', 0); bad[11] ^= 255;
  w.storage.entries.set(w.key('i.blb', 0), new Response(bad));
  await w.init();
  const result = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
  assert.deepEqual(new Uint8Array(result.bytes), w.block('i.blb', 0));
  assert.equal(result.stats.corruptions, 1); assert.equal(result.stats.cacheHits, 0);
  assert.deepEqual(w.storage.calls.delete, [w.key('i.blb', 0)]);
  assert.equal(w.requests.length, 1);
  assert.deepEqual(new Uint8Array(await w.storage.entries.get(w.key('i.blb', 0)).arrayBuffer()), w.block('i.blb', 0));
});

test('original worker does not deliver corrupt cache data when repair is offline', async t => {
  const w = await worker(t, { fetchResponse() { throw new Error('offline'); } });
  w.storage.entries.set(w.key('i.blb', 0), new Response(new Uint8Array(ORIGINAL_BLOCK_BYTES)));
  await w.init();
  const result = await w.sab('i.blb', 0);
  assert.equal(result.state, -1); assert.match(new TextDecoder().decode(result.bytes), /offline/);
  assert.equal(w.storage.entries.has(w.key('i.blb', 0)), false);
});

test('original worker rejects incorrect HTTP status, ranges, lengths and SHA256 without caching', async t => {
  const cases = [
    ['whole-file 200', req => response(req, { status: 200 }), /exact byte range/],
    ['wrong range start', req => response(req, { headers: { 'Content-Range': 'bytes 1-65536/131115' } }), /exact byte range/],
    ['wrong total', req => response(req, { headers: { 'Content-Range': 'bytes 0-65535/131116' } }), /exact byte range/],
    ['missing range', req => { const res = response(req); res.headers.delete('Content-Range'); return res; }, /exact byte range/],
    ['declared length', req => response(req, { headers: { 'Content-Length': '1' } }), /length mismatch/],
    ['corrupt SHA', req => { const body = req.bytes.slice(); body[7] ^= 255; return response(req, { body }); }, /SHA256 mismatch/],
    ['oversized streamed body', req => {
      const res = response(req, { body: new ReadableStream({ start(controller) {
        controller.enqueue(req.bytes); controller.enqueue(new Uint8Array([1])); controller.close();
      } }) });
      res.headers.delete('Content-Length'); return res;
    }, /Oversized/],
    ['truncated streamed body', req => {
      const res = response(req, { body: req.bytes.subarray(0, req.bytes.length - 1) });
      res.headers.delete('Content-Length'); return res;
    }, /Truncated/],
    ['absent response body', req => { const res = response(req, { body: null }); return res; }, /no body/],
  ];
  for (const [label, fetchResponse, expected] of cases) await t.test(label, async t => {
    const w = await worker(t, { fetchResponse }); await w.init();
    const result = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
    assert.match(result.error, expected); assert.equal(result.bytes, undefined);
    assert.equal(w.storage.calls.put.length, 0); assert.equal(w.storage.entries.size, 0);
    assert.equal(w.requests.length, 1);
  });
});

test('original worker publishes SAB failure, then allows a new job to retry a failed fetch', async t => {
  let corrupt = true;
  const w = await worker(t, { fetchResponse(req) {
    const body = req.bytes.slice(); if (corrupt) body[0] ^= 255;
    return response(req, { body });
  } });
  await w.init();
  const failed = await w.sab('i.blb', 0);
  assert.equal(failed.state, -1); assert.match(new TextDecoder().decode(failed.bytes), /SHA256 mismatch/);
  assert.equal(w.storage.entries.size, 0);
  corrupt = false;
  const retry = await w.sab('i.blb', 0);
  assert.equal(retry.state, 1); assert.deepEqual(retry.bytes, w.block('i.blb', 0));
  assert.equal(w.requests.length, 2);
});

test('original worker delivers verified bytes despite cache quota exhaustion', async t => {
  const storage = cacheStorage(); storage.quota = true;
  const w = await worker(t, { storage }); await w.init();
  const result = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
  assert.equal(result.error, undefined); assert.match(result.cacheError, /QuotaExceededError/);
  assert.deepEqual(new Uint8Array(result.bytes), w.block('i.blb', 0));
  assert.equal(storage.entries.size, 0);
  const sab = await w.sab('i.blb', 2);
  assert.equal(sab.state, 1); assert.deepEqual(sab.bytes, w.block('i.blb', 2));
});

test('original worker starts and serves verified network bytes when CacheStorage is unavailable', async t => {
  const storage = { async open() { throw new Error('CacheStorage unavailable'); } };
  const w = await worker(t, { storage });
  const init = await w.init(); assert.equal(init.ready, true); assert.match(init.cacheError, /unavailable/);
  const result = await w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
  assert.equal(result.error, undefined); assert.match(result.cacheError, /unavailable/);
  assert.deepEqual(new Uint8Array(result.bytes), w.block('i.blb', 0));
});

test('original worker deduplicates concurrent prefetch and SAB jobs by verified block hash', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = await worker(t, { fetchResponse: async req => { await gate; return response(req); } });
  await w.init();
  const first = w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
  const second = w.request({ type: 'prefetch', name: 'i.blb', index: 0 });
  const sab = w.sab('i.blb', 0);
  try { await until(() => w.requests.length === 1); } finally { release(); }
  const [a, b, c] = await Promise.all([first, second, sab]);
  for (const result of [a, b]) assert.deepEqual(new Uint8Array(result.bytes), w.block('i.blb', 0));
  assert.equal(c.state, 1); assert.deepEqual(c.bytes, w.block('i.blb', 0));
  assert.equal(w.requests.length, 1); assert.equal(w.storage.calls.put.length, 1);
});

test('original worker runs at most four jobs and prioritizes queued reads over prefetch', async t => {
  const releases = [];
  const w = await worker(t, { fetchResponse: req => new Promise(resolve => {
    releases.push(() => resolve(response(req)));
  }) });
  await w.init();
  const names = REQUIRED_FILES.slice(0, 6);
  const jobs = names.slice(0, 4).map(name => w.request({ type: 'prefetch', name, index: 0 }));
  await until(() => w.requests.length === 4);
  jobs.push(w.request({ type: 'prefetch', name: names[4], index: 0 }));
  jobs.push(w.request({ type: 'read', name: names[5], index: 0 }));
  assert.equal(w.requests.length, 4);
  try {
    releases[0](); await until(() => w.requests.length === 5);
    assert.equal(w.requests[4].name, names[5]);
    releases[1](); await until(() => w.requests.length === 6);
    assert.equal(w.requests[5].name, names[4]);
  } finally { for (const release of releases) release(); }
  const results = await Promise.all(jobs);
  assert(results.every(result => result.bytes && !result.error));
});
