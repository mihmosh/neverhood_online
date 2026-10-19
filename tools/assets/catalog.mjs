import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { explode } from './dcl.mjs';
import { animation, bitmap, png, range, crc32, raster, TYPE_NAMES } from './formats.mjs';

export const MARKER = '.private-assets-no-public';
export const MARKER_CONTENT = 'verification_noZippublic\nPRIVATE Neverhood game media. Never publish, upload, or package.\n';
export const ARCHIVES = ['a.blb', 'c.blb', 'hd.blb', 'i.blb', 'm.blb', 's.blb', 't.blb'];
const sha = data => createHash('sha256').update(data).digest('hex');
const hex = n => n.toString(16).padStart(8, '0');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
function upsert(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  return db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(${columns[0]}) DO UPDATE SET ${columns.slice(1).map(column => `${column}=excluded.${column}`).join(',')}`);
}

export function privateRoot(output, repo, initialize = false) {
  repo = fs.realpathSync(repo);
  output = path.resolve(output);
  // Resolve every existing ancestor before creating anything (including symlink targets).
  let ancestor = output;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonical = path.join(fs.realpathSync(ancestor), path.relative(ancestor, output));
  const approved = path.join(repo, 'private-assets');
  if (inside(repo, output) && !inside(approved, canonical)) throw new Error('Repository output may not escape private-assets through a symlink');
  if (inside(repo, canonical) && !inside(approved, canonical)) throw new Error('Output inside repository must be under private-assets');
  if (canonical.split(path.sep).some(p => /^(web|public|build|dist|src|docs|scummvm)$/i.test(p)))
    throw new Error('Refusing public, source, or build output path');
  for (let parent = canonical; parent !== path.dirname(parent); parent = path.dirname(parent))
    if (fs.existsSync(path.join(parent, '.git')) && !inside(approved, canonical)) throw new Error('Custom output must be outside source repositories');
  if (canonical === path.parse(canonical).root || canonical === repo) throw new Error('Unsafe output root');
  if (initialize) {
    if (fs.existsSync(canonical) && fs.readdirSync(canonical).length && !fs.existsSync(path.join(canonical, MARKER)))
      throw new Error('Refusing to initialize nonempty unmarked directory');
    fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
    const marker = path.join(canonical, MARKER);
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, MARKER_CONTENT, { flag: 'wx', mode: 0o600 });
  }
  const marker = path.join(canonical, MARKER);
  if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== MARKER_CONTENT)
    throw new Error(`Private marker required: run with --init-private (${MARKER})`);
  // Reject nested symlinks before any write; content addressing never follows a substituted blob path.
  function check(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error(`Symlink forbidden in output: ${path.join(dir, item.name)}`);
      if (item.isDirectory()) check(path.join(dir, item.name));
    }
  }
  check(canonical);
  return canonical;
}

function readAt(fd, offset, length) {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, out, done, length - done, offset + done);
    if (!n) throw new Error(`Unexpected EOF at ${offset + done}`);
    done += n;
  }
  return out;
}
function hashRange(fd, offset, length) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, length)));
  for (let n = 0; n < length;) {
    const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - n), offset + n);
    if (!count) throw new Error('Truncated source while hashing');
    hash.update(buffer.subarray(0, count)); n += count;
  }
  return hash.digest('hex');
}
function acquireLock(output) {
  const lock = path.join(output, '.extract.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid extraction lock; inspect it before removing');
    try { process.kill(pid, 0); throw new Error(`Extraction lock held by process ${pid}`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeSync(fd, `${process.pid}\n`);
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
function storeBuffer(db, output, data, extension = 'bin') {
  const hash = sha(data), relative = `blobs/${hash.slice(0, 2)}/${hash}.${extension}`, target = path.join(output, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let valid = false;
  if (fs.existsSync(target) && fs.statSync(target).size === data.length) {
    const fd = fs.openSync(target, 'r');
    try { valid = hashRange(fd, 0, data.length) === hash; } finally { fs.closeSync(fd); }
  }
  if (!valid) { fs.writeFileSync(target + '.tmp', data, { mode: 0o600 }); fs.renameSync(target + '.tmp', target); }
  db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?,?)').run(hash, data.length, relative);
  return hash;
}
function writeIndex(db, output) {
  const tables = ['archives', 'archive_indexes', 'resources', 'aliases', 'blobs', 'palettes', 'decodedframes', 'logicalframes', 'raster_variants', 'frame_associations', 'media', 'replacementjobs', 'replacementstatus', 'catalogmeta'];
  const index = fs.openSync(path.join(output, 'index.jsonl.tmp'), 'w', 0o600);
  try {
    for (const table of tables) for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1`).iterate())
      fs.writeSync(index, JSON.stringify({ table, ...row }) + '\n');
  } finally { fs.closeSync(index); }
  fs.renameSync(path.join(output, 'index.jsonl.tmp'), path.join(output, 'index.jsonl'));
}
export function parseArchive(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, h = readAt(fd, 0, 16);
    const count = h.readUInt32LE(12), extSize = h.readUInt16LE(6);
    if (h.readUInt32LE(0) !== 0x02004940 || h.readUInt16LE(4) !== 7 || h.readUInt32LE(8) !== size)
      throw new Error(`Invalid BLB header: ${file}`);
    const tableSize = count * 24 + extSize;
    if (tableSize > size - 16 || tableSize > 64 * 1024 * 1024) throw new Error('Invalid BLB table size');
    const table = readAt(fd, 16, tableSize), ext = table.subarray(count * 24);
    const entries = [];
    for (let index = 0; index < count; index++) {
      const at = count * 4 + index * 20;
      const e = { index, hash: table.readUInt32LE(index * 4), type: table[at], compression: table[at + 1],
        extOffset: table.readUInt16LE(at + 2), timestamp: table.readUInt32LE(at + 4), offset: table.readUInt32LE(at + 8),
        diskSize: table.readUInt32LE(at + 12), size: table.readUInt32LE(at + 16) };
      if (e.extOffset > extSize) throw new Error(`Invalid extData pointer ${index}`);
      if (e.compression !== 0x65 && (e.offset < 16 + tableSize || e.offset + e.diskSize > size))
        throw new Error(`Invalid BLB entry bounds ${index}`);
      entries.push(e);
    }
    return { file, size, sha256: hashRange(fd, 0, size), entries, ext, index: Buffer.concat([h, table]) };
  } finally { fs.closeSync(fd); }
}

