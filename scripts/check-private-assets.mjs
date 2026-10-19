import { execFileSync } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = /(^|\/)(original game|extracted|private-assets|asset-workspace|private-research|saves|save-backups|scummvm)(\/|$)|(^|\/)\.private-(assets|research)-no-public$|\.(blb|exe|bin|zip|smk|sav|sve|sqlite|sqlite3|sqlite-wal|sqlite-shm|db|db-wal|db-shm|safetensors|ckpt|pth|pt|onnx|\d{3})$/i;

export function privateAssetPaths(paths) {
  return paths.filter(path => forbidden.test(path));
}

export async function checkPrivateAssets(root = project) {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const bad = privateAssetPaths(tracked);
  for (const name of ['web', 'docs', 'dist']) {
    const base = join(root, name);
    try { await lstat(base); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const walk = async (directory, prefix) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Public content must not contain symlinks: ${path}`);
        if (entry.isDirectory()) await walk(join(directory, entry.name), path);
        else if (forbidden.test(path)) bad.push(path);
      }
    };
    await walk(base, name);
  }
  if (bad.length) throw new Error(`Private game media/database paths found in Git or public content:\n${[...new Set(bad)].join('\n')}`);
  return tracked.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkPrivateAssets().then(count => console.log(`Private asset audit passed (${count} tracked files; public trees checked). No artwork/hash similarity audit is implied.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
