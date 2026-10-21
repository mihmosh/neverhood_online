import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDemoManifest, demoPath } from '../web/lib/demo-data.js';
import { validateRoomArchive } from '../web/prototype/room-archive.js';
import { SOURCE_RUNTIME_SHA256 } from './prepare-hd-room-packs.mjs';
import { WINDOW_SCENES, ALL_WINDOW_VIEWS } from './window-scenes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function windowCoverage(manifest, selection, scenes = ALL_WINDOW_VIEWS) {
  validateDemoManifest(manifest, SOURCE_RUNTIME_SHA256);
  assert.equal(manifest.runtimeSHA256, SOURCE_RUNTIME_SHA256);
  assert(selection.private && selection.purpose === 'offline-human-approved-release-selection');
  const seen = new Set();
  return scenes.map(scene => {
    assert(!seen.has(scene.room), 'Duplicate window state'); seen.add(scene.room);
    const sources = selection.selected.filter(row => row.identities.some(identity => identity.resourceId === `0x${scene.resource}`));
    assert.equal(sources.length, 1, `No unique approved window: ${scene.room}`);
    const approved = sources[0], pack = manifest.packs[scene.room], trigger = manifest.rooms[scene.room];
    assert(pack && trigger, `Window is not connected: ${scene.room}`);
    assert(approved.approvalEvidence.length && approved.artifactId === `${approved.sourceSha256}:${approved.output.sha256}`, 'Missing exact window approval');
    assert(![...selection.unapproved, ...selection.conflicts].some(row => row.sourceSha256 === approved.sourceSha256), 'Quarantined window');
    return { ...scene, artifactId: approved.artifactId, pack, trigger };
  });
}

export function checkWindowArchive(state, archive) {
  const pack = archive.manifest;
  assert.equal(pack.room, state.room);
  assert.equal(pack.sourceBinding.artifactId, state.artifactId, `Stale/wrong window artwork: ${state.room}`);
  assert(pack.sourceBinding.identities.some(identity => identity.catalogResourceId.endsWith(`:${state.resource.toLowerCase()}`)), 'Window source resource mismatch');
  assert.equal(pack.backgrounds.length, 1, 'Window must have an explicit HD background');
  const background = pack.backgrounds[0];
  assert(state.trigger.backgroundKeys.includes(background.key), 'Window trigger does not select its background');
  const proof = pack.paletteProofs[background.paletteProof];
  assert(proof && proof.indices.length, 'Missing original window color proof');
  const binding = state.trigger.backgroundBindings.find(binding => binding.key === background.key);
  assert(binding, 'Missing window palette trigger');
  assert.deepEqual(binding.palette, proof, 'Window trigger palette differs from its pack');
  const image = pack.images.find(image => image.id === background.image);
  assert(image && image.format === 'png' && image.width === 2560 && image.height === 1920, 'Window is not lossless 4x');
  return { module: state.module, scene: state.scene, state: state.state, conditions: state.conditions,
    kind: state.kind ?? 'window', resource: state.resource, room: state.room,
    artifactId: state.artifactId, backgroundKey: background.key, usedColors: proof.indices.length,
    imageSHA256: image.sha256, archiveSHA256: state.pack.sha256, archiveBytes: state.pack.bytes, connected: true };
}

export async function auditWindowCoverage({ release, selection, output }) {
  release = resolve(release); selection = resolve(selection);
  const privateRoot = resolve(root, 'private-assets');
  assert(release.startsWith(privateRoot + '/') && selection.startsWith(privateRoot + '/'), 'Private inputs required');
  assert.equal(await realpath(release), release); assert.equal(await realpath(selection), selection);
  const manifestBytes = await readFile(resolve(release, 'manifest.json'));
  const selectionBytes = await readFile(selection);
  const manifest = JSON.parse(manifestBytes), chosen = JSON.parse(selectionBytes);
  const states = windowCoverage(manifest, chosen), windows = [];
  for (const state of states) {
    assert(demoPath(state.pack.file));
    const path = resolve(release, state.pack.file);
    assert(path.startsWith(release + '/') && await realpath(path) === path);
    const info = await lstat(path);
    assert(info.isFile() && info.size === state.pack.bytes);
    const bytes = new Uint8Array(await readFile(path));
    assert.equal(sha(bytes), state.pack.sha256, `Corrupt window archive: ${state.room}`);
    const archive = await validateRoomArchive(bytes, { runtimeSHA256: SOURCE_RUNTIME_SHA256, room: state.room });
    windows.push(checkWindowArchive(state, archive));
  }
  const report = { private: true, purpose: 'all-native-window-hd-coverage', runtimeUnchanged: true,
    manifest: { path: resolve(release, 'manifest.json'), sha256: sha(manifestBytes) },
    selection: { path: selection, sha256: sha(selectionBytes) },
    nativeScenes: new Set(WINDOW_SCENES.map(state => `${state.module}:${state.scene}`)).size,
    backgroundStates: windows.filter(state => state.kind === 'window').length, complete: windows.length === ALL_WINDOW_VIEWS.length,
    windows: windows.filter(state => state.kind === 'window'), relatedViews: windows.filter(state => state.kind !== 'window'),
    verification: 'Native source inventory plus exact release/ZIP/artifact/trigger/palette/image checks; not a complete gameplay walkthrough.' };
  if (output) {
    output = resolve(output);
    assert(output.startsWith(privateRoot + '/') && await realpath(dirname(output)) === dirname(output));
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i].replace(/^--/, '');
      assert(['release', 'selection', 'output'].includes(key) && process.argv[i + 1], 'Use --release --selection [--output]');
      options[key] = process.argv[i + 1];
    }
    assert(options.release && options.selection);
    console.log(JSON.stringify(await auditWindowCoverage(options), null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