export function resolveAlias(requested, lookup) {
  const seen = new Set(), chain = [];
  let current = requested;
  while (current) {
    if (seen.has(current.id)) return { error: 'alias-cycle', chain };
    seen.add(current.id); chain.push(current.id);
    if (current.compression !== 0x65) return { resolved: current, chain };
    current = lookup(current.diskSize);
  }
  return { error: 'alias-target-missing', chain };
}

const SCHEMA = `
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS archives(id TEXT PRIMARY KEY,name TEXT NOT NULL,sha256 TEXT NOT NULL,source_size INTEGER NOT NULL,ext_blob TEXT,load_order INTEGER NOT NULL,variant TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY,size INTEGER NOT NULL,path TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS archive_indexes(archive_id TEXT PRIMARY KEY REFERENCES archives(id),index_blob TEXT NOT NULL REFERENCES blobs(sha256));
CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,archive_id TEXT NOT NULL REFERENCES archives(id),entry_index INTEGER NOT NULL,hash INTEGER NOT NULL,type INTEGER NOT NULL,compression INTEGER NOT NULL,timestamp INTEGER NOT NULL,offset INTEGER NOT NULL,disk_size INTEGER NOT NULL,size INTEGER NOT NULL,ext_offset INTEGER NOT NULL,raw_blob TEXT,payload_blob TEXT,format TEXT,status TEXT NOT NULL,error TEXT,UNIQUE(archive_id,entry_index));
CREATE INDEX IF NOT EXISTS resource_hash ON resources(hash,timestamp);
CREATE TABLE IF NOT EXISTS aliases(requested_id TEXT PRIMARY KEY REFERENCES resources(id),requested_hash INTEGER NOT NULL,resolved_id TEXT REFERENCES resources(id),original_ext_offset INTEGER NOT NULL,chain_json TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
CREATE TABLE IF NOT EXISTS palettes(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),blob TEXT NOT NULL REFERENCES blobs(sha256),association TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decodedframes(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),requested_hash INTEGER NOT NULL,resolved_hash INTEGER NOT NULL,list_index INTEGER NOT NULL,frame_index INTEGER NOT NULL,frame_hash INTEGER,width INTEGER NOT NULL,height INTEGER NOT NULL,indexed_blob TEXT NOT NULL REFERENCES blobs(sha256),palette_id TEXT REFERENCES palettes(id),png_blob TEXT,palette_status TEXT NOT NULL,metadata_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS frames_resource ON decodedframes(resource_id);
CREATE TABLE IF NOT EXISTS media(resource_id TEXT PRIMARY KEY REFERENCES resources(id),format TEXT NOT NULL,probe_json TEXT,probe_error TEXT);
CREATE TABLE IF NOT EXISTS replacementjobs(id TEXT PRIMARY KEY,frame_id TEXT REFERENCES decodedframes(id),resource_id TEXT REFERENCES resources(id),source_sha256 TEXT NOT NULL,output_blob TEXT REFERENCES blobs(sha256),status TEXT NOT NULL DEFAULT 'pending',parameters_json TEXT NOT NULL DEFAULT '{}',CHECK(frame_id IS NOT NULL OR resource_id IS NOT NULL));
CREATE TABLE IF NOT EXISTS replacementstatus(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL REFERENCES replacementjobs(id),status TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,detail TEXT);
CREATE TABLE IF NOT EXISTS catalogmeta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logicalframes(id TEXT PRIMARY KEY,requested_id TEXT NOT NULL REFERENCES resources(id),resolved_id TEXT NOT NULL REFERENCES resources(id),decoded_frame_id TEXT NOT NULL REFERENCES decodedframes(id),capacity_width INTEGER NOT NULL,capacity_height INTEGER NOT NULL,ext_blob TEXT,ext_offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS raster_variants(id TEXT PRIMARY KEY,logical_frame_id TEXT NOT NULL REFERENCES logicalframes(id),frame_id TEXT NOT NULL REFERENCES decodedframes(id),width INTEGER NOT NULL,height INTEGER NOT NULL,pitch INTEGER NOT NULL,flip_x INTEGER NOT NULL,flip_y INTEGER NOT NULL,pixel_crc32 TEXT NOT NULL,palette_crc32 TEXT,pixel_sha256 TEXT NOT NULL,recipe_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS frame_associations(id TEXT PRIMARY KEY,logical_frame_id TEXT NOT NULL REFERENCES logicalframes(id),palette_id TEXT REFERENCES palettes(id),png_blob TEXT REFERENCES blobs(sha256),provenance TEXT NOT NULL,metadata_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS logical_decoded_frame ON logicalframes(decoded_frame_id);
CREATE INDEX IF NOT EXISTS logical_requested ON logicalframes(requested_id);
CREATE INDEX IF NOT EXISTS logical_resolved ON logicalframes(resolved_id);
CREATE INDEX IF NOT EXISTS raster_frame ON raster_variants(frame_id);
CREATE INDEX IF NOT EXISTS raster_logical_frame ON raster_variants(logical_frame_id);
CREATE INDEX IF NOT EXISTS palette_resource ON palettes(resource_id);
CREATE INDEX IF NOT EXISTS association_logical_frame ON frame_associations(logical_frame_id);
`;

