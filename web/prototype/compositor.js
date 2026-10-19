// External indexed-surface experiment, independent of the native renderer.
// GPL-3.0-or-later. Real-game parity must be checked against native frames.
export const LIMITS = Object.freeze({
  layers: 512,
  sourceBytes: 8 * 1024 * 1024,
  framePixels: 8 * 1024 * 1024,
  outputPixels: 32 * 1024 * 1024,
  dimension: 8192,
});

function integer(value, name, min = 0, max = LIMITS.dimension) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

function paletteCheck(palette) {
  if (!(palette instanceof Uint8Array || palette instanceof Uint8ClampedArray) || palette.length !== 1024) {
    throw new TypeError('palette must contain exactly 1024 RGBA bytes');
  }
}

function validate(items, width, height) {
  integer(width, 'frame width', 1);
  integer(height, 'frame height', 1);
  if (width * height > LIMITS.framePixels) throw new RangeError('Frame pixel limit exceeded');
  if (!Array.isArray(items) || items.length > LIMITS.layers) throw new RangeError('Layer limit exceeded');
  const seen = new Set();
  let bytes = 0;
  function surface(source) {
    if (!source || !(source.pixels instanceof Uint8Array)) throw new TypeError('Source pixels must be Uint8Array');
    integer(source.width, 'source width', 1);
    integer(source.height, 'source height', 1);
    integer(source.pitch, 'source pitch', source.width, LIMITS.sourceBytes);
    const size = source.pitch * source.height;
    if (source.pixels.length < size) throw new RangeError('Source snapshot is shorter than pitch * height');
    if (!seen.has(source.pixels)) {
      seen.add(source.pixels);
      bytes += source.pixels.byteLength;
      if (bytes > LIMITS.sourceBytes) throw new RangeError('Source byte limit exceeded');
    }
  }
  return items.map(item => {
    if (!item || typeof item.transparent !== 'boolean') throw new TypeError('transparent must be boolean');
    surface(item.source);
    integer(item.destX, 'destX', -0x1000000, 0x1000000);
    integer(item.destY, 'destY', -0x1000000, 0x1000000);
    integer(item.srcX, 'srcX');
    integer(item.srcY, 'srcY');
    integer(item.width, 'item width');
    integer(item.height, 'item height');
    const alpha = integer(item.alphaColor ?? 0, 'alphaColor', 0, 255);
    if (item.srcX + item.width > item.source.width || item.srcY + item.height > item.source.height) {
      throw new RangeError('Source rectangle out of bounds');
    }
    const x = Math.max(0, item.destX);
    const y = Math.max(0, item.destY);
    const w = Math.max(0, Math.min(width, item.destX + item.width) - x);
    const h = Math.max(0, Math.min(height, item.destY + item.height) - y);
    if (item.shadow) {
      surface(item.shadow);
      if (w && h && (x + w > item.shadow.width || y + h > item.shadow.height)) {
        throw new RangeError('Shadow world rectangle out of bounds');
      }
    }
    return { item, alpha, x, y, w, h, sx: item.srcX + x - item.destX, sy: item.srcY + y - item.destY };
  });
}

export function composeIndexed(items, width = 640, height = 480) {
  const layers = validate(items, width, height);
  const result = new Uint8Array(width * height);
  for (const { item, alpha, x, y, w, h, sx, sy } of layers) {
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const index = item.source.pixels[(sy + row) * item.source.pitch + sx + col];
        if (item.shadow) {
          if (index !== 0) result[(y + row) * width + x + col] = item.shadow.pixels[(y + row) * item.shadow.pitch + x + col];
        } else if (!item.transparent || index !== alpha) {
          result[(y + row) * width + x + col] = index;
        }
      }
    }
  }
  return result;
}

