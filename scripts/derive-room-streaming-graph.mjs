import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FILES } from '../web/lib/validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK_SIZE = 65536;
const hex = value => value.toString(16).padStart(8, '0');
const digest = value => createHash('sha256').update(value).digest('hex');
const unique = values => [...new Set(values)].sort();
const literals = text => [...text.matchAll(/\b0x([\da-f]{8})\b/gi)].map(match => parseInt(match[1], 16));

// Keep offsets/line numbers stable while excluding comments and string contents.
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    token => token.replace(/[^\n]/g, ' '));
}

function closingBrace(text, start) {
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    if (text[at] === '{') depth++;
    if (text[at] === '}' && --depth === 0) return at;
  }
  throw new Error('Unbalanced native source braces');
}

function members(source) {
  const result = [];
  const pattern = /^[ \t]*(?:[\w:*&<>]+[ \t]+)*(\w+)::(~?\w+)\([^;{}]*?\)\s*(?::[^{}]*?)?\{/gm;
  for (const match of source.code.matchAll(pattern)) {
    const start = match.index + match[0].lastIndexOf('{');
    const end = closingBrace(source.code, start);
    result.push({ owner: match[1], name: match[2], text: source.code.slice(match.index, end + 1),
      start, declarationStart: match.index, end, file: source.file, line: source.code.slice(0, match.index).split('\n').length });
  }
  return result;
}

function sceneCases(member, selector = '(?:_sceneNum|_vm->gameState\\(\\)\\.sceneNum)') {
  if (!member) return [];
  const match = new RegExp(`switch\\s*\\(\\s*${selector}\\s*\\)\\s*\\{`).exec(member.text);
  if (!match) return [];
  const start = match.index + match[0].length - 1;
  const end = closingBrace(member.text, start);
  const labels = [];
  let depth = 1;
  for (let at = start + 1; at < end; at++) {
    if (member.text[at] === '{') depth++;
    else if (member.text[at] === '}') depth--;
    if (depth !== 1) continue;
    const label = /^(?:case\s+(\d+)\s*:|default\s*:)/.exec(member.text.slice(at));
    if (label) { labels.push({ at, end: at + label[0].length, scene: label[1] }); at += label[0].length - 1; }
  }
  return labels.filter(label => label.scene !== undefined).map(label => {
    let next = labels.find(item => item.at > label.at);
    // Consecutive case labels share the same native arm.
    while (next?.scene !== undefined && !member.text.slice(label.end, next.at).trim()) {
      next = labels.find(item => item.at > next.at);
    }
    return { scene: Number(label.scene), text: member.text.slice(label.end, next?.at ?? end),
      file: member.file, line: member.line + member.text.slice(0, label.at).split('\n').length - 1 };
  });
}

function callArguments(text, name) {
  const result = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    let start = match.index + match[0].length;
    let depth = 0, at = start;
    const args = [];
    for (; at < text.length; at++) {
      if (text[at] === '(') depth++;
      else if (text[at] === ')') { if (!depth) break; depth--; }
      else if (text[at] === ',' && !depth) { args.push(text.slice(start, at).trim()); start = at + 1; }
    }
    args.push(text.slice(start, at).trim()); result.push(args);
  }
  return result;
}
const firstArguments = (text, name) => callArguments(text, name).map(args => args[0]);

// Resolve only the flat which-selector constructor idiom; other entry logic stays unresolved.
function constructorEntry(member, which) {
  if (!member || which < 0) return null;
  const chain = /if\s*\(\s*which\s*<\s*0\s*\)\s*createScene\([^;]+;\s*((?:else if\s*\(\s*which\s*==\s*\d+\s*\)\s*createScene\(\s*\d+\s*,\s*-?\d+\s*\);\s*)*)(?:else\s*createScene\(\s*(\d+)\s*,\s*(-?\d+)\s*\);)?/.exec(member.text);
  if (!chain) return null;
  for (const branch of chain[1].matchAll(/which\s*==\s*(\d+)\s*\)\s*createScene\(\s*(\d+)\s*,\s*(-?\d+)\s*\)/g)) {
    if (Number(branch[1]) === which) return { scene: Number(branch[2]), which: Number(branch[3]) };
  }
  return chain[2] === undefined ? null : { scene: Number(chain[2]), which: Number(chain[3]) };
}

