import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip } from '../web/test/zip-fixture.mjs';
import { buildStreamedHD } from '../scripts/prepare-streamed-hd.mjs';
import { loadStreamedDemoReplacementPackURL } from '../web/prototype/streamed-room-pack.js';

const runtimeSHA256 = 'a'.repeat(64), room = 'Scene1001';
const key = '1x1-1-00000001-p12345678-0';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'streamed-hd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = join(directory, 'base'), output = join(directory, 'output');
  await mkdir(base); await mkdir(output); await mkdir(join(base, 'rooms'));
  const image = Buffer.alloc(33);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 4, 4].forEach((n, i) => image.writeUInt32BE(n, i * 4));
  const manifest = { version: 2, private: true, lossless: true, scale: 4, room, runtimeSHA256,
    sourceBinding: 'fixture', images: [{ id: 'b'.repeat(64), file: 'images/a.png', format: 'png', width: 4, height: 4, sha256: digest(image) }],
    entries: [{ key, scale: 4, width: 4, height: 4, image: 'b'.repeat(64), crop: { x: 0, y: 0, width: 4, height: 4 },
      flipX: false, kind: 'sprite', resource: 'fixture', frameId: 0, sourceSHA256: 'c'.repeat(64) }], backgrounds: [] };
  const items = [{ path: 'room-pack.json', bytes: JSON.stringify(manifest), method: 0 }, { path: 'images/a.png', bytes: image, method: 0 }];
  mutate(items);
  const bytes = zip(items);
  const archive = { file: `rooms/${room}.zip`, bytes: bytes.length, sha256: digest(bytes) };
  await writeFile(join(base, archive.file), bytes);
  await writeFile(join(base, 'manifest.json'), JSON.stringify({ sourceRuntimeSHA256: runtimeSHA256, packs: { [room]: archive } }));
  return { base, output, archive, bytes, manifest, image };
}
async function prepared(t, mutate) {
  const f = await fixture(t, mutate);
  const mapping = await buildStreamedHD(f.base, f.output);
  const descriptor = mapping[room].streaming.index;
  const indexBytes = await readFile(join(f.output, descriptor.file));
  return { ...f, descriptor, indexBytes, index: JSON.parse(indexBytes), archive: { ...f.archive, ...mapping[room] } };
}
function serve(t, f, change = response => response) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.headers?.Range) return new Response(f.indexBytes);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
    return change(new Response(f.bytes.subarray(start, end + 1), { status: 206, headers: {
      'content-range': `bytes ${start}-${end}/${f.bytes.length}`, 'content-length': String(end - start + 1) } }), requests.length);
  });
  return requests;
}
const options = f => ({ runtimeSHA256, room, archive: { ...f.archive, streaming: { index: { ...f.descriptor,
  url: 'https://cdn.example/streamed-hd/Scene1001.json' } } } });
const load = f => loadStreamedDemoReplacementPackURL('https://cdn.example/rooms/Scene1001.zip', options(f));

test('metadata builder pins exact original STORE ranges without copying images', async t => {
  const f = await prepared(t);
  assert.equal(digest(f.indexBytes), f.descriptor.sha256);
  assert.equal(f.index.archive.url, '/__stream-hd/Scene1001.zip');
  const m = f.index.members['images/a.png'];
  assert.deepEqual(f.bytes.subarray(m.offset, m.offset + m.bytes), f.image);
  assert.equal(m.sha256, digest(f.image)); assert.equal(typeof m.crc32, 'number');
  assert.deepEqual(JSON.parse(f.bytes.subarray(f.index.manifest.offset, f.index.manifest.offset + f.index.manifest.bytes)), f.manifest);
  await assert.rejects(readFile(join(f.output, 'images/a.png')), { code: 'ENOENT' });
});

