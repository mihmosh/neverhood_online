import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { bitmap, png } from '../../assets/formats.mjs';
import { explode } from '../../assets/dcl.mjs';
import { parseArchive, privateRoot } from '../../assets/catalog.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = n => `0x${Number(n).toString(16).padStart(8, '0').toUpperCase()}`;
const output = 'private-assets/upscaling/opaque-all-source-selection.json';
const moduleDir = 'scummvm/engines/neverhood/modules';

// Source-only classifications, reviewed on the private numbered contact sheets.
const visualExclusions = new Map([
  ...['0000A245', '0100022B', '010F9284', '01C58000', '04270A94', '048C0600', '0A806204', '10866205', '2D438A00', '81C60635', '9408121E', 'CA811204'].map(h => [`0x${h}`, 'Statue/individual prop closeup between columns, not a full scenic room view (statueCloseup macro and contact-sheet review)']),
  ...['02108034', '023023B4', '046CF08E', '36204507', '9313A237', 'A651F246'].map(h => [`0x${h}`, 'Teleporter destination control UI closeup, not scenic room background']),
  ...['000C6444', '00442225', '01C01414', '08100A0C', '090B0192', '090B0392', '09507248', '0C0C007D', '20010002', '20628E05', '2800E011', '3E049A95', '51409A16', '60210ED5', '80802626', '8870A546', '90791B80', '92124A04', '92124A14', 'A1D03005', 'A8006200', 'D000420C'].map(h => [`0x${h}`, 'Puzzle/control/panel, held foreground sheet, inscription or device closeup rather than a full scenic room (C++ scene context plus visual review)']),
  ...['0CA04202', '30050A0A', '8420221D'].map(h => [`0x${h}`, 'Intro logo/credits/copyright screen, not a scenic room']),
  ...['11840E24', '25848E24', '40339414', '071963E5', '41983216', 'E0102A45'].map(h => [`0x${h}`, 'Hall-of-records wall-of-text room/state; excluded from scenic restoration scope even though traversable']),
]);

