import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zip } from '../web/test/zip-fixture.mjs';
import { validateRoomArchive, ROOM_ARCHIVE_LIMITS } from '../web/prototype/room-archive.js';
import { loadDemoReplacementPackURL, PACK_LIMITS } from '../web/prototype/replacement-pack.js';

const runtimeSHA256 = 'a'.repeat(64);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = (n, w = 1, h = 1) => `${w}x${h}-${w}-${n.toString(16).padStart(8, '0')}-p12345678-0`;
function webp(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8X', 8); bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}
function fixture() {
  const sprite = webp(4, 4), background = webp(2560, 1920);
  const images = [sprite, background].map((bytes, index) => ({ id: String(index + 1).repeat(64),
    file: `images/${index}.webp`, format: 'webp', width: index ? 2560 : 4, height: index ? 1920 : 4, sha256: digest(bytes) }));
  const binding = (index, sourceKey) => ({ key: sourceKey, scale: 4, width: images[index].width, height: images[index].height,
    image: images[index].id, crop: { x: 0, y: 0, width: images[index].width, height: images[index].height }, flipX: false });
  const manifest = { version: 2, private: true, scale: 4, room: 'Scene1001', runtimeSHA256, sourceBinding: 'synthetic', images,
    entries: [1, 2].map(n => ({ ...binding(0, key(n)), kind: 'sprite', resource: 'synthetic', frameId: n, sourceSHA256: 'b'.repeat(64) })),
    backgrounds: [{ ...binding(1, key(3, 640, 480)), id: 'gemini', label: 'Gemini' }] };
  return { manifest, items: () => [{ path: 'room-pack.json', bytes: JSON.stringify(manifest), method: 0 },
    ...images.map((image, index) => ({ path: image.file, bytes: [sprite, background][index], method: 0 }))] };
}
const options = { runtimeSHA256, room: 'Scene1001' };
const validate = bytes => validateRoomArchive(bytes, options);

test('STORE archive preserves v2 manifest, shared bindings, and zero-copy encoded views', async () => {
  const value = fixture(), bytes = zip(value.items()), result = await validate(bytes);
  assert.deepEqual(result.manifest, value.manifest);
  assert.equal(result.entries.size, 2); assert.equal(result.backgrounds.size, 1); assert.equal(result.files.size, 2);
  for (const payload of result.files.values()) assert.equal(payload.buffer, bytes.buffer);
  assert.equal(result.entries.get(key(1)).imageResource, result.entries.get(key(2)).imageResource);
});

test('lossless opt-in uses the same v2 room ZIP validation for other rooms and PNG bytes', async () => {
  const value = fixture(), bytes = Buffer.alloc(33);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 4, 4].forEach((n, i) => bytes.writeUInt32BE(n, i * 4));
  Object.assign(value.manifest, { lossless: true, room: 'Scene1402-native-state', backgrounds: [] });
  value.manifest.images = [{ ...value.manifest.images[0], file: 'images/frame.png', format: 'png', sha256: digest(bytes) }];
  const archive = zip([{ path: 'room-pack.json', bytes: JSON.stringify(value.manifest), method: 0 },
    { path: 'images/frame.png', bytes, method: 0 }]);
  const result = await validateRoomArchive(archive, { runtimeSHA256, room: value.manifest.room });
  assert.equal(result.entries.size, 2);
  assert.deepEqual(Buffer.from(result.files.get('images/frame.png')), bytes);
  await assert.rejects(validateRoomArchive(archive, { runtimeSHA256, room: '../evil' }), /room/);
  await assert.rejects(validateRoomArchive(archive, { runtimeSHA256, room: 'Scene1403' }), /match/);
});

test('rejects duplicates, unsafe paths, directories, compression, encryption, CRC, truncation, and overlaps', async () => {
  const value = fixture();
  const variants = [
    [items => [...items, items[1]], /duplicate/],
    [items => [...items, { path: '../evil.webp', bytes: 'x', method: 0 }], /unsafe/],
    [items => [...items, { path: 'evil%20.webp', bytes: 'x', method: 0 }], /unsafe/],
    [items => [...items, { path: 'images/', bytes: 'x', method: 0 }], /directory/],
    [items => items.map((item, i) => i === 1 ? { ...item, method: 8 } : item), /STORE/],
    [items => items.map((item, i) => i === 1 ? { ...item, flags: 1 } : item), /encrypted/],
    [items => items.map((item, i) => i === 1 ? { ...item, crc: 123 } : item), /CRC/],
    [items => [...items, { path: 'unused.webp', bytes: webp(4, 4), method: 0 }], /unreferenced/],
    [items => items.slice(0, -1), /missing/],
  ];
  for (const [mutate, error] of variants) await assert.rejects(validate(zip(mutate(value.items()))), error);
  const bytes = zip(value.items());
  await assert.rejects(validate(bytes.subarray(0, -1)), /directory|truncated/);
  const overlap = Buffer.from(bytes), directory = overlap.readUInt32LE(overlap.length - 6);
  const second = directory + 46 + Buffer.byteLength('room-pack.json');
  overlap.writeUInt32LE(0, second + 42);
  await assert.rejects(validate(overlap), /overlapping|disagree/);
});

