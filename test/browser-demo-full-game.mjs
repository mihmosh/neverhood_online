import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4191';
const manifest = await (await fetch(`${origin}/__private-demo/manifest.json`)).json();
assert.equal(manifest.fullGame, true);
const mobile = process.env.MOBILE === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const report = { unchangedRuntime: true, mobile, transitionInjection: false, fullPlaythrough: false, launches: [] };
try {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1280, height: 960 } });
  async function launch() {
    const page = await context.newPage(), archives = [], errors = [];
    if (process.env.DEMO_MANIFEST_URL) await page.route('**/hd-demo/config.json', route => route.fulfill({
      json: { version: 1, manifestURL: process.env.DEMO_MANIFEST_URL },
    }));
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.zip')) archives.push(request.url()); });
    page.on('request', request => { if (/\.r2\.dev$|\.r2\.cloudflarestorage\.com$/.test(new URL(request.url()).hostname)) errors.push('Unexpected R2 request'); });
    await page.goto(`${origin}/hd-demo/`);
    await page.waitForFunction(() => !document.getElementById('demo-play').disabled);
    await page.locator('#demo-play').click();
    await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 240000 });
    const frame = page.frames().find(value => value.url().includes('/player.html?'));
    assert.ok(frame);
    const deadline = Date.now() + Number(process.env.SMOKE_HD_TIMEOUT || 180000);
    for (;;) {
      try {
        await frame.waitForFunction(() => window.roomRendererPrototype?.stats().hdDraws > 0, null, { timeout: 2000 });
        break;
      } catch (error) {
        if (errors.length || Date.now() > deadline) {
          await page.screenshot({ path: '/tmp/kilo/full-game-demo-failure.png' });
          const state = await frame.evaluate(async () => {
            const { RenderFrameReader } = await import('/prototype/read-frame.js');
            const { updateCRC32 } = await import('/lib/zip-validation.js');
            const abi = await (await fetch('/prototype/render-abi.json')).json();
            const observed = new RenderFrameReader(Module, abi, { allRooms: true }).read();
            const crc = bytes => ((updateCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
            return { stats: window.roomRendererPrototype?.stats(), available: observed.available, reason: observed.reason,
              sourceKeys: observed.items?.map(item => `${item.source.width}x${item.source.height}-${item.source.pitch}-${crc(item.source.pixels)}-p${crc(observed.palette)}-${item.transparent ? item.alphaColor : 'opaque'}`) };
          });
          throw new Error(`No full-game HD frame: ${JSON.stringify({ errors, state })}; ${error.message}`);
        }
        await frame.locator('#canvas').press('Space');
      }
    }
    assert.equal(await frame.evaluate(() => Module.renderPrototypeWasmSHA256), manifest.sourceRuntimeSHA256);
    assert.equal(await frame.locator('#game-menu').isVisible(), true);
    assert.equal(await frame.evaluate(() => document.querySelector('script[src*="/runtime/scummvm.js"]') !== null), true);
    await frame.waitForFunction(() => {
      const pack = window.roomRendererPrototype.stats().pack;
      return pack && pack.pendingLoads === 0 && pack.queuedLoads === 0;
    }, null, { timeout: 30000 });
    const first = await frame.evaluate(() => window.roomRendererPrototype.stats());
    assert.equal(first.errors, 0); assert.equal(first.mismatches, 0);
    assert.equal((await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame())).differingPixels, 0);
    return { page, frame, archives, errors, first };
  }
  const cold = await launch();
  const firstRoom = cold.first.activeRoom;
  assert.ok(manifest.packs[firstRoom]);
  assert.equal(cold.archives.length, 1, 'Only the currently entered room archive loads');
  await cold.frame.locator('#room-hd-view').selectOption('original');
  await cold.frame.waitForFunction(() => window.roomRendererPrototype.output.hidden);
  await cold.frame.locator('#room-hd-view').selectOption('hd');
  await cold.frame.waitForFunction(() => !window.roomRendererPrototype.output.hidden);
  async function click(x, y) {
    const box = await cold.frame.locator('#canvas').boundingBox();
    const target = [box.x + box.width * x / 640, box.y + box.height * y / 480];
    if (mobile) await cold.page.touchscreen.tap(...target);
    else await cold.page.mouse.click(...target, { delay: 60 });
  }
  async function ticks(count) {
    await cold.frame.evaluate(count => new Promise(resolve => {
      const start = window.roomRendererPrototype.stats().engineFrames;
      const deadline = performance.now() + 60000;
      function next() {
        if (performance.now() > deadline) { resolve(false); return; }
        if (window.roomRendererPrototype.stats().engineFrames - start >= count) resolve();
        else requestAnimationFrame(next);
      }
      next();
    }), count).then(result => assert.notEqual(result, false, 'The native game must keep advancing'));
  }
  await click(300, 300); await ticks(140);
  for (let attempt = 0; attempt < 3; attempt++) { await click(75, 360); await ticks(180); }
  await click(556, 327);
  await cold.frame.waitForFunction(first => {
    const state = window.roomRendererPrototype.stats();
    return state.activeRoom && state.activeRoom !== first && state.hdDraws > 0;
  }, firstRoom, { timeout: 90000 });
  await ticks(80);
  const second = await cold.frame.evaluate(() => window.roomRendererPrototype.stats());
  assert.ok(manifest.packs[second.activeRoom]);
  assert.equal(second.errors, 0); assert.equal(second.mismatches, 0);
  assert.equal((await cold.frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame())).differingPixels, 0);
  assert.equal(cold.archives.length, 2, 'Entering the next room downloads exactly its ZIP');
  await click(300, 430); await ticks(240);
  await click(297, 120); await ticks(180);
  await click(480, 435); await ticks(180);
  await click(64, 420);
  await cold.frame.waitForFunction(visited => {
    const state = window.roomRendererPrototype.stats();
    return state.activeRoom && !visited.includes(state.activeRoom) && state.hdDraws > 0;
  }, [firstRoom, second.activeRoom], { timeout: 90000 });
  await ticks(80);
  const third = await cold.frame.evaluate(() => window.roomRendererPrototype.stats());
  assert.equal(third.errors, 0);
  assert.equal((await cold.frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame())).differingPixels, 0);
  assert.equal(await cold.page.locator('#demo-session').isVisible(), true, 'The full runtime must continue past the old two-room boundary');
  assert.equal(cold.archives.length, 3, 'The third room uses the same on-entry archive loader');
  assert.deepEqual(cold.errors, []);
  if (process.env.DEMO_MANIFEST_URL) assert(cold.archives.every(url => new URL(url).origin === new URL(process.env.DEMO_MANIFEST_URL).origin));
  report.launches.push({ rooms: [firstRoom, second.activeRoom, third.activeRoom], archiveDownloads: cold.archives.length, passedOldDemoBoundary: true,
    delivery: process.env.DEMO_MANIFEST_URL ?? 'local-private-release',
    hdLayers: [cold.first.hdDraws, second.hdDraws, third.hdDraws] });
  await cold.page.close();
  const warm = await launch();
  assert.equal(warm.first.activeRoom, firstRoom);
  assert.equal(warm.first.pack.persistentCacheHit, true);
  assert.equal(warm.archives.length, 0, 'A cached room must not download its ZIP again');
  assert.deepEqual(warm.errors, []);
  report.launches.push({ room: firstRoom, archiveDownloads: warm.archives.length, persistentCacheHit: true });
  await warm.page.close();
  console.log(JSON.stringify({ passed: true, ...report }, null, 2));
} finally { await browser.close(); }
