import { REQUIRED_FILES } from './validation.js';

export const ORIGINAL_BLOCK_BYTES = 65536;
export const STOCK_RUNTIME_SHA256 = '31bdb5fa1afcdf80a6895e2fe5c87a5a999a245af85de7326df20f0756e0d83c';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateOriginalFiles(index, address, files) {
  if (index?.version !== 1 || index.blockSize !== ORIGINAL_BLOCK_BYTES || index.runtimeSHA256 !== STOCK_RUNTIME_SHA256 ||
      !index.files || Object.keys(index.files).length !== REQUIRED_FILES.length) throw new Error('Invalid original streaming index.');
  let total = 0;
  const base = new URL(address);
  for (const name of REQUIRED_FILES) {
    const file = index.files[name], expected = files?.find(entry => entry.name === name);
    if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 16 || file.bytes > 512 * 1024 ** 2 ||
        !hash(file.sha256) || !Array.isArray(file.hashes) || file.hashes.length !== Math.ceil(file.bytes / ORIGINAL_BLOCK_BYTES) ||
        file.hashes.some(value => !hash(value)) || typeof file.url !== 'string' ||
        expected && (expected.bytes !== file.bytes || expected.sha256 !== file.sha256)) throw new Error(`Invalid original file index: ${name}`);
    const url = new URL(file.url, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Original block URL leaves its release origin.');
    total += file.bytes;
  }
  if (total > 1024 ** 3) throw new Error('Oversized original streaming index.');
  return index;
}

export function validateOriginalIndex(index, address, files) {
  validateOriginalFiles(index, address, files);
  validateBlockRefs(index, index.bootstrap);
  validateBlockRefs(index, index.common ?? []);
  if (!index.rooms || Object.keys(index.rooms).length > 2048) throw new Error('Missing original room dependencies.');
  for (const [id, video] of Object.entries(index.videos ?? {})) {
    if (!/^[a-f0-9]{8}$/.test(id)) throw new Error('Invalid original video identity.');
    validateBlockRefs(index, video.blocks);
  }
  for (const [id, room] of Object.entries(index.rooms)) {
    if (!/^\d{4}:\d{1,4}$/.test(id) || !Array.isArray(room.neighbors) || room.neighbors.some(id => !index.rooms[id])) throw new Error('Invalid original room edge.');
    validateBlockRefs(index, room.blocks);
    for (const id of [...(room.videoHashes ?? []), ...(room.entryVideoHashes ?? [])]) if (!index.videos?.[id]) throw new Error('Room references an unknown original video.');
  }
  return index;
}

export function validateBlockRefs(index, refs) {
  if (!Array.isArray(refs) || refs.length > 16384) throw new Error('Invalid original block references.');
  for (const ref of refs) if (!ref || !REQUIRED_FILES.includes(ref.name) || !Number.isSafeInteger(ref.index) || ref.index < 0 ||
    ref.index >= index.files[ref.name].hashes.length) throw new Error('Original block reference is outside its file.');
  return refs;
}

export function installOriginalFiles(FS, index, readBlock, { onRead = () => {}, now = () => performance.now(), waitMs = 60 } = {}) {
  FS.mkdirTree('/game');
  for (const [name, file] of Object.entries(index.files)) {
    const node = FS.create(`/game/${name}`, 0o444);
    node.usedBytes = file.bytes;
    node.stream_ops = { ...node.stream_ops,
      read(stream, destination, offset, length, position) {
        if (![offset, length, position].every(Number.isSafeInteger) || Math.min(offset, length, position) < 0) throw new FS.ErrnoError(28);
        const count = Math.max(0, Math.min(length, file.bytes - position));
        if (offset + count > destination.length) throw new FS.ErrnoError(28);
        const started = now(), blocks = [];
        // Resolve the complete read before changing its destination or stream position.
        for (let done = 0; done < count;) {
          const at = position + done, blockIndex = Math.floor(at / index.blockSize);
          const bytes = readBlock(name, blockIndex, started + waitMs);
          if (!(bytes instanceof Uint8Array) || bytes.length !== Math.min(index.blockSize, file.bytes - blockIndex * index.blockSize)) throw new Error('Truncated verified original block.');
          const within = at % index.blockSize, take = Math.min(count - done, bytes.length - within);
          blocks.push({ bytes, within, take, done }); done += take;
        }
        for (const block of blocks) destination.set(block.bytes.subarray(block.within, block.within + block.take), offset + block.done);
        onRead({ name, position, requested: length, bytes: count, ms: now() - started });
        return count;
      },
      llseek(stream, offset, whence) {
        const position = offset + (whence === 1 ? stream.position : whence === 2 ? file.bytes : 0);
        if (![0, 1, 2].includes(whence) || !Number.isSafeInteger(position) || position < 0) throw new FS.ErrnoError(28);
        return position;
      },
      write() { throw new FS.ErrnoError(69); },
    };
    node.node_ops = { ...node.node_ops, setattr() { throw new FS.ErrnoError(69); } };
  }
}
