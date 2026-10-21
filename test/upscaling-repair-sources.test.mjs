import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bindPalette, nameHash, staticTables } from '../tools/upscaling/gemini/repair-sources.mjs';
import { png } from '../tools/assets/formats.mjs';
import { freezeJson, rgbIdentity } from '../tools/upscaling/gemini/bulk-sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const selectionPath = path.join(root, 'private-assets/upscaling/opaque-repair-source-selection.json');

test('engine name hashing ignores case/non-alphanumerics and wraps bit31 unsigned', () => {
  assert.equal(nameHash('A'), 2);
  assert.equal(nameHash('AA'), 6);
  assert.equal(nameHash('Z'), 0x4000000);
  assert.equal(nameHash('Z-E'), 0x84000000);
  assert.equal(nameHash('paPodShade'), nameHash('PA-pod_Shade'));
  assert.notEqual(nameHash('paPodShade'), nameHash('paPodBlack'));
});

test('palette binding copies exact engine ranges in order and never mutates originals', () => {
  const embedded = Buffer.alloc(1024, 7), a = Buffer.alloc(1024, 11), b = Buffer.alloc(1024, 19);
  a.fill(31, 5 * 4, 7 * 4);
  const bound = bindPalette(embedded, [['a', 65, 2, 5], ['b', 66, 1, 0]], k => ({ a, b })[k]);
  assert.deepEqual(bound.subarray(0, 65 * 4), embedded.subarray(0, 65 * 4));
  assert.deepEqual([...bound.subarray(65 * 4, 67 * 4)], [31,31,31,31,19,19,19,19]);
  assert(bound.subarray(67 * 4).every(v => v === 7));
  assert(embedded.every(v => v === 7)); assert(a.subarray(5 * 4, 7 * 4).every(v => v === 31));
  assert.throws(() => bindPalette(embedded, [['a', 255, 2, 0]], () => a));
  assert.throws(() => bindPalette(embedded, [['a', -1, 1, 0]], () => a));
  assert.throws(() => bindPalette(embedded, [['a', 0, 1, 256]], () => a));
  assert.throws(() => bindPalette(embedded, [['a', 0, 1, 0]], () => Buffer.alloc(768)));
});

function staticFixture() {
  const bytes = Buffer.alloc(8 + 4 * 4 + 4 + 22 + 4 + 40);
  bytes.writeUInt32LE(0x11223344, 0);
  const hallCountAt = 24, trackCountAt = 50;
  bytes.writeUInt32LE(1, hallCountAt); bytes.writeUInt32LE(1, trackCountAt);
  [0x004B7180, 11, 12, 13, 14].forEach((v, i) => bytes.writeUInt32LE(v, hallCountAt + 4 + 4 * i));
  [0x004B2240, 21, 22, 23, 24, 25, 26, 27, 28].forEach((v, i) => bytes.writeUInt32LE(v, trackCountAt + 4 + 4 * i));
  return bytes;
}

test('validated static tail maps named hall/track fields without neighboring-resource guesses', () => {
  const bytes = staticFixture(), result = staticTables(bytes);
  assert.equal(result.halls[0].bgFilename1, 11); assert.equal(result.halls[0].bgFilename2, 12);
  assert.equal(result.halls[0].bgFilename3, 14); assert.equal(result.halls[0].bytes, 22);
  assert.equal(result.tracks[0].bgFilename, 21);
  assert.equal(result.tracks[0].exPaletteFilename2, 26); assert.equal(result.tracks[0].exPaletteFilename1, 27);
  assert.equal(result.tracks[0].mouseCursorFilename, 28);
  assert.equal(result.tracks[0].sha256, sha(bytes.subarray(54, 94)));
  assert.throws(() => staticTables(bytes.subarray(0, -1)));
  assert.throws(() => staticTables(Buffer.concat([bytes, Buffer.from([0])])));
  bytes.writeUInt32LE(1, 4); assert.throws(() => staticTables(bytes));
});

test('shared RGB identity ignores unused palette bytes and includes used index0', () => {
  const a = Buffer.alloc(1024), b = Buffer.alloc(1024);
  b[255 * 4] = 200;
  assert.equal(rgbIdentity(Buffer.from([1,1]), a, 2, 1), rgbIdentity(Buffer.from([1,1]), b, 2, 1));
  b[0] = 100;
  assert.notEqual(rgbIdentity(Buffer.from([0,1]), a, 2, 1), rgbIdentity(Buffer.from([0,1]), b, 2, 1));
  assert.equal(rgbIdentity(Buffer.from([1,1]), a, 2, 1), sha(Buffer.alloc(6)));
});

