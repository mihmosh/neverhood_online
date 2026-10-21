import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RenderFrameReader } from '../web/prototype/read-frame.js';
import { composeIndexed } from '../web/prototype/compositor.js';
import { createRoomPrototype } from '../web/prototype/room1.js';

const abi = JSON.parse(await readFile(new URL('../web/prototype/render-abi.json', import.meta.url), 'utf8'));

function fixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'HEAPU8');
  const heap = new Uint8Array(2 * 1024 ** 2);
  Object.defineProperty(globalThis, 'HEAPU8', { configurable: true, value: heap });
  t.after(() => previous ? Object.defineProperty(globalThis, 'HEAPU8', previous) : delete globalThis.HEAPU8);
  const reader = new RenderFrameReader({ _g_engine: 100 }, abi);
  const data = new DataView(heap.buffer);
  const u32 = (address, value) => data.setUint32(address, value, true);
  const i16 = (address, value) => data.setInt16(address, value, true);
  const p = { engine: 2000, screen: 12000, game: 13000, room: 14000, scene: 15000, pending: 16000, previous: 16020, storage: 17000, source: 18000, back: 19000, mouse: 1100000, base: 1101000, cursor: 1102000, cursorPixels: 1103000 };
  const l = reader.layout;
  u32(100, p.engine);
  u32(p.engine + l.engine._screen, p.screen);
  u32(p.engine + l.engine._gameModule, p.game);
  u32(p.game + l.game._moduleNum, 1000);
  u32(p.game + l.module._childObject, p.room);
  u32(p.room + l.module._childObject, p.scene);
  u32(p.screen + l.screen._prevRenderQueue, p.previous);
  u32(p.screen + l.screen._renderQueue, p.pending);
  u32(p.previous + l.array._size, 1);
  u32(p.previous + l.array._capacity, 1);
  u32(p.previous + l.array._storage, p.storage);
  u32(p.storage + l.item._surface, p.source);
  i16(p.storage + l.item._width, 640);
  i16(p.storage + l.item._height, 480);
  for (const [surface, pixels] of [[p.source, 20000], [p.back, 700000]]) {
    i16(surface + l.surface.w, 640);
    i16(surface + l.surface.h, 480);
    u32(surface + l.surface.pitch, 640);
    u32(surface + l.surface.pixels, pixels);
    heap[surface + l.surface.bytesPerPixel] = 1;
    heap.fill(42, pixels, pixels + 640 * 480);
  }
  u32(p.screen + l.screen._backScreen, p.back);
  u32(p.screen + l.screen._paletteData, 400000);
  u32(p.scene + l.scene._mouseCursor, p.mouse);
  u32(p.mouse + l.sprite._surface + l.shared._pointer, p.base);
  u32(p.base + l.baseSurface._surface, p.cursor);
  heap[p.base + l.baseSurface._visible] = 1;
  i16(p.cursor + l.surface.w, 32);
  i16(p.cursor + l.surface.h, 32);
  u32(p.cursor + l.surface.pitch, 32);
  u32(p.cursor + l.surface.pixels, p.cursorPixels);
  heap[p.cursor + l.surface.bytesPerPixel] = 1;
  heap[p.cursorPixels + 1] = 12;
  i16(p.engine + l.engine._mouseX, 100);
  i16(p.engine + l.engine._mouseY, 200);
  i16(p.mouse + l.sprite._drawOffset + l.rect.x, -8);
  i16(p.mouse + l.sprite._drawOffset + l.rect.y, -3);
  return { reader, heap, l, p, u32, i16 };
}

test('compiled-layout reader reconstructs a bounded completed frame without writing the heap', t => {
  const { reader, heap } = fixture(t);
  const before = Uint8Array.from(heap);
  const frame = reader.read();
  assert.equal(frame.available, true);
  assert.equal(frame.room, 'Scene1001');
  assert.equal(frame.items.length, 1);
  assert.deepEqual(composeIndexed(frame.items), frame.reference);
  assert.deepEqual(heap, before);
});

