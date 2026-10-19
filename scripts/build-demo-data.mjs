#!/usr/bin/env node
// Offline audit, lossless fallback and experimental repack; no two-room closure claim.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ARCHIVES, parseArchive } from '../tools/assets/catalog.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = n => n.toString(16).padStart(8, '0');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

export function hashFile(file, algorithm = 'sha256', limit = Infinity) {
  const fd = fs.openSync(file, 'r'), hash = createHash(algorithm), buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let offset = 0; offset < limit;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (!count) break;
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function inspectStaticData(data) {
  let offset = 0;
  function skip(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > data.length - offset)
      throw new Error(`Truncated neverhood.dat at ${offset}`);
    offset += bytes;
  }
  function u32() { const at = offset; skip(4); return data.readUInt32LE(at); }
  if (u32() !== 0x11223344 || u32() !== 0) throw new Error('Unsupported neverhood.dat magic/version');
  const sections = {};
  for (const [name, stride] of [['messages', 6], ['rects', 0], ['hitRects', 10], ['navigation', 22]]) {
    const count = u32(), ids = [], values = [];
    if (count > data.length / 8) throw new Error('Invalid static list count');
    for (let i = 0; i < count; i++) {
      ids.push(hex(u32()));
      const items = u32();
      if (stride) {
        const at = offset; skip(items * stride);
        if (name === 'messages') for (let j = 0; j < items; j++)
          values.push(data.readUInt32LE(at + j * 6 + 2));
      } else {
        if (items > data.length / 12) throw new Error('Invalid rect count');
        for (let j = 0; j < items; j++) { skip(8); const subItems = u32(); skip(subItems * 12); }
      }
    }
    sections[name] = { count, ids };
    if (name === 'messages') sections[name].values = [...new Set(values)];
  }
  for (const [name, stride] of [['hallOfRecords', 22], ['tracks', 40]]) {
    const count = u32(); skip(count * stride); sections[name] = { count };
  }
  if (offset !== data.length) throw new Error(`Unexpected neverhood.dat trailing bytes: ${data.length - offset}`);
  return { magic: '11223344', version: 0, sections };
}

export function resolveResources(archives) {
  const winners = new Map();
  for (const archive of archives) for (const entry of archive.entries) {
    const previous = winners.get(entry.hash);
    if (!previous || entry.timestamp > previous.timestamp)
      winners.set(entry.hash, { ...entry, archive: path.basename(archive.file) });
  }
  const aliases = [];
  for (const [hash, entry] of winners) {
    if (entry.compression !== 0x65) continue;
    const seen = new Set(), chain = [];
    let current = entry;
    while (current.compression === 0x65) {
      if (seen.has(current.hash)) throw new Error(`BLB alias cycle: ${hex(hash)}`);
      seen.add(current.hash); chain.push(hex(current.hash));
      current = winners.get(current.diskSize);
      if (!current) throw new Error(`Missing BLB alias target: ${hex(hash)}`);
    }
    chain.push(hex(current.hash));
    aliases.push({ requested: hex(hash), chain, archive: current.archive, index: current.index,
      requestedExtOffset: entry.extOffset });
  }
  return { winners, aliases };
}

