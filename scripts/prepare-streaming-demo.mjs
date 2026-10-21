import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REQUIRED_FILES, validateHeader } from '../web/lib/validation.js';
import { validateDemoManifest } from '../web/lib/demo-data.js';
import { decodeEngineData, parseNativeScenes } from './derive-room-streaming-graph.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BLOCK_SIZE = 65536;
export const PRELOAD_LIMIT_BYTES = 32 * 1024 ** 2;
export const INDEX_LIMIT_BYTES = 16 * 1024 ** 2;
export const RUNTIME_SHA256 = '31bdb5fa1afcdf80a6895e2fe5c87a5a999a245af85de7326df20f0756e0d83c';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, path) => path === base || path.startsWith(base + sep);

export async function noSymlinks(path) {
  assert(isAbsolute(path) && resolve(path) === path, 'Canonical absolute path required');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    assert(!(await lstat(current)).isSymbolicLink(), 'Symlinks are forbidden');
  }
  assert.equal(await realpath(path), path);
}

async function readExactly(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    assert(bytesRead > 0, 'Truncated input');
    offset += bytesRead;
  }
}

export async function indexOriginal(path, expected) {
  await noSymlinks(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = Number(before.size);
    assert(before.isFile() && bytes === expected.bytes, 'Original size mismatch');
    const header = Buffer.alloc(16);
    await readExactly(handle, header, 0);
    validateHeader(header, bytes, expected.name);
    const tableBytes = 16 + header.readUInt32LE(12) * 24 + header.readUInt16LE(6);
    assert(tableBytes <= 4 * 1024 ** 2, 'BLB table exceeds metadata budget');
    const table = Buffer.alloc(tableBytes);
    await readExactly(handle, table, 0);
    const entries = [], count = header.readUInt32LE(12);
    for (let i = 0; i < count; i++) {
      const at = 16 + count * 4 + i * 20;
      const entry = { name: expected.name, hash: table.readUInt32LE(16 + i * 4), type: table[at],
        compression: table[at + 1], timestamp: table.readUInt32LE(at + 4),
        offset: table.readUInt32LE(at + 8), diskSize: table.readUInt32LE(at + 12) };
      if (entry.compression !== 0x65) assert(entry.offset + entry.diskSize <= bytes, 'Invalid physical BLB span');
      entries.push(entry);
    }
    const hashes = [], full = createHash('sha256'), buffer = Buffer.alloc(BLOCK_SIZE);
    for (let start = 0; start < bytes; start += BLOCK_SIZE) {
      const block = buffer.subarray(0, Math.min(BLOCK_SIZE, bytes - start));
      await readExactly(handle, block, start);
      hashes.push(sha256(block)); full.update(block);
    }
    const digest = full.digest('hex'), after = await handle.stat({ bigint: true });
    assert.equal(digest, expected.sha256, 'Original SHA256 mismatch');
    assert(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'Original changed during indexing');
    const resources = entries.map(entry => ({ hash: entry.hash.toString(16).padStart(8, '0'), type: entry.type,
      offset: entry.offset, bytes: entry.compression === 0x65 ? 0 : entry.diskSize, compression: entry.compression,
      ...(entry.compression === 0x65 ? { alias: entry.diskSize.toString(16).padStart(8, '0') } : {}) }));
    return { file: { bytes, sha256: digest, url: `/__stream-original/${expected.name}`, hashes, resources }, tableBytes, entries };
  } finally { await handle.close(); }
}

const refs = set => [...set].sort().map(value => { const [name, index] = value.split('/'); return { name, index: Number(index) }; });
function addSpan(set, name, position, count, files) {
  assert(Object.hasOwn(files, name), 'Trace references unknown archive');
  assert(Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(count) && count >= 0 && position + count <= files[name].bytes, 'Invalid traced physical read');
  for (let i = Math.floor(position / BLOCK_SIZE); count && i <= Math.floor((position + count - 1) / BLOCK_SIZE); i++) set.add(`${name}/${i}`);
}

export function sourceLiteralHashes(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  return [...new Set([...code.matchAll(/\b0x([a-fA-F0-9]{8})\b/g)].map(match => parseInt(match[1], 16)))];
}

