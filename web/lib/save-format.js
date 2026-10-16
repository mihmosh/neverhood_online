import { Inflate, zipSync } from '../vendor/fflate-0.8.2.js';
import { inspectZip, updateCRC32 } from './zip-validation.js';

export const MAX_SAVE_BYTES = 4 * 1024 ** 2;
export const MAX_BATCH_BYTES = 32 * 1024 ** 2;
const MAX_SLOTS = 1000;
const MAX_ZIP_BYTES = MAX_BATCH_BYTES + 1024 ** 2;
const fail = message => { throw new Error(`Invalid save: ${message}`); };
const crc32 = bytes => (updateCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

function saveName(name) {
  const match = /^([a-z0-9][a-z0-9_-]*)\.(\d{3})$/i.exec(name);
  if (!match) fail('expected a flat target.### filename with a slot from 000 to 999.');
  const slot = Number(match[2]);
  return { name: `neverhood.${match[2]}`, slot };
}

function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_SAVE_BYTES) fail('file must contain 1 byte to 4 MiB.');
}

async function saveBody(bytes) {
  checkBytes(bytes);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (bytes.length < 18) fail('truncated gzip stream.');
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8);
  const size = trailer.getUint32(4, true);
  if (!size || size > MAX_SAVE_BYTES) fail('gzip uncompressed size exceeds 4 MiB or is empty.');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_SAVE_BYTES || length > size) fail('gzip decompressed data exceeds its size limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw new Error(`Invalid save: gzip decompression failed: ${error.message}`);
  } finally { reader.releaseLock(); }
  if (length !== size) fail('gzip ISIZE mismatch.');
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  if (crc32(body) !== trailer.getUint32(0, true)) fail('gzip CRC32 mismatch.');
  return body;
}

function inspectBody(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (offset, size) => { if (offset + size > bytes.length) fail('truncated save structure.'); };
  need(0, 5);
  const version = data.getUint32(0, true);
  if (version !== 0) fail('unsupported Neverhood save version.');
  const descriptionLength = bytes[4];
  need(5, descriptionLength + 14);
  const description = new TextDecoder().decode(bytes.subarray(5, 5 + descriptionLength));
  let offset = 5 + descriptionLength;
  const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag !== 'THMB' && tag !== 'BMHT') fail('missing thumbnail header.');
  const thumbnailSize = data.getUint32(offset + 4);
  const thumbnailVersion = bytes[offset + 8];
  if (thumbnailVersion !== 1 && thumbnailVersion !== 2) fail('unsupported thumbnail version.');
  const headerSize = thumbnailVersion === 2 ? 22 : 14;
  need(offset, headerSize);
  const width = data.getUint16(offset + 9);
  const height = data.getUint16(offset + 11);
  const bpp = bytes[offset + 13];
  if (!width || !height || (bpp !== 2 && bpp !== 4) || (thumbnailVersion === 1 && bpp !== 2)
      || thumbnailSize !== headerSize + width * height * bpp) fail('invalid thumbnail dimensions or size.');
  if (thumbnailVersion === 2) {
    for (let channel = 0; channel < 4; channel++) {
      const loss = bytes[offset + 14 + channel];
      const shift = bytes[offset + 18 + channel];
      if (loss > 8 || shift + 8 - loss > bpp * 8) fail('invalid thumbnail pixel format.');
    }
  }
  need(offset, thumbnailSize + 17 + 4);
  offset += thumbnailSize + 17;
  const count = data.getUint32(offset, true);
  offset += 4;
  if (!count || count > 32768) fail('invalid game variable count.');
  need(offset, count * 12);
  if (offset + count * 12 !== bytes.length) fail('unexpected trailing save data.');
  const edges = Array.from({ length: count }, (_, index) => {
    const first = data.getInt16(offset + index * 12 + 8, true);
    const next = data.getInt16(offset + index * 12 + 10, true);
    for (const reference of [first, next]) if (reference < -1 || reference >= count) fail('invalid game variable reference.');
    return [first, next];
  });
  // Iterative DFS bounds both work and stack usage for hostile variable graphs.
  const state = new Uint8Array(count);
  for (let root = 0; root < count; root++) {
    if (state[root]) continue;
    const stack = [[root, 0]];
    state[root] = 1;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame[1] === 2) { state[frame[0]] = 2; stack.pop(); continue; }
      const child = edges[frame[0]][frame[1]++];
      if (child === -1) continue;
      if (state[child] === 1) fail('cyclic game variable references.');
      if (!state[child]) { state[child] = 1; stack.push([child, 0]); }
    }
  }
  return { description, version };
}

