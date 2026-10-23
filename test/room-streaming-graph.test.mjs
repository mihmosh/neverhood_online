import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { decodeEngineData, deriveRoomGraph, deriveRoomGraphFromSources, parseNativeScenes } from '../scripts/derive-room-streaming-graph.mjs';

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
function fixtureData() {
  return Buffer.concat([
    u32(0x11223344), u32(0),
    u32(1), u32(0x00400001), u32(1), Buffer.alloc(2), u32(0x11111111),
    u32(0), u32(0),
    u32(1), u32(0x004b67b8), u32(1),
    u32(0x2048a041), u32(0x820820c1), u32(0x80080061), u32(0), Buffer.from([1, 0]), u32(0),
    u32(0), u32(0)
  ]);
}
const source = (file, text) => ({ file: `engines/neverhood/${file}`, text });
const sources = [source('modules/module1000.cpp', `
Module1000::Module1000(int x) { load(0x22222222); }
void Module1000::createScene(int sceneNum, int which) {
 switch (_sceneNum) {
 case 0: _childObject = new Scene1001(); break;
 case 1: createNavigationScene(0x004B67B8, which); break;
 case 2: createStaticScene(0xC084110C, 0x41108C00); break;
 case 3: case 4: _childObject = new Scene1005(); break;
 default: break;
 }
}
void Module1000::updateScene() {
 switch (_sceneNum) {
 case 0: if (result) createScene(1, 0); else createScene(2, 0); break;
 case 1: switch(result) { case 0: createScene(0, 0); break; case 1: leaveModule(0); break; } break;
 case 2: createScene(_previous, 0); break;
 }
}
Scene1001::Scene1001() { setMessageList(0x00400001); insertSprite<AsScene1001>(); }
void Scene1001::update() { load(0x33333333); /* 0xDEADBEEF */ }
Scene1005::Scene1005() : _resource(0x55555555) {}
`), source('modules/module1000_sprites.cpp', `
AsScene1001::AsScene1001() { load(0x44444444); }
void AsScene1001::update() { const char *ignored = "0xDEADBEEF"; }
`)];

function fixture() {
  const entries = [
    { hash: 0x11111111, offset: 100, diskSize: 100 },
    { hash: 0x22222222, offset: 65530, diskSize: 30 },
    { hash: 0x33333333, offset: 131100, diskSize: 10 },
    { hash: 0x44444444, compression: 0x65, diskSize: 0x11111111 },
    { hash: 0x55555555, offset: 190000, diskSize: 10 },
    { hash: 0x2048a041, type: 10, offset: 200000, diskSize: 120000 },
    { hash: 0x820820c1, type: 10, offset: 330000, diskSize: 100 },
    { hash: 0x80080061, type: 10, offset: 340000, diskSize: 100 },
    { hash: 0x99999999, type: 10, offset: 350000, diskSize: 100 }
  ].map(entry => ({ type: 2, compression: 1, timestamp: 1, ...entry }));
  return { sources, engineData: fixtureData(), manifest: { packs: { Scene1001: {}, 'Module1000-C084110C': {} } },
    files: { 'a.blb': { bytes: 400000, hashes: Array(7).fill('a'.repeat(64)) } },
    tables: { 'a.blb': { entries } } };
}

test('decodes exact navigation fields and binary offsets, not guessed scene links', () => {
  const data = decodeEngineData(fixtureData());
  const list = data.navigationLists.get(0x004b67b8);
  assert.equal(list.bytes, 30);
  assert.equal(list.items[0].offset, list.offset + 8);
  assert.deepEqual(list.items[0], { offset: list.offset + 8, fileHash: 0x2048a041,
    leftSmackerFileHash: 0x820820c1, rightSmackerFileHash: 0x80080061, middleSmackerFileHash: 0,
    interactive: 1, middleFlag: 0, mouseCursorFileHash: 0 });
  assert.deepEqual(data.references.get(0x00400001), [0x11111111]);
  assert.throws(() => decodeEngineData(fixtureData().subarray(0, -1)), /Truncated/);
  assert.throws(() => decodeEngineData(Buffer.concat([fixtureData(), Buffer.alloc(1)])), /trailing/);
  const corrupt = fixtureData(); corrupt.writeUInt32LE(1, 4);
  assert.throws(() => decodeEngineData(corrupt), /version/);
});

