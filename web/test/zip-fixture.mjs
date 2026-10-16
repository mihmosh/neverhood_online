import { deflateRawSync } from 'node:zlib';
import { updateCRC32 } from '../lib/zip-validation.js';

export const crc32 = bytes => (updateCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

export function unicodePathExtra(nameBytes, path, { version = 1, crc = crc32(nameBytes) } = {}) {
  const name = Buffer.from(path);
  const extra = Buffer.alloc(9 + name.length);
  extra.writeUInt16LE(0x7075);
  extra.writeUInt16LE(5 + name.length, 2);
  extra[4] = version;
  extra.writeUInt32LE(crc, 5);
  name.copy(extra, 9);
  return extra;
}

// Raw name/extra variants allow central-only Unicode metadata and mismatched-header fixtures.
export function zip(items) {
  const locals = [];
  const central = [];
  let localOffset = 0;
  for (const item of items) {
    const name = Buffer.from(item.nameBytes ?? item.path);
    const localName = Buffer.from(item.localNameBytes ?? name);
    const extra = Buffer.from(item.extra ?? []);
    const localExtra = Buffer.from(item.localExtra ?? extra);
    const bytes = Buffer.from(item.bytes || 'game resource');
    const compressed = item.method === 0 ? bytes : deflateRawSync(bytes);
    const method = item.method ?? 8;
    const flags = item.flags ?? 0x800;
    const crc = item.crc ?? crc32(bytes);
    const size = item.size ?? bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt32LE(item.attributes ?? 0, 38);
    directory.writeUInt32LE(localOffset, 42);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    locals.push(local, localName, localExtra, compressed, descriptor);
    central.push(directory, name, extra);
    localOffset += local.length + localName.length + localExtra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, directory, end]);
}
