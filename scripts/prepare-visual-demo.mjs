import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demoPath, validateDemoManifest } from '../web/lib/demo-data.js';
import { validateDemoCursorManifest } from '../web/prototype/demo-cursor.js';
import { validateImageHeader } from '../web/prototype/replacement-pack.js';
import { validateRoomArchive } from '../web/prototype/room-archive.js';
import { SOURCE_RUNTIME_SHA256 } from './prepare-hd-room-packs.mjs';
import { WINDOW_ROOM, WINDOW_OUTPUT_SHA256, windowOverlayManifest } from './prepare-window-overlay.mjs';
import { ALL_WINDOW_VIEWS } from './window-scenes.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export function declaredLegacyFiles(manifest) {
  validateDemoManifest(manifest, SOURCE_RUNTIME_SHA256);
  assert.equal(manifest.runtimeSHA256, SOURCE_RUNTIME_SHA256);
  assert.equal(manifest.version, 2);
  return [...manifest.files, ...Object.values(manifest.packs)];
}

export function requireWindowStates(manifest) {
  for (const scene of ALL_WINDOW_VIEWS) {
    const room = manifest.rooms?.[scene.room], pack = manifest.packs?.[scene.room];
    assert(room?.backgroundKeys?.length && room.backgroundBindings?.length && pack, `Missing window state: ${scene.room}`);
  }
}

async function regular(root, file, maxBytes, expectedBytes) {
  assert(demoPath(file));
  const path = resolve(root, file);
  assert(path.startsWith(root + '/') && await realpath(path) === path, 'Noncanonical or symlinked input');
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maxBytes, `Invalid input ${file}`);
  if (expectedBytes !== undefined) assert.equal(info.size, expectedBytes, `Size mismatch ${file}`);
  return { path, info };
}

