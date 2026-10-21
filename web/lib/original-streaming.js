import { fetchDemoBytes, demoAssetURL } from './demo-data.js';
import { ORIGINAL_BLOCK_BYTES, validateOriginalIndex, installOriginalFiles } from './original-streaming-fs.js';
import { createNativeRoomReader } from './original-streaming-state.js';

export async function createOriginalStreaming({ module, manifest, signal, onProgress = () => {}, onFatal, memoryBytes = 128 * 1024 ** 2 }) {
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw new Error('Room streaming requires a cross-origin isolated page. The full download was not started.');
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < ORIGINAL_BLOCK_BYTES || memoryBytes > 256 * 1024 ** 2) throw new Error('Invalid original streaming memory budget.');
  const source = manifest.streaming?.index;
  if (manifest.streaming?.version !== 1 || !source) throw new Error('Missing original streaming contract.');
  const address = demoAssetURL(source.file, manifest.manifestURL);
  const bytes = await fetchDemoBytes(address, { signal, limit: 16 * 1024 ** 2, expectedBytes: source.bytes, sha256: source.sha256 });
  const index = validateOriginalIndex(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), address, manifest.files);
  const abiResponse = await fetch(new URL('../prototype/render-abi.json', import.meta.url), { signal });
  if (!abiResponse.ok) throw new Error('Native streaming observer ABI is unavailable.');
  const nativeRoom = createNativeRoomReader(module, await abiResponse.json());
  signal?.throwIfAborted();
  const worker = new Worker(new URL('../workers/original-bytes.js', import.meta.url), { type: 'module' });
  const pending = new Map(), memory = new Map(), reads = new Map();
  const stats = { mode: 'room-streaming', indexBytes: bytes.length, memoryBytes: 0, maxMemoryBytes: 0,
    memoryHits: 0, synchronousMisses: 0, maxReadMs: 0, maxWaitMs: 0, reads: 0, readyRooms: [], terminal: false };
  let serial = 0, disposed = false, protectedHashes = new Set(), currentRoom, generation = 0, enteredGame = false;
  const transitions = [];
  const hashFor = ref => index.files[ref.name].hashes[ref.index];
  const request = (type, payload) => new Promise((resolve, reject) => {
    if (disposed) return reject(new Error('Original streaming session closed.'));
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Original byte worker did not respond. Retry the session.')); }, 20000);
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage({ type, id, ...payload }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  worker.onmessage = ({ data }) => {
    if (disposed) return;
    Object.assign(stats, data.stats ?? {});
    if (data.cacheError) stats.cacheError = data.cacheError;
    const entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error)); else entry.resolve(data);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; generation++; worker.terminate(); memory.clear(); stats.memoryBytes = 0;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Original streaming session closed.')); }
    pending.clear(); signal?.removeEventListener('abort', dispose);
  };
  signal?.addEventListener('abort', dispose, { once: true });
  worker.onerror = event => {
    if (disposed) return;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(event.message || 'Original byte worker failed.')); }
    pending.clear(); fail(new Error(event.message || 'Original byte worker failed.'));
  };
  const retain = (hash, bytes) => {
    if (memory.has(hash)) return;
    for (const [key, entry] of memory) {
      if (stats.memoryBytes + bytes.length <= memoryBytes) break;
      if (!protectedHashes.has(key)) { memory.delete(key); stats.memoryBytes -= entry.length; }
    }
    if (stats.memoryBytes + bytes.length > memoryBytes) throw new Error('Active room originals exceed the streaming memory budget.');
    memory.set(hash, bytes); stats.memoryBytes += bytes.length;
    stats.maxMemoryBytes = Math.max(stats.maxMemoryBytes, stats.memoryBytes);
  };
  const prefetch = async (refs, label = 'room', isCurrent = () => true) => {
    const unique = [...new Map(refs.map(ref => [hashFor(ref), ref])).values()];
    let at = 0, completed = 0;
    async function run() {
      while (at < unique.length && !disposed && isCurrent()) {
        const ref = unique[at++], hash = hashFor(ref);
        if (!memory.has(hash)) {
          const result = await request('prefetch', ref);
          if (disposed) throw new Error('Original streaming cancelled.');
          if (isCurrent() || protectedHashes.has(hash)) retain(hash, new Uint8Array(result.bytes));
        }
        completed++; onProgress(completed / Math.max(1, unique.length), `Preparing original ${label} data...`);
      }
    }
    await Promise.all(Array.from({ length: navigator.connection?.saveData ? 1 : 4 }, run));
  };
  const fail = error => {
    if (!stats.terminal) {
      stats.terminal = true; stats.error = error.message;
      module.pauseMainLoop?.(); dispose();
      try { onFatal(error); } finally { globalThis.abort(`Original streaming stopped: ${error.message}`); }
    }
    throw error;
  };
  const readBlock = (name, number, deadline) => {
    if (disposed || stats.terminal) throw new Error('Original streaming session is terminal.');
    const hash = index.files[name].hashes[number], cached = memory.get(hash);
    if (cached) { stats.memoryHits++; memory.delete(hash); memory.set(hash, cached); return cached; }
    stats.synchronousMisses++;
    stats.lastMiss = { name, index: number, room: currentRoom };
    const started = performance.now(), sab = new SharedArrayBuffer(ORIGINAL_BLOCK_BYTES + 32), header = new Int32Array(sab, 0, 8);
    worker.postMessage({ type: 'read', name, index: number, sab });
    let spins = 0, state;
    while ((state = Atomics.load(header, 0)) === 0) {
      if ((++spins & 1023) === 0 && performance.now() >= deadline) return fail(new Error(`Original block was not ready (${name}:${number}). Retry the session; no partial read was returned.`));
    }
    stats.maxWaitMs = Math.max(stats.maxWaitMs, performance.now() - started);
    if (state !== 1) return fail(new Error(new TextDecoder().decode(new Uint8Array(sab, 32, header[1]))));
    const bytes = new Uint8Array(sab, 32, header[1]).slice();
    try { retain(hash, bytes); } catch (error) { return fail(error); }
    return bytes;
  };
  const setRoom = async id => {
    const room = index.rooms[id];
    if (!room) return;
    const ticket = ++generation;
    // Entry bytes must be prefetched; this does not suspend or retry a native read.
    stats.loadingBoundary = 'input-gate-and-prefetched-neighbors';
    currentRoom = id; stats.currentRoom = id; stats.preparing = true; stats.prefetchError = undefined;
    const videoBlocks = hashes => (hashes ?? []).flatMap(hash => index.videos[hash].blocks);
    const refs = [...index.bootstrap, ...(index.common ?? []), ...room.blocks, ...videoBlocks(room.videoHashes)];
    const neighbors = room.neighbors.flatMap(id => {
      const target = index.rooms[id];
      const entries = (room.neighborEntries ?? []).filter(entry => entry.room === id).flatMap(entry => entry.entryVideoHashes ?? []);
      return [...target.blocks, ...videoBlocks(entries.length ? entries : target.entryVideoHashes ?? target.videoHashes)];
    });
    const needed = new Map([...refs, ...neighbors].map(ref => [hashFor(ref), ref]));
    const neededBytes = [...needed.values()].reduce((sum, ref) => sum + Math.min(index.blockSize,
      index.files[ref.name].bytes - ref.index * index.blockSize), 0);
    if (neededBytes > memoryBytes) throw new Error('Current room and its entry barriers exceed the original memory budget.');
    if (!enteredGame && neededBytes > 32 * 1024 ** 2) throw new Error('The original startup bundle exceeds the 32 MiB fast-start budget.');
    protectedHashes = new Set(needed.keys());
    worker.postMessage({ type: 'protect', hashes: [...protectedHashes] });
    const isCurrent = () => ticket === generation;
    await prefetch(refs, id, isCurrent);
    if (ticket !== generation || disposed) return;
    await prefetch(neighbors, 'neighbor', isCurrent);
    if (ticket === generation) {
      stats.readyRooms = [...new Set([id, ...room.neighbors])].filter(id => index.rooms[id].blocks.every(ref => memory.has(hashFor(ref))));
      stats.readyVideos = Object.entries(index.videos ?? {}).filter(([, video]) => video.blocks.every(ref => memory.has(hashFor(ref)))).map(([hash]) => hash);
      stats.preparing = false;
      const predictedVideos = [...new Set(room.neighbors.flatMap(id => index.rooms[id].videoHashes ?? []))];
      const speculative = videoBlocks(predictedVideos).filter(ref => !memory.has(hashFor(ref)));
      stats.backgroundVideoPrefetch = speculative.length > 0;
      if (speculative.length) prefetch(speculative, 'neighbor video', isCurrent).then(() => {
        if (!isCurrent() || disposed) return;
        stats.backgroundVideoPrefetch = false;
        stats.readyVideos = Object.entries(index.videos ?? {}).filter(([, video]) => video.blocks.every(ref => memory.has(hashFor(ref)))).map(([hash]) => hash);
      }).catch(error => {
        if (!isCurrent() || disposed) return;
        stats.backgroundVideoPrefetch = false; stats.speculativeVideoError = error.message;
      });
    }
  };
  try {
    if (typeof globalThis.abort !== 'function' || typeof module.pauseMainLoop !== 'function') throw new Error('The stock runtime loading boundary is unavailable.');
    const byteIndex = { version: index.version, blockSize: index.blockSize, runtimeSHA256: index.runtimeSHA256,
      files: Object.fromEntries(Object.entries(index.files).map(([name, file]) => [name,
        { bytes: file.bytes, sha256: file.sha256, url: file.url, hashes: file.hashes }])) };
    await request('init', { index: byteIndex, address });
    await setRoom('1000:0');
    installOriginalFiles(module.FS, index, readBlock, { onRead: read => {
      stats.reads++; stats.maxReadMs = Math.max(stats.maxReadMs, read.ms);
      const key = `${currentRoom}/${read.name}/${read.position}/${read.bytes}`, previous = reads.get(key);
      reads.delete(key);
      reads.set(key, { ...read, room: currentRoom, observations: (previous?.observations ?? 0) + 1, ms: Math.max(read.ms, previous?.ms ?? 0) });
      if (reads.size > 8192) reads.delete(reads.keys().next().value);
    } });
  } catch (error) { dispose(); throw error; }
  return { index, setRoom, prefetch, dispose, currentRoom: () => currentRoom,
    enterRoom(hdRoom, nativeModule) {
      const prefix = /^Module\d{4}$/.test(nativeModule) ? `${nativeModule.slice(6)}:` : null;
      const id = Object.keys(index.rooms).find(id => (index.rooms[id].hdRoom === hdRoom || index.rooms[id].hdRooms?.includes(hdRoom)) && (!prefix || id.startsWith(prefix)));
      if (!id || id === currentRoom) return Promise.resolve();
      return setRoom(id).catch(error => { stats.prefetchError = error.message; throw error; });
    },
    observe() {
      if (disposed) return null;
      const state = nativeRoom();
      if (!state) return null;
      stats.native = state;
      if (state.id === '1000:0') enteredGame = true;
      if (!enteredGame || state.menu) return null;
      const last = transitions.at(-1);
      if (!last || last.id !== state.id || last.smacker !== state.smacker) {
        transitions.push({ ...state, time: performance.now() });
        if (transitions.length > 128) transitions.shift();
      }
      if (!index.rooms[state.id] || state.id === currentRoom) return null;
      return setRoom(state.id).catch(error => { stats.prefetchError = error.message; throw error; });
    },
    retry: () => setRoom(currentRoom).catch(error => { stats.prefetchError = error.message; throw error; }),
    neighborHDRooms: () => [...new Set((index.rooms[currentRoom]?.neighbors ?? []).filter(id => id !== currentRoom)
      .flatMap(id => index.rooms[id].hdRooms ?? [index.rooms[id].hdRoom]).filter(Boolean))].slice(0, 4),
    trace: () => [...reads.values()].map(read => ({ ...read })),
    stats: () => ({ ...stats, transitions: transitions.map(state => ({ ...state })), readyRooms: [...stats.readyRooms], pending: pending.size }) };
}
