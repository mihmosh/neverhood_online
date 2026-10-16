import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectZip, normalizeZipPath, updateCRC32, ZIP_LIMITS } from '../lib/zip-validation.js';
import { zip, crc32, unicodePathExtra } from './zip-fixture.mjs';

function file(bytes) { return new File([bytes], 'source.zip'); }

test('legacy CP437 and unflagged UTF-8 filenames preserve ASCII game basenames', async () => {
  const plan = await inspectZip(file(zip([
    { nameBytes: Buffer.from([0x82, 0x2f, ...Buffer.from('hd.blb')]), flags: 0 },
    { path: '\u0418\u0433\u0440\u0430/setup.exe', flags: 0 },
  ])));
  assert.deepEqual(plan.entries.map(entry => entry.path), ['\u00e9/hd.blb', '\u0418\u0433\u0440\u0430/setup.exe']);
});

test('CP437 fallback is deterministic for legacy Cyrillic bytes and strict for flagged UTF-8', async () => {
  const nameBytes = Buffer.from([0x88, 0xa3, 0xe0, 0xa0, 0x2f, ...Buffer.from('hd.blb')]);
  const plan = await inspectZip(file(zip([{ nameBytes, flags: 0 }])));
  assert.equal(plan.entries[0].path, '\u00ea\u00fa\u03b1\u00e1/hd.blb');
  for (const bytes of [nameBytes, Buffer.from([0xc0, 0xaf, ...Buffer.from('hd.blb')]), Buffer.from([0xed, 0xa0, 0x80, ...Buffer.from('hd.blb')])]) {
    await assert.rejects(inspectZip(file(zip([{ nameBytes: bytes }]))), /invalid UTF-8/);
  }
  // Valid UTF-8 containing a control must not be retried as CP437.
  await assert.rejects(inspectZip(file(zip([{ path: 'a/\x01hd.blb', flags: 0 }]))), /unsafe/);
});

test('Unicode Path overrides use version 1 and CRC of raw filename, including central-only metadata', async () => {
  const nameBytes = Buffer.from([0x82, ...Buffer.from('/old.txt')]);
  const path = '\u0418\u0433\u0440\u0430/hd.blb';
  const extra = unicodePathExtra(nameBytes, path);
  for (const localExtra of [extra, Buffer.alloc(0), unicodePathExtra(nameBytes, '../ignored', { crc: 42 }), unicodePathExtra(nameBytes, '../ignored', { version: 2 })]) {
    const plan = await inspectZip(file(zip([{ nameBytes, flags: 0, extra, localExtra }])));
    assert.equal(plan.entries[0].path, path);
    assert.equal(plan.total, 13);
  }
  const raw = Buffer.from('raw/hd.blb');
  for (const options of [{ crc: (crc32(raw) ^ 1) >>> 0 }, { version: 0 }, { version: 2 }]) {
    const plan = await inspectZip(file(zip([{ nameBytes: raw, flags: 0, extra: unicodePathExtra(raw, '../ignored', options) }])));
    assert.equal(plan.entries[0].path, 'raw/hd.blb');
  }
});

test('Unicode Path validation rejects unsafe aliases, malformed fields and invalid UTF-8', async () => {
  const nameBytes = Buffer.from('raw/hd.blb');
  for (const path of ['../hd.blb', '/hd.blb', 'a\\hd.blb', 'a/\x00hd.blb', 'a/\x1fhd.blb', 'a/\x7fhd.blb', 'a//hd.blb', 'a/../hd.blb', '']) {
    await assert.rejects(inspectZip(file(zip([{ nameBytes, flags: 0, extra: unicodePathExtra(nameBytes, path) }]))), /unsafe/);
  }
  const invalidUTF8 = unicodePathExtra(nameBytes, 'x');
  invalidUTF8[9] = 0xff;
  const malformed = [Buffer.from([0x75]), Buffer.from([0x75, 0x70, 5, 0, 1]), Buffer.from([0x75, 0x70, 4, 0, 1, 0, 0, 0]), invalidUTF8];
  for (const extra of malformed) {
    for (const fields of [{ extra }, { localExtra: extra }]) {
      await assert.rejects(inspectZip(file(zip([{ nameBytes, flags: 0, ...fields }]))), /extra field/);
    }
  }
  await assert.rejects(inspectZip(file(zip([{ path: '../raw.blb', flags: 0, extra: unicodePathExtra(Buffer.from('../raw.blb'), 'safe.blb') }]))), /unsafe/);
});

