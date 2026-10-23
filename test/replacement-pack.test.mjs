import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadReplacementPack, loadReplacementPackURL, PACK_LIMITS, validateReplacementManifest, validateImageHeader, paletteProofMatches } from '../web/prototype/replacement-pack.js';

const runtimeSHA256 = 'a'.repeat(64);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const key = (id, width = 1, height = 1) => `${width}x${height}-${width}-${id.toString(16).padStart(8, '0')}-p12345678-0`;
function png(width, height) {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, width, height].forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}
function file(name, bytes, path = `pack/${name}`) {
  const blob = new Blob([bytes]);
  Object.defineProperties(blob, { name: { value: name }, webkitRelativePath: { value: path } });
  return blob;
}
function fixture(count = 3, backgrounds = false) {
  const manifest = { version: 1, private: true, scale: 4, runtimeSHA256,
    sourceBinding: { catalog: 'synthetic', sha256: 'b'.repeat(64) }, room: 'Scene1001', entries: [], backgrounds: [] };
  const images = [];
  for (let index = 1; index <= count; index++) {
    const bytes = png(4, 4);
    const entry = { key: key(index), file: `sprites/${index}.png`, sha256: digest(bytes), width: 4, height: 4,
      scale: 4, kind: 'sprite', resource: 'test-resource', frameId: index, sourceSHA256: 'c'.repeat(64) };
    manifest.entries.push(entry); images.push(file(entry.file, bytes));
  }
  if (backgrounds) for (const id of ['gemini', 'realesrnet']) {
    const bytes = png(2560, 1920);
    const entry = { id, label: id, key: key(9, 640, 480), file: `${id}.png`, sha256: digest(bytes),
      width: 2560, height: 1920, scale: 4 };
    manifest.backgrounds.push(entry); images.push(file(entry.file, bytes));
  }
  return { manifest, images, files: () => [file('room-pack.json', JSON.stringify(manifest)), ...images] };
}

function sharedFixture() {
  const value = fixture(2), bytes = new Uint8Array(30), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0); view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8); view.setUint32(16, 10, true);
  bytes[20] = 0x10; bytes[24] = 1; bytes[27] = 1;
  const image = { id: 'd'.repeat(64), file: 'images/shared.webp', format: 'webp', width: 2, height: 2, sha256: digest(bytes) };
  value.manifest.version = 2; value.manifest.images = [image];
  value.manifest.entries = value.manifest.entries.map((old, index) => {
    const { file, sha256, ...entry } = old;
    return { ...entry, image: image.id, crop: { x: index, y: 1, width: 2, height: 2 }, flipX: !!index };
  });
  value.images = [file(image.file, bytes)];
  value.files = () => [file('room-pack.json', JSON.stringify(value.manifest)), ...value.images];
  return value;
}

const proofId = 'e'.repeat(64);
function proofFixture(count = 1, backgrounds = false) {
  const value = fixture(count, backgrounds), manifest = value.manifest;
  manifest.version = 2; manifest.lossless = true; manifest.images = [];
  manifest.paletteProofs = { [proofId]: { indices: [1, 255], rgb: '123456abcdef' } };
  for (const entry of [...manifest.entries, ...manifest.backgrounds]) {
    const { file, sha256 } = entry;
    const id = digest(file);
    manifest.images.push({ id, file, sha256, format: 'png', width: entry.width, height: entry.height });
    delete entry.file; delete entry.sha256;
    Object.assign(entry, { image: id, crop: { x: 0, y: 0, width: entry.width, height: entry.height }, flipX: false, paletteProof: proofId });
  }
  const palette = new Uint8Array(1024);
  palette.set([0x12, 0x34, 0x56, 0xff], 4); palette.set([0xab, 0xcd, 0xef, 0xff], 255 * 4);
  return { ...value, palette };
}

test('palette proofs compare only declared RGB, including index zero when declared', () => {
  const { palette, manifest } = proofFixture(), proof = manifest.paletteProofs[proofId];
  assert.equal(paletteProofMatches(proof, palette), true);
  palette[0] = 42; palette[7] = 0; palette[1023] = 17;
  assert.equal(paletteProofMatches(proof, palette), true, 'unused RGB and used fourth bytes do not affect native RGB');
  assert.equal(paletteProofMatches({ indices: [0], rgb: '2a0000' }, palette), true);
  assert.equal(paletteProofMatches({ indices: [0], rgb: '000000' }, palette), false);
  palette[4]--;
  assert.equal(paletteProofMatches(proof, palette), false);
  for (const invalid of [null, [], new Uint8Array(1023), new Uint16Array(1024)]) {
    assert.equal(paletteProofMatches(proof, invalid), false);
  }
  assert.equal(paletteProofMatches(null, palette), false);
});

test('lossless proofs validate table shape, ordered indices, exact lowercase RGB and references', async () => {
  const changes = [
    m => { m.paletteProofs = null; }, m => { m.paletteProofs = []; }, m => { m.paletteProofs = 'proof'; },
    m => { m.paletteProofs = { BAD: m.paletteProofs[proofId] }; },
    m => { m.paletteProofs[proofId] = null; }, m => { m.paletteProofs[proofId] = []; },
    m => { m.paletteProofs[proofId].extra = true; },
    m => { m.paletteProofs[proofId].indices = [255, 1]; },
    m => { m.paletteProofs[proofId].indices = [1, 1]; },
    m => { m.paletteProofs[proofId].indices = [-1, 255]; },
    m => { m.paletteProofs[proofId].indices = [1, 256]; },
    m => { m.paletteProofs[proofId].indices = [1, 2.5]; },
    m => { m.paletteProofs[proofId].indices = ['1', 255]; },
    m => { m.paletteProofs[proofId].indices = Array(257).fill(1); },
    m => { m.paletteProofs[proofId].indices = {}; },
    m => { m.paletteProofs[proofId].rgb = '123456ABCDEf'; },
    m => { m.paletteProofs[proofId].rgb = '123456abcdeg'; },
    m => { m.paletteProofs[proofId].rgb = '123456'; },
    m => { m.paletteProofs[proofId].rgb = 123456; },
    m => { m.entries[0].paletteProof = 'f'.repeat(64); },
    m => { m.entries[0].paletteProof = null; },
    m => { m.entries[0].paletteProof = 'INVALID'; },
    m => { delete m.paletteProofs; },
    m => { m.backgrounds[0].paletteProof = 'f'.repeat(64); },
    m => { m.paletteProofs = Object.fromEntries(Array.from({ length: PACK_LIMITS.entries + 1 }, (_, i) => [i.toString(16).padStart(64, '0'), { indices: [], rgb: '' }])); }
  ];
  for (const change of changes) {
    const value = proofFixture(1, true); change(value.manifest);
    await assert.rejects(load(value), /paletteProof/);
  }
  for (const value of [fixture(1), sharedFixture()]) {
    value.manifest.paletteProofs = {};
    await assert.rejects(load(value), /paletteProof/);
    delete value.manifest.paletteProofs; value.manifest.entries[0].paletteProof = proofId;
    await assert.rejects(load(value), /paletteProof/);
  }
});

