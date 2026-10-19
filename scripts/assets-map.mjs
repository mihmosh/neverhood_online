import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateRoot } from '../tools/assets/catalog.mjs';
import { raster, png, crc32 } from '../tools/assets/formats.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => value.toString(16).padStart(8, '0');
const within = (root, file) => file.startsWith(root + path.sep);

function open(root, repo = project) {
  root = privateRoot(root, repo);
  if (fs.existsSync(path.join(root, '.extract.lock'))) throw new Error('Finish archive extraction before preparing or reviewing replacements.');
  const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  return { root, db };
}

function blob(root, db, sha) {
  const record = db.prepare('SELECT * FROM blobs WHERE sha256=?').get(sha);
  if (!record || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('Missing source blob.');
  const file = path.resolve(root, record.path);
  if (!within(root, file) || fs.statSync(file).size > 64 * 1024 ** 2) throw new Error('Unsafe or oversized source blob.');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== record.size || hash(bytes) !== sha) throw new Error('Source blob integrity failure.');
  return bytes;
}

function store(root, db, bytes) {
  const sha = hash(bytes), relative = `blobs/${sha.slice(0, 2)}/${sha}.png`;
  const existing = db.prepare('SELECT * FROM blobs WHERE sha256=?').get(sha);
  if (existing) { blob(root, db, sha); return sha; }
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination + '.tmp', bytes, { mode: 0o600 });
  fs.renameSync(destination + '.tmp', destination);
  db.prepare('INSERT INTO blobs(sha256,size,path) VALUES(?,?,?)').run(sha, bytes.length, relative);
  return sha;
}

function indexedPNG(pixels, width, height, palette, alpha) {
  const base = png(pixels, width, height, palette);
  if (alpha === 'opaque') return base;
  const table = Buffer.alloc(256, 255); table[alpha] = 0;
  const chunk = Buffer.alloc(268);
  chunk.writeUInt32BE(256); chunk.write('tRNS', 4); table.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  let offset = 8;
  while (offset < base.length && base.toString('ascii', offset + 4, offset + 8) !== 'IDAT') offset += base.readUInt32BE(offset) + 12;
  return Buffer.concat([base.subarray(0, offset), chunk, base.subarray(offset)]);
}

function pngInfo(bytes) {
  if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('Expected a PNG replacement.');
  let offset = 8, count = 0, info, ended = false, data = false, alpha = false;
  while (offset < bytes.length) {
    if (++count > 10000 || offset + 12 > bytes.length) throw new Error('Invalid PNG chunk bounds.');
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('PNG chunk CRC or bounds failure.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (count === 1) {
      if (type !== 'IHDR' || size !== 13) throw new Error('PNG must start with IHDR.');
      info = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12), colorType: bytes[offset + 17] };
      if (bytes[offset + 16] !== 8 || ![2, 3, 6].includes(info.colorType) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) throw new Error('Use an 8-bit RGB, RGBA or indexed PNG for this prototype.');
      alpha = [4, 6].includes(info.colorType);
    } else if (type === 'IHDR') throw new Error('Duplicate PNG header.');
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT') data = true;
    if (type === 'IEND') { if (size || end !== bytes.length) throw new Error('Invalid PNG ending.'); ended = true; }
    offset = end;
  }
  if (!ended || !data) throw new Error('Incomplete PNG replacement.');
  return { ...info, alpha };
}