test('verifies runtime, expected room, Gemini, manifest version, every image hash and header upfront', async () => {
  for (const [change, error] of [
    [m => { m.runtimeSHA256 = 'c'.repeat(64); }, /runtime/],
    [m => { m.room = 'Scene1002'; }, /room/],
    [m => { m.backgrounds[0].id = 'realesrnet'; }, /Gemini/],
    [m => { m.version = 1; }, /version 2/],
    [m => { m.images[1].sha256 = 'c'.repeat(64); }, /SHA256/],
    [m => { m.images[0].width = 3; m.entries.forEach(e => { e.crop.width = 3; }); }, /dimensions/],
  ]) {
    const value = fixture(); change(value.manifest);
    await assert.rejects(validate(zip(value.items())), error);
  }
  const value = fixture();
  await assert.rejects(validateRoomArchive(zip(value.items()), { runtimeSHA256 }), /expected room/);
  await assert.rejects(validate(new Uint8Array(ROOM_ARCHIVE_LIMITS.bytes + 1)), /byte limit/);
  const count = zip(value.items()); count.writeUInt16LE(PACK_LIMITS.files + 1, count.length - 14); count.writeUInt16LE(PACK_LIMITS.files + 1, count.length - 12);
  await assert.rejects(validate(count), /count/);
});

test('archive loader makes one pinned download, decodes shared images on demand, exposes retention, disposes in-flight decode', async t => {
  const bytes = zip(fixture().items()), requests = [], decodes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(bytes, { headers: { 'content-length': '1', 'content-encoding': 'br' } });
  });
  let resolveDecode;
  const originalBitmap = globalThis.createImageBitmap;
  t.after(() => { if (originalBitmap) globalThis.createImageBitmap = originalBitmap; else delete globalThis.createImageBitmap; });
  globalThis.createImageBitmap = blob => {
    decodes.push(blob); return new Promise(resolve => { resolveDecode = resolve; });
  };
  const pack = await loadDemoReplacementPackURL('https://cdn.example/room1.zip', { ...options,
    archive: { bytes: bytes.length, sha256: digest(bytes) } });
  assert.equal(decodes.length, 0); assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(pack.stats().imageRequests, 0); assert.equal(pack.stats().archiveRequests, 1);
  assert.equal(pack.stats().archiveBytes, bytes.length); assert.equal(pack.stats().encodedBytes, bytes.length);
  pack.observe([key(1), key(2)]); await Promise.resolve();
  assert.equal(decodes.length, 1);
  const pending = [...pack.pending.values()];
  pack.dispose();
  assert.equal(pack.stats().encodedBytes, 0); assert.equal(pack.stats().encodedCacheBytes, 0);
  assert.equal(pack.files.size, 0); assert.equal(pack.pending.size, 0);
  assert.equal(requests[0].options.signal.aborted, true);
  let closed = 0; resolveDecode({ width: 4, height: 4, close() { closed++; } });
  await Promise.all(pending); assert.equal(closed, 1); assert.equal(requests.length, 1);
});

test('archive requires valid pins before fetch, rejects mismatches without fallback and honors pre-abort', async t => {
  const bytes = zip(fixture().items()); let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(bytes); });
  const url = 'https://cdn.example/room1.zip';
  for (const archive of [null, {}, { bytes: bytes.length, sha256: 'bad' }, { bytes: ROOM_ARCHIVE_LIMITS.bytes + 1, sha256: digest(bytes) }]) {
    await assert.rejects(loadDemoReplacementPackURL(url, { ...options, archive }), /pinned/);
  }
  assert.equal(requests, 0);
  for (const archive of [{ bytes: bytes.length, sha256: 'f'.repeat(64) }, { bytes: bytes.length + 1, sha256: digest(bytes) }]) {
    await assert.rejects(loadDemoReplacementPackURL(url, { ...options, archive }), /SHA256|Incomplete/);
  }
  assert.equal(requests, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadDemoReplacementPackURL(url, { ...options, signal: controller.signal,
    archive: { bytes: bytes.length, sha256: digest(bytes) } }), { name: 'AbortError' });
  await assert.rejects(validateRoomArchive(bytes, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 2);
});

