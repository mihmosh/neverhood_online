import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { explode } from '../tools/assets/dcl.mjs';
import { bitmap, rle, animation, png, crc32, raster } from '../tools/assets/formats.mjs';
import { ARCHIVES, extract, privateRoot, resolveAlias, parseArchive, associate } from '../tools/assets/catalog.mjs';

test('DCL reference vector and bounded corrupt streams', () => {
  const vector = Buffer.from('00048224258f807f', 'hex');
  assert.equal(explode(vector, 13).toString(), 'AIAIAIAIAIAIA');
  assert.throws(() => explode(vector, 12), /overflow/);
  assert.throws(() => explode(vector, 14), /mismatch/);
  assert.throws(() => explode(vector.subarray(0, 4), 13), /Truncated/);
  assert.throws(() => explode(vector, 13, 12), /limit/);
  assert.throws(() => explode(Buffer.from([2, 4]), 0), /header/);
});
test('bitmap defaults, padded rows, embedded palette and absolute RLE skips', () => {
  assert.deepEqual(bitmap(Buffer.from([0, 0])), { flags: 0, width: 1, height: 1, x: 0, y: 0, palette: null, pixels: null });
  const b = Buffer.from([18,0,3,0,2,0,1,2,3,99,4,5,6,99]);
  assert.deepEqual([...bitmap(b).pixels], [1,2,3,4,5,6]);
  const encoded = Buffer.from([1,0,2,0,0,0,1,0,7,2,0,1,0,8,0,0,0,0]);
  assert.deepEqual([...rle(encoded, 3, 1)], [7,0,8]);
  assert.throws(() => rle(encoded, 2, 1), /width/);
  assert.throws(() => bitmap(b.subarray(0, 8)), /bounds/);
});
test('animation frame index disambiguates duplicate hashes and retains signed offsets', () => {
  const data = Buffer.alloc(12 + 8 + 64 + 20);
  data.writeUInt16LE(1); data.writeUInt16LE(20, 2); data.writeUInt32LE(84, 4);
  data.writeUInt32LE(123, 12); data.writeUInt16LE(2, 16);
  for (let i = 0; i < 2; i++) {
    const at = 20 + i * 32;
    data.writeUInt32LE(456, at); data.writeUInt16LE(i + 1, at + 4); data.writeInt16LE(-3, at + 6);
    data.writeUInt16LE(1, at + 10); data.writeUInt16LE(1, at + 12);
  }
  Buffer.from([1,0,1,0,0,0,1,0,42,0,0,0,0]).copy(data, 84);
  const frames = [...animation(data)];
  assert.equal(frames.length, 2); assert.equal(frames[1].frameIndex, 1);
  assert.equal(frames[0].frameHash, frames[1].frameHash);
  assert.equal(frames[1].durationTicks, 2); assert.equal(frames[0].x, -3);
});
test('indexed PNG contains exact RGB palette and valid CRCs', () => {
  const palette = Buffer.alloc(1024); palette.set([22,33,44,0], 4);
  const image = png(Buffer.from([1]), 1, 1, palette);
  let at = 8;
  while (at < image.length) {
    const n = image.readUInt32BE(at), type = image.toString('ascii', at + 4, at + 8);
    assert.equal(crc32(image.subarray(at + 4, at + 8 + n)), image.readUInt32BE(at + 8 + n));
    if (type === 'PLTE') assert.deepEqual([...image.subarray(at + 11, at + 14)], [22,33,44]);
    if (type === 'IDAT') assert.deepEqual([...inflateSync(image.subarray(at + 8, at + 8 + n))], [0,1]);
    at += n + 12;
  }
});
test('alias cycles and missing targets fail explicitly', () => {
  const a = { id: 'a', compression: 101, diskSize: 2 }, b = { id: 'b', compression: 101, diskSize: 1 };
  assert.equal(resolveAlias(a, n => n === 2 ? b : a).error, 'alias-cycle');
  assert.equal(resolveAlias(a, () => null).error, 'alias-target-missing');
  b.compression = 1;
  assert.equal(resolveAlias(a, () => b).resolved.id, 'b');
});
test('runtime rasters preserve aligned zero capacity and flip only the frame rectangle', () => {
  const out = raster(Buffer.from([1,2,3,4]), 2, 2, 3, 3, true, true);
  assert.equal(out.pitch, 4);
  assert.deepEqual([...out.pixels], [4,3,0,0,2,1,0,0,0,0,0,0]);
  assert.throws(() => raster(Buffer.alloc(4), 2, 2, 1, 1), /capacity/);
});

