import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { inspectStaticData } from '../../../scripts/build-demo-data.mjs';
import { bitmap, png } from '../../assets/formats.mjs';
import { explode } from '../../assets/dcl.mjs';
import { parseArchive, privateRoot } from '../../assets/catalog.mjs';
import { freezeJson, rgbIdentity } from './bulk-sources.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = n => `0x${Number(n).toString(16).padStart(8, '0').toUpperCase()}`;
const priorPath = 'private-assets/upscaling/opaque-all-source-selection.json';
const output = 'private-assets/upscaling/opaque-repair-source-selection.json';
const directory = 'private-assets/upscaling/opaque-repair-sources';
const modulePath = n => `scummvm/engines/neverhood/modules/module${n}.cpp`;

export function nameHash(value) {
  let hash = 0, shift = 0;
  for (let ch of value.toUpperCase()) {
    if (!/[A-Z0-9]/.test(ch)) continue;
    let code = ch.charCodeAt(0);
    if (code <= 57) code += 22;
    shift = (shift + code - 64) % 32;
    hash ^= 1 << shift;
  }
  return hash >>> 0;
}

// Reuse the full-file validator; these two fixed tables are its validated tail.
export function staticTables(bytes) {
  const inventory = inspectStaticData(bytes);
  const nc = inventory.sections.tracks.count, nh = inventory.sections.hallOfRecords.count;
  const trackCountAt = bytes.length - nc * 40 - 4;
  const hallCountAt = trackCountAt - nh * 22 - 4;
  assert.equal(bytes.readUInt32LE(trackCountAt), nc);
  assert.equal(bytes.readUInt32LE(hallCountAt), nh);
  const records = (count, at, stride, names) => Array.from({ length: count }, (_, i) => {
    const offset = at + 4 + i * stride;
    return { offset, bytes: stride, sha256: sha(bytes.subarray(offset, offset + stride)),
      ...Object.fromEntries(names.map((name, j) => [name, bytes.readUInt32LE(offset + j * 4)])) };
  });
  return { inventory, halls: records(nh, hallCountAt, 22, ['id', 'bgFilename1', 'bgFilename2', 'txFilename', 'bgFilename3']),
    tracks: records(nc, trackCountAt, 40, ['id', 'bgFilename', 'bgShadowFilename', 'dataResourceFilename', 'trackPointsName', 'rectListName', 'exPaletteFilename2', 'exPaletteFilename1', 'mouseCursorFilename']) };
}

export function bindPalette(embedded, operations, resolve) {
  assert.equal(embedded.length, 1024);
  const result = Buffer.from(embedded);
  for (const operation of operations) {
    const [hash, to, count, from] = operation;
    assert([to, count, from].every(Number.isInteger));
    assert(to >= 0 && from >= 0 && count > 0 && to + count <= 256 && from + count <= 256);
    const bytes = resolve(hash);
    assert.equal(bytes.length, 1024);
    bytes.copy(result, to * 4, from * 4, (from + count) * 4);
  }
  return result;
}

