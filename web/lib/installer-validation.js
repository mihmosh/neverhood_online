import { REQUIRED_FILES } from './validation.js';

export const MAX_INSTALLER_BYTES = 2 * 1024 ** 3;
export const MAX_OUTPUT_BYTES = 1024 ** 3;
export const MAX_ARCHIVE_BYTES = 512 * 1024 ** 2;

export function selectInstaller(files) {
  const input = [...files];
  if (!input.length) throw new Error('Choose the installer EXE and all adjacent BIN files together.');
  if (input.length > 33) throw new Error('Too many installer parts. At most 32 BIN files are supported.');
  const seen = new Set();
  let total = 0;
  for (const file of input) {
    if (!file.name || file.name.length > 240 || /[\\/\x00-\x1f\x7f]/.test(file.name)) throw new Error('Installer filenames must not contain paths or control characters.');
    const name = file.name.toLowerCase();
    if (!/\.(exe|bin)$/.test(name)) throw new Error(`Unexpected file: ${file.name}. Choose only the EXE and its BIN parts.`);
    if (seen.has(name)) throw new Error(`Duplicate installer part: ${file.name}.`);
    seen.add(name);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`${file.name}: the installer part is empty or invalid.`);
    total += file.size;
  }
  const executables = input.filter(file => /\.exe$/i.test(file.name));
  if (executables.length !== 1) throw new Error('Choose exactly one installer EXE, together with its adjacent BIN files.');
  if (total > MAX_INSTALLER_BYTES) throw new Error('This prototype supports installer inputs up to 2 GiB in total.');
  return { files: input, executable: executables[0].name, total };
}

export function parseInstallerListing(lines) {
  const archives = new Map();
  for (const line of lines) {
    const match = /^(\d+) ([^\x00-\x1f]+)$/.exec(line);
    if (!match) {
      if (/\.blb/i.test(line)) throw new Error('The installer has an unsupported BLB listing entry.');
      continue;
    }
    const [, amount, path] = match;
    const parts = path.split('/');
    const name = parts.at(-1).toLowerCase();
    if (!REQUIRED_FILES.includes(name)) continue;
    if (path.length > 512 || path.startsWith('/') || /[\\:]/.test(path) || parts.some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe resource path in installer: ${path}.`);
    }
    if (archives.has(name)) throw new Error(`The installer contains multiple copies of ${name}; choose an unambiguous installer.`);
    // --silent --list-sizes emits exact decimal bytes rather than rounded units.
    const upperBytes = Number(amount);
    if (!Number.isSafeInteger(upperBytes) || upperBytes < 16 || upperBytes > MAX_ARCHIVE_BYTES) throw new Error(`${name}: declared output exceeds the supported archive size.`);
    archives.set(name, { name, path, upperBytes });
  }
  const missing = REQUIRED_FILES.filter(name => !archives.has(name));
  if (missing.length) throw new Error(`This installer does not contain the complete game. Missing: ${missing.join(', ')}.`);
  const entries = REQUIRED_FILES.map(name => archives.get(name));
  const upperBytes = entries.reduce((sum, entry) => sum + entry.upperBytes, 0);
  if (upperBytes > MAX_OUTPUT_BYTES) throw new Error('The installer exceeds the 1 GiB extracted-resource limit.');
  return { entries, upperBytes };
}