test('per-room palette tables allow 4500 full contexts within the bounded 16 MiB manifest', async () => {
  const value = proofFixture();
  const proof = { indices: Array.from({ length: 256 }, (_, i) => i), rgb: 'abcdef'.repeat(256) };
  value.manifest.paletteProofs = Object.fromEntries(Array.from({ length: 4500 }, (_, i) => [i.toString(16).padStart(64, '0'), proof]));
  value.manifest.entries[0].paletteProof = '0'.repeat(64);
  const bytes = Buffer.byteLength(JSON.stringify(value.manifest));
  assert.ok(bytes > 4 * 1024 ** 2 && bytes < PACK_LIMITS.manifest);
  const pack = await load(value);
  assert.equal(Object.keys(pack.manifest.paletteProofs).length, 4500);
  assert.equal(pack.entries.get(key(1)).paletteProof, '0'.repeat(64));
  pack.dispose();
});

test('resolveKey verifies exact and aliased used RGB without touching loader state', async () => {
  const value = proofFixture(), log = [], pack = await load(value, { decode: decoder(log) });
  const raw = key(1).replace('-p12345678-', '-p87654321-');
  const before = pack.stats();
  assert.equal(pack.resolveKey(key(1), value.palette), key(1));
  value.palette[200 * 4] = 99; value.palette[7] = 12;
  assert.equal(pack.resolveKey(raw, value.palette), key(1), 'returns the original manifest key, not a synthesized key');
  value.palette[4]--;
  assert.equal(pack.resolveKey(raw, value.palette), undefined, 'used RGB fade falls back');
  assert.equal(pack.resolveKey(key(1), value.palette), undefined, 'an exact raw CRC still needs RGB verification');
  assert.equal(pack.resolveKey(raw), undefined);
  assert.deepEqual(pack.stats(), before);
  for (const state of ['cache', 'pending', 'wanted', 'queue', 'hints', 'failed']) assert.equal(pack[state].size, 0);
  assert.equal(log.length, 0);
  pack.dispose(); assert.equal(pack.resolveKey(key(1), value.palette), undefined);
});

test('proof aliases preserve pixel CRC, dimensions, pitch and transparency exactly', async () => {
  const value = proofFixture(), pack = await load(value);
  for (const raw of ['unknown', key(2), key(1, 2), key(1, 1, 2),
    key(1).replace('1x1-1-', '1x1-2-'), key(1).replace(/-0$/, '-opaque'), key(1).replace(/-0$/, '-1')]) {
    assert.equal(pack.resolveKey(raw, value.palette), undefined, raw);
  }
  value.palette[0] = 64;
  assert.equal(pack.resolveKey(key(1), value.palette), key(1), 'transparent actor index zero is ignored only because its proof omits zero');
  pack.dispose();
  const opaque = proofFixture();
  opaque.manifest.entries[0].key = key(1).replace(/-0$/, '-opaque');
  opaque.manifest.paletteProofs[proofId] = { indices: [0, 1, 255], rgb: '000000123456abcdef' };
  const opaquePack = await load(opaque), canonical = opaque.manifest.entries[0].key;
  assert.equal(opaquePack.resolveKey(canonical, opaque.palette), canonical);
  assert.equal(opaquePack.resolveKey(key(1), opaque.palette), undefined);
  opaque.palette[0] = 64;
  assert.equal(opaquePack.resolveKey(canonical, opaque.palette), undefined, 'opaque index zero is real RGB');
  opaquePack.dispose();
});

test('proof aliases honor the selected background, including original native fallback', async () => {
  const value = proofFixture(1, true), pack = await load(value);
  const canonical = value.manifest.backgrounds[0].key, raw = canonical.replace('-p12345678-', '-p87654321-');
  assert.equal(pack.resolveKey(canonical, value.palette), undefined);
  assert.equal(pack.resolveKey(raw, value.palette), undefined);
  assert.equal(pack.entryFor(canonical), undefined);
  for (const id of ['gemini', 'realesrnet']) {
    pack.selectBackground(id);
    assert.equal(pack.resolveKey(raw, value.palette), canonical);
    assert.equal(pack.entryFor(canonical).id, id);
    assert.equal(pack.entryFor(canonical).paletteProof, proofId);
  }
  pack.selectBackground('original');
  assert.equal(pack.resolveKey(raw, value.palette), undefined);
  assert.equal(pack.resolveKey(key(1), value.palette), key(1));
  pack.dispose();
});

test('proof aliases fail closed for different images or flips, but identical replacements choose the first canonical key', async () => {
  for (const mode of ['image', 'flip', 'same']) {
    const value = proofFixture(2), [first, second] = value.manifest.entries;
    second.key = first.key.replace('-p12345678-', '-p87654321-');
    if (mode !== 'image') {
      second.image = first.image; value.manifest.images.pop(); value.images.pop();
      if (mode === 'flip') second.flipX = true;
    }
    const pack = await load(value), expected = mode === 'same' ? first.key : undefined;
    assert.equal(pack.resolveKey(first.key, value.palette), expected, `${mode}: exact key cannot bypass ambiguity`);
    assert.equal(pack.resolveKey(second.key, value.palette), expected);
    assert.equal(pack.resolveKey(first.key.replace('-p12345678-', '-pffffffff-'), value.palette), expected);
    pack.dispose();
  }
  const value = sharedFixture();
  value.manifest.lossless = true;
  const image = value.manifest.images[0], bytes = png(2, 2);
  Object.assign(image, { format: 'png', file: 'images/shared.png', sha256: digest(bytes) });
  value.images = [file(image.file, bytes)];
  value.manifest.paletteProofs = { [proofId]: { indices: [1], rgb: '123456' } };
  const [first, second] = value.manifest.entries;
  first.paletteProof = second.paletteProof = proofId;
  second.key = first.key.replace('-p12345678-', '-p87654321-'); second.flipX = first.flipX;
  const pack = await load(value), palette = new Uint8Array(1024);
  palette.set([0x12, 0x34, 0x56], 4);
  assert.equal(pack.resolveKey(first.key, palette), undefined, 'different crop placements are ambiguous even for one physical image');
  pack.dispose();
});

test('legacy and proof-free lossless bindings remain exact-only without requiring a palette', async () => {
  for (const value of [fixture(1, true), sharedFixture(), proofFixture()]) {
    delete value.manifest.paletteProofs;
    for (const entry of value.manifest.entries) delete entry.paletteProof;
    const pack = await load(value);
    assert.equal(pack.resolveKey(key(1)), key(1));
    assert.equal(pack.resolveKey(key(1).replace('-p12345678-', '-p87654321-'), new Uint8Array(1024)), undefined);
    assert.equal(pack.resolveKey('unknown'), undefined);
    if (value.manifest.backgrounds.length) {
      const canonical = value.manifest.backgrounds[0].key;
      assert.equal(pack.resolveKey(canonical), undefined);
      pack.selectBackground('gemini'); assert.equal(pack.resolveKey(canonical), canonical);
    }
    pack.dispose();
  }
});

test('v2 shares one physical WebP across independent mirrored logical bindings', async () => {
  const value = sharedFixture(), log = [];
  const pack = await load(value, { decode: async (file, entry) => {
    log.push(entry); return { width: 2, height: 2, close() {} };
  } });
  pack.observe([key(1), key(2)]); await settle(pack);
  const hits = pack.observe([key(1), key(2)]);
  assert.equal(log.length, 1); assert.equal(pack.stats().cacheBytes, 16);
  assert.equal(hits.size, 2); assert.equal(hits.get(key(1)).image, hits.get(key(2)).image);
  assert.equal(hits.get(key(1)).width, 4); assert.equal(hits.get(key(2)).flipX, true);
  assert.equal(hits.get(key(2)).crop.x, 1);
  pack.dispose();
});

