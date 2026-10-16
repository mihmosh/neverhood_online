export const REQUIRED_FILES = ['a.blb', 'c.blb', 'hd.blb', 'i.blb', 'm.blb', 's.blb', 't.blb'];
export const ENGLISH_HD_SIZE = 4279716;

export function selectArchives(files) {
  const selected = new Map();
  const errors = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!REQUIRED_FILES.includes(name)) {
      errors.push(`Unexpected file: ${file.name}. Select only the seven BLB archives.`);
    } else if (selected.has(name)) {
      errors.push(`Duplicate file: ${name}.`);
    } else {
      selected.set(name, file);
    }
  }
  const missing = REQUIRED_FILES.filter(name => !selected.has(name));
  if (missing.length) errors.push(`Missing: ${missing.join(', ')}.`);
  return { files: REQUIRED_FILES.filter(name => selected.has(name)).map(name => ({ name, file: selected.get(name) })), errors };
}

export function validateHeader(bytes, size, name) {
  if (bytes.byteLength < 16 || size < 16) throw new Error(`${name}: BLB header is too short.`);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== 0x02004940 || header.getUint16(4, true) !== 7) {
    throw new Error(`${name}: invalid BLB signature.`);
  }
  if (header.getUint32(8, true) !== size) throw new Error(`${name}: size does not match the header.`);
  const count = header.getUint32(12, true);
  if (!count || 16 + count * 24 + header.getUint16(6, true) > size) {
    throw new Error(`${name}: invalid BLB table size.`);
  }
}

export async function validateArchives(files) {
  const selection = selectArchives(files);
  if (selection.errors.length) throw new Error(selection.errors.join('\n'));
  for (const { name, file } of selection.files) {
    // Only the fixed header is buffered, never the full archive.
    validateHeader(new Uint8Array(await file.slice(0, 16).arrayBuffer()), file.size, name);
  }
  const hd = selection.files.find(entry => entry.name === 'hd.blb').file;
  return {
    files: selection.files,
    total: selection.files.reduce((sum, entry) => sum + entry.file.size, 0),
    warning: editionWarning(hd.size),
  };
}

export function editionWarning(hdSize) {
  return hdSize === ENGLISH_HD_SIZE
    ? 'The hd.blb size matches the known English edition. Contents and checksums have not been verified.'
    : 'The hd.blb size differs from the known English edition. This may be another version; compatibility is unconfirmed.';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit) + ' ' + ['B', 'KiB', 'MiB', 'GiB'][unit];
}
