import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4191';
const remote = process.env.DEMO_CDN_FIXTURE === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const report = { realRuntime: true, importedGame: false, transitionInjection: true, fullGameplayRoute: false, errors: [], httpErrors: [] };
report.cdnFixture = remote;
let releaseRoom2;
const room2Gate = new Promise(resolve => { releaseRoom2 = resolve; });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const archives = [], looseRoomImages = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/\/room[12]\.zip$/.test(path)) archives.push(request.url());
    if (/\/room[12]\/.*\.(?:png|webp)$/.test(path)) looseRoomImages.push(request.url());
  });
  if (remote) {
    await page.route('**/hd-demo/config.json', route => route.fulfill({ json: { version: 1, manifestURL: 'https://demo-assets.example.test/v1/manifest.json' } }));
    await page.route('https://demo-assets.example.test/v1/**', async route => {
      const file = new URL(route.request().url()).pathname.slice('/v1/'.length);
      if (file === 'room2.zip') await room2Gate;
      const response = await fetch(`${origin}/__private-demo/${file}`);
      await route.fulfill({ status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: {
        'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'access-control-allow-origin': origin, 'cache-control': 'public, max-age=31536000, immutable',
      } });
    });
  }
  if (!remote) await page.route('**/room2.zip', async route => { await room2Gate; await route.continue(); });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: response.url() }); });
  await page.goto(`${origin}/hd-demo/`);
  assert.equal(await page.locator('input[type=file]').count(), 0);
  await page.waitForFunction(() => !document.getElementById('demo-play').disabled, null, { timeout: 30000 });
  await page.locator('#comparison-stage[data-state="ready"]').waitFor({ timeout: 30000 });
  await page.locator('#demo-play').click();
  await page.locator('#playframe').waitFor({ timeout: 30000 });
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 180000 });
  const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  assert.ok(frame && frame.url().includes('demo=1'));
  await frame.waitForFunction(() => window.roomRendererPrototype?.stats().hdDraws > 0, null, { timeout: 60000 });
  assert.equal(await frame.locator('#room-hd-controls select').count(), 1);
  assert.equal(await frame.locator('#room-hd-background').count(), 0);
  assert.equal(await frame.locator('#game-menu').isVisible(), false);
  report.room1 = await frame.evaluate(() => window.roomRendererPrototype.stats());
  report.room1StartedBeforeRoom2 = true;
  assert.equal(await page.locator('#demo-loading').isHidden(), true, 'Room 1 must be playable while room 2 download is held');
  assert.equal(report.room1.pack.selectedBackground, 'gemini');
  assert.equal(report.room1.activeRoom, 'Scene1001');
  assert.equal(report.room1.errors, 0);
  report.saves = await frame.evaluate(() => Module.FS.readdir('/saves'));
  assert.deepEqual(report.saves, ['.', '..']);
  const bounds = await frame.locator('#canvas').boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 320 / 640, bounds.y + bounds.height * 420 / 480);
  await frame.waitForFunction(() => window.roomRendererPrototype.stats().cursor?.visible);
  report.cursor = await frame.evaluate(() => window.roomRendererPrototype.stats().cursor);
  assert.equal(report.cursor.hd, true);
  await page.screenshot({ path: '/tmp/kilo/hd-demo-game-room1.png' });
  await frame.locator('#room-hd-view').selectOption('original');
  await frame.waitForFunction(() => window.roomRendererPrototype.output.hidden);
  await frame.locator('#room-hd-view').selectOption('hd');
  await frame.waitForFunction(() => !window.roomRendererPrototype.output.hidden);
  await page.mouse.click(bounds.x + bounds.width * 300 / 640, bounds.y + bounds.height * 300 / 480);
  await frame.waitForFunction(() => window.roomRendererPrototype.draws().some(item => item.sourceWidth === 320 && item.height > 100), null, { timeout: 20000 });
  report.wakingParity = await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame());
  assert.equal(report.wakingParity.differingPixels, 0);
  // Inject only native scene-completion results. C++ performs transitions/guards;
  // this is boundary coverage, not a claim of a complete puzzle walkthrough.
  const transition = async (result, expectedScene) => {
    await frame.evaluate(async result => {
      const abi = await (await fetch('/demo-runtime/render-abi.json')).json();
      const field = (type, name) => abi.records[`Neverhood::${type}`].fields[name].offset;
      const ptr = address => Module.getValue(address, '*');
      const engine = ptr(Module._g_engine), game = ptr(engine + field('NeverhoodEngine', '_gameModule'));
      const module = ptr(game + field('Module', '_childObject'));
      Module.setValue(module + field('Module', '_moduleResult'), result, 'i32');
      Module.setValue(module + field('Module', '_done'), 1, 'i8');
    }, result);
    if (expectedScene) await frame.waitForFunction(room => window.roomRendererPrototype.stats().activeRoom === room && window.roomRendererPrototype.stats().hdDraws > 0, expectedScene, { timeout: 60000 });
  };
  await transition(0);
  await page.locator('#demo-loading').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page.locator('#demo-loading-title').innerText(), /next room/i);
  assert.equal(archives.filter(url => new URL(url).pathname.endsWith('/room2.zip')).length, 1, 'Room entry must reuse the background request');
  releaseRoom2();
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 180000 });
  await frame.waitForFunction(() => window.roomRendererPrototype.stats().activeRoom === 'Scene1002' && window.roomRendererPrototype.stats().pack?.selectedBackground === 'gemini');
  report.room2 = await frame.evaluate(() => window.roomRendererPrototype.stats());
  assert.equal(report.room2.pack.selectedBackground, 'gemini');
  assert.equal(report.room2.errors, 0);
  await frame.locator('#room-hd-view').selectOption('original');
  await transition(0, 'Scene1001');
  assert.equal(await frame.locator('#room-hd-view').inputValue(), 'original');
  await frame.locator('#room-hd-view').selectOption('hd');
  await transition(0, 'Scene1002');
  await page.screenshot({ path: '/tmp/kilo/hd-demo-game-room2.png' });
  report.room2Parity = await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame());
  assert.equal(report.room2Parity.differingPixels, 0);
  await transition(2);
  await page.locator('#demo-session').waitFor({ state: 'hidden', timeout: 30000 });
  const archiveMode = report.room1.pack.archiveRequests !== undefined;
  if (archiveMode) {
    assert.equal(archives.length, 2, 'One archive download per room on first launch');
    assert.deepEqual(looseRoomImages, []);
    report.cacheNames = await page.evaluate(() => caches.keys());
    assert.equal(report.cacheNames.length, 4, 'One index and one committed image cache per room');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('demo-play').disabled, null, { timeout: 30000 });
  }
  assert.equal(await page.locator('#demo-play').isEnabled(), true);
  await page.locator('#demo-play').click();
  await page.locator('#playframe').waitFor();
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 180000 });
  if (archiveMode) {
    const warmFrame = page.frames().find(frame => frame.url().includes('/player.html?'));
    report.warmRoom1 = await warmFrame.evaluate(() => window.roomRendererPrototype.stats());
    assert.equal(report.warmRoom1.pack.persistentCacheHit, true);
    assert.equal(report.warmRoom1.pack.archiveRequests, 0);
    assert.equal(archives.length, 2, 'Reload must read extracted cache without downloading ZIPs');
    report.archiveDownloads = archives.length; report.looseRoomImageRequests = looseRoomImages.length;
  }
  await page.locator('#demo-exit').click();
  await page.locator('#demo-session').waitFor({ state: 'hidden', timeout: 30000 });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.httpErrors, []);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, realRuntime: true, noImport: true, cdnFixture: remote, rooms: 2, controls: 1,
    archiveDownloads: report.archiveDownloads, looseRoomImageRequests: report.looseRoomImageRequests,
    warmCacheHit: report.warmRoom1?.pack.persistentCacheHit, wakingParity: report.wakingParity, room2Parity: report.room2Parity }, null, 2));
  await context.close();
} catch (error) {
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  releaseRoom2();
  await writeFile(`/tmp/kilo/hd-demo-${remote ? 'cdn-fixture' : 'game'}-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