function crossModuleEntries(native) {
  const update = native.functions.find(member => member.owner === 'GameModule' && member.name === 'updateModule');
  const routing = sceneCases(update, '_moduleNum');
  const result = new Map();
  for (const scene of native.scenes) {
    const exits = unique([...(scene.update?.text ?? '').matchAll(/\bleaveModule\s*\(\s*(\d+)\s*\)/g)].map(match => Number(match[1])));
    const arm = routing.find(item => item.scene === scene.module);
    if (!exits.length || !arm) continue;
    const calls = callArguments(arm.text, 'createModule').filter(args => /^\d+$/.test(args[0]) && /^-?\d+$/.test(args[1]));
    const entries = [];
    for (const exit of exits) for (const [moduleArg, whichArg] of calls) {
      const module = Number(moduleArg), which = Number(whichArg);
      const unconditional = calls.length === 1 && !/\b_moduleResult\b/.test(arm.text);
      const conditional = [...arm.text.matchAll(/if\s*\(\s*_moduleResult\s*==\s*(\d+)\s*\)\s*(?:\{\s*)?createModule\(\s*(\d+)\s*,\s*(-?\d+)\s*\)/g)]
        .some(match => Number(match[1]) === exit && Number(match[2]) === module && Number(match[3]) === which);
      if (!unconditional && !conditional) continue;
      const constructor = native.functions.find(member => member.owner === `Module${module}` && member.name === `Module${module}`);
      const entry = constructorEntry(constructor, which);
      if (!entry || !native.scenes.some(item => item.id === `${module}:${entry.scene}`)) continue;
      entries.push({ room: `${module}:${entry.scene}`, which: entry.which, moduleResult: exit, moduleEntry: which,
        evidence: { routing: { file: arm.file, line: arm.line }, constructor: { file: constructor.file, line: constructor.line } } });
    }
    result.set(scene.id, entries);
  }
  return result;
}

/** Decode StaticData::load, not a scan for plausible hashes inside neverhood.dat. */
export function decodeEngineData(input) {
  const bytes = Buffer.from(input);
  let at = 0;
  const take = count => { assert(at + count <= bytes.length, 'Truncated neverhood.dat'); const offset = at; at += count; return offset; };
  const u32 = () => bytes.readUInt32LE(take(4));
  const count = () => { const value = u32(); assert(value <= bytes.length / 4, 'Invalid static-data count'); return value; };
  assert.equal(u32(), 0x11223344, 'Unsupported neverhood.dat magic');
  assert.equal(u32(), 0, 'Unsupported neverhood.dat version');
  const references = new Map(), navigationLists = new Map(), backgrounds = new Map();
  const sections = {};
  const lists = (section, read) => {
    sections[section] = { offset: at, count: count() };
    for (let i = 0; i < sections[section].count; i++) {
      const offset = at, id = u32();
      read(id, offset);
    }
  };
  lists('messageLists', id => {
    const refs = [];
    for (let n = count(); n; n--) { take(2); refs.push(u32()); }
    references.set(id, refs);
  });
  lists('rectLists', id => {
    const refs = [];
    for (let n = count(); n; n--) {
      take(8);
      for (let sub = count(); sub; sub--) { take(8); refs.push(u32()); }
    }
    references.set(id, refs);
  });
  lists('hitRectLists', () => take(count() * 10));
  lists('navigationLists', (id, offset) => {
    const items = [];
    for (let n = count(); n; n--) {
      const itemOffset = at;
      const fileHash = u32(), leftSmackerFileHash = u32(), rightSmackerFileHash = u32(), middleSmackerFileHash = u32();
      const interactive = bytes[take(1)], middleFlag = bytes[take(1)], mouseCursorFileHash = u32();
      items.push({ offset: itemOffset, fileHash, leftSmackerFileHash, rightSmackerFileHash, middleSmackerFileHash,
        interactive, middleFlag, mouseCursorFileHash });
    }
    navigationLists.set(id, { id: hex(id), offset, bytes: at - offset, items });
  });
  lists('hallOfRecordsInfo', id => {
    const refs = [u32(), u32(), u32(), u32()]; take(2); references.set(id, refs);
    backgrounds.set(id, [refs[0], refs[1], refs[3]].filter(Boolean));
  });
  lists('trackInfo', id => {
    const refs = Array.from({ length: 8 }, u32); take(4); references.set(id, refs); backgrounds.set(id, [refs[0]]);
  });
  assert.equal(at, bytes.length, 'Unexpected neverhood.dat trailing bytes');
  return { references, navigationLists, backgrounds, sections, sha256: digest(bytes), bytes: bytes.length };
}

/** Deliberately limited to the engine's module switch/member idioms. */
export function parseNativeScenes(inputs) {
  const sources = inputs.map(source => ({ ...source, code: codeOnly(source.text) }));
  const functions = sources.flatMap(members);
  const classes = new Map();
  for (const member of functions) {
    if (!classes.has(member.owner)) classes.set(member.owner, []);
    classes.get(member.owner).push(member);
  }
  const pointerOwners = new Map(), arrays = [];
  for (const source of sources) {
    for (const match of source.code.matchAll(/\b(\w+)\s*\*\s*(\w+)\s*(?=[;=(])/g)) {
      if (!pointerOwners.has(match[2])) pointerOwners.set(match[2], new Set());
      pointerOwners.get(match[2]).add(match[1]);
    }
    for (const match of source.code.matchAll(/\b(?:static\s+)?const\s+\w+\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{/g)) {
      const start = match.index + match[0].lastIndexOf('{');
      const end = closingBrace(source.code, start);
      arrays.push({ name: match[1], text: source.code.slice(match.index, end + 1), file: source.file,
        line: source.code.slice(0, match.index).split('\n').length });
    }
  }
  const scenes = [];
  for (const member of functions.filter(item => /^Module\d+$/.test(item.owner) && item.name === 'createScene')) {
    const module = Number(member.owner.slice(6));
    const updates = sceneCases(functions.find(item => item.owner === member.owner && item.name === 'updateScene'));
    for (const arm of sceneCases(member)) {
      const update = updates.find(item => item.scene === arm.scene);
      const transitions = [...(update?.text ?? '').matchAll(/\bcreateScene\s*\(\s*(\d+)\s*,/g)].map(match => `${module}:${Number(match[1])}`);
      // This macro has a fixed third exit as well as its two literal arguments.
      for (const match of (update?.text ?? '').matchAll(/\bHallOfRecordsSceneLink\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
        transitions.push(`${module}:${match[1]}`, `${module}:${match[2]}`, `${module}:7`);
      }
      for (const match of (update?.text ?? '').matchAll(/\bSceneLinkIf\s*\(\s*\d+\s*,\s*(\d+)\s*,/g)) transitions.push(`${module}:${match[1]}`);
      const sceneClasses = unique([...arm.text.matchAll(/\bnew\s+(\w*Scene\w*)\b|\bcreate(Scene\d+|HallOfRecordsScene)\s*\(/g)].map(match => match[1] ?? match[2]));
      const backgrounds = unique([...firstArguments(arm.text, 'createStaticScene'), ...firstArguments(arm.text, 'statueCloseup')]
        .flatMap(literals).map(hash => hex(hash).toUpperCase()));
      const navigationListIds = unique(firstArguments(arm.text, 'createNavigationScene').flatMap(literals).map(hex));
      const unresolvedEdges = [];
      if (/\bleaveModule\s*\(/.test(update?.text ?? '')) unresolvedEdges.push('cross-module-exit-requires-GameModule-result-routing');
      if (/\bcreateScene\s*\(\s*(?!\d+\s*,)/.test(update?.text ?? '')) unresolvedEdges.push('dynamic-scene-destination');
      if (!update) unresolvedEdges.push('no-updateScene-case');
      scenes.push({ id: `${module}:${arm.scene}`, module, scene: arm.scene, sceneClasses, backgrounds, navigationListIds,
        neighbors: unique(transitions), unresolvedEdges, arm, update });
    }
  }
  return { sources, functions, classes, scenes, pointerOwners, arrays };
}

export function deriveRoomGraphFromSources({ files, tables, manifest, engineData, sources }) {
  const native = parseNativeScenes(sources), data = decodeEngineData(engineData);
  const crossEntries = crossModuleEntries(native), incoming = new Map();
  const navigationEntryHashes = (scene, indices) => {
    const hashes = new Set();
    for (const args of callArguments(scene.arm.text, 'createNavigationScene')) {
      const selected = /^\d+$/.test(args[1]) ? [Number(args[1])] : args[1] === 'which' ? indices : [];
      for (const id of literals(args[0])) for (const index of selected) {
        const hash = data.navigationLists.get(id)?.items[index]?.fileHash;
        if (hash) hashes.add(hex(hash));
      }
    }
    return [...hashes].sort();
  };
  const addIncoming = (id, which) => { if (!incoming.has(id)) incoming.set(id, new Set()); incoming.get(id).add(which); };
  for (const scene of native.scenes) {
    for (const match of (scene.update?.text ?? '').matchAll(/\bcreateScene\s*\(\s*(\d+)\s*,\s*(-?\d+)\s*\)/g)) addIncoming(`${scene.module}:${Number(match[1])}`, Number(match[2]));
    for (const entry of crossEntries.get(scene.id) ?? []) addIncoming(entry.room, entry.which);
  }
  for (const member of native.functions.filter(item => /^Module\d+$/.test(item.owner) && item.name === item.owner)) {
    for (const match of member.text.matchAll(/\bcreateScene\s*\(\s*(\d+)\s*,\s*(-?\d+)\s*\)/g)) addIncoming(`${member.owner.slice(6)}:${Number(match[1])}`, Number(match[2]));
  }
  const winners = new Map();
  for (const name of REQUIRED_FILES) for (const raw of tables[name]?.entries ?? []) {
    const entry = { ...raw, name };
    if (!winners.has(entry.hash) || entry.timestamp > winners.get(entry.hash).timestamp) winners.set(entry.hash, entry);
  }
  const physical = hash => {
    let entry = winners.get(hash);
    const seen = new Set();
    while (entry?.compression === 0x65) {
      assert(!seen.has(entry.hash), `BLB alias cycle at ${hex(hash)}`); seen.add(entry.hash);
      entry = winners.get(entry.diskSize);
    }
    return entry;
  };
  const span = entry => {
    assert(files[entry.name] && Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Number.isSafeInteger(entry.diskSize)
      && entry.diskSize > 0 && entry.offset + entry.diskSize <= files[entry.name].bytes, 'Invalid physical resource span');
    const result = [];
    for (let index = Math.floor(entry.offset / BLOCK_SIZE); index <= Math.floor((entry.offset + entry.diskSize - 1) / BLOCK_SIZE); index++) {
      assert(/^[\da-f]{64}$/.test(files[entry.name].hashes?.[index] ?? ''), 'Missing verified physical block hash');
      result.push({ name: entry.name, index });
    }
    return result;
  };
  const refs = blocks => [...new Map(blocks.map(ref => [`${ref.name}/${ref.index}`, ref])).values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);
  const videos = {}, rooms = {};
  const sourceEvidence = native.sources.map(source => ({ file: source.file, sha256: digest(source.text) }));
  for (const scene of native.scenes) {
    const moduleName = `Module${scene.module}`;
    const moduleFile = native.sources.find(source => source.file.endsWith(`/module${scene.module}.cpp`) || source.file === `module${scene.module}.cpp`);
    const moduleMembers = native.functions.filter(member => member.owner === moduleName && member.name !== 'createScene');
    // Module-level arrays and module helpers are state-unioned, not every other Scene's methods.
    let globals = moduleFile?.code ?? '';
    if (moduleFile) for (const member of native.functions.filter(member => member.file === moduleFile.file).sort((a, b) => b.start - a.start)) {
      globals = globals.slice(0, member.declarationStart) + ' '.repeat(member.end - member.declarationStart + 1) + globals.slice(member.end + 1);
    }
    const selectedClasses = new Set(scene.sceneClasses), queue = [...scene.sceneClasses];
    const texts = [scene.arm.text, globals, ...moduleMembers.map(member => member.text)];
    const classEvidence = [];
    const dependencyTexts = [{ text: scene.arm.text, file: scene.arm.file },
      { text: globals, file: moduleFile?.file }, ...moduleMembers];
    while (queue.length) {
      const owner = queue.shift();
      for (const member of native.classes.get(owner) ?? []) {
        texts.push(member.text);
        dependencyTexts.push(member);
        classEvidence.push({ file: member.file, line: member.line, member: `${owner}::${member.name}` });
        for (const token of member.text.matchAll(/\b(?:As\w+|Km\w+|Ss\w+|Scene\d+|Klaymen)\b/g)) {
          if (native.classes.has(token[0]) && !selectedClasses.has(token[0])) { selectedClasses.add(token[0]); queue.push(token[0]); }
        }
      }
      // KmScene classes inherit animations from Klaymen even without naming it in a method body.
      if (owner.startsWith('Km') && native.classes.has('Klaymen') && !selectedClasses.has('Klaymen')) {
        selectedClasses.add('Klaymen'); queue.push('Klaymen');
      }
    }
    // Follow typed shared helpers and their source-local tables, not every member of their owner.
    const helperSeen = new Set(dependencyTexts), arraySeen = new Set(), sharedHelpers = [], resourceArrays = [];
    for (let at = 0; at < dependencyTexts.length; at++) {
      const dependency = dependencyTexts[at];
      for (const match of dependency.text.matchAll(/\b(\w+)(?:\s*\([^()]*\))?\s*->\s*(\w+)\s*\(/g)) {
        const owners = native.pointerOwners.get(match[1]);
        if (owners?.size !== 1) continue;
        const owner = [...owners][0];
        for (const helper of native.classes.get(owner) ?? []) {
          if (helper.name !== match[2] || helperSeen.has(helper)) continue;
          helperSeen.add(helper); dependencyTexts.push(helper); texts.push(helper.text);
          sharedHelpers.push({ file: helper.file, line: helper.line, member: `${owner}::${helper.name}` });
        }
      }
      for (const array of native.arrays) {
        if (array.file !== dependency.file || arraySeen.has(array) || !new RegExp(`\\b${array.name}\\b`).test(dependency.text)) continue;
        arraySeen.add(array); dependencyTexts.push(array); texts.push(array.text);
        resourceArrays.push({ file: array.file, line: array.line, name: array.name });
      }
    }
    const hashes = new Set(texts.flatMap(literals)), staticSeen = new Set();
    const expandStatic = hash => {
      if (staticSeen.has(hash)) return;
      staticSeen.add(hash);
      for (const ref of data.references.get(hash) ?? []) { hashes.add(ref); expandStatic(ref); }
    };
    for (const hash of [...hashes]) expandStatic(hash);
    const navigationLists = scene.navigationListIds.map(id => {
      const list = data.navigationLists.get(parseInt(id, 16));
      assert(list, `Native navigation list ${id} absent from neverhood.dat`);
      return list;
    });
    const movieEvidence = new Map();
    for (const list of navigationLists) for (const [index, item] of list.items.entries()) {
      hashes.add(item.mouseCursorFileHash || 0x63a40028);
      for (const field of ['fileHash', 'leftSmackerFileHash', 'rightSmackerFileHash', 'middleSmackerFileHash']) {
        if (!item[field]) continue;
        const hash = hex(item[field]);
        if (!movieEvidence.has(hash)) movieEvidence.set(hash, []);
        movieEvidence.get(hash).push({ list: list.id, item: index, offset: item.offset, field });
      }
    }
    const unresolvedMovies = [];
    for (const argument of firstArguments(scene.arm.text, 'createSmackerScene')) {
      let movieHashes = literals(argument);
      if (/^\w+$/.test(argument)) {
        const array = new RegExp(`\\b${argument}\\s*\\[\\s*\\]\\s*=\\s*\\{([^}]+)\\}`).exec(moduleFile?.code ?? '');
        if (array) movieHashes = literals(array[1]);
      }
      if (!movieHashes.length) unresolvedMovies.push(argument);
      for (const hash of movieHashes) movieEvidence.set(hex(hash), [{ file: scene.arm.file, line: scene.arm.line, call: 'createSmackerScene' }]);
    }
    const resources = [], missingVideoHashes = [];
    for (const hash of [...hashes].sort((a, b) => a - b)) {
      const entry = physical(hash);
      if (!entry || entry.type === 10 || !entry.diskSize) continue;
      resources.push({ hash: hex(hash), resolvedHash: hex(entry.hash), name: entry.name, offset: entry.offset, bytes: entry.diskSize });
    }
    for (const [hash, evidence] of movieEvidence) {
      const entry = physical(parseInt(hash, 16));
      if (!entry || entry.type !== 10 || !entry.diskSize) { missingVideoHashes.push(hash); continue; }
      const video = videos[hash] ??= { name: entry.name, offset: entry.offset, bytes: entry.diskSize, resolvedHash: hex(entry.hash),
        blocks: span(entry), identities: [], navigation: false, startup: false, evidence: [],
        qualification: 'complete-winning-physical-Smacker-span; association-from-native-call-or-navigation-list', closureProven: false };
      video.identities.push(scene.id); video.navigation ||= navigationLists.length > 0;
      video.evidence.push(...evidence.map(item => ({ ...item, room: scene.id })));
    }
    const backgroundHashes = new Set(scene.backgrounds);
    for (const text of [scene.arm.text, ...scene.sceneClasses.flatMap(owner => (native.classes.get(owner) ?? []).map(member => member.text))]) {
      for (const argument of firstArguments(text, 'setBackground')) {
        for (const hash of literals(argument)) backgroundHashes.add(hex(hash).toUpperCase());
        if (/^\w+$/.test(argument)) for (const assignment of text.matchAll(new RegExp(`\\b${argument}\\s*=\\s*0x([\\da-f]{8})\\b`, 'gi'))) {
          backgroundHashes.add(assignment[1].toUpperCase());
        }
      }
      for (const hash of literals(text)) for (const background of data.backgrounds.get(hash) ?? []) backgroundHashes.add(hex(background).toUpperCase());
    }
    const hdRooms = Object.keys(manifest.packs ?? {}).filter(id => {
      if (scene.sceneClasses.includes(id)) return true;
      for (const owner of [...scene.sceneClasses, moduleName]) {
        if (!id.startsWith(`${owner}-`)) continue;
        const background = id.slice(owner.length + 1).split('-')[0];
        if (backgroundHashes.has(background)) return true;
      }
      return false;
    }).sort();
    const entryVideoHashesByWhich = {};
    for (let index = 0; index < Math.max(0, ...navigationLists.map(list => list.items.length)); index++) {
      entryVideoHashesByWhich[index] = navigationEntryHashes(scene, [index]);
    }
    const entryVideoHashes = navigationLists.length ? navigationEntryHashes(scene, [...incoming.get(scene.id) ?? []]) : [...movieEvidence.keys()].sort();
    const unresolved = ['dynamic-and-named-resource-references-not-proven', 'base-classes-and-native-resource-transitivity-not-proven',
      'physical-stdio-read-ahead-not-proven', ...scene.unresolvedEdges];
    if (!scene.sceneClasses.length && !scene.backgrounds.length && !navigationLists.length && !movieEvidence.size) unresolved.push('unrecognized-native-scene-factory');
    if (missingVideoHashes.length) unresolved.push('missing-navigation-or-cutscene-resource');
    if (unresolvedMovies.length) unresolved.push('dynamic-Smacker-hash');
    const blocks = refs(resources.flatMap(resource => span({ ...resource, diskSize: resource.bytes })));
    rooms[scene.id] = { blocks,
      originalBytes: blocks.reduce((sum, block) => sum + Math.min(BLOCK_SIZE, files[block.name].bytes - block.index * BLOCK_SIZE), 0),
      hdRoom: hdRooms.length === 1 ? hdRooms[0] : null, hdRooms,
      neighbors: unique([...scene.neighbors, ...(crossEntries.get(scene.id) ?? []).map(entry => entry.room)]),
      neighborEntries: crossEntries.get(scene.id) ?? [], entryVideoHashes, entryVideoHashesByWhich,
      entryVideoQualification: navigationLists.length ? 'known-inbound-which-union; prefer-transition-specific-neighborEntries; negative-saved-index-unresolved' : 'literal-cutscene-state-union',
      videoHashes: [...movieEvidence.keys()].filter(hash => videos[hash]).sort(), resources,
      sceneClasses: scene.sceneClasses, staticBackgrounds: scene.backgrounds, backgroundHashes: [...backgroundHashes].sort(), navigationListIds: scene.navigationListIds,
      navigationLists, missingVideoHashes, unresolvedMovies, unresolved: unique(unresolved), unresolvedEdges: scene.unresolvedEdges,
      qualification: 'native-case-and-referenced-class-literal-state-union-plus-module-shared-helpers; not-complete-closure', closureProven: false,
      evidence: { createScene: { file: scene.arm.file, line: scene.arm.line },
        updateScene: scene.update ? { file: scene.update.file, line: scene.update.line } : null, members: classEvidence,
        sharedHelpers, resourceArrays,
        moduleShared: moduleMembers.map(member => ({ file: member.file, line: member.line, member: `${moduleName}::${member.name}` })),
        hdMapping: 'existing-manifest-ID equals native class or native-class/background-hash state; not a new visual/palette binding' } };
  }
  for (const room of Object.values(rooms)) for (const entry of room.neighborEntries) {
    const target = native.scenes.find(scene => scene.id === entry.room);
    entry.entryVideoHashes = target.navigationListIds.length ? navigationEntryHashes(target, [entry.which]) : rooms[entry.room].entryVideoHashes;
  }
  for (const video of Object.values(videos)) video.identities = unique(video.identities);
  const mappedHD = new Set(Object.values(rooms).flatMap(room => room.hdRooms));
  return { rooms, videos, evidence: { qualification: 'all-native-createScene-cases-indexed; partial-static-resource-and-edge-closure', closureProven: false,
    roomCount: Object.keys(rooms).length, moduleCount: new Set(native.scenes.map(scene => scene.module)).size,
    navigationRoomCount: Object.values(rooms).filter(room => room.navigationListIds.length).length,
    navigationListCount: data.navigationLists.size, referencedNavigationListCount: new Set(native.scenes.flatMap(scene => scene.navigationListIds)).size,
    videoCount: Object.keys(videos).length, hdRoomCount: mappedHD.size,
    largestOriginalRoomBytes: Math.max(0, ...Object.values(rooms).map(room => room.originalBytes)),
    unmappedHDRooms: Object.keys(manifest.packs ?? {}).filter(id => !mappedHD.has(id)).sort(),
    missingVideoHashes: unique(Object.values(rooms).flatMap(room => room.missingVideoHashes)),
    unresolvedEdgeRoomCount: Object.values(rooms).filter(room => room.unresolvedEdges.length).length,
    resolvedCrossModuleEntryCount: [...crossEntries.values()].reduce((sum, entries) => sum + entries.length, 0),
    sources: sourceEvidence, engineData: { sha256: data.sha256, bytes: data.bytes, sections: data.sections,
      decoder: 'engines/neverhood/staticdata.cpp:44-224', navigationSemantics: 'engines/neverhood/navigationscene.cpp:32-215',
      qualification: 'navigation records contain movie hashes and cursor/flags, NOT destination scene IDs; neighbors are source updateScene candidate exits' },
    physicalResolution: 'required-archive-order; strictly-newer-timestamp-wins; compression-0x65-alias-chain; verified-64KiB-spans',
    prefetchPolicy: 'room-blocks-and-explicit-videoHashes-only; never-all-archives-or-all-videos; require-preentry-barrier-for-unproven-closure' } };
}

export async function deriveRoomGraph({ files, tables, manifest, engineData, sourceRoot = resolve(root, 'scummvm/engines/neverhood') }) {
  const sources = [];
  for (const directory of ['', 'modules']) {
    for (const file of (await readdir(resolve(sourceRoot, directory))).sort()) {
      if (!/\.(cpp|h)$/.test(file)) continue;
      const path = directory ? `${directory}/${file}` : file;
      sources.push({ file: `engines/neverhood/${path}`, text: await readFile(resolve(sourceRoot, path), 'utf8') });
    }
  }
  const bytes = typeof engineData === 'string' ? await readFile(engineData)
    : engineData ?? await readFile(resolve(root, 'web/public/runtime/neverhood.dat'));
  return deriveRoomGraphFromSources({ files, tables, manifest, engineData: bytes, sources });
}