test('private frozen selection independently reproduces every PNG and all RGB pixels', { skip: !fs.existsSync(selectionPath) }, () => {
  const selection = JSON.parse(fs.readFileSync(selectionPath));
  const prior = JSON.parse(fs.readFileSync(path.join(root, selection.priorRegistry.path)));
  assert.equal(sha(fs.readFileSync(path.join(root, selection.priorRegistry.path))), selection.priorRegistry.sha256);
  assert.equal(selection.schemaVersion, 1); assert.equal(selection.rooms.length, 70);
  assert.equal(selection.generationCalls, 0); assert.equal(selection.networkCalls, 0);
  const priorRgb = new Set(prior.rooms.map(r => r.rgbPixelSha256)), priorSha = new Set(prior.rooms.map(r => r.source.sha256));
  const readProof = record => {
    const bytes = fs.readFileSync(path.join(root, record.path));
    assert.equal(sha(bytes), record.sha256); if (record.bytes !== undefined) assert.equal(bytes.length, record.bytes);
    return bytes;
  };
  const rgb = new Set(), ids = new Set();
  for (const room of selection.rooms) {
    assert(!ids.has(room.id)); ids.add(room.id);
    assert(!priorRgb.has(room.rgbPixelSha256)); assert(!priorSha.has(room.source.sha256));
    assert(!rgb.has(room.rgbPixelSha256)); rgb.add(room.rgbPixelSha256);
    assert.equal(room.sourcePath, room.source.path); assert.deepEqual(room.source.dimensions, [640, 480]);
    assert.equal(room.source.role, 'source-composition'); assert(!room.id.startsWith('HallOfRecordsScene'));
    assert(!room.id.startsWith('Scene1201')); assert(!room.id.startsWith('Scene2101')); assert(!room.id.startsWith('Scene2201'));
    const provenance = room.provenance, embedded = readProof(provenance.palette);
    const alias = room.bindingAliases[0], paletteByHash = new Map();
    for (const proof of alias.paletteProofs) paletteByHash.set(Number(proof.requestedHash), readProof(proof.palette));
    const palette = bindPalette(embedded, alias.operations, hash => paletteByHash.get(typeof hash === 'number' ? hash : nameHash(hash)));
    assert.equal(sha(palette), provenance.palette.finalSha256);
    const pixels = readProof(provenance.indexedPixels);
    assert.equal(sha(pixels), provenance.decoding.originalIndexSha256);
    assert.equal(rgbIdentity(pixels, palette, 640, 480), room.rgbPixelSha256);
    assert.deepEqual(png(pixels, 640, 480, palette), readProof(room.source));
    assert.equal(provenance.decoding.cropped, false); assert.equal(provenance.decoding.resampled, false);
    assert(provenance.aliasTableEntries.length > 0);
    for (const chain of provenance.aliasTableEntries) for (const item of chain) assert.match(item.archive.sha256, /^[a-f0-9]{64}$/);
  }
  // A different PNG reader confirms palette application, full RGB identity and opacity.
  const program = `import json,sys,hashlib
from PIL import Image
for r in json.load(sys.stdin):
 im=Image.open(r['sourcePath']);assert im.size==(640,480);assert 'transparency' not in im.info
 assert hashlib.sha256(im.convert('RGB').tobytes()).hexdigest()==r['rgbPixelSha256']
print('all original source pixels verified')`;
  assert.match(execFileSync('python3', ['-c', program], { cwd: root, input: JSON.stringify(selection.rooms), encoding: 'utf8' }), /all original/);
  assert.equal(selection.priorExcludedDispositions.length, prior.dispositions.filter(d => d.disposition !== 'included').length);
  assert(!selection.dispositions.some(d => d.disposition === 'missing-proof'));
  const native = selection.dispositions.find(d => d.disposition === 'excluded-native-dimensions');
  assert.deepEqual(native.dimensions, [640, 500]);
  assert(selection.dispositions.some(d => d.disposition === 'excluded-records-textwall-scope'));
  assert(selection.prior1201PaletteAudit.every(r => r.correctOriginalPalette));
  for (const state of [selection.pairedExperiment.stateA, selection.pairedExperiment.stateB]) assert(ids.has(state.roomId));
  assert.equal(selection.hallClassification.statueHall.resourceId, '0x26508804');
  assert.equal(selection.hallClassification.statueHall.disposition, 'duplicate-prior42');
  const before = fs.statSync(selectionPath).mtimeMs, originalBytes = fs.readFileSync(selectionPath);
  freezeJson(selectionPath, selection);
  assert.equal(fs.statSync(selectionPath).mtimeMs, before); assert.deepEqual(fs.readFileSync(selectionPath), originalBytes);
  assert.throws(() => freezeJson(selectionPath, { ...selection, schemaVersion: 999 }), /refusing overwrite/);
});