function main(mode) {
  assert(['--inspect', '--freeze'].includes(mode), 'Use --inspect or --freeze; offline source preparation only');
  const privateDir = privateRoot(path.join(root, 'private-assets'), root);
  assert(fs.existsSync(path.join(root, 'private-assets/upscaling')));
  fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
  const priorBytes = fs.readFileSync(path.join(root, priorPath)), prior = JSON.parse(priorBytes);
  const manifestBytes = fs.readFileSync(path.join(privateDir, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const db = new DatabaseSync(path.join(privateDir, 'catalog.sqlite'), { readOnly: true });
  try {
    assert.equal(manifest.variant, 'english');
    assert.equal(db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get().value, manifest.sourceBinding);
    const evidence = (file, first = 1, last) => {
      const bytes = fs.readFileSync(path.join(root, file));
      return { path: file, sha256: sha(bytes), lines: [first, last ?? bytes.toString().split('\n').length],
        excerpt: bytes.toString().split('\n').slice(first - 1, last).join('\n') };
    };
    const code = new Map([1400, 1600, 2200, 2400, 2500, 2700, 2800].map(n => [n, evidence(modulePath(n))]));
    const datPath = 'web/public/runtime/neverhood.dat', datBytes = fs.readFileSync(path.join(root, datPath));
    const tables = staticTables(datBytes);
    const datRecord = { path: datPath, sha256: sha(datBytes), bytes: datBytes.length };
    const archives = new Map(), originals = new Map();
    function tableEntry(resource) {
      const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(resource.archive_id); assert(archive);
      const archivePath = `extracted/app/DATA/${archive.name}`;
      if (!archives.has(archive.id)) {
        const parsed = parseArchive(path.join(root, archivePath));
        assert.equal(parsed.sha256, archive.sha256); assert.equal(parsed.size, archive.source_size);
        archives.set(archive.id, parsed);
      }
      const entry = archives.get(archive.id).entries[resource.entry_index]; assert(entry);
      for (const [a, b] of [['hash', 'hash'], ['type', 'type'], ['compression', 'compression'], ['offset', 'offset'], ['diskSize', 'disk_size'], ['size', 'size'], ['timestamp', 'timestamp']]) assert.equal(entry[a], resource[b]);
      return { archive: { path: archivePath, ...archive }, entry: resource };
    }
    function blob(hash) {
      const row = db.prepare('SELECT * FROM blobs WHERE sha256=?').get(hash); assert(row);
      const record = { path: `private-assets/${row.path}`, sha256: hash, bytes: row.size };
      const bytes = fs.readFileSync(path.join(root, record.path));
      assert.equal(bytes.length, row.size); assert.equal(sha(bytes), hash);
      return { record, bytes };
    }
    function original(hash) {
      hash = typeof hash === 'string' && !hash.startsWith('0x') ? nameHash(hash) : Number(hash);
      if (originals.has(hash)) return originals.get(hash);
      const aliases = db.prepare('SELECT * FROM aliases WHERE requested_hash=?').all(hash);
      assert(aliases.length && aliases.every(a => a.status === 'resolved' && a.resolved_id === aliases[0].resolved_id), `Unresolved alias ${hex(hash)}`);
      const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(aliases[0].resolved_id);
      const verified = tableEntry(resource), archivePath = verified.archive.path;
      const aliasTableEntries = aliases.map(alias => {
        const chain = JSON.parse(alias.chain_json).map(id => {
          const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id); assert(r); return tableEntry(r);
        });
        assert.equal(chain[0].entry.id, alias.requested_id);
        assert.equal(chain[0].entry.hash, hash);
        assert.equal(chain.at(-1).entry.id, resource.id);
        for (let i = 0; i + 1 < chain.length; i++) {
          assert.equal(chain[i].entry.compression, 0x65);
          assert.equal(chain[i].entry.disk_size, chain[i + 1].entry.hash);
        }
        return chain;
      });
      const raw = blob(resource.raw_blob), payload = blob(resource.payload_blob);
      const bytes = Buffer.alloc(resource.disk_size), fd = fs.openSync(path.join(root, archivePath), 'r');
      try { assert.equal(fs.readSync(fd, bytes, 0, bytes.length, resource.offset), bytes.length); } finally { fs.closeSync(fd); }
      assert.deepEqual(bytes, raw.bytes);
      assert([1, 3].includes(resource.compression));
      assert.deepEqual(resource.compression === 3 ? explode(bytes, resource.size) : bytes, payload.bytes);
      const paletteRow = db.prepare('SELECT * FROM palettes WHERE resource_id=?').get(resource.id); assert(paletteRow);
      const palette = blob(paletteRow.blob);
      let decoded, frame, indexed;
      if (resource.type === 2) {
        decoded = bitmap(payload.bytes); assert.deepEqual(decoded.palette, palette.bytes);
        frame = db.prepare('SELECT * FROM decodedframes WHERE resource_id=?').get(resource.id); assert(frame);
        indexed = blob(frame.indexed_blob); assert.deepEqual(decoded.pixels, indexed.bytes);
        assert.deepEqual(png(decoded.pixels, decoded.width, decoded.height, palette.bytes), blob(frame.png_blob).bytes);
      } else { assert.equal(resource.type, 3); assert.deepEqual(payload.bytes, palette.bytes); }
      const result = { decoded, palette, provenance: { catalogResourceId: resource.id, catalogSourceBinding: manifest.sourceBinding,
        entry: resource, aliasResolution: aliases, aliasTableEntries, archive: verified.archive, raw: raw.record, payload: payload.record,
        ...(frame ? { decodedFrameId: frame.id, indexedPixels: indexed.record } : {}),
        palette: { ...palette.record, association: paletteRow.association, resourceId: resource.id } } };
      originals.set(hash, result); return result;
    }
    const recipes = [];
    const add = (scene, hash, operations, state, module, first, last, extra = {}) => recipes.push({ scene, resourceId: hex(hash), operations,
      state, codeBinding: evidence(modulePath(module), first, last), ...extra });
    add('Scene1402', 0x231482F0, [[0x91D3A391, 0, 64, 0]], 'Full native scrolling original; engine shifts backgroundY=-10, not applied to source', 1400, 287, 300);
    add('Scene1404', 0xAC0B006F, [[0x00801510, 0, 65, 0]], 'All constructor entry states', 1400, 602, 660);
    add('Scene1608', 0x10080E01, [['paKlayRed', 0, 64, 0]], 'Lower floor; which=0 or restored standing', 1600, 201, 327);
    add('Scene1608', 0x98001604, [['paPodRed', 65, 31, 65], ['paKlayRed', 0, 64, 0]], 'Upper floor/car; which=1 or 2', 1600, 241, 327);
    add('Scene2403', 0x0C05060C, [[0x414364B0, 0, 65, 0]], 'All constructor entry states', 2400, 467, 516);
    add('Scene2501', 0x1B8E8115, [[0x00128842, 65, 31, 65], ['paKlayRed', 0, 64, 0]], 'All constructor entry states', 2500, 229, 315);
    add('Scene2706', 0x18808B88, [['paPodShade', 65, 31, 65], ['paKlayShade', 0, 65, 0]], 'All constructor entry states', 2700, 1026, 1040);
    add('Scene2805', 0x08021E04, [[0x8A6B1F91, 0, 65, 0]], 'All constructor entry states', 2800, 1263, 1303);
    for (const hash of [0x01400666, 0x11E00684, 0x030006E6]) {
      add('Scene2801', hash, [[0x15021024, 0, 65, 0]], 'Door branch as bound in code; which!=1/front palette endpoint', 2800, 397, 441);
      add('Scene2801', hash, [[0xB103B604, 0, 65, 0]], 'Same door branch; which=1/back palette endpoint', 2800, 397, 441);
    }
    for (const hash of [0x412A423E, 0x29800A01]) {
      add('Scene2803', hash, [], 'V_SHRINK_LIGHTS_ON selects matching bitmap; paletteArea=0 endpoint', 2800, 827, 897);
      add('Scene2803', hash, [[hash === 0x412A423E ? 0xB103B604 : 0x0263D144, 0, 64, 0]], 'Same lights branch; paletteArea=1 endpoint', 2800, 827, 897);
      add('Scene2803Small', hash, [], 'Matching lights branch; paletteArea=0 endpoint', 2800, 1118, 1148);
      add('Scene2803Small', hash, [[hash === 0x412A423E ? 0xB103B604 : 0x0263D144, 0, 64, 0]], 'Matching lights branch; paletteArea=2 endpoint', 2800, 1118, 1148);
      if (hash === 0x412A423E) add('Scene2803Small', hash, [[0x0A938204, 0, 64, 0]], 'V_SHRINK_LIGHTS_ON=true; paletteArea=1 endpoint', 2800, 1118, 1148);
    }
    for (const [scene, hashes, darkPalette, first, last] of [
      ['Scene2205', [0x0008028D, 0xD00A028D], 0x68033B1C, 836, 922],
      ['Scene2206', [0x41983216, 0xE0102A45], 0x0263D144, 948, 1021],
      ['Scene2242', [0x11840E24, 0x25848E24], 0x68033B1C, 1479, 1544],
      ['Scene2247', [0x40339414, 0x071963E5], null, 1693, 1748],
    ]) {
      add(scene, hashes[0], [], 'V_LIGHTS_ON=true; normal/front entry', 2200, first, last, { classification: 'records-hall-interior-not-statue-hall' });
      add(scene, hashes[1], darkPalette ? [[darkPalette, 0, 65, 0]] : [], 'V_LIGHTS_ON=false; normal shaded entry', 2200, first, last, { classification: 'records-hall-interior-not-statue-hall' });
      if (darkPalette && scene !== 'Scene2242') add(scene, hashes[1], [], 'V_LIGHTS_ON=false; lit-area palette endpoint', 2200, first, last);
      if (scene === 'Scene2206') add(scene, hashes[0], [[0xB103B604, 0, 65, 0]], 'V_LIGHTS_ON=true and which=2/behind spikes', 2200, first, last);
    }
    // All factory call sites supply the table IDs; no neighboring-resource inference.
    for (const [module, record] of code) {
      for (const match of record.excerpt.matchAll(/\bcreate(Scene270[34]|HallOfRecordsScene)\(which,\s*(0x[\da-f]+)/gi)) {
        const scene = match[1], id = Number(match[2]), line = record.excerpt.slice(0, match.index).split('\n').length;
        const isHall = scene === 'HallOfRecordsScene';
        const table = (isHall ? tables.halls : tables.tracks).filter(t => t.id === id); assert.equal(table.length, 1);
        const t = table[0], tableBinding = { ...datRecord, table: isHall ? 'HallOfRecordsInfo' : 'TrackInfo', record: t };
        const extra = { tableBinding, factoryBinding: evidence(modulePath(module), line, line),
          classification: isHall ? 'records-hall-interior-not-statue-hall' : 'scenic-track-base' };
        if (isHall) {
          add(scene, t.bgFilename1, [], 'V_LIGHTS_ON=true or absent dark bitmap', 2200, 1600, 1643, extra);
          if (t.bgFilename2) add(scene, t.bgFilename2, [], 'V_LIGHTS_ON=false', 2200, 1600, 1643, extra);
        } else if (scene === 'Scene2704') {
          const ops = [];
          if (t.exPaletteFilename1) ops.push([t.exPaletteFilename1, 0, 65, 0]);
          if (t.exPaletteFilename2) ops.push([t.exPaletteFilename2, 65, 31, 65]);
          add(scene, t.bgFilename, ops, 'Factory-specific TrackInfo constructor palette', 2700, 925, 942, extra);
        } else {
          for (const shade of ['Shade', 'Black']) add(scene, t.bgFilename,
            [[`paPod${shade}`, 65, 31, 65], [`paKlay${shade}`, 0, 65, 0]], `which selects ${shade} palette endpoint`, 2700, 810, 875, extra);
        }
      }
    }
    const track = tables.tracks.find(t => t.id === 0x004B2240); assert(track);
    add('Scene2701', track.bgFilename, [['paPodFloor', 65, 31, 65], ['paKlayFloor', 0, 65, 0]], 'Constructor floor palette', 2700, 548, 561,
      { tableBinding: { ...datRecord, table: 'TrackInfo', record: track } });
    // Position-dependent character palette arrays do not change the base bitmap;
    // retain each engine-defined endpoint and let exact RGB deduplication decide.
    for (const [scene, hash, array, first, last] of [
      ['Scene2806', 0xC1B22110, 'kScene2806PaletteFileHashes', 1419, 1442],
      ['Scene2809', 0xB22116C5, 'kScene2809PaletteFileHashes', 1695, 1718],
    ]) {
      const match = code.get(2800).excerpt.match(new RegExp(`${array}\\[\\]\\s*=\\s*\\{([^}]+)\\}`)); assert(match);
      for (const h of match[1].matchAll(/0x[\da-f]+/gi)) add(scene, hash, [[Number(h[0]), 0, 64, 0]], `${array} endpoint ${h[0]}; point-index predicate remains engine-owned`, 2800, first, last);
    }
    const priorRgb = new Map(prior.rooms.map(r => [r.rgbPixelSha256, r.id]));
    const priorSha = new Map(prior.rooms.map(r => [r.source.sha256, r.id]));
    const rooms = [], byRgb = new Map(), dispositions = [], previews = [];
    for (const recipe of recipes) {
      try {
        const source = original(recipe.resourceId), d = source.decoded; assert(d);
        const paletteProofs = recipe.operations.map(([hash, to, count, from]) => ({ requested: typeof hash === 'number' ? hex(hash) : hash,
          requestedHash: hex(typeof hash === 'number' ? hash : nameHash(hash)), to, count, from, ...original(hash).provenance }));
        const palette = bindPalette(source.palette.bytes, recipe.operations, hash => original(hash).palette.bytes);
        const bytes = png(d.pixels, d.width, d.height, palette), sourceSha = sha(bytes);
        const rgb = rgbIdentity(d.pixels, palette, d.width, d.height);
        const sourcePath = `${directory}/${sourceSha}.png`;
        const absolute = path.join(root, sourcePath);
        if (fs.existsSync(absolute)) assert.deepEqual(fs.readFileSync(absolute), bytes);
        else fs.writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o400 });
        const alias = { ...recipe, catalogResourceId: source.provenance.catalogResourceId, paletteProofs, boundPaletteSha256: sha(palette),
          rgbPixelSha256: rgb, sourceSha256: sourceSha, sourcePath, dimensions: [d.width, d.height] };
        previews.push(alias);
        if (d.width !== 640 || d.height !== 480) {
          dispositions.push({ ...alias, disposition: 'excluded-native-dimensions', reason: `Full original ${d.width}x${d.height} retained, not cropped or resized; not a 640x480 2K 4:3 input` }); continue;
        }
        if (recipe.scene === 'HallOfRecordsScene') {
          dispositions.push({ ...alias, disposition: 'excluded-records-textwall-scope', reason: 'Full original text-wall corridor, not statue hall. Earlier text-wall exclusion not unambiguously revoked by Hall of Fame request; source proofs retained separately, not queued as UI or scenic statue hall.' }); continue;
        }
        const duplicate = priorRgb.get(rgb) ?? priorSha.get(sourceSha);
        if (duplicate) { dispositions.push({ ...alias, disposition: 'duplicate-prior42', duplicateOf: duplicate }); continue; }
        let room = byRgb.get(rgb);
        if (room) { room.bindingAliases.push(alias); dispositions.push({ ...alias, disposition: 'duplicate-additional', duplicateOf: room.id }); continue; }
        const id = `${recipe.scene}-${recipe.resourceId.slice(2)}-${rgb.slice(0, 8)}`;
        room = { id, resourceId: recipe.resourceId, sourcePath,
          source: { path: sourcePath, sha256: sourceSha, bytes: bytes.length, role: 'source-composition', mimeType: 'image/png', dimensions: [d.width, d.height] },
          rgbPixelSha256: rgb, provenance: { ...source.provenance, codeBinding: recipe.codeBinding,
            palette: { ...source.provenance.palette, finalSha256: sha(palette), overrides: paletteProofs },
            decoding: { existingDecoder: 'tools/assets/formats.mjs:bitmap,png', dimensions: [d.width, d.height],
              originalIndexSha256: sha(d.pixels), paletteRgbBinding: 'Original indexed bitmap with exact engine-bound original palette entries; no sprite/foreground/UI/mask/frame assembly',
              resampled: false, cropped: false, transforms: [], opaque: true } }, bindingAliases: [alias] };
        rooms.push(room); byRgb.set(rgb, room);
        dispositions.push({ ...alias, disposition: 'new-accepted', roomId: id });
      } catch (error) { dispositions.push({ ...recipe, disposition: 'missing-proof', reason: error.message }); }
    }
    for (const hash of [0x412A423E, 0x29800A01]) dispositions.push({ scene: 'Scene2803Small', resourceId: hex(hash),
      state: 'paletteArea=3', disposition: 'excluded-engine-black-fill', codeBinding: evidence(modulePath(2800), 1118, 1148),
      reason: 'Engine fillBaseBlack(0,64) endpoint is a runtime palette fill rather than binding original palette entries; not synthesized for original-palette-only selection.' });
    const resolvedPrior = prior.dispositions.filter(d => d.disposition !== 'included').map(d => {
      const matches = dispositions.filter(r => r.scene === d.scene && (!d.resourceId || r.resourceId === d.resourceId));
      return { bindingId: d.id, scene: d.scene, resourceId: d.resourceId, previousReason: d.reason,
        disposition: matches.length ? 'resolved-per-state' : 'excluded',
        states: matches.map(r => ({ resourceId: r.resourceId, state: r.state, disposition: r.disposition, roomId: r.roomId, duplicateOf: r.duplicateOf, reason: r.reason })),
        reason: matches.length ? 'See exact per-state resource/palette and RGB dispositions' : d.reason };
    });
    const previewUnique = [...new Map(previews.map(p => [p.sourceSha256, p])).values()];
    const sheets = makeSheets(previewUnique);
    const prior1201 = prior.rooms.filter(r => r.id.startsWith('Scene1201')).map(room => {
      const source = original(room.resourceId), d = source.decoded;
      const bytes = png(d.pixels, d.width, d.height, source.palette.bytes);
      assert.equal(sha(bytes), room.source.sha256); assert.deepEqual(bytes, fs.readFileSync(path.join(root, room.sourcePath)));
      return { id: room.id, resourceId: room.resourceId, source: room.source, originalEmbeddedPalette: source.provenance.palette,
        correctOriginalPalette: true, codeBinding: evidence('scummvm/engines/neverhood/modules/module1200.cpp', 187, 195),
        explanation: 'Conditional creature state binds each bitmap to its matching embedded original palette. Different bridge/opening geometry states, not a pure lighting pair.' };
    });
    const document = { schemaVersion: 1, purpose: 'additional-original-source-selection-only', private: true,
      generationCalls: 0, networkCalls: 0, candidatesCreated: false,
      priorRegistry: { path: priorPath, sha256: sha(priorBytes), rooms: prior.rooms.length },
      catalog: { sourceBinding: manifest.sourceBinding, manifestSha256: sha(manifestBytes) },
      implementation: { path: 'tools/upscaling/gemini/repair-sources.mjs', sha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))) },
      sharedEvidence: { staticData: evidence('scummvm/engines/neverhood/staticdata.cpp', 178, 222),
        staticValidator: evidence('scripts/build-demo-data.mjs', 25, 58), paletteRanges: evidence('scummvm/engines/neverhood/palette.cpp', 50, 110),
        nameHash: evidence('scummvm/engines/neverhood/resource.cpp', 566, 582), originalOpaqueBackground: prior.sharedEvidence.opaqueSurface },
      hallClassification: { statueHall: { scene: 'Scene2810', resourceId: '0x26508804', disposition: 'duplicate-prior42',
        evidence: evidence(modulePath(2800), 115, 117), binding: evidence(modulePath(2800), 1720, 1729) },
        recordsHall: 'Module2200/HallOfRecordsScene is a different text-wall corridor family, not Hall of Fame. Original source proofs retained but pure text-wall corridor originals excluded for scope ambiguity. Scenic door/interior rooms2205/2206/2242/2247 classified separately and included.',
        statueCloseups: 'Twelve statueCloseup macro originals and Scene2822 button closeup remain excluded, not substituted for full hall.' },
      prior1201PaletteAudit: prior1201,
      pairedExperiment: { stateA: { roomId: 'Scene2803-412A423E-ecd4da1e', lighting: 'on' },
        stateB: { roomId: 'Scene2803-29800A01-b1f53112', lighting: 'off' },
        evidence: { binding: evidence(modulePath(2800), 827, 897),
          explanation: 'Same laboratory view, original V_SHRINK_LIGHTS_ON bitmap/palette branches, paletteArea=0 endpoint. No request or paired candidate created here.' } },
      staticTableInventory: { source: datRecord, inventory: tables.inventory, hallRecords: tables.halls.length, trackRecords: tables.tracks.length },
      verifiedOriginals: [...new Map([...originals.values()].map(o => [o.provenance.catalogResourceId, o.provenance])).values()],
      coverage: { recipes: recipes.length, additionalRooms: rooms.length, priorExcludedBindings: resolvedPrior.length,
        dispositionCounts: Object.fromEntries([...new Set(dispositions.map(d => d.disposition))].map(k => [k, dispositions.filter(d => d.disposition === k).length])) },
      deduplication: 'Exact decoded full RGB pixel SHA256 and exact source PNG SHA256 against all prior42, then against additional rooms; historical unknown outcomes never enter additional rooms.',
      limitations: ['Source-only base bitmaps, not gameplay screenshot or runtime layer assembly.', 'Palette fade interpolation is excluded; exact engine-defined endpoint palettes only.',
        'Full native non640x480 originals retained privately and excluded, never cropped.', 'No object/ROI inventories, generated candidates, paid judges or network calls.',
        'Point/entry predicates are retained as engine-owned state evidence, not a promise every cross-method state combination is reachable.'],
      visualInspection: { kind: 'manual-original-contact-sheet-inspection', sheets: sheets.map(s => ({ path: s.path, sha256: s.sha256 })),
        findings: ['Full scenic room and track originals, no runtime sprite assembly.', 'HallOfRecords pure text-wall originals kept separate and excluded from rooms.',
          'Scene1402 native640x500 retained in full and excluded from rooms.', 'Small palette endpoint differences are original palette bindings, not generated color adjustment.'] },
      contactSheets: sheets, priorExcludedDispositions: resolvedPrior, dispositions, rooms };
    const inspectionPath = `${directory}/inspection.json`;
    if (mode === '--inspect') fs.writeFileSync(path.join(root, inspectionPath), JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
    else {
      assert(fs.existsSync(path.join(root, inspectionPath)), 'Inspect original contact sheets before freezing');
      const inspected = JSON.parse(fs.readFileSync(path.join(root, inspectionPath)));
      assert.equal(sha(JSON.stringify(document)), sha(JSON.stringify(inspected)), 'Inspection inputs changed; inspect again before freeze');
      freezeJson(path.join(root, output), document);
    }
    console.log(JSON.stringify({ path: mode === '--inspect' ? inspectionPath : output, rooms: rooms.map(r => ({ id: r.id, resourceId: r.resourceId })), coverage: document.coverage, sheets: sheets.map(s => s.path) }, null, 2));
  } finally { db.close(); }
}

