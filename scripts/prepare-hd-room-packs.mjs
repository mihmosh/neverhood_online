import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { bitmap, crc32, raster } from '../tools/assets/formats.mjs';
import { zipSync } from '../web/vendor/fflate-0.8.2.js';
import { validateRoomArchive, ROOM_ARCHIVE_LIMITS } from '../web/prototype/room-archive.js';
import { PACK_LIMITS, validateImageHeader } from '../web/prototype/replacement-pack.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_RUNTIME_SHA256 = '31bdb5fa1afcdf80a6895e2fe5c87a5a999a245af85de7326df20f0756e0d83c';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = n => n.toString(16).padStart(8, '0');
const inside = (base, file) => file === base || file.startsWith(base + sep);
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const roomPattern = /^[A-Za-z][A-Za-z0-9_-]{0,95}$/;

async function regular(file, expected, bytes, limit = 64 * 1024 ** 2) {
  const info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink() && await realpath(file) === file, `Unsafe input: ${file}`);
  assert(info.size > 0 && info.size <= limit, `Input byte limit: ${file}`);
  const data = await readFile(file);
  if (expected !== undefined) assert.equal(sha(data), expected, `SHA256 mismatch: ${file}`);
  if (bytes !== undefined) assert.equal(data.length, bytes, `Byte mismatch: ${file}`);
  return data;
}

// Decode only bounded, noninterlaced 8-bit catalog PNGs, for RGB/alpha proof.
// Replacement bytes are never encoded, resized, padded or recolored here.
export function decodeProofPNG(data) {
  assert(data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Expected PNG');
  let width, height, type, channels, palette, transparency, ended = false;
  const chunks = [];
  for (let at = 8, count = 0; at < data.length;) {
    assert(++count <= 10000 && at + 12 <= data.length, 'PNG chunk bounds');
    const size = data.readUInt32BE(at), end = at + 12 + size;
    assert(end <= data.length && crc32(data.subarray(at + 4, end - 4)) === data.readUInt32BE(end - 4), 'PNG CRC/bounds');
    const name = data.toString('ascii', at + 4, at + 8), body = data.subarray(at + 8, end - 4);
    if (count === 1) {
      assert(name === 'IHDR' && size === 13, 'PNG IHDR');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9];
      assert(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= PACK_LIMITS.pixels, 'PNG pixel limit');
      assert(body[8] === 8 && [2, 3, 6].includes(type) && !body[10] && !body[11] && !body[12], 'Unsupported proof PNG');
      channels = type === 6 ? 4 : type === 2 ? 3 : 1;
    } else assert(name !== 'IHDR', 'Duplicate PNG IHDR');
    if (name === 'PLTE') palette = body;
    if (name === 'tRNS') transparency = body;
    if (name === 'IDAT') chunks.push(body);
    if (name === 'IEND') { assert(size === 0 && end === data.length, 'PNG ending'); ended = true; }
    assert(name !== 'acTL', 'Animated PNG is not a frame');
    at = end;
  }
  assert(ended && chunks.length, 'Incomplete PNG');
  const stride = width * channels, length = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: length });
  assert.equal(raw.length, length, 'PNG scanline size');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert(filter <= 4, 'PNG filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0, c = y && x >= channels ? pixels[at - stride - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const prediction = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[at] = raw[y * (stride + 1) + x + 1] + prediction;
    }
  }
  const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height, 255);
  for (let i = 0; i < width * height; i++) {
    const index = pixels[i], offset = type === 3 ? index * 3 : i * channels;
    const colors = type === 3 ? palette : pixels;
    assert(colors && offset + 3 <= colors.length, 'PNG palette index');
    colors.copy(rgb, i * 3, offset, offset + 3);
    if (type === 6) alpha[i] = pixels[i * 4 + 3];
    if (type === 3 && transparency && index < transparency.length) alpha[i] = transparency[index];
    if (type === 2 && transparency) {
      assert.equal(transparency.length, 6);
      if ([0, 1, 2].every(c => pixels[offset + c] === transparency.readUInt16BE(c * 2))) alpha[i] = 0;
    }
  }
  return { width, height, rgb, alpha };
}

