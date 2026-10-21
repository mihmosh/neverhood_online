import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { bitmap, crc32, png, raster } from '../tools/assets/formats.mjs';
import { unzipSync } from '../web/vendor/fflate-0.8.2.js';
import { validateRoomArchive, ROOM_ARCHIVE_LIMITS } from '../web/prototype/room-archive.js';
import { decodeProofPNG, paletteCompatible, packHDAssetMap, prepareHDRoomPacks, prepareRoomArchive, sourceKey, SOURCE_RUNTIME_SHA256 } from '../scripts/prepare-hd-room-packs.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = n => n.toString(16).padStart(8, '0');
const json = value => JSON.stringify(value) + '\n';
function chunk(type, body) {
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length); result.write(type, 4); body.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function rgbaPNG(width, height, pixel) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(raw, y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, { height = 2, width = 4, room = 'SceneFixture-state_1', mismatchedPalette = false, unknownCapacity = false, badAlpha = false, override = false } = {}) {
  const root = await mkdtemp('/tmp/kilo/hd-room-packs-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateDir = resolve(root, 'private-assets'); await mkdir(privateDir);
  const release = resolve(privateDir, 'upscaling/full-game-release'); await mkdir(release, { recursive: true });
  const normalizedDir = resolve(release, 'runtime-normalized-v1'); await mkdir(normalizedDir);
  const db = new DatabaseSync(resolve(privateDir, 'catalog.sqlite'));
  db.exec(`CREATE TABLE catalogmeta(key TEXT,value TEXT);
    CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,size INTEGER,path TEXT);
    CREATE TABLE resources(id TEXT PRIMARY KEY,payload_blob TEXT);
    CREATE TABLE palettes(id TEXT PRIMARY KEY,resource_id TEXT,blob TEXT,association TEXT);
    CREATE TABLE decodedframes(id TEXT PRIMARY KEY,resource_id TEXT,indexed_blob TEXT,width INTEGER,height INTEGER,palette_id TEXT);
    CREATE TABLE raster_variants(id TEXT PRIMARY KEY,frame_id TEXT,logical_frame_id TEXT,width INTEGER,height INTEGER,pitch INTEGER,flip_x INTEGER,flip_y INTEGER,pixel_crc32 TEXT,pixel_sha256 TEXT,recipe_json TEXT);
    CREATE TABLE frame_associations(logical_frame_id TEXT,provenance TEXT);`);
  db.prepare('INSERT INTO catalogmeta VALUES(?,?)').run('source-binding', 'fixture-catalog');
  const store = async (bytes, suffix = 'bin') => {
    const hash = sha(bytes), file = `${hash}.${suffix}`;
    await writeFile(resolve(privateDir, file), bytes);
    db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?,?)').run(hash, bytes.length, file);
    return { path: resolve(privateDir, file), sha256: hash, bytes: bytes.length };
  };
  const palette = Buffer.alloc(1024); palette.set([12, 34, 56, 0], 4); palette.set([99, 88, 77, 0], 8);
  const pal = await store(palette, 'pal');
  db.prepare('INSERT INTO palettes VALUES(?,?,?,?)').run('background-pal', 'background', pal.sha256, 'embedded');
  const indexed = Buffer.alloc(width * height, 2), index = await store(indexed, 'idx');
  db.prepare('INSERT INTO decodedframes VALUES(?,?,?,?,?,?)').run('background-frame', 'background', index.sha256, width, height, 'background-pal');
  const payload = Buffer.alloc(1030 + ((width + 3) & ~3) * height);
  payload.writeUInt16LE(26); payload.writeUInt16LE(width, 2); payload.writeUInt16LE(height, 4); palette.copy(payload, 6);
  for (let y = 0; y < height; y++) indexed.copy(payload, 1030 + y * ((width + 3) & ~3), y * width, (y + 1) * width);
  assert(bitmap(payload).pixels.equals(indexed));
  db.prepare('INSERT INTO resources VALUES(?,?)').run('background', (await store(payload)).sha256);
  const boundPalette = Buffer.from(palette);
  const binding = { catalogResourceId: 'background', catalogSourceBinding: 'fixture-catalog', decodedFrameId: 'background-frame', indexedPixels: index,
    palette: { ...pal, resourceId: 'background' } };
  if (override) {
    const other = Buffer.from(palette); other.set([101, 102, 103, 0], 8);
    const p = await store(other, 'pal');
    db.prepare('INSERT INTO palettes VALUES(?,?,?,?)').run('override-pal', 'override-resource', p.sha256, 'standalone');
    binding.paletteProofs = [{ catalogSourceBinding: 'fixture-catalog', to: 2, from: 2, count: 1, palette: { ...p, resourceId: 'override-resource' } }];
    other.copy(boundPalette, 8, 8, 12); binding.boundPaletteSha256 = sha(boundPalette);
  }
  const source = await store(png(indexed, width, height, boundPalette), 'png');
  const originalOutput = await store(rgbaPNG(8, 8, () => [10, 20, 30, 255]), 'png');
  const identity = { id: 'exact-approved-choice', aliases: [room], sourceBinding: binding };
  const approved = { sourceSha256: source.sha256, artifactId: `${source.sha256}:${originalOutput.sha256}`, source: { ...source, dimensions: [width, height] }, output: originalOutput,
    aliases: [room], identities: [identity], approvalEvidence: [{ kind: 'synthetic-human-approval' }],
    candidateIdentities: [{ sourceSha256: source.sha256, outputSha256: originalOutput.sha256 }] };
  const selection = { private: true, purpose: 'offline-human-approved-release-selection', valid: false, selected: [approved], unapproved: [{ sourceSha256: 'unapproved' }], conflicts: [{ sourceSha256: 'conflict' }] };
  const selectionPath = resolve(release, 'background-selection.json'); await writeFile(selectionPath, json(selection));
  const nativeOutput = rgbaPNG(width * 4, height * 4, () => [120, 130, 140, 255]);
  const runtime = { path: `${source.sha256}.png`, sha256: sha(nativeOutput), dimensions: [width * 4, height * 4] };
  await writeFile(resolve(normalizedDir, runtime.path), nativeOutput);
  const normalized = { private: true, purpose: 'offline-runtime-normalization', executed: true, selection: { sha256: sha(Buffer.from(json(selection))) }, artifacts: [{ ...approved, runtime }] };
  await writeFile(resolve(normalizedDir, 'runtime-manifest.json'), json(normalized));
  await writeFile(resolve(privateDir, 'manifest.json'), json({ sourceBinding: 'fixture-catalog' }));
  const animationPalette = Buffer.from(palette); if (mismatchedPalette) animationPalette[4]++;
  const animationPal = await store(animationPalette, 'pal');
  db.prepare('INSERT INTO palettes VALUES(?,?,?,?)').run('animation-pal', 'animation', animationPal.sha256, 'embedded');
  const pixels = Buffer.from([0, 1]), idx = await store(pixels, 'idx');
  db.prepare('INSERT INTO decodedframes VALUES(?,?,?,?,?,?)').run('animation-frame', 'animation', idx.sha256, 2, 1, 'animation-pal');
  if (!unknownCapacity) for (const flip of [false, true]) {
    const result = raster(pixels, 2, 1, 4, 2, flip, false);
    db.prepare('INSERT INTO raster_variants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(`variant-${flip}`, 'animation-frame', 'logical', result.width, result.height, result.pitch, Number(flip), 0,
      hex(crc32(result.pixels)), sha(result.pixels), json({ capacityWidth: 4, capacityHeight: 2 }));
  }
  db.prepare('INSERT INTO frame_associations VALUES(?,?)').run('logical', 'explicit synthetic room association');
  db.close();
  const output = await storeWithoutDB(privateDir, rgbaPNG(8, 4, x => [100, 90, 80, x < 4 && !badAlpha ? 0 : 255]));
  const imageId = 'existing-animation-output';
  const animation = { provenance: { model: { alpha: 'source-index0-binary-nearest4x' } }, validation: { valid: true },
    images: [{ id: imageId, ...output, width: 8, height: 4 }], resources: [{ runtimeMappings: [{ requestedHash: 123, frameIndex: 0, imageId, sourceFrameId: 'animation-frame' }], frames: [{ imageId, sourceFrameId: 'animation-frame', requestedHash: 123, width: 2, height: 1,
      source: { indexedRaster: idx, palette: animationPal } }] }] };
  await writeFile(resolve(release, 'animation-catalog.json'), json(animation));
  return { root, privateDir, release, selectionPath, selection, normalized, normalizedDir, animation, nativeOutput, output: output.data, room };
}
async function storeWithoutDB(directory, bytes) {
  const path = resolve(directory, `${sha(bytes)}.png`); await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: bytes.length, data: bytes };
}

