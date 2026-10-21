import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { BLOCK_SIZE, PRELOAD_LIMIT_BYTES, INDEX_LIMIT_BYTES, RUNTIME_SHA256, deriveDependencies, mergeRoomGraph, indexOriginal, noSymlinks, sha256, sourceLiteralHashes } from '../scripts/prepare-streaming-demo.mjs';
import { boundedRange, createStreamingServer, MAX_RANGE_BYTES, MAX_HD_RANGE_BYTES } from '../scripts/serve-streaming-demo.mjs';
import { REQUIRED_FILES } from '../web/lib/validation.js';
import { deriveMenuCommon, loadMenuSources, mergeMenuCommon } from '../scripts/prepare-streaming-demo.mjs';

function original() {
  const bytes = Buffer.alloc(BLOCK_SIZE * 3 + 17);
  for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 17 + 3) % 256;
  bytes.writeUInt32LE(0x02004940, 0); bytes.writeUInt16LE(7, 4); bytes.writeUInt16LE(0, 6);
  bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(1, 12);
  bytes.writeUInt32LE(0x12345678, 16);
  bytes[20] = 2; bytes[21] = 1; bytes.writeUInt16LE(0, 22); bytes.writeUInt32LE(1, 24);
  bytes.writeUInt32LE(40, 28); bytes.writeUInt32LE(bytes.length - 40, 32); bytes.writeUInt32LE(bytes.length - 40, 36);
  return bytes;
}

function dependencies() {
  const files = Object.fromEntries(REQUIRED_FILES.map(name => [name, { bytes: BLOCK_SIZE * 4 }]));
  const tables = Object.fromEntries(REQUIRED_FILES.map(name => [name, { tableBytes: name === 'a.blb' ? BLOCK_SIZE + 1 : 40, entries: [] }]));
  tables['a.blb'].entries = [
    { name: 'a.blb', hash: 0xc084110c, timestamp: 1, compression: 1, offset: 2 * BLOCK_SIZE, diskSize: 5 },
    { name: 'a.blb', hash: 0x41108c00, timestamp: 1, compression: 1, offset: 2 * BLOCK_SIZE, diskSize: 5 },
  ];
  tables['i.blb'].entries = [
    { name: 'i.blb', hash: 0xc084110c, timestamp: 2, compression: 0x65, diskSize: 123 },
    { name: 'i.blb', hash: 123, timestamp: 1, compression: 1, offset: 3 * BLOCK_SIZE - 4, diskSize: 8 },
  ];
  tables['c.blb'].entries = [{ name: 'c.blb', hash: 0x001a0005, type: 10, timestamp: 1, compression: 1, offset: BLOCK_SIZE, diskSize: 5 }];
  const read = (name, position, scene, extra = {}) => ({ name, position, count: 5, phase: 'interactive', native: { module: 1000, scene }, ...extra });
  const reads = [read('c.blb', BLOCK_SIZE, undefined, { phase: 'startup', native: { module: 1500, scene: 999, sceneType: 1 }, videoHashes: ['001a0005'] }),
    read('a.blb', 2 * BLOCK_SIZE, 0), read('s.blb', BLOCK_SIZE, 0), read('s.blb', BLOCK_SIZE, 1),
    read('a.blb', 3 * BLOCK_SIZE, 1, { phase: 'lever3' }), read('i.blb', BLOCK_SIZE, 3, { phase: 'room2-cross' })];
  const trace = { mode: 'cold', checkpoints: [{ label: 'room1', reads: 2 }], trace: { reads,
    blocks: [...new Set(reads.map(r => `${r.name}/${Math.floor(r.position / BLOCK_SIZE)}`))].map(k => { const [name, block] = k.split('/'); return { name, block: Number(block) }; }) } };
  return { files, tables, trace };
}