test('archive decoded LRU evicts without ever downloading individual images', async t => {
  const bytes = zip(fixture().items()); let requests = 0, decodes = 0, closed = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(bytes); });
  const originalBitmap = globalThis.createImageBitmap;
  t.after(() => { if (originalBitmap) globalThis.createImageBitmap = originalBitmap; else delete globalThis.createImageBitmap; });
  globalThis.createImageBitmap = async blob => {
    decodes++; const view = new DataView(await blob.arrayBuffer());
    return { width: 1 + view.getUint16(24, true), height: 1 + view.getUint16(27, true), close() { closed++; } };
  };
  const budget = 2560 * 1920 * 4;
  const pack = await loadDemoReplacementPackURL('https://cdn.example/room1.zip', { ...options, cacheBytes: budget,
    archive: { bytes: bytes.length, sha256: digest(bytes) } });
  const observe = async keys => { pack.observe(keys); await Promise.all([...pack.pending.values()]); };
  await observe([key(1), key(2)]);
  assert.equal(decodes, 1); assert.equal(pack.observe([key(2)]).size, 1);
  pack.selectBackground('gemini'); await observe([key(3, 640, 480)]);
  assert.equal(closed, 1); assert.equal(pack.stats().cacheBytes, budget);
  await observe([key(1)]); assert.equal(decodes, 3); assert.equal(requests, 1);
  assert.equal(pack.stats().imageRequests, 0); assert.equal(pack.stats().encodedBytes, bytes.length);
  pack.dispose(); assert.equal(closed, 3);
});

test('external abort releases an installed archive and parser yields for cancellation', async t => {
  const value = fixture(), bytes = zip(value.items());
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const controller = new AbortController();
  const pack = await loadDemoReplacementPackURL('https://cdn.example/room1.zip', { ...options, signal: controller.signal,
    archive: { bytes: bytes.length, sha256: digest(bytes) } });
  controller.abort(); assert.equal(pack.stats().loaded, false); assert.equal(pack.stats().encodedBytes, 0);
  const large = value.items(); large.push({ path: 'large.webp', method: 0, bytes: Buffer.alloc(2 * 1024 ** 2) });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 0);
  try { await assert.rejects(validateRoomArchive(zip(large), { ...options, signal: abort.signal }), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
});

class MemoryCacheStorage {
  constructor() { this.stores = new Map(); this.operations = []; this.onPut = () => {}; }
  async open(name) {
    if (!this.stores.has(name)) {
      const values = new Map(), owner = this;
      this.stores.set(name, {
        values,
        async match(key) { return values.get(String(key))?.clone(); },
        async put(key, response) {
          owner.onPut(name, String(key), response);
          owner.operations.push(['put', name, String(key)]);
          values.set(String(key), response.clone());
        },
        async keys() { return [...values.keys()].map(url => new Request(url)); },
        async delete(key) { owner.operations.push(['delete-key', name, String(key)]); return values.delete(String(key)); },
      });
    }
    return this.stores.get(name);
  }
  async delete(name) { this.operations.push(['delete-cache', name]); return this.stores.delete(name); }
}

function installGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
}
function cachedFixture(t, items = fixture().items()) {
  const storage = new MemoryCacheStorage(), bytes = zip(items), requests = [], progress = [];
  installGlobal(t, 'caches', storage);
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, options }); return new Response(bytes); });
  installGlobal(t, 'createImageBitmap', async blob => {
    const view = new DataView(await blob.arrayBuffer());
    return { width: 1 + view.getUint16(24, true), height: 1 + view.getUint16(27, true), close() {} };
  });
  const load = extra => loadDemoReplacementPackURL('https://cdn.example/room1.zip', { ...options,
    archive: { bytes: bytes.length, sha256: digest(bytes) }, onProgress: (...args) => progress.push(args), ...extra });
  const generation = () => [...storage.stores].find(([name]) => name.length > `neverhood-room-v1-Scene1001-${digest(bytes)}`.length)?.[1];
  return { storage, bytes, requests, progress, load, generation };
}
async function observe(pack, keys = [key(1)]) {
  pack.observe(keys); await Promise.all([...pack.pending.values()]);
}

