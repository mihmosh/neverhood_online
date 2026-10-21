import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { WINDOW_SCENES, ALL_WINDOW_VIEWS } from '../scripts/window-scenes.mjs';
import { windowCoverage, checkWindowArchive } from '../scripts/audit-window-coverage.mjs';
import { requireWindowStates } from '../scripts/prepare-visual-demo.mjs';
import { SOURCE_RUNTIME_SHA256 } from '../scripts/prepare-hd-room-packs.mjs';
import { REQUIRED_FILES } from '../web/lib/validation.js';

function fixture() {
  const proof = { indices: [0, 4], rgb: '123456abcdef' };
  const manifest = { version: 2, id: 'window-fixture', fullGame: true,
    runtimeSHA256: SOURCE_RUNTIME_SHA256, sourceRuntimeSHA256: SOURCE_RUNTIME_SHA256,
    files: REQUIRED_FILES.map(name => ({ name, file: `game/${name}`, bytes: 16, sha256: '1'.repeat(64) })),
    cursor: 'cursor/cursor.json', packs: {}, rooms: {} };
  const selection = { private: true, purpose: 'offline-human-approved-release-selection', selected: [], unapproved: [], conflicts: [] };
  for (const [index, scene] of ALL_WINDOW_VIEWS.entries()) {
    const key = `640x480-640-${index.toString(16).padStart(8, '0')}-p11111111-opaque`;
    manifest.packs[scene.room] = { file: `rooms/${scene.room}.zip`, bytes: 100, sha256: '2'.repeat(64) };
    manifest.rooms[scene.room] = { backgroundKeys: [key], backgroundBindings: [{ key, palette: proof }] };
    const sourceSha256 = index.toString(16).padStart(64, '0'), output = { sha256: 'a'.repeat(64) };
    selection.selected.push({ sourceSha256, output, artifactId: `${sourceSha256}:${output.sha256}`,
      approvalEvidence: [{ kind: 'human-receipt' }], identities: [{ resourceId: `0x${scene.resource}` }] });
  }
  return { manifest, selection, proof };
}

test('inventory covers every conditional window state with distinct resource identities', async () => {
  assert.equal(WINDOW_SCENES.length, 13);
  assert.equal(new Set(WINDOW_SCENES.map(s => `${s.module}:${s.scene}`)).size, 8);
  assert.equal(new Set(WINDOW_SCENES.map(s => s.resource)).size, 13);
  assert.equal(ALL_WINDOW_VIEWS.length, 14);
  for (const module of new Set(ALL_WINDOW_VIEWS.map(s => s.module))) {
    const source = await readFile(new URL(`../scummvm/engines/neverhood/modules/module${module}.cpp`, import.meta.url), 'utf8');
    for (const state of ALL_WINDOW_VIEWS.filter(s => s.module === module)) assert(source.toLowerCase().includes(`0x${state.resource.toLowerCase()}`), `Unproven native resource ${state.resource}`);
  }
});

test('assembly requires all windows, including every conditional variant, without altering its input', () => {
  const { manifest } = fixture(), before = structuredClone(manifest);
  requireWindowStates(manifest);
  assert.deepEqual(manifest, before);
  for (const state of ALL_WINDOW_VIEWS) {
    const missing = structuredClone(manifest); delete missing.packs[state.room];
    assert.throws(() => requireWindowStates(missing), /Missing window state/);
    assert.throws(() => windowCoverage(missing, fixture().selection));
  }
});

test('all native StaticScene resources are accounted for, without treating radio/plaque/statues as windows', async () => {
  const directory = new URL('../scummvm/engines/neverhood/modules/', import.meta.url);
  const resources = [], statues = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.cpp')) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/createStaticScene\(0x([a-f0-9]{8}),/gi)) resources.push(match[1].toUpperCase());
    for (const match of source.matchAll(/statueCloseup\(0x([a-f0-9]{8}),/gi)) statues.push(match[1].toUpperCase());
  }
  const nonWindows = ['09507248', '000C6444'];
  assert(nonWindows.every(hash => resources.includes(hash)));
  assert.equal(statues.length, 12);
  assert.deepEqual(new Set(resources.filter(hash => !nonWindows.includes(hash))),
    new Set(WINDOW_SCENES.filter(scene => scene.module !== 1300).map(scene => scene.resource)));
});

test('coverage refuses unapproved, conflicted and ambiguously selected windows', () => {
  const { manifest, selection } = fixture();
  assert.equal(windowCoverage(manifest, selection).length, 14);
  const missing = structuredClone(selection); missing.selected.pop();
  assert.throws(() => windowCoverage(manifest, missing), /unique approved/);
  const duplicate = structuredClone(selection); duplicate.selected.push(duplicate.selected[0]);
  assert.throws(() => windowCoverage(manifest, duplicate), /unique approved/);
  const conflict = structuredClone(selection); conflict.conflicts.push(conflict.selected[0]);
  assert.throws(() => windowCoverage(manifest, conflict), /Quarantined/);
});

test('archive audit rejects stale artwork, incorrect native resources and mismatched trigger color proof', () => {
  const { manifest, selection, proof } = fixture();
  const state = windowCoverage(manifest, selection)[0];
  const pack = { room: state.room, sourceBinding: { artifactId: state.artifactId, identities: [{ catalogResourceId: `english:entry:0:${state.resource.toLowerCase()}` }] },
    backgrounds: [{ key: state.trigger.backgroundKeys[0], paletteProof: 'proof', image: 'image' }],
    paletteProofs: { proof }, images: [{ id: 'image', format: 'png', width: 2560, height: 1920, sha256: '3'.repeat(64) }] };
  assert.equal(checkWindowArchive(state, { manifest: pack }).connected, true);
  for (const change of [p => { p.sourceBinding.artifactId = 'wrong'; }, p => { p.sourceBinding.identities[0].catalogResourceId = 'wrong'; },
    p => { p.backgrounds[0].key = 'wrong'; }, p => { p.paletteProofs.proof.rgb = '000000000000'; }, p => { p.images[0].format = 'webp'; }]) {
    const changed = structuredClone(pack); change(changed);
    assert.throws(() => checkWindowArchive(state, { manifest: changed }));
  }
});