export async function inspectSaveBytes(bytes) {
  return inspectBody(await saveBody(bytes));
}

async function extractEntry(file, entry) {
  const result = new Uint8Array(entry.size);
  let written = 0;
  let ended = false;
  const write = (bytes, final) => {
    if (written + bytes.length > result.length) fail('ZIP output exceeds declared size.');
    result.set(bytes, written);
    written += bytes.length;
    ended ||= final;
  };
  const inflater = entry.method === 8 ? new Inflate(write) : null;
  // Small input chunks bound synchronous inflater allocations before the output check.
  for (let offset = 0; offset < entry.compressed; offset += 65536) {
    const end = Math.min(offset + 65536, entry.compressed);
    const bytes = new Uint8Array(await file.slice(entry.dataOffset + offset, entry.dataOffset + end).arrayBuffer());
    if (bytes.length !== end - offset) fail('truncated ZIP payload.');
    for (let cursor = 0; cursor < bytes.length; cursor += 256) {
      const next = Math.min(cursor + 256, bytes.length);
      const final = offset + next === entry.compressed;
      if (inflater) inflater.push(bytes.subarray(cursor, next), final); else write(bytes.subarray(cursor, next), final);
    }
  }
  if (!ended || written !== entry.size || crc32(result) !== entry.crc) fail('ZIP size or CRC32 mismatch.');
  return result;
}

export async function readSaveFiles(files) {
  const inputs = Array.from(files ?? []);
  if (!inputs.length || inputs.length > MAX_SLOTS) fail('select 1 to 1000 save files or one ZIP backup.');
  let entries;
  if (inputs.length === 1 && /\.zip$/i.test(inputs[0].name)) {
    const file = inputs[0];
    const plan = await inspectZip(file, {
      select: (path, { directory }) => {
        if (directory) fail('ZIP backups must contain only flat save files, not directories.');
        saveName(path);
        return true;
      },
      maxInputBytes: MAX_ZIP_BYTES, maxEntryBytes: MAX_SAVE_BYTES,
      maxTotalBytes: MAX_BATCH_BYTES, maxEntries: MAX_SLOTS,
    });
    entries = plan.entries.map(entry => ({ ...saveName(entry.path), read: () => extractEntry(file, entry) }));
  } else {
    let total = 0;
    entries = inputs.map(file => {
      const name = saveName(file.name);
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_SAVE_BYTES) fail('file exceeds 4 MiB or is empty.');
      total += file.size;
      if (total > MAX_BATCH_BYTES) fail('batch exceeds 32 MiB.');
      return { ...name, read: async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== file.size) fail('truncated file input.');
        return bytes;
      } };
    });
  }
  const slots = new Set();
  for (const { slot } of entries) {
    if (slots.has(slot)) fail('duplicate save slots, including different target prefixes.');
    slots.add(slot);
  }
  const records = [];
  let total = 0;
  for (const entry of entries) {
    const bytes = await entry.read();
    const body = await saveBody(bytes);
    total += body.length;
    if (total > MAX_BATCH_BYTES) fail('uncompressed batch exceeds 32 MiB.');
    const { description } = inspectBody(body);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    records.push({ name: entry.name, slot: entry.slot, description, bytes, sha256 });
  }
  return records.sort((a, b) => a.slot - b.slot);
}

export async function createSaveBackup(records) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_SLOTS) fail('backup requires 1 to 1000 saves.');
  const files = Object.create(null);
  let total = 0;
  for (const record of records) {
    const { name } = saveName(record.name);
    if (Object.hasOwn(files, name)) fail('duplicate save slots.');
    checkBytes(record.bytes);
    total += record.bytes.length;
    if (total > MAX_BATCH_BYTES) fail('batch exceeds 32 MiB.');
    files[name] = record.bytes;
  }
  return zipSync(files, { level: 0 });
}
