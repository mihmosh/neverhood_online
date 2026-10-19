// Independent local format tooling; upstream ScummVM is only a read-only reference.
import { deflateSync } from 'node:zlib';

export const TYPE_NAMES = { 2: 'bitmap', 3: 'palette', 4: 'animation', 5: 'data', 6: 'text', 7: 'sound', 8: 'music', 10: 'video' };
export function range(data, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > data.length)
    throw new Error(`Out-of-bounds format range ${offset}+${size}/${data.length}`);
  return data.subarray(offset, offset + size);
}
function dimensions(width, height) {
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024)
    throw new Error(`Invalid image dimensions ${width}x${height}`);
}
export function rle(data, width, height, offset = 0) {
  dimensions(width, height);
  const out = Buffer.alloc(width * height);
  let y = 0;
  for (;;) {
    range(data, offset, 4);
    const rows = data.readUInt16LE(offset), chunks = data.readUInt16LE(offset + 2);
    offset += 4;
    if (!rows) break;
    if (y + rows > height) throw new Error('RLE rows exceed image height');
    if (!chunks) { y += rows; continue; }
    for (let row = 0; row < rows; row++, y++) {
      for (let c = 0; c < chunks; c++) {
        range(data, offset, 4);
        const skip = data.readUInt16LE(offset), copy = data.readUInt16LE(offset + 2);
        offset += 4;
        if (skip + copy > width) throw new Error('RLE chunk exceeds row width');
        range(data, offset, copy).copy(out, y * width + skip);
        offset += copy;
      }
    }
  }
  return out;
}
export function bitmap(data) {
  range(data, 0, 2);
  const flags = data.readUInt16LE(0);
  if (flags & ~31) throw new Error(`Unsupported bitmap flags ${flags}`);
  let offset = 2, width = 1, height = 1, x = 0, y = 0;
  if (flags & 2) {
    range(data, offset, 4);
    width = data.readUInt16LE(offset); height = data.readUInt16LE(offset + 2); offset += 4;
  }
  if (flags & 4) {
    range(data, offset, 4);
    x = data.readInt16LE(offset); y = data.readInt16LE(offset + 2); offset += 4;
  }
  let palette = null;
  if (flags & 8) { palette = range(data, offset, 1024); offset += 1024; }
  let pixels = null;
  if (flags & 16) {
    dimensions(width, height);
    if (flags & 1) pixels = rle(data, width, height, offset);
    else {
      const pitch = (width + 3) & ~3;
      range(data, offset, pitch * height);
      pixels = Buffer.alloc(width * height);
      for (let row = 0; row < height; row++) data.copy(pixels, row * width, offset + row * pitch, offset + row * pitch + width);
    }
  }
  return { flags, width, height, x, y, palette, pixels };
}
export function* animation(data) {
  range(data, 0, 12);
  const count = data.readUInt16LE(0), info = data.readUInt16LE(2);
  const sprite = data.readUInt32LE(4), paletteOffset = data.readUInt32LE(8);
  range(data, 12, count * 8);
  const palette = paletteOffset ? range(data, paletteOffset, 1024) : null;
  for (let listIndex = 0; listIndex < count; listIndex++) {
    const list = 12 + listIndex * 8;
    const requestedHash = data.readUInt32LE(list), frames = data.readUInt16LE(list + 4);
    const start = info + data.readUInt16LE(list + 6);
    range(data, start, frames * 32);
    for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
      const at = start + frameIndex * 32;
      const frame = { requestedHash, listIndex, frameIndex, frameHash: data.readUInt32LE(at), durationTicks: data.readUInt16LE(at + 4),
        x: data.readInt16LE(at + 6), y: data.readInt16LE(at + 8), width: data.readUInt16LE(at + 10), height: data.readUInt16LE(at + 12),
        deltaX: data.readInt16LE(at + 14), deltaY: data.readInt16LE(at + 16), collisionX: data.readInt16LE(at + 18),
        collisionY: data.readInt16LE(at + 20), collisionWidth: data.readUInt16LE(at + 22), collisionHeight: data.readUInt16LE(at + 24),
        reserved: data.readUInt16LE(at + 26), spriteOffset: data.readUInt32LE(at + 28), palette };
      frame.pixels = rle(data, frame.width, frame.height, sprite + frame.spriteOffset);
      yield frame;
    }
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data) {
  let crc = 0xffffffff;
  for (const n of data) crc = crcTable[(crc ^ n) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function raster(pixels, width, height, capacityWidth, capacityHeight, flipX = false, flipY = false) {
  dimensions(capacityWidth, capacityHeight);
  if (width > capacityWidth || height > capacityHeight) throw new Error('Frame exceeds original surface capacity');
  const pitch = (capacityWidth + 3) & ~3;
  const out = Buffer.alloc(pitch * capacityHeight);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    out[(flipY ? height - 1 - y : y) * pitch + (flipX ? width - 1 - x : x)] = pixels[y * width + x];
  return { pixels: out, pitch, width: pitch, height: capacityHeight };
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export function png(pixels, width, height, palette) {
  dimensions(width, height); range(pixels, 0, width * height); range(palette, 0, 1024);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 3;
  const colors = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) palette.copy(colors, i * 3, i * 4, i * 4 + 3);
  const scan = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(scan, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('PLTE', colors), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
