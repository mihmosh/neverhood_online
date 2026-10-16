import { importLibrary } from './storage.js';
import { selectInstaller } from './installer-validation.js';

const base = new URL('../extractor/', import.meta.url);
const TEMP_ROOT = 'neverhood-installer-staging-v1';

function artifact(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid extractor artifact name.');
  return new URL(name, base).href;
}

export async function discoverExtractor() {
  try {
    const response = await fetch(new URL('extractor.json', base), { cache: 'no-store' });
    if (!response.ok) return { available: false, reason: 'The browser installer extractor has not been built yet.' };
    const descriptor = await response.json();
    if (descriptor.available !== true || descriptor.api !== 'emscripten-modularize' || descriptor.factory !== 'createInnoextract') throw new Error('Unsupported extractor API.');
    const parts = await Promise.all([descriptor.module, descriptor.wasm].map(name => fetch(artifact(name), { method: 'HEAD' })));
    if (parts.some(response => !response.ok)) throw new Error('Extractor artifacts are missing.');
    return { available: true, descriptor };
  } catch { return { available: false, reason: 'The browser installer extractor is unavailable or incompatible.' }; }
}

function extractInWorker(selection, descriptor, stage, onProgress, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./installer-worker.js', import.meta.url));
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException('Installer import cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Installer extraction exceeded ten minutes. Import was stopped.')), 600000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'The installer worker stopped unexpectedly.')); };
    worker.onmessageerror = () => finish(new Error('This browser could not exchange files with the installer worker.'));
    worker.onmessage = async ({ data }) => {
      if (settled) return;
      try {
        if (data.type === 'plan') {
          const estimate = await navigator.storage.estimate();
          // Temporary extraction and the final transactional import coexist.
          if (estimate.quota && estimate.quota - (estimate.usage || 0) < data.upperBytes * 2 + 65536) {
            throw new DOMException('Not enough browser storage for temporary extraction and the new library. The existing library has not been changed.', 'QuotaExceededError');
          }
          signal?.throwIfAborted();
          worker.postMessage({ type: 'continue' });
        } else if (data.type === 'progress') onProgress(data);
        else if (data.type === 'done') finish(null, data);
        else if (data.type === 'error') {
          const storageError = ['QuotaExceededError', 'NotAllowedError', 'NotFoundError', 'SecurityError'].includes(data.name);
          finish(storageError ? new DOMException(data.message, data.name) : new Error(data.message));
        }
      } catch (error) { finish(error); }
    };
    try { worker.postMessage({ type: 'extract', files: selection.files, executable: selection.executable, moduleURL: artifact(descriptor.module), stage }); }
    catch (error) { finish(error); }
  });
}

export async function importInstaller(files, onProgress = () => {}, { signal, descriptor } = {}) {
  const selection = selectInstaller(files);
  if (!navigator.locks?.request) throw new Error('This browser does not support the locks required for safe installer import.');
  if (!descriptor) throw new Error('The installer extractor is not ready.');
  return navigator.locks.request('neverhood-installer-import-v1', { mode: 'exclusive', signal }, async () => {
    signal?.throwIfAborted();
    const root = await navigator.storage.getDirectory();
    const temporary = await root.getDirectoryHandle(TEMP_ROOT, { create: true });
    for await (const [name, handle] of temporary.entries()) {
      if (handle.kind === 'directory' && name.startsWith('extract-')) await temporary.removeEntry(name, { recursive: true });
    }
    const name = `extract-${crypto.randomUUID()}`;
    const stage = await temporary.getDirectoryHandle(name, { create: true });
    try {
      const result = await extractInWorker(selection, descriptor, stage, onProgress, signal);
      signal?.throwIfAborted();
      const archives = [];
      for (const { name, size } of result.files) {
        const file = await (await stage.getFileHandle(name)).getFile();
        if (file.size !== size) throw new Error(`${name}: temporary extraction is incomplete.`);
        archives.push(file);
      }
      return await importLibrary(archives, progress => onProgress({ phase: 'commit', ...progress }), { signal });
    } finally {
      await temporary.removeEntry(name, { recursive: true }).catch(error => console.warn('Temporary extraction cleanup will be retried on the next import:', error));
    }
  });
}
