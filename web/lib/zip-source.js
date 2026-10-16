import { ZIP_LIMITS } from './zip-validation.js';

const TEMP_ROOT = 'neverhood-zip-staging-v1';

function extractZip(file, stage, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./zip-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason || new DOMException('ZIP import cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('ZIP extraction exceeded ten minutes. Import was stopped.')), 600000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'The ZIP worker stopped unexpectedly.')); };
    worker.onmessageerror = () => finish(new Error('This browser could not exchange files with the ZIP worker.'));
    worker.onmessage = ({ data }) => {
      if (settled) return;
      try {
        if (data.type === 'progress') onProgress(data);
        else if (data.type === 'done') finish(null, data.files);
        else if (data.type === 'error') {
          const storageError = ['QuotaExceededError', 'NotAllowedError', 'NotFoundError', 'SecurityError'].includes(data.name);
          finish(storageError ? new DOMException(data.message, data.name) : new Error(data.message));
        }
      } catch (error) { finish(error); }
    };
    try { worker.postMessage({ type: 'extract', file, stage }); }
    catch (error) { finish(error); }
  });
}

// The callback receives {path, file} records and may use them only until its promise
// settles. No library lock is taken here; the callback owns transactional adoption.
export async function withZipFiles(file, callback, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(file?.size) || file.size < 22 || file.size > ZIP_LIMITS.input) throw new Error('Choose a ZIP archive no larger than 2 GiB.');
  if (typeof callback !== 'function') throw new TypeError('A ZIP file consumer callback is required.');
  if (!navigator.locks?.request || !navigator.storage?.getDirectory) throw new Error('This browser does not support the OPFS storage and locks required for safe ZIP import.');
  return navigator.locks.request('neverhood-zip-import-v1', { mode: 'exclusive', signal }, async () => {
    signal?.throwIfAborted();
    const root = await navigator.storage.getDirectory();
    const temporary = await root.getDirectoryHandle(TEMP_ROOT, { create: true });
    // The dedicated ZIP lock covers extraction AND the consumer's lifetime, so no
    // other tab can delete live files while abandoned staging directories are swept.
    for await (const [name, handle] of temporary.entries()) {
      if (handle.kind === 'directory' && name.startsWith('extract-')) await temporary.removeEntry(name, { recursive: true });
    }
    const name = `extract-${crypto.randomUUID()}`;
    const stage = await temporary.getDirectoryHandle(name, { create: true });
    try {
      const result = await extractZip(file, stage, { signal, onProgress });
      signal?.throwIfAborted();
      const records = [];
      for (const entry of result) {
        const stored = await (await stage.getFileHandle(entry.stored)).getFile();
        if (stored.size !== entry.size) throw new Error(`${entry.path}: temporary ZIP output is incomplete.`);
        records.push({ path: entry.path, file: new File([stored], entry.path.split('/').at(-1), { lastModified: file.lastModified }) });
      }
      signal?.throwIfAborted();
      return await callback(records);
    } finally {
      await temporary.removeEntry(name, { recursive: true }).catch(error => console.warn('Temporary ZIP cleanup will be retried on the next import:', error));
    }
  });
}
