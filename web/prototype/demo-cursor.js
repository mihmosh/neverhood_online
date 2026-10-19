import { demoAddress, fetchDemoBytes } from '../lib/demo-data.js';

const imageHash = '4c57062a74df1e1caf38e3107ebecf9f54e5b4f4af31da6bfbfb9c1323070204';
const paletteHash = 'd7ff65dc62ed03f0f92d5146a06effd79fb6793e04ae6cf4917743b73908167d';
const frameHashes = [
  '663fd2ed316a50bf5026d1f1937ebdd26e0e15424788d175b658031c1113ae3f',
  '93bdeffea770b78ee18625ae6df089eb54ea2cc1ea592a7e6bf514cad79185cf',
  'f37324305136a62735519a44d514ea36db34bef722812e5e8ae720ec7112e744',
];
const same = (a, b) => a?.length === b.length && b.every((value, i) => a[i] === value);
const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
const decode = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

export async function validateDemoCursorManifest(manifest) {
  if (manifest?.version !== 1 || manifest.revision !== 'tail-swing-v4' || manifest.resource !== '6520a400' ||
      manifest.row !== 4 || manifest.paletteResource !== '4086520e' || manifest.cellSize !== 128 ||
      !same(manifest.logicalSize, [32, 32]) || !same(manifest.hotspot, [3, 7]) ||
      !same(manifest.phaseMapping, [0, 0, 1, 1, 2, 2]) || manifest.imageSHA256 !== imageHash ||
      manifest.paletteRGBSHA256 !== paletteHash || manifest.frames?.length !== 3) throw new Error('Unsupported demo cursor binding.');
  const palette = decode(manifest.paletteRGBBase64);
  if (palette.length !== 768 || await sha(palette) !== paletteHash) throw new Error('Demo cursor palette fingerprint mismatch.');
  const frames = [];
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    const frame = manifest.frames[ordinal];
    const pixels = decode(frame.indicesBase64);
    if (frame.ordinal !== ordinal || frame.indexedSHA256 !== frameHashes[ordinal] || pixels.length !== 1024 ||
        await sha(pixels) !== frameHashes[ordinal]) throw new Error('Demo cursor indexed fingerprint mismatch.');
    frames.push(pixels);
  }
  return { palette, frames };
}

// Match the presented raster, not Mouse._frameNum (which is already incremented).
// This also retains needRefresh-delayed row changes and sheet-load phase.
export function demoCursorOrdinal(binding, frame) {
  const cursor = frame.cursor;
  if (frame.room !== 'Scene1001' || cursor?.resourceHash !== 0x6520a400 || cursor.hotspotX !== 3 || cursor.hotspotY !== 7 ||
      cursor.source.width !== 32 || cursor.source.height !== 32 || frame.palette?.length !== 1024) return -1;
  for (let i = 0; i < 768; i++) if (frame.palette[Math.floor(i / 3) * 4 + i % 3] !== binding.palette[i]) return -1;
  return binding.frames.findIndex(pixels => {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      if (cursor.source.pixels[y * cursor.source.pitch + x] !== pixels[y * 32 + x]) return false;
    }
    return true;
  });
}

export async function loadDemoCursor({ manifestURL, imageURL }, { signal } = {}) {
  const manifestBytes = await fetchDemoBytes(demoAddress(manifestURL).href, { signal, limit: 16 * 1024 });
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  const binding = await validateDemoCursorManifest(manifest);
  const bytes = await fetchDemoBytes(demoAddress(imageURL).href, { signal, limit: 2 * 1024 ** 2, sha256: imageHash });
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (signal?.aborted || image.width !== 384 || image.height !== 128) { image.close(); throw new Error('Invalid demo cursor image.'); }
  return { ...binding, image, dispose: () => image.close() };
}