export function prepareJob({ root, repo, resource, frame = 0, flipX = false, flipY = false, palette, alpha, runtimeKey }) {
  const context = open(root, repo);
  ({ root } = context);
  const { db } = context;
  try {
    if (!/^[a-f0-9]{8}$/i.test(resource || '') || !/^[a-f0-9]{8}$/i.test(palette || '')) throw new Error('Specify resource and scene palette hashes as eight hexadecimal digits.');
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > 65535) throw new Error('Invalid frame index.');
    if (alpha !== 'opaque' && (!Number.isInteger(alpha) || alpha < 0 || alpha > 255)) throw new Error('Explicitly choose opaque or a transparent palette index 0-255.');
    const rows = db.prepare(`SELECT v.*,f.indexed_blob,f.width AS frame_width,f.height AS frame_height,f.frame_index,l.capacity_width,l.capacity_height
      FROM raster_variants v JOIN decodedframes f ON f.id=v.frame_id JOIN logicalframes l ON l.id=v.logical_frame_id
      JOIN aliases a ON a.requested_id=l.requested_id WHERE a.requested_hash=? AND f.frame_index=? AND v.flip_x=? AND v.flip_y=?`).all(parseInt(resource, 16), frame, Number(flipX), Number(flipY));
    const palettes = db.prepare(`SELECT DISTINCT p.blob FROM palettes p JOIN aliases a ON a.resolved_id=p.resource_id WHERE a.requested_hash=? AND a.status='resolved'`).all(parseInt(palette, 16));
    if (palettes.length !== 1) throw new Error(`Expected one scene palette, found ${palettes.length}.`);
    const colors = blob(root, db, palettes[0].blob);
    if (colors.length !== 1024) throw new Error('Expected a 256-entry native palette.');
    const paletteCRC = hex(crc32(colors));
    let choices = rows;
    const contextual = choices.filter(row => row.palette_crc32 === paletteCRC);
    if (contextual.length) choices = contextual;
    if (runtimeKey) choices = choices.filter(row => `${row.width}x${row.height}-${row.pitch}-${row.pixel_crc32}-p${paletteCRC}-${alpha}` === runtimeKey);
    choices = [...new Map(choices.map(row => [`${row.frame_id}:${row.pixel_sha256}:${row.width}:${row.height}:${row.pitch}`, row])).values()];
    if (choices.length !== 1) throw new Error(`Expected one logical/context frame variant, found ${choices.length}. Add an explicit scene association or supply the observed --key; do not guess.`);
    const variant = choices[0], recipe = JSON.parse(variant.recipe_json || '{}');
    const source = raster(blob(root, db, variant.indexed_blob), variant.frame_width, variant.frame_height, recipe.capacityWidth ?? variant.capacity_width, recipe.capacityHeight ?? variant.capacity_height, flipX, flipY);
    if (hash(source.pixels) !== variant.pixel_sha256 || hex(crc32(source.pixels)) !== variant.pixel_crc32) throw new Error('Raster recipe does not match the catalog.');
    if (source.width * source.height * 16 > 16 * 1024 ** 2) throw new Error('4x replacement exceeds the browser prototype pixel limit.');
    const input = indexedPNG(source.pixels, source.width, source.height, colors, alpha);
    const sourcePNG = store(root, db, input);
    const parameters = { version: 1, variant: variant.id, resource: resource.toLowerCase(), frame, flipX, flipY, palette: palettes[0].blob,
      paletteCRC32: paletteCRC, alpha, sourcePNG, width: source.width, height: source.height, scale: 4,
      runtimeKey: `${source.width}x${source.height}-${source.pitch}-${variant.pixel_crc32}-p${paletteCRC}-${alpha}` };
    const id = `hd:${hash(JSON.stringify(parameters))}`;
    const inserted = db.prepare("INSERT OR IGNORE INTO replacementjobs(id,frame_id,source_sha256,status,parameters_json) VALUES(?,?,?,'prepared',?)").run(id, variant.frame_id, variant.pixel_sha256, JSON.stringify(parameters));
    if (inserted.changes) db.prepare('INSERT INTO replacementstatus(job_id,status,detail) VALUES(?,?,?)').run(id, 'prepared', 'Explicit scene palette and transparency; no model has run.');
    const output = path.join(root, db.prepare('SELECT path FROM blobs WHERE sha256=?').get(sourcePNG).path);
    return { id, input: output, targetWidth: source.width * 4, targetHeight: source.height * 4, runtimeKey: parameters.runtimeKey };
  } finally { db.close(); }
}

export function registerOutput({ root, repo, job, file, reviewed = false, model = 'manual-unspecified' }) {
  const context = open(root, repo); ({ root } = context); const { db } = context;
  try {
    const row = db.prepare('SELECT * FROM replacementjobs WHERE id=?').get(job);
    if (!row) throw new Error('Unknown replacement job.');
    const parameters = JSON.parse(row.parameters_json);
    const source = db.prepare('SELECT pixel_sha256 FROM raster_variants WHERE id=?').get(parameters.variant);
    if (!source || source.pixel_sha256 !== row.source_sha256) throw new Error('The source binding changed. Prepare a new job.');
    const info = fs.statSync(file);
    if (!info.isFile() || info.size > 32 * 1024 ** 2) throw new Error('Replacement must be a PNG file up to 32 MiB.');
    const sourcePath = fs.realpathSync(file), repository = fs.realpathSync(repo || project);
    if (within(repository, sourcePath) && !within(root, sourcePath)) throw new Error('Keep replacement images in the private asset directory, not the public source tree.');
    const bytes = fs.readFileSync(file), image = pngInfo(bytes);
    if (image.width !== parameters.width * 4 || image.height !== parameters.height * 4) throw new Error('Replacement dimensions do not match the prepared 4x job.');
    if (parameters.alpha !== 'opaque' && !image.alpha) throw new Error('The output lost its alpha channel. Restore transparency before registering it.');
    const output = store(root, db, bytes), status = reviewed ? 'approved' : 'candidate';
    const next = { ...parameters, model: String(model).slice(0, 500), reviewed: Boolean(reviewed), reviewedAt: reviewed ? new Date().toISOString() : null, alphaReviewRequired: parameters.alpha !== 'opaque' };
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE replacementjobs SET output_blob=?,status=?,parameters_json=? WHERE id=?').run(output, status, JSON.stringify(next), job);
      db.prepare('INSERT INTO replacementstatus(job_id,status,detail) VALUES(?,?,?)').run(job, status, reviewed ? 'Owner explicitly marked visual review complete; no automatic image-quality guarantee.' : 'Candidate only; not enabled in the mapping.');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { id: job, status, sha256: output };
  } finally { db.close(); }
}

