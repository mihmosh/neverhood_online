import test from 'node:test';
import assert from 'node:assert/strict';
import { composeIndexed, indicesToRGBA, paintFrame, LIMITS } from '../web/prototype/compositor.js';

const surface = (pixels, width, height = 1, pitch = width) => ({ pixels: Uint8Array.from(pixels), width, height, pitch });
const item = (source, extra = {}) => ({ source, destX: 0, destY: 0, srcX: 0, srcY: 0,
  width: source.width, height: source.height, transparent: false, ...extra });
const palette = new Uint8Array(1024);
for (let i = 0; i < 256; i++) palette.set([i, 255 - i, i ^ 85, 0], i * 4);

// Minimal synthetic Canvas2D implementation; neither a DOM nor game media needed.
function canvas(width, height) {
  const result = { width, height, calls: [], data: new Uint8ClampedArray(width * height * 4) };
  let transform = [1, 1, 0, 0];
  const stack = [];
  const ctx = {
    canvas: result,
    save() { stack.push([...transform]); }, restore() { transform = stack.pop(); },
    setTransform(a, b, c, d, e, f) { assert.equal(b, 0); assert.equal(c, 0); transform = [a, d, e, f]; },
    translate(x, y) { transform[2] += x * transform[0]; transform[3] += y * transform[1]; },
    scale(x, y) { transform[0] *= x; transform[1] *= y; },
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { result.data.set(image.data); },
    fillRect() {
      const rgb = this.fillStyle.match(/\d+/g).map(Number);
      for (let i = 0; i < width * height; i++) result.data.set([...rgb, 255], i * 4);
    },
    drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
      result.calls.push([image, sx, sy, sw, sh, dx, dy, dw, dh]);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const source = ((sy + Math.floor(y * sh / dh)) * image.width + sx + Math.floor(x * sw / dw)) * 4;
          const px = Math.floor(transform[2] + (dx + x + .5) * transform[0]);
          const py = Math.floor(transform[3] + (dy + y + .5) * transform[1]);
          if (image.data[source + 3]) result.data.set(image.data.subarray(source, source + 4), (py * width + px) * 4);
        }
      }
    },
  };
  result.getContext = () => ctx;
  return result;
}

test('ordered composition: opaque zero, nonzero alpha, overlap, and blank palette-zero background', () => {
  const layers = [item(surface([4, 5, 6], 3)), item(surface([0, 9], 2), { destX: 1 }),
    item(surface([7, 8, 7], 3), { transparent: true, alphaColor: 7 })];
  assert.deepEqual([...composeIndexed(layers, 4, 2)], [4, 8, 9, 0, 0, 0, 0, 0]);
  assert.deepEqual([...composeIndexed([item(surface([0, 2], 2), { transparent: true })], 2, 1)], [0, 2]);
});

test('pitched half-views and all destination edges clip without changing source origin', () => {
  const source = surface([1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9, 99], 3, 3, 4);
  assert.deepEqual([...composeIndexed([item(source, { srcX: 1, width: 2, destX: -1, destY: -1 })], 2, 2)], [6, 0, 9, 0]);
  assert.deepEqual([...composeIndexed([item(source, { destX: 1, destY: 1 })], 2, 2)], [0, 0, 0, 1]);
  assert.deepEqual([...composeIndexed([item(source, { destX: 100 })], 2, 2)], [0, 0, 0, 0]);
});

test('shadow uses world coordinates and source zero mask, ignoring alpha and transparent flag', () => {
  const shadow = surface([1, 2, 3, 4, 5, 6, 7, 8], 4, 2);
  for (const transparent of [false, true]) {
    const layers = [item(surface([9, 9, 9, 9], 4)), item(surface([0, 5, 6], 3), {
      destX: 1, shadow, transparent, alphaColor: 5,
    })];
    assert.deepEqual([...composeIndexed(layers, 4, 2)], [9, 9, 3, 4, 0, 0, 0, 0]);
  }
  const clipped = item(surface([1, 0, 1, 1], 2, 2), { destX: -1, shadow });
  assert.deepEqual([...composeIndexed([clipped], 4, 2)], [0, 0, 0, 0, 5, 0, 0, 0]);
});

test('RGBA conversion preserves RGB including index zero, always opaque', () => {
  const rgba = indicesToRGBA(Uint8Array.of(0, 255), palette);
  assert.ok(rgba instanceof Uint8ClampedArray);
  assert.deepEqual([...rgba], [0, 255, 85, 255, 255, 0, 170, 255]);
});