test('raw keys include exact original pitch, pixel CRC, palette CRC and alpha', () => {
  const palette = Buffer.alloc(1024), original = raster(Buffer.from([1, 2, 3]), 3, 1, 5, 2);
  assert.equal(sourceKey(original, palette, 0), `8x2-8-${hex(crc32(original.pixels))}-p${hex(crc32(palette))}-0`);
  assert(sourceKey(original, palette, 'opaque').endsWith('-opaque'));
  assert.throws(() => sourceKey(original, palette, 1));
});

test('palette proof ignores transparent index0 and unused colors but rejects used RGB mismatch', () => {
  const a = Buffer.alloc(1024), b = Buffer.from(a); b[0] = 10; b[800] = 20;
  assert(paletteCompatible(Buffer.from([0, 1]), a, b));
  b[4] = 1; assert(!paletteCompatible(Buffer.from([0, 1]), a, b));
});

test('PNG proof decodes original indexed RGB and rejects corruption/animated chunks', () => {
  const palette = Buffer.alloc(1024); palette.set([1, 2, 3, 0], 4);
  const bytes = png(Buffer.from([1]), 1, 1, palette);
  assert.deepEqual([...decodeProofPNG(bytes).rgb], [1, 2, 3]);
  const bad = Buffer.from(bytes); bad[bad.length - 1] ^= 1;
  assert.throws(() => decodeProofPNG(bad), /CRC/);
  const animated = Buffer.concat([bytes.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), bytes.subarray(33)]);
  assert.throws(() => decodeProofPNG(animated), /Animated/);
});

