import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (!process.env.GAME_DATA_DIR) throw new Error('Set GAME_DATA_DIR to a legally obtained installed game folder.');
const profile = await mkdtemp(join(tmpdir(), 'neverhood-room1-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const uploads = [];
const logs = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => logs.push(message.text()));
page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url()); });
page.on('dialog', dialog => dialog.accept());

async function ticks(frame, count = 30) {
  await frame.evaluate(count => new Promise(resolve => {
    let n = 0;
    const next = () => ++n >= count ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }), count);
}
async function clickGame(frame, x, y) {
  const rect = await frame.locator('#canvas').boundingBox();
  await page.mouse.move(rect.x + rect.width * x / 640, rect.y + rect.height * y / 480);
  await ticks(frame, 5);
  await page.mouse.click(rect.x + rect.width * x / 640, rect.y + rect.height * y / 480, { delay: 60 });
}

try {
  const url = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:4173');
  url.searchParams.set('renderer', 'room1-proxy');
  url.searchParams.set('renderer-debug', '1');
  await page.goto(url.href);
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  await page.locator('#game-folder').setInputFiles(process.env.GAME_DATA_DIR);
  await page.locator('#prepare').click();
  await page.locator('#library-panel[data-state="ready"]').waitFor({ timeout: 180000 });
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  await page.locator('#play').click();
  await page.locator('#game-loading').waitFor({ state: 'hidden', timeout: 180000 });
  const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  assert.ok(frame.url().includes('renderer=room1-proxy'));
  for (let i = 0; i < 60; i++) {
    if (await frame.evaluate(() => window.roomRendererPrototype?.stats().verified > 0)) break;
    await frame.locator('#canvas').press('Space');
    await ticks(frame, 15);
  }
  let stats = await frame.evaluate(() => window.roomRendererPrototype?.stats());
  console.log('Initial prototype:', stats);
  assert.ok(stats?.verified > 0, JSON.stringify(stats));
  assert.equal(stats.maxDifference, 0);
  assert.equal(stats.errors, 0);
  assert.equal(stats.outputWidth, 640);
  assert.equal((await frame.evaluate(() => window.roomRendererPrototype.verify1x())).differingChannels, 0);
  await frame.locator('#room-proxy-canvas').waitFor({ state: 'visible' });
  // CURSOR: compare the separate overlay against the live original indexed surface.
  const cursorSample = () => frame.evaluate(async () => {
    const prototype = window.roomRendererPrototype;
    const { RenderFrameReader } = await import('./prototype/read-frame.js');
    const abi = await (await fetch('./prototype/render-abi.json')).json();
    // Sample immediately after the proxy's earlier-registered RAF, not across a timer-driven engine update.
    await new Promise(requestAnimationFrame);
    const live = new RenderFrameReader(Module, abi).read();
    const state = prototype.stats().cursor;
    const overlay = prototype.cursorCanvas;
    const actual = overlay.getContext('2d').getImageData(0, 0, 32, 32).data;
    const expected = new Uint8Array(actual.length);
    if (state?.visible && live.available) {
      const cursor = live.cursor;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const index = cursor.source.pixels[y * cursor.source.pitch + x];
        if (!index) continue;
        const offset = (y * 32 + x) * 4;
        expected.set(live.palette.subarray(index * 4, index * 4 + 3), offset);
        expected[offset + 3] = 255;
      }
    }
    let differences = 0, opaque = 0, hash = 2166136261;
    for (let i = 0; i < actual.length; i++) {
      // Transparent RGB is not observable and putImageData preserves it.
      if (state?.visible && (i % 4 === 3 || actual[i - i % 4 + 3]) && actual[i] !== expected[i]) differences++;
      hash = Math.imul(hash ^ actual[i], 16777619) >>> 0;
      if (i % 4 === 3 && actual[i]) opaque++;
    }
    const rect = prototype.cursorViewport.getBoundingClientRect(), native = document.getElementById('canvas').getBoundingClientRect();
    const cursor = overlay.getBoundingClientRect();
    const positioned = !state?.visible || (Math.abs(cursor.x - rect.x - (state.x-state.hotspotX)*rect.width/640) < .1 && Math.abs(cursor.y - rect.y - (state.y-state.hotspotY)*rect.height/480) < .1);
    return { state, hidden: overlay.hidden, hash, opaque, differences, positioned, transform: overlay.style.transform,
      aligned: ['x', 'y', 'width', 'height'].every(key => Math.abs(rect[key] - native[key]) < 0.01),
      clipping: getComputedStyle(prototype.cursorViewport).overflow, pointerEvents: getComputedStyle(overlay).pointerEvents,
      z: Number(getComputedStyle(prototype.cursorViewport).zIndex), sceneZ: Number(getComputedStyle(prototype.output).zIndex) };
  });
  const cursorSamples = [];
  for (const [x, y] of [[300, 300], [610, 300], [1, 1], [639, 479]]) {
    const rect = await frame.locator('#canvas').boundingBox();
    await page.mouse.move(rect.x + rect.width * x / 640, rect.y + rect.height * y / 480);
    await ticks(frame, 15);
    const sample = await cursorSample();
    console.log('CURSOR pointer:', sample);
    assert.equal(sample.state.visible, true);
    assert.equal(sample.hidden, false);
    assert.ok(Math.abs(sample.state.x - x) <= 1 && Math.abs(sample.state.y - y) <= 1);
    assert.equal(sample.differences, 0, 'cursor does not match original surface/palette/hotspot/clipping');
    assert.ok(sample.opaque > 0);
    assert.equal(sample.aligned, true);
    assert.equal(sample.positioned, true);
    assert.equal(sample.clipping, 'hidden');
    assert.equal(sample.pointerEvents, 'none');
    assert.ok(sample.z > sample.sceneZ);
    cursorSamples.push(sample);
  }
  assert.ok(new Set(cursorSamples.map(value => value.transform)).size > 1, 'moving pointer did not move the small cursor layer');
  assert.ok(cursorSamples.every(value => value.state.hotspotX !== 0 || value.state.hotspotY !== 0), 'the stock nonzero hotspot was lost');
  const animatedCursorHashes = await frame.evaluate(() => new Promise(resolve => {
    const hashes = new Set();
    let n = 0;
    const next = () => {
      hashes.add(window.roomRendererPrototype.stats().cursor?.rasterHash);
      if (++n >= 60) resolve([...hashes]); else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }));
  assert.ok(animatedCursorHashes.length > 1, 'original cursor animation froze');
  console.log('CURSOR original animated raster hashes:', animatedCursorHashes);
  assert.equal((await frame.evaluate(() => window.roomRendererPrototype.verify1x())).differingChannels, 0, 'cursor leaked into scene parity');
  await ticks(frame, 60);
  const draws = await frame.evaluate(() => window.roomRendererPrototype.draws());
  console.log('Room layers:', draws);
  const lever = draws.find(item => item.sourceWidth === 72 && item.sourceHeight === 73);
  assert.ok(lever, 'first-room lever surface was not observed');
  for (let attempt = 0; attempt < 8; attempt++) {
    if ((await frame.evaluate(() => window.roomRendererPrototype.stats())).leverVariants >= 7) break;
    await clickGame(frame, lever.destX + lever.width / 2, lever.destY + lever.height / 2);
    await ticks(frame, 120);
  }
  stats = await frame.evaluate(() => window.roomRendererPrototype.stats());
  console.log('After lever interaction:', stats);
  assert.ok(stats.leverVariants >= 7, 'the full observed lever cycle did not advance');
  assert.equal(stats.maxDifference, 0);
  assert.equal((await frame.evaluate(() => window.roomRendererPrototype.verify1x())).differingChannels, 0);

  // CURSOR: CSS/mobile geometry follows the native canvas, not the HD backing size.
  await page.setViewportSize({ width: 390, height: 844 });
  await ticks(frame, 30);
  {
    const rect = await frame.locator('#canvas').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await ticks(frame, 15);
    const sample = await cursorSample();
    assert.equal(sample.aligned, true);
    assert.equal(sample.hidden, false);
    assert.equal(sample.differences, 0);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ticks(frame, 30);

  await frame.locator('#room-proxy-panel summary').click();
  // CURSOR: UI hover must not leave a frozen duplicate cursor over the lab.
  assert.equal(await frame.locator('#room-proxy-cursor').evaluate(canvas => canvas.hidden), true);
  const current = await frame.evaluate(() => window.roomRendererPrototype.draws());
  const background = current.find(item => item.sourceWidth === 640 && item.sourceHeight === 480 && item.destX === 0 && item.destY === 0);
  assert.ok(background);
  await frame.locator('#proxy-layer').selectOption(background.key);
  const point = [{ x: 300, y: 10 }, { x: 200, y: 20 }, { x: 350, y: 100 }].find(point => !current.some(item => item.key !== background.key && point.x >= item.destX && point.x < item.destX + item.width && point.y >= item.destY && point.y < item.destY + item.height));
  assert.ok(point, 'no unobscured test point');
  const png = await frame.evaluate(async point => {
    const canvas = new OffscreenCanvas(2560, 1920);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#355577'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff0000'; ctx.fillRect(point.x * 4, point.y * 4, 1, 1);
    ctx.fillStyle = '#00ff00'; ctx.fillRect(point.x * 4 + 1, point.y * 4, 1, 1);
    return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())];
  }, point);
  await frame.locator('#proxy-image').setInputFiles({ name: 'synthetic-private-4x.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await frame.waitForFunction(() => window.roomRendererPrototype.stats().hdFrames > 0);
  const detail = await frame.evaluate(point => [...document.getElementById('room-proxy-canvas').getContext('2d').getImageData(point.x * 4, point.y * 4, 2, 1).data], point);
  assert.deepEqual(detail, [255, 0, 0, 255, 0, 255, 0, 255], 'HD detail was lost through a low-resolution intermediate');
  assert.equal((await frame.evaluate(() => window.roomRendererPrototype.stats())).outputWidth, 2560);
  // CURSOR: the authentic cursor stays above direct 4x replacement layers.
  {
    const rect = await frame.locator('#canvas').boundingBox();
    await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height * 0.3);
    await ticks(frame, 15);
    const sample = await cursorSample();
    assert.equal(sample.hidden, false);
    assert.equal(sample.differences, 0);
    assert.ok(sample.opaque > 0 && sample.z > sample.sceneZ);
  }
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
  await frame.locator('#proxy-clear').click();
  // CURSOR: a read failure restores the entire original frame, then recovers on a valid read.
  const cursorFailure = await frame.evaluate(async () => {
    const { RenderFrameReader } = await import('./prototype/read-frame.js');
    const read = RenderFrameReader.prototype.read;
    try {
      RenderFrameReader.prototype.read = () => { throw new Error('CURSOR test: native cursor read unavailable'); };
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return { originalOpacity: getComputedStyle(document.getElementById('canvas')).opacity, sceneHidden: window.roomRendererPrototype.output.hidden, cursorHidden: window.roomRendererPrototype.cursorCanvas.hidden };
    } finally { RenderFrameReader.prototype.read = read; }
  });
  assert.deepEqual(cursorFailure, { originalOpacity: '1', sceneHidden: true, cursorHidden: true });
  await frame.waitForFunction(() => !window.roomRendererPrototype.output.hidden);
  await frame.locator('#proxy-toggle').click();
  assert.equal(await frame.locator('#canvas').evaluate(canvas => getComputedStyle(canvas).opacity), '1');
  assert.equal(await frame.locator('#room-proxy-cursor').evaluate(canvas => canvas.hidden), true, 'original selection left duplicate cursor visible');
  const mismatch = await frame.evaluate(async () => {
    try {
      await (await import('./prototype/room1.js')).createRoomPrototype({ module: Module, canvas: document.getElementById('canvas'), wasmSHA256: '0'.repeat(64) });
      return '';
    } catch (error) { return error.message; }
  });
  assert.match(mismatch, /does not match/);
  assert.equal(await frame.locator('#room-proxy-canvas').count(), 1);
  console.log('A mismatched runtime layout is refused without modifying the original renderer');
  await frame.locator('#room-proxy-panel summary').click();
  await frame.locator('#canvas').press('Escape');
  await frame.waitForFunction(() => document.getElementById('room-proxy-canvas').hidden);
  assert.equal(await frame.locator('#room-proxy-cursor').evaluate(canvas => canvas.hidden), true, 'menu fallback left a duplicate cursor');
  assert.equal(await frame.locator('#canvas').evaluate(canvas => getComputedStyle(canvas).opacity), '1');
  await clickGame(frame, 95, 400);
  await page.locator('#game').waitFor({ state: 'hidden', timeout: 30000 });
  assert.deepEqual(errors, []);
  assert.deepEqual(uploads, []);
  console.log('Room 1 prototype passed: native parity, lever/character frames, direct 4x texture, menu fallback and Quit');
} catch (error) {
  console.error(logs.join('\n'));
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