test('dependency index keeps startup, all seven tables, shared refs, entry transitions and real alias-winning window spans', () => {
  const input = dependencies(), before = structuredClone(input);
  const index = deriveDependencies(input.trace, input.files, input.tables);
  assert.deepEqual(input, before);
  for (const name of REQUIRED_FILES) assert(index.bootstrap.some(ref => ref.name === name && ref.index === 0));
  assert(index.bootstrap.some(ref => ref.name === 'a.blb' && ref.index === 1));
  assert(index.bootstrap.some(ref => ref.name === 'a.blb' && ref.index === 2), 'before checkpoint even without startup phase');
  assert(index.common.some(ref => ref.name === 's.blb' && ref.index === 1));
  assert.deepEqual(index.rooms['1000:1'].blocks, [{ name: 'a.blb', index: 3 }]);
  assert.deepEqual(index.rooms['1000:3'].blocks, [{ name: 'i.blb', index: 1 }]);
  assert.deepEqual(index.rooms['1000:2'].blocks, [{ name: 'i.blb', index: 2 }, { name: 'i.blb', index: 3 }]);
  assert.deepEqual(index.videos['001a0005'].identities, ['1500:type:1']);
  assert.equal(index.videos['001a0005'].navigation, false);
  assert.equal(index.evidence.closureProven, false);
  for (const room of Object.values(index.rooms)) assert.equal(room.closureProven, false);
});

test('dependency index rejects unknown/truncated reads and mismatched observed union', () => {
  const { files, tables, trace } = dependencies();
  trace.trace.reads[0].name = 'secret';
  assert.throws(() => deriveDependencies(trace, files, tables), /unknown archive/);
  trace.trace.reads[0].name = 'c.blb'; trace.trace.reads[0].position = files['c.blb'].bytes;
  assert.throws(() => deriveDependencies(trace, files, tables), /Invalid traced/);
  trace.trace.reads[0].position = BLOCK_SIZE; trace.trace.blocks.pop();
  assert.throws(() => deriveDependencies(trace, files, tables), /union disagree/);
});

test('raw-read closure completes compressed/audio resources but never recursively follows padding-block neighbors', () => {
  const { trace, files, tables } = dependencies();
  tables['s.blb'].entries = [
    { name: 's.blb', hash: 111, type: 8, compression: 1, offset: BLOCK_SIZE - 5, diskSize: BLOCK_SIZE + 10 },
    { name: 's.blb', hash: 112, type: 4, compression: 3, offset: 2 * BLOCK_SIZE + 6, diskSize: BLOCK_SIZE + 1 },
  ];
  const index = deriveDependencies(trace, files, tables);
  assert(index.common.some(ref => ref.name === 's.blb' && ref.index === 2), 'full audio payload beyond traced reads');
  assert(!index.common.some(ref => ref.name === 's.blb' && ref.index === 3), 'neighbor resource in newly fetched block must not expand');
  tables['s.blb'].entries[0].compression = 3;
  assert(deriveDependencies(trace, files, tables).common.some(ref => ref.name === 's.blb' && ref.index === 2), 'compressed payload remains physical and complete');
});

test('source literal closure resolves winners and aliases, covers block34, excludes comments/videos and enforces32MiB', () => {
  const { trace, files, tables } = dependencies();
  files['a.blb'].bytes = 36 * BLOCK_SIZE;
  tables['a.blb'].entries.push({ name: 'a.blb', hash: 0x41688704, type: 7, compression: 3, offset: 34 * BLOCK_SIZE + 5, diskSize: 20 });
  const sources = [{ file: 'module1000_sprites.cpp', text: 'playSound(0, 0x41688704); load(0xC084110C); /* 0xDEADBEEF */ // 0xCAFEBABE\n movie(0x001A0005);' }];
  assert.deepEqual(sourceLiteralHashes(sources[0].text), [0x41688704, 0xc084110c, 0x001a0005]);
  const index = deriveDependencies(trace, files, tables, sources);
  assert(index.common.some(ref => ref.name === 'a.blb' && ref.index === 34));
  assert(index.common.some(ref => ref.name === 'i.blb' && ref.index === 3), 'static literal follows authoritative winning alias');
  assert.deepEqual(index.evidence.staticSources[0].resolved, ['41688704', 'c084110c']);
  assert.equal(index.evidence.closureProven, false);
  files['a.blb'].bytes = 40 * 1024 ** 2;
  tables['a.blb'].entries.at(-1).diskSize = PRELOAD_LIMIT_BYTES + 1;
  assert.throws(() => deriveDependencies(trace, files, tables, sources), /preload exceeds32MiB.*largest resources/);
});

