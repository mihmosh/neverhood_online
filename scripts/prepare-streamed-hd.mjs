import { createHash } from 'node:crypto';
import { open, readFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { inspectZip, updateCRC32 } from '../web/lib/zip-validation.js';
import { demoPath } from '../web/lib/demo-data.js';
import { PACK_LIMITS, validPackRoom, validateReplacementManifest } from '../web/prototype/replacement-pack.js';
import { ROOM_ARCHIVE_LIMITS } from '../web/prototype/room-archive.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Streamed HD: ${message}`); };

// Read only ZIP metadata and room-pack.json. Image SHA pins come from that manifest;
// the archive SHA is an identity supplied by the release, not a partial-read proof.
export async function buildStreamedHD(baseDir, outputDir) {
  baseDir = await realpath(baseDir);
  outputDir = await realpath(outputDir);
  const release = JSON.parse(await readFile(resolve(baseDir, 'manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(release.sourceRuntimeSHA256) || !release.packs ||
      !Object.keys(release.packs).length || Object.keys(release.packs).length > 2048) fail('invalid release');
  const result = {};
  await mkdir(resolve(outputDir, 'streamed-hd'), { recursive: true });
  for (const [room, archive] of Object.entries(release.packs)) {
    if (!validPackRoom(room) || !demoPath(archive.file) || !Number.isSafeInteger(archive.bytes) ||
        archive.bytes < 22 || archive.bytes > ROOM_ARCHIVE_LIMITS.bytes || !/^[a-f0-9]{64}$/.test(archive.sha256)) fail('invalid archive descriptor');
    const path = resolve(baseDir, archive.file);
    if (!path.startsWith(baseDir + sep) || await realpath(path) !== path) fail('unsafe archive path');
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== archive.bytes) fail('archive byte mismatch');
      const read = async (start, end) => {
        const bytes = Buffer.alloc(end - start);
        let offset = 0;
        while (offset < bytes.length) {
          const value = await handle.read(bytes, offset, bytes.length - offset, start + offset);
          if (!value.bytesRead) fail('truncated archive');
          offset += value.bytesRead;
        }
        return bytes;
      };
      const inspected = await inspectZip({ size: stat.size, slice(start, end) {
        return { async arrayBuffer() { const bytes = await read(start, end); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } };
      } }, { maxInputBytes: ROOM_ARCHIVE_LIMITS.bytes, maxEntryBytes: PACK_LIMITS.fileBytes,
        maxTotalBytes: ROOM_ARCHIVE_LIMITS.bytes, maxEntries: PACK_LIMITS.files,
        select(path, { directory }) {
          if (directory || !demoPath(path)) fail('unsafe file path or directory');
          return true;
        } });
      if (inspected.entries.some(entry => entry.method !== 0)) fail('only ZIP STORE supported');
      const files = new Map(inspected.entries.map(entry => [entry.path, entry]));
      const member = files.get('room-pack.json');
      if (!member || member.size > PACK_LIMITS.manifest) fail('missing or oversized manifest');
      const bytes = await read(member.dataOffset, member.dataOffset + member.size);
      if (((updateCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0) !== member.crc) fail('manifest CRC mismatch');
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const { descriptors } = validateReplacementManifest(manifest, release.sourceRuntimeSHA256);
      if (manifest.room !== room || manifest.version !== 2 || manifest.lossless !== true) fail('lossless room mismatch');
      if (files.size !== descriptors.length + 1) fail('unreferenced or missing files');
      const members = {};
      for (const image of descriptors) {
        const entry = files.get(image.file);
        if (!entry) fail(`missing image ${image.file}`);
        members[image.file] = { offset: entry.dataOffset, bytes: entry.size, sha256: image.sha256, crc32: entry.crc };
      }
      const index = { version: 1, room, runtimeSHA256: release.sourceRuntimeSHA256,
        archive: { url: `/__stream-hd/${room}.zip`, bytes: archive.bytes, sha256: archive.sha256 },
        manifest: { offset: member.dataOffset, bytes: bytes.length, sha256: digest(bytes) }, members };
      const data = Buffer.from(JSON.stringify(index) + '\n');
      const file = `streamed-hd/${room}.json`;
      await writeFile(resolve(outputDir, file), data, { flag: 'wx' });
      result[room] = { streaming: { index: { file, bytes: data.length, sha256: digest(data) } } };
    } finally { await handle.close(); }
  }
  return result;
}