export function extract({ input, output, repo, initialize = false, variant = 'english', maxResource = 64 * 1024 * 1024, probe = true }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(variant)) throw new Error('Invalid game variant');
  output = privateRoot(output, repo, initialize);
  const releaseLock = acquireLock(output);
  let db;
  const summary = { schemaVersion: 1, variant, sourceBytes: 0, archives: 0, physicalEntries: 0, aliases: 0, payloads: 0,
    frames: 0, pngs: 0, unresolvedPalettes: 0, errors: 0, byType: {}, failures: [], startedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.join(output, 'blobs'), { recursive: true });
    db = new DatabaseSync(path.join(output, 'catalog.sqlite'));
    db.exec(SCHEMA);
    const sourceChecksums = ARCHIVES.map(name => {
      const file = path.join(input, name), fd = fs.openSync(file, 'r');
      try { return { name, sha256: hashRange(fd, 0, fs.fstatSync(fd).size) }; } finally { fs.closeSync(fd); }
    });
    const binding = sha(JSON.stringify({ variant, sourceChecksums }));
    const previousBinding = db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get();
    if (previousBinding && previousBinding.value !== binding) throw new Error('Output catalog belongs to different source archives/variant; use a separate private output directory');
    db.prepare('INSERT OR IGNORE INTO catalogmeta VALUES(?,?)').run('source-binding', binding);
    summary.sourceBinding = binding;
    const insertBlob = db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?,?)');
    const store = (data, extension) => storeBuffer(db, output, data, extension);
    function storeRange(fd, offset, size, extension = 'bin') {
      const hash = hashRange(fd, offset, size), relative = `blobs/${hash.slice(0, 2)}/${hash}.${extension}`, target = path.join(output, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let valid = false;
      if (fs.existsSync(target) && fs.statSync(target).size === size) {
        const existing = fs.openSync(target, 'r');
        try { valid = hashRange(existing, 0, size) === hash; } finally { fs.closeSync(existing); }
      }
      if (!valid) {
        const dest = fs.openSync(target + '.tmp', 'w', 0o600), buffer = Buffer.alloc(1024 * 1024);
        try {
          for (let n = 0; n < size;) {
            const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - n), offset + n);
            if (!count) throw new Error('Truncated resource');
            let done = 0;
            while (done < count) done += fs.writeSync(dest, buffer, done, count - done);
            n += count;
          }
        } finally { fs.closeSync(dest); }
        fs.renameSync(target + '.tmp', target);
      }
      insertBlob.run(hash, size, relative);
      return hash;
    }
    const blobPath = hash => path.join(output, db.prepare('SELECT path FROM blobs WHERE sha256=?').get(hash).path);
    const paletteInsert = upsert(db, 'palettes');
    const frameInsert = upsert(db, 'decodedframes');
    const resourceInsert = upsert(db, 'resources');
    const archiveInsert = upsert(db, 'archives');
    const indexInsert = upsert(db, 'archive_indexes');
    const mediaInsert = upsert(db, 'media');
    function saveFrame(e, frame, index, listIndex = 0, requestedHash = e.hash) {
      const { pixels, palette, ...metadata } = frame;
      let paletteId = null, pngBlob = null;
      if (palette) {
        const paletteBlob = store(palette, 'pal');
        paletteId = `${e.id}:palette:${paletteBlob}`;
        paletteInsert.run(paletteId, e.id, paletteBlob, 'embedded');
      }
      const indexed = store(pixels, 'idx');
      if (palette) { pngBlob = store(png(pixels, frame.width, frame.height, palette), 'png'); summary.pngs++; }
      else summary.unresolvedPalettes++;
      const id = `${e.id}:requested:${hex(requestedHash)}:resolved:${hex(e.hash)}:list:${listIndex}:frame:${index}`;
      frameInsert.run(id, e.id, requestedHash, e.hash, listIndex, index, frame.frameHash ?? null, frame.width, frame.height, indexed,
        paletteId, pngBlob, palette ? 'known-embedded' : 'unresolved-scene-palette', JSON.stringify(metadata));
      summary.frames++;
    }
    // Metadata is read one archive at a time; payloads are range-read and never retained across entries.
    for (let order = 0; order < ARCHIVES.length; order++) {
      const archive = parseArchive(path.join(input, ARCHIVES[order]));
      const archiveId = `${variant}:${archive.sha256}`;
      summary.archives++; summary.sourceBytes += archive.size;
      db.exec('BEGIN');
      const extBlob = store(archive.ext, 'ext');
      archiveInsert.run(archiveId, ARCHIVES[order], archive.sha256, archive.size, extBlob, order, variant);
      indexInsert.run(archiveId, store(archive.index, 'blbindex'));
      const fd = fs.openSync(archive.file, 'r');
      try {
        for (const e of archive.entries) {
          e.id = `${archiveId}:entry:${e.index}:${hex(e.hash)}`;
          summary.physicalEntries++;
          const type = TYPE_NAMES[e.type] ?? `unknown-${e.type}`;
          summary.byType[type] = (summary.byType[type] ?? 0) + 1;
          let raw = null, payload = null, format = type, error = null, status = 'pending';
          // Alias diskSize is a resource hash, not a byte count. The exact record and ext table are retained in the catalog.
          try {
            if (e.compression === 0x65) { status = 'alias'; summary.aliases++; }
            else {
              const magic = e.diskSize >= 4 ? readAt(fd, e.offset, 4).toString('ascii') : '';
              const extension = /^SMK[24]$/.test(magic) ? 'smk' : e.type === 7 ? 'nhsound' : e.type === 8 ? 'nhmusic' : 'bin';
              raw = storeRange(fd, e.offset, e.diskSize, extension);
              if (e.compression === 1) payload = raw;
              else if (e.compression === 3) {
                if (e.diskSize > maxResource) throw new Error('Compressed input exceeds resource memory limit');
                payload = store(explode(readAt(fd, e.offset, e.diskSize), e.size, maxResource));
              } else throw new Error(`Unsupported compression ${e.compression}`);
              summary.payloads++; status = 'payload-exported';
            }
          } catch (err) { error = err.message; status = 'extract-error'; }
          resourceInsert.run(e.id, archiveId, e.index, e.hash, e.type,
            e.compression, e.timestamp, e.offset, e.diskSize, e.size, e.extOffset, raw, payload, format, status, error);
          if (payload) {
            try {
              if ([2, 3, 4].includes(e.type)) {
                const file = blobPath(payload), size = fs.statSync(file).size;
                if (size > maxResource) throw new Error('Decoded payload exceeds resource memory limit');
                const data = fs.readFileSync(file);
                // English archives are decoded verbatim; Russian Fargus size patches are deliberately not applied.
                if (e.type === 2) {
                  const frame = bitmap(data);
                  if (frame.palette) {
                    const palBlob = store(frame.palette, 'pal');
                    paletteInsert.run(`${e.id}:palette:${palBlob}`, e.id, palBlob, 'embedded');
                  }
                  if (frame.pixels) saveFrame(e, frame, 0);
                } else if (e.type === 3) {
                  const palBlob = store(range(data, 0, 1024), 'pal');
                  paletteInsert.run(`${e.id}:palette:${palBlob}`, e.id, palBlob, 'standalone');
                } else {
                  for (const frame of animation(data)) saveFrame(e, frame, frame.frameIndex, frame.listIndex, frame.requestedHash);
                }
                status = 'decoded';
              } else if ([7, 8, 10].includes(e.type)) {
                const file = blobPath(payload), mediaFd = fs.openSync(file, 'r');
                let magic;
                try { magic = fs.statSync(file).size >= 4 ? readAt(mediaFd, 0, 4).toString('ascii') : ''; } finally { fs.closeSync(mediaFd); }
                format = /^SMK[24]$/.test(magic) ? 'smacker' : TYPE_NAMES[e.type];
                let result = null, probeError = null;
                const prior = db.prepare('SELECT * FROM media WHERE resource_id=?').get(e.id);
                if (prior) { result = prior.probe_json; probeError = prior.probe_error; }
                else if (probe) {
                  const p = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
                  if (p.status === 0) result = p.stdout;
                  else probeError = p.error?.message ?? p.stderr.trim();
                }
                mediaInsert.run(e.id, format, result, probeError);
              }
            } catch (err) { error = err.message; status = 'decode-error'; }
            db.prepare('UPDATE resources SET status=?,error=?,format=? WHERE id=?').run(status, error, format, e.id);
          }
          if (error) {
            summary.errors++;
            if (summary.failures.length < 100) summary.failures.push({ id: e.id, type, error });
          }
        }
      } finally { fs.closeSync(fd); }
      db.exec('COMMIT');
      console.error(`${ARCHIVES[order]}: ${archive.entries.length} entries, ${summary.frames} frames total`);
    }
    // Strictly newer timestamp wins; ties keep the first entry in engine archive load order.
    const winner = db.prepare(`SELECT r.*,r.disk_size AS diskSize FROM resources r JOIN archives a ON a.id=r.archive_id WHERE r.hash=? AND a.variant=? ORDER BY r.timestamp DESC,a.load_order,r.entry_index LIMIT 1`);
    const aliases = upsert(db, 'aliases');
    const selected = db.prepare(`SELECT r.*,r.disk_size AS diskSize FROM resources r JOIN archives a ON a.id=r.archive_id WHERE a.variant=? ORDER BY a.load_order,r.entry_index`);
    db.exec('BEGIN');
    for (const e of selected.iterate(variant)) {
      if (winner.get(e.hash, variant).id !== e.id) continue;
      const result = resolveAlias(e, hash => winner.get(hash, variant));
      aliases.run(e.id, e.hash, result.resolved?.id ?? null, e.ext_offset, JSON.stringify(result.chain), result.error ? 'unresolved' : 'resolved', result.error ?? null);
      if (result.error) summary.errors++;
    }
    db.exec('COMMIT');
    const logicalInsert = upsert(db, 'logicalframes');
    const rasterInsert = upsert(db, 'raster_variants');
    summary.logicalFrames = 0; summary.rasterVariants = 0; summary.unresolvedCapacities = 0;
    db.exec('BEGIN');
    for (const item of db.prepare(`SELECT l.requested_id,l.requested_hash,l.resolved_id,r.type,r.hash AS resolved_hash,a.ext_blob,l.original_ext_offset FROM aliases l JOIN resources r ON r.id=l.resolved_id JOIN resources original ON original.id=l.requested_id JOIN archives a ON a.id=original.archive_id WHERE l.status='resolved' AND r.type IN (2,4) ORDER BY l.requested_id`).iterate()) {
      let capacityWidth = null, capacityHeight = null;
      if (item.type === 4 && item.original_ext_offset > 0) {
        const fd = fs.openSync(blobPath(item.ext_blob), 'r');
        try {
          const ext = readAt(fd, item.original_ext_offset - 1, 4);
          capacityWidth = ext.readUInt16LE(0); capacityHeight = ext.readUInt16LE(2);
        } finally { fs.closeSync(fd); }
      }
      for (const frame of db.prepare('SELECT * FROM decodedframes WHERE resource_id=? AND (?=2 OR requested_hash=?) ORDER BY list_index,frame_index').iterate(item.resolved_id, item.type, item.requested_hash)) {
        const cw = item.type === 2 ? frame.width : capacityWidth;
        const ch = item.type === 2 ? frame.height : capacityHeight;
        if (!cw || !ch || cw < frame.width || ch < frame.height) { summary.unresolvedCapacities++; continue; }
        const logicalId = `${item.requested_id}:resolved:${item.resolved_id}:list:${frame.list_index}:frame:${frame.frame_index}`;
        logicalInsert.run(logicalId, item.requested_id, item.resolved_id, frame.id, cw, ch, item.ext_blob, item.original_ext_offset);
        summary.logicalFrames++;
        const pixels = fs.readFileSync(blobPath(frame.indexed_blob));
        let paletteCrc = null;
        if (frame.palette_id) {
          const pal = db.prepare('SELECT blob FROM palettes WHERE id=?').get(frame.palette_id);
          paletteCrc = hex(crc32(fs.readFileSync(blobPath(pal.blob))));
        }
        for (const flipX of [false, true]) for (const flipY of [false, true]) {
          const result = raster(pixels, frame.width, frame.height, cw, ch, flipX, flipY);
          const recipe = { source: frame.indexed_blob, frameWidth: frame.width, frameHeight: frame.height, capacityWidth: cw, capacityHeight: ch,
            pitch: result.pitch, flipX, flipY, padding: 'zero', palette: frame.palette_id, transparency: 'runtime-context-dependent' };
          rasterInsert.run(`${logicalId}:flip:${Number(flipX)}${Number(flipY)}`, logicalId, frame.id, result.width, result.height,
            result.pitch, Number(flipX), Number(flipY), hex(crc32(result.pixels)), paletteCrc, sha(result.pixels), JSON.stringify(recipe));
          summary.rasterVariants++;
        }
      }
    }
    db.exec('COMMIT');
    // Regenerate a canonical, line-streamed interchange index without loading result sets into memory.
    writeIndex(db, output);
    summary.resolvedResources = db.prepare("SELECT count(*) n FROM aliases WHERE status='resolved'").get().n;
    summary.unresolvedAliases = db.prepare("SELECT count(*) n FROM aliases WHERE status='unresolved'").get().n;
    summary.smackerVideos = db.prepare("SELECT count(*) n FROM media WHERE format='smacker'").get().n;
    summary.probeErrors = db.prepare('SELECT count(*) n FROM media WHERE probe_error IS NOT NULL').get().n;
    summary.baseRasterVariants = summary.rasterVariants;
    summary.rasterVariants = db.prepare('SELECT count(*) n FROM raster_variants').get().n;
    summary.contextAssociations = db.prepare('SELECT count(*) n FROM frame_associations').get().n;
    summary.errorsByType = Object.fromEntries(db.prepare('SELECT type,count(*) n FROM resources WHERE error IS NOT NULL GROUP BY type').all().map(row => [TYPE_NAMES[row.type] ?? row.type, row.n]));
    summary.maxRssBytes = process.resourceUsage().maxRSS * 1024;
    summary.completedAt = new Date().toISOString();
    summary.notes = ['Indexed pixels are authoritative; missing scene palettes are not guessed.', 'Frame duration is engine counter ticks, not an assumed millisecond rate.', 'Raw sound/music retain original Neverhood formats, not mislabeled WAV.', 'No Fargus/Russian size fixes applied; English input expected.', 'Alias entries have no physical payload; disk_size is the target hash.', 'Frame IDs include archive checksum, physical entry, requested animation hash, list index and frame index; frame hashes are not unique IDs.', 'PNG palette RGB is authentic; transparency of index zero depends on runtime draw context and is not invented in these PNGs.', 'Intrinsic extData capacity can differ from explicit runtime constructor capacity; contextual raster recipes preserve this distinction.'];
    fs.writeFileSync(path.join(output, 'manifest.json.tmp'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(path.join(output, 'manifest.json.tmp'), path.join(output, 'manifest.json'));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return summary;
  } finally {
    db?.close(); releaseLock();
  }
}

