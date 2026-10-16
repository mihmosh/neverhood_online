import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_FILES, ENGLISH_HD_SIZE, editionWarning } from '../lib/validation.js';
import { importLibrary, getLibrary, openArchive, deleteLibrary, storageSupported, describeStorageError } from '../lib/storage.js';

// Models async writable atomic-close semantics, including failed commits.
class Directory {
  constructor(path = '', failure = { path: null }) {
    this.kind = 'directory';
    this.path = path;
    this.children = new Map();
    this.failure = failure;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name) && create) this.children.set(name, new Directory(`${this.path}/${name}`, this.failure));
    const value = this.children.get(name);
    if (!value) throw new DOMException('Missing', 'NotFoundError');
    return value;
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name) && create) {
      let stored = new Blob([]);
      const path = `${this.path}/${name}`;
      const failure = this.failure;
      this.children.set(name, {
        kind: 'file',
        getFile: async () => stored,
        createWritable: async () => {
          const chunks = [];
          const writer = new WritableStream({
            write(chunk) { chunks.push(chunk); },
            close() {
              if (path.endsWith(failure.path || '\0')) throw new DOMException('Injected failure', 'QuotaExceededError');
              stored = new Blob(chunks);
            },
          });
          // OPFS WritableFileStream exposes both WritableStream and convenience methods.
          writer.write = async chunk => { chunks.push(chunk); };
          writer.close = async () => {
            if (path.endsWith(failure.path || '\0')) throw new DOMException('Injected failure', 'QuotaExceededError');
            stored = new Blob(chunks);
          };
          writer.abort = async () => {};
          return writer;
        },
      });
    }
    const value = this.children.get(name);
    if (!value) throw new DOMException('Missing', 'NotFoundError');
    return value;
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new DOMException('Missing', 'NotFoundError');
  }
  async *entries() { yield* this.children.entries(); }
}

function archives() {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02004940, true);
  view.setUint16(4, 7, true);
  view.setUint32(8, 40, true);
  view.setUint32(12, 1, true);
  return REQUIRED_FILES.map(name => new File([bytes], name));
}

test('OPFS transaction survives stream/commit failures, reloads, cleans staging and deletes', async t => {
  const root = new Directory();
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { getDirectory: async () => root, estimate: async () => ({ usage: 0, quota: 1e9 }) },
    locks: { request: async (name, options, operation) => {
      options.signal?.throwIfAborted();
      return operation();
    } },
  } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  t.after(() => {
    delete globalThis.isSecureContext;
    Object.defineProperty(globalThis, 'navigator', previousNavigator);
  });
  assert.equal(storageSupported(), true);
  assert.equal(await getLibrary(), null);
  let progress = 0;
  const original = await importLibrary(archives(), event => { progress = event.copied; });
  assert.equal(progress, 280);
  assert.equal((await getLibrary()).directory, original.directory);
  assert.equal((await openArchive('a.blb')).size, 40);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(importLibrary(archives(), undefined, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal((await getLibrary()).directory, original.directory);

  const duringCopy = new AbortController();
  await assert.rejects(importLibrary(archives(), () => duringCopy.abort(), { signal: duringCopy.signal }), { name: 'AbortError' });
  assert.equal((await getLibrary()).directory, original.directory);

  root.failure.path = '/m.blb';
  await assert.rejects(importLibrary(archives()), { name: 'QuotaExceededError' });
  assert.equal((await getLibrary()).directory, original.directory);
  const dir = await root.getDirectoryHandle('neverhood-library-v1');
  assert.equal([...dir.children.keys()].filter(name => name.startsWith('import-')).length, 1);

  // Existing version-1 manifests stay readable, regardless of their old warning language.
  const generation = await dir.getDirectoryHandle(original.directory);
  const manifestHandle = await generation.getFileHandle('manifest.json');
  const manifest = JSON.parse(await (await manifestHandle.getFile()).text());
  manifest.warning = '\u0420\u0430\u0437\u043c\u0435\u0440 hd.blb';
  const writer = await manifestHandle.createWritable();
  await writer.write(JSON.stringify(manifest));
  await writer.close();
  const legacy = await getLibrary();
  assert.equal(legacy.directory, original.directory);
  assert.equal(legacy.warning, manifest.warning);
  assert.match(editionWarning(legacy.files.find(file => file.name === 'hd.blb').size), /compatibility is unconfirmed/);
  assert.match(editionWarning(ENGLISH_HD_SIZE), /matches the known English edition/);

  root.failure.path = '/active.json';
  await assert.rejects(importLibrary(archives()), { name: 'QuotaExceededError' });
  assert.equal((await getLibrary()).directory, original.directory);

  root.failure.path = null;
  await dir.getDirectoryHandle('import-abandoned', { create: true });
  const replacement = await importLibrary(archives());
  assert.notEqual(replacement.directory, original.directory);
  assert.equal(dir.children.has(original.directory), false);
  assert.equal(dir.children.has('import-abandoned'), false);
  assert.equal((await getLibrary()).directory, replacement.directory);
  await deleteLibrary();
  assert.equal(await getLibrary(), null);
});

test('storage errors do not imply a complete integrity check', () => {
  assert.match(describeStorageError(new DOMException('', 'QuotaExceededError')), /previous library has not been replaced/);
  assert.match(describeStorageError(new DOMException('', 'SecurityError')), /denied/);
});