test('menu common closes static references, winning aliases, fonts and controls absent from the room graph', async () => {
  const { files, tables, trace } = dependencies();
  const data = Buffer.alloc(46);
  data.writeUInt32LE(0x11223344, 0); data.writeUInt32LE(1, 8);
  data.writeUInt32LE(0xabcdef01, 12); data.writeUInt32LE(1, 16);
  data.writeUInt32LE(0x94188d4d, 22);
  tables['hd.blb'].entries.push(
    { name: 'hd.blb', hash: 0x08c0020c, type: 2, timestamp: 1, compression: 1, offset: BLOCK_SIZE, diskSize: 10 },
    { name: 'hd.blb', hash: 0x94188d4d, type: 2, timestamp: 1, compression: 0x65, diskSize: 123 });
  const sources = [{ file: 'menu.cpp', text: 'uint32 buttons[] = {0x08C0020C}; script(0xABCDEF01); movie(0x001A0005);' }];
  const menu = deriveMenuCommon(files, tables, sources, data);
  assert.deepEqual(menu.blocks, [{ name: 'hd.blb', index: 1 }, { name: 'i.blb', index: 2 }, { name: 'i.blb', index: 3 }]);
  assert.equal(menu.resources.find(resource => resource.hash === '94188d4d').resolvedHash, '0000007b');
  assert.deepEqual(menu.videos, ['001a0005']);
  const index = deriveDependencies(trace, files, tables), before = structuredClone(index);
  assert(!index.common.some(ref => ref.name === 'hd.blb' && ref.index === 1));
  const merged = mergeMenuCommon(index, menu, files);
  assert(merged.common.some(ref => ref.name === 'hd.blb' && ref.index === 1));
  assert.deepEqual(index, before); assert.deepEqual(merged.rooms, index.rooms); assert.deepEqual(merged.videos, index.videos);
  const native = (await loadMenuSources()).flatMap(source => sourceLiteralHashes(source.text));
  for (const hash of [0x08c0020c, 0x00208084, 0x2328121a, 0x201c2474, 0x728523ed, 0x94188d4d, 0x8290ac20, 0x08861079]) {
    assert(native.includes(hash), `Missing native menu background/cursor/font/control/sound ${hash.toString(16)}`);
  }
  const oversized = { ...menu, blocks: Array.from({ length: 513 }, (_, index) => ({ name: 'a.blb', index })) };
  files['a.blb'].bytes = 40 * 1024 ** 2;
  assert.throws(() => mergeMenuCommon(index, oversized, files), /Menu common exceeds32MiB/);
});

test('observed startup Smacker gets a full separate bundle without expanding unrelated videos sharing padding', () => {
  const { trace, files, tables } = dependencies();
  files['c.blb'].bytes = 8 * BLOCK_SIZE;
  tables['c.blb'].entries[0].diskSize = 2 * BLOCK_SIZE + 5;
  tables['c.blb'].entries.push({ name: 'c.blb', hash: 0xdeadbeef, type: 10, compression: 1, offset: 3 * BLOCK_SIZE + 10, diskSize: 4 * BLOCK_SIZE });
  const index = deriveDependencies(trace, files, tables);
  const video = index.videos['001a0005'];
  assert.equal(video.bytes, 2 * BLOCK_SIZE + 5); assert.equal(video.startup, true); assert.equal(video.navigation, false);
  assert.deepEqual(video.blocks.map(ref => ref.index), [1, 2, 3]);
  assert.deepEqual(video.observedBlocks.map(ref => ref.index), [1]);
  assert(index.bootstrap.some(ref => ref.name === 'c.blb' && ref.index === 3));
  assert(!index.common.some(ref => ref.name === 'c.blb' && ref.index === 4));
  assert.equal(index.videos.deadbeef, undefined);
  delete trace.trace.reads[0].videoHashes;
  assert.equal(deriveDependencies(trace, files, tables).videos['001a0005'].bytes, video.bytes, 'physical video reads do not depend on a decoder probe');
  files['c.blb'].bytes = 40 * 1024 ** 2;
  tables['c.blb'].entries[0].diskSize = PRELOAD_LIMIT_BYTES + 1;
  assert.throws(() => deriveDependencies(trace, files, tables), /Startup video.*exceeds32MiB/);
});

