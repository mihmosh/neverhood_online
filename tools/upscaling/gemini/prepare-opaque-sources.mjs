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
import { prepareBulkSources } from './bulk-sources.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => value.toString(16).padStart(8, '0').toUpperCase();
const output = 'private-assets/upscaling/opaque-pilot-source-selection.json';

// Source-only observations made by individually opening the original catalog PNGs.
// Pixel boxes are [left, top, right, bottom], converted without candidate feedback.
const selections = [
  {
    id: 'Scene1109', hash: '8449E02F', module: 'module1100.cpp', line: 485,
    inventory: [
      'Green roughly sculpted wall and floor, with long dark ceiling/wall seam.',
      'Right-side pale curled teleporter shell, dark opening, reddish vertical interior and trailing stem.',
      'Round reddish control face and small loop attached to the teleporter; curled base recess.',
      'Broad unoccupied green wall at left; no character or loose pickups in the bitmap.',
    ],
    regions: [
      ['teleporter-shell', 'Pale shell silhouette, curling lip, interior opening and reddish inset', [338, 149, 553, 464]],
      ['teleporter-control', 'Circular red-orange control, pale rim and adjacent small loop', [340, 307, 425, 391]],
      ['ceiling-seam', 'Long irregular ceiling seam and upper-right dark recess', [0, 0, 640, 117]],
      ['empty-wall', 'Unoccupied left green wall; preserve dents without introducing objects', [0, 112, 337, 413]],
      ['base-and-floor', 'Teleporter base curl and wall/floor transition', [268, 390, 640, 480]],
    ],
  },
  {
    id: 'Scene1302', hash: '420643C4', module: 'module1300.cpp', line: 324,
    inventory: [
      'Predominantly black room shell with deep saturated blue sculpted architectural edges.',
      'Central-left blue arched opening with three left-pointing protrusions and a dark interior.',
      'Five blue rounded ceiling pads and a row of irregular blue floor pads.',
      'Three diminishing rounded blue wall forms to the right of the arch.',
      'Tall pink-lit inset at far right with a thick irregular blue border.',
      'No hanging rings, bridge, fence, flytrap or character composited into this source.',
    ],
    regions: [
      ['blue-arch', 'Blue arched aperture, three left protrusions and dark opening', [130, 100, 376, 362]],
      ['ceiling-pads', 'Five rounded ceiling forms; preserve count and spacing', [190, 0, 374, 48]],
      ['wall-roundels', 'Three diminishing rounded forms to the right of the arch', [344, 224, 512, 323]],
      ['right-inset', 'Pink-lit tall inset and irregular blue frame', [519, 12, 624, 374]],
      ['floor-and-darkness', 'Blue floor-pad row and original black negative space below', [0, 344, 526, 480]],
    ],
  },
  {
    id: 'Scene1305', hash: '28801B64', module: 'module1300.cpp', line: 595,
    inventory: [
      'Purple room walls, ceiling and floor.',
      'Narrow blue-bordered dark aperture at left, with pale spike-like bars at its lower edge.',
      'Two broad red vertical bands bending over wall/floor; right band curls into a large spiral.',
      'Far-right red sculpted vertical motif with rounded upper and lower lobes.',
      'Red band runs along left floor edge; no character in original bitmap.',
    ],
    regions: [
      ['left-aperture', 'Blue-edged left opening, dark void and visible pale spikes', [58, 91, 150, 447]],
      ['red-bands', 'Two red descending wall bands and their irregular widths', [199, 0, 549, 294]],
      ['red-spiral', 'Large red spiral and purple negative space within it', [280, 239, 515, 421]],
      ['right-motif', 'Far-right red rounded motif; preserve lobes and narrow internal opening', [505, 158, 640, 447]],
      ['floor-junction', 'Purple floor and red band continuation, no added props', [0, 413, 640, 480]],
    ],
  },
  {
    id: 'Scene1306', hash: '05303114', module: 'module1300.cpp', line: 623,
    inventory: [
      'Purple sculpted room with broad empty upper wall.',
      'Cyan/turquoise curled teleporter shell at left, reddish interior and round red control.',
      'Central pointed arch with warm orange clay surface visible through it.',
      'Small black wall plaque with pale downward-arrow mark beside central arch.',
      'Pale rounded wall-mounted screen/control housing to the right, with dark slot above.',
      'Narrow warm-lit right opening and thin floor illumination; no key, tape or character.',
    ],
    regions: [
      ['teleporter', 'Cyan shell, red inset and round control with smaller adjacent circles', [25, 143, 238, 460]],
      ['central-arch', 'Pointed purple arch and warm orange interior', [190, 186, 363, 439]],
      ['arrow-plaque', 'Small dark plaque with original pale down arrow only', [340, 317, 388, 380]],
      ['wall-console', 'Pale rounded display housing, internal marks and upper dark slot', [401, 268, 536, 409]],
      ['right-opening', 'Narrow warm-lit opening and its irregular purple boundary', [548, 239, 620, 447]],
      ['room-shell', 'Broad upper purple wall and ceiling; preserve original empty space', [0, 0, 640, 143]],
    ],
  },
  {
    id: 'Scene1308', hash: '41024202', module: 'module1300.cpp', line: 938,
    inventory: [
      'Dark room wall, floor and ceiling with a small illuminated area at left-center.',
      'Left red/pink arched border with pointed protrusions and purple jagged forms inside.',
      'Broad ribbed cylindrical hanging form overhead.',
      'Small pale illuminated wall patch with faint original incised marks; do not interpret as legible text.',
      'Red/blue alternating floor pads and tall blue far-right vertical form.',
      'No projector, mouse, tape, key-slot numbers or character added to the background.',
    ],
    regions: [
      ['jagged-arch', 'Pink/red arch, outward points and original purple jagged inner shapes', [0, 148, 226, 448]],
      ['ribbed-cylinder', 'Overhead ribbed cylinder and descending curved silhouette', [147, 0, 310, 191]],
      ['lit-wall-marks', 'Lit wall patch and only faint original incised marks, no invented text', [200, 210, 309, 342]],
      ['floor-pads', 'Alternating red and blue floor pads and their irregular boundaries', [86, 416, 605, 466]],
      ['dark-right-shell', 'Dark empty wall and tall far-right blue form; do not brighten or add props', [306, 42, 640, 438]],
    ],
  },
  {
    id: 'Scene1401', hash: '08221FA5', module: 'module1400.cpp', line: 152,
    inventory: [
      'Brown/ochre cave-like room shell and floor, with irregular ceiling.',
      'Several long pale pointed hanging ceiling forms above the middle-left area.',
      'Central thick orange rectangular doorway frame with purple clay interior.',
      'Tall narrow bright pink/yellow left opening with dark lower-edge cutouts.',
      'Small round pale wall nub left of central frame and broad red right doorway surface.',
      'Scattered reddish floor marks are baked in; no mouse, cheese, pipe animation or projector.',
    ],
    regions: [
      ['central-frame', 'Thick irregular orange frame and purple interior surface', [180, 172, 412, 442]],
      ['ceiling-points', 'Pale hanging ceiling points, count, tips and intervening gaps', [137, 20, 280, 205]],
      ['left-light', 'Tall pink/yellow illuminated slit and dark lower edge cutouts', [22, 99, 161, 411]],
      ['right-red-door', 'Broad red right-side door surface and surrounding dark border', [494, 126, 640, 448]],
      ['wall-nub-floor', 'Small pale wall nub and ochre floor with existing red patches', [163, 331, 640, 480]],
    ],
  },
  {
    id: 'Scene1403', hash: '2110A234', module: 'module1400.cpp', line: 502,
    inventory: [
      'Pale cream sculpted projection-room wall and floor.',
      'Large yellow irregular ceiling slabs, with dark gaps between them.',
      'Tilted pale yellow square wall tile with glossy lower edge and hanging drip.',
      'Dark edge openings at far left and right.',
      'Faint small incised cross and dash near lower center, and two low irregular pale floor forms.',
      'No projector or tapes in the original bitmap; do not fill the otherwise empty wall.',
    ],
    regions: [
      ['ceiling-slabs', 'Irregular yellow ceiling slabs and dark intervening gaps', [0, 0, 640, 173]],
      ['tilted-tile', 'Tilted square wall tile, reflected highlight and descending drip', [120, 144, 313, 385]],
      ['left-edge-opening', 'Dark left opening with pale irregular edge', [0, 126, 61, 323]],
      ['right-edge-opening', 'Dark right opening and slanting yellow slab boundary', [471, 52, 640, 445]],
      ['lower-marks-floor', 'Faint original cross/dash, low pale floor forms and wall/floor junction', [76, 366, 583, 480]],
    ],
  },
  {
    id: 'Scene2101', hash: '44242305', module: 'module2100.cpp', line: 89,
    inventory: [
      'Pink/purple cylindrical room wall and floor with strong diagonal light/shadow boundary.',
      'Left pale curled teleporter shell with red control disk and smaller adjacent details.',
      'Large shallow incised wall drawings in the illuminated upper-left and central/right wall.',
      'Narrow tall right opening filled by warm orange surface.',
      'Small ochre oval on lower middle floor is present in original; no added tapes or character.',
    ],
    regions: [
      ['teleporter', 'Left pale curled shell, dark opening and red circular control', [21, 198, 234, 465]],
      ['upper-wall-drawing', 'Shallow original upper-left incised drawing, not newly legible text', [22, 0, 333, 246]],
      ['right-wall-drawing', 'Central/right incised drawing, thin lines and original shadow contrast', [204, 111, 556, 369]],
      ['right-opening', 'Tall warm orange right opening and irregular purple edge', [536, 106, 634, 451]],
      ['floor-and-light', 'Small ochre floor oval and diagonal lighting transition', [226, 374, 543, 480]],
    ],
  },
  {
    id: 'Scene2201', hash: '40008208', module: 'module2200.cpp', line: 482,
    inventory: [
      'Pink/cream room shell, floor and ceiling, with diagonal sunlight across left side.',
      'Tall irregular pale left frame around narrow dark opening with small bright slivers.',
      'Large pale rounded sphere on stepped cylindrical pedestal at lower left.',
      'Small recessed grid with three columns and three rows left of central doorway.',
      'Rounded dark central-right doorway, tiny dark right wall recess, and small hanging ceiling fixture.',
      'No puzzle cubes, animated ceiling fan, tapes, door overlays or character composited into source.',
    ],
    regions: [
      ['left-window', 'Tall pale irregular frame, black opening and existing narrow highlights', [59, 19, 210, 459]],
      ['sphere-pedestal', 'Pale sphere, stacked rounded pedestal and cast shadow', [190, 259, 297, 468]],
      ['recessed-grid', 'Small dark three-by-three wall grid; preserve divisions and perspective', [284, 288, 356, 362]],
      ['central-door', 'Rounded dark doorway, rim and visible floor depth', [359, 238, 470, 422]],
      ['ceiling-right-shell', 'Small ceiling fixture, empty right wall and tiny existing recess', [303, 0, 640, 480]],
    ],
  },
  {
    id: 'Scene2402', hash: '81660220', module: 'module2400.cpp', line: 372,
    inventory: [
      'Cream curved room shell and floor with raised green curling vine-like ornament.',
      'Tall narrow dark left opening with an irregular pale rim.',
      'Bright small high window at upper middle-right with thick pale surround.',
      'Large pale flared column at right, obscuring part of the wall ornament.',
      'Two narrow hanging forms near upper middle and a small red disk in the left green spiral.',
      'No tape, TV, animated door or character; broad floor green pattern is baked into source.',
    ],
    regions: [
      ['left-door', 'Narrow dark left aperture and uneven cream rim', [70, 182, 139, 424]],
      ['spiral-control', 'Green curling ornament and original small red disk', [126, 217, 301, 415]],
      ['high-window', 'Bright high window, irregular pale surround and internal tonal shapes', [351, 104, 463, 252]],
      ['right-column', 'Broad pale column, curved base and overlap with green wall ornament', [368, 0, 580, 449]],
      ['ceiling-floor-pattern', 'Narrow upper hanging forms and lower green floor pattern', [0, 0, 640, 480]],
    ],
  },
];

