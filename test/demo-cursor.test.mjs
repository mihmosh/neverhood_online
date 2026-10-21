import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { demoCursorOrdinal, validateDemoCursorManifest, loadDemoCursor } from '../web/prototype/demo-cursor.js';
import { createRoomPrototype } from '../web/prototype/room1.js';
import { RenderFrameReader } from '../web/prototype/read-frame.js';

const privateManifest = await readFile(new URL('../private-assets/demo-cursor/cursor.json', import.meta.url), 'utf8').then(JSON.parse).catch(() => null);

function frameFor(binding, ordinal = 0, pitch = 32) {
  const palette = new Uint8Array(1024);
  for (let i = 0; i < 768; i++) palette[Math.floor(i / 3) * 4 + i % 3] = binding.palette[i];
  const pixels = new Uint8Array(pitch * 32);
  for (let y = 0; y < 32; y++) pixels.set(binding.frames[ordinal].subarray(y * 32, y * 32 + 32), y * pitch);
  return { available: true, room: 'Scene1001', tick: 1, items: [], palette, reference: new Uint8Array(640 * 480),
    cursor: { resourceHash: 0x6520a400, source: { width: 32, height: 32, pitch, pixels }, hotspotX: 3, hotspotY: 7, x: 0, y: 0, visible: true } };
}

test('presented engine raster drives six phases, including repeated poses and pitched surfaces', () => {
  const binding = { palette: new Uint8Array(768), frames: [1, 2, 3].map(index => new Uint8Array(1024).fill(index)) };
  const actual = [0, 0, 1, 1, 2, 2, 0].map(ordinal => demoCursorOrdinal(binding, frameFor(binding, ordinal, 40)));
  assert.deepEqual(actual, [0, 0, 1, 1, 2, 2, 0]);
  const frame = frameFor(binding, 2);
  frame.tick = 999999; frame.cursor.frameNum = 0;
  assert.equal(demoCursorOrdinal(binding, frame), 2, 'no clock/counter-derived phase advancement');
  frame.cursor.visible = false;
  assert.equal(demoCursorOrdinal(binding, frame), 2, 'visibility never resets phase');
});

test('unsupported resources, gestures, hotspot, index mutations and fades immediately use native', () => {
  const binding = { palette: new Uint8Array(768), frames: [1, 2, 3].map(index => new Uint8Array(1024).fill(index)) };
  for (const mutate of [frame => { frame.room = 'Scene1002'; }, frame => { frame.cursor.resourceHash = 0x23303124; },
    frame => { frame.cursor.hotspotX = 15; }, frame => { frame.cursor.hotspotY = 5; },
    frame => { frame.cursor.source.pixels[300] = 42; }, frame => { frame.palette[0] = 1; },
    frame => { frame.palette[1022] = 1; }, frame => { frame.cursor.source.width = 128; }]) {
    const frame = frameFor(binding); mutate(frame);
    assert.equal(demoCursorOrdinal(binding, frame), -1);
  }
  const frame = frameFor(binding);
  frame.palette[3] = 255;
  assert.equal(demoCursorOrdinal(binding, frame), 0, 'palette fourth byte is not alpha');
});

test('full-game cursor lookup still requires exact raster, palette and hotspot outside the first room', () => {
  const binding = { palette: new Uint8Array(768), frames: [1, 2, 3].map(index => new Uint8Array(1024).fill(index)) };
  const frame = frameFor(binding, 1); frame.room = 'Module2300';
  assert.equal(demoCursorOrdinal(binding, frame), -1);
  assert.equal(demoCursorOrdinal(binding, frame, { allRooms: true }), 1);
  frame.cursor.source.pixels[300] ^= 1;
  assert.equal(demoCursorOrdinal(binding, frame, { allRooms: true }), -1);
});

test('cursor manifest rejects unrecognized versions and incomplete binding', async () => {
  await assert.rejects(validateDemoCursorManifest({ version: 1 }), /binding/);
  await assert.rejects(validateDemoCursorManifest({ version: 2 }), /binding/);
});