export function sourceKey(source, palette, alpha) {
  assert.equal(source.pixels.length, source.pitch * source.height);
  assert.equal(palette.length, 1024);
  assert(alpha === 'opaque' || alpha === 0);
  return `${source.width}x${source.height}-${source.pitch}-${hex(crc32(source.pixels))}-p${hex(crc32(palette))}-${alpha}`;
}

export function paletteCompatible(indexed, original, room) {
  if (original.length !== 1024 || room.length !== 1024) return false;
  for (const index of new Set(indexed)) {
    if (index && !original.subarray(index * 4, index * 4 + 3).equals(room.subarray(index * 4, index * 4 + 3))) return false;
  }
  return true;
}

export function paletteProof(indexed, palette, transparent = false) {
  const indices = [...new Set(indexed)].filter(index => !transparent || index !== 0).sort((a, b) => a - b);
  const rgb = indices.map(index => palette.subarray(index * 4, index * 4 + 3).toString('hex')).join('');
  return { indices, rgb };
}

export async function prepareRoomArchive(manifest, members) {
  const files = { 'room-pack.json': json(manifest), ...members };
  const estimate = 22 + Object.entries(files).reduce((sum, [file, bytes]) => sum + bytes.length + 76 + Buffer.byteLength(file) * 2, 0);
  assert(estimate <= ROOM_ARCHIVE_LIMITS.bytes, `Room archive byte limit: ${manifest.room} (${estimate} bytes)`);
  assert(files['room-pack.json'].length <= PACK_LIMITS.manifest, 'Room manifest exceeds limit');
  const bytes = zipSync(files, { level: 0, mtime: new Date('2000-01-01T00:00:00Z') });
  assert(bytes.length <= ROOM_ARCHIVE_LIMITS.bytes, 'Room archive byte limit');
  await validateRoomArchive(bytes, { runtimeSHA256: SOURCE_RUNTIME_SHA256, room: manifest.room });
  return bytes;
}

async function mappedArchives(assetMap, root, stage) {
  assert.equal(assetMap.version, 1, 'Unsupported asset map');
  assert.equal(assetMap.runtimeSHA256, SOURCE_RUNTIME_SHA256, 'Asset map runtime mismatch');
  assert(Array.isArray(assetMap.rooms) && assetMap.rooms.length > 0 && assetMap.rooms.length <= 2048, 'Invalid asset map rooms');
  const descriptors = [], files = new Map(), privateDir = resolve(root, 'private-assets');
  for (const room of assetMap.rooms) {
    const pack = room.manifest, members = {};
    assert(roomPattern.test(room.id) && pack.room === room.id && pack.lossless === true, 'Invalid mapped room');
    for (const image of pack.images) {
      const source = assetMap.images[image.id];
      assert(source && source.sha256 === image.sha256 && source.width === image.width && source.height === image.height, 'Missing mapped HD image');
      const path = resolve(root, source.sourceFile);
      assert(inside(privateDir, path), 'Mapped image escapes private assets');
      if (!files.has(image.id)) files.set(image.id, await regular(path, source.sha256, source.bytes, PACK_LIMITS.fileBytes));
      members[image.file] = files.get(image.id);
    }
    const archive = await prepareRoomArchive(pack, members);
    const descriptor = { id: room.id, aliases: room.aliases, backgroundKeys: room.backgroundKeys,
      backgroundBindings: room.backgroundBindings, file: `${room.id}.zip`, sha256: sha(archive), bytes: archive.length, coverage: room.coverage };
    descriptors.push(descriptor);
    if (stage) await writeFile(resolve(stage, 'rooms', descriptor.file), archive, { flag: 'wx', mode: 0o600 });
  }
  return descriptors;
}