function main() {
  if (process.argv.length === 3 && process.argv[2] === '--all') return prepareBulkSources();
  assert.equal(process.argv.length, 2, 'No options: this preparation tool is offline and source-only');
  const privateDir = privateRoot(path.join(root, 'private-assets'), root);
  const db = new DatabaseSync(path.join(privateDir, 'catalog.sqlite'), { readOnly: true });
  try {
    const manifestBytes = fs.readFileSync(path.join(privateDir, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.variant, 'english');
    assert.equal(manifest.sourceBinding, db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get().value);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'scummvm'), encoding: 'utf8' }).trim();
    const code = new Map();
    function evidence(file, first, last) {
      if (!code.has(file)) code.set(file, fs.readFileSync(path.join(root, file)));
      const bytes = code.get(file);
      return { path: file, sha256: sha(bytes), lines: [first, last], excerpt: bytes.toString('utf8').split('\n').slice(first - 1, last).join('\n') };
    }
    function blob(hash) {
      const row = db.prepare('SELECT * FROM blobs WHERE sha256=?').get(hash);
      assert(row, `Missing blob ${hash}`);
      const relative = `private-assets/${row.path}`;
      const bytes = fs.readFileSync(path.join(root, relative));
      assert.equal(bytes.length, row.size);
      assert.equal(sha(bytes), hash);
      return { record: { path: relative, sha256: hash, bytes: bytes.length }, bytes };
    }
    const archives = new Map();
    const rooms = selections.map(selection => {
      const requestedHash = parseInt(selection.hash, 16);
      assert(!['Scene1001', 'Scene1002'].includes(selection.id));
      const alias = db.prepare('SELECT * FROM aliases WHERE requested_hash=?').get(requestedHash);
      assert.equal(alias.status, 'resolved');
      const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(alias.resolved_id);
      assert.equal(resource.type, 2);
      assert.equal(resource.status, 'decoded');
      assert.equal(resource.error, null);
      assert.equal(resource.id, alias.requested_id, 'Selections must be direct original resources, not aliases');
      const frame = db.prepare('SELECT * FROM decodedframes WHERE resource_id=?').get(resource.id);
      assert.equal(frame.width, 640); assert.equal(frame.height, 480);
      assert.equal(frame.palette_status, 'known-embedded');
      const palette = db.prepare('SELECT * FROM palettes WHERE id=?').get(frame.palette_id);
      assert.equal(palette.association, 'embedded');
      assert.equal(palette.resource_id, resource.id);
      const archive = db.prepare('SELECT * FROM archives WHERE id=?').get(resource.archive_id);
      const archivePath = `extracted/app/DATA/${archive.name}`;
      if (!archives.has(archive.id)) {
        const parsed = parseArchive(path.join(root, archivePath));
        assert.equal(parsed.sha256, archive.sha256);
        assert.equal(parsed.size, archive.source_size);
        archives.set(archive.id, parsed);
      }
      const entry = archives.get(archive.id).entries[resource.entry_index];
      for (const [a, b] of [['hash', 'hash'], ['type', 'type'], ['compression', 'compression'], ['offset', 'offset'], ['diskSize', 'disk_size'], ['size', 'size'], ['timestamp', 'timestamp']]) assert.equal(entry[a], resource[b]);
      const raw = blob(resource.raw_blob), payload = blob(resource.payload_blob);
      const original = Buffer.alloc(resource.disk_size), fd = fs.openSync(path.join(root, archivePath), 'r');
      try { assert.equal(fs.readSync(fd, original, 0, original.length, resource.offset), original.length); }
      finally { fs.closeSync(fd); }
      assert.deepEqual(original, raw.bytes);
      assert.deepEqual(resource.compression === 3 ? explode(original, resource.size) : original, payload.bytes);
      const decoded = bitmap(payload.bytes);
      const indexed = blob(frame.indexed_blob), pal = blob(palette.blob), image = blob(frame.png_blob);
      assert.deepEqual(decoded.pixels, indexed.bytes);
      assert.deepEqual(decoded.palette, pal.bytes);
      assert.deepEqual(png(decoded.pixels, decoded.width, decoded.height, decoded.palette), image.bytes);
      assert.equal(image.bytes[25], 3, 'Expected indexed PNG');
      const chunks = [];
      for (let at = 8; at < image.bytes.length;) {
        chunks.push(image.bytes.toString('ascii', at + 4, at + 8));
        at += 12 + image.bytes.readUInt32BE(at);
      }
      assert(!chunks.includes('tRNS'), 'No keyed transparency allowed');
      const histogram = Array(256).fill(0);
      for (const index of indexed.bytes) histogram[index]++;
      assert.equal(histogram[0], 0);
      const binding = evidence(`scummvm/engines/neverhood/modules/${selection.module}`, selection.line, selection.line + 1);
      assert(binding.excerpt.includes(`setBackground(0x${selection.hash});`));
      assert(binding.excerpt.includes(`setPalette(0x${selection.hash});`));
      const regions = selection.regions.map(([id, label, box]) => ({ id, label, box: box.map((v, i) => v / (i % 2 ? 480 : 640)) }));
      for (const { box } of regions) assert(box[0] >= 0 && box[1] >= 0 && box[2] <= 1 && box[3] <= 1 && box[0] < box[2] && box[1] < box[3]);
      assert(regions.length >= 4 && regions.length <= 6);
      return {
        id: selection.id, resourceId: `0x${selection.hash}`, sourcePath: image.record.path,
        source: { ...image.record, role: 'source-composition', mimeType: 'image/png', dimensions: [640, 480] },
        provenance: {
          catalogResourceId: resource.id, decodedFrameId: frame.id, catalogSourceBinding: manifest.sourceBinding,
          archive: { path: archivePath, ...archive }, entry: resource, aliasResolution: alias,
          raw: raw.record, payload: payload.record, indexedPixels: indexed.record,
          palette: { ...pal.record, id: palette.id, association: palette.association, resourceId: palette.resource_id,
            binding: `Both setBackground and setPalette request 0x${selection.hash}; PaletteResource loads the bitmap embedded palette, not a guessed scene palette.` },
          decoding: { existingDecoder: 'tools/assets/formats.mjs:38-65,113-121', flags: decoded.flags,
            dimensions: [decoded.width, decoded.height], position: [decoded.x, decoded.y], pngChunks: chunks,
            verification: ['Original archive SHA-256 and entry table match catalog', 'Archive byte range equals raw blob', 'Existing DCL decompression equals payload blob', 'Existing bitmap decoder equals catalog indexed pixels and embedded palette', 'Existing PNG encoder reproduces source PNG byte-for-byte'],
            paletteIndexHistogram: histogram, indexZeroPixels: histogram[0], transparency: 'opaque, no tRNS or alpha; index zero is not keyed and is not used',
            transforms: [], resampled: false, composited: false },
          codeBinding: binding, engineReferenceRevision: revision,
        },
        visualInspection: { method: 'Each original source PNG opened individually with read tool before recording inventories/ROIs; no generated candidates inspected',
          scope: 'Only the original base background bitmap, not a complete gameplay screenshot', confidence: 'high for original base-layer identity, palette binding and opaque decoding' },
        inventory: selection.inventory, regions,
        limitations: ['Separate runtime sprites, foreground layers, characters and state-dependent overlays are intentionally absent and must not be reconstructed from memory.', 'Inventory describes visible shapes, not exhaustive microscopic texture or a claim of gameplay-state completeness.'],
      };
    });
    assert.equal(rooms.length, 10);
    assert.equal(new Set(rooms.map(r => r.source.sha256)).size, 10);
    const document = {
      schemaVersion: 1, purpose: 'source-selection-and-provenance-only', private: true,
      createdAt: new Date().toISOString(), candidatesCreated: false, generationCalls: 0, networkCalls: 0,
      excludedRooms: ['Scene1001', 'Scene1002'],
      selectionScope: '10 distinct original opaque 640x480 (4:3) gameplay-room base backgrounds; not puzzle-panel closeups, foregrounds or sprites',
      annotationsFrozenBeforeCandidates: true,
      regionConvention: { box: '[left, top, right, bottom], normalized to full original image', origin: 'top-left', purpose: 'Source-only geometry/object-preservation checks; no candidate-dependent tuning' },
      catalog: { path: 'private-assets/catalog.sqlite', manifestPath: 'private-assets/manifest.json', manifestSha256: sha(manifestBytes), sourceBinding: manifest.sourceBinding,
        manifestSummary: { errors: manifest.errors, unresolvedPalettes: manifest.unresolvedPalettes, probeErrors: manifest.probeErrors },
        note: 'Catalog-wide unresolved scene palettes and media probe errors do not affect these ten known-embedded bitmap sources; SQLite opened read-only.' },
      sharedEvidence: {
        engineReferenceRevision: revision,
        sceneBackground: evidence('scummvm/engines/neverhood/scene.cpp', 195, 207),
        opaqueSurface: evidence('scummvm/engines/neverhood/background.cpp', 33, 45),
        embeddedPalette: evidence('scummvm/engines/neverhood/resource.cpp', 79, 92),
        paletteUse: evidence('scummvm/engines/neverhood/palette.cpp', 50, 55),
        catalogFrame: evidence('tools/assets/catalog.mjs', 227, 240),
        bitmapDecoder: evidence('tools/assets/formats.mjs', 38, 65),
        opaquePng: evidence('tools/assets/formats.mjs', 113, 121),
      },
      rejectedDuringResearch: [
        { rooms: ['Scene1001', 'Scene1002'], reason: 'Explicitly excluded; already used by historical experiment' },
        { rooms: ['Scene1105', 'Scene3009', 'Scene3011'], reason: 'Puzzle/console closeups, not full room views; Scene3011 also binds a different palette' },
        { rooms: ['Scene1303', 'Scene1304', 'Scene2001', 'Scene2401'], reason: 'Exterior/tower/ledge views omitted in favor of unambiguous interior rooms; Scene2401 also mutates palette' },
        { rooms: ['Scene1004', 'Scene1402', 'Scene1404', 'Scene1705', 'Scene2403'], reason: 'Alternate palettes, palette mutations or shifted/shaking view require extra state-specific proof; not needed for this ten-room selection' },
      ],
      problems: ['These are original base layers, not complete gameplay renders. Runtime foregrounds and moving objects are intentionally excluded.', 'No runtime screenshot comparison performed; authenticity is established by archive bytes, catalog records, code bindings and individual visual inspection.', 'Local archive checksums establish byte provenance, not legal ownership or redistribution rights; keep all media private.'],
      rooms,
    };
    const destination = path.join(root, output);
    assert(fs.existsSync(path.dirname(destination)), 'Private upscaling directory must already exist');
    if (fs.existsSync(destination)) {
      const existing = JSON.parse(fs.readFileSync(destination, 'utf8'));
      document.createdAt = existing.createdAt;
      assert.deepEqual(JSON.parse(JSON.stringify(document)), existing, 'Frozen source selection differs; never overwrite pilot provenance');
    } else {
      const fd = fs.openSync(destination, 'wx', 0o444);
      try { fs.writeFileSync(fd, JSON.stringify(document, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    console.log(JSON.stringify({ path: output, sha256: sha(fs.readFileSync(destination)), rooms: rooms.map(r => ({ id: r.id, resourceId: r.resourceId, sha256: r.source.sha256, regions: r.regions.length })), generationCalls: 0, networkCalls: 0 }, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
