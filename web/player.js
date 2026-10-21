import { REQUIRED_FILES } from './lib/validation.js';
import { openArchive } from './lib/storage.js';
import { demoAssetURL, fetchDemoBytes, fetchDemoManifest } from './lib/demo-data.js';
import { createDemoProgress } from './lib/demo-progress.js';
import { discoverRuntime } from './lib/runtime.js';

const nonce = new URL(location.href).searchParams.get('session');
const prototypeRequested = new URL(location.href).searchParams.get('renderer') === 'room1-proxy';
const demoRequested = new URL(location.href).searchParams.get('demo') === '1';
let fullGameSession = false;
const canvas = document.getElementById('canvas');
const menu = document.getElementById('game-menu');
menu.addEventListener('click', () => {
  if ((demoRequested && !fullGameSession) || menu.hidden || controller.signal.aborted) return;
  canvas.focus();
  // SDL listens to DOM keyboard events; keep the original engine menu behavior.
  for (const type of ['keydown', 'keyup']) {
    canvas.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  }
});
const controller = new AbortController();
let started = false;
let finishing;
let mounted = false;
let resizeObserver;
let syncing = Promise.resolve();
let engineFrame;
let windowStamp = '';
let renderPrototype;

function windowSize() {
  if (renderPrototype?.preferNativeResolution?.()) return [640, 480];
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

function engineExitError(code = 0) {
  if (code) return new Error(`The game stopped (code ${code}).`);
  if (demoRequested && !fullGameSession && ![2, 3].includes(window.Module?.getValue(Module._neverhood_demo_state, 'i32'))) return new Error('The demo stopped before reaching its completion boundary.');
}

function artifact(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid player file.');
  return new URL(`./${demoRequested && !fullGameSession ? 'demo-runtime' : 'runtime'}/${name}`, import.meta.url).href;
}

function sync(populate) {
  syncing = syncing.catch(() => {}).then(() => new Promise((resolve, reject) => Module.FS.syncfs(populate, error => error ? reject(error) : resolve())));
  return syncing;
}

function finish(error) {
  if (finishing) return finishing;
  controller.abort();
  renderPrototype?.dispose();
  resizeObserver?.disconnect();
  cancelAnimationFrame(engineFrame);
  canvas.hidden = true;
  menu.hidden = true;
  window.Module?._emscripten_pause_main_loop?.();
  finishing = (async () => {
    // onExit fires after Emscripten shutdown; IDBFS remains available for flushing.
    try { if (mounted) await sync(false); }
    catch { error ||= new Error('Your latest progress could not be saved.'); }
    send('exited', error ? { error: String(error.message || error).slice(0, 500) } : {});
  })();
  return finishing;
}

async function start(descriptor, demo) {
  const { signal } = controller;
  let playing = false;
  const status = (text, progress, phase = playing ? 'background' : 'loading') => { if (!signal.aborted && !(playing && phase === 'loading')) send('status', { text, progress, phase }); };
  status(demoRequested ? 'Loading the demo manifest...' : 'Loading the game player...', 0);
  if (demoRequested && (descriptor.demo !== true || !demo?.manifestURL)) throw new Error('A bounded demo engine and demo data are required.');
  const demoManifest = demoRequested ? await fetchDemoManifest(demo.manifestURL, descriptor.sourceRuntimeSHA256, signal) : null;
  fullGameSession = demoManifest?.fullGame === true;
  if (fullGameSession) {
    const stock = await discoverRuntime();
    if (!stock.available) throw new Error('The unchanged full-game runtime is unavailable.');
    descriptor = { ...stock.descriptor, wasmSHA256: demoManifest.sourceRuntimeSHA256,
      sourceRuntimeSHA256: demoManifest.sourceRuntimeSHA256 };
  }
  const startup = demoManifest ? createDemoProgress({ nativeBytes: demoManifest.totalBytes,
    roomBytes: demoManifest.packs.Scene1001?.bytes ?? 0 }, status) : null;
  const announcePlaying = () => {
    if (playing || signal.aborted) return;
    startup?.('ready', 1, 'Enjoy Neverhood!');
    playing = true;
    send('playing');
    renderPrototype?.startBackgroundLoading?.();
  };
  status('Loading the game player...', 0);
  await new Promise((resolve, reject) => {
    window.Module = {
      canvas,
      noInitialRun: true,
      noExitRuntime: false,
      locateFile: artifact,
      print: text => console.info('[ScummVM]', text),
      printErr: text => console.warn('[ScummVM]', text),
      onRuntimeInitialized: resolve,
      onExit: code => { finish(engineExitError(code)); },
      onAbort: reason => { const error = new Error(`The game player stopped: ${String(reason).slice(0, 300)}`); reject(error); finish(error); },
    };
    if (prototypeRequested) {
      // Capture the exact instantiated bytes, not a second fetch that could race a deploy.
      Module.instantiateWasm = (imports, receive) => {
        (async () => {
          const response = await fetch(artifact(descriptor.wasm), { signal });
          if (!response.ok) throw new Error('Experimental player WASM download failed.');
          const bytes = await response.arrayBuffer();
          Module.renderPrototypeWasmSHA256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
          if (demoRequested && Module.renderPrototypeWasmSHA256 !== descriptor.wasmSHA256) throw new Error('Demo engine SHA256 verification failed.');
          const result = await WebAssembly.instantiate(bytes, imports);
          receive(result.instance, result.module);
        })().catch(error => { reject(error); finish(error); });
        return {};
      };
    }
    const script = document.createElement('script');
    script.src = artifact(descriptor.module);
    script.onerror = () => reject(new Error('The game player could not be downloaded.'));
    document.head.append(script);
  });
  signal.throwIfAborted();
  startup?.('engine', 1, 'Game player initialized.');
  if (prototypeRequested) {
    try {
      const { createRoomPrototype } = await import('./prototype/room1.js');
      const demoOptions = demoManifest ? {
        fullGame: fullGameSession, rooms: demoManifest.rooms,
        abiURL: fullGameSession ? new URL('./prototype/render-abi.json', import.meta.url).href : artifact(descriptor.abi), sourceRuntimeSHA256: descriptor.sourceRuntimeSHA256,
        packs: Object.fromEntries(Object.entries(demoManifest.packs).map(([room, entry]) => [room, demoManifest.version === 2
          ? { ...entry, url: demoAssetURL(entry.file, demoManifest.manifestURL) } : demoAssetURL(entry, demoManifest.manifestURL)])),
        onStatus: status,
        onStartupProgress: (loaded, total, phase) => startup(phase === 'download' ? 'room' : 'verify', total ? loaded / total : 0,
          phase === 'download' ? 'Loading HD room 1...' : 'Verifying HD room 1 and preparing its cache...'),
        cursor: { manifestURL: demoAssetURL(demoManifest.cursor, demoManifest.manifestURL),
          imageURL: new URL('sprite-sheet-128.png', demoAssetURL(demoManifest.cursor, demoManifest.manifestURL)).href },
      } : undefined;
      renderPrototype = await createRoomPrototype({ module: Module, canvas, wasmSHA256: Module.renderPrototypeWasmSHA256, signal, demo: demoOptions });
      if (demoRequested) await renderPrototype.ready;
      if (demoRequested) startup('verify', 1, fullGameSession ? 'Room archive loader and cursor ready.' : 'HD room 1 and cursor ready.');
      if (signal.aborted) { renderPrototype.dispose(); signal.throwIfAborted(); }
    } catch (error) {
      if (error.name === 'AbortError' || demoRequested) throw error;
      console.warn('Original renderer retained:', error);
      window.roomRendererPrototype = { stats: () => ({ status: 'disabled', lastError: error.message }) };
    }
  }
  const fs = Module.FS;
  if (!fs || !Module.IDBFS || typeof Module.callMain !== 'function') throw new Error('The game player is incomplete.');
  fs.mkdirTree('/game');
  fs.mkdirTree('/saves');
  if (!demoRequested || fullGameSession) {
    fs.mount(Module.IDBFS, { autoPersist: true }, '/saves');
    mounted = true;
    await sync(true);
  }
  signal.throwIfAborted();
  fs.mkdirTree('/engine-data');
  for (const name of descriptor.engineData) {
    const response = await fetch(artifact(name), { signal });
    if (!response.ok) throw new Error('A game player file is missing.');
    fs.writeFile(`/engine-data/${name}`, new Uint8Array(await response.arrayBuffer()));
  }
  if (demoManifest) {
    let copied = 0;
    for (const entry of demoManifest.files) {
      const bytes = await fetchDemoBytes(demoAssetURL(entry.file, demoManifest.manifestURL), {
        signal, limit: entry.bytes, expectedBytes: entry.bytes, sha256: entry.sha256,
        onProgress: loaded => startup('native', (copied + loaded) / demoManifest.totalBytes, 'Loading original game data...'),
      });
      fs.writeFile(`/game/${entry.name}`, bytes, { canOwn: fullGameSession });
      copied += bytes.length;
      startup('native', copied / demoManifest.totalBytes, 'Verifying original game data...');
    }
  } else {
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
  }
  signal.throwIfAborted();
  // Keep the session configuration separate from upstream's persisted HOME mount.
  fs.writeFile('/tmp/neverhood.ini', '[scummvm]\ngui_return_to_launcher_at_exit=false\nconfirm_exit=false\nfiltering=true\noriginalsaveload=true\n');
  canvas.focus();
  if (startup) startup('ready', 0, 'Stepping into Neverhood...');
  else status('Stepping into Neverhood...', 100);
  const [width, height] = windowSize();
  let observingEngine = false;
  if (typeof Module._g_engine === 'number' && typeof Module.getValue === 'function') {
    observingEngine = true;
    let sawEngine = false;
    let announced = false;
    const observeEngine = () => {
      if (signal.aborted) return;
      const active = Module.getValue(Module._g_engine, '*') !== 0;
      if (active) resizeWindow();
      if (active && !sawEngine) {
        sawEngine = true;
        menu.hidden = demoRequested && !fullGameSession;
        if (!demoRequested || fullGameSession) { announced = true; announcePlaying(); }
      } else if (sawEngine && !active) {
        // The game's destructor has run. Dispose the whole session, not its launcher.
        finish(engineExitError());
        return;
      }
      if (active && demoRequested && !fullGameSession) {
        const state = window.roomRendererPrototype?.stats();
        if (!announced && state?.pack?.cacheError) { finish(new Error(state.pack.cacheError)); return; }
        if (!announced) {
          if (Object.keys(state?.pack?.errors ?? {}).length || state?.errors || state?.mismatches) { finish(new Error('The HD demo assets could not be drawn. Please retry.')); return; }
          if (state?.hdDraws > 0 && state.verified > 0 && state.pack?.missKeys.length === 0) { announced = true; announcePlaying(); }
        }
      }
      engineFrame = requestAnimationFrame(observeEngine);
    };
    engineFrame = requestAnimationFrame(observeEngine);
  }
  if (demoRequested && !observingEngine) throw new Error('The demo player cannot verify its first game frame.');
  try {
    Module.callMain(['--path=/game', '--extrapath=/engine-data', '--savepath=/saves', '--config=/tmp/neverhood.ini', '--no-fullscreen', '--filtering', '--stretch-mode=fit_force_aspect', `--window-size=${width},${height}`, 'neverhood']);
    if (!observingEngine && !finishing && !signal.aborted) { menu.hidden = demoRequested; announcePlaying(); }
  } catch (error) {
    if (error === 'unwind') { if (!observingEngine) { menu.hidden = demoRequested; announcePlaying(); } }
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
    start(data.descriptor, data.demo).catch(error => { if (error.name !== 'AbortError') finish(error); });
  }
});

if (parent !== window && /^[a-z0-9-]{36}$/.test(nonce || '')) send('ready');
