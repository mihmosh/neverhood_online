import { readFile, mkdir, writeFile, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const study = '/home/mosha/neverhood-upscaling/data/cursor-study';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const output = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? path.join(root, 'private-assets/demo-cursor'));
const allGestures = process.argv.includes('--all-gestures');
// Never export original indices or candidate media into public/Git directories.
const privateRoot = await realpath(path.join(root, 'private-assets'));
const stagingRoot = path.join(await realpath(path.join(study, '..')), 'hd-demo');
const isPrivate = value => [privateRoot, stagingRoot].some(base => value.startsWith(`${base}${path.sep}`));
if (!isPrivate(output)) throw new Error('Cursor output must be inside private-assets or the private hd-demo staging directory.');
const source = JSON.parse(await readFile(path.join(study, 'manifest.json'), 'utf8'));
const sheet = source.sheets.find(item => item.resolved_hash === 0x6520a400);
const blob = async (hash, extension) => {
  const bytes = await readFile(path.join(privateRoot, 'blobs', hash.slice(0, 2), `${hash}.${extension}`));
  if (sha(bytes) !== hash) throw new Error('Source blob fingerprint mismatch.');
  return bytes;
};
const indices = await blob(sheet.indexed_blob, 'idx');
const palette = await blob(source.scenePalettes['6520a400'].palette_blob, 'pal');
if (indices.length !== 96 * 224 || palette.length !== 1024) throw new Error('Unexpected source dimensions.');
const rgb = Buffer.from(Array.from({ length: 768 }, (_, i) => palette[Math.floor(i / 3) * 4 + i % 3]));
const frames = [0, 1, 2].map(ordinal => {
  const pixels = Buffer.alloc(1024);
  for (let y = 0; y < 32; y++) indices.copy(pixels, y * 32, (128 + y) * 96 + ordinal * 32, (128 + y) * 96 + ordinal * 32 + 32);
  return { ordinal, indexedSHA256: sha(pixels), indicesBase64: pixels.toString('base64') };
});
const imagePath = allGestures ? path.join(privateRoot, 'hd-cursor/sprite-sheet-128.png') : path.join(study, 'blender-sculpt/fitted-v2/sprite-sheet-128.png');
const imageSHA256 = sha(await readFile(imagePath));
if (!allGestures && imageSHA256 !== '4c57062a74df1e1caf38e3107ebecf9f54e5b4f4af31da6bfbfb9c1323070204') throw new Error('Not the preserved tail-swing-v4 checkpoint.');
let manifest = { version: 1, revision: 'tail-swing-v4', resource: '6520a400', row: 4,
  paletteResource: '4086520e', logicalSize: [32, 32], hotspot: [3, 7], cellSize: 128,
  phaseMapping: [0, 0, 1, 1, 2, 2], imageSHA256,
  paletteRGBSHA256: sha(rgb), paletteRGBBase64: rgb.toString('base64'), frames };
if (allGestures) {
  const artwork = JSON.parse(await readFile(path.join(privateRoot, 'hd-cursor/cursor.json'), 'utf8'));
  if (artwork.revision !== 'clay-seven-gestures-v1' || artwork.rows.length !== 7 ||
      imageSHA256 !== '36521a672effd2421d6fababe04d79a0a03c98b830585fae23eaa82704284e26') throw new Error('Unsupported seven-gesture artwork.');
  const bindings = [];
  for (const resource of ['6520a400', '41108c00', '23303124']) {
    const original = source.sheets.find(item => item.resolved_hash === Number.parseInt(resource, 16));
    const pixels = await blob(original.indexed_blob, 'idx');
    const colors = await blob(source.scenePalettes[resource].palette_blob, 'pal');
    if (pixels.length !== 96 * 224 || colors.length !== 1024) throw new Error('Unexpected source dimensions.');
    const rgb = Buffer.from(Array.from({ length: 768 }, (_, i) => colors[Math.floor(i / 3) * 4 + i % 3]));
    for (const row of artwork.rows) {
      const frames = [0, 1, 2].map(ordinal => {
        const cell = Buffer.alloc(1024);
        for (let y = 0; y < 32; y++) pixels.copy(cell, y * 32, (row.row * 32 + y) * 96 + ordinal * 32, (row.row * 32 + y) * 96 + ordinal * 32 + 32);
        return { ordinal, indexedSHA256: sha(cell), indicesBase64: cell.toString('base64') };
      });
      bindings.push({ resource, row: row.row, hotspot: row.hotspot, paletteRGBSHA256: sha(rgb), paletteRGBBase64: rgb.toString('base64'), frames });
    }
  }
  manifest = { version: 2, revision: artwork.revision, logicalSize: [32, 32], cellSize: 128,
    phaseMapping: [0, 0, 1, 1, 2, 2], imageSHA256, sourceBinding: source.sourceBinding, bindings };
}
await mkdir(output, { recursive: true });
if (!isPrivate(await realpath(output))) throw new Error('Cursor output symlink escaped private storage.');
await copyFile(imagePath, path.join(output, 'sprite-sheet-128.png'));
await writeFile(path.join(output, 'cursor.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, imageSHA256, bindingSHA256: sha(Buffer.from(JSON.stringify(manifest))),
  bindings: manifest.bindings?.length ?? 1, paletteRGBSHA256: manifest.paletteRGBSHA256 }, null, 2));