test('v2 validates physical dimensions and references separately from logical allocation', async () => {
  for (const change of [m => { m.images[0].width = 8; }, m => { m.entries[0].image = 'unknown'; },
    m => { m.entries[0].flipX = 1; }, m => { m.entries[0].crop.x = 4; },
    m => { m.images[0].file = '../escape.webp'; }, m => { m.images.push({ ...m.images[0] }); },
    m => { m.images[0].format = 'png'; }, m => { m.entries[0].sha256 = 'e'.repeat(64); }]) {
    const value = sharedFixture(); change(value.manifest);
    await assert.rejects(load(value), /image|crop/);
  }
  const value = sharedFixture(); value.images[0] = file(value.manifest.images[0].file, new Uint8Array(30));
  await assert.rejects(load(value), /SHA256/);
});

test('WebP header verification rejects animation, truncated RIFF and mismatched dimensions', () => {
  const value = sharedFixture(), image = value.manifest.images[0];
  const bytes = new Uint8Array(30), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF')); view.setUint32(4, 22, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8); view.setUint32(16, 10, true);
  bytes[24] = bytes[27] = 1;
  validateImageHeader(bytes, image);
  bytes[20] = 2; assert.throws(() => validateImageHeader(bytes, image), /animated/); bytes[20] = 0;
  bytes[24] = 3; assert.throws(() => validateImageHeader(bytes, image), /dimensions/); bytes[24] = 1;
  view.setUint32(4, 200, true); assert.throws(() => validateImageHeader(bytes, image), /RIFF/);
});

test('legacy PNG bindings cannot inject internal shared-resource metadata or another codec', async () => {
  for (const field of [{ imageResource: { width: 1, height: 1 } },
    { imageResource: { crop: { x: 0, y: 0, width: -8192, height: 8192 } } },
    { image: 'd'.repeat(64) }, { flipX: true }, { format: 'webp' }]) {
    const value = fixture(1); Object.assign(value.manifest.entries[0], field);
    await assert.rejects(load(value), /unexpected image resource/);
  }
});
function decoder(log = []) {
  return async value => {
    const bytes = await value.arrayBuffer(), view = new DataView(bytes);
    const image = { width: view.getUint32(16), height: view.getUint32(20), closed: 0,
      close() { this.closed++; } };
    log.push({ file: value.name, image }); return image;
  };
}
async function settle(pack) {
  for (let tries = 0; tries < 20; tries++) {
    if (!pack.pending.size) return;
    await Promise.all([...pack.pending.values()]);
  }
  throw new Error('decode queue did not settle');
}
const load = (value, options = {}) => loadReplacementPack(value.files(), { runtimeSHA256, decode: decoder(), ...options });

test('validates local pack without decoding; exact unknown keys fall back', async () => {
  const value = fixture(), log = [];
  value.manifest.sourceBinding = 'b'.repeat(64);
  const pack = await load(value, { decode: decoder(log) });
  assert.equal(log.length, 0);
  assert.equal(pack.stats().loaded, true);
  assert.equal(pack.stats().selectedBackground, 'original');
  assert.equal(pack.observe(['unknown']).size, 0);
  assert.deepEqual(pack.stats().missKeys, ['unknown']);
  assert.equal(pack.observe([key(1), key(1)]).size, 0);
  assert.equal(pack.stats().pendingLoads, 1);
  pack.observe([key(1)]);
  await settle(pack);
  assert.equal(log.length, 1, 'in-flight requests are deduplicated');
  assert.equal(pack.observe([key(1)]).get(key(1)).scale, 4);
  assert.deepEqual(pack.stats().hitKeys, [key(1)]);
  assert.equal(pack.stats().cacheBytes, 64);
  pack.dispose();
  assert.equal(log[0].image.closed, 1);
});

for (const path of ['../evil.png', '/evil.png', 'a/../../evil.png', 'a\\evil.png', 'a/%2e%2e/evil.png',
  'https://host/evil.png', 'a//evil.png', './evil.png', 'a.png?x', 'a\u0000.png']) {
  test(`rejects unsafe manifest file path ${JSON.stringify(path)}`, async () => {
    const value = fixture(1); value.manifest.entries[0].file = path;
    await assert.rejects(load(value), /unsafe or missing/);
  });
}

test('rejects unsafe/mixed/duplicate selected directory paths and non-PNG files', async () => {
  const value = fixture(1);
  for (const extra of [file('bad.png', png(4, 4), '../bad.png'), file('bad.png', png(4, 4), 'other/bad.png'),
    value.images[0], file('readme.txt', 'not an image')]) {
    await assert.rejects(loadReplacementPack([...value.files(), extra], { runtimeSHA256 }), /path|directory|PNG/);
  }
});

test('rejects missing files and missing or malformed manifest', async () => {
  const value = fixture(1);
  await assert.rejects(loadReplacementPack(value.images, { runtimeSHA256 }), /missing or oversized/);
  await assert.rejects(loadReplacementPack([file('room-pack.json', '{')], { runtimeSHA256 }), /invalid manifest JSON/);
  value.manifest.entries[0].file = 'missing.png';
  await assert.rejects(load(value), /missing PNG/);
});

test('rejects unsupported schema, runtime, hashes and duplicate entries', async () => {
  const changes = [
    [value => { value.version = 2; }, /schema/],
    [value => { value.private = false; }, /schema/],
    [value => { value.scale = 2; }, /schema/],
    [value => { value.room = 'Scene1003'; }, /schema/],
    [value => { value.runtimeSHA256 = 'f'.repeat(64); }, /runtime SHA256/],
    [value => { value.runtimeSHA256 = 'sha256:unknown'; }, /runtime SHA256/],
    [value => { delete value.sourceBinding; }, /sourceBinding/],
    [value => { value.sourceBinding = 'x'.repeat(65537); }, /sourceBinding/],
    [value => { value.coverage = []; }, /coverage/],
    [value => { value.entries[0].sha256 = 'md5'; }, /SHA256/],
    [value => { value.entries[0].sourceSHA256 = 'unknown'; }, /invalid\/duplicate/],
    [value => { value.entries[0].kind = 'script'; }, /invalid\/duplicate/],
    [value => { value.entries[0].resource = {}; }, /invalid\/duplicate/],
    [value => { value.entries[0].frameId = []; }, /invalid\/duplicate/],
    [value => { value.entries[1].key = value.entries[0].key; }, /duplicate/],
    [value => { value.entries[1].file = value.entries[0].file; }, /duplicate/],
  ];
  for (const [change, pattern] of changes) {
    const value = fixture(); change(value.manifest);
    await assert.rejects(load(value), pattern);
  }
});