test('graph merge preserves observed startup, removes common duplicates, keeps videos separate and aliases only unique real identities', () => {
  const { trace, files, tables } = dependencies(), observed = deriveDependencies(trace, files, tables);
  const graph = { rooms: {
    '1000:0': { blocks: [{ name: 's.blb', index: 1 }], hdRooms: ['Scene1001'], sceneClasses: ['SharedScene'], neighbors: ['1000:1'], videoHashes: [] },
    '1000:1': { blocks: [{ name: 'a.blb', index: 3 }], hdRooms: ['Scene1002'], neighbors: ['2300:0'], videoHashes: [],
      neighborEntries: [{ room: '2300:0', which: 1, entryVideoHashes: ['deadbeef'] }] },
    '2300:0': { blocks: [{ name: 't.blb', index: 2 }], hdRooms: [], sceneClasses: ['SharedScene'], neighbors: ['1000:1'],
      videoHashes: ['deadbeef', 'eeeeeeee'], entryVideoHashes: ['eeeeeeee'] },
  }, videos: {
    '001a0005': { name: 'c.blb', offset: BLOCK_SIZE, bytes: 5, blocks: [{ name: 'c.blb', index: 1 }], startup: false, identities: ['1500:0'], evidence: [{ file: 'native.cpp' }] },
    deadbeef: { name: 'c.blb', offset: 2 * BLOCK_SIZE, bytes: 5, blocks: [{ name: 'c.blb', index: 2 }], startup: false, identities: ['2300:0'], navigation: true },
    eeeeeeee: { name: 'c.blb', offset: 3 * BLOCK_SIZE, bytes: 5, blocks: [{ name: 'c.blb', index: 3 }], startup: false, identities: ['2300:0'], navigation: true },
  }, evidence: { roomCount: 3, closureProven: false } };
  const before = structuredClone({ graph, observed });
  const index = mergeRoomGraph(observed, graph, files);
  assert.deepEqual({ graph, observed }, before);
  assert.equal(index.videos['001a0005'].startup, true);
  assert.deepEqual(index.videos['001a0005'].phases, ['startup']);
  assert.deepEqual(index.videos['001a0005'].identities, ['1500:0', '1500:type:1']);
  assert.deepEqual(index.videos['001a0005'].evidence, [{ file: 'native.cpp' }]);
  assert(!index.common.some(ref => ref.name === 'c.blb' && ref.index === 1));
  assert(index.bootstrap.some(ref => ref.name === 'c.blb' && ref.index === 1));
  assert(index.rooms['1000:1'].neighbors.includes('2300:0'));
  assert(index.rooms['1000:0'].blocks.every(ref => !(ref.name === 's.blb' && ref.index === 1)));
  assert.deepEqual(index.rooms['2300:0'].entryVideoHashes, ['eeeeeeee']);
  assert.deepEqual(index.rooms['2300:0'].blocks, [{ name: 't.blb', index: 2 }]);
  assert.equal(index.roomAliases.Scene1001, '1000:0');
  assert.equal(index.roomAliases.SharedScene, undefined);
  assert.deepEqual(index.hdRoomIdentities.SharedScene, ['1000:0', '2300:0']);
  assert(!index.bootstrap.some(ref => ref.name === 'c.blb' && ref.index === 2), 'navigation movie is not a startup dependency');
  assert.equal(index.evidence.budget.module2300EntryVideoBytes, BLOCK_SIZE);
  assert.deepEqual(index.evidence.budget.module2300EntryVideoHashes, ['deadbeef'], 'actual inbound sceneWhich overrides generic default entry');
  assert.deepEqual(index.evidence.budget.module2300DefaultSceneEntryVideoHashes, ['eeeeeeee']);
  assert.equal(index.evidence.budget.module2300TransitionAdditionalBytes, 2 * BLOCK_SIZE);
  assert.equal(index.evidence.closureProven, false);
  graph.rooms['1000:1'].neighbors.push('9999:0');
  assert.throws(() => mergeRoomGraph(observed, graph, files), /real native identity/);
});

test('graph merge rejects mismatched physical video identity and initial preload over32MiB', () => {
  const { trace, files, tables } = dependencies(), observed = deriveDependencies(trace, files, tables);
  const graph = { rooms: {}, videos: { '001a0005': { name: 'c.blb', offset: BLOCK_SIZE + 1, bytes: 5, blocks: [] } }, evidence: {} };
  assert.throws(() => mergeRoomGraph(observed, graph, files), /physical spans disagree/);
  graph.videos = {};
  files['a.blb'].bytes = 40 * 1024 ** 2;
  graph.rooms['1000:0'] = { blocks: Array.from({ length: 600 }, (_, index) => ({ name: 'a.blb', index })) };
  assert.throws(() => mergeRoomGraph(observed, graph, files), /Initial room\+neighbors exceed32MiB/);
});

