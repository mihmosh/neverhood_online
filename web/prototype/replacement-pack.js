import { demoAddress, fetchDemoBytes, validPaletteProof as proofShape } from '../lib/demo-data.js';

// Private candidates retain their local-only loader; demo delivery is explicit.
export const PACK_LIMITS = Object.freeze({ files: 8192, entries: 8192, manifest: 16 * 1024 ** 2,
  fileBytes: 32 * 1024 ** 2, encodedBytes: 512 * 1024 ** 2, cacheBytes: 96 * 1024 ** 2, maxCacheBytes: 192 * 1024 ** 2,
  pixels: 16 * 1024 ** 2, dimension: 8192, concurrent: 2, encodedCacheBytes: 32 * 1024 ** 2 });

const hashPattern = /^[a-f0-9]{64}$/;
const keyPattern = /^([1-9]\d*)x([1-9]\d*)-([1-9]\d*)-([a-f0-9]{8})-p([a-f0-9]{8})-(opaque|0|[1-9]\d{0,2})$/;
const fail = message => { throw new Error(`Private pack: ${message}`); };
const checkAbort = signal => { if (signal?.aborted) throw new DOMException('Pack selection cancelled', 'AbortError'); };
const validPath = path => typeof path === 'string' && path.length <= 512 &&
  !/[\\:%?#\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
const hash = async bytes => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const resource = entry => entry.imageResource ?? entry;
const decodedSize = entry => { const image = resource(entry); return image.crop ?? image; };
const decodedBytes = entry => { const size = decodedSize(entry); return size.width * size.height * 4; };
const decodeBitmap = (file, entry) => {
  const crop = resource(entry).crop;
  return crop ? createImageBitmap(file, crop.x, crop.y, crop.width, crop.height) : createImageBitmap(file);
};

export function paletteProofMatches(proof, palette) {
  if (!proofShape(proof) || !(palette instanceof Uint8Array) || palette.length !== 1024) return false;
  for (let offset = 0; offset < proof.indices.length; offset++) {
    for (let channel = 0; channel < 3; channel++) {
      if (palette[proof.indices[offset] * 4 + channel] !== parseInt(proof.rgb.slice(offset * 6 + channel * 2, offset * 6 + channel * 2 + 2), 16)) return false;
    }
  }
  return true;
}

const paletteIndependentKey = key => typeof key === 'string' && keyPattern.test(key) ? key.replace(/-p[a-f0-9]{8}-/, '-') : undefined;
const replacementIdentity = entry => JSON.stringify([entry.file, resource(entry).sha256, entry.width, entry.height,
  entry.crop ? [entry.crop.x, entry.crop.y, entry.crop.width, entry.crop.height] : null, entry.flipX ?? false]);

function dimensions(key) {
  const match = typeof key === 'string' && keyPattern.exec(key);
  if (!match) fail('invalid source key');
  const [width, height, pitch] = match.slice(1, 4).map(Number);
  if (width > 4096 || height > 4096 || pitch < width || pitch > 8192 || pitch * height > 8 * 1024 ** 2 ||
      (match[6] !== 'opaque' && Number(match[6]) > 255)) fail('source key bounds');
  return { width: width * 4, height: height * 4 };
}

export function validateImageHeader(bytes, entry, totalBytes = bytes.byteLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.format === 'webp') {
    const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (bytes.length < 25 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== totalBytes) fail('expected bounded WebP RIFF');
    const chunk = tag(12), length = view.getUint32(16, true);
    if (length + 20 > totalBytes) fail('WebP chunk bounds');
    let width, height;
    if (chunk === 'VP8X' && length === 10 && bytes.length >= 30) {
      if (bytes[20] & 2) fail('animated WebP is not a frame resource');
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === 'VP8 ' && length >= 10 && bytes.length >= 30 && !(bytes[20] & 1) && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    } else if (chunk === 'VP8L' && length >= 5 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    } else fail('unsupported WebP frame header');
    if (width !== entry.width || height !== entry.height) fail('WebP dimensions differ from image resource');
    return;
  }
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) fail('expected PNG IHDR');
  if (view.getUint32(16) !== entry.width || view.getUint32(20) !== entry.height) fail('PNG dimensions differ from manifest/source key');
}

