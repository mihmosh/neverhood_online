import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { validateDemoManifest, demoPath } from '../web/lib/demo-data.js';
import { validateReplacementManifest } from '../web/prototype/replacement-pack.js';
import { validateRoomArchive } from '../web/prototype/room-archive.js';
import { zipSync } from '../web/vendor/fflate-0.8.2.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, path) => path === base || path.startsWith(base + sep);

export async function prepareDemoRelease({ gameManifest, room1, room2, roomIndex, cursor, output, runtime = resolve(root, 'web/public/demo-runtime/runtime.json') }) {
  if (!isAbsolute(output) || output !== resolve(output) || inside(root, output) && !inside(resolve(root, 'private-assets'), output)) throw new Error('Demo media must be outside public/source trees.');
  const parent = await realpath(dirname(output));
  if (parent !== dirname(output) || ['web', 'dist', '.git', 'scummvm'].some(name => inside(resolve(root, name), parent))) throw new Error('Unsafe release output parent.');
  try { await lstat(output); throw new Error('Release output already exists; use a new version directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = `${output}.preparing-${process.pid}`;
  const descriptor = JSON.parse(await readFile(runtime, 'utf8'));
  const fullGame = Boolean(roomIndex);
  if (!fullGame && (!descriptor.demo || !/^[a-f0-9]{64}$/.test(descriptor.wasmSHA256))) throw new Error('Build the bounded demo runtime first.');
  if (fullGame && (descriptor.demo || !demoPath(descriptor.wasm) || descriptor.wasm.includes('/'))) throw new Error('Use the existing unchanged full-game runtime.');
  const sourceRuntimeSHA256 = fullGame ? digest(await readFile(resolve(dirname(runtime), descriptor.wasm))) : descriptor.sourceRuntimeSHA256;
  const source = JSON.parse(await readFile(gameManifest, 'utf8'));
  const manifest = { version: 2, id: fullGame ? 'full-game-lossless-v1' : 'two-rooms-q90-zip-tail-swing-v4', sourceRuntimeSHA256,
    runtimeSHA256: fullGame ? sourceRuntimeSHA256 : descriptor.wasmSHA256, files: [], packs: {},
    cursor: 'cursor/cursor.json', minimal: false, experimental: true,
    resourceStrategy: source.mode ?? source.resourceStrategy ?? 'reference-corpus', closureProven: source.closureProven === true };
  if (fullGame) Object.assign(manifest, { fullGame: true, rooms: {}, resourceStrategy: 'original-full-game-unchanged', closureProven: false });
  let totalAssetBytes = 0;
  const verifiedInput = async (sourcePath, sha256, bytes) => {
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(sourcePath) !== sourcePath) throw new Error('Release inputs must be regular files without symlinks.');
    const data = await readFile(sourcePath);
    if (sha256 && digest(data) !== sha256 || bytes !== undefined && data.length !== bytes) throw new Error(`Release input verification failed: ${sourcePath}`);
    return data;
  };
  const copy = async (sourcePath, file, sha256, bytes) => {
    if (!demoPath(file)) throw new Error('Unsafe release asset path.');
    const data = await verifiedInput(sourcePath, sha256, bytes);
    const path = resolve(stage, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    totalAssetBytes += data.length;
  };
  await mkdir(stage);
  try {
    await writeFile(resolve(stage, '.private-assets-no-public'), 'Private game-derived demo release. Not for public distribution without permission.\n');
    for (const name of REQUIRED_FILES) {
      const entry = source.files?.find(item => item.name === name || fullGame && item.relativePath === `DATA/${name}`);
      if (!entry || !(fullGame && entry.localPath ? isAbsolute(entry.localPath) && entry.relativePath === `DATA/${name}` : demoPath(entry.file))) throw new Error(`Game manifest is missing ${name}.`);
      const file = `game/${name}`;
      await copy(fullGame && entry.localPath ? entry.localPath : resolve(dirname(gameManifest), entry.file), file, entry.sha256, entry.bytes);
      manifest.files.push({ name, file, bytes: entry.bytes, sha256: entry.sha256 });
    }
    if (fullGame) {
      const index = JSON.parse(await readFile(roomIndex, 'utf8'));
      if (!Array.isArray(index.rooms) || !index.rooms.length || index.rooms.length > 2048) throw new Error('Missing verified room archives.');
      for (const entry of index.rooms) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(entry.id) || manifest.packs[entry.id] || !demoPath(entry.file)) throw new Error('Invalid or duplicate room archive.');
        const bytes = await verifiedInput(resolve(dirname(roomIndex), entry.file), entry.sha256, entry.bytes);
        const validated = await validateRoomArchive(bytes, { runtimeSHA256: sourceRuntimeSHA256, room: entry.id });
        if (validated.manifest.lossless !== true) throw new Error('Full-game room archives must use lossless PNGs.');
        const file = `rooms/${entry.id}.zip`;
        await copy(resolve(dirname(roomIndex), entry.file), file, entry.sha256, entry.bytes);
        manifest.packs[entry.id] = { file, bytes: bytes.length, sha256: digest(bytes) };
        manifest.rooms[entry.id] = { backgroundKeys: entry.backgroundKeys, backgroundBindings: entry.backgroundBindings };
      }
      manifest.assetMapSHA256 = index.assetMapSHA256;
    }
    for (const [directory, room, prefix] of fullGame ? [] : [[room1, 'Scene1001', 'room1'], [room2, 'Scene1002', 'room2']]) {
      const pack = JSON.parse(await readFile(resolve(directory, 'room-pack.json'), 'utf8'));
      pack.backgrounds = pack.backgrounds.filter(entry => entry.id === 'gemini');
      if (pack.backgrounds.length !== 1) throw new Error('Each demo room requires its Gemini background.');
      if (pack.version === 2) {
        const used = new Set([...pack.entries, ...pack.backgrounds].map(entry => entry.image));
        pack.images = pack.images.filter(image => used.has(image.id));
      }
      const { descriptors } = validateReplacementManifest(pack, descriptor.sourceRuntimeSHA256);
      if (pack.room !== room) throw new Error('Demo room pack is mislabeled.');
      const members = { 'room-pack.json': new TextEncoder().encode(JSON.stringify(pack) + '\n') };
      for (const image of [...descriptors].sort((a, b) => a.file.localeCompare(b.file))) {
        members[image.file] = await verifiedInput(resolve(directory, image.file), image.sha256);
      }
      // WebP is already compressed; STORE avoids a second compression/decompression pass.
      const bytes = zipSync(members, { level: 0, mtime: new Date('2000-01-01T00:00:00Z') });
      await validateRoomArchive(bytes, { runtimeSHA256: descriptor.sourceRuntimeSHA256, room });
      const file = `${prefix}.zip`;
      await writeFile(resolve(stage, file), bytes);
      manifest.packs[room] = { file, bytes: bytes.length, sha256: digest(bytes) };
      totalAssetBytes += bytes.length;
    }
    const cursorManifest = JSON.parse(await readFile(resolve(cursor, 'cursor.json'), 'utf8'));
    await copy(resolve(cursor, 'cursor.json'), 'cursor/cursor.json');
    await copy(resolve(cursor, 'sprite-sheet-128.png'), 'cursor/sprite-sheet-128.png', cursorManifest.imageSHA256 ?? cursorManifest.image?.sha256);
    manifest.totalAssetBytes = totalAssetBytes;
    validateDemoManifest(manifest, sourceRuntimeSHA256);
    await writeFile(resolve(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rename(stage, output);
    return manifest;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  const keys = { '--game-manifest': 'gameManifest', '--room1': 'room1', '--room2': 'room2', '--room-index': 'roomIndex', '--cursor': 'cursor', '--output': 'output', '--runtime': 'runtime' };
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = keys[process.argv[index]], value = process.argv[index + 1];
    if (!key || !value) throw new Error('Usage: prepare-demo-release.mjs --game-manifest PATH --room1 DIR --room2 DIR --cursor DIR --output NEW_PRIVATE_DIR');
    options[key] = resolve(value);
  }
  prepareDemoRelease(options).then(manifest => console.log(JSON.stringify({ output: options.output, gameBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), totalAssetBytes: manifest.totalAssetBytes, minimal: manifest.minimal }, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