test('index hashes every physical byte, partial tail, padding and non-winning spans without copying originals', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neverhood-index-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = original(), path = join(directory, 'a.blb');
  await writeFile(path, bytes);
  const expected = { name: 'a.blb', bytes: bytes.length, sha256: sha256(bytes) };
  const indexed = await indexOriginal(path, expected);
  assert.equal(indexed.file.sha256, sha256(bytes));
  assert.equal(indexed.file.hashes.length, 4);
  assert.deepEqual(indexed.file.resources[0], { hash: '12345678', type: 2, offset: 40, bytes: bytes.length - 40, compression: 1 });
  for (let i = 0; i < 4; i++) assert.equal(indexed.file.hashes[i], sha256(bytes.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE)));
  assert.deepEqual(await readdir(directory), ['a.blb']);
  await assert.rejects(indexOriginal(path, { ...expected, sha256: '0'.repeat(64) }), /SHA256 mismatch/);
  await symlink(path, join(directory, 'link.blb'));
  await assert.rejects(noSymlinks(join(directory, 'link.blb')), /Symlinks/);
});

test('ranges require explicit bounded inclusive endpoints and never permit whole-file transfer', () => {
  assert.deepEqual(boundedRange('bytes=7-23', 100), { start: 7, end: 23 });
  assert.deepEqual(boundedRange(`bytes=0-${MAX_RANGE_BYTES - 1}`, MAX_RANGE_BYTES + 1), { start: 0, end: MAX_RANGE_BYTES - 1 });
  for (const value of [undefined, 'bytes=0-', 'bytes=-8', 'bytes=0-99', 'bytes=99-100', 'bytes=2-1', 'bytes=0-1,4-5', 'bytes=0-9007199254740993']) assert.equal(boundedRange(value, 100), null);
  assert.equal(boundedRange(`bytes=0-${MAX_RANGE_BYTES}`, MAX_RANGE_BYTES + 2), null);
  assert.deepEqual(boundedRange(`bytes=0-${MAX_HD_RANGE_BYTES - 1}`, MAX_HD_RANGE_BYTES + 1, MAX_HD_RANGE_BYTES), { start: 0, end: MAX_HD_RANGE_BYTES - 1 });
  assert.equal(boundedRange(`bytes=0-${MAX_HD_RANGE_BYTES}`, MAX_HD_RANGE_BYTES + 2, MAX_HD_RANGE_BYTES), null);
});

