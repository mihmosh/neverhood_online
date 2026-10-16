export const ZIP_LIMITS = Object.freeze({
  input: 2 * 1024 ** 3,
  output: 2 * 1024 ** 3,
  blb: 512 * 1024 ** 2,
  exe: 512 * 1024 ** 2,
  bin: 1536 * 1024 ** 2,
  entries: 10000,
  directory: 16 * 1024 ** 2,
});

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// ZIP's original character set, indexed by bytes 0x80 through 0xff.
const cp437 = '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5'
  + '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192'
  + '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb'
  + '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510'
  + '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567'
  + '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580'
  + '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229'
  + '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';
const fail = message => { throw new Error(`Invalid ZIP: ${message}`); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function normalizeZipPath(path) {
  if (!path || path.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith('/')) fail('unsafe entry path.');
  const directory = path.endsWith('/');
  const parts = (directory ? path.slice(0, -1) : path).split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.trim() !== part || part.length > 240)) fail('unsafe entry path.');
  return parts.join('/').normalize('NFC') + (directory ? '/' : '');
}

function decodeName(bytes, flags) {
  let name;
  try { name = utf8.decode(bytes); }
  catch {
    if (flags & 0x800) fail('invalid UTF-8 entry name.');
    name = Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]).join('');
  }
  return normalizeZipPath(name);
}

function checkExtra(bytes, nameBytes) {
  const data = view(bytes);
  let unicodePath;
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) fail('truncated extra field.');
    const id = data.getUint16(offset, true);
    const length = data.getUint16(offset + 2, true);
    offset += 4;
    if (offset + length > bytes.length) fail('truncated extra field.');
    if (id === 1) fail('ZIP64 archives are not supported.');
    if (id === 0x7075) {
      if (length < 5) fail('malformed Unicode Path extra field.');
      // Unknown versions and stale CRCs must not override the original filename.
      if (bytes[offset] === 1 && data.getUint32(offset + 1, true) === ((updateCRC32(0xffffffff, nameBytes) ^ 0xffffffff) >>> 0)) {
        let path;
        try { path = utf8.decode(bytes.subarray(offset + 5, offset + length)); }
        catch { fail('invalid UTF-8 Unicode Path extra field.'); }
        path = normalizeZipPath(path);
        if (unicodePath !== undefined && unicodePath !== path) fail('conflicting Unicode Path extra fields.');
        unicodePath = path;
      }
    }
    offset += length;
  }
  return unicodePath;
}

async function readRange(file, start, length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) fail('truncated archive.');
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  if (bytes.length !== length) fail('truncated archive.');
  return bytes;
}

