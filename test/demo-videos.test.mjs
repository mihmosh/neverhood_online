import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDemoVideos } from '../scripts/verify-demo-videos.mjs';
import { REQUIRED_FILES } from '../web/lib/validation.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runtime = '31bdb5fa1afcdf80a6895e2fe5c87a5a999a245af85de7326df20f0756e0d83c';

async function fixture(t) {
  const root = await mkdtemp('/tmp/kilo/original-video-audit-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = [], remote = new Map();
  for (const name of REQUIRED_FILES) {
    const video = name === 'm.blb', bytes = Buffer.alloc(video ? 60 : 16);
    bytes.writeUInt32LE(0x02004940, 0); bytes.writeUInt16LE(7, 4);
    bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(video ? 1 : 0, 12);
    if (video) {
      bytes.writeUInt32LE(0x12345678, 16); bytes[20] = 10; bytes[21] = 1;
      bytes.writeUInt32LE(40, 28); bytes.writeUInt32LE(20, 32); bytes.writeUInt32LE(20, 36);
      bytes.write('SMK2', 40); bytes.writeUInt32LE(320, 44); bytes.writeUInt32LE(240, 48); bytes.writeUInt32LE(3, 52);
    }
    const localPath = join(root, name); await writeFile(localPath, bytes);
    source.push({ relativePath: `DATA/${name}`, localPath, bytes: bytes.length, sha256: hash(bytes) });
    remote.set(`/release/game/${name}`, bytes);
  }
  const originals = join(root, 'originals.json'); await writeFile(originals, JSON.stringify({ files: source }));
  const manifest = { version: 2, fullGame: true, id: 'original-video-test', sourceRuntimeSHA256: runtime, runtimeSHA256: runtime,
    files: source.map(row => ({ name: row.relativePath.slice(5), file: `game/${row.relativePath.slice(5)}`, bytes: row.bytes, sha256: row.sha256 })),
    totalBytes: source.reduce((n, row) => n + row.bytes, 0), cursor: 'cursor/cursor.json',
    packs: { Scene1001: { file: 'rooms/Scene1001.zip', bytes: 22, sha256: 'b'.repeat(64) } },
    rooms: { Scene1001: { backgroundKeys: ['640x480-640-11111111-p22222222-opaque'] } } };
  const fetcher = async input => {
    const path = new URL(input).pathname;
    return new Response(path === '/release/manifest.json' ? JSON.stringify(manifest) : remote.get(path), { status: remote.has(path) || path.endsWith('/manifest.json') ? 200 : 404 });
  };
  return { originals, release: 'https://assets.example.test/release/manifest.json', fetcher, manifest, remote };
}

test('audit proves unchanged full original media and counts source Smacker streams', async t => {
  const f = await fixture(t), result = await verifyDemoVideos(f);
  assert.equal(result.verified, true);
  assert.equal(result.originalArchives.length, 7);
  assert.equal(result.physicalVideoResources, 1);
  assert.equal(result.winningVideoResources, 1);
  assert.deepEqual(result.signatures, { SMK2: 1 });
  assert.equal(result.transcoded, false); assert.equal(result.upscaled, false);
});

test('old nonvideo stubs cannot pass as a full original-video release', async t => {
  const f = await fixture(t), file = f.manifest.files.find(row => row.name === 'm.blb');
  const stub = f.remote.get('/release/game/m.blb').subarray(0, 16);
  f.manifest.totalBytes -= file.bytes - stub.length;
  Object.assign(file, { bytes: stub.length, sha256: hash(stub) });
  await assert.rejects(verifyDemoVideos(f), /omits or changes|stub/);
});

test('corrupt or truncated public media are rejected even with a valid release manifest', async t => {
  const f = await fixture(t), bytes = Buffer.from(f.remote.get('/release/game/m.blb'));
  bytes[59] ^= 1; f.remote.set('/release/game/m.blb', bytes);
  await assert.rejects(verifyDemoVideos(f), /Public archive hash mismatch/);
  f.remote.set('/release/game/m.blb', bytes.subarray(0, 59));
  await assert.rejects(verifyDemoVideos(f), /Truncated/);
});