export function deriveMenuCommon(files, tables, sources, engineData) {
  const data = decodeEngineData(engineData), winners = new Map();
  for (const name of REQUIRED_FILES) for (const entry of tables[name].entries) {
    if (!winners.has(entry.hash) || entry.timestamp > winners.get(entry.hash).timestamp) winners.set(entry.hash, entry);
  }
  const hashes = new Set(sources.flatMap(source => sourceLiteralHashes(source.text))), visited = new Set();
  const expand = hash => {
    if (visited.has(hash)) return;
    visited.add(hash);
    for (const ref of data.references.get(hash) ?? []) { hashes.add(ref); expand(ref); }
  };
  for (const hash of [...hashes]) expand(hash);
  const blocks = new Set(), resources = [], videos = [];
  for (const hash of [...hashes].sort((a, b) => a - b)) {
    let entry = winners.get(hash);
    const aliases = new Set();
    while (entry?.compression === 0x65) {
      assert(!aliases.has(entry.hash), 'Menu BLB alias cycle'); aliases.add(entry.hash);
      entry = winners.get(entry.diskSize);
      assert(entry, 'Missing menu BLB alias target');
    }
    if (!entry || !entry.diskSize) continue;
    if (entry.type === 10) { videos.push(hash.toString(16).padStart(8, '0')); continue; }
    addSpan(blocks, entry.name, entry.offset, entry.diskSize, files);
    resources.push({ hash: hash.toString(16).padStart(8, '0'), resolvedHash: entry.hash.toString(16).padStart(8, '0'),
      name: entry.name, offset: entry.offset, bytes: entry.diskSize });
  }
  return { blocks: refs(blocks), resources, videos,
    sources: sources.map(source => ({ file: source.file, sha256: sha256(source.text) })),
    engineDataSHA256: data.sha256,
    qualification: 'native-menu-all-states-nonvideo-source-literals-and-recursive-static-data-winning-physical-spans; movies-excluded' };
}

export async function loadMenuSources() {
  const sources = [];
  const helpers = {
    'gamemodule.cpp': ['GameModule', 'checkRequests', 'openMainMenu', 'createMenuModule', 'updateMenuModule'],
    'scene.cpp': ['Scene', 'insertScreenMouse', 'insertStaticSprite'],
    'graphics.cpp': ['FontSurface'],
  };
  for (const file of ['menumodule.cpp', 'menumodule.h', 'mouse.cpp', 'mouse.h', ...Object.keys(helpers)]) {
    const path = resolve(root, 'scummvm/engines/neverhood', file);
    await noSymlinks(path);
    const text = await readFile(path, 'utf8');
    const selected = helpers[file] ? parseNativeScenes([{ file, text }]).functions
      .filter(member => helpers[file].includes(member.name)).map(member => member.text).join('\n') : text;
    sources.push({ file: `engines/neverhood/${file}`, text: selected });
  }
  return sources;
}

export function mergeMenuCommon(index, menu, files) {
  const common = new Set([...index.common, ...menu.blocks].map(ref => `${ref.name}/${ref.index}`));
  const measure = list => [...new Set(list.map(ref => `${ref.name}/${ref.index}`))].reduce((sum, value) => {
    const [name, block] = value.split('/');
    return sum + Math.min(BLOCK_SIZE, files[name].bytes - Number(block) * BLOCK_SIZE);
  }, 0);
  const budget = { ...index.evidence.budget, commonBytes: measure(refs(common)) };
  const initialIds = budget.initialRoomIds ?? ['1000:0', ...(index.rooms['1000:0']?.neighbors ?? [])];
  budget.firstRoomBytes = measure([...index.bootstrap, ...refs(common), ...(index.rooms['1000:0']?.blocks ?? [])]);
  budget.firstRoomAndNeighborsBytes = measure([...index.bootstrap, ...refs(common), ...initialIds.flatMap(id => index.rooms[id]?.blocks ?? [])]);
  if (index.rooms['2300:0']) {
    const initial = [...index.bootstrap, ...refs(common), ...initialIds.flatMap(id => index.rooms[id]?.blocks ?? [])];
    const entry = index.rooms['2300:0'];
    const next = [...initial, ...entry.blocks, ...(budget.module2300EntryVideoHashes ?? []).flatMap(hash => index.videos[hash].blocks)];
    budget.module2300TransitionResidentBytes = measure(next);
    budget.module2300TransitionAdditionalBytes = measure(next) - measure(initial);
    budget.module2300TransitionWithin32MiB = measure(next) <= PRELOAD_LIMIT_BYTES;
    budget.module2300AssociatedVideosResidentBytes = measure([...initial, ...entry.blocks, ...(entry.videoHashes ?? []).flatMap(hash => index.videos[hash].blocks)]);
  }
  assert(budget.firstRoomAndNeighborsBytes <= PRELOAD_LIMIT_BYTES, 'Menu common exceeds32MiB initial preload');
  return { ...index, common: refs(common), evidence: { ...index.evidence, budget, menuCommon: menu } };
}

