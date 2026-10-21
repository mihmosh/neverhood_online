import assert from 'node:assert/strict';
import test from 'node:test';
import { demandWindow } from '../web/lib/original-streaming-demand.js';

test('Scene2803 radio misses select complete physical tracks rather than one 64 KiB block', () => {
  const file = { bytes: 50571893, hashes: Array(Math.ceil(50571893 / 65536)), resources: [
    { hash: '82b22000', offset: 25363504, bytes: 1669120, compression: 0 },
    { hash: '02b22001', offset: 27032624, bytes: 1027073, compression: 0 },
  ] };
  const index = { blockSize: 65536, files: { 'a.blb': file } };
  const first = demandWindow(index, 'a.blb', 412, { position: 27001000, length: 1024 });
  assert.equal(first.first, Math.floor(25363504 / 65536));
  assert.equal(first.last, Math.floor((25363504 + 1669120 + 4095) / 65536));
  const second = demandWindow(index, 'a.blb', 413, { position: 27067000, length: 1024 });
  assert.equal(second.first, 412);
  assert.equal(second.last, Math.floor((27032624 + 1027073 + 4095) / 65536));
});

test('demand expansion is non-recursive and ignores aliases and unrelated adjacent resources', () => {
  const index = { blockSize: 64, files: { 'i.blb': { bytes: 1024, hashes: Array(16), resources: [
    { offset: 130, bytes: 20, compression: 0 },
    { offset: 160, bytes: 700, compression: 0x65 },
  ] } } };
  const result = demandWindow(index, 'i.blb', 2, { position: 130, length: 10 });
  assert.equal(result.first, 2);
  assert.equal(result.last, 15, 'read-ahead is clipped to the physical file');
  const bounded = demandWindow(index, 'i.blb', 2, { position: 130, length: 10 }, 128);
  assert.deepEqual(bounded, { name: 'i.blb', first: 2, last: 3 });
});

test('unclassified physical gaps use a small forward window, never an entire BLB', () => {
  const index = { blockSize: 65536, files: { 'i.blb': { bytes: 65536 * 1000, hashes: Array(1000), resources: [] } } };
  assert.deepEqual(demandWindow(index, 'i.blb', 100, { position: 6553600, length: 1024 }), { name: 'i.blb', first: 100, last: 107 });
});