// Hash all referenced encoded files before installing a pack, but decode only on demand.
export async function loadReplacementPack(selection, { runtimeSHA256, signal, decode = decodeBitmap,
  onChange = () => {}, cacheBytes = PACK_LIMITS.cacheBytes } = {}) {
  checkAbort(signal);
  const files = Array.from(selection);
  if (!files.length || files.length > PACK_LIMITS.files) fail('file count limit');
  const paths = files.map(file => file.webkitRelativePath || file.name);
  if (paths.some(path => !validPath(path))) fail('unsafe selected path');
  const root = paths[0].includes('/') ? paths[0].split('/')[0] + '/' : '';
  const local = new Map();
  let encodedBytes = 0;
  files.forEach((file, index) => {
    const path = paths[index];
    if (root && !path.startsWith(root)) fail('select one directory');
    const relative = path.slice(root.length);
    if (!validPath(relative) || local.has(relative)) fail('duplicate or unsafe selected path');
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > PACK_LIMITS.fileBytes) fail('encoded file size limit');
    encodedBytes += file.size;
    if (encodedBytes > PACK_LIMITS.encodedBytes) fail('encoded byte limit');
    if (relative !== 'room-pack.json' && !/\.(png|webp)$/.test(relative)) fail('only PNG/WebP files and room-pack.json are allowed');
    local.set(relative, file);
  });
  const manifestFile = local.get('room-pack.json');
  if (!manifestFile || manifestFile.size > PACK_LIMITS.manifest) fail('missing or oversized room-pack.json');
  let manifest;
  try { manifest = JSON.parse(await manifestFile.text()); } catch { fail('invalid manifest JSON'); }
  checkAbort(signal);
  const { entries, backgrounds, descriptors } = validateReplacementManifest(manifest, runtimeSHA256);
  for (const entry of descriptors) {
    if (!local.has(entry.file)) fail('unsafe or missing PNG file');
    checkAbort(signal);
    const bytes = new Uint8Array(await local.get(entry.file).arrayBuffer());
    checkAbort(signal);
    if (bytes.byteLength !== local.get(entry.file).size || await hash(bytes) !== entry.sha256) fail(`SHA256 mismatch: ${entry.file}`);
    checkAbort(signal);
    validateImageHeader(bytes, entry);
  }
  checkAbort(signal);
  return new ReplacementPack({ manifest, entries, backgrounds, files: local, decode, onChange, cacheBytes, encodedBytes, signal });
}