export async function inspectZip(file, { signal, select, maxInputBytes = ZIP_LIMITS.input, maxEntryBytes, maxTotalBytes = ZIP_LIMITS.output, maxEntries = ZIP_LIMITS.entries } = {}) {
  if (!Number.isSafeInteger(file?.size) || file.size < 22 || file.size > maxInputBytes) fail(maxInputBytes === ZIP_LIMITS.input ? 'archive must be between 22 bytes and 2 GiB.' : 'archive exceeds its input limit or is shorter than 22 bytes.');
  signal?.throwIfAborted();
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await readRange(file, tailStart, file.size - tailStart);
  const end = view(tail);
  let offset = tail.length - 22;
  for (; offset >= 0; offset--) {
    if (end.getUint32(offset, true) === 0x06054b50 && offset + 22 + end.getUint16(offset + 20, true) === tail.length) break;
  }
  if (offset < 0) fail('end-of-directory record is missing.');
  const endOffset = tailStart + offset;
  const count = end.getUint16(offset + 10, true);
  const directoryBytes = end.getUint32(offset + 12, true);
  const directoryOffset = end.getUint32(offset + 16, true);
  if (end.getUint16(offset + 4, true) || end.getUint16(offset + 6, true) || end.getUint16(offset + 8, true) !== count) fail('multi-volume archives are not supported.');
  if (count === 65535 || directoryBytes === 0xffffffff || directoryOffset === 0xffffffff || (offset >= 20 && end.getUint32(offset - 20, true) === 0x07064b50)) fail('ZIP64 archives are not supported.');
  if (!count || count > maxEntries) fail(maxEntries === ZIP_LIMITS.entries ? 'archive entry count exceeds the 10,000-entry limit or is empty.' : 'archive entry count exceeds its limit or is empty.');
  if (directoryBytes > ZIP_LIMITS.directory || directoryOffset + directoryBytes !== endOffset) fail('invalid or oversized central directory (ZIP64 is not supported).');
  const bytes = await readRange(file, directoryOffset, directoryBytes);
  const data = view(bytes);
  const entries = [];
  const names = new Set();
  let total = 0;
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted();
    if (cursor + 46 > bytes.length || data.getUint32(cursor, true) !== 0x02014b50) fail('invalid central directory entry.');
    const flags = data.getUint16(cursor + 8, true);
    const method = data.getUint16(cursor + 10, true);
    const crc = data.getUint32(cursor + 16, true);
    const compressed = data.getUint32(cursor + 20, true);
    const size = data.getUint32(cursor + 24, true);
    const nameLength = data.getUint16(cursor + 28, true);
    const extraLength = data.getUint16(cursor + 30, true);
    const commentLength = data.getUint16(cursor + 32, true);
    const localOffset = data.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.length) fail('truncated directory entry.');
    if (flags & ~0x080e || (method === 0 && flags & 6)) fail('encrypted or unsupported entry flags.');
    if (method !== 0 && method !== 8) fail('only stored and deflated entries are supported.');
    if (data.getUint16(cursor + 34, true)) fail('multi-volume entry.');
    if ([size, compressed, localOffset].includes(0xffffffff)) fail('ZIP64 entries are not supported.');
    const mode = data.getUint32(cursor + 38, true) >>> 16;
    if ((mode & 0xf000) && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000) fail('links and special files are not supported.');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawPath = decodeName(nameBytes, flags);
    const unicodePath = checkExtra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), nameBytes);
    if ((flags & 0x800) && unicodePath !== undefined && unicodePath !== rawPath) fail('UTF-8 name and Unicode Path disagree.');
    const path = unicodePath ?? rawPath;
    const aliases = new Set([rawPath, path].map(name => name.replace(/\/$/, '').toLowerCase()));
    for (const key of aliases) {
      if (names.has(key)) fail('duplicate normalized entry paths.');
      names.add(key);
    }
    const extension = /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase();
    const selected = select ? Boolean(select(path, { directory: path.endsWith('/') || (mode & 0xf000) === 0x4000 || Boolean(data.getUint32(cursor + 38, true) & 0x10) }))
      : ['blb', 'exe', 'bin'].includes(extension) && !path.endsWith('/');
    if (method === 0 && compressed !== size) fail('stored entry sizes differ.');
    if (selected) {
      if (!size || size > (maxEntryBytes ?? ZIP_LIMITS[extension] ?? ZIP_LIMITS.blb)) fail(`${path}: selected entry exceeds its size limit or is empty.`);
      total += size;
      if (total > maxTotalBytes) fail(maxTotalBytes === ZIP_LIMITS.output ? 'selected output exceeds 2 GiB.' : 'selected output exceeds its limit.');
      if (size > Math.max(1024 * 1024, compressed * 1000)) fail('suspicious compression ratio.');
    }
    entries.push({ path, nameBytes, flags, method, crc, compressed, size, localOffset, selected });
    cursor = next;
  }
  if (cursor !== bytes.length) fail('unexpected central directory data.');
  // Validate every local header, including ignored files, and forbid overlapping payloads.
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  let previousEnd = 0;
  for (const entry of sorted) {
    signal?.throwIfAborted();
    if (entry.localOffset < previousEnd || entry.localOffset + 30 > directoryOffset) fail('overlapping or invalid local entries.');
    const header = view(await readRange(file, entry.localOffset, 30));
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== entry.flags || header.getUint16(8, true) !== entry.method) fail('local and central headers disagree.');
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    if (nameLength > 4096 || extraLength > 65535) fail('oversized local entry name.');
    const variable = await readRange(file, entry.localOffset + 30, nameLength + extraLength);
    const localName = variable.subarray(0, nameLength);
    if (localName.length !== entry.nameBytes.length || localName.some((byte, index) => byte !== entry.nameBytes[index])) fail('local entry name disagrees with directory.');
    delete entry.nameBytes;
    const localUnicodePath = checkExtra(variable.subarray(nameLength), localName);
    if (localUnicodePath !== undefined && localUnicodePath !== entry.path) fail('local Unicode Path disagrees with directory.');
    if (!(entry.flags & 8) && (header.getUint32(14, true) !== entry.crc || header.getUint32(18, true) !== entry.compressed || header.getUint32(22, true) !== entry.size)) fail('local sizes or CRC disagree with directory.');
    entry.dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    previousEnd = entry.dataOffset + entry.compressed;
    if (entry.flags & 8) {
      const descriptor = view(await readRange(file, previousEnd, 16));
      const start = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0;
      if (descriptor.getUint32(start, true) !== entry.crc || descriptor.getUint32(start + 4, true) !== entry.compressed || descriptor.getUint32(start + 8, true) !== entry.size) fail('invalid data descriptor.');
      previousEnd += start + 12;
    }
    if (previousEnd > directoryOffset) fail('entry overlaps the central directory.');
  }
  const selected = entries.filter(entry => entry.selected);
  if (!selected.length) fail(select ? 'archive contains no selected files.' : 'archive contains no BLB game files or EXE/BIN installer files.');
  return { entries: selected, total, inputBytes: file.size };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function updateCRC32(state, bytes) {
  for (const byte of bytes) state = crcTable[(state ^ byte) & 255] ^ (state >>> 8);
  return state >>> 0;
}