test('private exported fingerprints validate real indices and reject tampering', { skip: !privateManifest && 'Run scripts/build-demo-cursor.mjs with the private study assets' }, async () => {
  const binding = await validateDemoCursorManifest(privateManifest);
  assert.deepEqual([0, 1, 2].map(ordinal => demoCursorOrdinal(binding, frameFor(binding, ordinal))), [0, 1, 2]);
  for (const mutate of [manifest => { manifest.frames[0].indicesBase64 = Buffer.alloc(1024).toString('base64'); },
    manifest => { manifest.paletteRGBBase64 = Buffer.alloc(768).toString('base64'); },
    manifest => { manifest.phaseMapping = [0, 1, 2]; }, manifest => { manifest.imageSHA256 = 'a'.repeat(64); }]) {
    const changed = structuredClone(privateManifest); mutate(changed);
    await assert.rejects(validateDemoCursorManifest(changed), /binding|fingerprint/);
  }
});

test('cursor download validates image bytes before decoding and closes invalid bitmap', { skip: !privateManifest }, async t => {
  const image = await readFile(new URL('../private-assets/demo-cursor/sprite-sheet-128.png', import.meta.url));
  const requests = [];
  let closed = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(String(url).endsWith('.json') ? JSON.stringify(privateManifest) : image);
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 384, height: 128, close() { closed++; } }) });
  t.after(() => previous ? Object.defineProperty(globalThis, 'createImageBitmap', previous) : delete globalThis.createImageBitmap);
  const config = { manifestURL: 'https://demo.example/cursor.json', imageURL: 'https://demo.example/sprite-sheet-128.png' };
  const cursor = await loadDemoCursor(config);
  cursor.dispose(); assert.equal(closed, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[1].options.redirect, 'error');
  t.mock.method(globalThis, 'fetch', async url => new Response(String(url).endsWith('.json') ? JSON.stringify(privateManifest) : 'corrupt'));
  await assert.rejects(loadDemoCursor(config), /SHA256/);
  await assert.rejects(loadDemoCursor({ ...config, manifestURL: 'http://outside.example/cursor.json' }), /HTTPS/);
});