export function validateReplacementManifest(manifest, runtimeSHA256) {
  if (!manifest || ![1, 2].includes(manifest.version) || manifest.private !== true || manifest.scale !== 4 ||
      !(manifest.version === 2 && manifest.lossless === true ? validPackRoom(manifest.room) : ['Scene1001', 'Scene1002'].includes(manifest.room))) fail('unsupported manifest schema');
  const shared = manifest.version === 2;
  const proofs = manifest.paletteProofs;
  if (proofs !== undefined && (!shared || manifest.lossless !== true || !proofs || typeof proofs !== 'object' || Array.isArray(proofs) ||
      Object.keys(proofs).length > PACK_LIMITS.entries || Object.entries(proofs).some(([id, proof]) => !hashPattern.test(id) || !proofShape(proof)))) fail('invalid paletteProofs');
  if (shared && (!Array.isArray(manifest.images) || !manifest.images.length || manifest.images.length > PACK_LIMITS.files - 1)) fail('unsupported image resource schema');
  if (!hashPattern.test(manifest.runtimeSHA256) || manifest.runtimeSHA256 !== runtimeSHA256) fail('runtime SHA256 mismatch');
  if (!(typeof manifest.sourceBinding === 'string' && manifest.sourceBinding.length ||
      manifest.sourceBinding && typeof manifest.sourceBinding === 'object' && !Array.isArray(manifest.sourceBinding)) ||
      JSON.stringify(manifest.sourceBinding).length > 65536) fail('missing or oversized sourceBinding catalog');
  if (!Array.isArray(manifest.entries) || manifest.entries.length > PACK_LIMITS.entries ||
      !Array.isArray(manifest.backgrounds) || manifest.backgrounds.length > 2) fail('entry/background count limit');
  if (manifest.coverage !== undefined && (!manifest.coverage || typeof manifest.coverage !== 'object' || Array.isArray(manifest.coverage))) fail('invalid coverage');
  const entries = new Map(), backgrounds = new Map(), usedFiles = new Set();
  const descriptors = [];
  const images = new Map(), referenced = new Set();
  if (shared) for (const image of manifest.images) {
    const format = manifest.lossless === true ? 'png' : 'webp';
    if (!image || !hashPattern.test(image.id) || images.has(image.id) || image.format !== format ||
        !validPath(image.file) || !image.file.endsWith(`.${format}`) || usedFiles.has(image.file) || !hashPattern.test(image.sha256) ||
        ![image.width, image.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= PACK_LIMITS.dimension) ||
        image.width * image.height > PACK_LIMITS.pixels || image.crop !== undefined) fail('invalid/duplicate image resource');
    const value = { id: image.id, file: image.file, format: image.format, sha256: image.sha256, width: image.width, height: image.height };
    images.set(image.id, value); usedFiles.add(image.file); descriptors.push(value);
  }
  const add = (entry, background) => {
    if (!entry || typeof entry !== 'object') fail('invalid entry');
    if (entry.paletteProof !== undefined && (!shared || manifest.lossless !== true ||
        typeof entry.paletteProof !== 'string' || !hashPattern.test(entry.paletteProof) ||
        !proofs || !Object.hasOwn(proofs, entry.paletteProof))) fail('invalid or missing paletteProof reference');
    const expected = dimensions(entry.key);
    if (entry.scale !== 4 || entry.width !== expected.width || entry.height !== expected.height ||
        entry.width > PACK_LIMITS.dimension || entry.height > PACK_LIMITS.dimension ||
        entry.width * entry.height > PACK_LIMITS.pixels) fail('entry dimension/scale bounds');
    if (entry.crop !== undefined) {
      const crop = entry.crop;
      if (!crop || typeof crop !== 'object' || Array.isArray(crop) ||
          !['x', 'y', 'width', 'height'].every(field => Number.isSafeInteger(crop[field])) ||
          crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
          crop.x + crop.width > entry.width || crop.y + crop.height > entry.height) fail('invalid crop bounds');
    }
    if (shared) {
      const image = images.get(entry.image);
      if (!image || !entry.crop || typeof entry.flipX !== 'boolean' ||
          entry.crop.width !== image.width || entry.crop.height !== image.height || entry.file !== undefined || entry.sha256 !== undefined) fail('invalid shared image binding');
      referenced.add(entry.image);
      entry = { ...entry, file: image.file, imageResource: image };
    } else {
      if (entry.imageResource !== undefined || entry.image !== undefined || entry.flipX !== undefined ||
          (entry.format !== undefined && entry.format !== 'png')) fail('unexpected image resource in PNG v1 binding');
      if (!validPath(entry.file) || !entry.file.endsWith('.png')) fail('unsafe or missing PNG file');
      if (!hashPattern.test(entry.sha256)) fail('invalid PNG SHA256');
      if (usedFiles.has(entry.file)) fail('duplicate PNG file');
      usedFiles.add(entry.file); descriptors.push(entry);
    }
    if (background) {
      if (!['gemini', 'realesrnet'].includes(entry.id) || backgrounds.has(entry.id) ||
          typeof entry.label !== 'string' || !entry.label.length || entry.label.length > 128 ||
          entry.width !== 2560 || entry.height !== 1920) fail('invalid/duplicate background');
      backgrounds.set(entry.id, entry);
    } else {
      if (entries.has(entry.key) || !['sprite', 'layer'].includes(entry.kind) ||
          !hashPattern.test(entry.sourceSHA256) || !metadata(entry.resource) || !metadata(entry.frameId, true)) fail('invalid/duplicate sprite or layer');
      entries.set(entry.key, entry);
    }
  };
  manifest.entries.forEach(entry => add(entry, false));
  manifest.backgrounds.forEach(entry => add(entry, true));
  const backgroundKeys = new Set([...backgrounds.values()].map(entry => entry.key));
  if (backgroundKeys.size > 1 || [...backgroundKeys].some(key => entries.has(key))) fail('background variants must share a distinct source key');
  if (shared && referenced.size !== images.size) fail('unreferenced image resource');
  for (const entry of [...entries.values(), ...backgrounds.values()]) {
    if (entry.nextKeys !== undefined && (!Array.isArray(entry.nextKeys) || entry.nextKeys.length > 4 ||
        new Set(entry.nextKeys).size !== entry.nextKeys.length || entry.nextKeys.some(key => !entries.has(key)))) fail('invalid nextKeys hints');
  }
  return { entries, backgrounds, descriptors };
}

