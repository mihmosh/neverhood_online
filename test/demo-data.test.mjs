import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { audit, build, externalOutput, hashFile, inspectStaticData, resolveResources, nonvideoPlan, repackArchive } from '../scripts/build-demo-data.mjs';
import { parseArchive } from '../tools/assets/catalog.mjs';

function staticFixture() {
  const chunks = [];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); chunks.push(b); };
  u32(0x11223344); u32(0);
  u32(1); u32(0x004B4890); u32(1);
  const message = Buffer.alloc(6); message.writeUInt16LE(0x4832); message.writeUInt32LE(0x12345678, 2); chunks.push(message);
  u32(1); u32(0x004B4A00); u32(1); chunks.push(Buffer.alloc(8)); u32(1); chunks.push(Buffer.alloc(12));
  u32(1); u32(0x004B4860); u32(1); chunks.push(Buffer.alloc(10));
  u32(1); u32(0x004B67E8); u32(1); chunks.push(Buffer.alloc(22));
  u32(1); chunks.push(Buffer.alloc(22));
  u32(1); chunks.push(Buffer.alloc(40));
  return Buffer.concat(chunks);
}

test('neverhood.dat parses all six sections, not a scan of hash-looking words', () => {
  const result = inspectStaticData(staticFixture());
  assert.equal(result.sections.navigation.count, 1);
  assert.deepEqual(result.sections.messages.ids, ['004b4890']);
  assert.deepEqual(result.sections.messages.values, [0x12345678]);
  assert.equal(result.sections.hallOfRecords.count, 1);
  assert.equal(result.sections.tracks.count, 1);
});

test('static tables fail closed on truncation, unsupported versions and trailing bytes', () => {
  const data = staticFixture();
  for (let size = 0; size < data.length; size++)
    assert.throws(() => inspectStaticData(data.subarray(0, size)), /Truncated|Invalid/);
  assert.throws(() => inspectStaticData(Buffer.concat([data, Buffer.alloc(1)])), /trailing/);
  const bad = Buffer.from(data); bad.writeUInt32LE(1, 4);
  assert.throws(() => inspectStaticData(bad), /Unsupported/);
  bad.writeUInt32LE(0, 4); bad.writeUInt32LE(0xffffffff, 8);
  assert.throws(() => inspectStaticData(bad), /Invalid/);
});

test('BLB winners retain load-order ties and newer timestamps, aliases retain original extData', () => {
  const entry = (hash, timestamp, compression = 1, diskSize = 0) => ({ hash, timestamp, compression, diskSize, index: hash, extOffset: hash });
  const { winners, aliases } = resolveResources([
    { file: '/input/a.blb', entries: [entry(1, 5), entry(2, 1), entry(3, 1, 101, 2), entry(4, 1, 101, 3)] },
    { file: '/input/c.blb', entries: [entry(1, 5), entry(2, 2)] }
  ]);
  assert.equal(winners.get(1).archive, 'a.blb');
  assert.equal(winners.get(2).archive, 'c.blb');
  assert.deepEqual(aliases[1].chain, ['00000004', '00000003', '00000002']);
  assert.equal(aliases[1].requestedExtOffset, 4);
  assert.equal(aliases[1].archive, 'c.blb');
  assert.throws(() => resolveResources([{ file: 'a', entries: [entry(1, 0, 101, 1)] }]), /cycle/);
  assert.throws(() => resolveResources([{ file: 'a', entries: [entry(1, 0, 101, 2)] }]), /Missing/);
});