test('normal HD reads skip reference allocation but retain all surface bounds checks', t => {
  const { reader, heap, l, p, u32 } = fixture(t);
  const frame = reader.read({ reference: false });
  assert.equal(frame.available, true);
  assert.equal(frame.reference, undefined);
  assert.equal(frame.items[0].source.pixels.length, 640 * 480);
  u32(p.back + l.surface.pixels, heap.length - 4);
  assert.throws(() => reader.read({ reference: false }), /heap range/);
});

test('all-room reading uses Module base fields without reading another subclass as Module1000', t => {
  const { heap, p, l, u32 } = fixture(t), before = heap.slice();
  u32(p.game + l.game._moduleNum, 3000);
  u32(p.room + l.roomModule._sceneNum, 0xffffffff);
  const expected = heap.slice();
  const reader = new RenderFrameReader({ _g_engine: 100 }, abi, { allRooms: true });
  const frame = reader.read();
  assert.equal(frame.available, true);
  assert.equal(frame.room, 'Module3000');
  assert.deepEqual(composeIndexed(frame.items), frame.reference);
  assert.deepEqual(heap, expected);
  assert.notDeepEqual(heap, before);
  u32(p.scene + l.scene._mouseCursor, 0);
  assert.equal(reader.read().available, true);
  assert.equal(reader.read().cursor, undefined);
  u32(p.room + l.module._sceneType, 2);
  assert.equal(reader.read().available, false);
  u32(p.room + l.module._sceneType, 0);
  for (const module of [999, 1001, 3100, 0xffffffff]) {
    u32(p.game + l.game._moduleNum, module);
    assert.equal(reader.read().available, false);
  }
});

test('native cursor preserves indexed frames, engine position, negative-offset hotspot and visibility outside scene parity', t => {
  const { reader, heap, l, p, i16 } = fixture(t);
  const frame = reader.read();
  assert.deepEqual([frame.cursor.x, frame.cursor.y, frame.cursor.hotspotX, frame.cursor.hotspotY, frame.cursor.visible], [100, 200, 8, 3, true]);
  assert.equal(frame.cursor.source.pixels[1], 12);
  assert.deepEqual(composeIndexed(frame.items), frame.reference);
  i16(p.engine + l.engine._mouseX, 0);
  i16(p.engine + l.engine._mouseY, 479);
  heap[p.base + l.baseSurface._visible] = 0;
  heap[p.cursorPixels + 1] = 14;
  const changed = reader.read();
  assert.equal(changed.cursor.x, 0);
  assert.equal(changed.cursor.y, 479);
  assert.equal(changed.cursor.visible, false);
  assert.equal(changed.cursor.source.pixels[1], 14);
  assert.deepEqual(changed.reference, frame.reference);
});

test('missing or invalid cursor fails closed rather than allowing a cursorless proxy', t => {
  const { reader, heap, l, p, u32, i16 } = fixture(t);
  u32(p.scene + l.scene._mouseCursor, 0);
  assert.equal(reader.read().available, false);
  u32(p.scene + l.scene._mouseCursor, p.mouse);
  u32(p.mouse + l.sprite._surface + l.shared._pointer, heap.length - 4);
  assert.throws(() => reader.read(), /heap range/);
  u32(p.mouse + l.sprite._surface + l.shared._pointer, p.base);
  i16(p.cursor + l.surface.w, 31);
  assert.throws(() => reader.read(), /cursor dimensions/);
  i16(p.cursor + l.surface.w, 32);
  i16(p.mouse + l.sprite._drawOffset + l.rect.x, -32768);
  assert.throws(() => reader.read(), /cursor hotspot/);
});

test('room adapter falls back for menus, other scenes, video and pending queues', t => {
  const { reader, l, p, u32 } = fixture(t);
  for (const [address, value] of [[p.game + l.game._moduleNum, 1500], [p.game + l.game._prevChildObject, 12], [p.room + l.roomModule._sceneNum, 2], [p.screen + l.screen._smackerDecoder, 12], [p.pending + l.array._size, 1]]) {
    const old = new DataView(globalThis.HEAPU8.buffer).getUint32(address, true);
    u32(address, value);
    assert.equal(reader.read().available, false);
    u32(address, old);
  }
});

