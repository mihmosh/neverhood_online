import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const source = resolve(process.argv[2] || join(root, 'private-assets/backstage_hires'));
const destination = join(directory, 'backstage');
const selected = [
  ['DrwmSLYX0AAqgBN.jpeg', 'Klaymen close-up against a textured clay wall'],
  ['EPlcPUAVUAESfY7.jpeg', 'Klaymen positioned in a clay doorway'],
  ['EPlcPUCU4AUortb.jpeg', 'Woodland set with a large tree'],
  ['EPlcPUCVUAMdcTc.jpeg', 'Two puppets on a green set; support wires visible'],
  ['EPlcPUHU4AAocYP.jpeg', 'Klaymen on a brown clay set'],
];
if (await realpath(source) !== source || await realpath(destination) !== destination) throw new Error('Reference directories must be canonical, without symlinks.');
let previous = { files: [] };
try { previous = JSON.parse(await readFile(join(destination, 'catalog.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const files = [];
for (const [file, description] of selected) {
  const input = join(source, file);
  if (await realpath(input) !== input) throw new Error(`Reference is a symlink: ${file}`);
  const bytes = await readFile(input);
  if (bytes.length < 128 || bytes.length > 10 * 1024 ** 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`Unexpected JPEG input: ${file}`);
  try { await writeFile(join(destination, file), bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(join(destination, file))).equals(bytes)) throw error;
  }
  files.push({ id: file.replace('.jpeg', ''), file, description, photographer: null, sourceUrl: null,
    captureDate: null, license: 'unspecified', cameraOriginalAuthenticated: false,
    ...previous.files.find(entry => entry.file === file),
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const catalog = { version: 1, category: 'physical-set-photo-candidates', publication: 'maintainer-approved-reference-inclusion',
  sourceCollection: 'Existing maintainer backstage_hires collection',
  softwareLicenseDoesNotApply: true, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
await writeFile(join(destination, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(JSON.stringify({ files: files.length, totalBytes: catalog.totalBytes, directory: destination }));
