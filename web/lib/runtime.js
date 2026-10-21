import { fetchDemoManifest } from './demo-data.js';

const base = new URL('../runtime/', import.meta.url);

function artifactURL(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid engine artifact name.');
  return new URL(name, base).href;
}

function startRuntime(descriptor, { container, onStatus = () => {}, signal }, localHD = false, demo) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.id = 'playframe';
    frame.title = 'Neverhood game';
    frame.allow = 'autoplay; fullscreen';
    frame.src = new URL(`../player.html?session=${nonce}`, import.meta.url).href;
    if (demo || localHD || new URL(location.href).searchParams.get('renderer') === 'room1-proxy') {
      const url = new URL(frame.src);
      url.searchParams.set('renderer', 'room1-proxy');
      if (demo) url.searchParams.set('demo', '1');
      if (new URL(location.href).searchParams.get('renderer-debug') === '1') url.searchParams.set('renderer-debug', '1');
      frame.src = url.href;
    }
    let settled = false;
    let initialized = false;
    let playing = false;
    let stopTimer;
    const send = type => frame.contentWindow?.postMessage({ channel: 'neverhood-player', nonce, type, ...(type === 'start' ? { descriptor, ...(demo ? { demo } : {}) } : {}) }, location.origin);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimer);
      clearTimeout(stopTimer);
      window.removeEventListener('message', receive);
      signal?.removeEventListener('abort', stop);
      frame.remove();
      if (error) reject(error); else resolve();
    };
    const stop = () => {
      if (settled || stopTimer) return;
      onStatus(demo ? 'Leaving the demo...' : 'Saving and returning to the site...', undefined, 'stopping');
      send('stop');
      // A wedged WASM instance must not keep the library lock or audio alive.
      stopTimer = setTimeout(() => finish(new Error(demo ? 'The demo player had to be stopped.' : 'The player had to stop before saving finished. Your latest progress may not have been saved.')), 8000);
    };
    const receive = event => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.channel !== 'neverhood-player' || data.nonce !== nonce) return;
      if (data.type === 'ready' && !initialized) {
        initialized = true;
        if (signal?.aborted) send('stop'); else send('start');
      } else if (data.type === 'status' && typeof data.text === 'string' && data.text.length <= 500) {
        const phase = ['loading', 'playing', 'background', 'room-loading', 'stopping'].includes(data.phase) ? data.phase : playing ? 'background' : 'loading';
        if (!signal?.aborted && !(playing && phase === 'loading')) onStatus(data.text, Number.isFinite(data.progress) ? Math.max(0, Math.min(100, data.progress)) : undefined, phase);
      } else if (data.type === 'playing' && !signal?.aborted) {
        playing = true;
        clearTimeout(loadTimer);
        onStatus('Enjoy Neverhood!', 100, 'playing');
        frame.focus();
      } else if (data.type === 'exited') {
        finish(typeof data.error === 'string' ? new Error(data.error.slice(0, 500)) : null);
      }
    };
    const loadTimer = setTimeout(() => finish(new Error('The player took too long to start. Please try Play again.')), 180000);
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', stop, { once: true });
    frame.addEventListener('error', () => finish(new Error('The game player could not load.')), { once: true });
    container.replaceChildren(frame);
    if (signal?.aborted) stop();
  });
}

export async function discoverDemoRuntime({ manifestURL } = {}) {
  try {
    if (!manifestURL) throw new Error('The HD demo has not been published yet.');
    const demoBase = new URL('../demo-runtime/', import.meta.url);
    const response = await fetch(new URL('runtime.json', demoBase), { cache: 'no-cache' });
    if (!response.ok) throw new Error('The demo engine build is not installed.');
    const descriptor = await response.json();
    if (!descriptor.available || descriptor.demo !== true || descriptor.api !== 'emscripten-global-module' || descriptor.engine !== 'neverhood' ||
        descriptor.module !== 'scummvm.js' || descriptor.wasm !== 'scummvm.wasm' || descriptor.abi !== 'render-abi.json' ||
        JSON.stringify(descriptor.engineData) !== '["neverhood.dat"]' ||
        !/^[a-f0-9]{64}$/.test(descriptor.wasmSHA256) || !/^[a-f0-9]{64}$/.test(descriptor.sourceRuntimeSHA256)) throw new Error('The demo engine descriptor is incompatible.');
    const manifest = await fetchDemoManifest(manifestURL, descriptor.sourceRuntimeSHA256);
    return { available: true, streaming: manifest.streaming?.version === 1,
      downloadBytes: manifest.streaming ? undefined : manifest.totalAssetBytes,
      start: options => startRuntime(descriptor, options, false, { manifestURL: manifest.manifestURL }) };
  } catch (error) {
    return { available: false, reason: error.message || 'The HD demo is unavailable.' };
  }
}

export async function discoverRuntime() {
  try {
    const response = await fetch(new URL('runtime.json', base), { cache: 'no-store' });
    if (!response.ok) return { available: false, reason: 'The engine build is not connected yet.' };
    const descriptor = await response.json();
    if (descriptor.available !== true || descriptor.api !== 'emscripten-global-module' || descriptor.engine !== 'neverhood') {
      return { available: false, reason: 'Artifacts were found, but no compatible engine build is connected.' };
    }
    if (!Array.isArray(descriptor.engineData) || !descriptor.engineData.includes('neverhood.dat')) throw new Error('The engine data descriptor is missing.');
    const artifacts = await Promise.all([descriptor.module, descriptor.wasm, ...descriptor.engineData].map(name => fetch(artifactURL(name), { method: 'HEAD', cache: 'no-store' })));
    if (artifacts.some(artifact => !artifact.ok)) throw new Error('Artifacts are missing.');
    let localHD = false;
    if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
      try {
        const pack = await fetch('/__private-room-pack/room-pack.json', { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
        localHD = pack.ok;
      } catch { /* Local HD is optional; original playback remains available. */ }
    }
    return { available: true, descriptor, start: options => startRuntime(descriptor, options, localHD) };
  } catch {
    return { available: false, reason: 'The engine is unavailable or its adapter is not ready.' };
  }
}