export function deriveDependencies(trace, files, tables, sources = []) {
  assert(trace.mode === 'cold' && Array.isArray(trace.trace?.reads), 'A cold read trace is required');
  const checkpoint = trace.checkpoints.find(entry => entry.label === 'room1');
  assert(Number.isSafeInteger(checkpoint?.reads) && checkpoint.reads > 0 && checkpoint.reads <= trace.trace.reads.length, 'Missing initial room checkpoint');
  const bootstrap = new Set(), observed = new Set(), groups = new Map(), videos = {};
  const winners = new Map(), selected = new Map();
  for (const name of REQUIRED_FILES) for (const entry of tables[name].entries) {
    if (!winners.has(entry.hash) || entry.timestamp > winners.get(entry.hash).timestamp) winners.set(entry.hash, entry);
  }
  const resolveResource = hash => {
    let entry = winners.get(hash);
    const visited = new Set();
    while (entry?.compression === 0x65) {
      assert(!visited.has(entry.hash), 'BLB alias cycle'); visited.add(entry.hash);
      entry = winners.get(entry.diskSize);
    }
    return entry;
  };
  const includeResource = (blocks, entry) => {
    assert(entry.compression !== 0x65, 'Aliases must resolve before physical expansion');
    addSpan(blocks, entry.name, entry.offset, entry.diskSize, files);
    selected.set(`${entry.name}/${entry.offset}/${entry.hash}`, entry);
  };
  for (const name of REQUIRED_FILES) addSpan(bootstrap, name, 0, tables[name].tableBytes, files);
  for (const [ordinal, read] of trace.trace.reads.entries()) {
    const blocks = new Set();
    addSpan(blocks, read.name, read.position, read.count, files);
    for (const block of blocks) observed.add(block);
    const encounteredVideos = new Set(read.videoHashes ?? []);
    // Intersect only original byte reads, never newly fetched block padding or expanded resources.
    for (const entry of tables[read.name].entries) {
      if (entry.compression !== 0x65 && entry.type === 10 && read.count > 0
          && read.position >= entry.offset && read.position < entry.offset + entry.diskSize) encounteredVideos.add(entry.hash.toString(16).padStart(8, '0'));
      if (entry.compression !== 0x65 && entry.type !== 10 && read.count > 0
          && entry.offset < read.position + read.count && entry.offset + entry.diskSize > read.position) includeResource(blocks, entry);
    }
    const startup = read.phase === 'startup' || ordinal < checkpoint.reads;
    if (startup) for (const block of blocks) bootstrap.add(block);
    const native = read.native ?? {};
    // Only Module1000 has a proven scene-number probe. Other modules retain observed type identity.
    const identity = Number.isInteger(native.module) ? native.module === 1000 && Number.isInteger(native.scene)
      ? `1000:${native.scene}` : `${native.module}:type:${native.sceneType ?? 'unknown'}` : null;
    if (identity && native.module === 1000) {
      if (!groups.has(identity)) groups.set(identity, new Set());
      for (const block of blocks) groups.get(identity).add(block);
    }
    for (const hash of encounteredVideos) {
      assert(/^[a-f0-9]{8}$/.test(hash), 'Invalid traced video hash');
      const video = videos[hash] ??= { blocks: new Set(), identities: new Set(), phases: new Set(), observed: new Set(), startup: false };
      const entry = resolveResource(parseInt(hash, 16));
      assert(entry?.type === 10 && entry.diskSize > 0, 'Observed video must resolve to a physical Smacker');
      includeResource(video.blocks, entry);
      video.resource = { name: entry.name, offset: entry.offset, bytes: entry.diskSize };
      addSpan(video.observed, read.name, read.position, read.count, files);
      video.startup ||= startup;
      if (startup) {
        assert(entry.diskSize <= PRELOAD_LIMIT_BYTES, `Startup video ${hash} exceeds32MiB: ${entry.diskSize}`);
        for (const block of video.blocks) bootstrap.add(block);
      }
      if (identity) video.identities.add(identity);
      video.phases.add(read.phase);
    }
  }
  const recorded = new Set(trace.trace.blocks.map(block => `${block.name}/${block.block}`));
  assert.deepEqual([...observed].sort(), [...recorded].sort(), 'Read trace and fetched physical block union disagree');
  const common = new Set(bootstrap);
  const staticSources = sources.map(source => {
    const resolved = [];
    for (const hash of sourceLiteralHashes(source.text)) {
      const entry = resolveResource(hash);
      if (!entry || entry.type === 10 || !entry.diskSize) continue;
      includeResource(common, entry);
      resolved.push(hash.toString(16).padStart(8, '0'));
    }
    return { file: source.file, sha256: sha256(source.text), resolved,
      qualification: 'conservative-literal-winning-resource-items-not-control-flow-or-transitive-closure' };
  });
  const ownership = new Map();
  for (const blocks of groups.values()) for (const block of blocks) ownership.set(block, (ownership.get(block) ?? 0) + 1);
  for (const [block, count] of ownership) if (count > 1) common.add(block);
  const rooms = {};
  const mapping = { '1000:0': ['Scene1001', ['1000:1', '1000:2']], '1000:1': ['Scene1002', ['1000:0', '1000:3']], '1000:3': ['Scene1004', ['1000:1']] };
  for (const [id, [hdRoom, neighbors]] of Object.entries(mapping)) {
    assert(groups.has(id), `Missing observed room ${id}`);
    rooms[id] = { blocks: refs(new Set([...groups.get(id)].filter(block => !common.has(block)))), hdRoom, neighbors,
      qualification: 'raw-read-intersected-complete-nonvideo-resources-including-entry-transition-plus-bounded-source-common', closureProven: false };
  }
  // Engine archive order, timestamp precedence, then compression-0x65 alias resolution.
  const window = new Set(), resources = [];
  for (const hash of [0xc084110c, 0x41108c00]) {
    const entry = resolveResource(hash);
    assert(entry && entry.diskSize > 0, 'Missing window physical resource');
    addSpan(window, entry.name, entry.offset, entry.diskSize, files);
    resources.push({ hash: hash.toString(16).padStart(8, '0'), resolvedHash: entry.hash.toString(16).padStart(8, '0'),
      name: entry.name, offset: entry.offset, bytes: entry.diskSize });
  }
  rooms['1000:2'] = { blocks: refs(new Set([...window].filter(block => !common.has(block)))), hdRoom: 'Module1000-C084110C',
    neighbors: ['1000:0'], resources, qualification: 'physical-winning-background-and-cursor-spans-plus-common-only', closureProven: false };
  const union = ids => new Set([...bootstrap, ...common, ...ids.flatMap(id => rooms[id].blocks.map(ref => `${ref.name}/${ref.index}`))]);
  const byteCount = blocks => [...blocks].reduce((sum, value) => {
    const [name, index] = value.split('/');
    return sum + Math.min(BLOCK_SIZE, files[name].bytes - Number(index) * BLOCK_SIZE);
  }, 0);
  const budget = { limit: PRELOAD_LIMIT_BYTES, bootstrapBytes: byteCount(bootstrap), commonBytes: byteCount(common),
    firstRoomBytes: byteCount(union(['1000:0'])), firstRoomAndNeighborsBytes: byteCount(union(['1000:0', '1000:1', '1000:2'])),
    routeBytes: byteCount(union(['1000:0', '1000:1', '1000:3'])), allIndexedRoomsBytes: byteCount(union(Object.keys(rooms))) };
  assert(budget.allIndexedRoomsBytes <= PRELOAD_LIMIT_BYTES, `Bounded preload exceeds32MiB: ${JSON.stringify(budget)}; largest resources ${JSON.stringify([...selected.values()].sort((a, b) => b.diskSize - a.diskSize).slice(0, 5))}`);
  return { bootstrap: refs(bootstrap), common: refs(common), rooms,
    videos: Object.fromEntries(Object.entries(videos).map(([hash, video]) => [hash, { blocks: refs(video.blocks),
      ...video.resource, observedBlocks: refs(video.observed), startup: video.startup,
      identities: [...video.identities].sort(), phases: [...video.phases].sort(),
      qualification: 'complete-physical-smacker-span-observed-association-only', navigation: false, closureProven: false }])),
    evidence: { qualification: 'bounded-cold-route-not-all-room-graph', route: ['1000:0', '1000:1', '1000:3'],
      routeBlocks: observed.size, navigationMovieObserved: trace.navigationMovieObserved === true,
      expansion: 'complete-nonvideo-physical-resources-intersecting-raw-reads-no-recursive-padding-expansion',
      staticSources, selectedResourceCount: selected.size, budget,
      sceneIdentity: 'Module1000 scene probe only; other modules use module plus observed sceneType', closureProven: false } };
}

