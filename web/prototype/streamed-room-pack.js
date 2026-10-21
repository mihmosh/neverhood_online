import { demoAddress, demoAssetURL, fetchDemoBytes, demoPath } from '../lib/demo-data.js';
import { updateCRC32 } from '../lib/zip-validation.js';
import { ReplacementPack, PACK_LIMITS, validPackRoom, validateReplacementManifest, validateImageHeader } from './replacement-pack.js';
import { ROOM_ARCHIVE_LIMITS } from './room-archive.js';

const hashPattern = /^[a-f0-9]{64}$/;
const fail = message => { throw new Error(`Streamed HD: ${message}`); };
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const pin = (value, limit) => value && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= limit && hashPattern.test(value.sha256);
const crc = bytes => (updateCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const CACHE_NAME = 'neverhood-streamed-hd-v1';
const DISK_BUDGET = 256 * 1024 ** 2;
let cacheWrites = Promise.resolve();

function cacheWrite(work) {
  const run = () => globalThis.navigator?.locks?.request
    ? navigator.locks.request(`${CACHE_NAME}-write`, work) : work();
  const pending = cacheWrites.then(run, run);
  cacheWrites = pending.catch(() => {});
  return pending;
}

async function boundedBody(response, length, signal, onChunk = () => {}) {
  if (!response.body) fail('missing response body');
  const reader = response.body.getReader(), bytes = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > length) fail('range exceeds declared length');
      bytes.set(value, offset); offset += value.length; onChunk(value.length, offset);
    }
    if (offset !== length) fail('truncated range');
    signal.throwIfAborted();
    return bytes;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

function archiveAddress(value, base, room) {
  const address = new URL(value, base);
  const location = globalThis.location;
  const local = location && address.origin === location.origin && address.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(address.hostname) && address.pathname === `/__stream-hd/${room}.zip`;
  if (local && !address.search && !address.hash && !address.username && !address.password) return address;
  return demoAddress(address.href);
}