test('dry-run validates real v2 STORE members without filesystem output; write preserves PNG bytes', async t => {
  const f = await fixture(t), before = await readdir(f.release);
  const report = await prepareHDRoomPacks({ root: f.root });
  assert.deepEqual(await readdir(f.release), before);
  assert.equal(report.rooms.length, 1); assert.equal(report.rooms[0].coverage.includedBindings, 2);
  assert.equal(report.unapprovedSources, 1); assert.equal(report.conflictedSources, 1);
  assert.equal(report.animation.complete, false);
  const output = resolve(f.release, 'packs-v1');
  const written = await prepareHDRoomPacks({ root: f.root, write: true, output });
  const index = JSON.parse(await readFile(resolve(output, 'rooms/index.json')));
  assert.deepEqual(index.rooms, written.rooms);
  const descriptor = index.rooms[0], bytes = await readFile(resolve(output, 'rooms', descriptor.file));
  assert.equal(sha(bytes), descriptor.sha256); assert.equal(bytes.length, descriptor.bytes);
  assert.equal(descriptor.sha256, report.rooms[0].sha256);
  const validated = await validateRoomArchive(bytes, { room: f.room, runtimeSHA256: SOURCE_RUNTIME_SHA256 });
  assert.equal(validated.manifest.version, 2); assert.equal(validated.manifest.lossless, true);
  assert.equal(validated.manifest.sourceRuntimeSHA256, SOURCE_RUNTIME_SHA256);
  const members = unzipSync(bytes);
  assert(Buffer.from(members[`images/${sha(f.nativeOutput)}.png`]).equals(f.nativeOutput));
  assert(Buffer.from(members[`images/${sha(f.output)}.png`]).equals(f.output));
  assert.equal(validated.entries.size, 3); // Native background layer plus two original flip contexts.
  await assert.rejects(prepareHDRoomPacks({ root: f.root, write: true, output }), /already exists/);
});

