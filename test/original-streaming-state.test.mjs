import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeRoomReader } from '../web/lib/original-streaming-state.js';
import { STOCK_RUNTIME_SHA256 } from '../web/lib/original-streaming-fs.js';

function fixture() {
  const heap = new Uint8Array(2048), view = new DataView(heap.buffer), records = {};
  const define = (name, size, fields) => { records[`Neverhood::${name}`] = { size, fields: Object.fromEntries(Object.entries(fields).map(([name, offset]) => [name, { offset }])) }; };
  define('NeverhoodEngine', 128, { _gameModule: 4, _screen: 8, _gameState: 12 });
  define('GameModule', 128, { _moduleNum: 12, _prevChildObject: 16, _restoreGameRequested: 20, _restartGameRequested: 21, _mainMenuRequested: 22 });
  define('Module', 32, { _childObject: 4, _sceneType: 8 });
  define('GameState', 8, { sceneNum: 0, which: 4 });
  define('Screen', 32, { _smackerDecoder: 4, _ticks: 8 });
  const abi = { wasmSHA256: STOCK_RUNTIME_SHA256, pointerSize: 4, records };
  const module = { _g_engine: 4, renderPrototypeWasmSHA256: STOCK_RUNTIME_SHA256 };
  const put = (offset, value) => view.setUint32(offset, value, true);
  put(4, 128); put(132, 512); put(136, 768); put(140, 0); put(144, 3);
  put(516, 1024); put(524, 2300); put(1032, 1); put(772, 1200); put(776, 44);
  return { heap, put, abi, module, reader: createNativeRoomReader(module, abi, () => heap) };
}

test('native observer reads common GameState and Module base for navigation without casting Module1000', () => {
  const { reader } = fixture();
  assert.deepEqual(reader(), { id: '2300:0', module: 2300, scene: 0, which: 3, menu: false, sceneType: 1, smacker: true, tick: 44 });
});

test('native menu/pending restore is identified without interpreting menu as a room', () => {
  for (const offset of [528, 532, 533, 534]) {
    const { reader, heap, put } = fixture();
    if (offset === 528) put(offset, 1200); else heap[offset] = 1;
    assert.equal(reader().menu, true);
  }
});

test('observer rejects unpinned layouts, missing pointers and impossible heap/state bounds', () => {
  const { module, abi, heap } = fixture();
  assert.throws(() => createNativeRoomReader(module, { ...abi, wasmSHA256: '0'.repeat(64) }), /mismatch/);
  assert.throws(() => createNativeRoomReader(module, { ...abi, pointerSize: 8 }), /mismatch/);
  for (const [offset, value] of [[4, 0], [132, 2047], [516, 2047], [524, 2301], [140, 100000]]) {
    const changed = heap.slice(); new DataView(changed.buffer).setUint32(offset, value, true);
    assert.equal(createNativeRoomReader(module, abi, () => changed)(), null);
  }
});
