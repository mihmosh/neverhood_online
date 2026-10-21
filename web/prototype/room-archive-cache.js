import { PACK_LIMITS, validateReplacementManifest, validateImageHeader } from './replacement-pack.js';

const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value));
const parseJSON = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

async function readResponse(response, limit, signal) {
  if (!response?.ok || !response.body) throw new Error('Missing cached room resource');
  const reader = response.body.getReader(), chunks = [];
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Cached room resource exceeds its size limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

// A unique generation prevents an interrupted/concurrent writer from deleting a
// different writer's completed cache. The tiny index is published last.
export async function loadRoomArchiveCache({ archive, room, runtimeSHA256, signal, onProgress = () => {}, load }) {
  signal?.throwIfAborted();
  const base = `neverhood-room-v1-${room}-${archive.sha256}`;
  const origin = globalThis.location?.origin || 'https://neverhood.invalid';
  const root = `${origin}/__neverhood_room_cache__/${room}/${archive.sha256}/`;
  const key = path => root + path;
  let storage;
  try { storage = globalThis.caches; } catch { /* Restricted browser storage. */ }
  if (!storage) return { ...await load(), persistent: false, persistentCacheHit: false };
  let index;
  try { index = await storage.open(base); }
  catch { signal?.throwIfAborted(); return { ...await load(), persistent: false, persistentCacheHit: false }; }

  const run = async () => {
    signal?.throwIfAborted();
    let cache, marker, manifest, validated;
    try {
      const pointer = parseJSON(await readResponse(await index.match(key('index')), 1024, signal));
      if (typeof pointer.generation !== 'string' || !pointer.generation.startsWith(base + '-') ||
          !/^[a-zA-Z0-9-]+$/.test(pointer.generation) || pointer.generation.length > base.length + 80) throw new Error('Invalid cache generation');
      cache = await storage.open(pointer.generation);
      marker = parseJSON(await readResponse(await cache.match(key('complete')), PACK_LIMITS.manifest, signal));
      if (marker.version !== 1 || marker.room !== room || marker.sourceRuntimeSHA256 !== runtimeSHA256 ||
          marker.archiveSHA256 !== archive.sha256 || marker.archiveBytes !== archive.bytes ||
          !Array.isArray(marker.files) || marker.files.length > PACK_LIMITS.files - 1) throw new Error('Incompatible cached room');
      const bytes = await readResponse(await cache.match(key('room-pack.json')), PACK_LIMITS.manifest, signal);
      if (await digest(bytes) !== marker.manifestSHA256) throw new Error('Cached manifest SHA256 mismatch');
      signal?.throwIfAborted();
      manifest = parseJSON(bytes);
      if (manifest.version !== 2 || manifest.room !== room) throw new Error('Invalid cached manifest');
      validated = validateReplacementManifest(manifest, runtimeSHA256);
      if ((!validated.backgrounds.has('gemini') && manifest.lossless !== true) || marker.files.length !== validated.descriptors.length) throw new Error('Invalid cached membership');
      const expected = new Set([key('complete'), key('room-pack.json')]);
      let total = 0;
      const sizes = new Map();
      for (const stored of marker.files) {
        if (!stored || typeof stored.file !== 'string' || sizes.has(stored.file) || !Number.isSafeInteger(stored.bytes) ||
            stored.bytes < 1 || stored.bytes > PACK_LIMITS.fileBytes) throw new Error('Invalid cached image size');
        total += stored.bytes; sizes.set(stored.file, stored.bytes);
      }
      for (const entry of validated.descriptors) {
        if (!sizes.has(entry.file)) throw new Error('Invalid cached membership');
        expected.add(key('images/' + entry.file));
      }
      if (total > archive.bytes) throw new Error('Invalid cached room size');
      const keys = await cache.keys();
      if (keys.length !== expected.size || keys.some(request => !expected.has(request.url))) throw new Error('Incomplete cached room');
      marker = { ...marker, sizes };
    } catch {
      signal?.throwIfAborted();
      cache = null;
    }
    if (cache) {
      onProgress(archive.bytes, archive.bytes, 'cached');
      return persistentResult(cache, manifest, validated, marker.sizes, true);
    }

    const result = await load();
    signal?.throwIfAborted();
    const generation = `${base}-${crypto.randomUUID()}`;
    let stage, committed = false;
    try {
      stage = await storage.open(generation);
      const manifestBytes = jsonBytes(result.manifest), sizes = new Map();
      const manifestSHA256 = await digest(manifestBytes);
      let stored = 0;
      onProgress(0, result.files.size, 'cache');
      for (const [path, bytes] of result.files) {
        signal?.throwIfAborted();
        await stage.put(key('images/' + path), new Response(bytes, { headers: { 'content-type': path.endsWith('.png') ? 'image/png' : 'image/webp' } }));
        sizes.set(path, bytes.byteLength);
        signal?.throwIfAborted();
        onProgress(++stored, result.files.size, 'cache');
      }
      await stage.put(key('room-pack.json'), new Response(manifestBytes, { headers: { 'content-type': 'application/json' } }));
      signal?.throwIfAborted();
      const complete = { version: 1, room, sourceRuntimeSHA256: runtimeSHA256, archiveSHA256: archive.sha256,
        archiveBytes: archive.bytes, manifestSHA256,
        files: [...sizes].map(([file, bytes]) => ({ file, bytes })) };
      await stage.put(key('complete'), new Response(jsonBytes(complete)));
      signal?.throwIfAborted();
      await index.put(key('index'), new Response(jsonBytes({ generation })));
      signal?.throwIfAborted();
      committed = true;
      result.files.clear();
      return persistentResult(stage, result.manifest, result, sizes, false);
    } catch (error) {
      if (signal?.aborted) { result.files.clear(); throw error; }
      return { ...result, persistent: false, persistentCacheHit: false };
    } finally {
      if (!committed) await storage.delete(generation).catch(() => {});
    }
  };

  function persistentResult(cache, manifest, validated, sizes, hit) {
    return { manifest, entries: validated.entries, backgrounds: validated.backgrounds,
      files: new Map(validated.descriptors ? validated.descriptors.map(entry => [entry.file, entry]) :
        manifest.images.map(entry => [entry.file, entry])), persistent: true, persistentCacheHit: hit,
      async read(entry) {
        try {
          signal?.throwIfAborted();
          const bytes = await readResponse(await cache.match(key('images/' + entry.file)), sizes.get(entry.file), signal);
          if (bytes.length !== sizes.get(entry.file) || await digest(bytes) !== entry.sha256) throw new Error('Cached image SHA256 or size mismatch');
          signal?.throwIfAborted();
          validateImageHeader(bytes, entry);
          return bytes;
        } catch (error) {
          signal?.throwIfAborted();
          await cache.delete(key('complete')).catch(() => {});
          throw new Error(`HD room cache is missing or corrupt (${entry.file}). Restart the demo to download it again.`, { cause: error });
        }
      } };
  }

  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  let entered = false;
  try { return await locks.request(base, { mode: 'exclusive', signal }, () => { entered = true; return run(); }); }
  catch (error) {
    signal?.throwIfAborted();
    if (entered) throw error;
    return run();
  }
}
