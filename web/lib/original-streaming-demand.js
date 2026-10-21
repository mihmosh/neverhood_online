export function demandWindow(index, name, number, read, maximumBytes = 32 * 1024 ** 2) {
  const file = index.files[name], blockSize = index.blockSize;
  let first = number, last = number;
  const position = read?.position ?? number * blockSize;
  const length = read?.length ?? Math.min(blockSize, file.bytes - position);
  const resources = (file.resources ?? []).filter(resource => resource.bytes > 0 && resource.compression !== 0x65 &&
    resource.offset < position + length && resource.offset + resource.bytes > position);
  if (resources.length) {
    first = Math.min(number, ...resources.map(resource => Math.floor(resource.offset / blockSize)));
    last = Math.max(number, ...resources.map(resource => Math.floor(Math.min(file.bytes - 1, resource.offset + resource.bytes + 4095) / blockSize)));
  } else {
    last = Math.min(file.hashes.length - 1, number + 7);
  }
  const maximumBlocks = Math.max(1, Math.floor(maximumBytes / blockSize));
  if (last - first + 1 > maximumBlocks) {
    first = Math.max(first, number);
    last = Math.min(last, first + maximumBlocks - 1);
  }
  return { name, first, last };
}
