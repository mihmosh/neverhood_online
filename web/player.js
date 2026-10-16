import { REQUIRED_FILES } from './lib/validation.js';
import { openArchive } from './lib/storage.js';

const nonce = new URL(location.href).searchParams.get('session');
const canvas = document.getElementById('canvas');
const controller = new AbortController();
let started = false;
let finishing;
let mounted = false;
let resizeObserver;
let syncing = Promise.resolve();
let engineFrame;
let windowStamp = '';

function windowSize() {
  const width = Math.max(4, Math.floor(Math.min(innerWidth, innerHeight * 4 / 3) / 4) * 4);
  return [width, width * 3 / 4];
}

function resizeWindow() {
  const module = window.Module;
  if (!module?._SDL_GetWindowID || !module?._SDL_SetWindowSize) return;
  const handle = module._SDL_GL_GetCurrentWindow?.() || module._SDL_GetKeyboardFocus?.();
  if (!handle) return;
  const size = windowSize();
  const stamp = `${module._SDL_GetWindowID(handle)}:${size.join(',')}`;
  const scale = devicePixelRatio || 1;
  const matches = Math.abs(canvas.width - size[0] * scale) < 4 && Math.abs(canvas.height - size[1] * scale) < 4;
  // Graphics initialization can resize an existing window after it was observed.
  if (stamp === windowStamp && matches) return;
  windowStamp = stamp;
  module._SDL_SetWindowSize(handle, ...size);
}

function send(type, data = {}) {
  parent.postMessage({ channel: 'neverhood-player', nonce, type, ...data }, location.origin);
}

function artifact(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid player file.');
  return new URL(`./runtime/${name}`, import.meta.url).href;
}

function sync(populate) {
  syncing = syncing.catch(() => {}).then(() => new Promise((resolve, reject) => Module.FS.syncfs(populate, error => error ? reject(error) : resolve())));
  return syncing;
}

function finish(error) {
  if (finishing) return finishing;
  controller.abort();
  resizeObserver?.disconnect();
  cancelAnimationFrame(engineFrame);
  canvas.hidden = true;
  window.Module?._emscripten_pause_main_loop?.();
  finishing = (async () => {
    // onExit fires after Emscripten shutdown; IDBFS remains available for flushing.
    try { if (mounted) await sync(false); }
    catch { error ||= new Error('Your latest progress could not be saved.'); }
    send('exited', error ? { error: String(error.message || error).slice(0, 500) } : {});
  })();
  return finishing;
}

async function start(descriptor) {
  const { signal } = controller;
  const status = (text, progress) => { if (!signal.aborted) send('status', { text, progress }); };
  status('Loading the game player...');
  await new Promise((resolve, reject) => {
    window.Module = {
      canvas,
      noInitialRun: true,
      noExitRuntime: false,
      locateFile: artifact,
      print: text => console.info('[ScummVM]', text),
      printErr: text => console.warn('[ScummVM]', text),
      onRuntimeInitialized: resolve,
      onExit: code => { finish(code ? new Error(`The game stopped (code ${code}).`) : null); },
      onAbort: reason => { const error = new Error(`The game player stopped: ${String(reason).slice(0, 300)}`); reject(error); finish(error); },
    };
    const script = document.createElement('script');
    script.src = artifact(descriptor.module);
    script.onerror = () => reject(new Error('The game player could not be downloaded.'));
    document.head.append(script);
  });
  signal.throwIfAborted();
  const fs = Module.FS;
  if (!fs || !Module.IDBFS || typeof Module.callMain !== 'function') throw new Error('The game player is incomplete.');
  fs.mkdirTree('/game');
  fs.mkdirTree('/saves');
  fs.mount(Module.IDBFS, { autoPersist: true }, '/saves');
  mounted = true;
  await sync(true);
  signal.throwIfAborted();
  fs.mkdirTree('/engine-data');
  for (const name of descriptor.engineData) {
    const response = await fetch(artifact(name), { signal });
    if (!response.ok) throw new Error('A game player file is missing.');
    fs.writeFile(`/engine-data/${name}`, new Uint8Array(await response.arrayBuffer()));
  }
  const files = await Promise.all(REQUIRED_FILES.map(openArchive));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let copied = 0;
  for (let i = 0; i < REQUIRED_FILES.length; i++) {
    signal.throwIfAborted();
    const reader = files[i].stream().getReader();
    const destination = fs.open(`/game/${REQUIRED_FILES[i]}`, 'w');
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        fs.write(destination, value, 0, value.byteLength);
        copied += value.byteLength;
        status(`Opening your world: ${Math.floor(copied / total * 100)}%`, copied / total * 100);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      fs.close(destination);
    }
  }
  signal.throwIfAborted();
  // Keep the session configuration separate from upstream's persisted HOME mount.
  fs.writeFile('/tmp/neverhood.ini', '[scummvm]\ngui_return_to_launcher_at_exit=false\nconfirm_exit=false\nfiltering=true\noriginalsaveload=true\n');
  canvas.focus();
  status('Stepping into Neverhood...', 100);
  const [width, height] = windowSize();
  let observingEngine = false;
  if (typeof Module._g_engine === 'number' && typeof Module.getValue === 'function') {
    observingEngine = true;
    let sawEngine = false;
    const observeEngine = () => {
      if (signal.aborted) return;
      const active = Module.getValue(Module._g_engine, '*') !== 0;
      if (active) resizeWindow();
      if (active && !sawEngine) {
        sawEngine = true;
        send('playing');
      } else if (sawEngine && !active) {
        // The game's destructor has run. Dispose the whole session, not its launcher.
        finish();
        return;
      }
      engineFrame = requestAnimationFrame(observeEngine);
    };
    engineFrame = requestAnimationFrame(observeEngine);
  }
  try {
    Module.callMain(['--path=/game', '--extrapath=/engine-data', '--savepath=/saves', '--config=/tmp/neverhood.ini', '--no-fullscreen', '--filtering', '--stretch-mode=fit_force_aspect', `--window-size=${width},${height}`, 'neverhood']);
    if (!observingEngine && !finishing && !signal.aborted) send('playing');
  } catch (error) {
    if (error === 'unwind') { if (!observingEngine) send('playing'); }
    else throw error;
  }
  // Let SDL resize its own drawable and GL viewport; never resize the GL canvas directly.
  if (Module._SDL_GetWindowFromID && Module._SDL_SetWindowSize && !signal.aborted) {
    resizeObserver = new ResizeObserver(resizeWindow);
    resizeObserver.observe(document.body);
  }
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const data = event.data;
  if (!data || data.channel !== 'neverhood-player' || data.nonce !== nonce) return;
  if (data.type === 'stop') finish();
  else if (data.type === 'start' && !started && !controller.signal.aborted) {
    started = true;
    start(data.descriptor).catch(error => { if (error.name !== 'AbortError') finish(error); });
  }
});

if (parent !== window && /^[a-z0-9-]{36}$/.test(nonce || '')) send('ready');
