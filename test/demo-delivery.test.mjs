import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStaticServer } from '../server.mjs';
import { demoAddress, demoAssetURL, fetchDemoBytes, validateDemoManifest } from '../web/lib/demo-data.js';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { loadDemoReplacementPackURL, loadReplacementPackURL } from '../web/prototype/replacement-pack.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeSHA256 = 'a'.repeat(64);
function manifest() {
  return { version: 1, id: 'two-rooms-v1', sourceRuntimeSHA256: runtimeSHA256,
    files: REQUIRED_FILES.map(name => ({ name, file: `game/${name}`, bytes: 16, sha256: sha(Buffer.alloc(16)) })),
    packs: { Scene1001: 'room1/room-pack.json', Scene1002: 'room2/room-pack.json' }, cursor: 'cursor/cursor.json' };
}

test('demo release validates all seven game archives, room packs, paths and runtime binding', () => {
  assert.equal(validateDemoManifest(manifest(), runtimeSHA256).totalBytes, 112);
  for (const change of [m => m.files.pop(), m => { m.files[0].bytes = 0; }, m => { m.files[0].sha256 = 'bad'; },
    m => { m.files[0].name = 'setup.exe'; }, m => { m.files[1].file = m.files[0].file; },
    m => { m.packs.Scene1001 = '../outside.json'; }, m => { m.cursor = 'https://evil.test/cursor'; },
    m => { m.sourceRuntimeSHA256 = 'b'.repeat(64); }]) {
    const value = manifest(); change(value);
    assert.throws(() => validateDemoManifest(value, runtimeSHA256));
  }
});

test('archive demo manifests pin one unique ZIP per room, its length and SHA256', () => {
  const value = manifest();
  value.version = 2;
  value.packs = Object.fromEntries(['Scene1001', 'Scene1002'].map((room, index) => [room, { file: `room${index + 1}.zip`, bytes: 64, sha256: 'b'.repeat(64) }]));
  assert.equal(validateDemoManifest(value, runtimeSHA256).version, 2);
  for (const update of [m => { m.packs.Scene1001.bytes = 0; }, m => { m.packs.Scene1001.bytes = 129 * 1024 ** 2; },
    m => { m.packs.Scene1001.sha256 = 'bad'; }, m => { m.packs.Scene1001.file = '../room1.zip'; },
    m => { m.packs.Scene1001.file = 'room1.json'; }, m => { m.packs.Scene1002.file = 'room1.zip'; }]) {
    const invalid = structuredClone(value); update(invalid);
    assert.throws(() => validateDemoManifest(invalid, runtimeSHA256));
  }
});

test('full-game delivery extends the same ZIP room registry using unambiguous background keys', () => {
  const value = manifest();
  Object.assign(value, { version: 2, fullGame: true, packs: {}, rooms: {} });
  for (const [index, room] of ['Scene1001-base', 'Scene1402-state', 'Scene2810-statues'].entries()) {
    value.packs[room] = { file: `rooms/${room}.zip`, bytes: 64, sha256: 'b'.repeat(64) };
    value.rooms[room] = { backgroundKeys: [`640x480-640-${index.toString(16).padStart(8, '0')}-p12345678-opaque`] };
  }
  assert.equal(Object.keys(validateDemoManifest(value, runtimeSHA256).packs).length, 3);
  for (const change of [m => { delete m.rooms; }, m => { m.version = 1; },
    m => { m.rooms['Scene1402-state'].backgroundKeys = m.rooms['Scene1001-base'].backgroundKeys; },
    m => { m.rooms['Scene1402-state'].backgroundKeys = []; },
    m => { m.packs['../evil'] = m.packs['Scene1001-base']; },
    m => { m.rooms['Scene1402-state'].backgroundKeys = ['unknown']; }]) {
    const invalid = structuredClone(value); change(invalid);
    assert.throws(() => validateDemoManifest(invalid, runtimeSHA256));
  }
  delete value.fullGame;
  assert.throws(() => validateDemoManifest(value, runtimeSHA256), /Incomplete/);
});

