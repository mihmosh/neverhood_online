import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { inspectSaveBytes, readSaveFiles, createSaveBackup, MAX_SAVE_BYTES, MAX_BATCH_BYTES } from '../lib/save-format.js';
import { inspectZip } from '../lib/zip-validation.js';
import { zip } from './zip-fixture.mjs';

function save({ description = 'Synthetic save', thumbnailVersion = 2, tag = 'THMB', refs = [[1, -1], [-1, -1]] } = {}) {
  const text = Buffer.from(description);
  const header = thumbnailVersion === 1 ? 14 : 22;
  const thumbnailSize = header + 4;
  const bytes = Buffer.alloc(5 + text.length + thumbnailSize + 17 + 4 + refs.length * 12);
  bytes[4] = text.length;
  text.copy(bytes, 5);
  const thumbnail = 5 + text.length;
  bytes.write(tag, thumbnail);
  bytes.writeUInt32BE(thumbnailSize, thumbnail + 4);
  bytes[thumbnail + 8] = thumbnailVersion;
  bytes.writeUInt16BE(2, thumbnail + 9);
  bytes.writeUInt16BE(1, thumbnail + 11);
  bytes[thumbnail + 13] = 2;
  if (thumbnailVersion === 2) bytes.set([3, 2, 3, 8, 11, 5, 0, 0], thumbnail + 14);
  const countOffset = thumbnail + thumbnailSize + 17;
  bytes.writeUInt32LE(refs.length, countOffset);
  refs.forEach(([first, next], index) => {
    bytes.writeUInt32LE(index, countOffset + 4 + index * 12);
    bytes.writeInt16LE(first, countOffset + 4 + index * 12 + 8);
    bytes.writeInt16LE(next, countOffset + 4 + index * 12 + 10);
  });
  return bytes;
}
const file = (bytes, name = 'custom-target.003') => new File([bytes], name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('imports raw and gzip native saves with canonical names, sorted slots and exact original hashes', async () => {
  const raw = save({ description: 'Original progress' });
  const compressed = gzipSync(raw);
  const result = await readSaveFiles([file(compressed, 'CUSTOM.005'), file(raw, 'Neverhood.000')]);
  assert.deepEqual(result.map(({ name, slot, description }) => ({ name, slot, description })), [
    { name: 'neverhood.000', slot: 0, description: 'Original progress' },
    { name: 'neverhood.005', slot: 5, description: 'Original progress' },
  ]);
  assert.deepEqual(result[0].bytes, new Uint8Array(raw));
  assert.deepEqual(result[1].bytes, new Uint8Array(compressed));
  assert.equal(result[0].sha256, hash(raw));
  assert.equal(result[1].sha256, hash(compressed));
  assert.deepEqual(await inspectSaveBytes(compressed), { description: 'Original progress', version: 0 });
});

test('accepts both historical thumbnail tags and supported versions', async () => {
  for (const tag of ['THMB', 'BMHT']) for (const thumbnailVersion of [1, 2]) {
    assert.equal((await inspectSaveBytes(save({ tag, thumbnailVersion }))).version, 0);
  }
});

test('every structural truncation and unexpected trailing byte is rejected', async () => {
  const bytes = save();
  for (let end = 0; end < bytes.length; end++) await assert.rejects(inspectSaveBytes(bytes.subarray(0, end)), /Invalid save/);
  await assert.rejects(inspectSaveBytes(Buffer.concat([bytes, Buffer.from([0])])), /trailing/);
});

test('rejects unknown versions, invalid thumbnail dimensions, format and count', async () => {
  const base = save();
  const thumbnail = 5 + base[4];
  const countOffset = base.length - 28;
  const mutations = [
    b => b.writeUInt32LE(1, 0),
    b => { b[thumbnail + 8] = 3; },
    b => { b[thumbnail + 8] = 0; },
    b => b.write('NOPE', thumbnail),
    b => b.writeUInt16BE(0, thumbnail + 9),
    b => { b[thumbnail + 13] = 3; },
    b => { b[thumbnail + 14] = 9; },
    b => { b[thumbnail + 18] = 255; },
    b => b.writeUInt32BE(0xffffffff, thumbnail + 4),
    b => b.writeUInt32LE(0, countOffset),
    b => b.writeUInt32LE(32769, countOffset),
    b => b.writeUInt32LE(500, countOffset),
  ];
  for (const mutate of mutations) {
    const bytes = Buffer.from(base);
    mutate(bytes);
    await assert.rejects(inspectSaveBytes(bytes), /Invalid save/);
  }
});

test('rejects out-of-range references and cycles through first or next links', async () => {
  for (const refs of [[[2, -1], [-1, -1]], [[-2, -1]], [[0, -1]], [[-1, 0]], [[1, -1], [-1, 0]]]) {
    await assert.rejects(inspectSaveBytes(save({ refs })), /reference/);
  }
  await inspectSaveBytes(save({ refs: [[1, -1], [2, 2], [-1, -1]] }));
});

test('gzip rejects truncation, CRC/ISIZE mismatch, concatenation and bounded-output bombs', async () => {
  const compressed = gzipSync(save());
  const crc = Buffer.from(compressed);
  crc[crc.length - 8] ^= 1;
  const isize = Buffer.from(compressed);
  isize[isize.length - 4] ^= 1;
  const bomb = gzipSync(Buffer.alloc(MAX_SAVE_BYTES + 1));
  const forgedBomb = Buffer.from(bomb);
  forgedBomb.writeUInt32LE(100, forgedBomb.length - 4);
  for (const bytes of [compressed.subarray(0, -1), compressed.subarray(0, 12), crc, isize, bomb, forgedBomb, Buffer.concat([compressed, compressed])]) {
    await assert.rejects(inspectSaveBytes(bytes), /gzip/);
  }
});

test('rejects unsafe names, duplicate slots across targets/case and mixed ZIP selections', async () => {
  const bytes = save();
  for (const name of ['../neverhood.000', 'folder/neverhood.000', 'C:neverhood.000', 'neverhood.00', 'neverhood.1000', '.000', 'neverhood.000\0', 'neverhood.000 ', 'neverhood.000.zip']) {
    await assert.rejects(readSaveFiles([file(bytes, name)]));
  }
  await assert.rejects(readSaveFiles([file(bytes, 'Neverhood.003'), file(bytes, 'custom.003')]), /duplicate/);
  await assert.rejects(readSaveFiles([file(bytes, 'backup.zip'), file(bytes)]));
  await assert.rejects(readSaveFiles([]));
  await assert.rejects(readSaveFiles(Array.from({ length: 1001 }, () => file(bytes))));
});

test('native files enforce size limits before reading their contents', async () => {
  const forbidden = size => ({ name: 'neverhood.000', size, arrayBuffer() { assert.fail('must not read oversized input'); } });
  for (const size of [0, MAX_SAVE_BYTES + 1, NaN, -1]) await assert.rejects(readSaveFiles([forbidden(size)]), /4 MiB/);
  await assert.rejects(inspectSaveBytes(new Uint8Array(MAX_SAVE_BYTES + 1)), /4 MiB/);
  const files = Array.from({ length: 9 }, (_, i) => ({ ...forbidden(MAX_SAVE_BYTES), name: `neverhood.00${i}` }));
  await assert.rejects(readSaveFiles(files), /32 MiB/);
  assert.equal(MAX_BATCH_BYTES, 32 * 1024 ** 2);
});

test('backup is a stored flat ZIP with byte-exact gzip originals and reimports through the same API', async () => {
  const bytes = gzipSync(save());
  const backup = await createSaveBackup([{ name: 'CUSTOM.003', bytes }, { name: 'neverhood.999', bytes }]);
  const source = file(backup, 'backup.ZIP');
  const plan = await inspectZip(source, { select: () => true, maxEntryBytes: MAX_SAVE_BYTES });
  assert.deepEqual(plan.entries.map(entry => [entry.path, entry.method]), [['neverhood.003', 0], ['neverhood.999', 0]]);
  const restored = await readSaveFiles([source]);
  for (const record of restored) {
    assert.equal(record.sha256, hash(bytes));
    assert.deepEqual(record.bytes, new Uint8Array(bytes));
  }
});

test('raw malformed existing states remain backupable without silently discarding progress', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const backup = await createSaveBackup([{ name: 'neverhood.000', bytes }]);
  const source = file(backup, 'backup.zip');
  const plan = await inspectZip(source, { select: () => true, maxEntryBytes: MAX_SAVE_BYTES });
  const entry = plan.entries[0];
  assert.deepEqual(new Uint8Array(await source.slice(entry.dataOffset, entry.dataOffset + entry.size).arrayBuffer()), bytes);
  await assert.rejects(readSaveFiles([source]), /Invalid save/);
  await assert.rejects(createSaveBackup([{ name: '../neverhood.000', bytes }]));
  await assert.rejects(createSaveBackup([{ name: 'a.000', bytes }, { name: 'B.000', bytes }]), /duplicate/);
  await assert.rejects(createSaveBackup([{ name: 'neverhood.000', bytes: new Uint8Array(MAX_SAVE_BYTES + 1) }]), /4 MiB/);
});