export async function loadStreamedDemoReplacementPackURL(url, { runtimeSHA256, room, archive, signal,
  onChange = () => {}, cacheBytes = PACK_LIMITS.cacheBytes, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!validPackRoom(room) || !hashPattern.test(runtimeSHA256) || !pin(archive, ROOM_ARCHIVE_LIMITS.bytes) ||
      !pin(archive.streaming?.index, PACK_LIMITS.manifest)) fail('requires pinned archive and index');
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 1 || cacheBytes > PACK_LIMITS.maxCacheBytes) fail('invalid cache budget');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const active = controller.signal;
  const encoded = new Map();
  let encodedSize = 0, fetchedBytes = 0, imageRequests = 0, rangeRequests = 0, cacheHits = 0, cacheError = null, disk;
  const check = () => active.throwIfAborted();
  const validBytes = async (bytes, meta) => bytes.length === meta.bytes && await digest(bytes) === meta.sha256 &&
    (meta.crc32 === undefined || crc(bytes) === meta.crc32);
  try {
    const base = new URL(url, globalThis.location?.href);
    const descriptor = archive.streaming.index;
    const indexURL = demoAddress(descriptor.url ?? demoAssetURL(descriptor.file, base));
    try { disk = await globalThis.caches?.open(CACHE_NAME); } catch (error) { cacheError = error.message; }
    const cached = async (meta, load) => {
      check();
      const key = new URL(`/__streamed-hd-cache/v1/${runtimeSHA256}/${meta.sha256}`, indexURL.origin).href;
      if (disk) {
        try {
          const response = await disk.match(key);
          if (response) {
            // Reject oversized persisted objects before materializing them.
            if (Number(response.headers.get('content-length')) === meta.bytes) {
              const bytes = await boundedBody(response, meta.bytes, active);
              if (await validBytes(bytes, meta)) { check(); cacheHits++; return bytes; }
            }
            await disk.delete(key);
          }
        } catch (error) {
          check();
          cacheError = error.message;
          try { await disk.delete(key); } catch { /* Cache failure must not prevent verified network repair. */ }
        }
      }
      check();
      const bytes = await load();
      if (!await validBytes(bytes, meta)) fail('member SHA256/CRC or byte mismatch');
      check();
      if (disk) {
        try {
          await cacheWrite(async () => {
            check();
            // This cache is private to this loader. Evict oldest members, never saves or other caches.
            const keys = await disk.keys();
            let total = 0;
            const sizes = [];
            for (const request of keys) {
              const response = await disk.match(request);
              const size = Number(response?.headers.get('content-length'));
              sizes.push([request, Number.isSafeInteger(size) && size > 0 ? size : DISK_BUDGET]);
              total += sizes.at(-1)[1];
            }
            for (const [request, size] of sizes) {
              if (total + bytes.length <= DISK_BUDGET) break;
              await disk.delete(request); total -= size;
            }
            check();
            await disk.put(key, new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
          });
        } catch (error) { cacheError = error.message; }
      }
      check();
      return bytes;
    };
    const indexBytes = await cached(descriptor, async () => {
      const bytes = await fetchDemoBytes(indexURL.href, { signal: active, expectedBytes: descriptor.bytes,
        limit: PACK_LIMITS.manifest, sha256: descriptor.sha256 });
      fetchedBytes += bytes.length; return bytes;
    });
    const index = json(indexBytes);
    if (index.version !== 1 || index.room !== room || index.runtimeSHA256 !== runtimeSHA256 ||
        !pin(index.archive, ROOM_ARCHIVE_LIMITS.bytes) || index.archive.bytes !== archive.bytes || index.archive.sha256 !== archive.sha256 ||
        !pin(index.manifest, PACK_LIMITS.manifest) || !index.members || Array.isArray(index.members) ||
        Object.keys(index.members).length > PACK_LIMITS.files - 1) fail('invalid index identity');
    const source = archiveAddress(index.archive.url, base, room);
    const ranges = [index.manifest, ...Object.values(index.members)];
    for (const meta of ranges) {
      if (!pin(meta, PACK_LIMITS.fileBytes) || !Number.isSafeInteger(meta.offset) || meta.offset < 30 ||
          meta.offset + meta.bytes > archive.bytes || meta.crc32 !== undefined &&
          (!Number.isInteger(meta.crc32) || meta.crc32 < 0 || meta.crc32 > 0xffffffff)) fail('invalid member range');
    }
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].bytes) fail('overlapping member ranges');
    const range = meta => cached(meta, async () => {
      check(); rangeRequests++;
      const end = meta.offset + meta.bytes - 1;
      const response = await fetch(source.href, { signal: active, credentials: 'omit', mode: 'cors', redirect: 'error',
        headers: { Range: `bytes=${meta.offset}-${end}` } });
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${meta.offset}-${end}/${archive.bytes}` ||
          response.headers.get('content-length') !== String(meta.bytes) ||
          ![null, 'identity'].includes(response.headers.get('content-encoding')) || !response.body) {
        await response.body?.cancel(); fail('requires exact uncompressed 206 Content-Range and length');
      }
      return boundedBody(response, meta.bytes, active, (length, offset) => {
        fetchedBytes += length; onProgress(offset, meta.bytes, 'range');
      });
    });
    const manifest = json(await range(index.manifest));
    const validated = validateReplacementManifest(manifest, runtimeSHA256);
    if (manifest.room !== room || manifest.version !== 2 || manifest.lossless !== true) fail('lossless source room mismatch');
    if (Object.keys(index.members).length !== validated.descriptors.length) fail('member count mismatch');
    for (const image of validated.descriptors) {
      if (!demoPath(image.file) || !Object.hasOwn(index.members, image.file) || index.members[image.file].sha256 !== image.sha256) fail('image pin mismatch');
    }
    const files = new Map(validated.descriptors.map(image => [image.file, image]));
    const decode = async image => {
      check();
      let bytes = encoded.get(image.file);
      if (bytes) { encoded.delete(image.file); encoded.set(image.file, bytes); }
      else {
        imageRequests++;
        bytes = await range(index.members[image.file]);
        check(); validateImageHeader(bytes, image);
        while (encodedSize + bytes.length > PACK_LIMITS.encodedCacheBytes && encoded.size) {
          const first = encoded.keys().next().value;
          encodedSize -= encoded.get(first).length; encoded.delete(first);
        }
        if (bytes.length <= PACK_LIMITS.encodedCacheBytes) { encoded.set(image.file, bytes); encodedSize += bytes.length; }
      }
      check();
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    };
    check();
    const pack = new ReplacementPack({ manifest, ...validated, files, decode, onChange, cacheBytes, encodedBytes: 0, signal });
    const dispose = pack.dispose.bind(pack), stats = pack.stats.bind(pack);
    pack.stats = () => ({ ...stats(), streaming: true, fullArchiveVerified: false, encodedCacheBytes: encodedSize,
      retainedEncodedBytes: encodedSize, fetchedBytes, imageRequests, rangeRequests, archiveRequests: 0, archiveBytes: 0,
      persistent: Boolean(disk), persistentCacheHit: cacheHits > 0, cacheHits, cacheError });
    pack.dispose = () => { controller.abort(); signal?.removeEventListener('abort', abort); dispose(); encoded.clear(); encodedSize = 0; };
    return pack;
  } catch (error) { controller.abort(); signal?.removeEventListener('abort', abort); encoded.clear(); throw error; }
}