test('demo URL policy allows HTTPS releases but never opens private loopback delivery cross-origin', () => {
  const location = new URL('http://127.0.0.1:4191/hd-demo/');
  assert.equal(demoAddress('/__private-demo/manifest.json', location).origin, location.origin);
  assert.equal(demoAddress('https://assets.example.test/releases/v1/manifest.json', location).protocol, 'https:');
  for (const url of ['http://127.0.0.1:4190/__private-demo/manifest.json', 'http://example.test/demo.json',
    'http://127.0.0.1:4191/__private-room-pack/room-pack.json', 'https://u:p@assets.example.test/manifest.json',
    'https://assets.example.test/manifest.json?token=x', 'https://assets.example.test/%2e%2e/manifest.json']) assert.throws(() => demoAddress(url, location));
  assert.equal(demoAssetURL('game/a.blb', 'https://assets.example.test/v1/manifest.json'), 'https://assets.example.test/v1/game/a.blb');
  for (const path of ['../game/a.blb', '/game/a.blb', 'game/%61.blb', 'game/a.blb?x', 'https://evil.test/a.blb']) assert.throws(() => demoAssetURL(path, 'https://assets.example.test/v1/manifest.json'));
});

test('demo download bounds responses and verifies SHA256 before mounting', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const bytes = new TextEncoder().encode('verified demo');
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.mode, 'cors');
    return new Response(bytes);
  };
  const result = await fetchDemoBytes('https://assets.example.test/a.blb', { expectedBytes: bytes.length, sha256: sha(bytes) });
  assert.deepEqual(result, bytes);
  await assert.rejects(fetchDemoBytes('https://assets.example.test/a.blb', { expectedBytes: 1 }), /size/);
  await assert.rejects(fetchDemoBytes('https://assets.example.test/a.blb', { sha256: '0'.repeat(64) }), /SHA256/);
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-length': '6', 'content-encoding': 'gzip' } });
  assert.deepEqual(await fetchDemoBytes('https://assets.example.test/a.blb', { expectedBytes: bytes.length, sha256: sha(bytes) }), bytes);
  globalThis.fetch = async () => new Response(new Uint8Array(17), { headers: { 'content-length': '8', 'content-encoding': 'gzip' } });
  await assert.rejects(fetchDemoBytes('https://assets.example.test/a.blb', { limit: 16 }), /size/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchDemoBytes('https://assets.example.test/a.blb', { signal: controller.signal }), /abort/i);
});

for (const stage of ['headers', 'body']) for (const cancellation of ['timeout', 'caller']) {
  test(`demo download cancels stalled ${stage} on ${cancellation}`, { timeout: 2000 }, async t => {
    const caller = new AbortController();
    let underlying;
    t.mock.method(globalThis, 'fetch', (url, { signal }) => {
      underlying = signal;
      if (cancellation === 'caller') setTimeout(() => caller.abort(), 5);
      if (stage === 'headers') return new Promise(() => {});
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1]));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } })));
    });
    await assert.rejects(fetchDemoBytes('https://assets.example.test/a.blb', {
      signal: caller.signal, timeoutMs: cancellation === 'timeout' ? 20 : 1000,
    }), { name: cancellation === 'timeout' ? 'TimeoutError' : 'AbortError' });
    assert.equal(underlying.aborted, true);
    assert.equal(caller.signal.aborted, cancellation === 'caller');
  });
}

function png(width, height) {
  const bytes = Buffer.alloc(33);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, width, height].forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
  return bytes;
}
function pack(room) {
  const image = png(2560, 1920);
  return { version: 1, private: true, scale: 4, runtimeSHA256, room, sourceBinding: 'synthetic-test', entries: [],
    backgrounds: [{ id: 'gemini', label: 'Gemini', key: '640x480-640-12345678-p12345678-opaque', file: 'gemini.png',
      sha256: sha(image), width: 2560, height: 1920, scale: 4 }] };
}

test('CDN pack delivery is explicit and does not weaken the original private loader', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let count = 0;
  globalThis.fetch = async (url, options) => {
    count++; assert.equal(options.mode, 'cors'); assert.equal(options.cache, 'default');
    return new Response(JSON.stringify(pack('Scene1001')));
  };
  const loaded = await loadDemoReplacementPackURL('https://assets.example.test/v1/room1/room-pack.json', { runtimeSHA256, room: 'Scene1001' });
  assert.equal(loaded.backgrounds.has('gemini'), true); loaded.dispose();
  await assert.rejects(loadReplacementPackURL('https://assets.example.test/v1/room1/room-pack.json', { runtimeSHA256 }), /loopback/);
  assert.equal(count, 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ ...pack('Scene1001'), backgrounds: [] }));
  await assert.rejects(loadDemoReplacementPackURL('https://assets.example.test/v1/room1/room-pack.json', { runtimeSHA256 }), /Gemini/);
});

