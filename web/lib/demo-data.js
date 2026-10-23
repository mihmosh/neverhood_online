import { REQUIRED_FILES } from './validation.js';

export const DEMO_LIMITS = Object.freeze({ manifest: 1024 ** 2, file: 512 * 1024 ** 2, total: 768 * 1024 ** 2,
  roomArchive: 128 * 1024 ** 2, losslessRoomArchive: 512 * 1024 ** 2 });
const hashPattern = /^[a-f0-9]{64}$/;
const roomPattern = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/;
const sourceKeyPattern = /^\d{1,4}x\d{1,4}-\d{1,5}-[a-f0-9]{8}-p[a-f0-9]{8}-(?:opaque|\d{1,3})$/;
export const validPaletteProof = proof => proof && typeof proof === 'object' && !Array.isArray(proof) &&
  Object.keys(proof).length === 2 && Array.isArray(proof.indices) && proof.indices.length <= 256 &&
  proof.indices.every((index, offset) => Number.isInteger(index) && index >= 0 && index <= 255 &&
    (offset === 0 || index > proof.indices[offset - 1])) &&
  typeof proof.rgb === 'string' && proof.rgb.length === 6 * proof.indices.length && /^[a-f0-9]*$/.test(proof.rgb);
export const demoPath = path => typeof path === 'string' && path.length <= 256 &&
  !/[\\:%?#\x00-\x20\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

export function demoAddress(value, location = globalThis.location) {
  if (typeof value !== 'string' || /[%\\\x00-\x20\x7f]/.test(value) || /(^|\/)\.{1,2}(\/|$)/.test(value)) throw new Error('Unsafe demo URL.');
  const url = new URL(value, location?.href);
  const local = location && url.origin === location.origin && url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.startsWith('/__private-demo/');
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash ||
      /%|\\/.test(url.pathname)) throw new Error('Demo assets require HTTPS or the same-origin private local demo route.');
  return url;
}

export function demoAssetURL(path, manifestURL) {
  if (!demoPath(path)) throw new Error('Unsafe demo asset path.');
  const base = new URL('.', manifestURL), url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Demo asset escaped its release directory.');
  return url.href;
}

export function validateDemoManifest(manifest, sourceRuntimeSHA256) {
  if (!manifest || ![1, 2].includes(manifest.version) || typeof manifest.id !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(manifest.id) ||
      !hashPattern.test(manifest.sourceRuntimeSHA256) || manifest.sourceRuntimeSHA256 !== sourceRuntimeSHA256 ||
      !Array.isArray(manifest.files) || manifest.files.length !== REQUIRED_FILES.length) throw new Error('Incompatible demo data manifest.');
  const names = new Set(), paths = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    if (!entry || !REQUIRED_FILES.includes(entry.name) || names.has(entry.name) || !demoPath(entry.file) || paths.has(entry.file) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 16 || entry.bytes > DEMO_LIMITS.file || !hashPattern.test(entry.sha256)) throw new Error('Invalid demo game file.');
    names.add(entry.name); paths.add(entry.file); total += entry.bytes;
  }
  const rooms = manifest.fullGame === true ? Object.keys(manifest.packs ?? {}) : ['Scene1001', 'Scene1002'];
  if (total > DEMO_LIMITS.total || !manifest.packs || !demoPath(manifest.cursor) ||
      (manifest.fullGame === true ? manifest.version !== 2 || !rooms.length || rooms.length > 2048 || !manifest.rooms || Object.keys(manifest.rooms).length !== rooms.length : Object.keys(manifest.packs).length !== 2)) throw new Error('Incomplete or oversized demo release.');
  const triggers = new Set();
  for (const room of rooms) {
    if (!roomPattern.test(room)) throw new Error('Invalid demo room identity.');
    if (manifest.fullGame === true) {
      const keys = manifest.rooms[room]?.backgroundKeys;
      if (!Array.isArray(keys) || !keys.length || keys.length > 64 || new Set(keys).size !== keys.length || keys.some(key => !sourceKeyPattern.test(key) || triggers.has(key))) throw new Error('Invalid or ambiguous demo room triggers.');
      for (const key of keys) triggers.add(key);
      const bindings = manifest.rooms[room].backgroundBindings;
      if (bindings !== undefined && (!Array.isArray(bindings) || !bindings.length || bindings.length > 64 ||
          bindings.some(binding => !keys.includes(binding.key) || !validPaletteProof(binding.palette) || !binding.palette.indices.length))) throw new Error('Invalid background palette proof.');
    }
    const entry = manifest.packs[room];
    if (manifest.version === 1 ? !demoPath(entry) : !entry || !demoPath(entry.file) || !entry.file.endsWith('.zip') ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 22 || entry.bytes > (manifest.fullGame === true ? DEMO_LIMITS.losslessRoomArchive : DEMO_LIMITS.roomArchive) || !hashPattern.test(entry.sha256)) throw new Error('Invalid demo room delivery.');
    const path = manifest.version === 1 ? entry : entry.file;
    if (paths.has(path) || path === manifest.cursor || path === 'manifest.json') throw new Error('Duplicate demo asset path.');
    paths.add(path);
  }
  return { ...manifest, totalBytes: total };
}

// One deadline covers headers and body, never the lifetime of a lazy pack.
export async function withDownloadTimeout(signal, timeoutMs = 20000, load) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw new Error('Invalid download timeout.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Download timed out.', 'TimeoutError')), timeoutMs);
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    return await Promise.race([load(controller.signal), cancelled]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export async function fetchDemoBytes(url, { signal, timeoutMs, limit = DEMO_LIMITS.manifest, expectedBytes, sha256, onProgress = () => {}, cache = 'default' } = {}) {
  return withDownloadTimeout(signal, timeoutMs, async signal => {
    signal.throwIfAborted();
    const response = await fetch(url, { signal, credentials: 'omit', mode: 'cors', redirect: 'error', cache });
    if (!response.ok || !response.body) throw new Error(`Demo download failed (HTTP ${response.status}).`);
    const header = response.headers.get('content-length');
    // Content-Length can describe compressed transfer bytes, not Fetch's decoded stream.
    if (header !== null && !/^\d+$/.test(header)) {
      await response.body.cancel(); throw new Error('Demo download has an invalid size.');
    }
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit || expectedBytes !== undefined && length > expectedBytes) throw new Error('Demo download exceeds its declared size.');
        chunks.push(value); onProgress(length);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    signal.throwIfAborted();
    if (!length || expectedBytes !== undefined && length !== expectedBytes) throw new Error('Incomplete demo download.');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (sha256) {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== sha256) throw new Error('Demo SHA256 verification failed.');
    }
    signal.throwIfAborted();
    return bytes;
  });
}

export async function fetchDemoManifest(url, sourceRuntimeSHA256, signal) {
  const address = demoAddress(url);
  const bytes = await fetchDemoBytes(address.href, { signal, cache: 'no-cache' });
  const manifest = validateDemoManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sourceRuntimeSHA256);
  return { ...manifest, manifestURL: address.href };
}
