import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_FILES, ENGLISH_HD_SIZE, selectArchives, validateHeader, validateArchives, formatBytes, editionWarning } from '../lib/validation.js';

function header(size = 40, count = 1) {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x02004940, true);
  view.setUint16(4, 7, true);
  view.setUint32(8, size, true);
  view.setUint32(12, count, true);
  return data;
}

test('requires exactly seven unique archives, case insensitive', () => {
  const files = REQUIRED_FILES.map(name => ({ name: name.toUpperCase() }));
  assert.deepEqual(selectArchives(files).errors, []);
  assert.equal(selectArchives([...files, { name: 'a.blb' }]).errors.length, 1);
  assert.match(selectArchives(files.slice(1)).errors.join(''), /a.blb/);
  assert.match(selectArchives([...files, { name: 'setup.exe' }]).errors.join(''), /Unexpected/);
});

test('rejects trivial corruption, truncated tables and size mismatch', () => {
  assert.doesNotThrow(() => validateHeader(header(), 40, 'a.blb'));
  assert.throws(() => validateHeader(new Uint8Array(4), 4, 'a.blb'), /too short/);
  assert.throws(() => validateHeader(new Uint8Array(16), 40, 'a.blb'), /signature/);
  assert.throws(() => validateHeader(header(), 41, 'a.blb'), /size/);
  assert.throws(() => validateHeader(header(40, 2), 40, 'a.blb'), /table/);
  assert.throws(() => validateHeader(header(40, 0), 40, 'a.blb'), /table/);
});

test('validation reads only 16 bytes, warns about unknown edition', async () => {
  let reads = 0;
  const files = REQUIRED_FILES.map(name => ({
    name, size: 40,
    arrayBuffer() { throw new Error('Must not read entire archive'); },
    slice(start, end) {
      assert.equal(start, 0);
      assert.equal(end, 16);
      reads++;
      return new Blob([header()]);
    },
  }));
  const result = await validateArchives(files);
  assert.equal(reads, 7);
  assert.equal(result.total, 280);
  assert.match(result.warning, /compatibility is unconfirmed/);
});

test('formats unavailable quota honestly', () => {
  assert.equal(formatBytes(undefined), 'unknown');
  assert.match(formatBytes(1048576), /1 MiB/);
});

test('edition warnings are English and derived from the saved archive size', () => {
  assert.match(editionWarning(ENGLISH_HD_SIZE), /matches the known English edition/);
  assert.match(editionWarning(40), /compatibility is unconfirmed/);
});
