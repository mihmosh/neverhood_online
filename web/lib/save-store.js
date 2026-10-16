import { withStorageLock } from './storage.js';
import { readSaveFiles, inspectSaveBytes, createSaveBackup, MAX_SAVE_BYTES, MAX_BATCH_BYTES } from './save-format.js';

// This is the persisted IDBFS schema used by the pinned Emscripten 4.0.10 runtime.
// Never bump its version independently: the game mounts the same database.
const DATABASE = '/saves';
const VERSION = 21;
const STORE = 'FILE_DATA';
const BACKUP_DIRECTORY = '/saves/.neverhood-web-backups';
const BACKUP_NAME = /^backup-(\d{10,16})-[a-f0-9-]{36}\.zip$/;
const MAX_BACKUPS = 3;
const FILE_MODE = 0o100644;
const DIRECTORY_MODE = 0o40755;

function openDatabase() {
  if (!globalThis.indexedDB) throw new Error('Saved-game storage is unavailable in this browser.');
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) {
        request.transaction.abort();
        return;
      }
      const store = request.result.createObjectStore(STORE);
      store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    request.onblocked = () => { settled = true; reject(new Error('Saved-game storage is busy. Close other game tabs and try again.')); };
    request.onerror = () => reject(request.error || new Error('Saved-game storage could not be opened.'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      if (!db.objectStoreNames.contains(STORE)) { db.close(); reject(new Error('The saved-game database has an unsupported format.')); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function readRecords(db) {
  return new Promise((resolve, reject) => {
    const records = [];
    const backups = [];
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      const key = item.primaryKey;
      if (typeof key === 'string' && /^\/saves\/neverhood\.\d{3}$/.test(key)) {
        const request = store.get(key);
        request.onsuccess = () => records.push({ key, value: request.result });
      } else if (typeof key === 'string' && key.startsWith(`${BACKUP_DIRECTORY}/`)) {
        const id = key.slice(BACKUP_DIRECTORY.length + 1);
        const match = BACKUP_NAME.exec(id);
        if (match && Number.isFinite(new Date(Number(match[1])).getTime())) backups.push({ id, createdAt: new Date(Number(match[1])).toISOString() });
      }
      item.continue();
    };
    transaction.oncomplete = () => resolve({ records, backups: backups.sort((a, b) => b.id.localeCompare(a.id)) });
    transaction.onabort = () => reject(transaction.error || new Error('Saved games could not be read.'));
    transaction.onerror = () => {};
  });
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}

async function snapshot(db) {
  const { records, backups } = await readRecords(db);
  if (records.length > 1000) throw new Error('Too many saved-game files.');
  let total = 0;
  const files = [];
  for (const { key, value } of records.sort((a, b) => a.key.localeCompare(b.key))) {
    if (!value || (value.mode & 0o170000) !== 0o100000 || !(value.contents instanceof Uint8Array) || !value.contents.length || value.contents.length > MAX_SAVE_BYTES) throw new Error('A saved-game record is damaged or unsupported. It has not been changed.');
    total += value.contents.length;
    if (total > MAX_BATCH_BYTES) throw new Error('The saved-game collection exceeds the supported backup size.');
    const bytes = value.contents;
    let description = 'Unrecognized save';
    try { ({ description } = await inspectSaveBytes(bytes)); } catch { /* Preserve damaged data in exports and pre-import backups too. */ }
    const name = key.slice('/saves/'.length);
    files.push({ name, slot: Number(name.slice(-3)), description, bytes, sha256: await digest(bytes) });
  }
  const revision = await digest(new TextEncoder().encode(JSON.stringify(files.map(({ name, sha256 }) => ({ name, sha256 })))));
  return { files, backups, revision };
}

async function access(callback) {
  return withStorageLock(async () => {
    const db = await openDatabase();
    try { return await callback(db); } finally { db.close(); }
  }, { ifAvailable: true });
}

function publicFiles(files) {
  return files.map(({ name, slot, description, bytes }) => ({ name, slot, description, bytes: bytes.length }));
}

export async function listSaves() {
  return access(async db => {
    const state = await snapshot(db);
    return { files: publicFiles(state.files), revision: state.revision, backups: state.backups };
  });
}

export async function prepareSaveImport(files) {
  const incoming = await readSaveFiles(files);
  return access(async db => {
    const state = await snapshot(db);
    const names = new Set(incoming.map(file => file.name));
    return { files: incoming, conflicts: publicFiles(state.files.filter(file => names.has(file.name))), revision: state.revision };
  });
}

function commitImport(db, files, backup, previousBackups) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const timestamp = new Date();
    const backupId = backup ? `backup-${timestamp.getTime()}-${crypto.randomUUID()}.zip` : null;
    let failure;
    transaction.oncomplete = () => resolve(backupId);
    transaction.onabort = () => reject(failure || transaction.error || new Error('The import could not be saved. Previous saved games are unchanged.'));
    transaction.onerror = () => {};
    try {
      if (backup) {
        store.put({ timestamp, mode: DIRECTORY_MODE }, BACKUP_DIRECTORY);
        store.put({ timestamp, mode: FILE_MODE, contents: backup }, `${BACKUP_DIRECTORY}/${backupId}`);
        for (const entry of previousBackups.slice(MAX_BACKUPS - 1)) store.delete(`${BACKUP_DIRECTORY}/${entry.id}`);
      }
      for (const file of files) store.put({ timestamp, mode: FILE_MODE, contents: file.bytes }, `/saves/${file.name}`);
    } catch (error) { failure = error; transaction.abort(); }
  });
}

export async function importSaves(plan, { overwrite = false } = {}) {
  if (!plan || !Array.isArray(plan.files) || !/^[a-f0-9]{64}$/.test(plan.revision)) throw new Error('Review the saved-game import again before confirming.');
  // Revalidate the reviewed bytes before a durable write; filenames never become paths unchecked.
  const incoming = await readSaveFiles(plan.files.map(file => new File([file.bytes], file.name)));
  return access(async db => {
    const state = await snapshot(db);
    if (state.revision !== plan.revision) throw new Error('Saved games changed in another tab. Review the import again; nothing was replaced.');
    const names = new Set(state.files.map(file => file.name));
    if (!overwrite && incoming.some(file => names.has(file.name))) throw new Error('Some save slots already exist. Review and explicitly allow replacement first.');
    const backup = state.files.length ? await createSaveBackup(state.files) : null;
    const backupId = await commitImport(db, incoming, backup, state.backups);
    return { count: incoming.length, backupId };
  });
}

export async function exportSaves() {
  return access(async db => {
    const state = await snapshot(db);
    if (!state.files.length) throw new Error('There are no saved games to export yet.');
    return { name: `neverhood-saves-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`, bytes: await createSaveBackup(state.files), count: state.files.length };
  });
}

export async function exportSaveBackup(id) {
  if (typeof id !== 'string' || !BACKUP_NAME.test(id)) throw new Error('Choose a valid previous backup.');
  return access(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(`${BACKUP_DIRECTORY}/${id}`);
    let record;
    request.onsuccess = () => { record = request.result; };
    transaction.onabort = () => reject(transaction.error || new Error('The backup could not be read.'));
    transaction.onerror = () => {};
    transaction.oncomplete = () => {
      if (!record || (record.mode & 0o170000) !== 0o100000 || !(record.contents instanceof Uint8Array) || !record.contents.length || record.contents.length > MAX_BATCH_BYTES + 1024 ** 2) reject(new Error('This backup is missing or damaged.'));
      else resolve({ name: `neverhood-${id}`, bytes: record.contents });
    };
  }));
}
