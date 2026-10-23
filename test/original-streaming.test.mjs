import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createOriginalStreaming } from '../web/lib/original-streaming.js';
import { ORIGINAL_BLOCK_BYTES, STOCK_RUNTIME_SHA256 } from '../web/lib/original-streaming-fs.js';
import { REQUIRED_FILES } from '../web/lib/validation.js';

async function session(t) {
  const abi = JSON.parse(await readFile(new URL('../web/prototype/render-abi.json', import.meta.url)));
  const files = Object.fromEntries(REQUIRED_FILES.map(name => [name, {
    bytes: ORIGINAL_BLOCK_BYTES * 2, sha256: '1'.repeat(64), hashes: ['2'.repeat(64), '3'.repeat(64)], url: name,
  }]));
  const index = { version: 1, runtimeSHA256: STOCK_RUNTIME_SHA256, blockSize: ORIGINAL_BLOCK_BYTES,
    files, bootstrap: [], rooms: {
      '1000:0': { blocks: [], neighbors: [] },
      '1000:4': { blocks: [{ name: 'a.blb', index: 0 }, { name: 'a.blb', index: 1 }], neighbors: [] },
    } };
  const bytes = new TextEncoder().encode(JSON.stringify(index)), nodes = new Map();
  let worker, fatal;
  class ByteWorker {
    constructor() { worker = this; }
    postMessage(message) {
      if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, ready: true } }));
    }
    terminate() { this.terminated = true; }
  }
  const canvas = { style: {}, setAttribute() {}, transferControlToOffscreen() { return {}; }, remove() {} };
  const globals = {
    crossOriginIsolated: true, Worker: ByteWorker, OffscreenCanvas: class {},
    HTMLCanvasElement: class { transferControlToOffscreen() {} },
    document: { createElement: () => canvas, body: { append() {} } }, innerWidth: 640, innerHeight: 480,
    addEventListener() {}, removeEventListener() {}, HEAPU8: new Uint8Array(64),
    abort(message) { throw new Error(message); },
    fetch: async url => String(url).endsWith('render-abi.json') ? Response.json(abi) : new Response(bytes),
  };
  const descriptors = Object.fromEntries(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let streaming;
  t.after(() => {
    streaming?.dispose();
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const module = { renderPrototypeWasmSHA256: STOCK_RUNTIME_SHA256, pauseMainLoop() {},
    FS: { mkdirTree() {}, create(path) {
      const node = { stream_ops: {}, node_ops: {} }; nodes.set(path, node); return node;
    } } };
  streaming = await createOriginalStreaming({ module, memoryBytes: ORIGINAL_BLOCK_BYTES,
    manifest: { manifestURL: 'https://release.test/manifest.json', streaming: {
      version: 1, index: { file: 'index.json', bytes: bytes.length },
    } }, onFatal(error) { fatal = error; } });
  return { streaming, nodes, worker, fatal: () => fatal };
}

test('room preparation releases the input gate after a rejected budget check', async t => {
  const { streaming } = await session(t);
  await assert.rejects(streaming.setRoom('1000:4'), /memory budget/);
  assert.equal(streaming.stats().preparing, false);
});

test('a dead byte worker terminates the native read without changing its destination', async t => {
  const { streaming, nodes, worker, fatal } = await session(t);
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 10000));
  const destination = new Uint8Array(4).fill(91);
  assert.throws(() => nodes.get('/game/a.blb').stream_ops.read({}, destination, 0, 4, 0), /timed out/);
  assert.deepEqual(destination, new Uint8Array(4).fill(91));
  assert.equal(streaming.stats().terminal, true);
  assert.equal(worker.terminated, true);
  assert.match(fatal().message, /a.blb, block 1/);
});

test('worker errors reach the fatal handler with an unshared TextDecoder input', async t => {
  const { streaming, nodes, worker, fatal } = await session(t);
  const Decoder = globalThis.TextDecoder;
  t.mock.method(globalThis, 'TextDecoder', class extends Decoder {
    decode(bytes, options) {
      assert(!(bytes.buffer instanceof SharedArrayBuffer), 'Chrome rejects shared TextDecoder input');
      return super.decode(bytes, options);
    }
  });
  worker.postMessage = message => {
    if (message.type !== 'read') return;
    const bytes = new TextEncoder().encode('HTTP 503 missing original block');
    const header = new Int32Array(message.sab, 0, 8);
    new Uint8Array(message.sab, 32).set(bytes);
    header[1] = bytes.length; Atomics.store(header, 0, -1);
  };
  assert.throws(() => nodes.get('/game/i.blb').stream_ops.read({}, new Uint8Array(4), 0, 4, 0), /HTTP 503/);
  assert.equal(streaming.stats().terminal, true);
  assert.equal(worker.terminated, true);
  assert.match(fatal().message, /HTTP 503/);
});