test('rejects invalid key bounds, dimensions and scale', async () => {
  for (const sourceKey of ['1x1-1-abcdef00-p12345678-256', '1x1-1-abcdef00-p12345678-00',
    '2x1-1-abcdef00-p12345678-0', '99999x1-99999-abcdef00-p12345678-0', 'unknown']) {
    const value = fixture(1); value.manifest.entries[0].key = sourceKey;
    await assert.rejects(load(value), /source key/);
  }
  for (const change of [entry => { entry.width = 8; }, entry => { entry.scale = 1; },
    entry => { entry.key = key(1, 4096, 2048); entry.width = 16384; entry.height = 8192; }]) {
    const value = fixture(1); change(value.manifest.entries[0]);
    await assert.rejects(load(value), /dimension\/scale/);
  }
});

test('verifies every encoded hash and PNG dimensions before any decode', async () => {
  const value = fixture(2), log = [];
  value.manifest.entries[1].sha256 = '0'.repeat(64);
  await assert.rejects(load(value, { decode: decoder(log) }), /SHA256 mismatch/);
  assert.equal(log.length, 0);
  for (const bytes of [new Uint8Array(33), png(8, 4)]) {
    const bad = fixture(1); bad.images[0] = file(bad.manifest.entries[0].file, bytes);
    bad.manifest.entries[0].sha256 = digest(bytes);
    await assert.rejects(load(bad), /PNG IHDR|PNG dimensions/);
  }
});

test('bounds file count, manifest, per-file, total encoded bytes and entries', async () => {
  const value = fixture(1);
  const fake = (name, size) => ({ name, webkitRelativePath: `pack/${name}`, size });
  await assert.rejects(loadReplacementPack(Array(PACK_LIMITS.files + 1).fill(value.images[0]), { runtimeSHA256 }), /file count/);
  await assert.rejects(loadReplacementPack([fake('room-pack.json', PACK_LIMITS.manifest + 1)], { runtimeSHA256 }), /room-pack.json/);
  await assert.rejects(loadReplacementPack([fake('a.png', PACK_LIMITS.fileBytes + 1)], { runtimeSHA256 }), /file size/);
  await assert.rejects(loadReplacementPack(Array.from({ length: 17 }, (_, i) => fake(`${i}.png`, PACK_LIMITS.fileBytes)), { runtimeSHA256 }), /encoded byte/);
  value.manifest.entries = Array(PACK_LIMITS.entries + 1).fill({});
  await assert.rejects(load(value), /count limit/);
});

test('bounded local and URL budgets accept 4226 unique entries and a manifest beyond 2 MiB', async t => {
  const value = fixture(4226);
  value.manifest.room = 'Scene1002';
  value.manifest.coverage = { catalogNotes: 'x'.repeat(2 * 1024 ** 2 - JSON.stringify(value.manifest).length) };
  const manifestBytes = Buffer.byteLength(JSON.stringify(value.manifest));
  assert.ok(manifestBytes > 2 * 1024 ** 2 && manifestBytes <= PACK_LIMITS.manifest);
  assert.ok(value.files().length > 4096);
  const pack = await load(value);
  assert.equal(pack.stats().loaded, true);
  assert.equal(pack.stats().entries, 4226);
  pack.dispose();
  const setup = urlFixture(t, value);
  const remote = await loadReplacementPackURL('/__private-room-pack/room2/room-pack.json', { runtimeSHA256 });
  assert.equal(remote.stats().entries, 4226);
  assert.equal(setup.requests.length, 1);
  assert.equal(setup.decoded.length, 0);
  remote.dispose();
});

test('background toggle shares a key, never removes sprites, original needs no background decode', async () => {
  const value = fixture(1, true), log = [];
  const pack = await load(value, { decode: decoder(log) });
  const bgKey = value.manifest.backgrounds[0].key;
  pack.observe([key(1), bgKey]); await settle(pack);
  assert.deepEqual(log.map(item => item.file), ['sprites/1.png']);
  pack.selectBackground('gemini'); pack.observe([key(1), bgKey]); await settle(pack);
  assert.equal(pack.observe([key(1), bgKey]).get(bgKey).image, log[1].image);
  pack.selectBackground('realesrnet'); pack.observe([key(1), bgKey]); await settle(pack);
  assert.equal(pack.observe([key(1), bgKey]).get(bgKey).image, log[2].image);
  pack.selectBackground('original');
  assert.deepEqual([...pack.observe([key(1), bgKey]).keys()], [key(1)]);
  assert.equal(pack.stats().selectedBackground, 'original');
  assert.throws(() => pack.selectBackground('untrusted'), /unknown background/);
  pack.dispose(); assert.ok(log.every(item => item.image.closed === 1));
});

test('rejects duplicate backgrounds, wrong background keys and collision with layers', async () => {
  for (const change of [value => { value.backgrounds[1].id = 'gemini'; },
    value => { value.backgrounds[1].key = key(10, 640, 480); },
    value => { value.entries[0].key = value.backgrounds[0].key; value.entries[0].width = 2560; value.entries[0].height = 1920; },
    value => { value.backgrounds[0].width = 4; }]) {
    const value = fixture(1, true); change(value.manifest);
    await assert.rejects(load(value), /background|dimension\/scale/);
  }
});

test('LRU is bounded, touches hits, evicts/closes and re-requests an evicted frame', async () => {
  const value = fixture(3), log = [];
  const pack = await load(value, { cacheBytes: 128, decode: decoder(log) });
  pack.observe([key(1), key(2)]); await settle(pack);
  assert.equal(pack.stats().cacheBytes, 128);
  pack.observe([key(1)]);
  pack.observe([key(3)]); await settle(pack);
  assert.equal(log[1].image.closed, 1);
  assert.equal(log[0].image.closed, 0);
  pack.observe([key(2)]); await settle(pack);
  assert.equal(log.length, 4);
  assert.equal(pack.stats().cacheBytes, 128);
  pack.dispose(); assert.ok(log.every(item => item.image.closed === 1));
});

test('normal playback can retain a full actor cycle within a bounded larger cache', async () => {
  const value = fixture(1);
  const pack = await load(value, { cacheBytes: PACK_LIMITS.maxCacheBytes });
  assert.equal(pack.budget, 192 * 1024 ** 2);
  pack.dispose();
  await assert.rejects(load(value, { cacheBytes: PACK_LIMITS.maxCacheBytes + 1 }), /cache budget/);
  assert.equal(PACK_LIMITS.cacheBytes, 96 * 1024 ** 2, 'diagnostic mode keeps its original default budget');
});

test('demand larger than cache settles without an infinite automatic re-decode loop', async () => {
  const log = [], pack = await load(fixture(3), { cacheBytes: 64, decode: decoder(log) });
  pack.observe([key(1), key(2), key(3)]); await settle(pack);
  assert.equal(log.length, 3);
  assert.equal(pack.stats().cacheBytes, 64);
  pack.dispose();
});

test('selected background stays resident while animation LRU entries are evicted', async () => {
  const value = fixture(3, true), log = [], bgBytes = 2560 * 1920 * 4;
  const pack = await load(value, { cacheBytes: bgBytes + 128, decode: decoder(log) });
  const bgKey = value.manifest.backgrounds[0].key;
  pack.selectBackground('gemini'); pack.observe([bgKey, key(1), key(2)]); await settle(pack);
  pack.observe([key(3)]); await settle(pack);
  assert.equal(log.find(item => item.file === 'gemini.png').image.closed, 0);
  assert.equal(log.find(item => item.file === 'sprites/1.png').image.closed, 1);
  assert.equal(pack.stats().cacheBytes, bgBytes + 128);
  assert.equal(pack.observe([bgKey]).size, 1);
  pack.dispose();
});