test('native640x500 stays full size in layer, still emits opaque room trigger', async t => {
  const f = await fixture(t, { width: 640, height: 500, room: 'Scene1402-231482F0-native' });
  const output = resolve(f.release, 'full-native');
  const report = await prepareHDRoomPacks({ root: f.root, write: true, output });
  const members = unzipSync(await readFile(resolve(output, 'rooms', report.rooms[0].file)));
  const pack = JSON.parse(Buffer.from(members['room-pack.json']));
  assert.equal(pack.backgrounds.length, 0);
  const layer = pack.entries.find(e => e.kind === 'layer');
  assert.equal(layer.width, 2560); assert.equal(layer.height, 2000);
  assert.equal(layer.key, report.rooms[0].backgroundKeys[0]);
});

test('one original-to-HD table is the sole input to repeatable room archive assembly', async t => {
  const f = await fixture(t), mappingOutput = resolve(f.release, 'mapping');
  await prepareHDRoomPacks({ root: f.root, write: true, mapOnly: true, output: mappingOutput });
  const mapping = resolve(mappingOutput, 'asset-map.json'), mapBytes = await readFile(mapping), table = JSON.parse(mapBytes);
  assert.equal(table.originals.length, 2);
  assert.equal(table.originals.find(row => row.kind === 'animation').image, sha(f.output));
  assert.equal(table.originals.find(row => row.kind === 'background').image, sha(f.nativeOutput));
  assert.equal((await readdir(resolve(mappingOutput, 'rooms'))).filter(name => name.endsWith('.zip')).length, 0);
  await writeFile(f.selectionPath, '{}'); // Packaging never regenerates or guesses source bindings.
  const output = resolve(f.release, 'from-table');
  const report = await packHDAssetMap({ root: f.root, mapping, write: true, output });
  assert.equal(report.assetMapSHA256, sha(mapBytes));
  const archive = await readFile(resolve(output, 'rooms', report.rooms[0].file));
  const manifest = JSON.parse(Buffer.from(unzipSync(archive)['room-pack.json']));
  assert.deepEqual(manifest, table.rooms[0].manifest);
  const again = await packHDAssetMap({ root: f.root, mapping });
  assert.equal(again.rooms[0].sha256, report.rooms[0].sha256);
  await writeFile(resolve(f.root, table.images[sha(f.output)].sourceFile), 'changed');
  await assert.rejects(packHDAssetMap({ root: f.root, mapping }), /SHA256|Byte mismatch/);
});

test('standard640x480 uses existing gemini background schema', async t => {
  const f = await fixture(t, { width: 640, height: 480 });
  const output = resolve(f.release, 'standard');
  await prepareHDRoomPacks({ root: f.root, write: true, output });
  const members = unzipSync(await readFile(resolve(output, 'rooms', `${f.room}.zip`)));
  const pack = JSON.parse(Buffer.from(members['room-pack.json']));
  assert.equal(pack.backgrounds[0].id, 'gemini'); assert.equal(pack.backgrounds[0].height, 1920);
});

test('unknown capacity is excluded explicitly; no frame-size capacity invention', async t => {
  const f = await fixture(t, { unknownCapacity: true });
  const report = await prepareHDRoomPacks({ root: f.root });
  assert.equal(report.rooms[0].coverage.includedBindings, 0);
  assert.equal(report.rooms[0].coverage.missingFrames, 1);
  assert.equal(report.exclusions[0].reason, 'unknown-original-capacity');
});

test('incompatible embedded animation palette remains native without recoloring', async t => {
  const f = await fixture(t, { mismatchedPalette: true });
  const report = await prepareHDRoomPacks({ root: f.root });
  assert.equal(report.rooms[0].coverage.paletteExcludedFrames, 1);
  assert.equal(report.rooms[0].coverage.includedBindings, 0);
});