export const validPackRoom = room => typeof room === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(room);

async function fetchBytes(url, limit, signal, remote = false) {
  checkAbort(signal);
  const response = await fetch(url, { signal, credentials: 'omit', cache: remote ? 'default' : 'no-store', redirect: 'error', mode: remote ? 'cors' : 'same-origin' });
  if (!response.ok) fail(`HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    fail('encoded file size limit');
  }
  if (!response.body) fail('missing response body');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) fail('encoded file size limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  checkAbort(signal);
  if (!length || declared !== null && Number(declared) !== length) fail('encoded file size mismatch');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function loadReplacementPackURL(url, { runtimeSHA256, signal, onChange = () => {},
  cacheBytes = PACK_LIMITS.cacheBytes } = {}) {
  checkAbort(signal);
  const location = globalThis.location;
  const address = new URL(url, location?.href);
  // Never turn a manifest into a network/proxy API, even on another loopback port.
  if (!location || address.origin !== location.origin || address.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(address.hostname) || address.username || address.password ||
      !['/__private-room-pack/room-pack.json', '/__private-room-pack/room2/room-pack.json'].includes(address.pathname) || address.search || address.hash ||
       ![address.href, address.pathname].includes(String(url))) fail('URL must be the same-origin loopback private pack manifest');
  return loadURLPack(address, { runtimeSHA256, signal, onChange, cacheBytes,
    expectedRoom: address.pathname === '/__private-room-pack/room2/room-pack.json' ? 'Scene1002' : 'Scene1001' });
}

export async function loadDemoReplacementPackURL(url, { runtimeSHA256, signal, onChange = () => {},
  cacheBytes = PACK_LIMITS.cacheBytes, room, archive, onProgress = () => {} } = {}) {
  checkAbort(signal);
  const address = demoAddress(url);
  if (archive !== undefined) return loadArchivePack(address, { runtimeSHA256, signal, onChange, cacheBytes, room, archive, onProgress });
  return loadURLPack(address, { runtimeSHA256, signal, onChange, cacheBytes, expectedRoom: room, remote: true });
}

async function loadArchivePack(address, { runtimeSHA256, signal, onChange, cacheBytes, room, archive, onProgress }) {
  const { ROOM_ARCHIVE_LIMITS, validateRoomArchive } = await import('./room-archive.js');
  const { loadRoomArchiveCache } = await import('./room-archive-cache.js');
  checkAbort(signal);
  if (!archive || !Number.isSafeInteger(archive.bytes) || archive.bytes < 22 || archive.bytes > ROOM_ARCHIVE_LIMITS.bytes ||
      !hashPattern.test(archive.sha256)) fail('archive requires pinned bytes and SHA256');
  if (!validPackRoom(room)) fail('archive requires an expected room');
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 1 || cacheBytes > PACK_LIMITS.maxCacheBytes) fail('invalid cache budget');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let files;
  try {
    checkAbort(signal);
    let archiveRequests = 0, archiveBytes = 0, cacheError = null;
    const validated = await loadRoomArchiveCache({ archive, room, runtimeSHA256, signal: controller.signal, onProgress,
      load: async () => {
        archiveRequests++;
        onProgress(0, archive.bytes, 'download');
        const bytes = await fetchDemoBytes(address.href, { signal: controller.signal, limit: ROOM_ARCHIVE_LIMITS.bytes,
          expectedBytes: archive.bytes, sha256: archive.sha256,
          onProgress: loaded => onProgress(loaded, archive.bytes, 'download') });
        archiveBytes += bytes.length;
        onProgress(0, archive.bytes, 'verify');
        const result = await validateRoomArchive(bytes, { runtimeSHA256, room, signal: controller.signal });
        onProgress(archive.bytes, archive.bytes, 'verify');
        return result;
      } });
    files = validated.files;
    const decode = (data, entry) => {
      checkAbort(controller.signal);
      if (validated.read) return validated.read(data).then(bytes => {
        checkAbort(controller.signal);
        return createImageBitmap(new Blob([bytes], { type: resource(entry).format === 'png' ? 'image/png' : 'image/webp' }));
      }).catch(error => {
        if (!controller.signal.aborted) { cacheError = error.message; onChange(); }
        throw error;
      });
      return createImageBitmap(new Blob([data], { type: resource(entry).format === 'png' ? 'image/png' : 'image/webp' }));
    };
    const pack = new ReplacementPack({ ...validated, decode, onChange, cacheBytes,
      encodedBytes: validated.persistent ? 0 : archive.bytes, signal });
    const dispose = pack.dispose.bind(pack), stats = pack.stats.bind(pack);
    pack.stats = () => ({ ...stats(), encodedCacheBytes: pack.encodedBytes, retainedEncodedBytes: pack.encodedBytes,
      fetchedBytes: archiveBytes, imageRequests: 0, archiveRequests, archiveBytes,
      persistent: validated.persistent, persistentCacheHit: validated.persistentCacheHit, cacheError });
    pack.dispose = () => {
      controller.abort(); signal?.removeEventListener('abort', abort); dispose();
      pack.encodedBytes = 0; pack.pending.clear(); pack.failed.clear(); pack.prefetching.clear();
    };
    checkAbort(signal);
    return pack;
  } catch (error) {
    controller.abort(); signal?.removeEventListener('abort', abort); files?.clear(); throw error;
  }
}

async function loadURLPack(address, { runtimeSHA256, signal, onChange, cacheBytes, expectedRoom, remote = false }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const bytes = await fetchBytes(address.href, PACK_LIMITS.manifest, controller.signal, remote);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid manifest JSON'); }
    const { entries, backgrounds, descriptors } = validateReplacementManifest(manifest, runtimeSHA256);
    if (expectedRoom && manifest.room !== expectedRoom) fail('manifest room does not match URL');
    if (remote && !backgrounds.has('gemini')) fail('demo requires a Gemini background');
    checkAbort(controller.signal);
    const files = new Map(descriptors.map(entry => [entry.file, entry]));
    const encoded = new Map();
    let encodedSize = 0, fetchedBytes = 0, imageRequests = 0;
    const decode = async entry => {
      let bytes = encoded.get(entry.file);
      if (bytes) { encoded.delete(entry.file); encoded.set(entry.file, bytes); }
      else {
        bytes = await fetchBytes(new URL(entry.file, address).href, PACK_LIMITS.fileBytes, controller.signal, remote);
        fetchedBytes += bytes.byteLength; imageRequests++;
        validateImageHeader(bytes, entry);
        if (await hash(bytes) !== entry.sha256) fail(`SHA256 mismatch: ${entry.file}`);
        checkAbort(controller.signal);
        while (encodedSize + bytes.byteLength > PACK_LIMITS.encodedCacheBytes && encoded.size) {
          const first = encoded.keys().next().value;
          encodedSize -= encoded.get(first).byteLength; encoded.delete(first);
        }
        encoded.set(entry.file, bytes); encodedSize += bytes.byteLength;
      }
      checkAbort(controller.signal);
      return decodeBitmap(new Blob([bytes], { type: entry.format === 'webp' ? 'image/webp' : 'image/png' }), entry);
    };
    const pack = new ReplacementPack({ manifest, entries, backgrounds, files, decode, onChange, cacheBytes,
      encodedBytes: 0, signal });
    const dispose = pack.dispose.bind(pack);
    const stats = pack.stats.bind(pack);
    pack.stats = () => ({ ...stats(), encodedCacheBytes: encodedSize, fetchedBytes, imageRequests });
    pack.dispose = () => { controller.abort(); signal?.removeEventListener('abort', abort); dispose(); encoded.clear(); encodedSize = 0; };
    return pack;
  } catch (error) {
    controller.abort(); signal?.removeEventListener('abort', abort); throw error;
  }
}

function metadata(value, nullable = false) {
  return nullable && value === null || typeof value === 'string' && value.length > 0 && value.length <= 256 ||
    Number.isSafeInteger(value) && value >= 0;
}

export class ReplacementPack {
  constructor({ manifest, entries, backgrounds, files, decode, onChange, cacheBytes, encodedBytes, signal }) {
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 1 || cacheBytes > PACK_LIMITS.maxCacheBytes) fail('invalid cache budget');
    Object.assign(this, { manifest, entries, backgrounds, files, decode, onChange, budget: cacheBytes, encodedBytes });
    this.cache = new Map(); this.pending = new Map(); this.failed = new Map(); this.wanted = new Map(); this.queue = new Map();
    this.hints = new Map(); this.prefetching = new Set();
    this.bytes = 0; this.active = 0; this.disposed = false; this.background = 'original';
    this.hits = []; this.misses = [];
    this.paletteCandidates = new Map();
    for (const entry of [...entries.values(), ...backgrounds.values()]) {
      if (entry.paletteProof === undefined) continue;
      const shape = paletteIndependentKey(entry.key);
      if (!this.paletteCandidates.has(shape)) this.paletteCandidates.set(shape, new Set());
      this.paletteCandidates.get(shape).add(entry.key);
    }
    this.abort = () => this.dispose(); this.signal = signal;
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.dispose();
  }

  selectBackground(id) {
    if (id !== 'original' && !this.backgrounds.has(id)) fail('unknown background variant');
    this.background = id;
    this.wanted.clear(); this.queue.clear(); this.hints.clear();
    this.onChange();
  }

  entryFor(key) {
    const background = this.backgrounds.get(this.background);
    return background?.key === key ? background : this.entries.get(key);
  }

  resolveKey(rawKey, palette) {
    if (this.disposed) return undefined;
    const exact = this.entryFor(rawKey);
    if (exact && exact.paletteProof === undefined) return rawKey;
    let canonical, identity;
    for (const key of this.paletteCandidates.get(paletteIndependentKey(rawKey)) ?? []) {
      const entry = this.entryFor(key);
      if (!entry || entry.paletteProof === undefined || !paletteProofMatches(this.manifest.paletteProofs?.[entry.paletteProof], palette)) continue;
      const candidate = replacementIdentity(entry);
      // Even an exact palette CRC cannot disambiguate conflicting proved replacements.
      if (canonical !== undefined && candidate !== identity) return undefined;
      if (canonical === undefined) { canonical = key; identity = candidate; }
    }
    return canonical;
  }

  observe(keys) {
    const result = new Map();
    this.wanted.clear(); this.queue.clear(); this.hits = []; this.misses = [];
    if (this.disposed) return result;
    for (const key of new Set(keys)) {
      const entry = this.entryFor(key);
      if (!entry) { this.misses.push(key); continue; }
      this.wanted.set(entry.file, entry);
      const value = this.cache.get(entry.file);
      if (value) {
        this.cache.delete(entry.file); this.cache.set(entry.file, value);
        result.set(key, entry.imageResource ? { image: value.image, width: entry.width, height: entry.height,
          scale: 4, crop: entry.crop, flipX: entry.flipX } : value); this.hits.push(key);
      } else {
        this.misses.push(key);
        if (!this.pending.has(entry.file) && !this.failed.has(entry.file)) this.queue.set(entry.file, entry);
      }
    }
    this.queueHints();
    this.pump();
    return result;
  }

  nextKeys(key) {
    return [...(this.entries.get(key)?.nextKeys ?? [])];
  }

  prefetch(keys) {
    this.hints.clear();
    for (const file of this.queue.keys()) if (!this.wanted.has(file)) this.queue.delete(file);
    if (this.disposed) return;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) this.hints.set(entry.file, entry);
      if (this.hints.size >= 8) break;
    }
    this.queueHints();
    this.pump();
  }

  queueHints() {
    for (const [file, entry] of this.hints) {
      if (!this.cache.has(file) && !this.pending.has(file) && !this.failed.has(file)) this.queue.set(file, entry);
    }
  }

  hintFits(entry) {
    let protectedBytes = 0;
    for (const value of this.wanted.values()) protectedBytes += decodedBytes(value);
    const pinned = this.backgrounds.get(this.background)?.file;
    const background = this.cache.get(pinned);
    if (background && !this.wanted.has(pinned)) protectedBytes += decodedBytes(background);
    return protectedBytes + decodedBytes(entry) <= this.budget;
  }

  pump() {
    if (this.disposed) return;
    // Demand first. Only one speculative worker, leaving the second available for a newly visible frame.
    const queued = [...this.queue].sort(([a], [b]) => Number(this.wanted.has(b)) - Number(this.wanted.has(a)));
    for (const [file, entry] of queued) {
      if (this.active >= PACK_LIMITS.concurrent) break;
      const speculative = !this.wanted.has(file);
      if (speculative && (!this.hints.has(file) || !this.hintFits(entry))) { this.queue.delete(file); continue; }
      if (speculative && this.prefetching.size) continue;
      this.queue.delete(file);
      if (this.cache.has(file) || this.pending.has(file) || this.failed.has(file)) continue;
      if (decodedBytes(entry) > this.budget) { this.failed.set(file, 'Image exceeds decoded cache budget'); continue; }
      this.active++;
      if (speculative) this.prefetching.add(file);
      const work = Promise.resolve().then(() => this.disposed ? null : this.decode(this.files.get(file), entry)).then(image => {
        if (!image) return;
        if (this.disposed) { image.close(); return; }
        const size = decodedSize(entry);
        if (image.width !== size.width || image.height !== size.height) { image.close(); throw new Error('Decoded PNG dimensions differ'); }
        const bytes = decodedBytes(entry);
        const hint = speculative && !this.wanted.has(file);
        if (hint && (!this.hints.has(file) || !this.hintFits(entry))) { image.close(); return; }
        // Keep the currently selected background resident when evicting animation frames.
        const pinned = this.backgrounds.get(this.background)?.file;
        while (this.bytes + bytes > this.budget && this.cache.size) {
          const old = [...this.cache.keys()].find(key => key !== pinned && (!hint || !this.wanted.has(key))) ??
            (hint ? undefined : this.cache.keys().next().value);
          if (old === undefined) { image.close(); return; }
          const value = this.cache.get(old);
          value.image.close(); this.bytes -= decodedBytes(value); this.cache.delete(old);
        }
        const value = { image, width: entry.width, height: entry.height, scale: 4,
          ...(entry.crop ? { crop: { ...entry.crop } } : {}), ...(entry.imageResource ? { imageResource: entry.imageResource } : {}) };
        // Speculative images enter at the cold end, below any actually observed image.
        if (hint) this.cache = new Map([[file, value], ...this.cache]);
        else this.cache.set(file, value);
        this.bytes += bytes;
      }).catch(error => { if (!this.disposed) this.failed.set(file, error.message); }).finally(() => {
        this.pending.delete(file); this.prefetching.delete(file); this.active--;
        if (!this.disposed) { if (this.wanted.has(file)) this.onChange(); this.pump(); }
      });
      this.pending.set(file, work);
    }
  }

  stats() {
    return { loaded: !this.disposed, room: this.manifest.room, runtimeSHA256: this.manifest.runtimeSHA256,
      sourceBinding: this.manifest.sourceBinding, entries: this.entries.size, backgrounds: [...this.backgrounds.keys()],
      selectedBackground: this.background, pendingLoads: this.pending.size,
      queuedLoads: this.queue.size,
      cacheBytes: this.bytes, cacheEntries: this.cache.size, encodedBytes: this.encodedBytes,
      hitKeys: [...this.hits], missKeys: [...this.misses], hits: this.hits.length, misses: this.misses.length,
      errors: Object.fromEntries(this.failed) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.signal?.removeEventListener('abort', this.abort);
    for (const value of this.cache.values()) value.image.close();
    this.cache.clear(); this.wanted.clear(); this.queue.clear(); this.hints.clear(); this.files.clear(); this.bytes = 0;
    this.hits = []; this.misses = [];
  }
}
