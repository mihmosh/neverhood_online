import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gcd = (a, b) => b ? gcd(b, a % b) : a;

export function prepareInputs({ repo = project, assets = path.join(repo, 'private-assets'), output = path.join(repo, 'private-research/inputs') } = {}) {
  const marker = path.join(repo, 'private-research/.private-research-no-public');
  if (!fs.existsSync(marker)) throw new Error('Initialize the private evaluation workspace first.');
  const allowed = fs.realpathSync(path.dirname(marker));
  assets = fs.realpathSync(assets);
  output = path.resolve(output);
  if (!output.startsWith(allowed + path.sep)) throw new Error('Evaluation inputs must stay inside private-research.');
  if (!fs.existsSync(path.join(assets, '.private-assets-no-public'))) throw new Error('The source asset catalog is not marked private.');
  const db = new DatabaseSync(path.join(assets, 'catalog.sqlite'), { readOnly: true });
  try {
    const binding = db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get()?.value;
    const rows = db.prepare(`SELECT r.id,r.hash,r.payload_blob,b.path,b.size,m.probe_json FROM resources r JOIN blobs b ON b.sha256=r.payload_blob JOIN media m ON m.resource_id=r.id WHERE m.format='smacker' ORDER BY r.id`).all();
    const unique = new Map();
    for (const row of rows) {
      if (unique.has(row.payload_blob)) { unique.get(row.payload_blob).resourceIds.push(row.id); continue; }
      const source = path.resolve(assets, row.path);
      if (!source.startsWith(assets + path.sep) || fs.lstatSync(source).isSymbolicLink() || !fs.realpathSync(source).startsWith(assets + path.sep)) throw new Error('Unsafe media source path.');
      const fd = fs.openSync(source, 'r'), header = Buffer.alloc(24);
      try { if (fs.readSync(fd, header, 0, 24, 0) !== 24) throw new Error('Truncated Smacker header.'); }
      finally { fs.closeSync(fd); }
      const codec = header.toString('ascii', 0, 4);
      if (!['SMK2', 'SMK4'].includes(codec)) throw new Error('Unexpected video signature.');
      const width = header.readUInt32LE(4), height = header.readUInt32LE(8), count = header.readUInt32LE(12), delay = header.readInt32LE(16), flags = header.readUInt32LE(20);
      let numerator = delay < 0 ? 100000 : 1000, denominator = delay < 0 ? -delay : delay || 1;
      const factor = gcd(numerator, denominator); numerator /= factor; denominator /= factor;
      const decodedHeight = flags & 6 ? height * 2 : height;
      const probe = JSON.parse(row.probe_json || '{}');
      const video = probe.streams?.find(stream => stream.codec_type === 'video');
      unique.set(row.payload_blob, {
        id: row.payload_blob, resourceIds: [row.id], requestedHash: row.hash.toString(16).padStart(8, '0'),
        relativeAssetPath: row.path, sourceBytes: row.size, sourceSHA256: row.payload_blob,
        codec, storedWidth: width, storedHeight: height, decodedWidth: width, decodedHeight,
        probedWidth: video?.width ?? null, probedHeight: video?.height ?? null,
        frameCount: count + Number(Boolean(flags & 1)), ringFrame: Boolean(flags & 1), frameRate: { numerator, denominator },
        durationSeconds: (count + Number(Boolean(flags & 1))) * denominator / numerator,
        sourceFlags: flags, classification: 'unreviewed', target4x: { width: width * 4, height: decodedHeight * 4 },
        note: 'Source-relative 4x, not necessarily 4x of the game display; scene doubling/presentation needs an explicit association.',
      });
    }
    const videos = [...unique.values()];
    const manifest = { version: 1, private: true, sourceBinding: binding, videoResources: rows.length, uniqueVideos: videos.length, totalFrames: videos.reduce((n, video) => n + video.frameCount, 0), videos };
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    if (!fs.realpathSync(output).startsWith(allowed + path.sep)) throw new Error('Evaluation output cannot escape through a symlink.');
    const data = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(output, 'video-candidates.json'), data, { mode: 0o600 });
    const selection = path.join(output, 'selection.json');
    if (!fs.existsSync(selection)) fs.writeFileSync(selection, JSON.stringify({ version: 1, private: true, sourceBinding: binding, selected: [], requiredCases: ['fixed-camera-moving-character', 'translating-camera-environment', 'puzzle-symbols-small-detail'], note: 'Select reviewed video IDs plus exact startFrame/frameCount. Roles are not inferred from filenames or duration.' }, null, 2) + '\n', { mode: 0o600 });
    return { file: path.join(output, 'video-candidates.json'), uniqueVideos: videos.length, frames: manifest.totalFrames, sha256: createHash('sha256').update(data).digest('hex'), selection: 'manual review required; no media copied or uploaded' };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(prepareInputs(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