// Associations are explicit offline scene metadata, never inferred from visual similarity.
export function associate({ output, repo, file }) {
  output = privateRoot(output, repo);
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('Association metadata exceeds 1 MiB');
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (document.version !== 1 || !Array.isArray(document.associations) || document.associations.length > 1000)
    throw new Error('Invalid association document');
  const releaseLock = acquireLock(output);
  let db;
  try {
    db = new DatabaseSync(path.join(output, 'catalog.sqlite')); db.exec(SCHEMA);
    if (document.sourceBinding !== db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get()?.value)
      throw new Error('Association sourceBinding does not match catalog');
    const result = { associations: 0, frames: 0, pngs: 0, rasterVariants: 0 };
    function resourceHash(value) {
      if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}$/.test(value)) throw new Error('Association hashes must be eight hexadecimal digits');
      return parseInt(value, 16);
    }
    function blob(hash) {
      const row = db.prepare('SELECT path,size FROM blobs WHERE sha256=?').get(hash);
      if (!row || row.size > 64 * 1024 * 1024) throw new Error('Missing/oversized association blob');
      const data = fs.readFileSync(path.join(output, row.path));
      if (sha(data) !== hash) throw new Error('Association source blob checksum mismatch; rerun extractor to repair');
      return data;
    }
    db.exec('BEGIN');
    const associationInsert = upsert(db, 'frame_associations');
    const rasterInsert = upsert(db, 'raster_variants');
    for (const association of document.associations) {
      const requestedHash = resourceHash(association.requestedHash);
      if (typeof association.provenance !== 'string' || !association.provenance.trim() || association.provenance.length > 4096)
        throw new Error('Association requires source provenance');
      for (const key of ['capacityWidth', 'capacityHeight']) if (association[key] !== undefined && (!Number.isInteger(association[key]) || association[key] < 1 || association[key] > 8192))
        throw new Error('Invalid association capacity');
      let palette = null, paletteId = null;
      if (association.paletteHash !== undefined) {
        const ph = resourceHash(association.paletteHash);
        const p = db.prepare('SELECT p.id,p.blob FROM aliases l JOIN palettes p ON p.resource_id=l.resolved_id WHERE l.requested_hash=? ORDER BY p.id LIMIT 1').get(ph);
        if (!p) throw new Error(`Palette not known for resource ${association.paletteHash}`);
        paletteId = p.id; palette = blob(p.blob);
      }
      const context = sha(JSON.stringify(association));
      let matches = 0;
      for (const frame of db.prepare(`SELECT f.*,l.id AS logical_id,l.capacity_width,l.capacity_height FROM logicalframes l JOIN resources r ON r.id=l.requested_id JOIN decodedframes f ON f.id=l.decoded_frame_id WHERE r.hash=? ORDER BY l.id`).iterate(requestedHash)) {
        const pixels = blob(frame.indexed_blob);
        const cw = association.capacityWidth ?? frame.capacity_width, ch = association.capacityHeight ?? frame.capacity_height;
        const pngBlob = palette ? storeBuffer(db, output, png(pixels, frame.width, frame.height, palette), 'png') : null;
        associationInsert.run(`${frame.logical_id}:context:${context}`, frame.logical_id, paletteId, pngBlob, association.provenance, JSON.stringify(association));
        for (const flipX of [false, true]) for (const flipY of [false, true]) {
          const rendered = raster(pixels, frame.width, frame.height, cw, ch, flipX, flipY);
          const recipe = { source: frame.indexed_blob, capacityWidth: cw, capacityHeight: ch, frameWidth: frame.width, frameHeight: frame.height,
            flipX, flipY, padding: 'zero', palette: paletteId, association: context, provenance: association.provenance };
          rasterInsert.run(`${frame.logical_id}:context:${context}:flip:${Number(flipX)}${Number(flipY)}`,
            frame.logical_id, frame.id, rendered.width, rendered.height, rendered.pitch, Number(flipX), Number(flipY), hex(crc32(rendered.pixels)),
            palette ? hex(crc32(palette)) : null, sha(rendered.pixels), JSON.stringify(recipe));
          result.rasterVariants++;
        }
        result.frames++; if (pngBlob) result.pngs++; matches++;
      }
      if (!matches) throw new Error(`No logical frames for resource ${association.requestedHash}`);
      result.associations++;
    }
    db.exec('COMMIT'); writeIndex(db, output);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    manifest.contextAssociations = db.prepare('SELECT count(*) n FROM frame_associations').get().n;
    manifest.rasterVariants = db.prepare('SELECT count(*) n FROM raster_variants').get().n;
    fs.writeFileSync(path.join(output, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(path.join(output, 'manifest.json.tmp'), path.join(output, 'manifest.json'));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return result;
  } finally { db?.close(); releaseLock(); }
}
