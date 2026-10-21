import { STOCK_RUNTIME_SHA256 } from './original-streaming-fs.js';

export function createNativeRoomReader(module, abi, heap = () => globalThis.HEAPU8) {
  if (abi.wasmSHA256 !== STOCK_RUNTIME_SHA256 || module.renderPrototypeWasmSHA256 !== STOCK_RUNTIME_SHA256 || abi.pointerSize !== 4) throw new Error('Native room observer ABI mismatch.');
  const record = name => {
    const source = abi.records[`Neverhood::${name}`];
    if (!source || !Number.isSafeInteger(source.size) || source.size < 1) throw new Error('Missing native room ABI record.');
    return { size: source.size, fields: Object.fromEntries(Object.entries(source.fields).map(([name, field]) => {
      if (!Number.isSafeInteger(field.offset) || field.offset < 0 || field.offset >= source.size) throw new Error('Invalid native room ABI offset.');
      return [name, field.offset];
    })) };
  };
  const engineLayout = record('NeverhoodEngine'), gameLayout = record('GameModule'), moduleLayout = record('Module');
  const stateLayout = record('GameState'), screenLayout = record('Screen');
  return () => {
    const bytes = heap();
    if (!bytes || !Number.isSafeInteger(module._g_engine)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const range = (pointer, size) => {
      if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + size > view.byteLength) throw new RangeError('Native room pointer out of heap.');
    };
    const uint = pointer => { range(pointer, 4); return view.getUint32(pointer, true); };
    const byte = pointer => { range(pointer, 1); return view.getUint8(pointer); };
    try {
      const engine = uint(module._g_engine);
      if (!engine) return null;
      range(engine, engineLayout.size);
      const game = uint(engine + engineLayout.fields._gameModule), screen = uint(engine + engineLayout.fields._screen);
      if (!game || !screen) return null;
      range(game, gameLayout.size); range(screen, screenLayout.size);
      const number = uint(game + gameLayout.fields._moduleNum);
      if (number < 1000 || number > 3000 || number % 100 !== 0) return null;
      const child = uint(game + moduleLayout.fields._childObject);
      if (!child) return null;
      range(child, moduleLayout.size);
      const state = engine + engineLayout.fields._gameState;
      range(state, stateLayout.size);
      const scene = uint(state + stateLayout.fields.sceneNum);
      if (scene > 1024) return null;
      const menu = Boolean(uint(game + gameLayout.fields._prevChildObject) || byte(game + gameLayout.fields._restoreGameRequested) ||
        byte(game + gameLayout.fields._restartGameRequested) || byte(game + gameLayout.fields._mainMenuRequested));
      return { id: `${number}:${scene}`, module: number, scene, which: view.getInt32(state + stateLayout.fields.which, true), menu,
        sceneType: uint(child + moduleLayout.fields._sceneType), smacker: Boolean(uint(screen + screenLayout.fields._smackerDecoder)),
        tick: uint(screen + screenLayout.fields._ticks) };
    } catch (error) {
      if (error instanceof RangeError) return null;
      throw error;
    }
  };
}