test('private local demo serves only release-listed resources to same-origin loopback clients', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-delivery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web'), release = join(directory, 'release');
  await mkdir(webRoot); await mkdir(release);
  const put = async (file, bytes) => { await mkdir(join(release, file, '..'), { recursive: true }); await writeFile(join(release, file), bytes); };
  await put('manifest.json', JSON.stringify(manifest()));
  for (const name of REQUIRED_FILES) await put(`game/${name}`, Buffer.alloc(16));
  for (const [prefix, room] of [['room1', 'Scene1001'], ['room2', 'Scene1002']]) {
    await put(`${prefix}/room-pack.json`, JSON.stringify(pack(room))); await put(`${prefix}/gemini.png`, png(2560, 1920));
  }
  await put('cursor/cursor.json', '{}'); await put('cursor/sprite-sheet-128.png', png(384, 128)); await put('secret.txt', 'not public');
  const server = createStaticServer({ webRoot, privateDemoDir: release });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['manifest.json', 'game/a.blb', 'room1/room-pack.json', 'room2/gemini.png', 'cursor/sprite-sheet-128.png']) {
    const response = await fetch(`${origin}/__private-demo/${name}`);
    assert.equal(response.status, 200, name); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal((await fetch(`${origin}/__private-demo/secret.txt`)).status, 404);
  assert.equal((await fetch(`${origin}/__private-demo/manifest.json`, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(`${origin}/__private-demo/manifest.json`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${origin}/__private-demo/manifest.json?x`)).status, 403);
  assert.equal((await fetch(`${origin}/__private-demo/game%2fa.blb`)).status, 403);
  await rm(join(release, 'game/a.blb')); await symlink(join(release, 'secret.txt'), join(release, 'game/a.blb'));
  assert.notEqual((await fetch(`${origin}/__private-demo/game/a.blb`)).status, 200);
  const archived = manifest(); archived.version = 2;
  archived.packs = Object.fromEntries(['Scene1001', 'Scene1002'].map((room, index) => [room, { file: `room${index + 1}.zip`, bytes: 64, sha256: sha(Buffer.alloc(64)) }]));
  await put('room1.zip', Buffer.alloc(64)); await put('room2.zip', Buffer.alloc(64));
  await put('manifest.json', JSON.stringify(archived));
  assert.equal((await fetch(`${origin}/__private-demo/room1.zip`)).status, 200);
  assert.equal((await fetch(`${origin}/__private-demo/room2.zip`, { method: 'HEAD' })).headers.get('content-length'), '64');
  assert.equal((await fetch(`${origin}/__private-demo/room1/room-pack.json`)).status, 404);
  assert.equal((await fetch(`${origin}/__private-demo/room2/gemini.png`)).status, 404);
  await rm(join(release, 'room1.zip')); await symlink(join(release, 'secret.txt'), join(release, 'room1.zip'));
  assert.notEqual((await fetch(`${origin}/__private-demo/room1.zip`)).status, 200);
  const preview = createStaticServer({ webRoot, bundlesInPublic: false, privateDemoDir: release });
  preview.listen(0, '127.0.0.1'); await once(preview, 'listening');
  t.after(async () => { preview.closeAllConnections(); await new Promise(resolve => preview.close(resolve)); });
  assert.equal((await fetch(`http://127.0.0.1:${preview.address().port}/__private-demo/manifest.json`)).status, 404);
});

test('bounded demo keeps saves ephemeral while the unchanged full-game player persists progress', async () => {
  const source = await readFile(new URL('../web/player.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!demoRequested \|\| fullGameSession\)\s*\{\s*fs\.mount\(Module\.IDBFS/);
  assert.match(source, /if \(fullGameSession\)\s*\{\s*const stock = await discoverRuntime\(\)/);
  assert.match(source, /if \(demoManifest\)/);
  assert.match(source, /expectedBytes: entry\.bytes, sha256: entry\.sha256/);
});