export function mergeRoomGraph(dependencies, graph, files) {
  const blockKey = ref => `${ref.name}/${ref.index}`;
  const uniqueBlocks = lists => {
    const set = new Set(lists.flat().map(blockKey));
    for (const value of set) {
      const [name, index] = value.split('/');
      assert(files[name] && Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) * BLOCK_SIZE < files[name].bytes, 'Graph block outside original file');
    }
    return refs(set);
  };
  const unique = values => [...new Set(values)].sort();
  const videos = {};
  for (const hash of unique([...Object.keys(graph.videos), ...Object.keys(dependencies.videos)])) {
    const compiled = graph.videos[hash], observed = dependencies.videos[hash];
    if (compiled && observed) assert(compiled.name === observed.name && compiled.offset === observed.offset && compiled.bytes === observed.bytes, 'Graph and trace video physical spans disagree');
    videos[hash] = { ...compiled, ...observed, blocks: uniqueBlocks([compiled?.blocks ?? [], observed?.blocks ?? []]),
      identities: unique([...(compiled?.identities ?? []), ...(observed?.identities ?? [])]),
      startup: Boolean(compiled?.startup || observed?.startup), navigation: Boolean(compiled?.navigation || observed?.navigation),
      ...(observed ? { observedQualification: observed.qualification } : {}), closureProven: false };
  }
  // Startup movies remain explicitly in bootstrap, not in reusable nonvideo common content.
  const observedVideoBlocks = new Set(Object.values(dependencies.videos).flatMap(video => video.blocks.map(blockKey)));
  const common = dependencies.common.filter(ref => !observedVideoBlocks.has(blockKey(ref))), commonKeys = new Set(common.map(blockKey));
  const rooms = {};
  for (const id of unique([...Object.keys(graph.rooms), ...Object.keys(dependencies.rooms)])) {
    assert(/^\d+:\d+$/.test(id), 'Expected native module:scene identity');
    const compiled = graph.rooms[id], observed = dependencies.rooms[id];
    const hdRooms = unique([...(compiled?.hdRooms ?? []), ...(observed?.hdRoom ? [observed.hdRoom] : [])]);
    const blocks = uniqueBlocks([compiled?.blocks ?? [], observed?.blocks ?? []]).filter(ref => !commonKeys.has(blockKey(ref)));
    rooms[id] = { ...compiled, blocks, hdRooms, hdRoom: observed?.hdRoom ?? (hdRooms.length === 1 ? hdRooms[0] : null),
      neighbors: unique([...(compiled?.neighbors ?? []), ...(observed?.neighbors ?? [])]),
      videoHashes: unique(compiled?.videoHashes ?? []), entryVideoHashes: unique(compiled?.entryVideoHashes ?? []),
      ...(observed ? { observedQualification: observed.qualification, observedResourceSpans: observed.resources ?? [] } : {}),
      qualification: 'source-derived-nonvideo-items-plus-observed-full-resource-spans-minus-common; not-complete-closure', closureProven: false };
  }
  for (const room of Object.values(rooms)) {
    assert(room.neighbors.every(id => Object.hasOwn(rooms, id)), 'Graph neighbor must be a real native identity');
    assert([...room.videoHashes, ...room.entryVideoHashes].every(hash => Object.hasOwn(videos, hash)), 'Graph movie association must resolve');
    for (const entry of room.neighborEntries ?? []) {
      assert(Object.hasOwn(rooms, entry.room) && room.neighbors.includes(entry.room), 'Transition entry must target a real neighbor');
      assert((entry.entryVideoHashes ?? []).every(hash => Object.hasOwn(videos, hash)), 'Transition movie association must resolve');
    }
  }
  const hdRoomIdentities = {};
  for (const [id, room] of Object.entries(rooms)) for (const alias of unique([...room.hdRooms, ...(room.sceneClasses ?? [])])) {
    (hdRoomIdentities[alias] ??= []).push(id);
  }
  const roomAliases = Object.fromEntries(Object.entries(hdRoomIdentities).filter(([, ids]) => ids.length === 1).map(([alias, ids]) => [alias, ids[0]]));
  const measure = list => uniqueBlocks([list]).reduce((sum, ref) => sum + Math.min(BLOCK_SIZE, files[ref.name].bytes - ref.index * BLOCK_SIZE), 0);
  const initialIds = ['1000:0', ...(rooms['1000:0']?.neighbors ?? [])];
  const initial = uniqueBlocks([dependencies.bootstrap, common, ...initialIds.map(id => rooms[id]?.blocks ?? [])]);
  const entry = rooms['2300:0'];
  const inboundEntries = (rooms['1000:1']?.neighborEntries ?? []).filter(candidate => candidate.room === '2300:0');
  const entryHashes = inboundEntries.length ? unique(inboundEntries.flatMap(candidate => candidate.entryVideoHashes ?? [])) : entry?.entryVideoHashes ?? [];
  const entryVideos = entryHashes.flatMap(hash => videos[hash].blocks);
  const associatedVideos = (entry?.videoHashes ?? []).flatMap(hash => videos[hash].blocks);
  const next = uniqueBlocks([initial, entry?.blocks ?? [], entryVideos]);
  const initialKeys = new Set(initial.map(blockKey));
  const budget = { limit: PRELOAD_LIMIT_BYTES, bootstrapBytes: measure(dependencies.bootstrap), commonBytes: measure(common),
    firstRoomBytes: measure([...dependencies.bootstrap, ...common, ...(rooms['1000:0']?.blocks ?? [])]),
    firstRoomAndNeighborsBytes: measure(initial), initialRoomIds: initialIds,
    module2300EntryNoncommonBytes: measure(entry?.blocks ?? []), module2300EntryVideoHashes: entryHashes,
    module2300DefaultSceneEntryVideoHashes: entry?.entryVideoHashes ?? [], module2300InboundEntries: inboundEntries,
    module2300EntryVideoBytes: measure(entryVideos), module2300TransitionAdditionalBytes: measure(next.filter(ref => !initialKeys.has(blockKey(ref)))),
    module2300TransitionResidentBytes: measure(next), module2300TransitionWithin32MiB: measure(next) <= PRELOAD_LIMIT_BYTES,
    module2300AssociatedVideoBytes: measure(associatedVideos),
    module2300AssociatedVideosResidentBytes: measure([...initial, ...(entry?.blocks ?? []), ...associatedVideos]) };
  assert(budget.firstRoomAndNeighborsBytes <= PRELOAD_LIMIT_BYTES, `Initial room+neighbors exceed32MiB: ${JSON.stringify(budget)}`);
  return { ...dependencies, common, rooms, videos, roomAliases, hdRoomIdentities,
    evidence: { ...dependencies.evidence, qualification: 'observed-initial-route-plus-source-derived-all-native-identities-not-all-room-closure',
      observedBudget: dependencies.evidence.budget, budget, graph: graph.evidence,
      prefetchPolicy: 'initial-current-and-neighbor-nonvideo-only-plus-explicit-observed-startup; other-video-bundles-on-associated-entry-demand-only', closureProven: false } };
}