async function fileSHA(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareVisualDemo({ baseDir, windowDir, cursorDir, output }) {
  [baseDir, windowDir, cursorDir, output] = [baseDir, windowDir, cursorDir, output].map(p => resolve(p));
  for (const dir of [baseDir, windowDir, cursorDir, dirname(output)]) assert.equal(await realpath(dir), dir, 'Canonical directories required');
  assert(output.startsWith(resolve(repo, 'private-assets') + '/'), 'Use a new private output directory');
  const baseFile = await regular(baseDir, 'manifest.json', 1024 ** 2);
  const baseBytes = await readFile(baseFile.path), base = JSON.parse(baseBytes);
  const legacy = declaredLegacyFiles(base);
  const overlayFile = await regular(windowDir, 'overlay-report.json', 1024 ** 2);
  const overlay = JSON.parse(await readFile(overlayFile.path));
  assert.equal(overlay.base.sha256, sha(baseBytes), 'Overlay was prepared against another release');
  const expectedManifest = windowOverlayManifest(base, overlay.room);
  requireWindowStates(expectedManifest);
  const overlayManifest = JSON.parse(await readFile((await regular(windowDir, 'manifest.json', 1024 ** 2)).path));
  assert.deepEqual(overlayManifest, expectedManifest, 'Unexpected overlay changes');
  const window = await regular(windowDir, `pack/rooms/${WINDOW_ROOM}.zip`, 8 * 1024 ** 2, overlay.room.bytes);
  assert.equal(await fileSHA(window.path), overlay.room.sha256);
  await validateRoomArchive(new Uint8Array(await readFile(window.path)), { runtimeSHA256: SOURCE_RUNTIME_SHA256, room: WINDOW_ROOM });
  const map = JSON.parse(await readFile((await regular(windowDir, 'window-asset-map.json', 1024 ** 2)).path));
  assert.equal(map.rooms.length, 1);
  assert.equal(map.rooms[0].manifest.sourceBinding.artifactId.split(':')[1], WINDOW_OUTPUT_SHA256);
  const cursorFile = await regular(cursorDir, 'cursor.json', 1024 ** 2), cursorBytes = await readFile(cursorFile.path);
  const cursor = JSON.parse(cursorBytes);
  assert.equal(cursor.version, 2);
  assert.equal(cursor.bindings.length, 21);
  await validateDemoCursorManifest(cursor);
  const image = await regular(cursorDir, 'sprite-sheet-128.png', 1024 ** 2), imageBytes = await readFile(image.path);
  assert.equal(sha(imageBytes), cursor.imageSHA256);
  validateImageHeader(imageBytes, { format: 'png', width: 384, height: 896 }, imageBytes.length);
  const checked = [];
  for (const entry of legacy) {
    const input = await regular(baseDir, entry.file, 512 * 1024 ** 2, entry.bytes);
    const hash = await fileSHA(input.path);
    assert.equal(hash, entry.sha256, `Hash mismatch ${entry.file}`);
    checked.push({ ...input, file: entry.file, sha256: hash });
  }
  // The demo UI and server explicitly declare these two optional preview paths.
  for (const file of ['room1-original-preview-v3.webp', 'room1-hd-preview-v3.webp']) {
    try {
      const input = await regular(baseDir, file, 2 * 1024 ** 2);
      checked.push({ ...input, file, sha256: await fileSHA(input.path) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(output, { mode: 0o700 });
  const linked = [], copied = [];
  for (const input of checked) {
    const target = resolve(output, input.file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Never write or chmod a link: the source inode is shared with the old release.
    await link(input.path, target);
    const result = await stat(target);
    assert.equal(result.ino, input.info.ino); assert.equal(result.dev, input.info.dev);
    assert.equal(await fileSHA(target), input.sha256);
    linked.push({ source: input.path, file: input.file, bytes: result.size, sha256: input.sha256, inode: result.ino });
  }
  const copy = async (source, file, expected) => {
    const target = resolve(output, file);
    assert(demoPath(file) && target.startsWith(output + '/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    const hash = await fileSHA(target);
    assert.equal(hash, expected);
    copied.push({ source, file, bytes: (await stat(target)).size, sha256: hash });
  };
  await copy(window.path, overlayManifest.packs[WINDOW_ROOM].file, overlay.room.sha256);
  await copy(cursorFile.path, base.cursor, sha(cursorBytes));
  await copy(image.path, `${dirname(base.cursor)}/sprite-sheet-128.png`, cursor.imageSHA256);
  const manifest = { ...overlayManifest, id: `local-visual-${Date.now()}-${sha(cursorBytes).slice(0, 12)}` };
  validateDemoManifest(manifest, SOURCE_RUNTIME_SHA256);
  const manifestBytes = Buffer.from(json(manifest));
  await writeFile(resolve(output, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
  assert.equal(await fileSHA(baseFile.path), sha(baseBytes), 'Base manifest changed during assembly');
  const report = { private: true, purpose: 'opt-in-local-window-and-cursor-release', output, releaseId: manifest.id,
    runtimeSHA256: manifest.runtimeSHA256, baseManifest: { path: baseFile.path, sha256: sha(baseBytes) },
    windowOverlay: windowDir, cursorDir, manifestSHA256: sha(manifestBytes),
    counts: { hardlinkedFiles: linked.length, hardlinkedBytes: linked.reduce((n, f) => n + f.bytes, 0),
      copiedFiles: copied.length, copiedBytes: copied.reduce((n, f) => n + f.bytes, 0),
      generatedManifestBytes: manifestBytes.length, roomPacks: Object.keys(manifest.packs).length, cursorBindings: cursor.bindings.length },
    linked, copied, policy: { symlinks: false, legacyByteCopy: false, repacked: false, originalsWritten: false, production: false } };
  await writeFile(resolve(output, 'assembly-report.json'), json(report), { flag: 'wx', mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = { '--base-dir': 'baseDir', '--window-dir': 'windowDir', '--cursor-dir': 'cursorDir', '--output': 'output' }[process.argv[i]];
      assert(key && process.argv[i + 1], 'Use --base-dir --window-dir --cursor-dir --output');
      options[key] = process.argv[i + 1];
    }
    assert(['baseDir', 'windowDir', 'cursorDir', 'output'].every(k => options[k]));
    const report = await prepareVisualDemo(options);
    console.log(json({ output: report.output, releaseId: report.releaseId, counts: report.counts }));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