export function scanBindings(text, file) {
  const functions = [...text.matchAll(/^(?:[\w:*<>]+\s+)?(\w+)::(\w+)\([^;]*?\)\s*(?::[^{}]*?)?\{/gm)];
  const bindings = [];
  const calls = /\b(setBackground|createStaticScene|statueCloseup|changeBackground)\(([^)\n]*)\)|_background->load\(([^)\n]+)\)|new Background\(_vm,\s*(0x[\da-f]+)\b/gi;
  for (const match of text.matchAll(calls)) {
    if (text.slice(text.lastIndexOf('\n', match.index) + 1, match.index).trimStart().startsWith('#')) continue;
    const fn = functions.findLast(item => item.index <= match.index);
    const end = functions.find(item => item.index > match.index)?.index ?? text.length;
    const context = text.slice(fn?.index ?? 0, end);
    const expression = (match[2]?.split(',')[0] ?? match[3] ?? match[4]).trim();
    if (!expression || expression === '0') continue;
    const line = text.slice(0, match.index).split('\n').length;
    const scene = fn?.[1] ?? path.basename(file, '.cpp');
    let hashes = /^0x[\da-f]+$/i.test(expression) ? [Number(expression)] : [];
    let resolution = hashes.length ? 'literal C++ resource hash' : null;
    const array = expression.match(/^(\w+)\[/)?.[1];
    if (array) {
      const initializer = text.match(new RegExp(`\\b${array}\\[\\]\\s*=\\s*\\{([^}]+)\\}`));
      if (initializer) {
        hashes = [...initializer[1].matchAll(/0x[\da-f]+/gi)].map(item => Number(item[0]));
        resolution = `All entries of C++ ${array} initializer`;
      }
    }
    if (expression === 'backgroundFileHash' && scene === 'Scene1501') {
      hashes = [...text.matchAll(/new Scene1501\(_vm, this,\s*(0x[\da-f]+)/gi)].map(item => Number(item[1]));
      resolution = 'All Scene1501 constructor arguments in module1500.cpp';
    }
    if (expression === 'backgroundFileHash' && scene === 'Scene1105') {
      const initializer = text.match(/kScene1105BackgroundFileHashes\[\]\s*=\s*\{([^}]+)\}/);
      hashes = [...initializer[1].matchAll(/0x[\da-f]+/gi)].map(item => Number(item[0]));
      resolution = 'All entries of kScene1105BackgroundFileHashes, used by both panel-transition methods';
    }
    if (expression === 'fileHash' && scene === 'Scene2206') {
      hashes = [...context.matchAll(/fileHash\s*=\s*(0x[\da-f]+)/gi)].map(item => Number(item[1]));
      resolution = 'All fileHash branch assignments in Scene2206 constructor';
    }
    const sceneContext = functions.filter(f => f[1] === scene).map(f => text.slice(f.index, functions.find(next => next.index > f.index)?.index ?? text.length)).join('\n');
    const paletteLines = sceneContext.split('\n').filter(s => /setPalette\(|_palette->(?:add|copy|startFade|fill)|setBackground[XY]\(/.test(s)).map(s => s.trim());
    bindings.push({ id: `${path.basename(file)}:${line}`, scene, method: fn?.[2] ?? 'createScene',
      call: match[1] ?? (match[3] ? '_background->load' : 'new Background'), expression,
      hashes: [...new Set(hashes)].map(hex), resolution,
      codeBinding: { path: file, sha256: sha(Buffer.from(text)), lines: [line, line], excerpt: text.split('\n')[line - 1] },
      stateContext: { path: file, lines: [Math.max(1, line - 12), line + 6], excerpt: text.split('\n').slice(Math.max(0, line - 13), line + 6).join('\n') },
      context: { lines: [text.slice(0, fn?.index ?? 0).split('\n').length, text.slice(0, end).split('\n').length], paletteOperations: paletteLines,
        paletteScope: 'All methods of the binding class in this module, not just constructor' },
    });
  }
  return bindings;
}

export function paletteSafety(binding, histogram, embedded, resolvePalette) {
  const proofs = [], problems = [];
  for (const operation of binding.context.paletteOperations) {
    if (/setBackground[XY]\(/.test(operation)) { problems.push(operation); continue; }
    if (!/_palette->(?:add|fill|copyPalette\()/i.test(operation)) continue;
    const range = operation.match(/(?:add(?:Base)?Palette\(.+|copyPalette\(.+),\s*(\d+),\s*(\d+),\s*(\d+)\)/);
    if (!range) { problems.push(operation); continue; }
    const [, to, count, from] = range.map(Number);
    const unused = histogram.slice(to, Math.min(256, to + count)).every(n => n === 0);
    const samePalette = operation.includes(`(${binding.expression},`) && to === from;
    if (unused || samePalette) proofs.push({ operation, reason: unused ? 'Override destination indices are unused by this original background' : 'Copies identical embedded palette entries at identical indices' });
    else {
      const hash = operation.match(/Palette\((0x[\da-f]+)/i)?.[1];
      let proof;
      try {
        const override = hash && resolvePalette?.(Number(hash));
        if (override && histogram.every((n, i) => !n || i < to || i >= to + count || embedded.subarray(i * 4, i * 4 + 3).equals(override.bytes.subarray((from + i - to) * 4, (from + i - to) * 4 + 3))))
          proof = { operation, reason: 'Verified original override palette leaves RGB identical at every used destination index', palette: override.record };
      } catch { /* An unverified override cannot establish palette safety. */ }
      if (proof) proofs.push(proof); else problems.push(operation);
    }
  }
  return { safe: problems.length === 0, proofs, unresolvedOperations: problems };
}

export function rgbIdentity(pixels, palette, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) palette.copy(rgb, i * 3, pixels[i] * 4, pixels[i] * 4 + 3);
  return sha(rgb);
}

export function freezeJson(destination, document) {
  const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n');
  if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination), bytes, 'Frozen bulk registry differs; refusing overwrite');
  else {
    const fd = fs.openSync(destination, 'wx', 0o444);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return sha(bytes);
}

function contactSheets(candidates, directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const program = `import json,sys,os,io,hashlib
from PIL import Image,ImageDraw
items=json.loads(sys.stdin.read())
hashes={}
for item in items:
 im=Image.open(item['path']).convert('RGB');out=io.BytesIO();im.save(out,format='PNG')
 hashes[item['label'].split()[0]]=hashlib.sha256(out.getvalue()).hexdigest()
for start in range(0,len(items),16):
 sheet=Image.new('RGB',(1280,1040),'#242424'); draw=ImageDraw.Draw(sheet)
 for i,item in enumerate(items[start:start+16]):
  x=(i%4)*320;y=(i//4)*260
  im=Image.open(item['path']).convert('RGB');im.thumbnail((316,237))
  sheet.paste(im,(x,y));draw.text((x+3,y+238),str(start+i+1)+' '+item['label'],fill='white')
 sheet.save(os.path.join(sys.argv[1],'sheet-%02d.png'%(start//16+1)))
print(json.dumps(hashes))
`;
  const rgbPngHashes = JSON.parse(execFileSync('python3', ['-c', program, directory], { input: JSON.stringify(candidates.map(c => ({ path: path.join(root, c.sourcePath), label: `${c.resourceId} ${c.scene}` }))), encoding: 'utf8' }));
  const sheets = fs.readdirSync(directory).filter(name => /^sheet-\d+\.png$/.test(name)).sort().map(name => {
    const absolute = path.join(directory, name), bytes = fs.readFileSync(absolute);
    return { path: path.relative(root, absolute), sha256: sha(bytes), bytes: bytes.length };
  });
  return { sheets, rgbPngHashes };
}

export function prepareBulkSources({ inspectOnly = false } = {}) {
  const privateDir = privateRoot(path.join(root, 'private-assets'), root);
  const db = new DatabaseSync(path.join(privateDir, 'catalog.sqlite'), { readOnly: true });
  try {
    const manifestBytes = fs.readFileSync(path.join(privateDir, 'manifest.json')), manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.variant, 'english');
    assert.equal(manifest.sourceBinding, db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get().value);
    const evidence = (file, first, last) => {
      const bytes = fs.readFileSync(path.join(root, file));
      return { path: file, sha256: sha(bytes), lines: [first, last], excerpt: bytes.toString().split('\n').slice(first - 1, last).join('\n') };
    };
    const modules = fs.readdirSync(path.join(root, moduleDir)).filter(n => /^module.*\.cpp$/.test(n)).sort();
    const bindings = modules.flatMap(name => scanBindings(fs.readFileSync(path.join(root, moduleDir, name), 'utf8'), `${moduleDir}/${name}`));
    const rawSetBackgroundCalls = modules.reduce((n, name) => n + [...fs.readFileSync(path.join(root, moduleDir, name), 'utf8').matchAll(/\bsetBackground\(/g)].length, 0);
    assert.equal(bindings.filter(b => b.call === 'setBackground').length, rawSetBackgroundCalls, 'Incomplete module setBackground scan');
    const files = modules.map(name => ({ path: `${moduleDir}/${name}`, sha256: sha(fs.readFileSync(path.join(root, moduleDir, name))) }));
    const blob = hash => {
      const row = db.prepare('SELECT * FROM blobs WHERE sha256=?').get(hash); assert(row, `Missing blob ${hash}`);
      const relative = `private-assets/${row.path}`, bytes = fs.readFileSync(path.join(root, relative));
      assert.equal(bytes.length, row.size); assert.equal(sha(bytes), hash);
      return { record: { path: relative, sha256: hash, bytes: bytes.length }, bytes };
    };
    const archives = new Map(), verified = new Map(), candidates = [], dispositions = [];
    function originalPayload(resource) {
      const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(resource.archive_id);
      const archivePath = `extracted/app/DATA/${archive.name}`;
      if (!archives.has(archive.id)) {
        const parsed = parseArchive(path.join(root, archivePath));
        assert.equal(parsed.sha256, archive.sha256); assert.equal(parsed.size, archive.source_size); archives.set(archive.id, parsed);
      }
      const entry = archives.get(archive.id).entries[resource.entry_index];
      for (const [a, b] of [['hash', 'hash'], ['type', 'type'], ['compression', 'compression'], ['offset', 'offset'], ['diskSize', 'disk_size'], ['size', 'size'], ['timestamp', 'timestamp']]) assert.equal(entry[a], resource[b]);
      const raw = blob(resource.raw_blob), payload = blob(resource.payload_blob);
      const original = Buffer.alloc(resource.disk_size), fd = fs.openSync(path.join(root, archivePath), 'r');
      try { assert.equal(fs.readSync(fd, original, 0, original.length, resource.offset), original.length); } finally { fs.closeSync(fd); }
      assert.deepEqual(original, raw.bytes);
      assert([1, 3].includes(resource.compression), 'Unsupported source compression');
      assert.deepEqual(resource.compression === 3 ? explode(original, resource.size) : original, payload.bytes);
      return { raw, payload, archive, archivePath };
    }
    function resolved(hash) {
      const aliases = db.prepare('SELECT * FROM aliases WHERE requested_hash=?').all(Number(hash));
      assert(aliases.length); assert(aliases.every(a => a.status === 'resolved' && a.resolved_id === aliases[0].resolved_id), `Ambiguous archive resolution ${hash}`);
      return { aliases, resource: db.prepare('SELECT * FROM resources WHERE id=?').get(aliases[0].resolved_id) };
    }
    const paletteCache = new Map();
    function originalPalette(hash) {
      if (paletteCache.has(hash)) return paletteCache.get(hash);
      const { resource } = resolved(hash), { payload } = originalPayload(resource);
      const row = db.prepare('SELECT * FROM palettes WHERE resource_id=?').get(resource.id);
      assert(row); const pal = blob(row.blob);
      assert.deepEqual(resource.type === 2 ? bitmap(payload.bytes).palette : payload.bytes, pal.bytes);
      assert.equal(pal.bytes.length, 1024);
      const result = { ...pal, record: { ...pal.record, resourceId: resource.id, originalPayload: payload.record, association: row.association } };
      paletteCache.set(hash, result); return result;
    }
    function verify(hash) {
      if (verified.has(hash)) return verified.get(hash);
      const { aliases, resource } = resolved(hash);
      assert.equal(resource.type, 2); assert.equal(resource.status, 'decoded'); assert.equal(resource.error, null);
      const frame = db.prepare('SELECT * FROM decodedframes WHERE resource_id=?').get(resource.id);
      assert.equal(frame.palette_status, 'known-embedded');
      const palette = db.prepare('SELECT * FROM palettes WHERE id=?').get(frame.palette_id);
      assert.equal(palette.association, 'embedded'); assert.equal(palette.resource_id, resource.id);
      const { raw, payload, archive, archivePath } = originalPayload(resource);
      const decoded = bitmap(payload.bytes), indexed = blob(frame.indexed_blob), pal = blob(palette.blob), image = blob(frame.png_blob);
      assert.deepEqual(decoded.pixels, indexed.bytes); assert.deepEqual(decoded.palette, pal.bytes);
      assert.deepEqual(png(decoded.pixels, decoded.width, decoded.height, decoded.palette), image.bytes);
      assert.equal(frame.width, decoded.width); assert.equal(frame.height, decoded.height);
      const histogram = Array(256).fill(0); for (const n of decoded.pixels) histogram[n]++;
      const result = { resourceId: hash, sourcePath: image.record.path,
        source: { ...image.record, role: 'source-composition', mimeType: 'image/png', dimensions: [decoded.width, decoded.height] },
        rgbPixelSha256: rgbIdentity(decoded.pixels, decoded.palette, decoded.width, decoded.height),
        provenance: { catalogResourceId: resource.id, decodedFrameId: frame.id, catalogSourceBinding: manifest.sourceBinding,
          archive: { path: archivePath, ...archive }, entry: resource, aliasResolution: aliases,
          raw: raw.record, payload: payload.record, indexedPixels: indexed.record,
          palette: { ...pal.record, id: palette.id, association: palette.association, resourceId: palette.resource_id },
          decoding: { existingDecoder: 'tools/assets/formats.mjs:38-65,113-121', flags: decoded.flags,
            dimensions: [decoded.width, decoded.height], position: [decoded.x, decoded.y],
            paletteIndexHistogram: histogram, indexZeroPixels: histogram[0],
            transparency: 'Scene background surface setTransparent(false); existing PNG encoder emits indexed RGB without tRNS or alpha, including index zero',
            verification: ['Archive SHA and entry table match catalog', 'Original archive byte range equals raw blob', 'Existing DCL decompression equals payload blob', 'Existing bitmap decoder equals indexed pixels and embedded palette', 'Existing PNG encoder reproduces catalog original byte-for-byte'],
            transforms: [], resampled: false, composited: false } } };
      verified.set(hash, result); return result;
    }
    for (const binding of bindings) {
      if (!binding.hashes.length) {
        const template = binding.scene === 'Module2800' && binding.expression === 'backgroundFileHash';
        const reason = template ? 'statueCloseup macro template; all 12 literal macro invocation bindings are expanded and classified individually, not a separate original resource'
          : binding.scene === 'HallOfRecordsScene' ? 'Hall-of-records static-data bgFilename1/bgFilename2 indirection; text-wall room family, but original resource/palette IDs not independently resolved; excluded, not guessed'
          : 'TrackInfo tracks->bgFilename static-data indirection with track/palette state; original resource/palette IDs and full non-scrolling view not independently resolved; excluded, not guessed';
        dispositions.push({ ...binding, disposition: template ? 'excluded' : 'unresolved', reason }); continue;
      }
      for (const hash of binding.hashes) {
        const item = { ...binding, resourceId: hash };
        try {
          const source = verify(hash);
          candidates.push({ ...source, scene: binding.scene });
          const dimensions = source.source.dimensions;
          let reason = visualExclusions.get(hash);
          if (binding.scene === 'Scene1105') reason = 'Dice puzzle panel and its opening/closing transition frames (C++ createObjects/upOpenPanel/upClosePanel), not scenic room';
          if (dimensions[0] * 3 !== dimensions[1] * 4 || dimensions[0] !== 640) reason = `Not original full 640x480 4:3 view (${dimensions.join('x')}); scrolling/partial/composite framing not authorized`;
          const operations = binding.context.paletteOperations;
          item.paletteVerification = paletteSafety(binding, source.provenance.decoding.paletteIndexHistogram, blob(source.provenance.palette.sha256).bytes, originalPalette);
          if (!reason && !item.paletteVerification.safe) reason = 'State-specific palette overrides/mutations or shifted view touch used or unresolved entries; excluded conservatively (see paletteVerification)';
          if (!reason && !operations.some(s => s.includes(`setPalette(${binding.expression})`)) && binding.call !== '_background->load' && binding.call !== 'createStaticScene' && binding.call !== 'statueCloseup') reason = 'No matching background/embedded-palette binding independently established';
          if (reason) dispositions.push({ ...item, disposition: 'excluded', reason, source: source.source, rgbPixelSha256: source.rgbPixelSha256 });
          else dispositions.push({ ...item, disposition: 'included', reason: 'Original full-view scenic room background with matched embedded palette and opaque engine surface', source: source.source, rgbPixelSha256: source.rgbPixelSha256 });
        } catch (error) { dispositions.push({ ...item, disposition: 'unresolved', reason: `Original catalog/decode provenance not verified: ${error.message}` }); }
      }
    }
    const uniqueCandidates = [...new Map(candidates.map(c => [c.resourceId, c])).values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    const { sheets, rgbPngHashes } = contactSheets(uniqueCandidates, path.join(privateDir, 'upscaling/opaque-all-contact-sheets'));
    for (const [hash, source] of verified) source.rgbPngSha256 = rgbPngHashes[hash];
    if (inspectOnly) {
      console.log(JSON.stringify({ candidates: uniqueCandidates.map((c, i) => ({ number: i + 1, resourceId: c.resourceId, scene: c.scene, dimensions: c.source.dimensions })), sheets, dispositions }, null, 2)); return;
    }
    const pilotPath = 'private-assets/upscaling/opaque-pilot-source-selection.json', pilotBytes = fs.readFileSync(path.join(root, pilotPath)), pilot = JSON.parse(pilotBytes);
    const rooms = [], byRgb = new Map();
    for (const disposition of dispositions.filter(d => d.disposition === 'included')) {
      const source = verified.get(disposition.resourceId);
      const alias = { scene: disposition.scene, resourceId: disposition.resourceId, bindingId: disposition.id, expression: disposition.expression, codeBinding: disposition.codeBinding, context: disposition.context };
      let room = byRgb.get(source.rgbPngSha256);
      if (room) { room.bindingAliases.push(alias); continue; }
      const variants = dispositions.filter(d => d.scene === disposition.scene && d.disposition === 'included').map(d => d.resourceId);
      const id = new Set(variants).size > 1 ? `${disposition.scene}-${source.resourceId.slice(2)}` : disposition.scene;
      room = { id, ...source, provenance: { ...source.provenance, codeBinding: disposition.codeBinding }, bindingAliases: [alias],
        visualInspection: { method: 'Source-only numbered private contact sheets', sheet: sheets[Math.floor(uniqueCandidates.findIndex(c => c.resourceId === source.resourceId) / 16)].path,
          scope: 'Scenic room versus puzzle/UI/prop classification only; no new manual inventories or ROIs' } };
      rooms.push(room); byRgb.set(source.rgbPngSha256, room);
    }
    for (const room of rooms) room.bindingAliases = dispositions.filter(d => verified.get(d.resourceId)?.rgbPngSha256 === room.rgbPngSha256).map(d => ({
      scene: d.scene, method: d.method, resourceId: d.resourceId, bindingId: d.id, expression: d.expression,
      disposition: d.disposition, codeBinding: d.codeBinding, stateContext: d.stateContext, context: d.context, paletteVerification: d.paletteVerification,
    }));
    assert.equal(new Set(rooms.map(r => r.id)).size, rooms.length);
    assert.equal(new Set(rooms.map(r => r.source.sha256)).size, rooms.length);
    assert(pilot.rooms.every(p => rooms.some(r => r.source.sha256 === p.source.sha256)), 'Bulk must retain all qualifying pilot originals');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'scummvm'), encoding: 'utf8' }).trim();
    const document = { schemaVersion: 1, purpose: 'source-selection-and-provenance-only', private: true,
      candidatesCreated: false, generationCalls: 0, networkCalls: 0, annotationsFrozenBeforeCandidates: true,
      selectionScope: 'All confidently verified unique original opaque 640x480 4:3 static scenic room base backgrounds in complete module binding scan, including exterior views; unresolved and state-palette-ambiguous bindings excluded explicitly',
      catalog: { path: 'private-assets/catalog.sqlite', manifestPath: 'private-assets/manifest.json', manifestSha256: sha(manifestBytes), sourceBinding: manifest.sourceBinding,
        manifestSummary: { errors: manifest.errors, unresolvedPalettes: manifest.unresolvedPalettes, probeErrors: manifest.probeErrors } },
      sharedEvidence: { ...pilot.sharedEvidence, engineReferenceRevision: revision,
        preparationScriptSha256: sha(fs.readFileSync(path.join(root, 'tools/upscaling/gemini/prepare-opaque-sources.mjs'))),
        bulkSourceModuleSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
        paletteRanges: evidence('scummvm/engines/neverhood/palette.cpp', 79, 110),
        staticScene: evidence('scummvm/engines/neverhood/scene.cpp', 610, 623) },
      coverage: { files, moduleSetBackgroundCallSites: bindings.filter(b => b.call === 'setBackground').length, scannedBindingCallSites: bindings.length,
        expandedDispositions: dispositions.length, verifiedUniqueResources: verified.size,
        note: 'Scans every module*.cpp, including sprites, and records setBackground, createStaticScene, statueCloseup, changeBackground, direct _background loads and literal Background constructors. Navigation/video scenes are not static source bitmaps. Nonmodule menu and disk-player UI are outside scenic scope.' },
      deduplication: { key: 'rgbPngSha256', encoder: 'Pillow RGB PNG, default lossless save, no transforms', note: 'SHA-256 of original PNG decoded to RGB and encoded losslessly, without resampling; rgbPixelSha256 independently verifies original RGB pixels and source.sha256 retains exact original catalog PNG bytes. All verified room/state/code aliases retained with individual dispositions.' },
      contactSheets: { visualReview: 'All candidate originals inspected in numbered groups; scene contexts used to distinguish scenic views from closeups/UI. Three additional dice-panel transition frames inspected after array expansion.',
        sources: uniqueCandidates.map((c, i) => ({ number: i + 1, resourceId: c.resourceId, scene: c.scene, sourcePath: c.sourcePath, sha256: c.source.sha256 })), sheets },
      pilotProvenance: { path: pilotPath, sha256: sha(pilotBytes), note: 'Copied frozen pilot annotations as provenance only; not bulk inventories or ROI profiles',
        inventories: pilot.rooms.map(r => ({ id: r.id, resourceId: r.resourceId, sourceSha256: r.source.sha256, inventory: r.inventory, regions: r.regions, visualInspection: r.visualInspection })) },
      limitations: ['Original base layers only, not screenshots or runtime composites; sprites, masks, characters, text overlays and foregrounds are absent.',
        'Runtime/static-data table indirections not independently resolved are explicitly unresolved, not claims that their images are non-scenic.',
        'Palette-mutated/shifted sources are excluded unless independently resolved; no guessed palette overrides.',
        'Contact-sheet review classifies composition, not exhaustive object inventories or microscopic texture; no runtime screenshot comparison.',
        'All media remains private; archive checksums establish byte provenance, not redistribution rights.'],
      verifiedSources: [...verified.values()], dispositions, rooms };
    const digest = freezeJson(path.join(root, output), document);
    console.log(JSON.stringify({ path: output, sha256: digest, rooms: rooms.length, dispositions: dispositions.length,
      counts: Object.fromEntries(['included', 'excluded', 'unresolved'].map(s => [s, dispositions.filter(d => d.disposition === s).length])), generationCalls: 0, networkCalls: 0 }, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--contact-sheets']);
  prepareBulkSources({ inspectOnly: true });
}
