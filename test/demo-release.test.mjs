import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDemoRelease } from '../scripts/prepare-demo-release.mjs';
import { validateRoomArchive } from '../web/prototype/room-archive.js';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { zipSync } from '../web/vendor/fflate-0.8.2.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeSHA256 = 'a'.repeat(64);
function webp() {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF'); bytes.writeUInt32LE(22, 4); bytes.write('WEBPVP8X', 8); bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(2559, 24, 3); bytes.writeUIntLE(1919, 27, 3);
  return bytes;
}

test('release emits deterministic single-room ZIPs, no loose HD images, and a pinned v2 delivery manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'demo-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, bytes) => { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), bytes); };
  const gameFiles = REQUIRED_FILES.map(name => ({ name, file: name, bytes: 16, sha256: hash(Buffer.alloc(16)) }));
  for (const file of gameFiles) await put(`source-game/${file.name}`, Buffer.alloc(16));
  await put('source-game/manifest.json', JSON.stringify({ files: gameFiles, mode: 'synthetic' }));
  await put('runtime.json', JSON.stringify({ demo: true, wasmSHA256: 'b'.repeat(64), sourceRuntimeSHA256: runtimeSHA256 }));
  const image = webp();
  for (const [prefix, room] of [['source-room1', 'Scene1001'], ['source-room2', 'Scene1002']]) {
    const images = ['gemini', 'realesrnet'].map((name, index) => ({ id: String(index + 1).repeat(64), file: `images/${name}.webp`, format: 'webp', width: 2560, height: 1920, sha256: hash(image) }));
    const pack = { version: 2, private: true, scale: 4, room, runtimeSHA256, sourceBinding: 'synthetic', images, entries: [],
      backgrounds: images.map((entry, index) => ({ id: index ? 'realesrnet' : 'gemini', label: index ? 'RealESRNet' : 'Gemini',
        key: '640x480-640-12345678-p12345678-0', image: entry.id, width: 2560, height: 1920, scale: 4,
        crop: { x: 0, y: 0, width: 2560, height: 1920 }, flipX: false })) };
    await put(`${prefix}/room-pack.json`, JSON.stringify(pack));
    for (const entry of images) await put(`${prefix}/${entry.file}`, image);
  }
  await put('source-cursor/cursor.json', JSON.stringify({ imageSHA256: hash(image) }));
  await put('source-cursor/sprite-sheet-128.png', image);
  const options = { gameManifest: join(root, 'source-game/manifest.json'), room1: join(root, 'source-room1'),
    room2: join(root, 'source-room2'), cursor: join(root, 'source-cursor'), runtime: join(root, 'runtime.json') };
  const manifest = await prepareDemoRelease({ ...options, output: join(root, 'release1') });
  const duplicate = await prepareDemoRelease({ ...options, output: join(root, 'release2') });
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest, duplicate);
  assert.deepEqual((await readdir(join(root, 'release1'))).sort(), ['.private-assets-no-public', 'cursor', 'game', 'manifest.json', 'room1.zip', 'room2.zip']);
  for (const [room, entry] of Object.entries(manifest.packs)) {
    const bytes = await readFile(join(root, 'release1', entry.file));
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    assert.deepEqual(bytes, await readFile(join(root, 'release2', entry.file)));
    const pack = await validateRoomArchive(bytes, { runtimeSHA256, room });
    assert.equal(pack.backgrounds.size, 1); assert.ok(pack.backgrounds.has('gemini')); assert.equal(pack.files.size, 1);
  }
  await assert.rejects(prepareDemoRelease({ ...options, output: join(root, 'release1') }), /already exists/);
});

test('full-game release reuses pinned room ZIPs and copies original videos without changing the runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'full-demo-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, bytes) => { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), bytes); };
  const wasm = Buffer.from('unchanged-runtime'), runtimeHash = hash(wasm), native = Buffer.alloc(32, 123);
  await put('runtime/scummvm.wasm', wasm);
  await put('runtime/runtime.json', JSON.stringify({ wasm: 'scummvm.wasm' }));
  const files = REQUIRED_FILES.map(name => ({ relativePath: `DATA/${name}`, localPath: join(root, 'DATA', name), bytes: native.length, sha256: hash(native) }));
  for (const name of REQUIRED_FILES) await put(`DATA/${name}`, native);
  await put('originals.json', JSON.stringify({ files }));
  const png = Buffer.alloc(33);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 2560, 1920].forEach((value, index) => png.writeUInt32BE(value, index * 4));
  const rooms = [];
  for (const [i, id] of ['Scene1001-native', 'Scene2810-statues'].entries()) {
    const key = `640x480-640-${String(i).padStart(8, '0')}-p12345678-opaque`;
    const pack = { version: 2, lossless: true, private: true, room: id, scale: 4, runtimeSHA256: runtimeHash,
      sourceBinding: 'synthetic original', entries: [],
      images: [{ id: hash(png), file: 'background.png', format: 'png', sha256: hash(png), width: 2560, height: 1920 }],
      backgrounds: [{ id: 'gemini', label: 'Approved', key, image: hash(png), width: 2560, height: 1920, scale: 4,
        crop: { x: 0, y: 0, width: 2560, height: 1920 }, flipX: false }] };
    const zip = zipSync({ 'room-pack.json': new TextEncoder().encode(JSON.stringify(pack)), 'background.png': png }, { level: 0 });
    const file = `${id}.zip`; await put(`packs/${file}`, zip);
    rooms.push({ id, file, bytes: zip.length, sha256: hash(zip), backgroundKeys: [key] });
  }
  await put('packs/index.json', JSON.stringify({ rooms }));
  await put('cursor/cursor.json', JSON.stringify({ imageSHA256: hash(png) }));
  await put('cursor/sprite-sheet-128.png', png);
  const manifest = await prepareDemoRelease({ gameManifest: join(root, 'originals.json'), roomIndex: join(root, 'packs/index.json'),
    cursor: join(root, 'cursor'), runtime: join(root, 'runtime/runtime.json'), output: join(root, 'release') });
  assert.equal(manifest.fullGame, true);
  assert.equal(manifest.runtimeSHA256, runtimeHash);
  assert.equal(Object.keys(manifest.packs).length, 2);
  assert.equal(hash(await readFile(join(root, 'runtime/scummvm.wasm'))), runtimeHash);
  for (const file of manifest.files) assert.deepEqual(await readFile(join(root, 'release', file.file)), native);
  for (const room of rooms) assert.deepEqual(await readFile(join(root, 'release', manifest.packs[room.id].file)), await readFile(join(root, 'packs', room.file)));
});
