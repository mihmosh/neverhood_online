import { inspectZip, updateCRC32 } from '../lib/zip-validation.js';
import { PACK_LIMITS, validateReplacementManifest, validateImageHeader } from './replacement-pack.js';

export const ROOM_ARCHIVE_LIMITS = Object.freeze({ bytes: 128 * 1024 ** 2 });
const fail = message => { throw new Error(`Room archive: ${message}`); };
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const safePath = path => path.length <= 512 && !/[\\:%?#\x00-\x20\x7f]/.test(path) &&
  path.split('/').every(part => part && part !== '.' && part !== '..');

// Payloads remain views of one bounded archive, never an extracted second store.
export async function validateRoomArchive(bytes, { runtimeSHA256, room, signal } = {}) {
  signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > ROOM_ARCHIVE_LIMITS.bytes) fail('archive byte limit');
  if (!['Scene1001', 'Scene1002'].includes(room)) fail('expected room is required');
  let reads = 0;
  const source = { size: bytes.byteLength, slice(start, end) {
    return { async arrayBuffer() {
      if (++reads % 64 === 0) await yieldTask();
      signal?.throwIfAborted();
      return new Uint8Array(bytes.subarray(start, end)).buffer;
    } };
  } };
  const inspected = await inspectZip(source, { signal, maxInputBytes: ROOM_ARCHIVE_LIMITS.bytes,
    maxEntryBytes: PACK_LIMITS.fileBytes, maxTotalBytes: ROOM_ARCHIVE_LIMITS.bytes, maxEntries: PACK_LIMITS.files,
    select(path, { directory }) {
      if (directory || !safePath(path)) fail('unsafe file path or directory');
      return true;
    } });
  const files = new Map();
  let processed = 0;
  for (const entry of inspected.entries) {
    signal?.throwIfAborted();
    if (entry.method !== 0) fail('only ZIP STORE is supported');
    const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.size);
    let crc = 0xffffffff;
    for (let offset = 0; offset < data.length; offset += 1024 ** 2) {
      signal?.throwIfAborted();
      crc = updateCRC32(crc, data.subarray(offset, offset + 1024 ** 2));
      processed += Math.min(1024 ** 2, data.length - offset);
      if (processed >= 1024 ** 2) { processed = 0; await yieldTask(); }
    }
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail(`CRC mismatch: ${entry.path}`);
    files.set(entry.path, data);
  }
  const manifestBytes = files.get('room-pack.json');
  if (!manifestBytes || manifestBytes.length > PACK_LIMITS.manifest) fail('missing or oversized room-pack.json');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { fail('invalid manifest JSON'); }
  if (manifest?.version !== 2) fail('manifest version 2 required');
  const { entries, backgrounds, descriptors } = validateReplacementManifest(manifest, runtimeSHA256);
  if (manifest.room !== room) fail('manifest room does not match expected room');
  if (!backgrounds.has('gemini')) fail('demo requires a Gemini background');
  if (files.size !== descriptors.length + 1) fail('unreferenced or missing files');
  for (let index = 0; index < descriptors.length; index++) {
    signal?.throwIfAborted();
    const entry = descriptors[index], data = files.get(entry.file);
    if (!data) fail(`missing image: ${entry.file}`);
    const hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    signal?.throwIfAborted();
    if (hash !== entry.sha256) fail(`SHA256 mismatch: ${entry.file}`);
    validateImageHeader(data, entry);
    if (index % 16 === 15) await yieldTask();
  }
  signal?.throwIfAborted();
  files.delete('room-pack.json');
  return { manifest, entries, backgrounds, files };
}
