import { Inflate } from '../vendor/fflate-0.8.2.js';
import { inspectZip, updateCRC32, ZIP_LIMITS } from './zip-validation.js';

self.onmessage = async ({ data }) => {
  if (data.type !== 'extract') return;
  try {
    const { file, stage } = data;
    self.postMessage({ type: 'progress', phase: 'zip-inspect', detail: 'Checking the ZIP directory and resource limits...' });
    const plan = await inspectZip(file);
    self.postMessage({ type: 'progress', phase: 'zip-extract', copied: 0, total: plan.total });
    let copied = 0;
    const outputs = [];
    for (const [index, entry] of plan.entries.entries()) {
      const stored = `entry-${index}`;
      const handle = await stage.getFileHandle(stored, { create: true });
      if (!handle.createSyncAccessHandle) throw new Error('This browser does not support disk-backed ZIP extraction in workers.');
      const output = await handle.createSyncAccessHandle();
      let written = 0;
      let crc = 0xffffffff;
      let ended = false;
      try {
        output.truncate(0);
        const write = (bytes, final) => {
          if (written + bytes.length > entry.size || copied + bytes.length > ZIP_LIMITS.output) throw new Error(`${entry.path}: decompressed data exceeds the declared size.`);
          crc = updateCRC32(crc, bytes);
          for (let offset = 0; offset < bytes.length;) {
            const count = output.write(bytes.subarray(offset), { at: written + offset });
            if (!count) throw new Error('Temporary ZIP storage write failed.');
            offset += count;
          }
          written += bytes.length;
          copied += bytes.length;
          if (final) ended = true;
        };
        const inflater = entry.method === 8 ? new Inflate(write) : null;
        // A small compressed chunk bounds fflate's synchronous output allocation. Each
        // callback writes directly to disk, so no archive-sized promise/write queue forms.
        const chunkSize = 16 * 1024;
        let reported = -1;
        for (let offset = 0; offset < entry.compressed; offset += chunkSize) {
          const size = Math.min(chunkSize, entry.compressed - offset);
          const chunk = new Uint8Array(await file.slice(entry.dataOffset + offset, entry.dataOffset + offset + size).arrayBuffer());
          if (chunk.length !== size) throw new Error('The ZIP input ended unexpectedly.');
          const final = offset + size === entry.compressed;
          if (inflater) inflater.push(chunk, final); else write(chunk, final);
          if (copied - reported >= 1024 * 1024 || final) {
            reported = copied;
            self.postMessage({ type: 'progress', phase: 'zip-extract', name: entry.path, copied, total: plan.total });
          }
        }
        if (!ended || written !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error(`${entry.path}: ZIP size or CRC32 verification failed.`);
        output.flush();
      } finally { output.close(); }
      outputs.push({ path: entry.path, stored, size: written });
    }
    self.postMessage({ type: 'done', files: outputs, total: copied });
  } catch (error) {
    self.postMessage({ type: 'error', name: error.name, message: String(error.message || error).slice(0, 2048) });
  } finally { self.close(); }
};