test('an image larger than the cache budget falls back without decoding', async () => {
  const log = [], pack = await load(fixture(1), { cacheBytes: 63, decode: decoder(log) });
  assert.equal(pack.observe([key(1)]).size, 0);
  await settle(pack);
  assert.equal(log.length, 0);
  assert.match(Object.values(pack.stats().errors)[0], /exceeds decoded cache/);
  pack.dispose();
});

test('changing current demand drops queued decodes even without disposing the pack', async () => {
  const value = fixture(3), pending = [];
  const pack = await load(value, { decode: () => new Promise(resolve => pending.push(resolve)) });
  pack.observe([key(1), key(2), key(3)]); await Promise.resolve();
  pack.observe([]);
  pending.forEach(resolve => resolve({ width: 4, height: 4, close() {} }));
  await settle(pack);
  assert.equal(pending.length, 2);
  assert.equal(pack.stats().queuedLoads, 0);
  pack.dispose();
});

test('limits concurrent decodes and cancels stale queues while closing late images', async () => {
  const value = fixture(3), pending = [];
  const pack = await load(value, { decode: () => new Promise(resolve => pending.push(resolve)) });
  pack.observe([key(1), key(2), key(3)]);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(pack.stats().pendingLoads, 2);
  assert.equal(pack.stats().queuedLoads, 1);
  pack.observe([]);
  pack.dispose();
  const images = pending.map(resolve => {
    const image = { width: 4, height: 4, closed: 0, close() { this.closed++; } };
    resolve(image); return image;
  });
  await settle(pack);
  assert.ok(images.every(image => image.closed === 1));
  assert.equal(pack.stats().cacheBytes, 0);
  assert.equal(pack.stats().pendingLoads, 0);
  assert.equal(pack.observe([key(1)]).size, 0);
});

test('abort before/during validation and after installation cancels and disposes', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(load(fixture(1), { signal: controller.signal }), { name: 'AbortError' });
  const value = fixture(1), during = new AbortController();
  const files = value.files();
  files[1].arrayBuffer = async () => { during.abort(); return png(4, 4).buffer; };
  await assert.rejects(loadReplacementPack(files, { runtimeSHA256, signal: during.signal }), { name: 'AbortError' });
  const after = new AbortController(), log = [], pack = await load(fixture(1), { signal: after.signal, decode: decoder(log) });
  pack.observe([key(1)]); await settle(pack); after.abort();
  assert.equal(pack.stats().loaded, false);
  assert.equal(log[0].image.closed, 1);
});

test('decode failures/dimension mismatch are reported once with original fallback', async () => {
  const value = fixture(1), image = { width: 5, height: 4, closed: 0, close() { this.closed++; } };
  const pack = await load(value, { decode: async () => image });
  pack.observe([key(1)]); await settle(pack);
  assert.equal(image.closed, 1);
  assert.equal(pack.stats().cacheBytes, 0);
  assert.match(Object.values(pack.stats().errors)[0], /Decoded PNG dimensions/);
  assert.equal(pack.observe([key(1)]).size, 0);
  assert.equal(pack.stats().pendingLoads, 0);
  pack.dispose();
});

const manifestURL = '/__private-room-pack/room-pack.json';
function urlFixture(t, value = fixture()) {
  const requests = [], decoded = [], origin = 'http://127.0.0.1:4173';
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: `${origin}/`, origin } });
  t.after(() => location ? Object.defineProperty(globalThis, 'location', location) : delete globalThis.location);
  const bodies = new Map(value.images.map((image, index) => [(value.manifest.images ?? value.manifest.entries)[index]?.file, image]));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error'); assert.equal(options.mode, 'same-origin');
    const path = new URL(url).pathname.slice((value.manifest.room === 'Scene1002' ? '/__private-room-pack/room2/' : '/__private-room-pack/').length);
    return new Response(new URL(url).pathname.endsWith('/room-pack.json') ? JSON.stringify(value.manifest) : bodies.get(path), { status: 200 });
  });
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = decoder(decoded);
  t.after(() => { if (bitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = bitmap; });
  return { value, requests, decoded, bodies, load: options => loadReplacementPackURL(manifestURL, { runtimeSHA256, ...options }) };
}

for (const stage of ['headers', 'body']) for (const cancellation of ['timeout', 'caller']) {
  test(`URL pack cancels stalled ${stage} on ${cancellation}`, { timeout: 2000 }, async t => {
    const setup = urlFixture(t), caller = new AbortController();
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
    await assert.rejects(setup.load({ signal: caller.signal, timeoutMs: cancellation === 'timeout' ? 20 : 1000 }),
      { name: cancellation === 'timeout' ? 'TimeoutError' : 'AbortError' });
    assert.equal(underlying.aborted, true);
  });
}

test('URL download deadlines are per request, not pack lifetime, and release lazy workers', { timeout: 2000 }, async t => {
  const setup = urlFixture(t), original = globalThis.fetch;
  let stalled;
  t.mock.method(globalThis, 'fetch', (url, opts) => {
    if (!String(url).endsWith('/1.png')) return original(url, opts);
    stalled = opts.signal;
    return new Promise(() => {});
  });
  const pack = await setup.load({ timeoutMs: 30 });
  t.after(() => pack.dispose());
  await new Promise(resolve => setTimeout(resolve, 50));
  pack.observe([key(1)]); await settle(pack);
  assert.equal(stalled.aborted, true);
  assert.match(pack.stats().errors['sprites/1.png'], /timed out/);
  assert.equal(pack.stats().pendingLoads, 0);
  assert.equal(pack.stats().loaded, true);
  pack.observe([key(2)]); await settle(pack);
  assert.equal(pack.observe([key(2)]).size, 1);
});

test('URL pack fetches only manifest at startup, verifies on demand and uses bounded LRU', async t => {
  const value = fixture(3); value.manifest.entries[0].sourceResources = ['alias-one', 'alias-two'];
  const setup = urlFixture(t, value), pack = await setup.load({ cacheBytes: 128 });
  assert.equal(setup.requests.length, 1); assert.equal(setup.decoded.length, 0);
  pack.observe([key(1), key(2)]); await settle(pack);
  assert.equal(setup.requests.length, 3); assert.equal(setup.decoded.length, 2);
  const evicted = pack.observe([key(2)]).get(key(2)).image;
  pack.observe([key(1)]); pack.observe([key(3)]); await settle(pack);
  assert.equal(evicted.closed, 1);
  assert.equal(pack.stats().cacheBytes, 128);
  pack.observe([key(2)]); await settle(pack);
  assert.equal(setup.requests.length, 4, 'decoded eviction reuses verified encoded bytes without another request');
  assert.equal(setup.decoded.length, 4);
  assert.equal(pack.stats().imageRequests, 3);
  assert.equal(pack.stats().encodedCacheBytes, 99);
  pack.dispose(); assert.ok(setup.decoded.every(item => item.image.closed === 1));
  assert.equal(pack.stats().encodedCacheBytes, 0);
});