test('builder rejects compression, unsafe paths, missing members, CRC and local header mismatch', async t => {
  for (const [mutate, pattern] of [
    [items => { items[1].method = 8; }, /STORE/],
    [items => { items[1].path = '../bad.png'; }, /unsafe/],
    [items => { items.pop(); }, /missing/],
    [items => { items[0].crc = 1; }, /CRC/],
    [items => { items.push({ path: 'unused.png', bytes: 'x', method: 0 }); }, /unreferenced/],
  ]) {
    const f = await fixture(t, mutate);
    await assert.rejects(buildStreamedHD(f.base, f.output), pattern);
  }
  const f = await fixture(t); f.bytes.writeUInt32LE(1, 18);
  await writeFile(join(f.base, f.archive.file), f.bytes);
  await assert.rejects(buildStreamedHD(f.base, f.output), /disagree/);
});

test('loader requests only pinned index and manifest before lazy image decode, retains queue interface', async t => {
  const f = await prepared(t), requests = serve(t, f);
  const old = globalThis.createImageBitmap;
  t.after(() => { if (old) globalThis.createImageBitmap = old; else delete globalThis.createImageBitmap; });
  let closed = 0, decoded;
  globalThis.createImageBitmap = async blob => { decoded = Buffer.from(await blob.arrayBuffer()); return { width: 4, height: 4, close() { closed++; } }; };
  const pack = await load(f);
  assert.equal(requests.length, 2); assert.equal(pack.stats().imageRequests, 0);
  assert.equal(requests[1].options.headers.Range, `bytes=${f.index.manifest.offset}-${f.index.manifest.offset + f.index.manifest.bytes - 1}`);
  pack.observe([key]); await Promise.all(pack.pending.values());
  assert.equal(requests.length, 3); assert.deepEqual(decoded, f.image);
  assert.equal(pack.observe([key]).size, 1); assert.equal(pack.stats().fullArchiveVerified, false);
  assert.equal(pack.stats().archiveBytes, 0); assert.equal(pack.stats().rangeRequests, 2);
  pack.dispose(); assert.equal(closed, 1); assert.equal(pack.stats().encodedCacheBytes, 0);
  assert.equal(requests[2].options.signal.aborted, false, 'completed downloads detach from pack cancellation');
});

for (const stage of ['headers', 'body']) for (const cancellation of ['timeout', 'caller']) {
  test(`range download cancels stalled ${stage} on ${cancellation}`, { timeout: 2000 }, async t => {
    const f = await prepared(t), caller = new AbortController();
    const requests = serve(t, f), original = globalThis.fetch;
    let underlying;
    t.mock.method(globalThis, 'fetch', (url, opts) => {
      if (!opts.headers?.Range) return original(url, opts);
      underlying = opts.signal;
      if (cancellation === 'caller') setTimeout(() => caller.abort(), 5);
      if (stage === 'headers') return new Promise(() => {});
      const meta = f.index.manifest, end = meta.offset + meta.bytes - 1;
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1]));
        opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason), { once: true });
      } }), { status: 206, headers: {
        'content-range': `bytes ${meta.offset}-${end}/${f.bytes.length}`, 'content-length': String(meta.bytes),
      } }));
    });
    await assert.rejects(loadStreamedDemoReplacementPackURL('https://cdn.example/rooms/Scene1001.zip', {
      ...options(f), signal: caller.signal, timeoutMs: cancellation === 'timeout' ? 20 : 1000,
    }), { name: cancellation === 'timeout' ? 'TimeoutError' : 'AbortError' });
    assert.equal(underlying.aborted, true);
    assert.equal(requests.length, 1, 'no whole archive fallback');
  });
}

test('lazy range timeout leaves the pack alive and settles its worker after an idle lifetime', { timeout: 2000 }, async t => {
  const f = await prepared(t), requests = serve(t, f), original = globalThis.fetch;
  let stalled;
  t.mock.method(globalThis, 'fetch', (url, opts) => {
    if (opts.headers?.Range !== `bytes=${f.index.members['images/a.png'].offset}-${f.index.members['images/a.png'].offset + f.image.length - 1}`)
      return original(url, opts);
    stalled = opts.signal;
    return new Promise(() => {});
  });
  const pack = await loadStreamedDemoReplacementPackURL('https://cdn.example/rooms/Scene1001.zip', { ...options(f), timeoutMs: 30 });
  t.after(() => pack.dispose());
  await new Promise(resolve => setTimeout(resolve, 50));
  pack.observe([key]); await Promise.all(pack.pending.values());
  assert.equal(stalled.aborted, true);
  assert.match(pack.stats().errors['images/a.png'], /timed out/);
  assert.equal(pack.stats().pendingLoads, 0);
  assert.equal(pack.stats().encodedCacheBytes, 0);
  assert.equal(pack.stats().loaded, true);
  assert.equal(requests.length, 2);
});