test('native scene cases retain nested update edges, fallthrough, static and HD identities', () => {
  const parsed = parseNativeScenes(sources);
  assert.equal(parsed.scenes.length, 5);
  assert.deepEqual(parsed.scenes[0].neighbors, ['1000:1', '1000:2']);
  assert.deepEqual(parsed.scenes[1].neighbors, ['1000:0']);
  assert.match(parsed.scenes[1].unresolvedEdges[0], /cross-module/);
  assert.deepEqual(parsed.scenes[2].backgrounds, ['C084110C']);
  assert.deepEqual(parsed.scenes[2].unresolvedEdges, ['dynamic-scene-destination']);
  assert.deepEqual(parsed.scenes[3].sceneClasses, ['Scene1005']);
  assert.deepEqual(parsed.scenes[4].sceneClasses, ['Scene1005']);
});

test('bounded scene/member/module resources and binary movie lists exclude unrelated media', () => {
  const graph = deriveRoomGraphFromSources(fixture());
  const room = graph.rooms['1000:0'];
  assert.equal(room.hdRoom, 'Scene1001');
  assert.equal(graph.rooms['1000:2'].hdRoom, 'Module1000-C084110C');
  assert.deepEqual(room.resources.map(entry => entry.hash), ['11111111', '22222222', '33333333', '44444444']);
  assert.equal(room.resources.at(-1).resolvedHash, '11111111');
  assert.deepEqual(room.blocks, [{ name: 'a.blb', index: 0 }, { name: 'a.blb', index: 1 }, { name: 'a.blb', index: 2 }]);
  assert.deepEqual(graph.rooms['1000:1'].videoHashes, ['2048a041', '80080061', '820820c1']);
  assert.equal(graph.videos['2048a041'].bytes, 120000);
  assert.equal(graph.videos['2048a041'].navigation, true);
  assert.deepEqual(graph.videos['2048a041'].evidence[0], { list: '004b67b8', item: 0,
    offset: decodeEngineData(fixtureData()).navigationLists.get(0x004b67b8).items[0].offset,
    field: 'fileHash', room: '1000:1' });
  assert.equal(graph.videos['99999999'], undefined);
  assert.equal(graph.evidence.closureProven, false);
  assert(Object.values(graph.rooms).every(room => !room.closureProven && room.unresolved.length));
});

test('strict timestamp precedence then alias resolution; cycles and unverified spans fail closed', () => {
  const input = fixture();
  input.tables['c.blb'] = { entries: [
    { ...input.tables['a.blb'].entries[0], timestamp: 1, offset: 200 },
    { ...input.tables['a.blb'].entries[2], timestamp: 2, offset: 250 }
  ] };
  input.files['c.blb'] = { bytes: 1000, hashes: ['b'.repeat(64)] };
  const room = deriveRoomGraphFromSources(input).rooms['1000:0'];
  assert.equal(room.resources[0].name, 'a.blb');
  assert.equal(room.resources[2].name, 'c.blb');
  assert.equal(room.resources[3].name, 'a.blb');
  input.tables['a.blb'].entries[0].compression = 0x65;
  input.tables['a.blb'].entries[0].diskSize = 0x44444444;
  assert.throws(() => deriveRoomGraphFromSources(input), /alias cycle/);
  const unverified = fixture(); unverified.files['a.blb'].hashes[0] = '';
  assert.throws(() => deriveRoomGraphFromSources(unverified), /verified physical block/);
});

test('typed shared hash helpers include source-local resource tables without unrelated owner methods', () => {
  const input = fixture();
  input.sources = [...input.sources.map(item => ({ ...item, text: item.text.replace('load(0x22222222);',
    'load(0x22222222); load(_vm->_gameModule->getMusicHash());') })),
  source('neverhood.h', 'class Engine { GameModule *_gameModule; };'),
  source('gamemodule.cpp', `
static const uint32 musicHashes[] = { 0x55555555, 0x33333333 };
static const uint32 unrelatedHashes[] = { 0x99999999 };
uint32 GameModule::getMusicHash() { return musicHashes[state]; }
void GameModule::unrelated() { load(0x99999999); }
`), source('modules/unrelated.cpp', 'static const uint32 musicHashes[] = { 0x99999999 };')];
  const room = deriveRoomGraphFromSources(input).rooms['1000:0'];
  assert(room.resources.some(resource => resource.hash === '55555555'));
  assert(!room.resources.some(resource => resource.hash === '99999999'));
  assert.deepEqual(room.evidence.sharedHelpers.map(item => item.member), ['GameModule::getMusicHash']);
  assert.deepEqual(room.evidence.resourceArrays.map(item => item.name), ['musicHashes']);
});