test('v2 URL loader fetches a shared WebP once and decodes physical rather than logical dimensions', async t => {
  const setup = urlFixture(t, sharedFixture());
  let calls = 0;
  globalThis.createImageBitmap = async (blob, ...crop) => {
    assert.equal(blob.type, 'image/webp'); assert.deepEqual(crop, []); calls++;
    return { width: 2, height: 2, close() {} };
  };
  const pack = await setup.load();
  pack.observe([key(1), key(2)]); await settle(pack);
  assert.equal(pack.observe([key(1), key(2)]).size, 2);
  assert.equal(setup.requests.length, 2); assert.equal(calls, 1);
  assert.equal(pack.stats().cacheBytes, 16);
  pack.dispose();
});

test('manifest room values are exactly the two supported rooms, with unchanged limits', async () => {
  for (const room of ['Scene1001', 'Scene1002']) {
    const value = fixture(1, true); value.manifest.room = room;
    const pack = await load(value);
    assert.equal(pack.stats().room, room); pack.dispose();
    value.manifest.entries = Array(PACK_LIMITS.entries + 1).fill(value.manifest.entries[0]);
    assert.throws(() => validateReplacementManifest(value.manifest, runtimeSHA256), /count limit/);
  }
  for (const room of [null, 'scene1002', 'Scene1002 ', 'Scene1003', 1, {}]) {
    const value = fixture(1); value.manifest.room = room;
    assert.throws(() => validateReplacementManifest(value.manifest, runtimeSHA256), /schema/);
  }
  assert.deepEqual(PACK_LIMITS, { files: 8192, entries: 8192, manifest: 16 * 1024 ** 2,
    fileBytes: 32 * 1024 ** 2, encodedBytes: 512 * 1024 ** 2, cacheBytes: 96 * 1024 ** 2,
    maxCacheBytes: 192 * 1024 ** 2, pixels: 16 * 1024 ** 2, dimension: 8192, concurrent: 2, encodedCacheBytes: 32 * 1024 ** 2 });
});

test('second URL loads only its manifest initially and keeps all PNG requests under its prefix', async t => {
  const value = fixture(1); value.manifest.room = 'Scene1002';
  const setup = urlFixture(t, value);
  const pack = await loadReplacementPackURL('/__private-room-pack/room2/room-pack.json', { runtimeSHA256 });
  assert.equal(setup.requests.length, 1);
  assert.equal(pack.stats().room, 'Scene1002');
  pack.observe([key(1)]); await settle(pack);
  assert.equal(setup.requests[1].url, 'http://127.0.0.1:4173/__private-room-pack/room2/sprites/1.png');
  assert.equal(pack.observe([key(1)]).size, 1);
  pack.dispose();
});

test('URL endpoints reject valid manifests belonging to the other room', async t => {
  const setup = urlFixture(t, fixture(1));
  await assert.rejects(loadReplacementPackURL('/__private-room-pack/room2/room-pack.json', { runtimeSHA256 }), /room does not match URL/);
  setup.value.manifest.room = 'Scene1002';
  await assert.rejects(setup.load(), /room does not match URL/);
  assert.equal(setup.decoded.length, 0);
});

test('URL pack rejects external, nonloopback, cross-port and noncanonical manifest URLs without fetch', async t => {
  const setup = urlFixture(t);
  for (const url of ['https://127.0.0.1:4173' + manifestURL, 'http://example.com' + manifestURL,
    'http://localhost:4173' + manifestURL, 'http://127.0.0.1:4180' + manifestURL,
    manifestURL + '?x', manifestURL + '#x', '/x/..' + manifestURL,
    '/__private-room-pack/%72oom-pack.json', '/__private-room-pack/a.png', '//127.0.0.1:4173' + manifestURL,
    '/__private-room-pack/room2/../room-pack.json', '/__private-room-pack/%72oom2/room-pack.json',
    '/__private-room-pack/room2/room-pack.json?x', '/__private-room-pack/room2/room-pack.json#x',
    'http://127.0.0.1:4180/__private-room-pack/room2/room-pack.json']) {
    await assert.rejects(loadReplacementPackURL(url, { runtimeSHA256 }), /same-origin loopback/);
  }
  assert.equal(setup.requests.length, 0);
});

test('URL manifest shares strict runtime, source key, path and entry validation', async t => {
  const setup = urlFixture(t, fixture(1)), entry = setup.value.manifest.entries[0];
  await assert.rejects(setup.load({ runtimeSHA256: 'f'.repeat(64) }), /runtime SHA256/);
  entry.file = '../evil.png'; await assert.rejects(setup.load(), /unsafe/);
  entry.file = 'sprites/1.png'; entry.key = 'invalid'; await assert.rejects(setup.load(), /source key/);
  entry.key = key(1); setup.value.manifest.entries = Array(PACK_LIMITS.entries + 1).fill(entry);
  await assert.rejects(setup.load(), /count limit/);
  assert.equal(setup.decoded.length, 0);
});

test('URL image hash, IHDR and size are checked before createImageBitmap', async t => {
  const setup = urlFixture(t, fixture(1));
  for (const [bytes, sha256, pattern] of [
    [png(4, 4), '0'.repeat(64), /SHA256 mismatch/],
    [png(8, 4), digest(png(8, 4)), /PNG dimensions/],
    [new Uint8Array(33), digest(new Uint8Array(33)), /PNG IHDR/]
  ]) {
    setup.value.manifest.entries[0].sha256 = sha256;
    setup.bodies.set('sprites/1.png', new Blob([bytes]));
    const pack = await setup.load(); pack.observe([key(1)]); await settle(pack);
    assert.match(Object.values(pack.stats().errors)[0], pattern); pack.dispose();
  }
  assert.equal(setup.decoded.length, 0);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => String(url).endsWith('.png') ?
    new Response('small body', { headers: { 'content-length': String(PACK_LIMITS.fileBytes + 1) } }) : fetch(url, options));
  const pack = await setup.load(); pack.observe([key(1)]); await settle(pack);
  assert.match(Object.values(pack.stats().errors)[0], /size limit/);
  assert.equal(setup.decoded.length, 0); pack.dispose();
});

test('URL loader bounds manifest response bytes with and without content-length', async t => {
  urlFixture(t);
  for (const headers of [{}, { 'content-length': String(PACK_LIMITS.manifest + 1) }]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(PACK_LIMITS.manifest + 1), { headers }));
    await assert.rejects(loadReplacementPackURL(manifestURL, { runtimeSHA256 }), /size limit/);
  }
});

test('URL loader bounds two concurrent requests and aborts active fetches on disposal', async t => {
  const setup = urlFixture(t), fetch = globalThis.fetch, signals = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (!String(url).endsWith('.png')) return fetch(url, options);
    signals.push(options.signal);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort',
      () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const controller = new AbortController(), pack = await setup.load({ signal: controller.signal });
  pack.observe([key(1), key(2), key(3)]); await Promise.resolve();
  assert.equal(signals.length, 2); assert.equal(pack.stats().queuedLoads, 1);
  controller.abort(); await settle(pack);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(pack.stats().cacheBytes, 0); assert.equal(pack.stats().loaded, false);
  assert.equal(setup.decoded.length, 0);
  await assert.rejects(setup.load({ signal: controller.signal }), { name: 'AbortError' });
});