export function exportMapping({ root, repo }) {
  const context = open(root, repo); ({ root } = context); const { db } = context;
  try {
    const rows = db.prepare("SELECT * FROM replacementjobs WHERE status='approved' AND output_blob IS NOT NULL ORDER BY id").all();
    const keys = new Set(), entries = [];
    for (const row of rows) {
      const parameters = JSON.parse(row.parameters_json);
      blob(root, db, row.output_blob);
      if (!parameters.reviewed) throw new Error('Approved job has no explicit review record.');
      if (keys.has(parameters.runtimeKey)) throw new Error('Multiple approved outputs target the same runtime raster. Resolve the ambiguity first.');
      keys.add(parameters.runtimeKey);
      entries.push({ key: parameters.runtimeKey, file: db.prepare('SELECT path FROM blobs WHERE sha256=?').get(row.output_blob).path, sha256: row.output_blob, frameId: row.frame_id, sourceSHA256: row.source_sha256, width: parameters.width * 4, height: parameters.height * 4, scale: 4 });
    }
    const manifest = { version: 1, private: true, sourceBinding: db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get()?.value, entries };
    fs.mkdirSync(path.join(root, 'replacements'), { recursive: true, mode: 0o700 });
    const destination = path.join(root, 'replacements/render-map.json');
    fs.writeFileSync(destination + '.tmp', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(destination + '.tmp', destination);
    return { file: destination, entries: entries.length };
  } finally { db.close(); }
}

export function inspectCatalog({ root, repo, resource }) {
  const context = open(root, repo), { db } = context;
  try {
    if (!resource) {
      const counts = {};
      for (const table of ['archives', 'resources', 'aliases', 'decodedframes', 'logicalframes', 'raster_variants', 'palettes', 'media', 'replacementjobs']) counts[table] = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
      return { private: true, counts, paletteNote: 'Embedded palettes are not necessarily the active scene palette. Explicit scene context is required before AI preparation.' };
    }
    if (!/^[a-f0-9]{8}$/i.test(resource)) throw new Error('Use an eight-digit resource hash.');
    return {
      resource: resource.toLowerCase(),
      resolution: db.prepare('SELECT * FROM aliases WHERE requested_hash=?').all(parseInt(resource, 16)),
      frames: db.prepare(`SELECT l.id,f.frame_index,f.width,f.height,f.palette_status,f.png_blob,count(v.id) AS raster_variants
        FROM logicalframes l JOIN aliases a ON a.requested_id=l.requested_id JOIN decodedframes f ON f.id=l.decoded_frame_id
        LEFT JOIN raster_variants v ON v.logical_frame_id=l.id WHERE a.requested_hash=? GROUP BY l.id ORDER BY f.frame_index LIMIT 1000`).all(parseInt(resource, 16)),
    };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2), options = { root: path.join(project, 'private-assets') };
  try {
    for (let i = 0; i < args.length; i++) {
      const name = args[i];
      if (['--flip-x', '--flip-y', '--reviewed'].includes(name)) options[{ '--flip-x': 'flipX', '--flip-y': 'flipY', '--reviewed': 'reviewed' }[name]] = true;
      else {
        const key = { '--root': 'root', '--resource': 'resource', '--frame': 'frame', '--palette': 'palette', '--alpha': 'alpha', '--key': 'runtimeKey', '--job': 'job', '--png': 'file', '--model': 'model' }[name];
        if (!key || args[i + 1] === undefined) throw new Error(`Unknown option or missing value: ${name}`);
        const value = args[++i]; options[key] = ['frame', 'alpha'].includes(key) && value !== 'opaque' ? Number(value) : value;
      }
    }
    const action = { inspect: inspectCatalog, prepare: prepareJob, register: registerOutput, export: exportMapping }[command];
    if (!action) throw new Error('Use inspect, prepare, register or export. Outputs remain private.');
    console.log(JSON.stringify(action(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