async function serverFixture(t, { indexPaddingBytes = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neverhood-stream-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseDir = join(root, 'base'), directory = join(root, 'metadata');
  await mkdir(baseDir); await mkdir(directory); await mkdir(join(baseDir, 'game')); await mkdir(join(baseDir, 'cursor')); await mkdir(join(baseDir, 'rooms'));
  const bytes = original(), files = {}, sourcePaths = {}, hdBytes = Buffer.alloc(2 * MAX_RANGE_BYTES + 17, 123);
  const manifest = { version: 2, id: 'stream-test', fullGame: true, sourceRuntimeSHA256: RUNTIME_SHA256, runtimeSHA256: RUNTIME_SHA256,
    files: [], cursor: 'cursor/cursor.json', packs: { Scene1001: { file: 'rooms/Scene1001.zip', bytes: hdBytes.length, sha256: sha256(hdBytes), retainedExtra: 'preserve-me' } },
    rooms: { Scene1001: { backgroundKeys: ['640x480-640-12345678-p12345678-opaque'] } } };
  for (const name of REQUIRED_FILES) {
    const file = `game/${name}`;
    await writeFile(join(baseDir, file), bytes); sourcePaths[name] = join(baseDir, file);
    manifest.files.push({ name, file, bytes: bytes.length, sha256: sha256(bytes) });
    files[name] = { bytes: bytes.length, sha256: sha256(bytes), url: `/__stream-original/${name}`,
      hashes: Array.from({ length: 4 }, (_, i) => sha256(bytes.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE))) };
  }
  await writeFile(join(baseDir, 'cursor/cursor.json'), '{}');
  await writeFile(join(baseDir, 'cursor/sprite-sheet-128.png'), 'cursor');
  await writeFile(join(baseDir, 'rooms/Scene1001.zip'), hdBytes);
  await writeFile(join(baseDir, 'manifest.json'), JSON.stringify(manifest));
  const indexBytes = Buffer.from(JSON.stringify({ version: 1, blockSize: BLOCK_SIZE, runtimeSHA256: RUNTIME_SHA256, files, fixturePadding: 'x'.repeat(indexPaddingBytes) }));
  await writeFile(join(directory, 'streaming-index.json'), indexBytes);
  manifest.streaming = { version: 1, index: { file: 'streaming-index.json', bytes: indexBytes.length, sha256: sha256(indexBytes) } };
  await mkdir(join(directory, 'streamed-hd'));
  const hdIndex = Buffer.from(JSON.stringify({ version: 1, room: 'Scene1001', url: '/__stream-hd/Scene1001.zip' }));
  await writeFile(join(directory, 'streamed-hd/Scene1001.json'), hdIndex);
  manifest.packs.Scene1001.streaming = { index: { file: 'streamed-hd/Scene1001.json', bytes: hdIndex.length, sha256: sha256(hdIndex) } };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'streaming-local.json'), JSON.stringify({ version: 1, baseDir, sourcePaths }));
  const server = await createStreamingServer({ directory });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const port = server.address().port;
  const get = (path, headers = {}, method = 'GET') => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => done({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  return { bytes, hdBytes, get, directory, baseDir, port };
}

test('local server preserves HD fallback, overrides metadata, serves exact physical ranges and accounts actual body bytes', async t => {
  const { bytes, hdBytes, get, port } = await serverFixture(t);
  const config = await get('/hd-demo/config.json');
  assert.equal(JSON.parse(config.bytes).manifestURL, `http://127.0.0.1:${port}/__private-demo/manifest.json`);
  const manifest = JSON.parse((await get('/__private-demo/manifest.json')).bytes);
  const index = await get('/__private-demo/streaming-index.json');
  assert.equal(sha256(index.bytes), manifest.streaming.index.sha256);
  const zip = await get('/__private-demo/rooms/Scene1001.zip');
  assert.equal(zip.status, 200); assert.deepEqual(zip.bytes, hdBytes);
  assert.equal(manifest.packs.Scene1001.retainedExtra, 'preserve-me');
  for (const [start, end] of [[0, 16], [BLOCK_SIZE - 4, BLOCK_SIZE + 7], [bytes.length - 7, bytes.length - 1]]) {
    const response = await get('/__stream-original/a.blb', { Range: `bytes=${start}-${end}` });
    assert.equal(response.status, 206); assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(response.bytes, bytes.subarray(start, end + 1));
  }
  assert.equal((await get('/__stream-original/a.blb')).status, 416);
  assert.equal((await get('/__stream-original/a.blb', { Range: `bytes=0-${bytes.length - 1}` })).status, 416);
  const head = await get('/__stream-original/a.blb', { Range: 'bytes=0-15' }, 'HEAD');
  assert.equal(head.status, 206); assert.equal(head.bytes.length, 0);
  const stats = JSON.parse((await get('/__stream-stats')).bytes);
  assert.equal(stats.requests, 3); assert.equal(stats.completed, 3); assert.equal(stats.bytes, 36); assert.equal(stats.rejected, 2);
  assert(stats.ranges.every(range => range.complete));
  assert.equal(stats.original.bytes, 36); assert.equal(stats.hd.bytes, 0);
});

test('HD indexes are pinned and whitelisted; HD Range is exact, bounded and separately accounted', async t => {
  const { hdBytes, get } = await serverFixture(t);
  const manifest = JSON.parse((await get('/__private-demo/manifest.json')).bytes);
  const index = await get('/__private-demo/streamed-hd/Scene1001.json');
  assert.equal(index.status, 200); assert.equal(sha256(index.bytes), manifest.packs.Scene1001.streaming.index.sha256);
  const end = MAX_RANGE_BYTES + 7, response = await get('/__stream-hd/Scene1001.zip', { Range: `bytes=3-${end}` });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], `bytes 3-${end}/${hdBytes.length}`);
  assert.deepEqual(response.bytes, hdBytes.subarray(3, end + 1));
  assert.equal((await get('/__stream-hd/Scene1001.zip')).status, 416);
  assert.equal((await get('/__stream-hd/Scene1001.zip', { Range: `bytes=0-${hdBytes.length - 1}` })).status, 416);
  assert.equal((await get('/__stream-hd/Scene1001.zip', { Range: 'bytes=0-1,3-4' })).status, 416);
  assert.equal((await get('/__stream-hd/Scene1001.zip', { Range: 'bytes=0-15' }, 'HEAD')).status, 206);
  for (const path of ['/__stream-hd/Other.zip', '/__stream-hd/../rooms/Scene1001.zip', '/__private-demo/streamed-hd/Other.json', '/__private-demo/streamed-hd/../streaming-local.json']) assert.equal((await get(path, { Range: 'bytes=0-15' })).status, 404);
  for (const path of ['/__stream-hd/%53cene1001.zip', '/__private-demo/streamed-hd/%53cene1001.json']) assert.equal((await get(path)).status, 403);
  assert.equal((await get('/__stream-hd/Scene1001.zip', { Origin: 'https://evil.test', Range: 'bytes=0-15' })).status, 403);
  const stats = JSON.parse((await get('/__stream-stats')).bytes);
  assert.equal(stats.hd.bytes, end - 2); assert.equal(stats.hd.requests, 1); assert.equal(stats.hd.completed, 1); assert.equal(stats.hd.rejected, 3);
  assert.equal(stats.original.bytes, 0); assert.equal(stats.bytes, stats.hd.bytes);
  assert.equal(stats.ranges[0].kind, 'hd');
});