test('all embedded palette contexts of a shared animation image must be compatible', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(resolve(f.privateDir, 'catalog.sqlite'));
  const palette = Buffer.alloc(1024); palette.set([200, 201, 202, 0], 4);
  const palettePath = `${sha(palette)}.pal`; await writeFile(resolve(f.privateDir, palettePath), palette);
  db.prepare('INSERT INTO blobs VALUES(?,?,?)').run(sha(palette), palette.length, palettePath);
  db.prepare('INSERT INTO palettes VALUES(?,?,?,?)').run('second-pal', 'second-resource', sha(palette), 'embedded');
  const first = f.animation.resources[0].frames[0];
  db.prepare('INSERT INTO decodedframes VALUES(?,?,?,?,?,?)').run('second-frame', 'second-resource', first.source.indexedRaster.sha256, 2, 1, 'second-pal');
  db.close();
  f.animation.resources[0].frames.push({ ...first, sourceFrameId: 'second-frame', source: { ...first.source, palette: { sha256: sha(palette) } } });
  await writeFile(resolve(f.release, 'animation-catalog.json'), json(f.animation));
  const report = await prepareHDRoomPacks({ root: f.root });
  assert.equal(report.rooms[0].coverage.includedBindings, 0);
  assert.equal(report.rooms[0].coverage.paletteExcludedFrames, 2);
});

test('only exact index0 binary nearest4x output alpha is accepted', async t => {
  const f = await fixture(t, { badAlpha: true });
  await assert.rejects(prepareHDRoomPacks({ root: f.root }), /alpha is not original index0/);
});

test('original palette overrides bind raw CRC and selected source RGB exactly', async t => {
  const f = await fixture(t, { override: true });
  const report = await prepareHDRoomPacks({ root: f.root });
  assert.equal(report.rooms[0].coverage.includedBindings, 2);
  const binding = f.selection.selected[0].identities[0].sourceBinding;
  binding.boundPaletteSha256 = '0'.repeat(64);
  await writeFile(f.selectionPath, json(f.selection));
  f.normalized.selection.sha256 = sha(Buffer.from(json(f.selection)));
  f.normalized.artifacts[0].identities = f.selection.selected[0].identities;
  await writeFile(resolve(f.normalizedDir, 'runtime-manifest.json'), json(f.normalized));
  await assert.rejects(prepareHDRoomPacks({ root: f.root }), /Bound palette mismatch/);
});

test('quarantined decisions and changed normalization are never autoapproved', async t => {
  const f = await fixture(t);
  f.selection.conflicts.push({ sourceSha256: f.selection.selected[0].sourceSha256 });
  await writeFile(f.selectionPath, json(f.selection));
  await assert.rejects(prepareHDRoomPacks({ root: f.root }), /selection changed/);
  f.normalized.selection.sha256 = sha(Buffer.from(json(f.selection)));
  await writeFile(resolve(f.normalizedDir, 'runtime-manifest.json'), json(f.normalized));
  await assert.rejects(prepareHDRoomPacks({ root: f.root }), /quarantined/);
});

test('source binding RGB and normalized byte tampering fail closed', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.normalizedDir, f.normalized.artifacts[0].runtime.path), Buffer.from('not-the-approved-bytes'));
  await assert.rejects(prepareHDRoomPacks({ root: f.root }), /SHA256 mismatch/);
});

test('output must be explicit, new and inside private with canonical parent', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareHDRoomPacks({ root: f.root, write: true }), /absolute new private/);
  await assert.rejects(prepareHDRoomPacks({ root: f.root, write: true, output: resolve(f.root, 'web') }), /private output/);
  const alias = resolve(f.privateDir, 'alias'); await symlink(f.release, alias);
  await assert.rejects(prepareHDRoomPacks({ root: f.root, write: true, output: resolve(alias, 'new') }), /Unsafe output parent/);
});

test('room archive rejects its lossless byte limit before ZIP allocation', async () => {
  const bytes = { length: ROOM_ARCHIVE_LIMITS.bytes };
  await assert.rejects(prepareRoomArchive({ room: 'SceneTest' }, { 'images/a.png': bytes }), /archive byte limit/);
});