test('invalid rectangles, strides, lengths, counts, coordinates, and allocation bombs are rejected', () => {
  const source = surface([1, 2], 2);
  for (const extra of [{ srcX: 1 }, { srcY: -1 }, { width: 3 }, { destX: NaN },
    { height: 0.5 }, { alphaColor: 256 }, { transparent: undefined },
    { source: { ...source, pitch: 1 } }, { source: { ...source, height: 2 } },
    { shadow: surface([1], 1) }]) {
    assert.throws(() => composeIndexed([item(source, extra)], 2, 1));
  }
  assert.throws(() => composeIndexed(Array(LIMITS.layers + 1).fill(item(source))));
  assert.throws(() => composeIndexed([], 8192, 8192));
  assert.throws(() => composeIndexed([], Infinity, 1));
  assert.throws(() => composeIndexed([item({ ...source, pixels: new Uint8Array(LIMITS.sourceBytes + 1) })]));
  assert.throws(() => indicesToRGBA(new Uint8Array(LIMITS.framePixels + 1), palette));
  assert.throws(() => indicesToRGBA(Uint8Array.of(1), new Uint8Array(1023)));
  assert.throws(() => indicesToRGBA([1], palette));
});

test('Canvas original fallback agrees with CPU for clipped alpha and shadow layers, at 1x and 4x', () => {
  const layers = [item(surface([2, 3, 4, 5, 6, 7], 3, 2)),
    item(surface([8, 0, 9, 10], 2, 2), { destX: -1, transparent: true }),
    item(surface([0, 9, 9, 0], 2, 2), { destX: 1, shadow: surface([11, 12, 13, 14, 15, 16], 3, 2) })];
  const expected = indicesToRGBA(composeIndexed(layers, 3, 2), palette);
  for (const scale of [1, 4]) {
    const target = canvas(3 * scale, 2 * scale);
    paintFrame(target.getContext(), layers, palette, { width: 3, height: 2, scale, createCanvas: canvas });
    for (let y = 0; y < 2 * scale; y++) {
      for (let x = 0; x < 3 * scale; x++) {
        const ref = (Math.floor(y / scale) * 3 + Math.floor(x / scale)) * 4;
        const offset = (y * 3 * scale + x) * 4;
        assert.deepEqual(target.data.slice(offset, offset + 4), expected.slice(ref, ref + 4));
      }
    }
    assert.equal(target.calls.length, 3);
  }
});

test('HD image draws directly with resource-scaled half-view and preserves full queue order', () => {
  const source = surface([1, 2, 3, 4], 4);
  const hd = canvas(16, 4);
  const layers = [item(surface([9, 9], 2)), item(source, { key: 'hd', srcX: 2, width: 2 }),
    item(surface([8], 1), { destX: 1 })];
  const target = canvas(8, 4);
  paintFrame(target.getContext(), layers, palette, { width: 2, height: 1, createCanvas: canvas,
    replacements: new Map([['hd', { image: hd, width: 16, height: 4, scale: 4 }]]) });
  assert.equal(target.calls.length, 3);
  assert.equal(target.calls[1][0], hd);
  assert.deepEqual(target.calls[1].slice(1), [8, 0, 8, 4, 0, 0, 8, 4]);
  assert.notEqual(target.calls[0][0], hd);
  assert.notEqual(target.calls[2][0], hd);
});

test('replacement and scale validation occurs before painting', () => {
  const target = canvas(8, 4);
  const layer = item(surface([1, 2], 2), { key: 'hd' });
  for (const replacement of [{ image: canvas(8, 4), width: 7, height: 4, scale: 4 },
    { image: canvas(7, 4), width: 8, height: 4, scale: 4 },
    { image: canvas(8, 4), width: 8, height: 4, scale: 0 }]) {
    assert.throws(() => paintFrame(target.getContext(), [layer], palette, {
      width: 2, height: 1, replacements: new Map([['hd', replacement]]), createCanvas: canvas,
    }));
  }
  assert.throws(() => paintFrame(target.getContext(), [], palette, { scale: 16, width: 640, height: 480 }));
  assert.equal(target.calls.length, 0);
});

test('optional decoded cache reuses immutable snapshots and invalidates palette/mask changes', () => {
  const source = surface([1, 2], 2);
  const cache = new Map();
  const target = canvas(2, 1);
  let allocations = 0;
  const createCanvas = (w, h) => { allocations++; return canvas(w, h); };
  const options = { width: 2, height: 1, scale: 1, createCanvas, cache };
  paintFrame(target.getContext(), [item(source)], palette, options);
  paintFrame(target.getContext(), [item(source)], palette, options);
  assert.equal(allocations, 1);
  const changed = palette.slice();
  changed[4]++;
  paintFrame(target.getContext(), [item(source)], changed, options);
  paintFrame(target.getContext(), [item(source, { transparent: true })], changed, options);
  assert.equal(allocations, 3);
});

