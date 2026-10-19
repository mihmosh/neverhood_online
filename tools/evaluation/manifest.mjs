import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skip = /(^|\/)(\.git|\.aws|\.ssh|\.venv|__pycache__|node_modules|transfer)(\/|$)|(^|\/)(\.env(?:\..*)?|\.netrc|auth\.json|token|token\.json)$/i;
const contained = (root, file) => file === root || file.startsWith(root + path.sep);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventoryResearch({ root = path.join(project, 'private-research'), bundle = false } = {}) {
  root = await realpath(root);
  const marker = JSON.parse(await readFile(path.join(root, '.private-research-no-public'), 'utf8'));
  if (marker.version !== 1 || marker.private !== true) throw new Error('Evaluation output must be marked private.');
  const files = [], exclusions = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = prefix + entry.name, absolute = path.join(directory, entry.name);
      if (skip.test(name) || (!prefix && ['manifest.json', 'inventory.jsonl'].includes(name))) { exclusions.push(name); continue; }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const link = await readlink(absolute);
        const target = await realpath(absolute);
        if (path.isAbsolute(link) || !contained(root, target)) throw new Error(`Transfer rejected a nonportable/outside symlink: ${name}`);
        files.push({ path: name, kind: 'symlink', target: link });
      } else if (info.isDirectory()) await walk(absolute, `${name}/`);
      else if (info.isFile()) {
        const record = { path: name, kind: 'file', bytes: info.size, sha256: await fileHash(absolute) };
        if (info.size < 1024 && /\.(safetensors|pth|pt|bin|ckpt)$/.test(name)) {
          const value = await readFile(absolute, 'utf8');
          if (value.startsWith('version https://git-lfs.github.com/spec/v1')) record.lfsPointerOnly = true;
        }
        files.push(record);
      } else throw new Error(`Unsupported evaluation input: ${name}`);
    }
  };
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const index = files.map(record => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(path.join(root, 'inventory.jsonl'), index, { mode: 0o600 });
  const componentManifests = files.filter(file => /(^|\/)manifest\.json$/.test(file.path)).map(file => file.path);
  const manifest = {
    version: 1, private: true, purpose: 'assessment-and-remote-planning', createdAt: new Date().toISOString(),
    files: files.length, bytes: files.reduce((sum, record) => sum + (record.bytes || 0), 0),
    inventory: { path: 'inventory.jsonl', sha256: sha256(index) }, componentManifests,
    potentialWeightFiles: files.filter(file => (/\.(safetensors|pth|pt|ckpt)$/i.test(file.path) || (/\.bin$/i.test(file.path) && file.bytes > 4 * 1024 ** 2)) && !file.lfsPointerOnly).map(file => file.path),
    exclusions, inferenceRunByThisTool: false, infrastructureProvisionedByThisTool: false, uploadsByThisTool: false,
    mediaNote: 'Video candidates reference the separate private-assets catalog. This tool does not copy or upload user game media.',
    warning: 'A source download is not proof of dependency compatibility or permission to use a model/checkpoint. Review each component manifest and license.',
  };
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  if (!bundle) return manifest;

  const destination = path.join(root, 'transfer');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const list = [...files.map(record => record.path), 'inventory.jsonl', 'manifest.json'];
  await writeFile(path.join(destination, 'files.list0'), list.join('\0') + '\0', { mode: 0o600 });
  const archive = path.join(destination, 'evaluation-kit.tar.gz');
  await execute('tar', ['--format=posix', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', root, '--null', '--verbatim-files-from', '-T', path.join(destination, 'files.list0')], { maxBuffer: 1024 * 1024 });
  const result = { version: 1, private: true, archive: 'evaluation-kit.tar.gz', bytes: (await lstat(archive)).size, sha256: await fileHash(archive), inventorySHA256: manifest.inventory.sha256, sourceBytes: manifest.bytes, sourceFiles: manifest.files,
    extract: 'Use a private directory with umask 077; tar --no-same-owner --no-same-permissions -xzf evaluation-kit.tar.gz. Verify inventory before installing or executing anything.',
    media: 'No user game media is copied by this bundler. Transfer only explicitly reviewed inputs separately.',
  };
  await writeFile(path.join(destination, 'transfer-manifest.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return result;
}

export async function verifyResearch(root = path.join(project, 'private-research')) {
  root = await realpath(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const index = await readFile(path.join(root, 'inventory.jsonl'), 'utf8');
  if (sha256(index) !== manifest.inventory.sha256) throw new Error('Evaluation inventory checksum mismatch.');
  let count = 0;
  for (const line of index.trimEnd().split('\n')) {
    const file = JSON.parse(line);
    const absolute = path.resolve(root, file.path);
    if (!contained(root, absolute) || file.path.startsWith('/') || file.path.includes('\0')) throw new Error('Unsafe evaluation inventory path.');
    const info = await lstat(absolute);
    if (file.kind === 'symlink') {
      if (!info.isSymbolicLink() || await readlink(absolute) !== file.target || !contained(root, await realpath(absolute))) throw new Error(`Symlink changed: ${file.path}`);
    } else if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || await fileHash(absolute) !== file.sha256) throw new Error(`Evaluation file changed: ${file.path}`);
    count++;
  }
  if (count !== manifest.files) throw new Error('Evaluation inventory count mismatch.');
  return { private: true, verifiedFiles: count, bytes: manifest.bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--bundle', '--verify'].includes(arg))) throw new Error('Use --bundle or --verify; this tool performs no uploads.');
  (args.includes('--verify') ? verifyResearch() : inventoryResearch({ bundle: args.includes('--bundle') }))
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
