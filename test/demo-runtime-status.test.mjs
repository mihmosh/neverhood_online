import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverRuntime } from '../web/lib/runtime.js';

test('runtime forwards explicit phases and never relabels background messages as startup', async t => {
  const listeners = new Map(), statuses = [], sent = [];
  let cleanup = () => {};
  t.after(() => cleanup());
  const frame = { contentWindow: { postMessage: message => sent.push(message) }, addEventListener() {}, remove() {}, focus() {} };
  const globals = {
    location: new URL('https://demo.example/'),
    document: { createElement: () => frame },
    window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => options?.method === 'HEAD' ? new Response() : Response.json({
    available: true, api: 'emscripten-global-module', engine: 'neverhood', module: 'scummvm.js', wasm: 'scummvm.wasm', engineData: ['neverhood.dat'],
  }));
  const runtime = await discoverRuntime();
  assert.equal(runtime.available, true);
  const session = runtime.start({ container: { replaceChildren() {} }, onStatus: (...args) => statuses.push(args) });
  const nonce = new URL(frame.src).searchParams.get('session');
  const receive = listeners.get('message');
  const message = (type, data = {}) => receive({ origin: location.origin, source: frame.contentWindow,
    data: { channel: 'neverhood-player', nonce, type, ...data } });
  cleanup = () => message('exited');
  message('ready');
  assert.equal(sent[0].type, 'start');
  message('status', { text: 'Starting', progress: 40, phase: 'loading' });
  message('playing');
  message('status', { text: 'Room 2', phase: 'background' });
  message('status', { text: 'Preparing room', progress: 60, phase: 'room-loading' });
  message('status', { text: 'Ready again', progress: 100, phase: 'playing' });
  message('status', { text: 'Late startup callback', phase: 'loading' });
  message('status', { text: 'Legacy message with no phase' });
  message('status', { text: 'Leaving', phase: 'stopping' });
  assert.deepEqual(statuses.map(event => event[2]), ['loading', 'playing', 'background', 'room-loading', 'playing', 'background', 'stopping']);
  assert.equal(statuses[2][1], undefined, 'missing background progress stays nonblocking, not a hidden loading signal');
  message('exited');
  await session;
});