test('Unicode aliases cannot bypass duplicate normalization or raw-name alias checks', async () => {
  for (const alias of ['HD.BLB', 'e\u0301/hd.blb']) {
    const nameBytes = Buffer.from('original.blb');
    const duplicate = alias.startsWith('H') ? 'hd.blb' : '\u00e9/hd.blb';
    await assert.rejects(inspectZip(file(zip([
      { nameBytes, flags: 0, extra: unicodePathExtra(nameBytes, alias) },
      { path: duplicate },
    ]))), /duplicate/);
  }
  const nameBytes = Buffer.from('raw.blb');
  await assert.rejects(inspectZip(file(zip([
    { nameBytes, flags: 0, extra: unicodePathExtra(nameBytes, 'alias.blb') },
    { path: 'RAW.BLB' },
  ]))), /duplicate/);
  await assert.rejects(inspectZip(file(zip([
    { nameBytes: Buffer.from([0x82, ...Buffer.from('/hd.blb')]), flags: 0 },
    { path: '\u00e9/hd.blb' },
  ]))), /duplicate/);
});

test('local filenames must match raw bytes even with matching Unicode aliases', async () => {
  const nameBytes = Buffer.from('raw/hd.blb');
  const localNameBytes = Buffer.from('different/hd.blb');
  const alias = 'alias/hd.blb';
  await assert.rejects(inspectZip(file(zip([{
    nameBytes, localNameBytes, flags: 0,
    extra: unicodePathExtra(nameBytes, alias),
    localExtra: unicodePathExtra(localNameBytes, alias),
  }]))), /local entry name disagrees/);
  // Normalized-equal strings are not raw-equal header names.
  await assert.rejects(inspectZip(file(zip([{ path: '\u00e9/hd.blb', localNameBytes: Buffer.from('e\u0301/hd.blb') }]))), /local entry name disagrees/);
  for (const extra of [undefined, unicodePathExtra(nameBytes, alias)]) {
    await assert.rejects(inspectZip(file(zip([{
      nameBytes, flags: 0, extra, localExtra: unicodePathExtra(nameBytes, 'other/hd.blb'),
    }]))), /local Unicode Path disagrees/);
  }
  await assert.rejects(inspectZip(file(zip([{ nameBytes, extra: unicodePathExtra(nameBytes, alias) }]))), /UTF-8 name and Unicode Path disagree/);
  await assert.rejects(inspectZip(file(zip([{
    nameBytes, flags: 0,
    extra: Buffer.concat([unicodePathExtra(nameBytes, alias), unicodePathExtra(nameBytes, 'other/hd.blb')]),
  }]))), /conflicting Unicode/);
});

test('nested stored/deflated resources and descriptors are inspected without whole-file reads', async () => {
  const fixture = zip([
    { path: 'release/DATA/hd.blb', method: 0 },
    { path: 'release/setup.exe', flags: 0x808 },
    { path: 'release/setup-1.bin' },
    { path: 'release/readme.txt' },
  ]);
  const source = file(fixture);
  source.arrayBuffer = () => { throw new Error('Whole-archive read forbidden'); };
  const plan = await inspectZip(source);
  assert.deepEqual(plan.entries.map(entry => entry.path), ['release/DATA/hd.blb', 'release/setup.exe', 'release/setup-1.bin']);
  assert.equal(plan.total, 39);
  assert.equal(plan.entries[0].method, 0);
});

test('path normalization rejects traversal, ambiguous separators, controls and absolute paths', () => {
  for (const path of ['../hd.blb', '/hd.blb', 'C:/hd.blb', 'a\\hd.blb', 'a//hd.blb', 'a/./hd.blb', 'a/../hd.blb', ' a/hd.blb', 'a/hd.blb ', 'a/\x00hd.blb', '/']) {
    assert.throws(() => normalizeZipPath(path), /unsafe/);
  }
  assert.equal(normalizeZipPath('nested/Game/HD.BLB'), 'nested/Game/HD.BLB');
  assert.equal(normalizeZipPath('nested/'), 'nested/');
  assert.equal(normalizeZipPath('e\u0301/hd.blb'), '\u00e9/hd.blb');
});

test('reject duplicate case/Unicode-normalized names and unsafe ignored entries', async () => {
  for (const paths of [['a/HD.BLB', 'a/hd.blb'], ['\u00e9/hd.blb', 'e\u0301/hd.blb'], ['safe.blb', '../ignored.txt']]) {
    await assert.rejects(inspectZip(file(zip(paths.map(path => ({ path }))))), /duplicate|unsafe/);
  }
});

test('reject encrypted, unsupported, symlink and misleading local headers', async () => {
  for (const item of [{ flags: 0x801 }, { method: 12 }, { attributes: 0xa1ff0000 }]) {
    await assert.rejects(inspectZip(file(zip([{ path: 'hd.blb', ...item }]))), /encrypted|supported|special/);
  }
  const mismatch = zip([{ path: 'hd.blb' }]);
  mismatch[30] = 120;
  await assert.rejects(inspectZip(file(mismatch)), /disagrees/);
  const mismatchSize = zip([{ path: 'hd.blb' }]);
  mismatchSize.writeUInt32LE(1, 22);
  await assert.rejects(inspectZip(file(mismatchSize)), /disagree/);
});