export function nonvideoPlan(archives) {
  const { winners } = resolveResources(archives);
  const omitted = [];
  const planned = archives.map(archive => {
    const name = path.basename(archive.file);
    const entries = archive.entries.filter(entry => {
      let resolved = entry;
      const seen = new Set();
      while (resolved.compression === 0x65) {
        if (seen.has(resolved)) throw new Error(`Physical alias cycle: ${name}:${entry.index}`);
        seen.add(resolved); resolved = winners.get(resolved.diskSize);
        if (!resolved) throw new Error(`Physical alias target missing: ${name}:${entry.index}`);
      }
      if (name === 'hd.blb' || (entry.type !== 10 && resolved.type !== 10)) return true;
      omitted.push({ archive: name, ...entry, hash: hex(entry.hash),
        reason: entry.compression === 0x65 ? 'alias-to-video' : 'video', resolvedHash: hex(resolved.hash) });
      return false;
    });
    return { ...archive, entries };
  });
  // A removed newer video must not expose an older nonvideo resource of the same hash.
  const remaining = resolveResources(planned).winners;
  for (const [hash, entry] of remaining) {
    const original = winners.get(hash);
    if (entry.archive !== original.archive || entry.index !== original.index)
      throw new Error(`Removal changes winning timestamp precedence for ${hex(hash)}`);
  }
  for (const archive of planned) for (const entry of archive.entries) {
    let resolved = entry;
    const seen = new Set();
    while (resolved.compression === 0x65) {
      if (seen.has(resolved)) throw new Error(`Retained alias cycle: ${hex(entry.hash)}`);
      seen.add(resolved); resolved = remaining.get(resolved.diskSize);
      if (!resolved) throw new Error(`Retained alias target missing: ${hex(entry.hash)}`);
    }
    if (resolved.type === 10 && path.basename(archive.file) !== 'hd.blb')
      throw new Error(`Retained alias resolves to video: ${hex(entry.hash)}`);
  }
  return { archives: planned, omitted };
}

function payloadHash(file, offset, bytes) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  try {
    for (let done = 0; done < bytes;) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, bytes - done), offset + done);
      if (!n) throw new Error('Truncated BLB payload');
      hash.update(buffer.subarray(0, n)); done += n;
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function repackArchive(archive, retained, target) {
  const count = retained.length, ext = archive.ext;
  const table = Buffer.alloc(16 + count * 24 + ext.length);
  archive.index.copy(table, 0, 0, 8);
  table.writeUInt32LE(count, 12);
  ext.copy(table, 16 + count * 24);
  let offset = table.length;
  retained.forEach((entry, i) => {
    table.writeUInt32LE(entry.hash, 16 + i * 4);
    const at = 16 + count * 4 + i * 20;
    const originalAt = 16 + archive.entries.length * 4 + entry.index * 20;
    archive.index.copy(table, at, originalAt, originalAt + 20);
    table.writeUInt32LE(entry.compression === 0x65 ? 0 : offset, at + 8);
    if (entry.compression !== 0x65) offset += entry.diskSize;
  });
  if (offset > 0xffffffff) throw new Error('Repacked BLB exceeds uint32 size');
  table.writeUInt32LE(offset, 8);
  const source = fs.openSync(archive.file, 'r');
  let dest;
  try {
    dest = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(dest, table);
    const buffer = Buffer.alloc(1024 * 1024);
    for (const entry of retained) {
      if (entry.compression === 0x65) continue;
      for (let done = 0; done < entry.diskSize;) {
        const n = fs.readSync(source, buffer, 0, Math.min(buffer.length, entry.diskSize - done), entry.offset + done);
        if (!n) throw new Error('Truncated source payload during repack');
        for (let written = 0; written < n;) {
          const bytes = fs.writeSync(dest, buffer, written, n - written);
          if (!bytes) throw new Error('Short BLB payload write');
          written += bytes;
        }
        done += n;
      }
    }
  } finally { fs.closeSync(source); if (dest !== undefined) fs.closeSync(dest); }
  const rebuilt = parseArchive(target);
  if (!rebuilt.ext.equals(ext) || rebuilt.entries.length !== count) throw new Error('Repacked BLB table verification failed');
  const preserved = rebuilt.entries.map((entry, index) => {
    const original = retained[index];
    for (const key of ['hash', 'type', 'compression', 'timestamp', 'diskSize', 'size', 'extOffset'])
      if (entry[key] !== original[key]) throw new Error(`Repack changed ${key}: ${index}`);
    const sha256 = entry.compression === 0x65 ? null : payloadHash(target, entry.offset, entry.diskSize);
    if (sha256 !== null && sha256 !== payloadHash(archive.file, original.offset, original.diskSize))
      throw new Error(`Repack changed compressed payload: ${index}`);
    return { sourceIndex: original.index, index, hash: hex(entry.hash), payloadSHA256: sha256 };
  });
  return { name: path.basename(target), file: path.basename(target), bytes: rebuilt.size, sha256: rebuilt.sha256,
    entries: count, preserved, indexSHA256: createHash('sha256').update(rebuilt.index).digest('hex'),
    sourceSHA256: archive.sha256, sourceBytes: archive.size, compressedPayloadsVerified: true, extDataVerified: true };
}

