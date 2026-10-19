#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareJob } from './assets-map.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'private-assets');
const research = fs.realpathSync(path.join(repo, '../neverhood-upscaling'));
const data = fs.realpathSync(path.join(research, 'data'));
const output = path.join(data, 'room-baselines', 'inputs');
for (const directory of [path.dirname(output), output]) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Symlink output forbidden.');
}
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const db = new DatabaseSync(path.join(root, 'catalog.sqlite'), { readOnly: true });
try {
  const frames = db.prepare(`SELECT f.frame_index,f.metadata_json FROM decodedframes f
    JOIN logicalframes l ON l.decoded_frame_id=f.id JOIN aliases a ON a.requested_id=l.requested_id
    WHERE a.requested_hash=? ORDER BY f.frame_index`).all(0x04a98c36);
  if (frames.length !== 12 || frames.some((f, i) => f.frame_index !== i)) throw new Error('Unexpected lever frame contract.');
  const entries = [{ resource: '4086520e', frame: 0, flipX: false, alpha: 'opaque', metadata: null },
    ...frames.map(row => ({ resource: '04a98c36', frame: row.frame_index, flipX: true, alpha: 0, metadata: JSON.parse(row.metadata_json) }))];
  const prepared = [];
  for (const entry of entries) {
    const job = prepareJob({ root, repo, ...entry, palette: '4086520e' });
    const parameters = JSON.parse(db.prepare('SELECT parameters_json FROM replacementjobs WHERE id=?').get(job.id).parameters_json);
    const bytes = fs.readFileSync(job.input);
    if (hash(bytes) !== parameters.sourcePNG) throw new Error('Input hash mismatch.');
    const file = `${entry.resource}-${String(entry.frame).padStart(3, '0')}.png`;
    fs.writeFileSync(path.join(output, file), bytes, { mode: 0o600 });
    const metadata = entry.metadata;
    prepared.push({ ...parameters, job: job.id, file, sha256: hash(bytes), metadata,
      placement: metadata ? { x: 150 - metadata.x - metadata.width + 1, y: 433 + metadata.y,
        width: metadata.width, height: metadata.height } : { x: 0, y: 0, width: 640, height: 480 } });
  }
  const manifest = { version: 1, private: true,
    sourceBinding: db.prepare("SELECT value FROM catalogmeta WHERE key='source-binding'").get().value,
    paletteResource: '4086520e', scale: 4, scene: 'module1000/scene0 (Scene1001)',
    provenance: ['module1000.cpp:135-136,175 background/palette and lever anchor (150,433), flipX=1',
      'module1000_sprites.cpp:175-177 lever resource/capacity', 'sprite.cpp:updatePosition flip and frame drawOffset',
      'scene.cpp:setFps(24); screen.cpp:setFps integer 1000/24 = 41 ms'],
    previewTiming: { tickMilliseconds: 41, note: 'All 12 resource frames, nominal durationTicks; not a captured gameplay schedule. Event/stick pauses are not simulated.' },
    entries: prepared };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ manifest: path.join(output, 'manifest.json'), inputs: prepared.length }, null, 2));
} finally { db.close(); }
