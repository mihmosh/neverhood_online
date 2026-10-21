import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredLegacyFiles } from '../scripts/prepare-visual-demo.mjs';
import { SOURCE_RUNTIME_SHA256 } from '../scripts/prepare-hd-room-packs.mjs';
import { REQUIRED_FILES } from '../web/lib/validation.js';

function fixture() {
  return { version: 2, id: 'fixture', runtimeSHA256: SOURCE_RUNTIME_SHA256, sourceRuntimeSHA256: SOURCE_RUNTIME_SHA256,
    files: REQUIRED_FILES.map(name => ({ name, file: `game/${name}`, bytes: 16, sha256: '1'.repeat(64) })),
    fullGame: true, cursor: 'cursor/cursor.json',
    packs: { Scene1001: { file: 'rooms/Scene1001.zip', bytes: 100, sha256: '2'.repeat(64) } },
    rooms: { Scene1001: { backgroundKeys: ['640x480-640-1bd38d80-pa1e6ba93-opaque'] } } };
}

test('assembly inventory includes only declared game files and ZIPs, not source cursor or arbitrary paths', () => {
  const manifest = fixture(), before = structuredClone(manifest);
  const files = declaredLegacyFiles(manifest);
  assert.equal(files.length, REQUIRED_FILES.length + 1);
  assert(files.every(file => file.file.startsWith('game/') || file.file === 'rooms/Scene1001.zip'));
  assert.deepEqual(manifest, before);
});

test('assembly inventory rejects traversal, duplicate destinations and changed runtime', () => {
  const traversal = fixture(); traversal.files[0].file = '../secret';
  assert.throws(() => declaredLegacyFiles(traversal));
  const duplicate = fixture(); duplicate.packs.Scene1001.file = duplicate.files[0].file;
  assert.throws(() => declaredLegacyFiles(duplicate));
  const runtime = fixture(); runtime.runtimeSHA256 = '3'.repeat(64);
  assert.throws(() => declaredLegacyFiles(runtime));
});
