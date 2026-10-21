import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packHDAssetMap, prepareHDRoomPacks, SOURCE_RUNTIME_SHA256 } from './prepare-hd-room-packs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WINDOW_ROOM = 'Module1000-C084110C';
export const WINDOW_OUTPUT_SHA256 = 'a3b85c90380de0b289fa1f759cc186e903c6cc965540ae56b4f5e342394902dc';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export function windowOverlayManifest(base, room) {
  assert.equal(base.runtimeSHA256, SOURCE_RUNTIME_SHA256);
  assert.equal(room.id, WINDOW_ROOM);
  assert(!base.packs[WINDOW_ROOM] && !base.rooms[WINDOW_ROOM], 'Window overlay already exists');
  assert(room.backgroundKeys.length === 1 && room.backgroundBindings.length === 1);
  assert(room.bytes > 0 && room.bytes < 8 * 1024 ** 2, 'Window overlay must remain bounded');
  assert(/^[a-f0-9]{64}$/.test(room.sha256));
  return { ...base, id: `${base.id}-approved-window-local`,
    packs: { ...base.packs, [WINDOW_ROOM]: { file: `__window-overlay/rooms/${WINDOW_ROOM}.zip`, bytes: room.bytes, sha256: room.sha256 } },
    rooms: { ...base.rooms, [WINDOW_ROOM]: { backgroundKeys: room.backgroundKeys, backgroundBindings: room.backgroundBindings } } };
}

export async function prepareWindowOverlay({ base, selection, normalized, output }) {
  output = resolve(output);
  const privateRoot = resolve(root, 'private-assets');
  assert(output.startsWith(privateRoot + '/'), 'Overlay must stay private');
  const selectionBytes = await readFile(selection), chosen = JSON.parse(selectionBytes);
  assert.equal(chosen.selected.length, 1, 'Window-only selection required');
  assert.equal(chosen.selected[0].output.sha256, WINDOW_OUTPUT_SHA256);
  assert(chosen.selected[0].identities.every(i => i.resourceId === '0xC084110C'));
  const prepared = JSON.parse(await readFile(normalized));
  assert.equal(prepared.artifacts.length, 1);
  assert.equal(prepared.selection.sha256, sha(selectionBytes));
  await mkdir(output, { mode: 0o700 });
  // The ordinary packer validates provenance, but receives no animation resources.
  const animations = resolve(output, 'no-animation-catalog.json');
  await writeFile(animations, json({ provenance: { model: { alpha: 'source-index0-binary-nearest4x' } },
    validation: { valid: true }, resources: [], images: [], scope: 'Window background only; all animation remains native.' }), { flag: 'wx', mode: 0o600 });
  const mapDir = resolve(output, 'mapping');
  await prepareHDRoomPacks({ root, selection, normalized, animations, output: mapDir, write: true, mapOnly: true });
  const mapping = JSON.parse(await readFile(resolve(mapDir, 'asset-map.json')));
  assert.equal(mapping.rooms.length, 1);
  mapping.rooms[0].id = WINDOW_ROOM;
  mapping.rooms[0].manifest.room = WINDOW_ROOM;
  const mapPath = resolve(output, 'window-asset-map.json');
  await writeFile(mapPath, json(mapping), { flag: 'wx', mode: 0o600 });
  const packed = await packHDAssetMap({ root, mapping: mapPath, output: resolve(output, 'pack'), write: true });
  const baseBytes = await readFile(base), manifest = windowOverlayManifest(JSON.parse(baseBytes), packed.rooms[0]);
  await writeFile(resolve(output, 'manifest.json'), json(manifest), { flag: 'wx', mode: 0o600 });
  const report = { private: true, purpose: 'approved-window-local-overlay', runtimeUnchanged: true,
    base: { path: resolve(base), sha256: sha(baseBytes) }, selection: { path: resolve(selection), sha256: sha(selectionBytes) },
    normalized: resolve(normalized), room: packed.rooms[0], manifest: resolve(output, 'manifest.json'),
    archive: resolve(output, 'pack/rooms', packed.rooms[0].file),
    policy: { copiedLegacyBytes: 0, animationBindings: packed.animation.includedBindings, upload: false, runtimePromotion: false } };
  await writeFile(resolve(output, 'overlay-report.json'), json(report), { flag: 'wx', mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = process.argv[i].replace(/^--/, '');
      assert(['base', 'selection', 'normalized', 'output'].includes(name) && process.argv[i + 1], 'Use --base --selection --normalized --output');
      options[name] = resolve(process.argv[i + 1]);
    }
    assert(['base', 'selection', 'normalized', 'output'].every(k => options[k]));
    console.log(json(await prepareWindowOverlay(options)));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
