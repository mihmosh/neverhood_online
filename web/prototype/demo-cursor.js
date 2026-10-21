import { demoAddress, fetchDemoBytes } from '../lib/demo-data.js';

const imageHash = '4c57062a74df1e1caf38e3107ebecf9f54e5b4f4af31da6bfbfb9c1323070204';
const sevenGestureManifestHash = '98b2c0aa3a42b34d4116c51d399b9c734466df5c9e6b76f8e786b747f4fbe58d';
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
  if (manifest?.version === 2) {
    if (manifest.revision !== 'clay-seven-gestures-v1' || !same(manifest.logicalSize, [32, 32]) ||
        manifest.cellSize !== 128 || !same(manifest.phaseMapping, [0, 0, 1, 1, 2, 2]) ||
        !/^[a-f0-9]{64}$/.test(manifest.imageSHA256) || !Array.isArray(manifest.bindings) ||
        !manifest.bindings.length || manifest.bindings.length > 112) throw new Error('Unsupported demo cursor binding.');
    const bindings = [], identities = new Set();
    const hotspots = [[15, 5], [17, 25], [17, 30], [14, 1], [3, 7], [30, 18], [1, 18]];
    for (const entry of manifest.bindings) {
      if (!/^[a-f0-9]{8}$/.test(entry.resource) || !Number.isInteger(entry.row) || !hotspots[entry.row] ||
          !same(entry.hotspot, hotspots[entry.row]) || identities.has(`${entry.resource}:${entry.row}`) ||
          !Array.isArray(entry.frames) || entry.frames.length !== 3) throw new Error('Unsupported demo cursor binding.');
      identities.add(`${entry.resource}:${entry.row}`);
      const palette = decode(entry.paletteRGBBase64);
      if (palette.length !== 768 || await sha(palette) !== entry.paletteRGBSHA256) throw new Error('Cursor palette fingerprint mismatch.');
      const frames = [], used = [];
      for (const [ordinal, frame] of entry.frames.entries()) {
        if (frame.ordinal !== ordinal || !/^[a-f0-9]{64}$/.test(frame.indexedSHA256)) throw new Error('Invalid cursor frame binding.');
        const pixels = decode(frame.indicesBase64);
        if (pixels.length !== 1024 || await sha(pixels) !== frame.indexedSHA256) throw new Error('Cursor index fingerprint mismatch.');
        const indices = [...new Set(pixels)].filter(index => index !== 0);
        if (!indices.length) throw new Error('Empty cursor binding.');
        used.push(indices);
        frames.push(pixels);
      }
      bindings.push({ resourceHash: Number.parseInt(entry.resource, 16), row: entry.row, hotspot: entry.hotspot,
        palette, frames, used });
    }
    return { bindings };
  }
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
export function demoCursorMatch(binding, frame, { allRooms = false } = {}) {
  const native = reason => ({ ordinal: -1, reason });
  const matched = ordinal => ({ ordinal, reason: null });
  const cursor = frame.cursor;
  if (!cursor) return native('cursor-unavailable');
  if (frame.palette?.length !== 1024) return native('palette-unavailable');
  if (cursor.source.width !== 32 || cursor.source.height !== 32 || cursor.source.pitch < 32) return native('shape-unproven');
  if (binding.bindings) {
    if (!allRooms && !['Scene1001', 'Scene1002'].includes(frame.room)) return native('room-unproven');
    let reason = 'resource-unproven';
    for (const candidate of binding.bindings) {
      if (cursor.resourceHash !== candidate.resourceHash) continue;
      if (reason === 'resource-unproven') reason = 'hotspot-unproven';
      if (cursor.hotspotX !== candidate.hotspot[0] || cursor.hotspotY !== candidate.hotspot[1]) continue;
      reason = 'raster-unproven';
      for (let ordinal = 0; ordinal < 3; ordinal++) {
        let equal = true;
        for (let y = 0; y < 32 && equal; y++) for (let x = 0; x < 32; x++) {
          if (cursor.source.pixels[y * cursor.source.pitch + x] !== candidate.frames[ordinal][y * 32 + x]) { equal = false; break; }
        }
        if (equal) {
          if (candidate.frames.some((pixels, other) => other !== ordinal && pixels.every((value, index) => value === candidate.frames[ordinal][index]))) return native('pose-ambiguous');
          if (!candidate.used[ordinal].every(index => [0, 1, 2].every(channel => frame.palette[index * 4 + channel] === candidate.palette[index * 3 + channel]))) return native('used-palette-mismatch');
          return matched(candidate.row * 3 + ordinal);
        }
      }
    }
    return native(reason);
  }
  if (!allRooms && frame.room !== 'Scene1001') return native('room-unproven');
  if (cursor.resourceHash !== 0x6520a400) return native('resource-unproven');
  if (cursor.hotspotX !== 3 || cursor.hotspotY !== 7) return native('hotspot-unproven');
  for (let i = 0; i < 768; i++) if (frame.palette[Math.floor(i / 3) * 4 + i % 3] !== binding.palette[i]) return native('legacy-palette-mismatch');
  const ordinal = binding.frames.findIndex(pixels => {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      if (cursor.source.pixels[y * cursor.source.pitch + x] !== pixels[y * 32 + x]) return false;
    }
    return true;
  });
  return ordinal < 0 ? native('raster-unproven') : matched(ordinal);
}

export function demoCursorOrdinal(binding, frame, options) {
  return demoCursorMatch(binding, frame, options).ordinal;
}

export async function loadDemoCursor({ manifestURL, imageURL }, { signal } = {}) {
  const manifestBytes = await fetchDemoBytes(demoAddress(manifestURL).href, { signal, limit: 256 * 1024 });
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  // Pin the complete prepared source-to-artwork association, not a self-asserted image hash.
  if (manifest.version === 2 && await sha(new TextEncoder().encode(JSON.stringify(manifest))) !== sevenGestureManifestHash) throw new Error('Unapproved demo cursor binding.');
  const binding = await validateDemoCursorManifest(manifest);
  const bytes = await fetchDemoBytes(demoAddress(imageURL).href, { signal, limit: 2 * 1024 ** 2, sha256: manifest.imageSHA256 });
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (signal?.aborted || image.width !== 384 || image.height !== (manifest.version === 2 ? 896 : 128)) { image.close(); throw new Error('Invalid demo cursor image.'); }
  return { ...binding, manifest, image, dispose: () => image.close() };
}