test('demo ABI is checked against actual variant hash, packs against source hash, UI selection persists between rooms', async t => {
  const abi = JSON.parse(await readFile(new URL('../web/prototype/render-abi.json', import.meta.url), 'utf8'));
  const actualHash = 'b'.repeat(64), sourceHash = abi.wasmSHA256;
  const demoABI = { ...abi, wasmSHA256: actualHash };
  const nodes = new Map(), callbacks = [], requests = [];
  let renderer;
  let cssScale = 1, resize;
  let backgroundID = 'gemini';
  let releaseRoom2;
  let room2Gate = new Promise(resolve => { releaseRoom2 = resolve; });
  let room2Failure = false;
  const statuses = [];
  let cursorDecoded;
  const cursorDecode = new Promise(resolve => { cursorDecoded = resolve; });
  t.after(() => renderer?.dispose());
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.listeners = new Map(); this.options = []; this.value = ''; this.hidden = false; this.children = new Map(); }
    setAttribute() {}
    set innerHTML(html) {
      for (const id of this.children.keys()) nodes.delete(id);
      this.children.clear();
      for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = new Element(match[1]); nodes.set(match[2], node); this.children.set(match[2], node);
        if (match[1] === 'select') {
          const content = html.slice(match.index + match[0].length).split('</select>')[0];
          node.options = [...content.matchAll(/<option value="([^"]+)"/g)].map(value => ({ value: value[1] }));
          node.value = node.options[0]?.value ?? '';
        }
      }
    }
    querySelector(selector) { return this.children.get(selector.slice(1)); }
    querySelectorAll(selector) { return selector === 'select' ? [...this.children.values()].filter(node => node.tag === 'select') : []; }
    append() {} remove() {} removeEventListener() {} focus() {}
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    matches() { return true; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 640 * cssScale, height: 480 * cssScale }; }
    getContext() { return { canvas: this, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      save() {}, restore() {}, setTransform() {}, fillRect() {}, clearRect() {}, drawImage() {}, putImageData() {} }; }
  }
  const globals = { document: { createElement: tag => new Element(tag), body: new Element('body'), hasFocus: () => true },
    window: { addEventListener() {}, removeEventListener() {} },
    location: { href: 'https://demo.example/', origin: 'https://demo.example', hostname: 'demo.example' },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
    devicePixelRatio: 1,
    createImageBitmap: async () => { cursorDecoded(); return { width: 384, height: 128, close() {} }; },
    requestAnimationFrame: fn => { callbacks.push(fn); return callbacks.length; }, cancelAnimationFrame() {} };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const binding = privateManifest ? await validateDemoCursorManifest(privateManifest)
    : { palette: new Uint8Array(768), frames: [1, 2, 3].map(index => new Uint8Array(1024).fill(index)) };
  const frame = frameFor(binding);
  t.mock.method(RenderFrameReader.prototype, 'read', function () { this.inRoom = true; return frame; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(String(url));
    if (String(url).endsWith('/demo-runtime/render-abi.json')) return new Response(JSON.stringify(demoABI));
    if (String(url).endsWith('/cursor.json')) return new Response(JSON.stringify(privateManifest));
    if (String(url).endsWith('/sprite-sheet-128.png')) return new Response(await readFile(new URL('../private-assets/demo-cursor/sprite-sheet-128.png', import.meta.url)));
    const room = String(url).includes('room2') ? 'Scene1002' : 'Scene1001';
    if (room === 'Scene1002') {
      await room2Gate;
      options.signal?.throwIfAborted();
      if (room2Failure) throw new Error('Room 2 download failed');
    }
    return new Response(JSON.stringify({ version: 1, private: true, scale: 4, runtimeSHA256: sourceHash,
      sourceBinding: 'unit-test', room, entries: [], backgrounds: [{ id: backgroundID, label: 'Gemini',
        key: '640x480-640-11111111-p12345678-opaque', file: 'gemini.png', sha256: 'a'.repeat(64), width: 2560, height: 1920, scale: 4 }] }));
  });
  const demo = { abiURL: 'https://demo.example/demo-runtime/render-abi.json', sourceRuntimeSHA256: sourceHash,
    onStatus: (...args) => statuses.push(args),
    packs: { Scene1001: 'https://demo.example/room1/room-pack.json', Scene1002: 'https://demo.example/room2/room-pack.json' } };
  if (privateManifest) demo.cursor = { manifestURL: 'https://demo.example/cursor.json', imageURL: 'https://demo.example/sprite-sheet-128.png' };
  await assert.rejects(createRoomPrototype({ module: {}, canvas: new Element('canvas'), wasmSHA256: sourceHash, demo }), /WASM build/);
  renderer = await createRoomPrototype({ module: {}, canvas: new Element('canvas'), wasmSHA256: actualHash, demo });
  await renderer.ready;
  assert.equal(requests.some(url => url.includes('/room2/')), false, 'first-room ready does not request room 2');
  const background = renderer.startBackgroundLoading();
  renderer.startBackgroundLoading();
  for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  const api = window.roomRendererPrototype;
  assert.equal(api.stats().pack.selectedBackground, 'gemini');
  assert.equal(nodes.has('room-hd-background'), false);
  const view = nodes.get('room-hd-view');
  frame.room = 'Scene1002'; frame.tick++; callbacks.shift()();
  assert.equal(statuses.at(-1)[2], 'room-loading', 'HD entry before prefetch completes has an explicit overlay phase');
  view.value = 'original'; view.listeners.get('change')(); callbacks.shift()();
  assert.equal(statuses.at(-1)[2], 'playing', 'Original selection dismisses room-loading without changing background download');
  releaseRoom2();
  await background;
  assert.equal(api.stats().mode, 'original');
  assert.equal(api.stats().packEnabled, false);
  assert.equal(api.stats().pack.room, 'Scene1002');
  assert.equal(view.value, 'original');
  view.value = 'hd'; view.listeners.get('change')(); callbacks.shift()();
  assert.equal(api.stats().packEnabled, true);
  frame.room = 'Scene1001'; frame.tick++; callbacks.shift()();
  assert.equal(api.stats().packEnabled, true);
  assert.equal(view.value, 'hd');
  assert.throws(() => api.selectPackBackground('realesrnet'), /Gemini/);
  assert.equal(requests.filter(url => url.endsWith('room-pack.json')).length, 2, 'background and room entry share one request');
  if (privateManifest) {
    await cursorDecode;
    await Promise.resolve(); await Promise.resolve();
    for (const dpr of [1, 2]) for (const scale of [1, 1.25, 2, 4]) for (const [x, y] of [[0, 0], [639, 479]]) {
      globalThis.devicePixelRatio = dpr; cssScale = scale; resize();
      frame.cursor.x = x; frame.cursor.y = y; callbacks.shift()();
      assert.equal(api.cursorCanvas.width, 128);
      assert.equal(api.cursorCanvas.style.width, `${32 * scale}px`);
      assert.equal(api.cursorCanvas.style.height, `${32 * scale}px`);
      assert.equal(api.cursorCanvas.style.transform, `translate(${(x - 3) * scale}px,${(y - 7) * scale}px)`);
      assert.equal(api.cursorViewport.style.cssText.includes('overflow:hidden'), true);
    }
    frame.palette[0] ^= 1; callbacks.shift()();
    assert.equal(api.cursorCanvas.width, 32, 'palette change immediately restores native backing size');
    assert.equal(api.stats().cursor.hd, false);
    frame.palette[0] ^= 1; callbacks.shift()();
    assert.equal(api.cursorCanvas.width, 128, 'reference palette restores same engine phase');
    assert.equal(api.stats().cursor.ordinal, 0);
    frame.cursor.visible = false; callbacks.shift()();
    assert.equal(api.cursorCanvas.hidden, true);
  }
  assert.equal(api.stats().errors, 0);
  backgroundID = 'realesrnet';
  await assert.rejects(api.loadPackURL('https://demo.example/room1/room-pack.json'), /[Gg]emini/);
  assert.equal(api.stats().pack, null, 'missing Gemini cannot silently select RealESRNet');
  assert.equal(api.output.hidden, true);
  renderer.dispose();
  backgroundID = 'gemini'; room2Failure = true;
  renderer = await createRoomPrototype({ module: {}, canvas: new Element('canvas'), wasmSHA256: actualHash, demo });
  await renderer.ready;
  await renderer.startBackgroundLoading();
  assert.match(statuses.at(-1)[0], /retry/);
  assert.equal(statuses.at(-1)[2], 'background', 'optional-room failure cannot revert startup loading');
  room2Failure = false;
  const retryAPI = window.roomRendererPrototype;
  const beforeRetry = requests.filter(url => url.includes('/room2/')).length;
  await retryAPI.loadPack(demo.packs.Scene1002, true, 'Scene1002');
  assert.equal(requests.filter(url => url.includes('/room2/')).length, beforeRetry + 1, 'failed prefetch can retry on entry');
  renderer.dispose();
  const abort = new AbortController();
  room2Gate = new Promise(resolve => { releaseRoom2 = resolve; });
  renderer = await createRoomPrototype({ module: {}, canvas: new Element('canvas'), wasmSHA256: actualHash, demo, signal: abort.signal });
  await renderer.ready;
  const cancelled = renderer.startBackgroundLoading();
  for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  abort.abort(); renderer.dispose(); releaseRoom2();
  await cancelled;
  assert.equal(requests.filter(url => url.includes('/room2/')).length, beforeRetry + 2);
  backgroundID = 'realesrnet';
  renderer = await createRoomPrototype({ module: {}, canvas: new Element('canvas'), wasmSHA256: actualHash, demo });
  await assert.rejects(renderer.ready, /[Gg]emini/);
});