export async function prepareStreamingDemo({ baseDir, output, tracePath, originalDir = resolve(root, 'extracted/app/DATA'),
  runtime = resolve(root, 'web/public/runtime/scummvm.wasm') }) {
  await noSymlinks(baseDir);
  assert(isAbsolute(output) && resolve(output) === output && (!inside(root, output) || inside(resolve(root, 'private-assets'), output)), 'Output must be private');
  assert(!inside(baseDir, output) && !inside(output, baseDir), 'Base release is read-only');
  await noSymlinks(dirname(output));
  assert(!(await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; })), 'Use a new output directory');
  await noSymlinks(runtime);
  assert.equal(sha256(await readFile(runtime)), RUNTIME_SHA256, 'Use unchanged shipped runtime');
  await noSymlinks(resolve(baseDir, 'manifest.json'));
  const manifest = JSON.parse(await readFile(resolve(baseDir, 'manifest.json'), 'utf8'));
  validateDemoManifest(manifest, RUNTIME_SHA256);
  assert.equal(manifest.runtimeSHA256, RUNTIME_SHA256);
  assert.equal(manifest.sourceRuntimeSHA256, RUNTIME_SHA256);
  const files = {}, tables = {}, sourcePaths = {};
  for (const name of REQUIRED_FILES) {
    const expected = manifest.files.find(entry => entry.name === name);
    assert(expected, `Missing ${name}`);
    let path = resolve(originalDir, name);
    try { await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; path = resolve(baseDir, expected.file); }
    const result = await indexOriginal(path, expected);
    files[name] = result.file; tables[name] = result; sourcePaths[name] = path;
  }
  const traceBytes = await readFile(tracePath), trace = JSON.parse(traceBytes);
  const sources = [];
  for (const file of ['modules/module1000.cpp', 'modules/module1000.h', 'modules/module1000_sprites.cpp', 'modules/module1000_sprites.h', 'klaymen.cpp', 'klaymen.h']) {
    const path = resolve(root, 'scummvm/engines/neverhood', file);
    await noSymlinks(path);
    sources.push({ file: `engines/neverhood/${file}`, text: await readFile(path, 'utf8') });
  }
  const { deriveRoomGraph } = await import('./derive-room-streaming-graph.mjs');
  const dependencies = deriveDependencies(trace, files, tables, sources);
  const graph = await deriveRoomGraph({ files, tables, manifest });
  const menu = deriveMenuCommon(files, tables, await loadMenuSources(), await readFile(resolve(root, 'web/public/runtime/neverhood.dat')));
  const index = { version: 1, blockSize: BLOCK_SIZE, runtimeSHA256: RUNTIME_SHA256, files,
    ...mergeMenuCommon(mergeRoomGraph(dependencies, graph, files), menu, files) };
  index.evidence.traceSHA256 = sha256(traceBytes);
  const indexBytes = Buffer.from(JSON.stringify(index) + '\n');
  assert(indexBytes.length <= INDEX_LIMIT_BYTES, `Streaming index exceeds16MiB: ${indexBytes.length}`);
  manifest.streaming = { version: 1, index: { file: 'streaming-index.json', bytes: indexBytes.length, sha256: sha256(indexBytes) } };
  const stage = `${output}.preparing-${process.pid}`;
  await mkdir(stage);
  try {
    const { buildStreamedHD } = await import('./prepare-streamed-hd.mjs');
    const streamed = await buildStreamedHD(baseDir, stage);
    assert.deepEqual(Object.keys(streamed).sort(), Object.keys(manifest.packs).sort(), 'HD indexes must cover the existing room descriptors');
    for (const [room, addition] of Object.entries(streamed)) {
      assert(addition?.streaming && Object.keys(addition).length === 1 && !manifest.packs[room].streaming, 'Only add per-pack streaming metadata');
      manifest.packs[room].streaming = addition.streaming;
    }
    await writeFile(resolve(stage, 'streaming-index.json'), indexBytes, { flag: 'wx' });
    await writeFile(resolve(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await writeFile(resolve(stage, 'streaming-local.json'), JSON.stringify({ version: 1, baseDir, sourcePaths }, null, 2) + '\n', { flag: 'wx' });
    await rename(stage, output);
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  return { output, index: manifest.streaming.index, evidence: index.evidence,
    bootstrapBlocks: index.bootstrap.length, commonBlocks: index.common.length,
    streamedHDRooms: Object.keys(manifest.packs).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {}, keys = { '--base-dir': 'baseDir', '--output': 'output', '--trace': 'tracePath', '--original-dir': 'originalDir', '--runtime': 'runtime' };
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(keys[process.argv[i]] && process.argv[i + 1], 'Usage: prepare-streaming-demo.mjs --base-dir DIR --output NEW_PRIVATE_DIR --trace COLD_TRACE');
    options[keys[process.argv[i]]] = resolve(process.argv[i + 1]);
  }
  prepareStreamingDemo(options).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}