export async function packHDAssetMap({ mapping, root = repo, output, write = false } = {}) {
  root = await realpath(resolve(root));
  const privateDir = resolve(root, 'private-assets'), input = resolve(mapping);
  assert(inside(privateDir, input), 'Asset map must remain private');
  const mapBytes = await regular(input, undefined, undefined, 128 * 1024 ** 2), assetMap = JSON.parse(mapBytes);
  let stage;
  if (write) {
    assert(output && output === resolve(output) && inside(privateDir, output) && output !== privateDir, 'Use a new private output directory');
    assert.equal(await realpath(dirname(output)), dirname(output), 'Unsafe output parent');
    try { await lstat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    stage = await mkdtemp(`${output}.preparing-`); await mkdir(resolve(stage, 'rooms'));
  }
  try {
    const rooms = await mappedArchives(assetMap, root, stage);
    const report = { private: true, dryRun: !write, partial: true, assetMapSHA256: sha(mapBytes), rooms,
      selectedSources: assetMap.selectedSources, unapprovedSources: assetMap.unapprovedSources, conflictedSources: assetMap.conflictedSources,
      animation: assetMap.animation, provenance: assetMap.provenance, totalBytes: rooms.reduce((n, r) => n + r.bytes, 0) };
    if (write) {
      await writeFile(resolve(stage, 'asset-map.json'), mapBytes, { flag: 'wx', mode: 0o600 });
      await writeFile(resolve(stage, 'rooms/index.json'), json(report), { flag: 'wx', mode: 0o600 });
      try { await lstat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(stage, output); stage = undefined;
    }
    return report;
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
}

export async function prepareHDRoomPacks({ root = repo, selection, normalized, animations, output, write = false, mapOnly = false } = {}) {
  root = await realpath(resolve(root));
  const privateDir = resolve(root, 'private-assets');
  const release = resolve(privateDir, 'upscaling/full-game-release');
  selection = resolve(selection ?? resolve(release, 'background-selection.json'));
  normalized = resolve(normalized ?? resolve(release, 'runtime-normalized-v1/runtime-manifest.json'));
  animations = resolve(animations ?? resolve(release, 'animation-catalog.json'));
  const privateFile = file => {
    const target = resolve(root, file);
    assert(inside(privateDir, target), `Input must remain private: ${target}`);
    return target;
  };
  let stage;
  if (write || output !== undefined) {
    assert(output && output === resolve(output) && inside(privateDir, output) && output !== privateDir, 'Use an absolute new private output directory');
    assert.equal(await realpath(dirname(output)), dirname(output), 'Unsafe output parent');
    try { await lstat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const selectionBytes = await regular(privateFile(selection));
  const chosen = JSON.parse(selectionBytes), normalizedBytes = await regular(privateFile(normalized));
  const prepared = JSON.parse(normalizedBytes), animationBytes = await regular(privateFile(animations));
  const animation = JSON.parse(animationBytes);
  assert(chosen.private === true && chosen.purpose === 'offline-human-approved-release-selection');
  assert(prepared.private === true && prepared.executed === true && prepared.purpose === 'offline-runtime-normalization');
  assert.equal(prepared.selection.sha256, sha(selectionBytes), 'Normalization selection changed');
  const catalogManifest = JSON.parse(await regular(resolve(privateDir, 'manifest.json')));
  const database = resolve(privateDir, 'catalog.sqlite');
  assert.equal(await realpath(database), database, 'Unsafe catalog path');
  assert((await lstat(database)).isFile(), 'Catalog must be regular');
  const db = new DatabaseSync(database, { readOnly: true });
  const report = { private: true, dryRun: !write, partial: true, rooms: [],
    selectedSources: chosen.selected.length, unapprovedSources: chosen.unapproved.length, conflictedSources: chosen.conflicts.length,
    animation: { complete: false, sourceFrames: animation.resources.reduce((n, r) => n + r.frames.length, 0), includedBindings: 0,
      note: 'Only exact catalog capacity variants and all embedded palette contexts compatible on used nonzero indices; unknown runtime capacities, palettes, vertical flips and uncovered frames remain native.' },
    exclusions: [], provenance: { selectionSHA256: sha(selectionBytes), normalizedSHA256: sha(normalizedBytes), animationSHA256: sha(animationBytes), catalogSourceBinding: catalogManifest.sourceBinding } };
  try {
    assert.equal(db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get().value, catalogManifest.sourceBinding);
    const blob = async hash => {
      const row = db.prepare('SELECT * FROM blobs WHERE sha256=?').get(hash);
      assert(row, `Missing catalog blob ${hash}`);
      return regular(privateFile(resolve(privateDir, row.path)), hash, row.size);
    };
    const paletteFor = async binding => {
      assert.equal(binding.catalogSourceBinding, catalogManifest.sourceBinding, 'Stale source binding');
      const source = db.prepare('SELECT * FROM palettes WHERE resource_id=? AND blob=?').get(binding.palette.resourceId, binding.palette.sha256);
      assert(source, 'Palette is not in the authoritative catalog');
      const result = Buffer.from(await blob(source.blob));
      assert.equal(result.length, 1024);
      for (const op of binding.palette.overrides ?? binding.paletteProofs ?? []) {
        assert.equal(op.catalogSourceBinding, catalogManifest.sourceBinding);
        const palette = db.prepare('SELECT * FROM palettes WHERE resource_id=? AND blob=?').get(op.palette.resourceId, op.palette.sha256);
        assert(palette, 'Override palette is not in catalog');
        assert([op.to, op.from, op.count].every(Number.isSafeInteger) && op.to >= 0 && op.from >= 0 && op.count > 0 && op.to + op.count <= 256 && op.from + op.count <= 256, 'Invalid palette range');
        (await blob(palette.blob)).copy(result, op.to * 4, op.from * 4, (op.from + op.count) * 4);
      }
      assert.equal(sha(result), binding.boundPaletteSha256 ?? binding.palette.finalSha256 ?? binding.palette.sha256, 'Bound palette mismatch');
      return result;
    };
    const selected = new Map(chosen.selected.map(row => [row.sourceSha256, row]));
    assert.equal(selected.size, chosen.selected.length, 'Duplicate selected source');
    const quarantine = new Set([...chosen.unapproved, ...chosen.conflicts].map(row => row.sourceSha256));
    const imageRows = new Map(animation.images.map(row => [row.id, row]));
    const assetMap = { version: 1, private: true, runtimeSHA256: SOURCE_RUNTIME_SHA256,
      provenance: report.provenance, images: {}, originals: [], rooms: [],
      selectedSources: report.selectedSources, unapprovedSources: report.unapprovedSources, conflictedSources: report.conflictedSources,
      animation: report.animation, exclusions: report.exclusions };
    for (const image of animation.images) assetMap.images[image.sha256] = {
      sha256: image.sha256, sourceFile: relative(root, privateFile(image.path)), bytes: image.bytes, width: image.width, height: image.height };
    for (const resource of animation.resources) for (const original of resource.runtimeMappings) {
      const frame = resource.frames.find(frame => frame.sourceFrameId === original.sourceFrameId);
      assetMap.originals.push({ ...original, kind: 'animation', image: imageRows.get(original.imageId).sha256,
        indexedSHA256: frame.source.indexedRaster.sha256, paletteSHA256: frame.source.palette.sha256 });
    }
    const groups = new Map();
    assert.equal(animation.provenance.model.alpha, 'source-index0-binary-nearest4x', 'Unknown animation alpha policy');
    assert.equal(animation.validation.valid, true, 'Animation catalog failed validation');
    for (const resource of animation.resources) for (const frame of resource.frames) {
      const group = groups.get(frame.imageId) ?? { frames: [], contexts: [], variants: [] };
      group.frames.push(frame); groups.set(frame.imageId, group);
    }
    for (const [imageId, group] of groups) {
      let reason;
      for (const frame of group.frames) {
        const original = db.prepare('SELECT * FROM decodedframes WHERE id=?').get(frame.sourceFrameId);
        if (!original || original.indexed_blob !== frame.source?.indexedRaster?.sha256 || original.width !== frame.width || original.height !== frame.height) { reason = 'unknown-original-indexed-raster'; break; }
        const pal = db.prepare('SELECT * FROM palettes WHERE id=?').get(original.palette_id);
        if (!pal || pal.association !== 'embedded' || pal.blob !== frame.source?.palette?.sha256) { reason = 'unknown-embedded-palette'; break; }
        const indexed = await blob(original.indexed_blob), palette = await blob(pal.blob);
        assert.equal(indexed.length, frame.width * frame.height);
        group.contexts.push({ indexed, palette, indices: [...new Set(indexed)], width: frame.width, height: frame.height });
        const variants = db.prepare(`SELECT v.*, a.provenance AS association FROM raster_variants v
          LEFT JOIN frame_associations a ON v.logical_frame_id=a.logical_frame_id
          WHERE v.frame_id=? AND v.flip_y=0 ORDER BY a.provenance IS NULL,v.id`).all(original.id);
        for (const variant of variants) {
          const recipe = JSON.parse(variant.recipe_json);
          const source = raster(indexed, frame.width, frame.height, recipe.capacityWidth, recipe.capacityHeight, !!variant.flip_x, false);
          assert.equal(sha(source.pixels), variant.pixel_sha256, 'Catalog raster recipe mismatch');
          assert.equal(hex(crc32(source.pixels)), variant.pixel_crc32);
          assert.equal(source.width, variant.width); assert.equal(source.height, variant.height); assert.equal(source.pitch, variant.pitch);
           const proof = paletteProof(source.pixels, palette, true);
           group.variants.push({ variant, source, frame, palette, proof, proofId: sha(json(proof)),
             keyPrefix: `${source.width}x${source.height}-${source.pitch}-${variant.pixel_crc32}` });
        }
      }
      if (!reason && !group.variants.length) reason = 'unknown-original-capacity';
      if (!imageRows.has(imageId)) reason = 'missing-existing-output';
      if (reason) { report.exclusions.push({ imageId, frames: group.frames.length, reason }); groups.delete(imageId); }
    }
    if (write) { stage = await mkdtemp(`${output}.preparing-`); await mkdir(resolve(stage, 'rooms')); }
    const usedKeys = new Map(), roomIds = new Set(), checkedImages = new Map();
    for (const artifact of prepared.artifacts) {
      const approved = selected.get(artifact.sourceSha256);
      assert(approved && !quarantine.has(artifact.sourceSha256), 'Unselected/quarantined normalized artifact');
      assert.equal(artifact.artifactId, approved.artifactId);
      assert.deepEqual(artifact.aliases, approved.aliases, 'Normalized aliases changed');
      assert.deepEqual(artifact.identities, approved.identities, 'Normalized bindings changed');
      assert(approved.approvalEvidence.length && approved.candidateIdentities.every(i => i.sourceSha256 === approved.sourceSha256 && i.outputSha256 === approved.output.sha256), 'Missing exact approval evidence');
      const sourcePNG = decodeProofPNG(await regular(privateFile(approved.source.path), approved.source.sha256));
      await regular(privateFile(approved.output.path), approved.output.sha256);
      const id = approved.aliases[0];
      assert(roomPattern.test(id) && !roomIds.has(id), 'Invalid/duplicate exact source room ID'); roomIds.add(id);
      const manifests = [], roomPalettes = [];
      for (const identity of approved.identities) {
        const binding = identity.sourceBinding;
        const frame = db.prepare('SELECT * FROM decodedframes WHERE id=?').get(binding.decodedFrameId);
        assert(frame && frame.resource_id === binding.catalogResourceId && frame.indexed_blob === binding.indexedPixels.sha256, 'Background frame binding mismatch');
        assert.deepEqual([frame.width, frame.height], [sourcePNG.width, sourcePNG.height]);
        const pixels = await blob(frame.indexed_blob), palette = await paletteFor(binding);
        const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(frame.resource_id);
        const decoded = bitmap(await blob(resource.payload_blob));
        assert(decoded.pixels.equals(pixels) && decoded.width === frame.width && decoded.height === frame.height, 'Original bitmap decode mismatch');
        const rgb = Buffer.alloc(pixels.length * 3);
        for (let i = 0; i < pixels.length; i++) palette.copy(rgb, i * 3, pixels[i] * 4, pixels[i] * 4 + 3);
        assert.equal(sha(rgb), sha(sourcePNG.rgb), 'Selected source RGB differs from exact indexed/palette context');
        assert(sourcePNG.alpha.every(a => a === 255), 'Background must remain opaque');
        for (const original of binding.bindingOriginals ?? []) {
          const digest = original.alias?.rgbPixelSha256;
          if (digest) assert.equal(sha(rgb), digest, 'Catalog source RGB digest mismatch');
        }
         manifests.push({ key: sourceKey(raster(pixels, frame.width, frame.height, frame.width, frame.height), palette, 'opaque'), frame, binding,
           proof: paletteProof(pixels, palette) });
        roomPalettes.push(palette);
      }
      assert(manifests.length, 'Missing raw source binding');
      const backgroundKeys = [...new Set(manifests.map(m => m.key))];
      for (const key of backgroundKeys) { assert(!usedKeys.has(key), `Duplicate room trigger: ${id}/${usedKeys.get(key)}`); usedKeys.set(key, id); }
      assert.equal(backgroundKeys.length, 1, 'Ambiguous background contexts must not be guessed');
      const imageBytes = await regular(privateFile(resolve(dirname(normalized), artifact.runtime.path)), artifact.runtime.sha256, undefined, PACK_LIMITS.fileBytes);
      const width = sourcePNG.width * 4, height = sourcePNG.height * 4;
      assert.deepEqual(artifact.runtime.dimensions, [width, height]);
      if (artifact.runtime.mode === 'RGB' && artifact.runtime.opaque === true && imageBytes[25] === 2) {
        validateImageHeader(imageBytes, { format: 'png', width, height });
      } else {
        const backgroundImage = decodeProofPNG(imageBytes);
        assert(backgroundImage.width === width && backgroundImage.height === height && backgroundImage.alpha.every(a => a === 255), 'Normalized background dimensions/opacity');
      }
      const imageId = sha(imageBytes), file = `images/${imageId}.png`;
      const pack = { version: 2, private: true, lossless: true, scale: 4, room: id, runtimeSHA256: SOURCE_RUNTIME_SHA256,
        sourceRuntimeSHA256: SOURCE_RUNTIME_SHA256, sourceBinding: { ...report.provenance, artifactId: artifact.artifactId,
          identities: approved.identities.map(i => ({ id: i.id, catalogResourceId: i.sourceBinding.catalogResourceId, decodedFrameId: i.sourceBinding.decodedFrameId, paletteSHA256: i.sourceBinding.boundPaletteSha256 ?? i.sourceBinding.palette.finalSha256 ?? i.sourceBinding.palette.sha256 })) },
        images: [{ id: imageId, file, format: 'png', sha256: imageId, width, height }], entries: [], backgrounds: [], paletteProofs: {} };
      const addProof = (proof, id = sha(json(proof))) => { pack.paletteProofs[id] = proof; return id; };
      assetMap.images[imageId] = { sha256: imageId, sourceFile: relative(root, privateFile(resolve(dirname(normalized), artifact.runtime.path))),
        bytes: imageBytes.length, width, height };
      assetMap.originals.push({ kind: 'background', room: id, resource: manifests[0].frame.resource_id,
        frameId: manifests[0].frame.id, indexedSHA256: manifests[0].binding.indexedPixels.sha256, image: imageId,
        approvalEvidence: approved.approvalEvidence });
      const members = { [file]: imageBytes };
      const background = { key: backgroundKeys[0], scale: 4, width, height, image: imageId, crop: { x: 0, y: 0, width, height }, flipX: false,
        paletteProof: addProof(manifests[0].proof), resource: manifests[0].frame.resource_id,
        frameId: manifests[0].frame.id, sourceSHA256: manifests[0].binding.indexedPixels.sha256 };
      if (width === 2560 && height === 1920) pack.backgrounds.push({ ...background, id: 'gemini', label: 'Approved Gemini background' });
      else pack.entries.push({ ...background, kind: 'layer', resource: manifests[0].frame.resource_id, frameId: manifests[0].frame.id, sourceSHA256: manifests[0].binding.indexedPixels.sha256 });
      const entryKeys = new Set(pack.entries.map(entry => entry.key));
      const paletteKeys = roomPalettes.map(palette => hex(crc32(palette)));
      const coverage = { complete: false, includedFrames: 0, includedBindings: 0, paletteExcludedFrames: 0, capacityExcludedBindings: 0, budgetExcludedBindings: 0 };
      let encoded = imageBytes.length;
      for (const [candidateId, group] of groups) {
        if (!roomPalettes.every(pal => group.contexts.every(c => c.indices.every(index => !index ||
          [0, 1, 2].every(channel => c.palette[index * 4 + channel] === pal[index * 4 + channel]))))) { coverage.paletteExcludedFrames += group.frames.length; continue; }
        const image = imageRows.get(candidateId);
        if (!checkedImages.has(candidateId)) {
          const bytes = await regular(privateFile(image.path), image.sha256, image.bytes, PACK_LIMITS.fileBytes);
          validateImageHeader(bytes, { format: 'png', width: image.width, height: image.height });
          for (const context of group.contexts) assert(image.width === context.width * 4 && image.height === context.height * 4, 'Animation output dimensions mismatch');
          if (!(image.validation === 'verified' && image.savedOutput?.sha256 === image.sha256 && image.savedOutput?.bytes === image.bytes)) {
            const decoded = decodeProofPNG(bytes);
            for (const context of group.contexts) for (let y = 0; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
              assert.equal(decoded.alpha[y * decoded.width + x], context.indexed[(y >> 2) * context.width + (x >> 2)] === 0 ? 0 : 255, 'Animation alpha is not original index0 nearest4x');
            }
          }
          checkedImages.set(candidateId, { bytes, image: { id: image.sha256, file: `images/${image.sha256}.png`, format: 'png', sha256: image.sha256, width: image.width, height: image.height } });
        }
        const checked = checkedImages.get(candidateId);
        let included = false;
        for (const { variant, source, frame, proof, proofId, keyPrefix } of group.variants) {
          if (source.width * 4 > PACK_LIMITS.dimension || source.height * 4 > PACK_LIMITS.dimension || source.width * source.height * 16 > PACK_LIMITS.pixels || image.width > source.width * 4 || image.height > source.height * 4) { coverage.capacityExcludedBindings++; continue; }
          for (const paletteKey of paletteKeys) {
            const key = `${keyPrefix}-p${paletteKey}-0`;
            if (entryKeys.has(key)) continue;
            const additional = members[checked.image.file] ? 0 : checked.bytes.length;
            // Leave bounded space for JSON and ZIP directory overhead, never split a room.
            if (encoded + additional > ROOM_ARCHIVE_LIMITS.bytes - PACK_LIMITS.manifest - 2 * 1024 ** 2 || pack.entries.length >= PACK_LIMITS.entries - 1 || pack.images.length >= PACK_LIMITS.files - 2) { coverage.budgetExcludedBindings++; continue; }
            if (!members[checked.image.file]) { members[checked.image.file] = checked.bytes; pack.images.push(checked.image); encoded += additional; }
            pack.entries.push({ key, kind: 'sprite', scale: 4, width: source.width * 4, height: source.height * 4,
               image: checked.image.id, crop: { x: 0, y: 0, width: image.width, height: image.height }, flipX: !!variant.flip_x,
               paletteProof: addProof(proof, proofId),
               resource: String(frame.requestedHash), frameId: frame.sourceFrameId, sourceSHA256: variant.pixel_sha256 });
            entryKeys.add(key);
            included = true; coverage.includedBindings++;
          }
        }
        if (included) coverage.includedFrames += group.frames.length;
      }
      coverage.missingFrames = report.animation.sourceFrames - coverage.includedFrames;
      pack.coverage = coverage;
      assetMap.rooms.push({ id, aliases: approved.aliases, backgroundKeys, coverage, manifest: pack,
        backgroundBindings: manifests.map(m => ({ key: m.key, palette: m.proof })) });
      report.animation.includedBindings += coverage.includedBindings;
    }
    assert.equal(assetMap.rooms.length, chosen.selected.length, 'Missing selected normalized backgrounds');
    const mapBytes = json(assetMap);
    report.assetMapSHA256 = sha(mapBytes);
    if (mapOnly) {
      report.rooms = assetMap.rooms.map(({ manifest, ...room }) => room);
      report.mappingOnly = true;
    } else report.rooms = await mappedArchives(assetMap, root, write ? stage : undefined);
    report.totalBytes = report.rooms.reduce((sum, room) => sum + (room.bytes ?? 0), 0);
    if (write) {
      await writeFile(resolve(stage, 'asset-map.json'), mapBytes, { flag: 'wx', mode: 0o600 });
      await writeFile(resolve(stage, '.private-assets-no-public'), 'Private game-derived room packs. Not for public distribution without permission.\n', { flag: 'wx', mode: 0o600 });
      await writeFile(resolve(stage, 'rooms/index.json'), json(report), { flag: 'wx', mode: 0o600 });
      try { await lstat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(stage, output); stage = undefined;
    }
    return report;
  } finally { db.close(); if (stage) await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  try {
    assert(!(process.argv.includes('--write') && process.argv.includes('--dry-run')), 'Choose --write or --dry-run');
    for (let i = 2; i < process.argv.length; i++) {
      const key = process.argv[i];
      if (key === '--write') options.write = true;
      else if (key === '--map-only') options.mapOnly = true;
      else if (key === '--summary') options.summary = true;
      else if (key === '--dry-run') { assert(options.write !== true, 'Choose --write or --dry-run'); options.write = false; }
      else {
        const name = { '--selection': 'selection', '--normalized': 'normalized', '--animations': 'animations', '--output': 'output', '--mapping': 'mapping', '--lookup': 'lookup' }[key];
        assert(name && process.argv[i + 1], 'Usage: prepare-hd-room-packs.mjs [--dry-run | --write --output NEW_PRIVATE_DIR] [--selection JSON --normalized JSON --animations JSON]');
        options[name] = name === 'lookup' ? process.argv[++i] : resolve(process.argv[++i]);
      }
    }
    if (options.lookup) {
      assert(options.mapping && !options.write && /^[a-f0-9]{8}$/.test(options.lookup), 'Use --mapping JSON --lookup PIXEL_CRC32 without --write');
      const assetMap = JSON.parse(await regular(options.mapping, undefined, undefined, 128 * 1024 ** 2));
      const rows = assetMap.rooms.flatMap(room => [...room.manifest.backgrounds, ...room.manifest.entries]
        .filter(entry => entry.key.split('-')[2] === options.lookup).map(entry => ({ room: room.id, originalKey: entry.key,
          resource: entry.resource, frameId: entry.frameId, sourceSHA256: entry.sourceSHA256, hdImage: entry.image,
          palette: room.manifest.paletteProofs?.[entry.paletteProof] })));
      console.log(JSON.stringify(rows, null, 2));
    } else {
    const result = await (options.mapping ? packHDAssetMap(options) : prepareHDRoomPacks(options));
    console.log(JSON.stringify(options.summary ? { rooms: result.rooms.length, originalBindings: result.animation.includedBindings,
      assetMapSHA256: result.assetMapSHA256, totalBytes: result.totalBytes, mappingOnly: result.mappingOnly === true } : result, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