test('reject malformed archive framing, ZIP64, entry limits and overlapping payloads', async () => {
  const source = zip([{ path: 'hd.blb' }]);
  await assert.rejects(inspectZip(file(source.subarray(0, source.length - 1))), /record is missing/);
  for (const [position, value, width] of [[source.length - 12, 65535, 2], [source.length - 6, 0xffffffff, 4], [source.length - 12, 10001, 2]]) {
    const modified = Buffer.from(source);
    if (width === 2) {
      modified.writeUInt16LE(value, position);
      modified.writeUInt16LE(value, source.length - 14);
    } else modified.writeUInt32LE(value, position);
    await assert.rejects(inspectZip(file(modified)), /ZIP64|entry count/);
  }
  const overlap = zip([{ path: 'a.blb' }, { path: 'b.blb' }]);
  const directoryOffset = overlap.readUInt32LE(overlap.length - 6);
  overlap.writeUInt32LE(0, directoryOffset + 46 + 5 + 42);
  await assert.rejects(inspectZip(file(overlap)), /overlapping/);
});

test('enforce individual and aggregate output limits, input limit and bomb ratio', async () => {
  await assert.rejects(inspectZip({ size: ZIP_LIMITS.input + 1 }), /2 GiB/);
  for (const item of [{ path: 'hd.blb', size: ZIP_LIMITS.blb + 1 }, { path: 'setup.exe', size: ZIP_LIMITS.exe + 1 }, { path: 'setup.bin', size: ZIP_LIMITS.bin + 1 }]) {
    await assert.rejects(inspectZip(file(zip([item]))), /size limit/);
  }
  await assert.rejects(inspectZip(file(zip([{ path: 'hd.blb', size: 10 * 1024 ** 2 }]))), /compression ratio/);
  const bytes = randomBytes(2 * 1024 ** 2);
  await assert.rejects(inspectZip(file(zip([
    { path: 'setup-1.bin', size: ZIP_LIMITS.bin, bytes },
    { path: 'setup-2.bin', size: ZIP_LIMITS.bin, bytes },
  ]))), /selected output exceeds 2 GiB/);
  await assert.rejects(inspectZip(file(zip([{ path: 'notes.txt' }]))), /no BLB/);
});

test('CRC32 uses the ZIP polynomial and supports incremental updates', () => {
  const bytes = Buffer.from('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
  const partial = updateCRC32(0xffffffff, bytes.subarray(0, 3));
  assert.equal((updateCRC32(partial, bytes.subarray(3)) ^ 0xffffffff) >>> 0, 0xcbf43926);
});

test('vendored fflate matches recorded source provenance', async () => {
  const provenance = JSON.parse(await readFile(new URL('../vendor/fflate-provenance.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../vendor/fflate-0.8.2.js', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.browserSHA256);
  assert.equal(provenance.version, '0.8.2');
  assert.match(await readFile(new URL('../vendor/fflate-LICENSE', import.meta.url), 'utf8'), /MIT License/);
});

test('worker streams resources to synchronous disk handles and verifies CRC before completion', async () => {
  const previous = globalThis.self;
  const messages = [];
  const stored = new Map();
  globalThis.self = { postMessage: message => messages.push(message), close() {} };
  try {
    await import('../lib/zip-worker.js');
    const stage = {
      async getFileHandle(name) {
        const chunks = [];
        return { async createSyncAccessHandle() { return {
          truncate() {},
          write(bytes) { chunks.push(Buffer.from(bytes)); return bytes.length; },
          flush() { stored.set(name, Buffer.concat(chunks)); },
          close() {},
        }; } };
      },
    };
    const bytes = Buffer.from('some legitimate game file contents '.repeat(5000));
    const multipleChunks = randomBytes(100000);
    await self.onmessage({ data: { type: 'extract', file: file(zip([
      { path: 'nested/hd.blb', bytes },
      { path: 'nested/setup.bin', bytes: multipleChunks },
      { path: 'nested/setup.exe', method: 0, bytes: multipleChunks },
      { path: 'ignored.txt' },
    ])), stage } });
    assert.equal(messages.at(-1).type, 'done');
    assert.equal(messages.at(-1).files.length, 3);
    assert.deepEqual(stored.get('entry-0'), bytes);
    assert.deepEqual(stored.get('entry-1'), multipleChunks);
    assert.deepEqual(stored.get('entry-2'), multipleChunks);
    messages.length = 0;
    await self.onmessage({ data: { type: 'extract', file: file(zip([{ path: 'hd.blb', crc: 42 }])), stage } });
    assert.equal(messages.at(-1).type, 'error');
    assert.match(messages.at(-1).message, /CRC32/);
    assert.ok(!messages.some(message => message.type === 'done'));
    messages.length = 0;
    await self.onmessage({ data: { type: 'extract', file: file(zip([{ path: 'hd.blb', size: 1 }])), stage } });
    assert.equal(messages.at(-1).type, 'error');
    assert.match(messages.at(-1).message, /declared size/);
  } finally { globalThis.self = previous; }
});
