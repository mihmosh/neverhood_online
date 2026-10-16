import assert from 'node:assert/strict';
import test from 'node:test';
import { bufferWorkerReads } from '../lib/worker-file-cache.js';

test('worker reads use bounded pages, support seeks and never load the full input', () => {
  const filesystem = { stream_ops: {} };
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const stream = { node: { id: 1, size: bytes.length, contents: bytes } };
  const reads = [];
  bufferWorkerReads(filesystem, slice => { reads.push(slice.length); return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length); }, 16, 2);
  const result = new Uint8Array(20);
  for (let i = 0; i < 12; i++) assert.equal(filesystem.stream_ops.read(stream, result, 0, 1, i), 1);
  assert.equal(reads.length, 1);
  filesystem.stream_ops.read(stream, result, 0, 20, 10);
  assert.deepEqual(result, bytes.slice(10, 30));
  assert.equal(reads.length, 2);
  assert.equal(filesystem.stream_ops.read(stream, result, 0, 20, 95), 5);
  assert.deepEqual(result.slice(0, 5), bytes.slice(95));
  assert.equal(filesystem.stream_ops.read(stream, result, 0, 20, 100), 0);
  filesystem.stream_ops.read(stream, result, 0, 1, 1);
  assert.equal(reads.length, 5, 'old pages are evicted');
  assert.ok(reads.every(size => size <= 16));
});
