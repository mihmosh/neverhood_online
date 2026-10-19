import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { prepareJob, registerOutput, exportMapping } from '../scripts/assets-map.mjs';
import { privateRoot } from '../tools/assets/catalog.mjs';
import { png, raster, crc32 } from '../tools/assets/formats.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(tmpdir(), 'neverhood-mapping-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const root = privateRoot(path.join(repo, 'private-assets'), repo, true);
  const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
  db.exec(`CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,size INTEGER,path TEXT);
    CREATE TABLE decodedframes(id TEXT PRIMARY KEY,width INTEGER,height INTEGER,indexed_blob TEXT,frame_index INTEGER);
    CREATE TABLE aliases(requested_id TEXT,requested_hash INTEGER,resolved_id TEXT,status TEXT);
    CREATE TABLE logicalframes(id TEXT,requested_id TEXT,capacity_width INTEGER,capacity_height INTEGER);
    CREATE TABLE raster_variants(id TEXT,frame_id TEXT,logical_frame_id TEXT,width INTEGER,height INTEGER,pitch INTEGER,flip_x INTEGER,flip_y INTEGER,pixel_crc32 TEXT,pixel_sha256 TEXT);
    CREATE TABLE palettes(resource_id TEXT,blob TEXT);
    CREATE TABLE catalogmeta(key TEXT,value TEXT);
    CREATE TABLE replacementjobs(id TEXT PRIMARY KEY,frame_id TEXT,resource_id TEXT,source_sha256 TEXT,output_blob TEXT,status TEXT,parameters_json TEXT);
    CREATE TABLE replacementstatus(id INTEGER PRIMARY KEY,job_id TEXT,status TEXT,at TEXT,detail TEXT);`);
  const store = (bytes, extension) => {
    const id = sha(bytes), relative = `blobs/${id}.${extension}`;
    fs.mkdirSync(path.join(root, 'blobs'), { recursive: true }); fs.writeFileSync(path.join(root, relative), bytes);
    db.prepare('INSERT INTO blobs VALUES(?,?,?)').run(id, bytes.length, relative);
    return id;
  };
  const indexed = Buffer.from([5]), palette = Buffer.alloc(1024); palette[20] = 255;
  const image = store(indexed, 'idx'), color = store(palette, 'pal');
  const variant = raster(indexed, 1, 1, 1, 1);
  db.prepare('INSERT INTO decodedframes VALUES(?,?,?,?,?)').run('frame0', 1, 1, image, 0);
  db.prepare('INSERT INTO aliases VALUES(?,?,?,?)').run('resource0', 0x4086520e, 'resource0', 'resolved');
  db.prepare('INSERT INTO logicalframes VALUES(?,?,?,?)').run('logical0', 'resource0', 1, 1);
  db.prepare('INSERT INTO raster_variants VALUES(?,?,?,?,?,?,?,?,?,?)').run('variant0', 'frame0', 'logical0', variant.width, variant.height, variant.pitch, 0, 0, crc32(variant.pixels).toString(16).padStart(8, '0'), sha(variant.pixels));
  db.prepare('INSERT INTO palettes VALUES(?,?)').run('resource0', color);
  db.prepare('INSERT INTO catalogmeta VALUES(?,?)').run('source-binding', 'synthetic-fixture');
  db.close();
  return { repo, root, palette, options: { root, repo, resource: '4086520e', palette: '4086520e', alpha: 'opaque' } };
}

test('private jobs prepare explicit padded native rasters and remain idempotent', t => {
  const { root, options } = fixture(t);
  const first = prepareJob(options), second = prepareJob(options);
  assert.equal(first.id, second.id);
  assert.equal(first.targetWidth, 16);
  assert.equal(first.targetHeight, 4);
  assert.match(first.runtimeKey, /^4x1-4-[a-f0-9]{8}-p[a-f0-9]{8}-opaque$/);
  assert.ok(fs.existsSync(first.input));
  const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
  assert.equal(db.prepare('SELECT count(*) n FROM replacementjobs').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM replacementstatus').get().n, 1);
  db.close();
});

test('candidate outputs are not mapped until explicit visual approval', t => {
  const { root, repo, palette, options } = fixture(t);
  const prepared = prepareJob(options), file = path.join(root, 'synthetic-4x.png');
  fs.writeFileSync(file, png(Buffer.alloc(16 * 4, 5), 16, 4, palette));
  assert.equal(registerOutput({ root, repo, job: prepared.id, file }).status, 'candidate');
  assert.equal(exportMapping({ root, repo }).entries, 0);
  assert.equal(registerOutput({ root, repo, job: prepared.id, file, reviewed: true, model: 'synthetic-test-no-model' }).status, 'approved');
  const exported = exportMapping({ root, repo });
  assert.equal(exported.entries, 1);
  const manifest = JSON.parse(fs.readFileSync(exported.file));
  assert.equal(manifest.private, true);
  assert.equal(manifest.entries[0].key, prepared.runtimeKey);
  assert.equal(manifest.entries[0].sha256, sha(fs.readFileSync(file)));
});

test('scene-associated capacity and palette override intrinsic animation metadata', t => {
  const { root, palette, options } = fixture(t);
  const db = new DatabaseSync(path.join(root, 'catalog.sqlite'));
  db.exec('ALTER TABLE raster_variants ADD COLUMN recipe_json TEXT; ALTER TABLE raster_variants ADD COLUMN palette_crc32 TEXT;');
  const source = raster(Buffer.from([5]), 1, 1, 2, 2), crc = crc32(source.pixels).toString(16).padStart(8, '0');
  db.prepare('INSERT INTO raster_variants VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('context-variant', 'frame0', 'logical0', 4, 2, 4, 0, 0, crc, sha(source.pixels), JSON.stringify({ capacityWidth: 2, capacityHeight: 2 }), crc32(palette).toString(16).padStart(8, '0'));
  db.close();
  const prepared = prepareJob(options);
  assert.equal(prepared.targetHeight, 8);
  assert.match(prepared.runtimeKey, new RegExp(`^4x2-4-${crc}-`));
  assert.throws(() => prepareJob({ ...options, runtimeKey: 'wrong-runtime-key' }), /found 0/);
});

test('wrong dimensions, corrupt PNG, lost transparency and public inputs are rejected', t => {
  const { root, repo, palette, options } = fixture(t);
  const prepared = prepareJob(options), file = path.join(root, 'invalid.png');
  fs.writeFileSync(file, png(Buffer.alloc(4 * 4, 5), 4, 4, palette));
  assert.throws(() => registerOutput({ root, repo, job: prepared.id, file }), /dimensions/);
  const corrupted = png(Buffer.alloc(16 * 4, 5), 16, 4, palette); corrupted[corrupted.length - 1] ^= 1;
  fs.writeFileSync(file, corrupted);
  assert.throws(() => registerOutput({ root, repo, job: prepared.id, file }), /CRC/);
  const masked = prepareJob({ ...options, alpha: 0 });
  fs.writeFileSync(file, png(Buffer.alloc(16 * 4, 5), 16, 4, palette));
  assert.throws(() => registerOutput({ root, repo, job: masked.id, file }), /alpha channel/);
  const publicFile = path.join(repo, 'web/accidental.png');
  fs.mkdirSync(path.dirname(publicFile)); fs.copyFileSync(file, publicFile);
  assert.throws(() => registerOutput({ root, repo, job: prepared.id, file: publicFile }), /private asset directory/);
});