test('imports stored and deflated ZIP saves with CRC verification', async () => {
  for (const method of [0, 8]) {
    const bytes = gzipSync(save());
    const result = await readSaveFiles([file(zip([{ path: 'target.007', bytes, method }]), 'backup.zip')]);
    assert.equal(result[0].name, 'neverhood.007');
    assert.equal(result[0].sha256, hash(bytes));
    await assert.rejects(readSaveFiles([file(zip([{ path: 'neverhood.007', bytes, method, crc: 123 }]), 'backup.zip')]), /CRC32/);
  }
});

test('ZIP parser enforces paths, directories, aliases, declared sizes and game defaults', async () => {
  const bytes = save();
  for (const items of [
    [{ path: '../neverhood.000', bytes }],
    [{ path: 'folder/neverhood.000', bytes }],
    [{ path: 'folder/', bytes: Buffer.alloc(0), method: 0 }],
    [{ path: 'metadata.json', bytes }],
    [{ path: 'a.000', bytes }, { path: 'B.000', bytes }],
    [{ path: 'neverhood.000', bytes, size: MAX_SAVE_BYTES + 1 }],
    [{ path: 'neverhood.000', bytes, size: 1 }],
    [{ path: 'neverhood.000', bytes, attributes: 0xa000 << 16 >>> 0 }],
    [{ path: 'neverhood.000', bytes, attributes: 0x4000 << 16 >>> 0 }],
    [{ path: 'neverhood.000', bytes, attributes: 0x10 }],
    [{ path: 'neverhood.000', bytes: Buffer.alloc(1024 ** 2), size: 100 }],
  ]) await assert.rejects(readSaveFiles([file(zip(items), 'backup.zip')]));
  const saves = file(zip([{ path: 'neverhood.000', bytes }]), 'backup.zip');
  await assert.rejects(inspectZip(saves), /no BLB/);
  await assert.rejects(inspectZip(saves, { select: () => true, maxEntryBytes: bytes.length - 1 }), /size limit/);
  await assert.rejects(inspectZip(saves, { select: () => true, maxEntryBytes: MAX_SAVE_BYTES, maxTotalBytes: bytes.length - 1 }), /output exceeds/);
  await assert.rejects(inspectZip(saves, { maxInputBytes: saves.size - 1 }), /input limit/);
  await assert.rejects(inspectZip(saves, { maxEntries: 0 }), /entry count/);
});