test('optional nextKeys are bounded, unique exact nonbackground entry references', async () => {
  for (const hints of [null, 'not an array', [key(99)], [key(2), key(2)], Array.from({ length: 5 }, (_, i) => key(i + 1)), [key(9, 640, 480)]]) {
    const value = fixture(5, true); value.manifest.entries[0].nextKeys = hints;
    await assert.rejects(load(value), /nextKeys/);
  }
  const value = fixture(3);
  value.manifest.entries[0].nextKeys = [key(2), key(3)];
  const log = [], pack = await load(value, { decode: decoder(log) });
  assert.deepEqual(pack.nextKeys(key(1)), [key(2), key(3)]);
  const hints = pack.nextKeys(key(1)); hints.pop();
  assert.equal(pack.nextKeys(key(1)).length, 2, 'callers cannot mutate validated hints');
  assert.deepEqual(pack.nextKeys('unknown'), []);
  pack.observe([key(1)]); await settle(pack);
  assert.equal(log.length, 1, 'observe never automatically prefetches hints');
  pack.dispose();
});

function controlledDecoder() {
  const started = [], waiting = new Map(), images = [];
  return { started, waiting, images,
    decode: value => new Promise(resolve => { started.push(value.name); waiting.set(value.name, resolve); }),
    finish(name, width = 4, height = 4) {
      const image = { width, height, closed: 0, close() { this.closed++; } };
      images.push(image); const resolve = waiting.get(name); waiting.delete(name); resolve(image); return image;
    }
  };
}

test('prefetch leaves one worker free, prioritizes visible demand and keeps hints across observe', async () => {
  const work = controlledDecoder(), pack = await load(fixture(6), { decode: work.decode });
  pack.prefetch([key(1), key(2), key(3)]); await Promise.resolve();
  assert.deepEqual(work.started, ['sprites/1.png']);
  pack.observe([key(4), key(5)]); await Promise.resolve();
  assert.deepEqual(work.started, ['sprites/1.png', 'sprites/4.png']);
  work.finish('sprites/1.png'); await pack.pending.get('sprites/1.png'); await Promise.resolve();
  assert.deepEqual(work.started, ['sprites/1.png', 'sprites/4.png', 'sprites/5.png'], 'queued demand starts before another hint');
  work.finish('sprites/4.png'); work.finish('sprites/5.png');
  await Promise.all([...pack.pending.values()]); await Promise.resolve();
  assert.equal(work.started.at(-1), 'sprites/2.png');
  pack.observe([key(4), key(5)]);
  work.finish('sprites/2.png'); await pack.pending.get('sprites/2.png'); await Promise.resolve();
  assert.equal(work.started.at(-1), 'sprites/3.png');
  work.finish('sprites/3.png'); await settle(pack);
  assert.equal(pack.observe([key(1), key(2), key(3)]).size, 3);
  pack.dispose(); assert.ok(work.images.every(image => image.closed === 1));
});

test('prefetch does not change visible demand or hit/miss statistics and deduplicates loads', async () => {
  const log = [], pack = await load(fixture(3), { decode: decoder(log) });
  pack.observe([key(1), 'unknown']); await settle(pack);
  const before = pack.stats();
  pack.prefetch([key(2), key(2), 'unknown']);
  pack.prefetch([key(2), key(2)]); await settle(pack);
  assert.deepEqual([...pack.wanted.keys()], ['sprites/1.png']);
  assert.deepEqual(pack.stats().hitKeys, before.hitKeys); assert.deepEqual(pack.stats().missKeys, before.missKeys);
  assert.equal(log.length, 2);
  assert.equal(pack.observe([key(2)]).size, 1); await settle(pack);
  assert.equal(log.length, 2, 'prefetched image is reused, not decoded twice');
  pack.dispose();
});

test('prefetch replaces stale queued hints and closes stale in-flight results', async () => {
  const work = controlledDecoder(), pack = await load(fixture(4), { decode: work.decode });
  pack.prefetch([key(1), key(2)]); await Promise.resolve();
  pack.prefetch([key(3), key(4)]);
  const stale = work.finish('sprites/1.png'); await pack.pending.get('sprites/1.png'); await Promise.resolve();
  assert.equal(stale.closed, 1); assert.equal(pack.cache.has('sprites/1.png'), false);
  assert.deepEqual(work.started, ['sprites/1.png', 'sprites/3.png']);
  pack.prefetch([]);
  const cancelled = work.finish('sprites/3.png'); await settle(pack);
  assert.equal(cancelled.closed, 1); assert.equal(pack.stats().queuedLoads, 0);
  assert.equal(work.started.length, 2);
  pack.dispose();
});

test('a pending hint promoted to demand is deduplicated and retained after hint replacement', async () => {
  const work = controlledDecoder(), pack = await load(fixture(2), { decode: work.decode });
  pack.prefetch([key(1)]); await Promise.resolve();
  pack.observe([key(1)]); pack.prefetch([]);
  const image = work.finish('sprites/1.png'); await settle(pack);
  assert.equal(work.started.length, 1); assert.equal(image.closed, 0);
  assert.equal(pack.observe([key(1)]).size, 1); pack.dispose();
});

test('prefetch never evicts visible cache entries or a pinned background, but may replace cold entries', async () => {
  const value = fixture(4, true), log = [], bgBytes = 2560 * 1920 * 4;
  const pack = await load(value, { cacheBytes: bgBytes + 128, decode: decoder(log) });
  const bgKey = value.manifest.backgrounds[0].key;
  pack.selectBackground('gemini'); pack.observe([bgKey, key(1), key(2)]); await settle(pack);
  pack.observe([key(1), key(2)]); // Background is pinned even when absent from current observed keys.
  pack.prefetch([key(3)]); await settle(pack);
  assert.equal(log.length, 3, 'no speculative decode if all cache space is protected');
  assert.equal(pack.stats().queuedLoads, 0, 'budget-blocked hints are not reported as unfinished work');
  pack.observe([key(1)]); await settle(pack);
  assert.equal(log.length, 4);
  assert.equal(log.find(item => item.file === 'sprites/2.png').image.closed, 1);
  assert.equal(log.find(item => item.file === 'sprites/1.png').image.closed, 0);
  assert.equal(log.find(item => item.file === 'gemini.png').image.closed, 0);
  assert.equal(pack.stats().cacheBytes, bgBytes + 128);
  pack.dispose();
});

test('prefetch rechecks protected budget after decode and closes an image that no longer fits', async () => {
  const work = controlledDecoder(), pack = await load(fixture(3), { cacheBytes: 128, decode: work.decode });
  pack.prefetch([key(1)]); await Promise.resolve();
  pack.observe([key(2), key(3)]); await Promise.resolve();
  const hint = work.finish('sprites/1.png'); await pack.pending.get('sprites/1.png'); await Promise.resolve();
  assert.equal(hint.closed, 1, 'reserve space for all current demand, including pending images');
  work.finish('sprites/2.png'); work.finish('sprites/3.png'); await settle(pack);
  assert.equal(pack.stats().cacheBytes, 128); assert.equal(pack.observe([key(2), key(3)]).size, 2);
  pack.dispose();
});