export function indicesToRGBA(indices, paletteRGBA1024) {
  paletteCheck(paletteRGBA1024);
  if (!(indices instanceof Uint8Array)) throw new TypeError('Indices must be Uint8Array');
  if (indices.length > LIMITS.framePixels) throw new RangeError('Frame pixel limit exceeded');
  const rgba = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const p = indices[i] * 4;
    rgba[i * 4] = paletteRGBA1024[p];
    rgba[i * 4 + 1] = paletteRGBA1024[p + 1];
    rgba[i * 4 + 2] = paletteRGBA1024[p + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function browserCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('Canvas unavailable: supply createCanvas(width,height)');
}

function decoded(source, palette, transparent, alpha, createCanvas, cache) {
  const old = cache?.get(source.pixels);
  if (old && old.width === source.width && old.height === source.height && old.pitch === source.pitch &&
      old.transparent === transparent && old.alpha === alpha && old.palette.every((v, i) => v === palette[i])) {
    return old.canvas;
  }
  const canvas = createCanvas(source.width, source.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Cannot create 2D source context');
  const image = context.createImageData(source.width, source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const index = source.pixels[y * source.pitch + x];
      const out = (y * source.width + x) * 4;
      image.data[out] = palette[index * 4];
      image.data[out + 1] = palette[index * 4 + 1];
      image.data[out + 2] = palette[index * 4 + 2];
      image.data[out + 3] = transparent && index === alpha ? 0 : 255;
    }
  }
  context.putImageData(image, 0, 0);
  if (cache) {
    // Caller-owned cache: snapshots must be immutable. Bound retained decoded data.
    let pixels = source.width * source.height;
    for (const entry of cache.values()) pixels += entry.width * entry.height;
    if (cache.size >= LIMITS.layers || pixels > LIMITS.sourceBytes) cache.clear();
    cache.set(source.pixels, { canvas, width: source.width, height: source.height, pitch: source.pitch,
      transparent, alpha, palette: Uint8Array.from(palette) });
  }
  return canvas;
}

// Replacements must already carry the desired alpha mask. No 1x intermediate
// framebuffer is involved: each source rectangle is drawn directly at output scale.
export function paintFrame(ctx, items, palette, {
  width = 640, height = 480, scale = 4, replacements = new Map(),
  createCanvas = browserCanvas, cache,
} = {}) {
  paletteCheck(palette);
  const layers = validate(items, width, height);
  integer(scale, 'output scale', 1, 16);
  if (width * height * scale * scale > LIMITS.outputPixels) throw new RangeError('Output pixel limit exceeded');
  if (!(replacements instanceof Map) || (cache !== undefined && !(cache instanceof Map))) throw new TypeError('Expected Map');
  for (const { item } of layers) {
    const replacement = item.shadow ? undefined : replacements.get(item.key);
    if (!replacement) continue;
    integer(replacement.scale, 'replacement scale', 1, 16);
    const crop = replacement.crop;
    if (replacement.flipX !== undefined && typeof replacement.flipX !== 'boolean') throw new RangeError('Invalid replacement flip');
    if (crop !== undefined) {
      if (!crop || typeof crop !== 'object' || Array.isArray(crop)) throw new RangeError('Invalid replacement crop');
      integer(crop.x, 'crop x', 0, replacement.width); integer(crop.y, 'crop y', 0, replacement.height);
      integer(crop.width, 'crop width', 1, replacement.width); integer(crop.height, 'crop height', 1, replacement.height);
      if (crop.x + crop.width > replacement.width || crop.y + crop.height > replacement.height) throw new RangeError('Replacement crop out of bounds');
    }
    if (!replacement.image || replacement.width !== item.source.width * replacement.scale ||
        replacement.height !== item.source.height * replacement.scale ||
        replacement.image.width !== (crop?.width ?? replacement.width) || replacement.image.height !== (crop?.height ?? replacement.height) ||
        replacement.width * replacement.height > LIMITS.outputPixels) {
      throw new RangeError('Replacement dimensions must match the logical source and resource scale');
    }
  }
  if (ctx.canvas.width !== width * scale) ctx.canvas.width = width * scale;
  if (ctx.canvas.height !== height * scale) ctx.canvas.height = height * scale;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = `rgb(${palette[0]}, ${palette[1]}, ${palette[2]})`;
    ctx.fillRect(0, 0, width * scale, height * scale);
    for (const { item, alpha, x, y, w, h, sx, sy } of layers) {
      if (!w || !h) continue;
      if (item.shadow) {
        const tile = createCanvas(w, h);
        const context = tile.getContext('2d');
        if (!context) throw new Error('Cannot create 2D shadow context');
        const image = context.createImageData(w, h);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            if (item.source.pixels[(sy + row) * item.source.pitch + sx + col] === 0) continue;
            const index = item.shadow.pixels[(y + row) * item.shadow.pitch + x + col];
            const out = (row * w + col) * 4;
            image.data[out] = palette[index * 4];
            image.data[out + 1] = palette[index * 4 + 1];
            image.data[out + 2] = palette[index * 4 + 2];
            image.data[out + 3] = 255;
          }
        }
        context.putImageData(image, 0, 0);
        ctx.drawImage(tile, 0, 0, w, h, x * scale, y * scale, w * scale, h * scale);
      } else {
        const replacement = replacements.get(item.key);
        const resourceScale = replacement?.scale ?? 1;
        const image = replacement?.image ?? decoded(item.source, palette, item.transparent, alpha, createCanvas, cache);
        const crop = replacement?.crop;
        if (crop) {
          const left = Math.max(sx * resourceScale, crop.x), top = Math.max(sy * resourceScale, crop.y);
          const right = Math.min((sx + w) * resourceScale, crop.x + crop.width);
          const bottom = Math.min((sy + h) * resourceScale, crop.y + crop.height);
          if (right <= left || bottom <= top) continue;
          const ratio = scale / resourceScale;
          const dx = x * scale + (left - sx * resourceScale) * ratio;
          const dy = y * scale + (top - sy * resourceScale) * ratio;
          const dw = (right - left) * ratio, dh = (bottom - top) * ratio;
          if (replacement.flipX) {
            ctx.save();
            try {
              ctx.translate(dx + dw, dy); ctx.scale(-1, 1);
              ctx.drawImage(image, crop.width - (right - crop.x), top - crop.y, right - left, bottom - top, 0, 0, dw, dh);
            } finally { ctx.restore(); }
          } else ctx.drawImage(image, left - crop.x, top - crop.y, right - left, bottom - top, dx, dy, dw, dh);
        } else {
          ctx.drawImage(image, sx * resourceScale, sy * resourceScale, w * resourceScale, h * resourceScale,
            x * scale, y * scale, w * scale, h * scale);
        }
      }
    }
  } finally {
    ctx.restore();
  }
}
