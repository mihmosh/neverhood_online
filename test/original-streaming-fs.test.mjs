import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { ORIGINAL_BLOCK_BYTES, STOCK_RUNTIME_SHA256, validateOriginalIndex, installOriginalFiles, waitForOriginalBlock, originalFontBlocks } from '../web/lib/original-streaming-fs.js';

function fixture() {
  const index = { version: 1, runtimeSHA256: STOCK_RUNTIME_SHA256, blockSize: ORIGINAL_BLOCK_BYTES,
    files: {}, bootstrap: [{ name: 'i.blb', index: 0 }], common: [], rooms: { '1000:0': { blocks: [], neighbors: [] } } };
  const source = new Map(), nodes = new Map();
  for (const [ordinal, name] of REQUIRED_FILES.entries()) {
    const bytes = Uint8Array.from({ length: ORIGINAL_BLOCK_BYTES * 3 + 43 }, (_, i) => (i * 31 + (i >>> 8) + ordinal) & 255);
    index.files[name] = { bytes: bytes.length, sha256: '1'.repeat(64), url: `/original/${name}`, hashes: Array(4).fill('2'.repeat(64)) };
    source.set(name, bytes);
  }
  class ErrnoError extends Error { constructor(errno) { super(String(errno)); this.errno = errno; this.name = 'ErrnoError'; } }
  const shared = { read: 'unmodified' }, FS = { ErrnoError, mkdirTree() {}, create(path, mode) {
    const node = { stream_ops: shared, node_ops: { getattr() {} }, contents: null, mode };
    nodes.set(path, node); return node;
  } };
  const block = (name, number) => source.get(name).slice(number * ORIGINAL_BLOCK_BYTES, (number + 1) * ORIGINAL_BLOCK_BYTES);
  return { index, source, nodes, FS, block, shared };
}

test('synchronous original reads stop waiting even when the worker never responds', () => {
  const header = new Int32Array(new SharedArrayBuffer(32));
  let clock = 0;
  assert.throws(() => waitForOriginalBlock(header, 3, () => ++clock), /timed out/);
  assert.equal(clock, 3);
  clock = 0;
  assert.equal(waitForOriginalBlock(header, 3, () => {
    if (++clock === 2) Atomics.store(header, 0, 1);
    return clock;
  }), 1);
  Atomics.store(header, 0, -1);
  assert.equal(waitForOriginalBlock(header, 3, () => { throw new Error('must not wait'); }), -1);
});

test('published indexes prepare the named note font metadata including native read-ahead', () => {
  const { index } = fixture();
  assert.deepEqual(originalFontBlocks(index), []);
  index.files['i.blb'].resources = [
    { hash: '0002486a', offset: ORIGINAL_BLOCK_BYTES * 2 - 1000, bytes: 582 },
    { hash: '12345678', offset: 0, bytes: 100 },
  ];
  assert.deepEqual(originalFontBlocks(index), [{ name: 'i.blb', index: 1 }, { name: 'i.blb', index: 2 }]);
  index.files['i.blb'].resources[0].bytes = index.files['i.blb'].bytes;
  assert.throws(() => originalFontBlocks(index), /font metadata/);
});

test('original streaming index binds all seven real-size files and references to one release origin', () => {
  const { index } = fixture();
  const files = Object.entries(index.files).map(([name, file]) => ({ name, bytes: file.bytes, sha256: file.sha256 }));
  assert.equal(validateOriginalIndex(index, 'http://localhost:4205/index.json', files), index);
  for (const mutate of [i => { i.files['i.blb'].url = 'https://elsewhere.test/i.blb'; },
    i => { i.files['i.blb'].bytes++; }, i => { i.runtimeSHA256 = '0'.repeat(64); },
    i => { i.bootstrap[0].index = 4; }, i => { i.rooms['1000:0'].neighbors.push('1000:1'); },
    i => { i.files['i.blb'].hashes.pop(); }, i => { i.files['a.blb'].hashes[0] = 'bad'; }]) {
    const invalid = structuredClone(index); mutate(invalid);
    assert.throws(() => validateOriginalIndex(invalid, 'http://localhost:4205/index.json', files));
  }
});

test('sparse files have exact size, no backing allocation, private operations and exact arbitrary ranges', () => {
  const { index, source, nodes, FS, block, shared } = fixture();
  const trace = [];
  installOriginalFiles(FS, index, block, { onRead: read => trace.push(read) });
  assert.equal(nodes.size, 7); assert.equal(shared.read, 'unmodified');
  let seed = 173;
  for (const name of REQUIRED_FILES) {
    const node = nodes.get(`/game/${name}`), bytes = source.get(name);
    assert.equal(node.usedBytes, bytes.length); assert.equal(node.contents, null);
    assert.notEqual(node.stream_ops, shared);
    for (let i = 0; i < 100; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const position = seed % (bytes.length + 100), count = Math.min(100000, seed >>> 13), out = new Uint8Array(count + 6).fill(254);
      const read = node.stream_ops.read({ position: 19 }, out, 3, count, position);
      const expected = bytes.slice(position, position + count);
      assert.equal(read, expected.length);
      assert.deepEqual(out.slice(3, 3 + read), expected);
      assert.deepEqual(out.slice(0, 3), new Uint8Array(3).fill(254));
      assert.equal(out[3 + read], 254);
    }
  }
  assert.equal(trace.length, 700);
});

test('seek is per descriptor, allows beyond EOF, rejects negative/invalid positions and preserves read-only files', () => {
  const { index, nodes, FS, block } = fixture(); installOriginalFiles(FS, index, block);
  const node = nodes.get('/game/i.blb'), { llseek, read } = node.stream_ops;
  assert.equal(llseek({ position: 19 }, 4, 1), 23);
  assert.equal(llseek({ position: 100 }, 4, 1), 104);
  assert.equal(llseek({ position: 19 }, -3, 2), node.usedBytes - 3);
  const bytes = new Uint8Array(10);
  assert.equal(read({}, bytes, 0, 10, node.usedBytes - 3), 3);
  assert.equal(read({}, bytes, 0, 10, node.usedBytes), 0);
  assert.equal(read({}, bytes, 0, 10, node.usedBytes + 100), 0);
  assert.throws(() => llseek({}, -1, 0)); assert.throws(() => llseek({}, 0, 3));
  assert.throws(() => node.node_ops.setattr(node, { size: 1 })); assert.throws(() => node.stream_ops.write());
});

test('missing or truncated second block changes neither destination bytes nor native descriptor position', () => {
  for (const truncated of [false, true]) {
    const { index, nodes, FS, block } = fixture();
    installOriginalFiles(FS, index, (name, number) => {
      if (number === 1) { if (truncated) return new Uint8Array(4); throw new Error('not ready'); }
      return block(name, number);
    });
    const destination = new Uint8Array(100).fill(219), stream = { position: ORIGINAL_BLOCK_BYTES - 20 };
    assert.throws(() => nodes.get('/game/i.blb').stream_ops.read(stream, destination, 0, 100, stream.position), /not ready|Truncated/);
    assert(destination.every(value => value === 219)); assert.equal(stream.position, ORIGINAL_BLOCK_BYTES - 20);
  }
});
