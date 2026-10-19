import test from 'node:test';
import assert from 'node:assert/strict';
import { findGameCrop } from '../scripts/prepare-demo-previews.mjs';

test('preview crop removes browser chrome and letterbox without scaling one layer differently', () => {
  const frame = { width: 800, height: 600 }, rgb = new Uint8Array(frame.width * frame.height * 3);
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const value = y < 120 ? 100 : x >= 80 && x < 720 ? 160 : 0;
    rgb.fill(value, (y * frame.width + x) * 3, (y * frame.width + x + 1) * 3);
  }
  assert.deepEqual(findGameCrop(rgb, frame), { x: 80, y: 120, width: 640, height: 480 });
  assert.throws(() => findGameCrop(rgb.subarray(3), frame), /pixels/);
  rgb.fill(255);
  assert.throws(() => findGameCrop(rgb, frame), /letterboxed/);
  rgb.fill(0);
  assert.throws(() => findGameCrop(rgb, frame), /letterboxed/);
});