test('pointer-returning scoped helpers resolve multiline named hashes and preserve evidence lines', () => {
  const input = fixture();
  input.tables['a.blb'].entries.push({ hash: 0x0002486a, type: 5, compression: 1, timestamp: 1, offset: 190100, diskSize: 582 });
  input.sources = [...input.sources, source('font.cpp', `
Font *Factory::createFont() { load(calcHash(
  "asRecFont"
)); }
void Factory::unused() { load(0x99999999); }
`)];
  input.sources[0] = { ...input.sources[0], text: input.sources[0].text.replace('load(0x33333333);', 'load(0x33333333); Factory::createFont();') };
  const room = deriveRoomGraphFromSources(input).rooms['1000:0'];
  assert(room.resources.some(resource => resource.hash === '0002486a'));
  assert.deepEqual(room.evidence.sharedHelpers.map(helper => [helper.member, helper.line]), [['Factory::createFont', 2]]);
  assert(!room.resources.some(resource => resource.hash === '99999999'));
});

test('HD state IDs require an actual class/background state, not an arbitrary prefix', () => {
  const input = fixture();
  input.sources = input.sources.map(item => ({ ...item, text: item.text.replace('setMessageList(0x00400001);',
    'setMessageList(0x00400001); uint32 bg; if (state) bg = 0x11111111; else bg = 0x33333333; setBackground(bg);') }));
  input.manifest.packs = { 'Scene1001-11111111-approved': {}, 'Scene1001-33333333-approved': {},
    'Scene1001-DEADBEEF-unrelated': {}, 'Scene1005-11111111-wrong-class': {} };
  const graph = deriveRoomGraphFromSources(input);
  assert.deepEqual(graph.rooms['1000:0'].hdRooms, ['Scene1001-11111111-approved', 'Scene1001-33333333-approved']);
  assert.equal(graph.rooms['1000:0'].hdRoom, null);
  assert.deepEqual(graph.evidence.unmappedHDRooms, ['Scene1001-DEADBEEF-unrelated', 'Scene1005-11111111-wrong-class']);
  assert.deepEqual(graph.rooms['1000:3'].resources.map(item => item.hash), ['22222222', '55555555']);
});

test('cross-module routing follows GameModule and constructor which, without assuming index zero', () => {
  const input = fixture();
  input.sources = [...input.sources, source('gamemodule.cpp', `
void GameModule::updateModule() { switch (_moduleNum) {
case 1000: createModule(2300, 0); break;
default: break;
} }
`), source('modules/module2300.cpp', `
Module2300::Module2300(int which) {
 if (which < 0) createScene(_saved, -1);
 else if (which == 1) createScene(2, 0);
 else createScene(0, 0);
}
void Module2300::createScene(int sceneNum, int which) { switch (_sceneNum) {
 case 0: createNavigationScene(0x004B67B8, which); break;
 case 2: createStaticScene(0x11111111, 0x22222222); break;
} }
void Module2300::updateScene() { switch (_sceneNum) { case 0: createScene(2, 0); break; } }
`)];
  const graph = deriveRoomGraphFromSources(input);
  assert(graph.rooms['1000:1'].neighbors.includes('2300:0'));
  assert(!graph.rooms['1000:0'].neighbors.includes('2300:0'));
  const entry = graph.rooms['1000:1'].neighborEntries[0];
  assert.equal(entry.which, 0);
  assert.equal(entry.moduleEntry, 0);
  assert.equal(entry.moduleResult, 0);
  assert.deepEqual(entry.entryVideoHashes, ['2048a041']);
  assert.deepEqual(graph.rooms['2300:0'].entryVideoHashes, ['2048a041']);
  assert.deepEqual(graph.rooms['1000:1'].unresolvedEdges, ['cross-module-exit-requires-GameModule-result-routing']);
  assert.equal(graph.rooms['1000:1'].closureProven, false);
});