test('CacheStorage cold install commits last, frees archive, and warm reload makes zero network requests', async t => {
  const value = cachedFixture(t);
  const cold = await value.load();
  assert.equal(cold.stats().persistent, true); assert.equal(cold.stats().persistentCacheHit, false);
  assert.equal(cold.stats().archiveRequests, 1); assert.equal(cold.stats().archiveBytes, value.bytes.length);
  assert.equal(cold.stats().retainedEncodedBytes, 0); assert.equal(cold.stats().encodedBytes, 0);
  const puts = value.storage.operations.filter(([op]) => op === 'put');
  assert.match(puts.at(-1)[2], /\/index$/); assert.match(puts.at(-2)[2], /\/complete$/);
  assert.equal(puts.filter(([, , url]) => url.includes('/images/')).length, 2);
  await observe(cold, [key(1), key(2)]); assert.equal(cold.observe([key(1), key(2)]).size, 2);
  cold.dispose();
  value.requests.length = 0;
  const warm = await value.load();
  assert.equal(warm.stats().persistent, true); assert.equal(warm.stats().persistentCacheHit, true);
  assert.equal(warm.stats().archiveRequests, 0); assert.equal(warm.stats().archiveBytes, 0);
  await observe(warm); assert.equal(warm.observe([key(1)]).size, 1);
  assert.equal(value.requests.length, 0); assert.equal(warm.stats().imageRequests, 0);
  assert.ok(value.progress.some(([, , phase]) => phase === 'download'));
  assert.ok(value.progress.some(([, , phase]) => phase === 'verify'));
  assert.ok(value.progress.some(([, , phase]) => phase === 'cache'));
  assert.deepEqual(value.progress.at(-1), [value.bytes.length, value.bytes.length, 'cached']);
  warm.dispose();
});

test('cached membership is independent of ZIP entry ordering', async t => {
  const value = cachedFixture(t, fixture().items().reverse());
  const cold = await value.load(); cold.dispose();
  const warm = await value.load(); assert.equal(warm.stats().persistentCacheHit, true);
  assert.equal(value.requests.length, 1); warm.dispose();
});

test('incomplete cache, corrupt manifest, wrong marker pins, missing membership and invalid sizes rebuild once', async t => {
  for (const mutate of [
    cache => cache.values.delete([...cache.values.keys()].find(url => url.endsWith('/complete'))),
    cache => cache.values.set([...cache.values.keys()].find(url => url.endsWith('/room-pack.json')), new Response('{}')),
    async cache => {
      const key = [...cache.values.keys()].find(url => url.endsWith('/complete'));
      const marker = await cache.values.get(key).clone().json(); marker.sourceRuntimeSHA256 = '0'.repeat(64);
      cache.values.set(key, new Response(JSON.stringify(marker)));
    },
    cache => cache.values.delete([...cache.values.keys()].find(url => url.includes('/images/'))),
    async cache => {
      const key = [...cache.values.keys()].find(url => url.endsWith('/complete'));
      const marker = await cache.values.get(key).clone().json(); marker.files[0].bytes = PACK_LIMITS.fileBytes + 1;
      cache.values.set(key, new Response(JSON.stringify(marker)));
    },
  ]) {
    await t.test('invalid cache metadata', async sub => {
      const value = cachedFixture(sub), pack = await value.load(); pack.dispose();
      await mutate(value.generation());
      const retry = await value.load();
      assert.equal(value.requests.length, 2); assert.equal(retry.stats().persistentCacheHit, false);
      assert.equal(retry.stats().persistent, true); retry.dispose();
    });
  }
});

test('cached image tampering is rejected before decode, invalidates marker, and retry rebuilds', async t => {
  const value = cachedFixture(t), first = await value.load(); first.dispose();
  const pack = await value.load(), cache = value.generation();
  const path = [...cache.values.keys()].find(url => url.includes('/images/images/0.webp'));
  const tampered = webp(4, 4); tampered[20] = 2;
  cache.values.set(path, new Response(tampered));
  let decodes = 0; globalThis.createImageBitmap = async () => { decodes++; throw new Error('must not decode'); };
  await observe(pack);
  assert.equal(decodes, 0); assert.match(pack.stats().cacheError, /missing or corrupt.*Restart/);
  assert.match(Object.values(pack.stats().errors)[0], /missing or corrupt/);
  assert.equal([...cache.values.keys()].some(url => url.endsWith('/complete')), false);
  assert.equal(value.requests.length, 1); pack.dispose();
  const retry = await value.load();
  assert.equal(value.requests.length, 2); assert.equal(retry.stats().persistentCacheHit, false); retry.dispose();
});

test('a cached image removed after pack installation is an explicit retryable failure', async t => {
  const value = cachedFixture(t), first = await value.load(); first.dispose();
  const pack = await value.load(), cache = value.generation();
  cache.values.delete([...cache.values.keys()].find(url => url.includes('/images/images/0.webp')));
  await observe(pack); assert.match(pack.stats().cacheError, /missing or corrupt/);
  assert.equal([...cache.values.keys()].some(url => url.endsWith('/complete')), false);
  pack.dispose(); const retry = await value.load();
  assert.equal(value.requests.length, 2); retry.dispose();
});

