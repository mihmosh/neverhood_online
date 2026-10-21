import test from 'node:test';
import assert from 'node:assert/strict';
import { windowOverlayManifest, WINDOW_ROOM } from '../scripts/prepare-window-overlay.mjs';
import { SOURCE_RUNTIME_SHA256 } from '../scripts/prepare-hd-room-packs.mjs';

const base = { id: 'fixture', runtimeSHA256: SOURCE_RUNTIME_SHA256, files: [{ file: 'game/i.blb' }], cursor: 'cursor/cursor.json',
  packs: { Scene1001: { file: 'rooms/Scene1001.zip', bytes: 100, sha256: '1'.repeat(64) } }, rooms: { Scene1001: { backgroundKeys: ['legacy'] } } };
const room = { id: WINDOW_ROOM, bytes: 6100000, sha256: '2'.repeat(64), backgroundKeys: ['exact-window-key'], backgroundBindings: [{ key: 'exact-window-key', palette: {} }] };

test('window overlay adds exactly one bounded room without copying or changing legacy descriptors', () => {
  const before = structuredClone(base), result = windowOverlayManifest(base, room);
  assert.deepEqual(base, before);
  assert.equal(result.files, base.files);
  assert.equal(result.packs.Scene1001, base.packs.Scene1001);
  assert.equal(result.rooms.Scene1001, base.rooms.Scene1001);
  assert.equal(result.cursor, base.cursor);
  assert.equal(result.runtimeSHA256, base.runtimeSHA256);
  assert.equal(Object.keys(result.packs).length, 2);
  assert.equal(Object.keys(result.rooms).length, 2);
  assert.equal(result.packs[WINDOW_ROOM].file, `__window-overlay/rooms/${WINDOW_ROOM}.zip`);
});

test('window overlay rejects wrong room, runtime, oversized archive and duplicates', () => {
  assert.throws(() => windowOverlayManifest({ ...base, runtimeSHA256: '0'.repeat(64) }, room));
  assert.throws(() => windowOverlayManifest(base, { ...room, id: 'Module1000' }));
  assert.throws(() => windowOverlayManifest(base, { ...room, bytes: 8 * 1024 ** 2 }));
  assert.throws(() => windowOverlayManifest(windowOverlayManifest(base, room), room));
});
