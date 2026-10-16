import { REQUIRED_FILES, validateArchives } from './validation.js';

const ROOT = 'neverhood-library-v1';
const LOCK = 'neverhood-library-write-v1';

export function storageSupported() {
  return Boolean(globalThis.isSecureContext && navigator.storage?.getDirectory);
}

async function directory() {
  if (!storageSupported()) throw new Error('OPFS is unavailable. Open the site over HTTPS or localhost in a supported browser.');
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT, { create: true });
}

async function readJSON(dir, name) {
  const handle = await dir.getFileHandle(name);
  return JSON.parse(await (await handle.getFile()).text());
}

async function writeJSON(dir, name, value) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(JSON.stringify(value));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

async function active(dir) {
  try {
    const file = await (await dir.getFileHandle('active.json')).getFile();
    // An interrupted very first write may leave an uncommitted empty file.
    if (file.size === 0) return null;
    const pointer = JSON.parse(await file.text());
    if (pointer.version !== 1 || !/^import-[a-z0-9-]+$/.test(pointer.directory)) throw new Error('The local library pointer is corrupted.');
    return pointer;
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    if (error instanceof SyntaxError) throw new Error('The local library pointer is corrupted. Delete the local library and import it again.');
    throw error;
  }
}

async function discardStaging(dir, keep) {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory' && name.startsWith('import-') && name !== keep) {
      await dir.removeEntry(name, { recursive: true });
    }
  }
}

export async function getLibrary() {
  const dir = await directory();
  const pointer = await active(dir);
  if (!pointer) return null;
  const data = await dir.getDirectoryHandle(pointer.directory);
  const manifest = await readJSON(data, 'manifest.json');
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 7 ||
      !REQUIRED_FILES.every(name => manifest.files.filter(file => file.name === name && Number.isSafeInteger(file.size) && file.size > 0).length === 1)) {
    throw new Error('Invalid library manifest. Import the BLB archives again.');
  }
  for (const entry of manifest.files) {
    const file = await (await data.getFileHandle(entry.name)).getFile();
    if (file.size !== entry.size) throw new Error(`${entry.name}: the local copy is missing or truncated. Import it again.`);
  }
  return { ...manifest, directory: pointer.directory };
}

export async function withStorageLock(callback, { signal } = {}) {
  if (!navigator.locks?.request) throw new Error('This browser does not support Web Locks: safe library changes are unavailable.');
  return navigator.locks.request(LOCK, { mode: 'exclusive', signal }, callback);
}

export async function importLibrary(files, onProgress = () => {}, { signal } = {}) {
  signal?.throwIfAborted();
  const validated = await validateArchives(files);
  return withStorageLock(async () => {
    signal?.throwIfAborted();
    const dir = await directory();
    const previous = await active(dir);
    // Recover abandoned transactions before checking available space.
    await discardStaging(dir, previous?.directory);
    const estimate = await navigator.storage.estimate?.();
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < validated.total + 65536) {
      throw new DOMException('Not enough free quota for a new copy. The previous library is preserved.', 'QuotaExceededError');
    }
    const id = `import-${crypto.randomUUID()}`;
    const stage = await dir.getDirectoryHandle(id, { create: true });
    let copied = 0;
    let committed = false;
    try {
      for (const { name, file } of validated.files) {
        signal?.throwIfAborted();
        const handle = await stage.getFileHandle(name, { create: true });
        const destination = await handle.createWritable();
        const progress = new TransformStream({
          transform(chunk, controller) {
            copied += chunk.byteLength;
            onProgress({ name, copied, total: validated.total });
            controller.enqueue(chunk);
          },
        });
        await file.stream().pipeThrough(progress).pipeTo(destination, { signal });
      }
      const manifest = {
        version: 1, importedAt: new Date().toISOString(), total: validated.total,
        warning: validated.warning,
        files: validated.files.map(({ name, file }) => ({ name, size: file.size })),
      };
      await writeJSON(stage, 'manifest.json', manifest);
      signal?.throwIfAborted();
      // createWritable commits its replacement on close, after every archive is complete.
      await writeJSON(dir, 'active.json', { version: 1, directory: id });
      committed = true;
      if (previous) await dir.removeEntry(previous.directory, { recursive: true }).catch(() => {});
      await discardStaging(dir, id).catch(() => {});
      return { ...manifest, directory: id };
    } catch (error) {
      if (!committed) await dir.removeEntry(id, { recursive: true }).catch(() => {});
      throw error;
    }
  }, { signal });
}

export async function deleteLibrary() {
  return withStorageLock(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(ROOT, { recursive: true }).catch(error => {
      if (error.name !== 'NotFoundError') throw error;
    });
  });
}

// Runtime adapters receive file handles on demand, not a whole-file memory copy.
export async function openArchive(name) {
  if (!REQUIRED_FILES.includes(name)) throw new Error('Unknown archive.');
  const dir = await directory();
  const pointer = await active(dir);
  if (!pointer) throw new Error('Import the BLB archives first.');
  const data = await dir.getDirectoryHandle(pointer.directory);
  return (await data.getFileHandle(name)).getFile();
}

export function describeStorageError(error) {
  if (error.name === 'QuotaExceededError') return 'Not enough browser storage space. Free some space and import again. Replacement needs quota for both copies; the previous library has not been replaced.';
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'The browser denied access to local storage. Check permissions and private browsing settings.';
  if (error.name === 'NotFoundError') return 'Local files are missing. The browser may have cleared storage; import the files again.';
  return error.message || 'The local storage operation failed.';
}