test('cropped HD textures match full transparent padding through source and destination clipping', () => {
  const source = surface(new Uint8Array(12), 4, 3), crop = { x: 3, y: 2, width: 9, height: 7 };
  const full = canvas(16, 12), trimmed = canvas(crop.width, crop.height);
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
    const rgba = [x * 13, y * 19, 211, (x + y) % 4 ? 255 : 0];
    full.data.set(rgba, ((y + crop.y) * full.width + x + crop.x) * 4);
    trimmed.data.set(rgba, (y * crop.width + x) * 4);
  }
  const geometry = [{}, { srcX: 1, width: 3 }, { srcY: 1, height: 2 },
    { srcX: 2, srcY: 1, width: 2, height: 2 }, { destX: -1, destY: -1 },
    { destX: 2, destY: 1 }, { srcX: 3, width: 1 }, { destX: -100 }, { destY: 100 }];
  for (const scale of [4, 8]) for (const placement of geometry) {
    const layers = [item(surface(Array(12).fill(7), 4, 3)), item(source, { key: 'hd', ...placement }),
      item(surface([8], 1), { destX: 2, destY: 2 })];
    const render = replacement => {
      const target = canvas(4 * scale, 3 * scale);
      paintFrame(target.getContext(), layers, palette, { width: 4, height: 3, scale, createCanvas: canvas,
        replacements: new Map([['hd', replacement]]) });
      return target;
    };
    const expected = render({ image: full, width: 16, height: 12, scale: 4 });
    const actual = render({ image: trimmed, width: 16, height: 12, scale: 4, crop });
    assert.deepEqual(actual.data, expected.data, `scale ${scale}: ${JSON.stringify(placement)}`);
    if (placement.srcX === 3 || placement.destX === -100 || placement.destY === 100) assert.equal(actual.calls.length, 2, 'fully outside crop or frame is skipped');
  }
});

test('crop UV offsets and fractional output/resource ratio preserve placement without stretching', () => {
  const crop = { x: 3, y: 5, width: 9, height: 6 }, image = canvas(9, 6);
  const target = canvas(4, 3), ctx = target.getContext();
  ctx.drawImage = (...args) => target.calls.push(args);
  const layer = item(surface(new Uint8Array(12), 4, 3), { key: 'hd', srcX: 1, width: 3 });
  paintFrame(ctx, [layer], palette, { width: 4, height: 3, scale: 1, createCanvas: canvas,
    replacements: new Map([['hd', { image, width: 16, height: 12, scale: 4, crop }]]) });
  assert.deepEqual(target.calls, [[image, 1, 0, 8, 6, 0, 1.25, 2, 1.5]]);
});

test('shared mirrored crops match preflipped padded images through clipping and queue order', () => {
  const crop = { x: 3, y: 2, width: 9, height: 7 };
  const canonical = canvas(9, 7), padded = canvas(20, 12);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) {
    const rgba = [x * 23, y * 31, 150, (x + y) % 3 ? 97 : 255];
    canonical.data.set(rgba, (y * 9 + x) * 4);
    padded.data.set(rgba, ((y + crop.y) * 20 + crop.x + 8 - x) * 4);
  }
  for (const placement of [{}, { srcX: 1, width: 4 }, { srcX: 2, width: 2 },
    { destX: -2, destY: -1 }, { srcY: 1, height: 2 }, { destX: 2, destY: 1 }]) {
    const source = surface(new Uint8Array(15), 5, 3);
    const render = replacement => {
      const target = canvas(20, 12);
      paintFrame(target.getContext(), [item(source, { key: 'shared', ...placement }),
        item(surface([9], 1), { destX: 4, destY: 2 })], palette,
      { width: 5, height: 3, scale: 4, createCanvas: canvas, replacements: new Map([['shared', replacement]]) });
      return target.data;
    };
    assert.deepEqual(render({ image: canonical, width: 20, height: 12, scale: 4, crop, flipX: true }),
      render({ image: padded, width: 20, height: 12, scale: 4 }), JSON.stringify(placement));
  }
});

test('invalid crop bounds and cropped bitmap dimensions fail before any painting', () => {
  const layer = item(surface([1, 2, 3, 4], 2, 2), { key: 'hd' });
  const invalid = [null, [], {}, { x: -1, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 }, { x: 0.5, y: 0, width: 2, height: 2 },
    { x: 7, y: 0, width: 2, height: 2 }, { x: 0, y: 7, width: 2, height: 2 },
    { x: 0, y: 0, width: 2, height: Infinity }];
  for (const crop of invalid) {
    const target = canvas(8, 8);
    assert.throws(() => paintFrame(target.getContext(), [layer], palette, { width: 2, height: 2, createCanvas: canvas,
      replacements: new Map([['hd', { image: canvas(2, 2), width: 8, height: 8, scale: 4, crop }]]) }), /crop/i);
    assert.equal(target.calls.length, 0); assert.ok(target.data.every(byte => byte === 0));
  }
  for (const [imageWidth, imageHeight] of [[8, 8], [2, 3], [3, 2]]) {
    const target = canvas(8, 8);
    assert.throws(() => paintFrame(target.getContext(), [layer], palette, { width: 2, height: 2, createCanvas: canvas,
      replacements: new Map([['hd', { image: canvas(imageWidth, imageHeight), width: 8, height: 8, scale: 4,
        crop: { x: 1, y: 1, width: 2, height: 2 } }]]) }), /Replacement dimensions/);
    assert.ok(target.data.every(byte => byte === 0));
  }
});