test('strict 206 response, Content-Range, length, SHA and CRC fail closed without full ZIP fallback', async t => {
  for (const change of [
    r => new Response(r.body),
    r => { r.headers.set('content-range', 'bytes 0-1/2'); return r; },
    r => { r.headers.delete('content-length'); return r; },
    r => { r.headers.set('content-encoding', 'gzip'); return r; },
  ]) {
    const f = await prepared(t), requests = serve(t, f, change);
    await assert.rejects(load(f), /206/); assert.equal(requests.length, 2);
  }
  const f = await prepared(t); f.bytes[f.index.manifest.offset] ^= 1;
  serve(t, f); await assert.rejects(load(f), /SHA256/);
});

test('rejects mismatched metadata/runtime/room/ranges and aborted selection before image fetch', async t => {
  for (const change of [i => { i.room = 'Scene1002'; }, i => { i.runtimeSHA256 = 'f'.repeat(64); },
    i => { i.members['images/a.png'].offset = i.archive.bytes; },
    i => { i.members['images/a.png'].sha256 = 'f'.repeat(64); },
    i => { i.members['images/a.png'].offset = i.manifest.offset; }]) {
    const f = await prepared(t); change(f.index);
    f.indexBytes = Buffer.from(JSON.stringify(f.index)); f.descriptor.bytes = f.indexBytes.length; f.descriptor.sha256 = digest(f.indexBytes);
    const requests = serve(t, f); await assert.rejects(load(f)); assert.ok(requests.length <= 2);
  }
  const f = await prepared(t), requests = serve(t, f), controller = new AbortController(); controller.abort();
  await assert.rejects(loadStreamedDemoReplacementPackURL('https://cdn.example/room.zip', { ...options(f), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

test('persistent content cache supports warm load and repairs corrupt members; quota falls back safely', async t => {
  const data = new Map(); let quota = false;
  const cache = { async match(key) { return data.get(String(key))?.clone(); }, async delete(key) { return data.delete(String(key)); },
    async keys() { return [...data.keys()]; }, async put(key, response) { if (quota) throw new Error('quota'); data.set(String(key), response.clone()); } };
  const previous = globalThis.caches;
  globalThis.caches = { async open(name) { assert.equal(name, 'neverhood-streamed-hd-v1'); return cache; } };
  t.after(() => { if (previous) globalThis.caches = previous; else delete globalThis.caches; });
  const f = await prepared(t), requests = serve(t, f);
  (await load(f)).dispose(); assert.equal(requests.length, 2);
  const warm = await load(f); assert.equal(requests.length, 2); assert.equal(warm.stats().cacheHits, 2); warm.dispose();
  const cacheKey = [...data.keys()].find(k => k.endsWith(f.index.manifest.sha256));
  data.set(cacheKey, new Response(Buffer.alloc(f.index.manifest.bytes), { headers: { 'content-length': String(f.index.manifest.bytes) } }));
  (await load(f)).dispose(); assert.equal(requests.length, 3);
  data.clear(); quota = true;
  const fallback = await load(f); assert.equal(fallback.stats().cacheError, 'quota'); fallback.dispose();
});

test('lazy images verify indexed CRC and PNG header even with independently matching SHA pins', async t => {
  for (const mode of ['crc', 'header']) {
    const f = await prepared(t, mode === 'header' ? items => {
      items[1].bytes.writeUInt32BE(8, 16);
      const manifest = JSON.parse(items[0].bytes);
      manifest.images[0].sha256 = digest(items[1].bytes);
      items[0].bytes = JSON.stringify(manifest);
    } : undefined);
    if (mode === 'crc') {
      f.index.members['images/a.png'].crc32 ^= 1;
      f.indexBytes = Buffer.from(JSON.stringify(f.index));
      f.descriptor.bytes = f.indexBytes.length; f.descriptor.sha256 = digest(f.indexBytes);
    }
    const requests = serve(t, f), pack = await load(f);
    pack.observe([key]); await Promise.all(pack.pending.values());
    assert.match(pack.stats().errors['images/a.png'], mode === 'crc' ? /CRC/ : /dimensions/);
    assert.equal(requests.length, 3); assert.equal(pack.cache.size, 0); pack.dispose();
  }
});

test('disposal aborts an in-flight lazy range and cannot repopulate encoded memory', async t => {
  const f = await prepared(t);
  let release;
  const requests = serve(t, f, (response, count) => count === 3 ? new Promise(resolve => { release = () => resolve(response); }) : response);
  const pack = await load(f);
  pack.observe([key]);
  const pending = [...pack.pending.values()];
  while (!release) await new Promise(resolve => setImmediate(resolve));
  pack.dispose(); assert.equal(requests[2].options.signal.aborted, true);
  release(); await Promise.all(pending);
  assert.equal(pack.stats().encodedCacheBytes, 0); assert.equal(pack.cache.size, 0);
});

test('offline re-entry retains verified cached background when a newly visible sprite was never cached', async t => {
  const f = await prepared(t, items => {
    const manifest = JSON.parse(items[0].bytes), background = Buffer.from(items[1].bytes);
    background.writeUInt32BE(2560, 16); background.writeUInt32BE(1920, 20);
    manifest.images.push({ id: 'd'.repeat(64), file: 'images/bg.png', format: 'png', width: 2560, height: 1920, sha256: digest(background) });
    manifest.backgrounds.push({ id: 'gemini', label: 'Gemini', key: '640x480-640-00000002-p12345678-opaque',
      scale: 4, width: 2560, height: 1920, image: 'd'.repeat(64),
      crop: { x: 0, y: 0, width: 2560, height: 1920 }, flipX: false });
    items[0].bytes = JSON.stringify(manifest); items.push({ path: 'images/bg.png', bytes: background, method: 0 });
  });
  const stored = new Map();
  const previousCache = globalThis.caches, previousBitmap = globalThis.createImageBitmap;
  globalThis.caches = { async open() { return {
    async match(key) { return stored.get(String(key))?.clone(); },
    async keys() { return [...stored.keys()]; }, async delete(key) { return stored.delete(String(key)); },
    async put(key, value) { stored.set(String(key), value.clone()); },
  }; } };
  globalThis.createImageBitmap = async blob => {
    const bytes = new DataView(await blob.arrayBuffer());
    return { width: bytes.getUint32(16), height: bytes.getUint32(20), close() {} };
  };
  t.after(() => {
    if (previousCache) globalThis.caches = previousCache; else delete globalThis.caches;
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap; else delete globalThis.createImageBitmap;
  });
  serve(t, f);
  const first = await load(f), backgroundKey = first.backgrounds.get('gemini').key;
  first.selectBackground('gemini'); first.observe([backgroundKey]); await Promise.all(first.pending.values());
  first.dispose();
  const attempts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { attempts.push({ url, range: options.headers?.Range }); throw new TypeError('offline'); });
  const returned = await load(f);
  returned.selectBackground('gemini'); returned.observe([backgroundKey, key]); await Promise.all(returned.pending.values());
  const draws = returned.observe([backgroundKey, key]);
  assert.equal(draws.has(backgroundKey), true); assert.equal(draws.has(key), false);
  assert.equal(returned.stats().loaded, true); assert.equal(returned.stats().cacheHits, 3);
  assert.equal(returned.stats().fetchedBytes, 0); assert.equal(returned.stats().cacheError, null);
  assert.deepEqual(returned.stats().errors, { 'images/a.png': 'offline' });
  const missing = f.index.members['images/a.png'];
  assert.deepEqual(attempts, [{ url: 'https://cdn.example/__stream-hd/Scene1001.zip', range: `bytes=${missing.offset}-${missing.offset + missing.bytes - 1}` }]);
  returned.dispose();
});