test('actual read-only native sources cover every module createScene case and authoritative navigation lists', async () => {
  const graph = await deriveRoomGraph({ files: {}, tables: {}, manifest: { packs: {} } });
  assert.equal(graph.evidence.roomCount, 244);
  assert.equal(graph.evidence.moduleCount, 21);
  assert.equal(graph.evidence.navigationListCount, 51);
  assert.equal(graph.evidence.referencedNavigationListCount, 51);
  assert.equal(graph.evidence.navigationRoomCount, 40);
  assert.deepEqual(graph.rooms['1000:0'].sceneClasses, ['Scene1001']);
  assert.deepEqual(graph.rooms['1000:2'].staticBackgrounds, ['C084110C']);
  assert.deepEqual(graph.rooms['2300:0'].navigationListIds, ['004b67b8']);
  assert.equal(graph.rooms['2300:0'].navigationLists[0].items[0].fileHash, 0x2048a041);
  assert(graph.rooms['1000:1'].neighbors.includes('2300:0'));
  const exit = graph.rooms['1000:1'].neighborEntries.find(entry => entry.room === '2300:0');
  assert.equal(exit.which, 1);
  assert.deepEqual(exit.entryVideoHashes, ['2028a041']);
  assert.deepEqual(graph.rooms['2300:0'].entryVideoHashes, ['2028a041', '2048a041']);
  assert.deepEqual(graph.rooms['2300:0'].entryVideoHashesByWhich[1], ['2028a041']);
  assert.deepEqual(graph.rooms['2000:1'].navigationListIds, ['004b7b00', '004b7b48']);
  assert.equal(graph.rooms['3000:1'].navigationListIds.length, 3);
  assert.deepEqual(graph.rooms['2800:12'].staticBackgrounds, ['0000A245']);
  assert(graph.rooms['2800:2'].evidence.sharedHelpers.some(item => item.member === 'GameModule::getCurrRadioMusicFileHash'));
  assert(graph.rooms['2800:2'].evidence.resourceArrays.some(item => item.name === 'kRadioMusicFileHashes'));
  assert(graph.rooms['2700:0'].neighbors.includes('2700:1'));
  assert(graph.rooms['3000:1008'].unresolved.includes('dynamic-Smacker-hash'));
  assert(graph.rooms['2300:0'].missingVideoHashes.includes('2048a041'));
  assert(graph.rooms['2200:9'].neighbors.length > 0);
  const moduleFiles = (await readdir(new URL('../scummvm/engines/neverhood/modules/', import.meta.url))).filter(file => /^module\d+\.cpp$/.test(file));
  let expected = 0;
  for (const file of moduleFiles) {
    const text = await readFile(new URL(`../scummvm/engines/neverhood/modules/${file}`, import.meta.url), 'utf8');
    const create = text.split(/void Module\d+::createScene\(/)[1]?.split('SetUpdateHandler')[0] ?? '';
    expected += [...create.matchAll(/\bcase\s+\d+\s*:/g)].length;
  }
  assert.equal(graph.evidence.roomCount, expected);
  console.log(JSON.stringify({ nativeRooms: graph.evidence.roomCount, modules: graph.evidence.moduleCount,
    navigationLists: graph.evidence.navigationListCount, referencedNavigationLists: graph.evidence.referencedNavigationListCount,
    navigationRooms: graph.evidence.navigationRoomCount, missingVideoHashes: graph.evidence.missingVideoHashes.length }));
});

test('Scene2803 actual shared radio selector closes both physical resources crossing a.blb block 412', async () => {
  const graph = await deriveRoomGraph({
    files: { 'a.blb': { bytes: 28059697, hashes: Array(429).fill('a'.repeat(64)) } },
    tables: { 'a.blb': { entries: [
      { hash: 0x82b22000, type: 8, compression: 1, timestamp: 3997947822, offset: 25363504, diskSize: 1669120 },
      { hash: 0x02b22001, type: 8, compression: 1, timestamp: 3991385818, offset: 27032624, diskSize: 1027073 }
    ] } }, manifest: { packs: { 'Scene2803-29800A01-b1f53112': {}, 'Scene2803-412A423E-ecd4da1e': {} } }
  });
  const room = graph.rooms['2800:2'];
  assert.deepEqual(room.resources.map(item => item.hash), ['02b22001', '82b22000']);
  for (let index = 387; index <= 428; index++) assert(room.blocks.some(block => block.name === 'a.blb' && block.index === index));
  assert.equal(room.hdRoom, null);
  assert.deepEqual(room.hdRooms, ['Scene2803-29800A01-b1f53112', 'Scene2803-412A423E-ecd4da1e']);
});

test('notes below room two include both font variants and text as lower-room neighbor dependencies', async () => {
  const graph = await deriveRoomGraph({
    files: { 'i.blb': { bytes: 196608, hashes: Array(3).fill('a'.repeat(64)) } },
    tables: { 'i.blb': { entries: [
      { hash: 0xc6604282, type: 2, compression: 1, timestamp: 1, offset: 100, diskSize: 100 },
      { hash: 0x283ce401, type: 2, compression: 1, timestamp: 1, offset: 65530, diskSize: 100 },
      { hash: 0x80283101, type: 6, compression: 1, timestamp: 1, offset: 131100, diskSize: 100 },
      { hash: 0x0002486a, type: 5, compression: 1, timestamp: 1, offset: 65560, diskSize: 582 },
    ] } }, manifest: { packs: {} },
  });
  assert(graph.rooms['1000:3'].neighbors.includes('1000:4'));
  assert.deepEqual(graph.rooms['1000:4'].sceneClasses, ['Scene1005']);
  assert.deepEqual(graph.rooms['1000:4'].resources.map(resource => resource.hash), ['0002486a', '283ce401', '80283101', 'c6604282']);
  assert(graph.rooms['1000:4'].evidence.sharedHelpers.some(helper => helper.member === 'FontSurface::createFontSurface'));
  assert.deepEqual(graph.rooms['1000:4'].blocks, [0, 1, 2].map(index => ({ name: 'i.blb', index })));
});
