import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scanBindings, paletteSafety, rgbIdentity, freezeJson } from './bulk-sources.mjs';

test('scan expands array bindings and retains every literal/state call', () => {
  const source = `static const uint32 backgrounds[] = {0x12345678, 0x87654321};
Scene42::Scene42() {
 setBackground(backgrounds[which]);
 setPalette(backgrounds[which]);
}
void Scene42::change() {
 setBackground(0x11223344);
 setPalette(0x11223344);
 _palette->addPalette(0x12345678, 0, 64, 0);
}
void Scene43::change() { setBackground(runtimeHash); }
`;
  const bindings = scanBindings(source, 'module42.cpp');
  assert.equal(bindings.length, 3);
  assert.deepEqual(bindings[0].hashes, ['0x12345678', '0x87654321']);
  assert.equal(bindings[0].context.paletteOperations.at(-1), '_palette->addPalette(0x12345678, 0, 64, 0);');
  assert.deepEqual(bindings[2].hashes, []);
  assert.equal(bindings[2].scene, 'Scene43');
});

test('unused index ranges and same embedded palette are independently safe', () => {
  const histogram = Array(256).fill(0); histogram[100] = 20;
  const binding = { expression: '0x12345678', context: { paletteOperations: [
    '_palette->addPalette(runtimePalette, 0, 65, 0);',
    '_palette->addBasePalette(0x12345678, 0, 256, 0);',
  ] } };
  assert.equal(paletteSafety(binding, histogram).safe, true);
  histogram[0] = 1;
  assert.equal(paletteSafety(binding, histogram).safe, false);
});

test('index zero is legitimate opaque RGB and palette override equality uses RGB only', () => {
  const palette = Buffer.alloc(1024), same = Buffer.alloc(1024), changed = Buffer.alloc(1024);
  const histogram = Array(256).fill(0); histogram[0] = 1;
  same[3] = 255; changed[0] = 1;
  const binding = { expression: '0x12345678', context: { paletteOperations: ['_palette->addPalette(0xAABBCCDD, 0, 64, 0);'] } };
  assert.equal(paletteSafety(binding, histogram, palette, () => ({ bytes: same, record: {} })).safe, true);
  assert.equal(paletteSafety(binding, histogram, palette, () => ({ bytes: changed, record: {} })).safe, false);
  assert.equal(paletteSafety({ ...binding, context: { paletteOperations: [] } }, histogram).safe, true);
});

test('RGB identity deduplicates palette-index permutations without altering source', () => {
  const palette = Buffer.alloc(1024); palette[4] = 255;
  const permuted = Buffer.alloc(1024); permuted[0] = 255;
  assert.equal(rgbIdentity(Buffer.from([0, 1]), palette, 2, 1), rgbIdentity(Buffer.from([1, 0]), permuted, 2, 1));
});

test('freeze reuses identical bytes and refuses different documents', () => {
  const directory = fs.mkdtempSync('/tmp/kilo/opaque-registry-test-');
  try {
    const file = path.join(directory, 'registry.json');
    const first = freezeJson(file, { rooms: [] }), before = fs.statSync(file);
    assert.equal(freezeJson(file, { rooms: [] }), first);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.throws(() => freezeJson(file, { rooms: [1] }), /Frozen bulk registry differs/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