test('all HTTP responses retain isolation including parent, player iframe, static modules, worker and runtime fallback', async t => {
  const { get } = await serverFixture(t);
  for (const path of ['/hd-demo/', '/player.html?demo=1', '/prototype/read-frame.js', '/lib/zip-worker.js', '/runtime/scummvm.js', '/runtime/scummvm.wasm', '/__private-demo/rooms/Scene1001.zip', '/__private-demo/streamed-hd/Scene1001.json', '/__stream-stats']) {
    const response = await get(path, {}, 'HEAD');
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin', path);
    assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp', path);
  }
});

test('server admits all-room indexes over4MiB while retaining a16MiB hard bound', async t => {
  const { get, directory } = await serverFixture(t, { indexPaddingBytes: 5 * 1024 ** 2 });
  const response = await get('/__private-demo/streaming-index.json');
  assert.equal(response.status, 200);
  assert(response.bytes.length > 4 * 1024 ** 2 && response.bytes.length < INDEX_LIMIT_BYTES);
  await writeFile(join(directory, 'streaming-index.json'), Buffer.alloc(INDEX_LIMIT_BYTES + 1));
  await assert.rejects(createStreamingServer({ directory }), /Metadata exceeds budget/);
});

test('server rejects cross-origin, DNS rebinding, encoded traversal, undeclared assets and changed originals', async t => {
  const { get, baseDir } = await serverFixture(t);
  for (const headers of [{ Host: 'evil.test' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    for (const route of ['/hd-demo/config.json', '/__stream-stats', '/__private-demo/manifest.json', '/__stream-original/a.blb']) assert.equal((await get(route, headers)).status, 403);
  }
  assert.equal((await get('/__stream-original/%61.blb', { Range: 'bytes=0-1' })).status, 403);
  assert.equal((await get('/__stream-original/../manifest.json', { Range: 'bytes=0-1' })).status, 404);
  assert.equal((await get('/__stream-original/not.blb', { Range: 'bytes=0-1' })).status, 404);
  assert.equal((await get('/__private-demo/streaming-local.json')).status, 404);
  assert.equal((await get('/__stream-stats?reset=1')).status, 403);
  assert.equal((await get('/__stream-stats', {}, 'POST')).status, 405);
  const path = join(baseDir, 'game/a.blb'), bytes = await readFile(path); bytes[123] ^= 1; await writeFile(path, bytes);
  assert.equal((await get('/__stream-original/a.blb', { Range: 'bytes=0-15' })).status, 409);
});