test('outputs cannot target repositories, public trees, existing paths or symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-output-test-'));
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git'));
    assert.throws(() => externalOutput(path.join(repo, 'private-assets/demo'), repo), /outside/);
    assert.throws(() => externalOutput(path.join(root, 'web/demo'), repo), /Public/);
    assert.throws(() => externalOutput(root, repo), /new directory/);
    const other = path.join(root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, '.git'), 'gitdir: elsewhere');
    assert.throws(() => externalOutput(path.join(other, 'data'), repo), /Git worktree/);
    fs.symlinkSync(repo, path.join(root, 'link'));
    assert.throws(() => externalOutput(path.join(root, 'link', 'data'), repo), /outside/);
    assert.equal(externalOutput(path.join(root, 'safe/demo'), repo), path.join(root, 'safe/demo'));
    assert.throws(() => build({ reference: true }), /requires --output/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded MD5 uses only 5000 bytes and SHA256 uses the complete file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-hash-test-'));
  try {
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    fs.writeFileSync(a, Buffer.alloc(6000));
    const changed = Buffer.alloc(6000); changed[5000] = 1; fs.writeFileSync(b, changed);
    assert.equal(hashFile(a, 'md5', 5000), hashFile(b, 'md5', 5000));
    assert.notEqual(hashFile(a), hashFile(b));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI help is offline, minimal mode is never silently enabled', () => {
  const help = spawnSync(process.execPath, ['scripts/build-demo-data.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /NOT minimal/);
  const bad = spawnSync(process.execPath, ['scripts/build-demo-data.mjs', '--minimal'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Unknown argument/);
  const missing = spawnSync(process.execPath, ['scripts/build-demo-data.mjs', '--nonvideo'], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /requires --output/);
  assert.throws(() => build({ nonvideo: true, reference: true, output: '/tmp/kilo/conflicting-demo-mode-test' }), /mutually exclusive/);
});

function archiveFixture(file, entries) {
  const ext = Buffer.from([11, 22, 33, 44]);
  let offset = 16 + entries.length * 24 + ext.length;
  const out = Buffer.alloc(offset + entries.reduce((n, e) => n + (e.alias ? 0 : e.data.length), 0));
  out.writeUInt32LE(0x02004940); out.writeUInt16LE(7, 4); out.writeUInt16LE(ext.length, 6);
  out.writeUInt32LE(out.length, 8); out.writeUInt32LE(entries.length, 12);
  ext.copy(out, offset - ext.length);
  entries.forEach((e, index) => {
    out.writeUInt32LE(e.hash, 16 + index * 4);
    const at = 16 + entries.length * 4 + index * 20;
    out[at] = e.type ?? 4; out[at + 1] = e.alias ? 101 : (e.compression ?? 1);
    out.writeUInt16LE(e.extOffset ?? 1, at + 2); out.writeUInt32LE(e.timestamp ?? 5, at + 4);
    out.writeUInt32LE(offset, at + 8); out.writeUInt32LE(e.alias ?? e.data.length, at + 12);
    out.writeUInt32LE(e.size ?? e.data?.length ?? 0, at + 16);
    if (!e.alias) { e.data.copy(out, offset); offset += e.data.length; }
  });
  fs.writeFileSync(file, out);
  return parseArchive(file);
}

test('nonvideo repack preserves raw compressed payloads, metadata, extData and alias chains', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-repack-test-'));
  try {
    const a = archiveFixture(path.join(root, 'a.blb'), [
      { hash: 10, type: 10, data: Buffer.from('VIDEO') },
      { hash: 1, compression: 3, size: 999, data: Buffer.from([0, 4, 128, 255]) },
      { hash: 2, alias: 1, extOffset: 4 },
      { hash: 11, alias: 10 }, { hash: 12, alias: 11 },
      { hash: 3, data: Buffer.from('older'), timestamp: 1 }
    ]);
    const c = archiveFixture(path.join(root, 'c.blb'), [
      { hash: 3, data: Buffer.from('newer'), timestamp: 2 },
      { hash: 1, data: Buffer.from('tie loses'), timestamp: 5 }
    ]);
    const plan = nonvideoPlan([a, c]);
    assert.deepEqual(plan.omitted.map(e => e.hash), ['0000000a', '0000000b', '0000000c']);
    assert.deepEqual(plan.omitted.map(e => e.reason), ['video', 'alias-to-video', 'alias-to-video']);
    const target = path.join(root, 'rebuilt.blb');
    const result = repackArchive(a, plan.archives[0].entries, target);
    const rebuilt = parseArchive(target);
    assert.equal(result.bytes, 16 + 3 * 24 + 4 + 4 + 5);
    assert.equal(rebuilt.size, fs.statSync(target).size);
    assert.deepEqual(rebuilt.entries.map(e => e.hash), [1, 2, 3]);
    assert.deepEqual(rebuilt.ext, a.ext);
    const raw = fs.readFileSync(target), entry = rebuilt.entries[0];
    assert.deepEqual(raw.subarray(entry.offset, entry.offset + entry.diskSize), Buffer.from([0, 4, 128, 255]));
    assert.equal(entry.compression, 3); assert.equal(entry.size, 999);
    assert.equal(rebuilt.entries[1].diskSize, 1); assert.equal(rebuilt.entries[1].extOffset, 4);
    assert.equal(rebuilt.entries[2].timestamp, 1);
    assert.deepEqual(result.preserved.map(e => e.sourceIndex), [1, 2, 5]);
    assert.equal(resolveResources(plan.archives).winners.get(3).archive, 'c.blb');
    assert.equal(resolveResources(plan.archives).winners.get(1).archive, 'a.blb');
    assert.equal(result.compressedPayloadsVerified, true);
    assert.equal(result.extDataVerified, true);
    assert.throws(() => repackArchive(a, plan.archives[0].entries, target), /EEXIST/);
    const empty = repackArchive(a, [], path.join(root, 'empty.blb'));
    assert.equal(empty.entries, 0); assert.equal(empty.bytes, 20);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nonvideo filtering cannot resurrect shadowed hashes or leave detection archive aliases dangling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-precedence-test-'));
  try {
    const old = archiveFixture(path.join(root, 'a.blb'), [{ hash: 1, data: Buffer.from('old'), timestamp: 1 }]);
    const video = archiveFixture(path.join(root, 'c.blb'), [{ hash: 1, type: 10, data: Buffer.from('new video'), timestamp: 2 }]);
    assert.throws(() => nonvideoPlan([old, video]), /precedence/);
    const hd = archiveFixture(path.join(root, 'hd.blb'), [{ hash: 2, alias: 1 }]);
    assert.throws(() => nonvideoPlan([video, hd]), /alias target/i);
    const detectionVideo = archiveFixture(path.join(root, 'hd.blb'), [{ hash: 1, type: 10, data: Buffer.from('hd video') }]);
    assert.equal(nonvideoPlan([detectionVideo]).archives[0].entries.length, 1);
    // A removed shadowed video does not alter the newer nonvideo winner.
    const newer = archiveFixture(path.join(root, 's.blb'), [{ hash: 1, data: Buffer.from('newest'), timestamp: 9 }]);
    const plan = nonvideoPlan([video, newer]);
    assert.equal(plan.omitted.length, 1);
    assert.equal(resolveResources(plan.archives).winners.get(1).archive, 's.blb');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('available private retail input yields an honest audit, not a playable minimal bundle', {
  skip: !fs.existsSync('extracted/app/DATA/hd.blb') || !fs.existsSync('web/public/runtime/neverhood.dat')
}, () => {
  const result = audit();
  assert.equal(result.minimal, false); assert.equal(result.closureProven, false);
  assert.equal(result.boundaryEnforced, false); assert.equal(result.playableBundle, false);
  assert.equal(result.files.length, 8); assert.equal(result.detection.md5PrefixBytes, 5000);
  assert.ok(result.resources.aliases.length > 0);
  assert.ok(result.staticData.sections.messages.ids.includes('004b4890'));
  assert.ok(result.blockers.some(b => b.code === 'RESOURCE_CLOSURE_UNPROVEN'));
  assert.ok(result.files.every(file => file.bytes > 0 && /^[0-9a-f]{64}$/.test(file.sha256)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-audit-test-'));
  try {
    const output = path.join(root, 'audit');
    const written = build({ output });
    assert.deepEqual(written.bundledFiles, []);
    assert.deepEqual(fs.readdirSync(output).sort(), ['.private-assets-no-public', 'manifest.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))).minimal, false);
    assert.throws(() => build({ output, reference: true }), /new directory/);
    const cli = spawnSync(process.execPath, ['scripts/build-demo-data.mjs'], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.equal(JSON.parse(cli.stdout).playableBundle, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