export function audit({ input = path.join(repo, 'extracted/app/DATA'), engineData = path.join(repo, 'web/public/runtime/neverhood.dat') } = {}) {
  const archives = ARCHIVES.map(name => parseArchive(path.join(input, name)));
  const { winners, aliases } = resolveResources(archives);
  const staticData = inspectStaticData(fs.readFileSync(engineData));
  const staticValues = staticData.sections.messages.values;
  delete staticData.sections.messages.values;
  const hd = archives.find(archive => path.basename(archive.file) === 'hd.blb');
  const detectionMD5 = hashFile(hd.file, 'md5', 5000);
  if (hd.size !== 4279716 || detectionMD5 !== '22958d968458c9ff221aee38577bb2b2')
    throw new Error('Only the verified English retail hd.blb detection signature is supported');
  return {
    schemaVersion: 1, private: true, kind: 'two-room-feasibility-audit',
    minimal: false, closureProven: false, boundaryEnforced: false, playableBundle: false,
    requestedScenes: ['Module1000/Scene1001', 'Module1000/Scene1002'],
    auxiliaryScene: 'Module1000 scene 2: window close-up',
    files: [...archives.map(a => ({ name: path.basename(a.file), file: path.basename(a.file), bytes: a.size, sha256: a.sha256,
      entries: a.entries.length, indexBytes: a.index.length,
      payloadBytesByType: Object.fromEntries([...new Set(a.entries.map(e => e.type))].map(type =>
        [type, a.entries.filter(e => e.type === type && e.compression !== 0x65).reduce((sum, e) => sum + e.diskSize, 0)])),
      indexSHA256: createHash('sha256').update(a.index).digest('hex') })),
    { name: 'neverhood.dat', file: 'neverhood.dat', bytes: fs.statSync(engineData).size, sha256: hashFile(engineData) }],
    detection: { game: 'neverhood', variant: 'English retail', file: 'hd.blb', bytes: hd.size,
      md5PrefixBytes: 5000, md5: detectionMD5 },
    resources: { physicalEntries: archives.reduce((sum, a) => sum + a.entries.length, 0),
      winningHashes: winners.size, aliases,
      staticMessageValuesMatchingResourceHashes: [...new Set(staticValues.filter(value => winners.has(value)))].map(hex),
      note: 'Message values are untyped: matching hashes are evidence, not a dependency graph.' },
    staticData,
    blockers: [
      { code: 'NO_TWO_ROOM_BOUNDARY', evidence: 'modules/module1000.cpp:87-120; gamemodule.cpp:634-635',
        detail: 'Retail scene 1 result 1 leaves for Module2300; result 2 enters scene 3 then 4. Scene 0 also enters window scene 2. Removing their payloads is not a safe demo exit.' },
      { code: 'STARTUP_IS_NOT_ROOM_ONE', evidence: 'gamemodule.cpp:356-359,661-662; neverhood.cpp:166-170; console.cpp:85-89',
        detail: 'Normal startup runs Module1500 logos/intro before Module1000. Existing save_slot or debugger scene 1000 0 can restore/jump, but neither enforces a boundary; no save is invented here.' },
      { code: 'RESOURCE_CLOSURE_UNPROVEN', evidence: 'staticdata.cpp:44-224; resourceman.cpp:39-65,100-106,149-152; klaymen.cpp; modules/module1000_sprites.cpp',
        detail: 'Need semantic traversal of message/rect tables, all shared Klaymen state handlers, computed hashes, sounds, cursors and menus for every permitted state. Source literals or a single playthrough are not proof.' }
    ],
    sparseAssessment: {
      formatPossible: true, implemented: false,
      requirements: ['Preserve original BLB logical length, full index/extData and offsets.',
        'Keep hd.blb first 5000 bytes byte-identical for retail detection.',
        'Retain timestamp winners, alias chains and requested-alias extData.',
        'Prove no permitted lookup/stream reads a zeroed payload, including menus/restart/load.',
        'Report logical bytes, allocated bytes and compressed transfer bytes separately.'],
      warning: 'Sparse holes save allocated disk blocks, not logical file/upload bytes. Zeros in requested DCL/video data are corruption, not missing-resource guards.'
    },
    safeAlternative: 'Use a lossless full-reference copy for local testing with a separately verified engine-side boundary, or supply authentic detected demo archives. Neither is a proven minimal two-room bundle.',
    runtimeVerified: false
  };
}