test('logical-size rendering stays stable across full refresh but not menus or other rooms', t => {
  const { reader, l, p, heap, u32 } = fixture(t);
  assert.equal(reader.read().available, true);
  assert.equal(reader.inRoom, true);
  heap[p.screen + l.screen._fullRefresh] = 1;
  assert.equal(reader.read().available, false);
  assert.equal(reader.inRoom, true, 'a resize refresh must not oscillate the native window size');
  heap[p.screen + l.screen._fullRefresh] = 0;
  heap[p.game + l.game._mainMenuRequested] = 1;
  assert.equal(reader.read().available, false);
  assert.equal(reader.inRoom, false);
  heap[p.game + l.game._mainMenuRequested] = 0;
  u32(p.room + l.roomModule._sceneNum, 2);
  assert.equal(reader.read().available, false);
  assert.equal(reader.inRoom, false);
});

test('second room uses the same bounded indexed reader and keeps room identity during resize', t => {
  const { reader, heap, l, p, u32, i16 } = fixture(t);
  u32(p.room + l.roomModule._sceneNum, 1);
  const before = Uint8Array.from(heap);
  const frame = reader.read();
  assert.equal(frame.room, 'Scene1002');
  assert.equal(frame.available, true);
  assert.equal(reader.inRoom, true);
  assert.deepEqual(composeIndexed(frame.items), frame.reference);
  assert.deepEqual(heap, before);
  heap[p.screen + l.screen._fullRefresh] = 1;
  assert.equal(reader.read().room, 'Scene1002');
  assert.equal(reader.inRoom, true);
  heap[p.screen + l.screen._fullRefresh] = 0;
  i16(p.storage + l.item._srcX, 1);
  assert.throws(() => reader.read(), /source rectangle/);
  i16(p.storage + l.item._srcX, 0);
  u32(p.previous + l.array._size, 513);
  assert.throws(() => reader.read(), /queue bounds/);
  u32(p.previous + l.array._size, 1);
  for (const index of [2, 3, 0xffffffff]) {
    u32(p.room + l.roomModule._sceneNum, index);
    assert.equal(reader.read().available, false);
    assert.equal(reader.inRoom, false);
    assert.equal(reader.room, undefined);
  }
  u32(p.room + l.roomModule._sceneNum, 0);
  assert.equal(reader.read().room, 'Scene1001');
});

test('heap ranges, queue bounds, pixel formats and cropped source rectangles fail closed', t => {
  const { reader, heap, l, p, u32, i16 } = fixture(t);
  u32(p.previous + l.array._size, 513);
  assert.throws(() => reader.read(), /queue bounds/);
  u32(p.previous + l.array._size, 1);
  heap[p.source + l.surface.bytesPerPixel] = 4;
  assert.throws(() => reader.read(), /indexed surfaces/);
  heap[p.source + l.surface.bytesPerPixel] = 1;
  u32(p.source + l.surface.pixels, heap.length - 10);
  assert.throws(() => reader.read(), /heap range/);
  u32(p.source + l.surface.pixels, 20000);
  i16(p.storage + l.item._srcX, 2);
  assert.throws(() => reader.read(), /source rectangle/);
  assert.throws(() => new RenderFrameReader({}, { ...abi, pointerSize: 8 }), /Unsupported/);
});