test('maximum-size raw backup fits ZIP input overhead allowance', async () => {
  const bytes = new Uint8Array(MAX_SAVE_BYTES);
  const records = Array.from({ length: 8 }, (_, i) => ({ name: `neverhood.00${i}`, bytes }));
  const backup = await createSaveBackup(records);
  assert.ok(backup.length > MAX_BATCH_BYTES);
  assert.ok(backup.length < MAX_BATCH_BYTES + 1024 ** 2);
  const source = file(backup, 'backup.zip');
  const plan = await inspectZip(source, {
    select: () => true, maxEntryBytes: MAX_SAVE_BYTES, maxTotalBytes: MAX_BATCH_BYTES,
    maxInputBytes: MAX_BATCH_BYTES + 1024 ** 2,
  });
  assert.equal(plan.total, MAX_BATCH_BYTES);
  // It passes ZIP envelope limits but is still correctly rejected as malformed save content.
  await assert.rejects(readSaveFiles([source]), /missing thumbnail/);
  await assert.rejects(createSaveBackup([...records, { name: 'neverhood.008', bytes: new Uint8Array([1]) }]), /32 MiB/);
});

test('batch uncompressed size is bounded independently of compressed input size', async () => {
  const refs = Array.from({ length: 32768 }, () => [-1, -1]);
  const bytes = gzipSync(save({ refs }));
  const files = Array.from({ length: 86 }, (_, i) => file(bytes, `neverhood.${String(i).padStart(3, '0')}`));
  await assert.rejects(readSaveFiles(files), /uncompressed batch exceeds/);
});
