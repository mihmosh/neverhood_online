import { RenderFrameReader } from './read-frame.js';
import { composeIndexed, indicesToRGBA, paintFrame } from './compositor.js';
import { updateCRC32 } from '../lib/zip-validation.js';
import { loadReplacementPack, loadReplacementPackURL } from './replacement-pack.js';
import { loadDemoCursor, demoCursorOrdinal } from './demo-cursor.js';
import { demoAddress, fetchDemoBytes } from '../lib/demo-data.js';

const crc = bytes => ((updateCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');

export async function createRoomPrototype({ module, canvas, wasmSHA256, signal, demo }) {
  if (demo && (!demo.abiURL || !/^[a-f0-9]{64}$/.test(demo.sourceRuntimeSHA256) ||
      !demo.packs?.Scene1001 || !demo.packs?.Scene1002)) throw new Error('Incomplete demo renderer configuration.');
  const debug = !demo && new URL(location.href).searchParams.get('renderer-debug') === '1';
  let abi;
  if (demo) {
    const address = new URL(demo.abiURL, location.href);
    if (address.origin !== location.origin || address.pathname !== '/demo-runtime/render-abi.json' || address.username || address.password || address.search || address.hash) throw new Error('Demo ABI must be the same-origin compiled artifact.');
    const bytes = await fetchDemoBytes(address.href, { signal, limit: 256 * 1024 });
    abi = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } else {
    const response = await fetch(new URL('./render-abi.json', import.meta.url), { signal });
    if (!response.ok) throw new Error('The experimental render layout is missing.');
    abi = await response.json();
  }
  if (abi.wasmSHA256 !== wasmSHA256) throw new Error('Render prototype disabled: this WASM build does not match its layout.');
  const reader = new RenderFrameReader(module, abi);
  const output = document.createElement('canvas');
  output.id = 'room-proxy-canvas';
  output.setAttribute('aria-hidden', 'true');
  output.width = 640;
  output.height = 480;
  output.hidden = true;
  output.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:1;';
  const context = output.getContext('2d', { alpha: false });
  if (!context) throw new Error('A proxy drawing context is unavailable.');
  const cursorCanvas = document.createElement('canvas');
  cursorCanvas.id = 'room-proxy-cursor';
  cursorCanvas.setAttribute('aria-hidden', 'true');
  cursorCanvas.width = 32;
  cursorCanvas.height = 32;
  cursorCanvas.hidden = true;
  cursorCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;background:transparent;';
  const cursorViewport = document.createElement('div');
  cursorViewport.id = 'room-proxy-cursor-viewport';
  cursorViewport.hidden = true;
  cursorViewport.style.cssText = 'position:fixed;pointer-events:none;z-index:2;overflow:hidden;';
  cursorViewport.append(cursorCanvas);
  const cursorContext = cursorCanvas.getContext('2d');
  if (!cursorContext) throw new Error('A native cursor drawing context is unavailable.');
  const cursorImage = cursorContext.createImageData(32, 32);
  const panel = document.createElement('details');
  panel.id = 'room-proxy-panel';
  panel.hidden = !debug;
  panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2;width:min(360px,calc(100vw - 16px));max-height:45vh;overflow:auto;background:#171b17ed;color:#e1ecd6;padding:10px;font:11px/1.5 monospace;border:1px solid #a3b88f;border-radius:5px;';
  panel.innerHTML = `
    <summary>Room 1 / 2 renderer lab</summary>
    <p>Experimental, exact-build adapter. Engine source is unchanged.</p>
    <p id="proxy-status" role="status">Waiting for room 1001...</p>
    <button id="proxy-toggle" type="button">Use original</button>
    <button id="proxy-verify" type="button">Compare displayed 1x</button>
    <label for="proxy-scale">Output</label>
    <select id="proxy-scale"><option value="1">1x reference</option><option value="4">4x composition</option></select>
    <label style="display:block;margin-top:10px" for="proxy-layer">Observed rasters</label>
    <select id="proxy-layer" style="width:100%"></select>
    <button id="proxy-export" type="button">Export original layer PNG</button>
    <label style="display:block;margin-top:10px" for="proxy-image">Private PNG replacement (exactly 4x)</label>
    <input id="proxy-image" type="file" accept="image/png" style="max-width:100%">
    <button id="proxy-clear" type="button">Clear replacements</button>
    <p id="proxy-import-status" role="status">Images stay in this session. Preserve transparency when preparing PNGs. No upload or AI inference.</p>
    <label style="display:block;margin-top:10px" for="proxy-pack">Private HD pack directory</label>
    <input id="proxy-pack" type="file" webkitdirectory multiple style="max-width:100%">
    <label style="display:block"><input id="proxy-pack-enabled" type="checkbox" disabled> Use experimental pack candidates (4x)</label>
    <label for="proxy-pack-background">Pack background</label>
    <select id="proxy-pack-background" disabled><option value="original">Original background + pack sprites</option><option value="gemini">Gemini candidate</option><option value="realesrnet">RealESRNet candidate</option></select>
    <button id="proxy-pack-clear" type="button">Unload pack</button>
    <p id="proxy-pack-status" role="status">Opt-in experimental candidates, not reviewed or approved. Files stay local; no upload or inference.</p>`;
  panel.style.zIndex = '3';
  const controls = document.createElement('div');
  controls.id = 'room-hd-controls';
  controls.hidden = true;
  controls.style.cssText = 'display:flex;position:fixed;left:max(8px,env(safe-area-inset-left));bottom:max(8px,env(safe-area-inset-bottom));z-index:3;align-items:center;gap:6px;padding:5px;background:#181818df;border:1px solid #f1dec244;border-radius:12px;color:#f1dec2;font:500 13px/1.2 sans-serif;';
  controls.innerHTML = '<select id="room-hd-view" aria-label="Graphics"><option value="hd">HD</option><option value="original">Original</option></select><select id="room-hd-background" aria-label="Background"><option value="gemini">Gemini</option><option value="realesrnet">RealESRNet</option></select>';
  if (demo) controls.innerHTML = '<select id="room-hd-view" aria-label="Graphics"><option value="hd">HD</option><option value="original">Original</option></select>';
  for (const select of controls.querySelectorAll('select')) select.style.cssText = 'min-height:44px;max-width:155px;padding:8px 10px;border:0;border-radius:8px;background:#302d28;color:#f1dec2;font:inherit;cursor:pointer;';
  document.body.append(output, cursorViewport, panel, controls);
  for (const event of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) panel.addEventListener(event, value => value.stopPropagation());
  for (const event of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) controls.addEventListener(event, value => value.stopPropagation());
  const find = id => panel.querySelector(`#${id}`);
  const viewControl = controls.querySelector('#room-hd-view');
  const backgroundControl = controls.querySelector('#room-hd-background');
  const replacements = new Map();
  const sources = new Map();
  const surfaceSnapshots = new Map();
  const decoded = new Map();
  const catalog = new Map();
  const variants = new Map();
  let sourceBytes = 0;
  let tick;
  let paletteKey;
  let mode = 'proxy';
  let outputScale = 1;
  let disposed = false;
  let pack;
  let packController;
  let packEnabled = false;
  let packLoading = false;
  let demoHD = true;
  let demoCursor;
  let backgroundStarted = false;
  let waitingRoom;
  const finishRoomLoading = () => {
    if (!waitingRoom) return;
    waitingRoom = undefined;
    demo?.onStatus?.('Enjoy Neverhood!', 100, 'playing');
  };
  const cursorController = new AbortController();
  const abortCursor = () => cursorController.abort();
  signal?.addEventListener('abort', abortCursor, { once: true });
  if (signal?.aborted) cursorController.abort();
  const roomPacks = new Map();
  let activeRoom = 'Scene1001';
  let parityRequired = true;
  let frameRequest;
  let lastUI = 0;
  let selected = '';
  let latestDraws = [];
  let lastReference;
  let lastPalette;
  let compositionTime = 0;
  let lastEngineTick;
  const engineIntervals = [];
  let cursorState;
  let cursorPixelsKey;
  let cursorPositionKey;
  let canvasRect;
  const resizeLayers = () => { canvasRect = undefined; };
  const canvasObserver = new ResizeObserver(resizeLayers);
  canvasObserver.observe(canvas);
  window.addEventListener('resize', resizeLayers);
  let pointerInside = canvas.matches(':hover');
  const hideCursor = () => { cursorCanvas.hidden = true; cursorViewport.hidden = true; if (cursorState) cursorState.visible = false; };
  const enterCanvas = () => { pointerInside = true; };
  const leaveCanvas = () => { pointerInside = false; hideCursor(); };
  canvas.addEventListener('pointerenter', enterCanvas);
  canvas.addEventListener('pointerleave', leaveCanvas);
  window.addEventListener('blur', hideCursor);
  const stats = { frames: 0, engineFrames: 0, verified: 0, mismatches: 0, errors: 0, hdFrames: 0, hdDraws: 0, maxDifference: 0, layers: 0, status: 'waiting', lastError: '', cpuMs: 0, meanCpuMs: 0, peakCpuMs: 0, leverVariants: 0, outputWidth: 640, outputHeight: 480, reusedSurfaces: 0, hashedSourceBytes: 0, rasterMs: 0, verifyMs: 0, paintMs: 0 };

  const original = reason => {
    output.hidden = true;
    cursorCanvas.hidden = true;
    cursorViewport.hidden = true;
    cursorState = undefined;
    canvas.style.opacity = '';
    stats.status = reason;
    controls.hidden = true;
  };
  const intern = source => {
    stats.hashedSourceBytes += source.pixels.length;
    const key = `${source.width}x${source.height}-${source.pitch}-${crc(source.pixels)}`;
    let entry = sources.get(key);
    if (entry) {
      if (entry.pixels.length !== source.pixels.length) throw new Error('Raster-key collision: original renderer retained.');
      for (let i = 0; i < entry.pixels.length; i++) {
        if (entry.pixels[i] !== source.pixels[i]) throw new Error('Raster-key collision: original renderer retained.');
      }
      sources.delete(key);
    } else {
      while (sourceBytes + source.pixels.length > 8 * 1024 ** 2 && sources.size) {
        const old = sources.keys().next().value;
        sourceBytes -= sources.get(old).pixels.length;
        sources.delete(old);
        for (const [address, snapshot] of surfaceSnapshots) if (snapshot.source.rasterKey === old) surfaceSnapshots.delete(address);
      }
      entry = { width: source.width, height: source.height, pitch: source.pitch, pixels: Uint8Array.from(source.pixels), rasterKey: key };
      sourceBytes += entry.pixels.length;
    }
    sources.set(key, entry);
    return entry;
  };
  const snapshotSurface = (item, frameTick) => {
    const input = item.source;
    const previous = surfaceSnapshots.get(input.address);
    // BaseSurface increments the byte version on every write. Only reuse it
    // across adjacent observations, so skipped frames cannot hide a byte wrap.
    if (!debug && previous && previous.version === item.version &&
        previous.buffer === input.pixels.buffer && previous.offset === input.pixels.byteOffset &&
        previous.source.width === input.width && previous.source.height === input.height && previous.source.pitch === input.pitch &&
        ((frameTick - previous.tick) >>> 0) < 100) {
      previous.tick = frameTick;
      sources.delete(previous.source.rasterKey); sources.set(previous.source.rasterKey, previous.source);
      stats.reusedSurfaces++;
      return previous.source;
    }
    const source = intern(input);
    surfaceSnapshots.set(input.address, { source, version: item.version, buffer: input.pixels.buffer,
      offset: input.pixels.byteOffset, tick: frameTick });
    return source;
  };
  const refreshUI = items => {
    if (!debug) return;
    const now = performance.now();
    if (now - lastUI < 250) return;
    lastUI = now;
    const current = selected || find('proxy-layer').value;
    const visible = new Set(items.map(item => item.key));
    find('proxy-layer').replaceChildren(...[...catalog.keys()].map(key => {
      const item = catalog.get(key);
      const option = document.createElement('option');
      option.value = key;
      option.textContent = `${item.width}x${item.height} ${key.slice(-17)}${visible.has(key) ? ' [current]' : ''}${replacements.has(key) ? ' [HD]' : ''}`;
      return option;
    }));
    if ([...find('proxy-layer').options].some(option => option.value === current)) find('proxy-layer').value = current;
    selected = find('proxy-layer').value;
    find('proxy-status').textContent = `${stats.status}; verified ${stats.verified}; mismatches ${stats.mismatches}; layers ${stats.layers}; HD ${stats.hdDraws}; ${stats.cpuMs.toFixed(1)} ms; lever frames ${stats.leverVariants}`;
    if (pack) {
      const state = pack.stats();
      find('proxy-pack-status').textContent = `Experimental pack ${packEnabled ? 'ON' : 'OFF'}; background ${state.selectedBackground}; ${state.hits} hits / ${state.misses} misses; ${state.pendingLoads} pending; ${(state.cacheBytes / 1024 ** 2).toFixed(1)} MiB cache. Not reviewed or approved.`;
    }
  };
  const snapshot = () => ({ ...stats, mode, replacements: replacements.size, recorded: catalog.size, sourceBytes,
    diagnostics: debug, activeRoom, engineIntervals: [...engineIntervals],
    packEnabled, packLoading, pack: pack?.stats() ?? null, cursor: cursorState ? { ...cursorState } : null });
  const paintCursor = frame => {
    const { source, visible, x, y, hotspotX, hotspotY } = frame.cursor;
    if (!canvasRect) {
      canvasRect = canvas.getBoundingClientRect();
      for (const layer of [output, cursorViewport]) {
        layer.style.left = `${canvasRect.left}px`; layer.style.top = `${canvasRect.top}px`;
        layer.style.width = `${canvasRect.width}px`; layer.style.height = `${canvasRect.height}px`;
        layer.style.transform = 'none';
      }
      cursorCanvas.style.width = `${canvasRect.width * 32 / 640}px`;
      cursorCanvas.style.height = `${canvasRect.height * 32 / 480}px`;
      cursorPositionKey = undefined;
    }
    const rect = canvasRect;
    const rgba = cursorImage.data;
    const rasterHash = crc(source.pixels);
    const ordinal = demoCursor ? demoCursorOrdinal(demoCursor, frame) : -1;
    const pixelsKey = `${rasterHash}:${crc(frame.palette)}:${ordinal}`;
    if (pixelsKey !== cursorPixelsKey) {
      const size = ordinal >= 0 ? 128 : 32;
      if (cursorCanvas.width !== size) { cursorCanvas.width = size; cursorCanvas.height = size; }
      if (ordinal >= 0) {
        cursorContext.clearRect(0, 0, 128, 128);
        cursorContext.drawImage(demoCursor.image, ordinal * 128, 0, 128, 128, 0, 0, 128, 128);
      } else {
        for (let row = 0; row < 32; row++) for (let col = 0; col < 32; col++) {
          const index = source.pixels[row * source.pitch + col];
          const offset = (row * 32 + col) * 4;
          rgba.set(frame.palette.subarray(index * 4, index * 4 + 3), offset);
          rgba[offset + 3] = index === 0 ? 0 : 255;
        }
        cursorContext.putImageData(cursorImage, 0, 0);
      }
      cursorPixelsKey = pixelsKey;
    }
    const positionKey = `${x}:${y}:${hotspotX}:${hotspotY}`;
    if (positionKey !== cursorPositionKey) {
      cursorCanvas.style.transform = `translate(${(x-hotspotX) * rect.width / 640}px,${(y-hotspotY) * rect.height / 480}px)`;
      cursorPositionKey = positionKey;
    }
    // The viewport clips all four edges without touching a screen-sized bitmap.
    const displayed = visible && pointerInside && document.hasFocus();
    cursorCanvas.hidden = !displayed;
    cursorViewport.hidden = !displayed;
    cursorState = { visible: displayed, engineVisible: visible, x, y, hotspotX, hotspotY, rasterHash, rgbaHash: ordinal < 0 ? crc(rgba) : null, hd: ordinal >= 0, ordinal };
  };

  const update = () => {
    if (disposed) return;
    try {
      let frame = reader.read({ reference: debug || (mode === 'proxy' && packEnabled && (parityRequired || stats.frames % 120 === 0)) });
      const room = frame.room ?? reader.room ?? null;
      if (room !== activeRoom) {
        if (activeRoom && roomPacks.has(activeRoom)) Object.assign(roomPacks.get(activeRoom), { enabled: packEnabled });
        pack?.observe([]); pack?.prefetch([]);
        activeRoom = room;
        parityRequired = true;
        const state = roomPacks.get(room);
        pack = state?.pack; packController = state?.controller;
        packEnabled = demo ? Boolean(state?.pack && demoHD) : state?.enabled ?? false; packLoading = state?.loading ?? false;
        if (packEnabled) { outputScale = 4; find('proxy-scale').value = '4'; }
        tick = paletteKey = lastEngineTick = undefined;
        cursorPixelsKey = cursorPositionKey = undefined;
        sources.clear(); sourceBytes = 0; surfaceSnapshots.clear(); decoded.clear(); catalog.clear(); variants.clear();
        for (const value of replacements.values()) value.image.close();
        replacements.clear(); latestDraws = []; lastReference = lastPalette = undefined; selected = '';
        original('Original renderer: changing rooms.');
        syncControls();
        if (demo && waitingRoom && waitingRoom !== room) finishRoomLoading();
        if (demo && room === 'Scene1002' && demoHD && !state?.pack) {
          waitingRoom = room;
          demo.onStatus?.('Preparing HD room 2...', undefined, 'room-loading');
        }
        if (room && (demo ? !state?.pack : !state) && !debug && (demo || ['127.0.0.1', 'localhost'].includes(location.hostname))) {
          installPack(demo ? demo.packs[room] : room === 'Scene1002' ? '/__private-room-pack/room2/room-pack.json' : '/__private-room-pack/room-pack.json', true, room).catch(() => {});
        }
      }
      if (demo && backgroundStarted && pack) {
        const state = pack.stats();
        if (state.cacheError || Object.keys(state.errors).length) {
          const failed = roomPacks.get(activeRoom);
          failed.controller.abort(); pack.dispose(); failed.pack = undefined;
          pack = undefined; packEnabled = false; packLoading = false;
          demo.onStatus?.('HD room assets could not be read. Original graphics remain available; re-enter the room to retry.', undefined, 'background');
          finishRoomLoading();
          syncControls();
        }
      }
      if (frame.available && mode === 'proxy' && packEnabled && parityRequired && !frame.reference) frame = reader.read({ reference: true });
      if (!frame.available) {
        parityRequired = true;
        surfaceSnapshots.clear(); lastEngineTick = undefined;
        pack?.observe([]);
        pack?.prefetch([]);
        tick = undefined;
        original(frame.reason);
      } else {
        if (lastEngineTick !== frame.tick) {
          stats.engineFrames++;
          if (lastEngineTick !== undefined) {
            const elapsed = (frame.tick - lastEngineTick) >>> 0;
            if (elapsed > 0 && elapsed < 1000) engineIntervals.push(elapsed);
            if (engineIntervals.length > 240) engineIntervals.shift();
          }
          lastEngineTick = frame.tick;
        }
        if (!debug && (mode === 'original' || (!packEnabled && !replacements.size))) {
          if (mode === 'original' || !demoHD) finishRoomLoading();
          parityRequired = true;
          pack?.observe([]);
          pack?.prefetch([]);
          original('Original selected');
          controls.hidden = demo ? !reader.inRoom : !pack;
          frameRequest = requestAnimationFrame(update);
          return;
        }
        const colors = crc(frame.palette);
        if (frame.tick !== tick || colors !== paletteKey) {
          tick = frame.tick;
          paletteKey = colors;
          const start = performance.now();
          const nextKeys = [];
          const items = frame.items.map(item => {
            const address = item.source.address;
            const source = snapshotSurface(item, frame.tick);
            const key = `${source.rasterKey}-p${colors}-${item.transparent ? item.alphaColor : 'opaque'}`;
            if (!debug && packEnabled && pack) {
              nextKeys.push(...pack.nextKeys(key));
            }
            const captured = catalog.get(key);
            if (captured && !captured.palette.every((value, i) => value === frame.palette[i])) throw new Error('Palette-key collision: original renderer retained.');
            if (!catalog.has(key)) {
              if (catalog.size >= 2048) catalog.delete(catalog.keys().next().value);
              catalog.set(key, { width: source.width, height: source.height, rasterKey: source.rasterKey, palette: Uint8Array.from(frame.palette), transparent: item.transparent, alphaColor: item.alphaColor });
            }
            const known = variants.get(address) || new Set();
            if (known.size < 2048) known.add(source.rasterKey);
            if (!variants.has(address) && variants.size >= 512) variants.delete(variants.keys().next().value);
            variants.set(address, known);
            if (source.width === 72 && source.height === 73) stats.leverVariants = Math.max(stats.leverVariants, known.size);
            return { ...item, source, key, shadow: item.shadow ? intern(item.shadow) : undefined };
          });
          stats.rasterMs = performance.now() - start;
          latestDraws = items.map(item => ({ key: item.key, sourceWidth: item.source.width, sourceHeight: item.source.height, destX: item.destX, destY: item.destY, width: item.width, height: item.height, shadow: Boolean(item.shadow) }));
          let differences = 0;
          const verifyStart = performance.now();
          if (frame.reference) {
            const pixels = composeIndexed(items);
            for (let i = 0; i < pixels.length; i++) if (pixels[i] !== frame.reference[i]) differences++;
            if (!differences) { stats.verified++; parityRequired = false; }
          }
          stats.verifyMs = performance.now() - verifyStart;
          stats.frames++;
          stats.layers = items.length;
          stats.maxDifference = Math.max(stats.maxDifference, differences);
          if (differences) {
            pack?.observe([]);
            stats.mismatches++;
            if (!debug) { mode = 'original'; if (demo) demoHD = false; surfaceSnapshots.clear(); syncControls(); }
            original(`Original fallback: ${differences} indexed pixels differ`);
            finishRoomLoading();
          } else {
            stats.status = `${activeRoom} / ${mode === 'proxy' ? debug ? 'proxy verified' : 'HD' : 'original selected'}`;
            if (mode === 'proxy') {
              const activeReplacements = packEnabled && outputScale === 4 && pack
                ? pack.observe(items.filter(item => !item.shadow).map(item => item.key)) : new Map();
              if (!debug && packEnabled && pack) pack.prefetch(nextKeys);
              if (!packEnabled || outputScale !== 4) pack?.observe([]);
              for (const [key, value] of replacements) activeReplacements.set(key, value);
              const paintStart = performance.now();
              paintFrame(context, items, frame.palette, { scale: outputScale, replacements: activeReplacements, cache: decoded });
              stats.paintMs = performance.now() - paintStart;
              lastReference = outputScale === 1 && !activeReplacements.size ? frame.reference : undefined;
              lastPalette = lastReference ? Uint8Array.from(frame.palette) : undefined;
              stats.outputWidth = output.width;
              stats.outputHeight = output.height;
              const count = items.filter(item => !item.shadow && activeReplacements.has(item.key)).length;
              stats.hdDraws = count;
              if (count) stats.hdFrames++;
              if (waitingRoom === activeRoom && !parityRequired && count && pack?.stats().missKeys.length === 0) finishRoomLoading();
              output.hidden = false;
              canvas.style.opacity = '0';
            } else { pack?.observe([]); original(`${activeRoom} / original selected`); }
          }
          stats.cpuMs = performance.now() - start;
          compositionTime += stats.cpuMs;
          stats.meanCpuMs = compositionTime / stats.frames;
          stats.peakCpuMs = Math.max(stats.peakCpuMs, stats.cpuMs);
          refreshUI(items);
        }
        if (!output.hidden && mode === 'proxy') {
          const cursorStart = performance.now();
          paintCursor(frame);
          stats.cursorMs = performance.now() - cursorStart;
        }
        controls.hidden = debug || (demo ? !reader.inRoom : !pack);
      }
    } catch (error) {
      pack?.observe([]);
      tick = undefined;
      stats.errors++;
      stats.lastError = error.message;
      original(error.message);
      finishRoomLoading();
    }
    if (debug && performance.now() - lastUI > 500) { lastUI = performance.now(); find('proxy-status').textContent = stats.status; }
    frameRequest = requestAnimationFrame(update);
  };

  const unloadPack = () => {
    packController?.abort(); packController = undefined;
    pack?.dispose(); pack = undefined; packEnabled = false; packLoading = false;
    if (activeRoom) roomPacks.set(activeRoom, { enabled: false, loading: false });
    find('proxy-pack-enabled').checked = false; find('proxy-pack-enabled').disabled = true;
    find('proxy-pack-background').disabled = true; find('proxy-pack-background').value = 'original';
    controls.hidden = true;
    tick = undefined;
  };
  const syncControls = () => {
    viewControl.value = (demo ? demoHD : mode === 'proxy' && packEnabled) ? 'hd' : 'original';
    if (backgroundControl) backgroundControl.disabled = viewControl.value !== 'hd';
    find('proxy-pack-enabled').disabled = !pack;
    find('proxy-pack-enabled').checked = packEnabled;
    find('proxy-pack-background').disabled = !pack;
    find('proxy-pack-background').value = pack?.background ?? 'original';
    for (const option of find('proxy-pack-background').options) option.disabled = option.value !== 'original' && !pack?.backgrounds.has(option.value);
    for (const option of backgroundControl?.options ?? []) option.disabled = !pack?.backgrounds.has(option.value);
    if (pack && backgroundControl) {
      const selected = pack.stats().selectedBackground;
      if (selected !== 'original') backgroundControl.value = selected;
    }
  };
  const installPack = async (files, automatic = false, room = activeRoom ?? 'Scene1001') => {
    if (!['Scene1001', 'Scene1002'].includes(room)) throw new Error('Unsupported private pack room.');
    const previous = roomPacks.get(room);
    if (automatic && previous?.loading && !previous.controller.signal.aborted) return previous.promise;
    previous?.controller?.abort(); previous?.pack?.dispose();
    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal });
    const state = { controller, loading: true, enabled: false };
    roomPacks.set(room, state);
    if (activeRoom === room) {
      pack = undefined; packController = controller; packLoading = true; packEnabled = false;
      tick = undefined; original('Original renderer: loading private pack.'); syncControls();
    }
    find('proxy-pack-status').textContent = 'Validating private pack hashes and PNG dimensions locally...';
    state.promise = (async () => {
    try {
      const load = demo ? (await import('./replacement-pack.js')).loadDemoReplacementPackURL : automatic ? loadReplacementPackURL : loadReplacementPack;
      const archive = demo && typeof files === 'object' ? files : undefined;
      const loaded = await load(archive ? archive.url : files, { runtimeSHA256: demo?.sourceRuntimeSHA256 ?? wasmSHA256, signal: controller.signal,
        room: demo ? room : undefined, archive,
        onProgress: (loaded, total, phase) => {
          if (!demo || disposed || controller.signal.aborted) return;
          if (room === 'Scene1001' && !backgroundStarted) demo.onStartupProgress?.(loaded, total, phase);
          else demo.onStatus?.(phase === 'download' ? 'Downloading HD room 2...' : 'Verifying HD room 2 and preparing its cache...',
            phase === 'download' && total ? Math.min(95, loaded / total * 95) : undefined,
            waitingRoom === room ? 'room-loading' : 'background');
        },
        cacheBytes: automatic ? 96 * 1024 ** 2 : undefined,
        onChange: () => { if (!disposed && activeRoom === room && roomPacks.get(room) === state) tick = undefined; } });
      if (disposed || controller.signal.aborted || roomPacks.get(room) !== state) { loaded.dispose(); return; }
      if (loaded.manifest.room !== room) { loaded.dispose(); throw new Error('Private pack does not match the active room.'); }
      if (demo && !loaded.backgrounds.has('gemini')) { loaded.dispose(); throw new Error('Demo HD requires a Gemini background.'); }
      state.pack = loaded; state.loading = false; state.enabled = automatic;
      if (demo && room === 'Scene1002') demo.onStatus?.('HD room 2 is ready.', 100, 'background');
      if (automatic) {
        const background = demo ? 'gemini' : loaded.backgrounds.has('gemini') ? 'gemini' : loaded.backgrounds.keys().next().value;
        if (background) loaded.selectBackground(background);
      }
      if (activeRoom !== room) return loaded.stats();
      pack = loaded; packLoading = false;
      find('proxy-pack-enabled').disabled = false;
      find('proxy-pack-background').disabled = false;
      for (const option of find('proxy-pack-background').options) option.disabled = option.value !== 'original' && !pack.backgrounds.has(option.value);
      find('proxy-pack-status').textContent = `Validated ${pack.entries.size} pack rasters. Experimental candidates are OFF until enabled. Original background selected.`;
      if (automatic) {
        enablePack(demo ? demoHD : true);
      }
      syncControls();
      return pack.stats();
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      state.loading = false;
      state.error = error;
      if (activeRoom === room && roomPacks.get(room) === state) {
        packLoading = false;
        find('proxy-pack-status').textContent = error.message;
      }
      if (demo && room === 'Scene1002') {
        demo.onStatus?.('HD room 2 could not be prepared. It will retry on room entry.', undefined, 'background');
        if (waitingRoom === room) finishRoomLoading();
      }
      throw error;
    }
    })();
    return state.promise;
  };
  const enablePack = enabled => {
    if (enabled && !pack) throw new Error('Load a private pack first.');
    if (enabled && !packEnabled) parityRequired = true;
    packEnabled = Boolean(enabled); find('proxy-pack-enabled').checked = packEnabled;
    const state = roomPacks.get(activeRoom);
    if (state) state.enabled = packEnabled;
    if (packEnabled) { outputScale = 4; find('proxy-scale').value = '4'; }
    else pack?.observe([]);
    tick = undefined;
    syncControls();
  };
  const selectPackBackground = id => {
    if (!pack) throw new Error('Load a private pack first.');
    if (demo && id !== 'gemini') throw new Error('Demo HD requires the Gemini background.');
    pack.selectBackground(id); find('proxy-pack-background').value = id;
    syncControls();
    tick = undefined;
  };
  find('proxy-pack').addEventListener('change', () => { installPack(find('proxy-pack').files).catch(() => {}); });
  find('proxy-pack-enabled').addEventListener('change', () => { enablePack(find('proxy-pack-enabled').checked); canvas.focus(); });
  find('proxy-pack-background').addEventListener('change', () => { selectPackBackground(find('proxy-pack-background').value); canvas.focus(); });
  find('proxy-pack-clear').addEventListener('click', () => {
    unloadPack(); find('proxy-pack').value = '';
    find('proxy-pack-status').textContent = 'Private pack unloaded.'; canvas.focus();
  });
  viewControl.addEventListener('change', () => {
    mode = viewControl.value === 'hd' ? 'proxy' : 'original';
    if (demo) demoHD = mode === 'proxy';
    if (demo && !demoHD) finishRoomLoading();
    if (demo && demoHD && activeRoom === 'Scene1002' && !pack) {
      waitingRoom = activeRoom;
      demo.onStatus?.('Preparing HD room 2...', undefined, 'room-loading');
      installPack(demo.packs[activeRoom], true, activeRoom).catch(() => {});
    }
    parityRequired = true;
    if (mode === 'proxy' && (!demo || pack)) enablePack(true);
    else { if (demo && pack) enablePack(false); original('Original selected'); }
    find('proxy-toggle').textContent = mode === 'proxy' ? 'Use original' : 'Use proxy';
    syncControls(); tick = undefined; canvas.focus();
  });
  backgroundControl?.addEventListener('change', () => {
    selectPackBackground(backgroundControl.value); canvas.focus();
  });
  find('proxy-layer').addEventListener('change', () => { selected = find('proxy-layer').value; });
  find('proxy-scale').addEventListener('change', () => { outputScale = Number(find('proxy-scale').value); tick = undefined; canvas.focus(); });
  find('proxy-toggle').addEventListener('click', () => {
    mode = mode === 'proxy' ? 'original' : 'proxy';
    parityRequired = true;
    find('proxy-toggle').textContent = mode === 'proxy' ? 'Use original' : 'Use proxy';
    tick = undefined;
    if (mode === 'original') original('Original selected');
    syncControls();
    canvas.focus();
  });
  find('proxy-clear').addEventListener('click', () => {
    for (const entry of replacements.values()) entry.image.close();
    replacements.clear();
    tick = undefined;
    find('proxy-import-status').textContent = 'Private replacements cleared.';
    canvas.focus();
  });
  find('proxy-image').addEventListener('change', async () => {
    const entryRoom = activeRoom;
    const key = selected;
    const entry = catalog.get(key);
    const file = find('proxy-image').files[0];
    let image;
    try {
      if (!entry || !file) throw new Error('Select an observed raster and a private PNG.');
      if (file.size > 32 * 1024 ** 2) throw new Error('PNG replacement exceeds 32 MiB.');
      const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer());
      if (disposed || activeRoom !== entryRoom) return;
      const view = new DataView(bytes.buffer);
      if (bytes.length !== 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || view.getUint32(12) !== 0x49484452) throw new Error('Choose a PNG image.');
      const width = view.getUint32(16), height = view.getUint32(20);
      if (width !== entry.width * 4 || height !== entry.height * 4 || width * height > 16 * 1024 ** 2) throw new Error(`Expected a ${entry.width * 4}x${entry.height * 4} PNG for this raster.`);
      const budget = [...replacements.entries()].reduce((total, [id, value]) => total + (id === key ? 0 : value.width * value.height * 4), 0);
      if (budget + width * height * 4 > 64 * 1024 ** 2) throw new Error('The private replacement cache exceeds 64 MiB.');
      image = await createImageBitmap(file);
      if (disposed || activeRoom !== entryRoom) { image.close(); return; }
      replacements.get(key)?.image.close();
      replacements.set(key, { image, width, height, scale: 4 });
      outputScale = 4;
      find('proxy-scale').value = '4';
      tick = undefined;
      find('proxy-import-status').textContent = `Private 4x PNG installed for ${key}.`;
    } catch (error) { image?.close(); if (!disposed) find('proxy-import-status').textContent = error.message; }
    canvas.focus();
  });
  find('proxy-export').addEventListener('click', async () => {
    const entry = catalog.get(selected);
    if (!entry) return;
    const source = sources.get(entry.rasterKey);
    if (!source) { find('proxy-import-status').textContent = 'This raster left the bounded cache. Replay its animation and try again.'; return; }
    const image = new OffscreenCanvas(entry.width, entry.height);
    const ctx = image.getContext('2d');
    const data = ctx.createImageData(entry.width, entry.height);
    for (let y = 0; y < entry.height; y++) for (let x = 0; x < entry.width; x++) {
      const index = source.pixels[y * source.pitch + x];
      const offset = (y * entry.width + x) * 4;
      data.data.set(entry.palette.subarray(index * 4, index * 4 + 3), offset);
      data.data[offset + 3] = entry.transparent && index === entry.alphaColor ? 0 : 255;
    }
    ctx.putImageData(data, 0, 0);
    const blob = await image.convertToBlob({ type: 'image/png' });
    if (disposed) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${selected}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  window.roomRendererPrototype = {
    stats: snapshot,
    resetTimings() { engineIntervals.length = 0; lastEngineTick = undefined; },
    verifyNativeFrame() {
      const frame = reader.read();
      if (!frame.available) throw new Error(frame.reason);
      if (frame.room !== activeRoom) surfaceSnapshots.clear();
      const items = frame.items.map(item => ({ ...item, source: snapshotSurface(item, frame.tick) }));
      const pixels = composeIndexed(items);
      let differences = 0;
      for (let i = 0; i < pixels.length; i++) if (pixels[i] !== frame.reference[i]) differences++;
      return { differingPixels: differences, pixels: pixels.length };
    },
    loadPack: installPack,
    loadPackURL: url => installPack(url, true),
    enablePack,
    selectPackBackground,
    unloadPack,
    layers: () => [...catalog.entries()].map(([key, value]) => ({ key, width: value.width, height: value.height })),
    draws: () => latestDraws.map(value => ({ ...value })),
    verify1x() {
      if (!lastReference || output.hidden || mode !== 'proxy') throw new Error('Select the 1x proxy without replacements first.');
      const actual = context.getImageData(0, 0, 640, 480).data;
      const expected = indicesToRGBA(lastReference, lastPalette);
      let differences = 0;
      for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) differences++;
      return { differingChannels: differences, channels: actual.length };
    },
    output,
    cursorCanvas,
    cursorViewport,
  };
  find('proxy-verify').addEventListener('click', () => {
    try {
      const result = window.roomRendererPrototype.verify1x();
      find('proxy-import-status').textContent = `${result.differingChannels} differing RGBA channels out of ${result.channels}.`;
    } catch (error) { find('proxy-import-status').textContent = error.message; }
  });
  frameRequest = requestAnimationFrame(update);
  let ready = Promise.resolve();
  const startBackgroundLoading = () => {
    if (!demo || disposed || signal?.aborted || backgroundStarted) return;
    backgroundStarted = true;
    // Handle optional-room failures here; entry can retry a failed request.
    return installPack(demo.packs.Scene1002, true, 'Scene1002').catch(() => {});
  };
  if (demo) {
    const assets = [installPack(demo.packs.Scene1001, true, 'Scene1001')];
    if (demo.cursor) assets.push(loadDemoCursor(demo.cursor, { signal: cursorController.signal }).then(value => {
      if (disposed) value.dispose(); else { demoCursor = value; cursorPixelsKey = undefined; }
    }));
    ready = Promise.all(assets);
  } else if (!debug && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
    installPack(new URL('/__private-room-pack/room-pack.json', location.origin).href, true).catch(() => {
      // An unconfigured static/local server simply keeps the original game.
    });
  }
  return {
    ready,
    startBackgroundLoading,
    preferNativeResolution: () => !debug && mode === 'proxy' && packEnabled && reader.inRoom,
    dispose() {
    disposed = true; cancelAnimationFrame(frameRequest);
    cursorController.abort(); demoCursor?.dispose(); signal?.removeEventListener('abort', abortCursor);
    unloadPack();
    for (const state of roomPacks.values()) { state.controller?.abort(); state.pack?.dispose(); }
    roomPacks.clear();
    canvas.removeEventListener('pointerenter', enterCanvas);
    canvas.removeEventListener('pointerleave', leaveCanvas);
    window.removeEventListener('blur', hideCursor);
    window.removeEventListener('resize', resizeLayers);
    canvasObserver.disconnect();
    for (const replacement of replacements.values()) replacement.image.close();
    replacements.clear(); sources.clear(); surfaceSnapshots.clear(); decoded.clear(); catalog.clear(); variants.clear();
    canvas.style.opacity = ''; output.remove(); cursorViewport.remove(); panel.remove(); controls.remove(); delete window.roomRendererPrototype;
  } };
}