test('automatic room packs survive navigation, preserve Original selection and reject stale installation', async t => {
  const { l, p, u32 } = fixture(t);
  const nodes = new Map(), callbacks = [];
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.listeners = new Map(); this.options = []; this.value = ''; this.hidden = false; }
    setAttribute() {}
    set innerHTML(html) {
      for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = new Element(match[1]); nodes.set(match[2], node);
        if (match[1] === 'select') {
          const content = html.slice(match.index + match[0].length).split('</select>')[0];
          node.options = [...content.matchAll(/<option value="([^"]+)"/g)].map(value => ({ value: value[1] }));
          node.value = node.options[0]?.value ?? '';
        }
      }
    }
    querySelector(selector) { return nodes.get(selector.slice(1)); }
    querySelectorAll(selector) { return selector === 'select' ? [...nodes.values()].filter(node => node.tag === 'select') : []; }
    append() {}
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener() {}
    remove() {}
    matches() { return false; }
    focus() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; }
    getContext() { return { canvas: this, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      save() {}, restore() {}, setTransform() {}, fillRect() {}, drawImage() {}, putImageData() {} }; }
  }
  const globals = { document: { createElement: tag => new Element(tag), body: new Element('body'), hasFocus: () => true },
    window: { addEventListener() {}, removeEventListener() {} },
    location: { href: 'http://127.0.0.1:4173/', origin: 'http://127.0.0.1:4173', hostname: '127.0.0.1' },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: fn => { callbacks.push(fn); return callbacks.length; }, cancelAnimationFrame() {} };
  let renderer;
  t.after(() => renderer?.dispose());
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const requests = [], waiting = [];
  const manifest = room => ({ version: 1, private: true, scale: 4, runtimeSHA256: abi.wasmSHA256,
    sourceBinding: 'unit-test', room, entries: [], backgrounds: [{ id: 'gemini', label: 'Gemini',
      key: `640x480-640-${room === 'Scene1001' ? '11111111' : '22222222'}-p12345678-opaque`,
      file: 'gemini.png', sha256: 'a'.repeat(64), width: 2560, height: 1920, scale: 4 }] });
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/render-abi.json')) return { ok: true, json: async () => abi };
    requests.push(String(url));
    if (String(url).includes('/room2/')) return new Promise(resolve => waiting.push(() => resolve(new Response(JSON.stringify(manifest('Scene1002'))))));
    return new Response(JSON.stringify(manifest('Scene1001')));
  });
  renderer = await createRoomPrototype({ module: { _g_engine: 100 }, canvas: new Element('canvas'), wasmSHA256: abi.wasmSHA256 });
  const api = window.roomRendererPrototype;
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  await flush();
  assert.equal(api.stats().pack.room, 'Scene1001');
  assert.equal(api.stats().pack.selectedBackground, 'gemini');
  api.selectPackBackground('original');
  callbacks.shift()();
  assert.equal(api.stats().frames, 1, 'leave periodic parity counter away from the 120-frame boundary');
  assert.equal(api.stats().verified, 1);
  const view = nodes.get('room-hd-view');
  view.value = 'original'; view.listeners.get('change')();
  callbacks.shift()();
  u32(p.room + l.roomModule._sceneNum, 1);
  callbacks.shift()(); await flush();
  assert.equal(api.stats().activeRoom, 'Scene1002');
  assert.equal(api.stats().pack, null);
  assert.equal(api.stats().packLoading, true);
  assert.equal(api.output.hidden, true);
  u32(p.room + l.roomModule._sceneNum, 0);
  callbacks.shift()();
  assert.equal(api.stats().pack.room, 'Scene1001');
  assert.equal(api.stats().pack.selectedBackground, 'original', 'room-one background choice survives room changes');
  waiting.shift()(); await flush();
  assert.equal(api.stats().activeRoom, 'Scene1001');
  assert.equal(api.stats().pack.room, 'Scene1001', 'late room-two manifest cannot replace room one');
  assert.equal(api.stats().mode, 'original');
  u32(p.room + l.roomModule._sceneNum, 1);
  callbacks.shift()();
  assert.equal(api.stats().pack.room, 'Scene1002');
  assert.equal(api.stats().pack.selectedBackground, 'gemini');
  assert.equal(api.stats().mode, 'original');
  assert.equal(nodes.get('room-hd-background').options.find(option => option.value === 'realesrnet').disabled, true);
  assert.equal(requests.length, 2, 'each room manifest loads once, with no PNG demand in Original mode');
  api.selectPackBackground('original');
  const verified = api.stats().verified;
  view.value = 'hd'; view.listeners.get('change')(); callbacks.shift()();
  assert.equal(api.stats().verified, verified + 1, 'first proxy frame after async room loading requires parity even off the periodic boundary');
  assert.equal(api.stats().errors, 0);
  assert.equal(api.stats().mismatches, 0);
  u32(p.room + l.roomModule._sceneNum, 2);
  callbacks.shift()();
  assert.equal(api.stats().activeRoom, null);
  assert.equal(api.stats().pack, null);
  assert.equal(api.output.hidden, true);
});
