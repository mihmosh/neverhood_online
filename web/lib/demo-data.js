import { REQUIRED_FILES } from './validation.js';

export const DEMO_LIMITS = Object.freeze({ manifest: 1024 ** 2, file: 512 * 1024 ** 2, total: 768 * 1024 ** 2, roomArchive: 128 * 1024 ** 2 });
const hashPattern = /^[a-f0-9]{64}$/;
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
  if (total > DEMO_LIMITS.total || !manifest.packs || Object.keys(manifest.packs).length !== 2 || !demoPath(manifest.cursor)) throw new Error('Incomplete or oversized demo release.');
  for (const room of ['Scene1001', 'Scene1002']) {
    const entry = manifest.packs[room];
    if (manifest.version === 1 ? !demoPath(entry) : !entry || !demoPath(entry.file) || !entry.file.endsWith('.zip') ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 22 || entry.bytes > DEMO_LIMITS.roomArchive || !hashPattern.test(entry.sha256)) throw new Error('Invalid demo room delivery.');
    const path = manifest.version === 1 ? entry : entry.file;
    if (paths.has(path) || path === manifest.cursor || path === 'manifest.json') throw new Error('Duplicate demo asset path.');
    paths.add(path);
  }
  return { ...manifest, totalBytes: total };
}

export async function fetchDemoBytes(url, { signal, limit = DEMO_LIMITS.manifest, expectedBytes, sha256, onProgress = () => {}, cache = 'default' } = {}) {
  signal?.throwIfAborted();
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
  signal?.throwIfAborted();
  if (!length || expectedBytes !== undefined && length !== expectedBytes) throw new Error('Incomplete demo download.');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (sha256) {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== sha256) throw new Error('Demo SHA256 verification failed.');
  }
  signal?.throwIfAborted();
  return bytes;
}

export async function fetchDemoManifest(url, sourceRuntimeSHA256, signal) {
  const address = demoAddress(url);
  const bytes = await fetchDemoBytes(address.href, { signal, cache: 'no-cache' });
  const manifest = validateDemoManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), sourceRuntimeSHA256);
  return { ...manifest, manifestURL: address.href };
}