test('prefetch cap is eight known keys, speculative cache is cold, and abort closes late images', async () => {
  const log = [], pack = await load(fixture(12), { cacheBytes: 128, decode: decoder(log) });
  pack.observe([key(12)]); await settle(pack);
  pack.prefetch(Array.from({ length: 11 }, (_, index) => key(index + 1))); await settle(pack);
  assert.equal(pack.hints.size, 8); assert.equal(log.length, 9);
  assert.equal(pack.stats().cacheBytes, 128);
  assert.equal(log[0].image.closed, 0);
  assert.equal(pack.cache.keys().next().value, 'sprites/8.png', 'hint stays colder than an observed image');
  pack.dispose();
  const controller = new AbortController(), work = controlledDecoder();
  const cancelled = await load(fixture(2), { signal: controller.signal, decode: work.decode });
  cancelled.prefetch([key(1), key(2)]); await Promise.resolve(); controller.abort();
  const late = work.finish('sprites/1.png'); await settle(cancelled);
  assert.equal(late.closed, 1); assert.equal(cancelled.stats().cacheBytes, 0);
  assert.equal(work.started.length, 1); assert.equal(cancelled.hints.size, 0);
});

test('URL prefetch uses the same verified on-demand path and does not fake visible hits', async t => {
  const setup = urlFixture(t, fixture(3));
  setup.value.manifest.entries[0].nextKeys = [key(2), key(3)];
  const pack = await setup.load();
  pack.prefetch(pack.nextKeys(key(1))); await settle(pack);
  assert.equal(setup.requests.length, 3); assert.equal(setup.decoded.length, 2);
  assert.deepEqual(pack.stats().hitKeys, []); assert.deepEqual(pack.stats().missKeys, []);
  assert.equal(pack.observe([key(2)]).size, 1); pack.dispose();
});

function croppedFixture(count = 3) {
  const value = fixture(count);
  for (const entry of value.manifest.entries) entry.crop = { x: 1, y: 1, width: 2, height: 2 };
  return value;
}
function cropDecoder(log = []) {
  return async (blob, entry) => {
    const size = entry.crop ?? entry;
    const image = { width: size.width, height: size.height, closed: 0, close() { this.closed++; } };
    log.push({ blob, entry, image }); return image;
  };
}

test('crop metadata is bounded while source keys, full PNG dimensions and hashes remain authoritative', async () => {
  for (const crop of [null, [], {}, { x: -1, y: 0, width: 2, height: 2 },
    { x: 0, y: -1, width: 2, height: 2 }, { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: 2, height: 0 }, { x: 0.5, y: 0, width: 2, height: 2 },
    { x: 3, y: 0, width: 2, height: 2 }, { x: 0, y: 3, width: 2, height: 2 },
    { x: 0, y: 0, width: Infinity, height: 2 }]) {
    const value = fixture(1); value.manifest.entries[0].crop = crop;
    await assert.rejects(load(value), /crop bounds/);
  }
  const value = croppedFixture(1), entry = value.manifest.entries[0];
  const bytes = png(2, 2);
  value.images[0] = file(entry.file, bytes); entry.sha256 = digest(bytes);
  await assert.rejects(load(value), /PNG dimensions/, 'a PNG matching only crop dimensions is not valid');
  value.images[0] = file(entry.file, png(4, 4));
  await assert.rejects(load(value), /SHA256 mismatch/, 'crop must not bypass verification of the full encoded file');
});

test('cropped decode receives full descriptor, returns full geometry and accounts LRU eviction by cropped bytes', async () => {
  const log = [], value = croppedFixture(), pack = await load(value, { cacheBytes: 32, decode: cropDecoder(log) });
  pack.observe([key(1), key(2)]); await settle(pack);
  assert.equal(pack.stats().cacheBytes, 32, 'two 2x2 bitmaps, not two padded 4x4 surfaces');
  const replacement = pack.observe([key(1)]).get(key(1));
  assert.deepEqual({ width: replacement.width, height: replacement.height, scale: replacement.scale, crop: replacement.crop },
    { width: 4, height: 4, scale: 4, crop: { x: 1, y: 1, width: 2, height: 2 } });
  assert.equal(log[0].entry, pack.entries.get(key(1)));
  assert.equal(log[0].image.width, 2);
  pack.observe([key(3)]); await settle(pack);
  assert.equal(pack.stats().cacheBytes, 32); assert.equal(log[1].image.closed, 1);
  assert.equal(log[0].image.closed, 0); pack.dispose();
  assert.ok(log.every(value => value.image.closed === 1)); assert.equal(pack.stats().cacheBytes, 0);
});

test('cropped prefetch admission and pending visible reservations use decoded rather than full dimensions', async () => {
  const log = [], pack = await load(croppedFixture(), { cacheBytes: 32, decode: cropDecoder(log) });
  pack.observe([key(1)]); await settle(pack);
  pack.prefetch([key(2)]); await settle(pack);
  assert.equal(log.length, 2, 'crop permits one visible and one prefetched bitmap in 32 bytes');
  assert.equal(pack.stats().cacheBytes, 32);
  pack.prefetch([key(3)]); await settle(pack);
  assert.equal(log.length, 3); assert.equal(log[1].image.closed, 1); assert.equal(log[0].image.closed, 0);
  assert.equal(pack.stats().cacheBytes, 32); pack.dispose();
  const limited = await load(croppedFixture(1), { cacheBytes: 15, decode: cropDecoder() });
  limited.observe([key(1)]); await settle(limited);
  assert.match(Object.values(limited.stats().errors)[0], /exceeds decoded cache/); limited.dispose();
});

test('a cropped descriptor rejects full-sized or otherwise wrong decoded bitmaps and closes them', async () => {
  const log = [], pack = await load(croppedFixture(1), { decode: decoder(log) });
  pack.observe([key(1)]); await settle(pack);
  assert.match(Object.values(pack.stats().errors)[0], /Decoded PNG dimensions differ/);
  assert.equal(log[0].image.closed, 1); assert.equal(pack.stats().cacheBytes, 0); pack.dispose();
});

test('local and URL default decode pass crop arguments only after full-file validation', async t => {
  const setup = urlFixture(t, croppedFixture(1)), calls = [];
  globalThis.createImageBitmap = async (blob, ...crop) => {
    const view = new DataView(await blob.arrayBuffer());
    assert.equal(view.getUint32(16), 4); assert.equal(view.getUint32(20), 4);
    calls.push(crop);
    return { width: crop[2] ?? 4, height: crop[3] ?? 4, close() {} };
  };
  const local = await loadReplacementPack(setup.value.files(), { runtimeSHA256 });
  assert.equal(calls.length, 0); local.observe([key(1)]); await settle(local);
  assert.deepEqual(calls, [[1, 1, 2, 2]]); assert.equal(local.stats().cacheBytes, 16); local.dispose();
  const url = await setup.load(); assert.equal(setup.requests.length, 1);
  url.prefetch([key(1)]); await settle(url);
  assert.deepEqual(calls, [[1, 1, 2, 2], [1, 1, 2, 2]]);
  assert.equal(url.stats().cacheBytes, 16); assert.equal(url.observe([key(1)]).get(key(1)).width, 4); url.dispose();
  setup.value.manifest.entries[0].sha256 = '0'.repeat(64);
  const bad = await setup.load(); bad.observe([key(1)]); await settle(bad);
  assert.equal(calls.length, 2); assert.match(Object.values(bad.stats().errors)[0], /SHA256 mismatch/); bad.dispose();
});