test('CacheStorage quota/security/unavailable falls back to one bounded in-memory archive', async t => {
  for (const mode of ['quota', 'security', 'unavailable']) {
    await t.test(mode, async sub => {
      const value = cachedFixture(sub);
      if (mode === 'quota') value.storage.onPut = () => { throw new DOMException('Full', 'QuotaExceededError'); };
      if (mode === 'security') value.storage.open = async () => { throw new DOMException('Blocked', 'SecurityError'); };
      if (mode === 'unavailable') globalThis.caches = undefined;
      const pack = await value.load();
      assert.equal(pack.stats().persistent, false); assert.equal(pack.stats().persistentCacheHit, false);
      assert.equal(pack.stats().retainedEncodedBytes, value.bytes.length); assert.equal(value.requests.length, 1);
      await observe(pack); assert.equal(pack.observe([key(1)]).size, 1);
      assert.equal([...value.storage.stores.values()].some(cache => [...cache.values.keys()].some(url => url.endsWith('/complete'))), false);
      pack.dispose(); assert.equal(pack.stats().retainedEncodedBytes, 0);
    });
  }
});

test('abort during cache writes never publishes completed cache and retry downloads again', async t => {
  const value = cachedFixture(t), controller = new AbortController();
  value.storage.onPut = (name, url) => { if (url.includes('/images/')) controller.abort(); };
  await assert.rejects(value.load({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal([...value.storage.stores.values()].some(cache => [...cache.values.keys()].some(url => /\/(complete|index)$/.test(url))), false);
  value.storage.onPut = () => {};
  const retry = await value.load(); assert.equal(value.requests.length, 2); retry.dispose();
});

test('aborted archive download cannot publish cache metadata', async t => {
  const value = cachedFixture(t), controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(value.bytes); controller.abort(); stream.close(); },
  })));
  await assert.rejects(value.load({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(value.storage.operations.filter(([operation]) => operation === 'put').length, 0);
});

test('disposing during a pending cached read cancels it without invalidating valid cache', async t => {
  const value = cachedFixture(t), first = await value.load(); first.dispose();
  const pack = await value.load(), cache = value.generation(), match = cache.match.bind(cache);
  let cancelled = false, started;
  const ready = new Promise(resolve => { started = resolve; });
  cache.match = async url => String(url).includes('/images/') ? new Response(new ReadableStream({
    start() { started(); }, cancel() { cancelled = true; },
  })) : match(url);
  pack.observe([key(1)]); await ready;
  const pending = [...pack.pending.values()]; pack.dispose(); await Promise.all(pending);
  assert.equal(cancelled, true); assert.equal(pack.stats().cacheError, null);
  assert.equal([...cache.values.keys()].some(url => url.endsWith('/complete')), true);
});

test('navigator.locks serializes writers and second caller reuses committed cache', async t => {
  const value = cachedFixture(t), calls = [];
  let tail = Promise.resolve();
  installGlobal(t, 'navigator', { locks: { request(name, options, callback) {
    calls.push({ name, options }); const result = tail.then(callback); tail = result.catch(() => {}); return result;
  } } });
  const packs = await Promise.all([value.load(), value.load()]);
  assert.equal(calls.length, 2); assert.equal(calls[0].name, calls[1].name);
  assert.equal(calls[0].options.mode, 'exclusive'); assert.equal(value.requests.length, 1);
  assert.equal(packs.filter(pack => pack.stats().persistentCacheHit).length, 1);
  packs.forEach(pack => pack.dispose());
});

test('without locks, aborted generation never deletes another concurrent completed writer', async t => {
  const value = cachedFixture(t), controller = new AbortController();
  installGlobal(t, 'navigator', {});
  let firstWriter = null;
  value.storage.onPut = (name, url) => {
    if (!firstWriter && url.includes('/images/')) { firstWriter = name; controller.abort(); }
  };
  const [aborted, completed] = await Promise.allSettled([value.load({ signal: controller.signal }), value.load()]);
  assert.equal(aborted.status, 'rejected'); assert.equal(completed.status, 'fulfilled');
  const published = [...value.storage.stores.values()].filter(cache => [...cache.values.keys()].some(url => url.endsWith('/complete')));
  assert.equal(published.length, 1);
  const warm = await value.load(); assert.equal(warm.stats().persistentCacheHit, true);
  warm.dispose(); completed.value.dispose();
});