export function externalOutput(output, sourceRepo = repo) {
  const absolute = path.resolve(output);
  let parent = absolute;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const canonical = path.join(fs.realpathSync(parent), path.relative(parent, absolute));
  if (inside(fs.realpathSync(sourceRepo), canonical)) throw new Error('Output must be outside the project/Git');
  if (canonical.split(path.sep).some(part => /^(web|public|dist|\.git)$/i.test(part))) throw new Error('Public output forbidden');
  for (let p = canonical; p !== path.dirname(p); p = path.dirname(p))
    if (fs.existsSync(path.join(p, '.git'))) throw new Error('Output inside a Git worktree is forbidden');
  if (fs.existsSync(canonical)) throw new Error('Output must be a new directory (no overwrite)');
  return canonical;
}

export function build({ input, engineData, output, reference = false, nonvideo = false, sourceRepo = repo } = {}) {
  // Validate the destination before reading large private input archives.
  const destination = output ? externalOutput(output, sourceRepo) : null;
  if (reference && !destination) throw new Error('--reference requires --output outside Git');
  if (reference && nonvideo) throw new Error('--reference and --nonvideo are mutually exclusive');
  if (nonvideo && !destination) throw new Error('--nonvideo requires --output outside Git');
  const report = audit({ input, engineData });
  const sourceArchives = nonvideo ? ARCHIVES.map(name => parseArchive(path.join(input ?? path.join(repo, 'extracted/app/DATA'), name))) : null;
  if (nonvideo && sourceArchives.some(a => report.files.find(f => f.name === path.basename(a.file)).sha256 !== a.sha256))
    throw new Error('Source archives changed during audit');
  const plan = nonvideo ? nonvideoPlan(sourceArchives) : null;
  report.totalBytes = report.files.reduce((sum, file) => sum + file.bytes, 0);
  if (!destination) return report;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(destination, '.private-assets-no-public'),
      'PRIVATE original Neverhood data. Offline only. Never publish or upload.\n', { flag: 'wx', mode: 0o600 });
    if (reference) {
      for (const file of report.files) {
        const source = file.name === 'neverhood.dat' ? (engineData ?? path.join(repo, 'web/public/runtime/neverhood.dat'))
          : path.join(input ?? path.join(repo, 'extracted/app/DATA'), file.name);
        const target = path.join(destination, file.name);
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
        if (fs.statSync(target).size !== file.bytes || hashFile(target) !== file.sha256)
          throw new Error(`Copy verification failed: ${file.name}`);
      }
      report.kind = 'full-reference-data';
      report.resourceComplete = true;
      report.copyVerified = true;
      report.note = 'Complete retail data, NOT a two-room demo. No runtime, launcher, boundary or save included.';
    }
    if (nonvideo) {
      report.sourceFiles = report.files;
      report.sourceTotalBytes = report.totalBytes;
      report.files = sourceArchives.map((archive, index) => {
        const name = path.basename(archive.file), target = path.join(destination, name);
        if (name !== 'hd.blb') return repackArchive(archive, plan.archives[index].entries, target);
        fs.copyFileSync(archive.file, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
        if (hashFile(target) !== archive.sha256) throw new Error('hd.blb byte-identical copy failed');
        return { ...report.sourceFiles.find(file => file.name === name), byteIdentical: true };
      });
      const dataFile = report.sourceFiles.find(file => file.name === 'neverhood.dat');
      const dataTarget = path.join(destination, dataFile.name);
      fs.copyFileSync(engineData ?? path.join(repo, 'web/public/runtime/neverhood.dat'), dataTarget, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dataTarget, 0o600);
      if (hashFile(dataTarget) !== dataFile.sha256) throw new Error('neverhood.dat copy failed');
      report.files.push(dataFile);
      // Re-parse the actual output and reject missing aliases or any altered winning source entry.
      const rebuilt = ARCHIVES.map(name => parseArchive(path.join(destination, name)));
      const winners = resolveResources(rebuilt).winners;
      const expected = resolveResources(plan.archives).winners;
      if (winners.size !== expected.size) throw new Error('Repack changed winner count');
      for (const [hash, entry] of winners) {
        const original = expected.get(hash), file = report.files.find(file => file.name === entry.archive);
        const sourceIndex = file.byteIdentical ? entry.index : file.preserved[entry.index].sourceIndex;
        if (!original || entry.archive !== original.archive || sourceIndex !== original.index)
          throw new Error(`Repack changed winner: ${hex(hash)}`);
      }
      report.kind = 'experimental-nonvideo-data'; report.experimental = true;
      report.requiresRuntime = 'two-room-demo';
      report.stockRuntimeBlockers = report.blockers;
      report.blockers = report.blockers.filter(blocker => blocker.code === 'RESOURCE_CLOSURE_UNPROVEN');
      report.omittedVideos = plan.omitted;
      report.retainedDetectionVideos = sourceArchives.find(a => path.basename(a.file) === 'hd.blb').entries
        .filter(entry => entry.type === 10).map(entry => ({ ...entry, hash: hex(entry.hash) }));
      report.totalBytes = report.files.reduce((sum, file) => sum + file.bytes, 0);
      report.savedBytes = report.sourceTotalBytes - report.totalBytes;
      report.repackVerified = true;
      report.resources = { source: report.resources, retainedWinningHashes: winners.size,
        retainedAliases: resolveResources(rebuilt).aliases };
      report.note = 'Experimental nonvideo superset, NOT minimal. Requires a separately verified two-room runtime with scene/module guards and no intro/save/load/menu. No runtime validation or closure proof is claimed.';
    }
    report.bundledFiles = reference || nonvideo ? report.files.map(file => file.name) : [];
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--reference') options.reference = true;
      else if (arg === '--nonvideo') options.nonvideo = true;
      else if (['--input', '--engine-data', '--output'].includes(arg)) {
        const value = process.argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        options[arg === '--engine-data' ? 'engineData' : arg.slice(2)] = value;
      } else if (arg === '--help') {
        console.log('Offline two-room feasibility audit (exit 2: minimal bundle blocked).\nnode scripts/build-demo-data.mjs [--input DATA_DIR] [--engine-data FILE] [--output NEW_EXTERNAL_DIR]\nExplicit lossless full-data fallback (NOT minimal): add --reference --output NEW_EXTERNAL_DIR\nExperimental nonvideo superset: add --nonvideo --output NEW_EXTERNAL_DIR (requires two-room-demo runtime).\nNo network, upstream edits, public output, overwrites or fabricated sparse closure.');
        process.exit(0);
      } else throw new Error(`Unknown argument ${arg}`);
    }
    const report = build(options);
    console.log(JSON.stringify(report, null, 2));
    if (!options.reference && !options.nonvideo) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
