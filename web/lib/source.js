import { REQUIRED_FILES } from './validation.js';
import { importLibrary } from './storage.js';
import { importInstaller } from './installer.js';
import { withZipFiles } from './zip-source.js';

export function findGameSource(input) {
  const records = [...input];
  if (!records.length) throw new Error('Choose the folder containing your game or installer.');
  if (records.length > 10000) throw new Error('This folder has too many files. Choose a smaller folder containing just the game.');
  const directories = new Map();
  const paths = new Set();
  for (const record of records) {
    const file = record.file || record;
    const path = record.path || file.webkitRelativePath || file.name;
    if (typeof path !== 'string' || path.length > 2048 || /[\\\x00-\x1f]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('The selected folder contains an unsafe or unsupported filename.');
    }
    const name = path.split('/').at(-1).toLowerCase();
    if (!REQUIRED_FILES.includes(name) && !/\.(exe|bin)$/.test(name)) continue;
    const normalized = path.toLowerCase();
    if (paths.has(normalized)) throw new Error('The selected folder contains duplicate game filenames. Choose one copy of the game.');
    paths.add(normalized);
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).toLowerCase() : '';
    if (!directories.has(parent)) directories.set(parent, []);
    directories.get(parent).push({ name, file });
  }
  const complete = [...directories.values()].filter(entries => REQUIRED_FILES.every(name => entries.some(entry => entry.name === name)));
  if (complete.length > 1) throw new Error('More than one copy of the game was found. Choose the folder for just one copy.');
  if (complete.length === 1) return { kind: 'blb', files: REQUIRED_FILES.map(name => complete[0].find(entry => entry.name === name).file) };

  let candidates = [...directories.values()].flatMap(entries => entries.filter(entry => /\.exe$/.test(entry.name) && !/unins|uninstall/.test(entry.name)).map(entry => {
    const stem = entry.name.slice(0, -4);
    const parts = entries.filter(item => item.name.startsWith(stem) && /^-\d+[a-z]?\.bin$/.test(item.name.slice(stem.length)));
    return { entry, entries, parts };
  }));
  const split = candidates.filter(candidate => candidate.parts.length);
  if (split.length) candidates = split;
  else {
    const named = candidates.filter(({ entry }) => /setup|install|repack/.test(entry.name));
    if (named.length) candidates = named;
  }
  if (candidates.length > 1) throw new Error('More than one installer was found. Choose a folder or ZIP containing only the installer you want.');
  if (!candidates.length) throw new Error('We could not find a complete game or a supported installer. Choose the game folder, or a ZIP containing its installer.');
  const { entry, entries, parts } = candidates[0];
  return { kind: 'installer', files: [entry.file, ...(parts.length ? parts : entries.filter(item => /\.bin$/.test(item.name))).map(item => item.file)] };
}

export async function importGameSource({ files, archive }, onProgress = () => {}, { signal, extractor } = {}) {
  if (Boolean(files) === Boolean(archive)) throw new Error('Choose either a game folder or one ZIP archive.');
  const prepare = async records => {
    signal?.throwIfAborted();
    onProgress({ phase: 'inspect', detail: 'Finding your game files...' });
    const source = findGameSource(records);
    if (source.kind === 'blb') return importLibrary(source.files, progress => onProgress({ phase: 'commit', ...progress }), { signal });
    if (!extractor) throw new Error('The installer reader is not available yet. Try again shortly.');
    try { return await importInstaller(source.files, onProgress, { signal, descriptor: extractor }); }
    catch (error) {
      if (error.name === 'Error' && error.message.startsWith('Installer extraction failed')) {
        console.warn('Installer reader details:', error);
        throw new Error('This installer could not be opened. Make sure its folder contains all of the installer files, or try unpacking your copy first.', { cause: error });
      }
      throw error;
    }
  };
  return archive ? withZipFiles(archive, prepare, { signal, onProgress }) : prepare(files);
}
