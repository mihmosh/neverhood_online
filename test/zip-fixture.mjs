import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { updateCRC32 } from '../web/lib/zip-validation.js';

// Private test archives are written outside the document root, without buffering
// complete installer BIN files. Raw names reproduce pre-UTF8 ZIP writers.
export async function createStoredZip(destination, entries) {
  const output = await open(destination, 'w');
  const central = [];
  let position = 0;
  const write = async bytes => {
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await output.write(bytes, offset, bytes.length - offset, position);
      if (!bytesWritten) throw new Error('Test ZIP write failed.');
      offset += bytesWritten;
      position += bytesWritten;
    }
  };
  try {
    for (const entry of entries) {
      const name = Buffer.isBuffer(entry.path) ? entry.path : Buffer.from(entry.path);
      const size = (await stat(entry.source)).size;
      const start = position;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 6);
      local.writeUInt16LE(name.length, 26);
      await write(local);
      await write(name);
      let crc = 0xffffffff;
      for await (const chunk of createReadStream(entry.source)) {
        crc = updateCRC32(crc, chunk);
        await write(chunk);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(size, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(start, 42);
      central.push(header, name);
    }
    const start = position;
    await write(Buffer.concat(central));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - start, 12);
    end.writeUInt32LE(start, 16);
    await write(end);
  } finally { await output.close(); }
}