function fixture(entries) {
  const start = 16 + entries.length * 24;
  const out = Buffer.alloc(start + entries.reduce((n, e) => n + (e.data?.length ?? 0), 0));
  out.writeUInt32LE(0x02004940); out.writeUInt16LE(7, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(entries.length, 12);
  let offset = start;
  entries.forEach((e, i) => {
    out.writeUInt32LE(e.hash, 16 + i * 4);
    const at = 16 + entries.length * 4 + i * 20;
    out[at] = e.type ?? 2; out[at + 1] = e.alias ? 101 : 1;
    out.writeUInt32LE(e.timestamp ?? 1, at + 4); out.writeUInt32LE(offset, at + 8);
    out.writeUInt32LE(e.alias ?? e.data.length, at + 12); out.writeUInt32LE(e.data?.length ?? 0, at + 16);
    if (e.data) { e.data.copy(out, offset); offset += e.data.length; }
  });
  return out;
}
test('private output guards, synthetic seven archive extraction, resume and corruption repair', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
  try {
    const repo = path.join(temp, 'repo'), input = path.join(temp, 'input'), output = path.join(repo, 'private-assets');
    fs.mkdirSync(repo); fs.mkdirSync(input);
    assert.throws(() => privateRoot(path.join(repo, 'web'), repo, true), /private-assets/);
    assert.throws(() => privateRoot(output, repo), /marker/);
    privateRoot(output, repo, true);
    fs.symlinkSync(input, path.join(output, 'link'));
    assert.throws(() => privateRoot(output, repo), /Symlink/);
    fs.unlinkSync(path.join(output, 'link'));
    const image = Buffer.from([18,0,1,0,1,0,42,0,0,0]);
    ARCHIVES.forEach((name, index) => fs.writeFileSync(path.join(input, name), fixture(index === 0 ? [{ hash: 1, data: image }, { hash: 2, alias: 1 }] : [{ hash: 1, data: image, timestamp: index === 1 ? 2 : 1 }])));
    const opts = { input, output, repo, probe: false };
    const result = extract(opts);
    assert.equal(result.physicalEntries, 8); assert.equal(result.frames, 7); assert.equal(result.errors, 0); assert.equal(result.unresolvedPalettes, 7);
    assert.equal(result.logicalFrames, 2); assert.equal(result.rasterVariants, 8);
    const db = new DatabaseSync(path.join(output, 'catalog.sqlite'));
    const winner = db.prepare('SELECT a.name FROM aliases l JOIN resources r ON r.id=l.resolved_id JOIN archives a ON a.id=r.archive_id WHERE l.requested_hash=2').get();
    assert.equal(winner.name, 'c.blb');
    const blob = db.prepare('SELECT path FROM blobs WHERE size=1').get(); db.close();
    fs.writeFileSync(path.join(output, blob.path), Buffer.from([0]));
    const again = extract(opts); assert.equal(again.errors, 0);
    assert.deepEqual([...fs.readFileSync(path.join(output, blob.path))], [42]);
    const metadata = path.join(temp, 'associations.json');
    fs.writeFileSync(metadata, JSON.stringify({ version: 1, sourceBinding: result.sourceBinding, associations: [
      { requestedHash: '00000001', capacityWidth: 2, capacityHeight: 2, provenance: 'Synthetic fixture metadata only' }
    ] }));
    const linked = associate({ repo, output, file: metadata });
    assert.equal(linked.frames, 1); assert.equal(linked.rasterVariants, 4); assert.equal(linked.pngs, 0);
    const resumed = extract(opts);
    assert.equal(resumed.errors, 0); assert.equal(resumed.contextAssociations, 1); assert.equal(resumed.rasterVariants, 12);
    fs.writeFileSync(metadata, JSON.stringify({ version: 1, sourceBinding: 'wrong', associations: [] }));
    assert.throws(() => associate({ repo, output, file: metadata }), /sourceBinding/);
    fs.writeFileSync(path.join(input, 't.blb'), fixture([{ hash: 3, data: image }]));
    assert.throws(() => extract(opts), /different source/);
    const bad = path.join(input, 'bad.blb'); fs.writeFileSync(bad, Buffer.alloc(16));
    assert.throws(() => parseArchive(bad), /header/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