function makeSheets(previews) {
  const program = `import json,sys,os
from PIL import Image,ImageDraw
items=json.load(sys.stdin)
for start in range(0,len(items),16):
 sheet=Image.new('RGB',(1280,1040),'#242424');draw=ImageDraw.Draw(sheet)
 for i,item in enumerate(items[start:start+16]):
  x=(i%4)*320;y=(i//4)*260
  im=Image.open(item['sourcePath']).convert('RGB');im.thumbnail((316,237));sheet.paste(im,(x,y))
  draw.text((x+3,y+238),str(start+i+1)+' '+item['scene']+' '+item['resourceId'],fill='white')
 sheet.save(os.path.join(sys.argv[1],'sheet-%02d.png'%(start//16+1)))
`;
  execFileSync('python3', ['-c', program, path.join(root, directory)], { cwd: root, input: JSON.stringify(previews) });
  return Array.from({ length: Math.ceil(previews.length / 16) }, (_, i) => {
    const file = `${directory}/sheet-${String(i + 1).padStart(2, '0')}.png`, bytes = fs.readFileSync(path.join(root, file));
    return { path: file, sha256: sha(bytes), sources: previews.slice(i * 16, i * 16 + 16).map(p => ({ scene: p.scene, resourceId: p.resourceId, path: p.sourcePath, sha256: p.sourceSha256 })) };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3); main(process.argv[2]);
}
