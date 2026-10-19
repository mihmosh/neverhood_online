import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const directory = '/home/mosha/neverhood-upscaling/data/room1-hd';
const functionalOnly = process.env.FUNCTIONAL_ONLY === '1';
const dpr = Number(process.env.TEST_DPR || 1);
const artifact = functionalOnly ? `automatic-functional-dpr${dpr}` : 'automatic';
const profile = await mkdtemp('/tmp/kilo/neverhood-auto-hd-');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  viewport: { width: 1440, height: 1000 }, deviceScaleFactor: dpr,
});
const page = context.pages()[0];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = { performanceAssertions: !functionalOnly,
  performanceContext: functionalOnly ? 'functional/DPI check; background inference may be active' : 'short local playback comparison' };
try {
  await page.goto(process.env.TEST_ORIGIN || 'http://127.0.0.1:4189/');
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  await page.locator('#game-folder').setInputFiles(process.env.GAME_DATA_DIR || '/home/mosha/neverhood/extracted/app/DATA');
  await page.locator('#prepare').click();
  await page.locator('#library-panel[data-state="ready"]').waitFor({ timeout: 180000 });
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  await page.locator('#play').click();
  await page.locator('#game-loading').waitFor({ state: 'hidden', timeout: 180000 });
  const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  assert.ok(frame);
  assert.ok(frame.url().includes('renderer=room1-proxy'), 'loopback HD capability should select the renderer automatically');
  assert.ok(!frame.url().includes('renderer-debug'), 'normal game must not open diagnostic mode');
  for (let i = 0; i < 90; i++) {
    if (await frame.evaluate(() => window.roomRendererPrototype?.stats().hdDraws > 0)) break;
    await frame.locator('#canvas').press('Space');
    await frame.evaluate(() => new Promise(resolve => {
      let frames = 0; const next = () => ++frames >= 15 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next);
    }));
  }
  await frame.waitForFunction(() => window.roomRendererPrototype?.stats().packEnabled && window.roomRendererPrototype.stats().hdDraws > 0);
  assert.equal(await frame.locator('#room-proxy-panel').isVisible(), false);
  assert.equal(await frame.locator('#room-hd-controls').isVisible(), true);
  assert.equal(await frame.locator('#room-hd-controls select').count(), 2);
  assert.equal(await frame.locator('#proxy-pack').isVisible(), false);
  assert.equal(await frame.locator('#proxy-image').isVisible(), false);
  report.initial = await frame.evaluate(() => window.roomRendererPrototype.stats());
  assert.deepEqual([report.initial.outputWidth, report.initial.outputHeight], [2560, 1920]);
  assert.equal(report.initial.diagnostics, false);
  const measure = async (view, milliseconds = 5000) => {
    await frame.locator('#room-hd-view').selectOption(view);
    return frame.evaluate(milliseconds => new Promise(resolve => {
      const api = window.roomRendererPrototype; api.resetTimings();
      const start = performance.now(), work = []; let last = -1, actorMissSamples = 0;
      const next = () => {
        const state = api.stats();
        if (state.frames !== last) {
          last = state.frames;
          work.push({ total: state.cpuMs, raster: state.rasterMs, verify: state.verifyMs, paint: state.paintMs });
          if (state.pack?.missKeys.some(key => key.startsWith('320x200-'))) actorMissSamples++;
        }
        if (performance.now() - start >= milliseconds) {
          const intervals = state.engineIntervals;
          const sorted = work.map(sample => sample.total).sort((a, b) => a-b);
          resolve({ intervals, fps: intervals.length ? 1000 * intervals.length / intervals.reduce((a,b) => a+b, 0) : null,
            medianProxyMs: sorted[Math.floor(sorted.length/2)] ?? null,
            p95ProxyMs: sorted[Math.floor(sorted.length*.95)] ?? null, actorMissSamples, samples: work, state });
        } else requestAnimationFrame(next);
      }; requestAnimationFrame(next);
    }), milliseconds);
  };
  report.original = await measure('original');
  assert.equal(await frame.locator('#room-proxy-canvas').evaluate(canvas => getComputedStyle(canvas).display), 'none');
  report.hd = await measure('hd');
  const bounds = await frame.locator('#canvas').boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 420 / 480);
  await frame.waitForFunction(() => {
    const cursor = window.roomRendererPrototype.stats().cursor;
    return cursor?.visible && Math.abs(cursor.x - 320) <= 1 && Math.abs(cursor.y - 420) <= 1;
  });
  report.hdNativeCanvas = await frame.locator('#canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, dpr: devicePixelRatio }));
  assert.deepEqual([report.hdNativeCanvas.width, report.hdNativeCanvas.height], [640 * report.hdNativeCanvas.dpr, 480 * report.hdNativeCanvas.dpr]);
  const sourceManifest = JSON.parse(await readFile(`${directory}/work-v1/manifest.json`, 'utf8'));
  const sleepTicks = sourceManifest.entries.filter(entry => entry.resource === '5a38c110' && !entry.flipX)
    .reduce((ticks, entry) => ticks + entry.metadata.durationTicks, 0);
  assert.ok(sleepTicks > 0);
  // Warm one actual source cycle, not an assumed number of wall-clock seconds.
  await frame.evaluate(ticks => new Promise(resolve => {
    const api = window.roomRendererPrototype, target = api.stats().engineFrames + ticks;
    const next = () => api.stats().engineFrames >= target ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }), sleepTicks);
  report.hdWarm = await measure('hd');
  assert.equal(report.hdWarm.actorMissSamples, 0, 'the steady sleeping cycle must fit the normal decoded cache');
  report.parity = await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame());
  assert.equal(report.parity.differingPixels, 0);
  if (!functionalOnly) {
    assert.ok(report.hdWarm.fps >= report.original.fps * .9, `warm HD engine FPS ${report.hdWarm.fps} versus original ${report.original.fps}; cold HD ${report.hd.fps}`);
    assert.ok(report.hdWarm.medianProxyMs < 10, `warm HD per-frame median ${report.hdWarm.medianProxyMs}ms exceeds the normal-mode budget`);
  }
  for (const background of ['gemini', 'realesrnet']) {
    await frame.locator('#room-hd-background').selectOption(background);
    await frame.waitForFunction(background => {
      const state = window.roomRendererPrototype.stats();
      return state.pack.selectedBackground === background && state.pack.pendingLoads === 0 && state.hdDraws > 0;
    }, background);
    await page.screenshot({ path: `${directory}/${artifact}-${background}.png` });
  }
  const rect = await frame.locator('#canvas').boundingBox();
  await page.mouse.click(rect.x + rect.width * 300/640, rect.y + rect.height * 300/480);
  await frame.waitForFunction(() => window.roomRendererPrototype.draws().some(item => item.sourceWidth === 320 && item.height > 100), null, { timeout: 20000 });
  report.movingParity = await frame.evaluate(() => new Promise((resolve, reject) => {
    const api = window.roomRendererPrototype, seen = new Set(), samples = [], start = performance.now();
    const next = () => {
      const actor = api.draws().find(item => item.sourceWidth === 320);
      if (actor && !seen.has(actor.key)) { seen.add(actor.key); samples.push(api.verifyNativeFrame()); }
      if (samples.length >= 5) resolve(samples);
      else if (performance.now()-start > 15000) reject(new Error('No distinct waking frames'));
      else requestAnimationFrame(next);
    }; requestAnimationFrame(next);
  }));
  assert.ok(report.movingParity.every(sample => sample.differingPixels === 0));
  const standing = sourceManifest.entries.filter(entry => ['5420e254', '5900c41e'].includes(entry.resource)).map(entry => entry.key);
  await frame.evaluate(keys => new Promise((resolve, reject) => {
    const start = performance.now(); let since;
    const next = () => {
      const actor = window.roomRendererPrototype.draws().find(item => item.sourceWidth === 320);
      if (actor && keys.includes(actor.key)) since ??= performance.now(); else since = undefined;
      if (since !== undefined && performance.now()-since >= 400) resolve();
      else if (performance.now()-start > 20000) reject(new Error('Klaymen did not finish waking'));
      else requestAnimationFrame(next);
    }; requestAnimationFrame(next);
  }), standing);
  const beforeWalk = await frame.evaluate(() => window.roomRendererPrototype.draws().find(item => item.sourceWidth === 320).destX);
  await page.mouse.click(rect.x + rect.width * 430/640, rect.y + rect.height * 440/480);
  await frame.waitForFunction(before => {
    const actor = window.roomRendererPrototype.draws().find(item => item.sourceWidth === 320);
    return actor && actor.destX - before > 80;
  }, beforeWalk, { timeout: 20000 });
  report.walkParity = await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame());
  assert.equal(report.walkParity.differingPixels, 0);
  await frame.locator('#game-menu').click();
  await frame.waitForFunction(() => window.roomRendererPrototype.output.hidden);
  assert.equal(await frame.locator('#room-proxy-canvas').evaluate(canvas => getComputedStyle(canvas).display), 'none');
  assert.equal(await frame.locator('#room-hd-controls').isVisible(), false);
  await frame.locator('#canvas').press('Escape');
  await frame.waitForFunction(() => !window.roomRendererPrototype.output.hidden);
  assert.equal(await frame.locator('#room-hd-controls').isVisible(), true);
  assert.deepEqual(errors, []);
  report.errors = errors; report.passed = true;
  console.log(JSON.stringify({ passed: true, performanceAssertions: !functionalOnly, dpr,
    originalFPS: report.original.fps, hdFPS: report.hd.fps,
    hdMedianMs: report.hd.medianProxyMs, hdP95Ms: report.hd.p95ProxyMs,
    warmActorMisses: report.hdWarm.actorMissSamples, warmHDfps: report.hdWarm.fps, parity: report.parity, controls: 2 }, null, 2));
} catch (error) {
  report.error = error.stack;
  await page.screenshot({ path: `${directory}/${artifact}-failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${directory}/${artifact}-report.json`, JSON.stringify(report, null, 2));
  await context.close(); await rm(profile, { recursive: true, force: true });
}
