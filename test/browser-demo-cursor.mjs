import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/tmp/kilo/node_modules/playwright');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4201';
const cursor = new URL('../private-assets/demo-cursor-seven-v1/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('cursor.json', cursor)));
assert.equal(manifest.version, 2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });
const report = { errors: [], stages: [] };
let frame;
page.on('pageerror', error => report.errors.push(error.message));
if (!process.env.DIRECT) {
  await page.route('**/hd-demo/config.json', route => route.fulfill({ json: { version: 1, manifestURL: `${origin}/__private-demo/manifest.json` } }));
  await page.route('**/__private-demo/cursor/cursor.json', route => route.fulfill({ json: manifest }));
  await page.route('**/__private-demo/cursor/sprite-sheet-128.png', route => route.fulfill({ path: new URL('sprite-sheet-128.png', cursor).pathname, contentType: 'image/png' }));
}
async function ticks(count) {
  const start = await frame.evaluate(() => window.roomRendererPrototype.stats().engineFrames);
  await frame.waitForFunction(({ start, count }) => window.roomRendererPrototype.stats().engineFrames >= start + count,
    { start, count }, { timeout: Math.max(30000, count * 250) });
}
async function point(x, y, click = false) {
  const box = await frame.locator('#canvas').boundingBox();
  const at = [box.x + box.width * x / 640, box.y + box.height * y / 480];
  await page.mouse.move(...at);
  if (click) { await ticks(5); await page.mouse.click(...at, { delay: 60 }); }
}
async function capture(name) {
  const stats = await frame.evaluate(() => window.roomRendererPrototype.stats());
  report.stages.push({ name, stats });
  await page.screenshot({ path: `/tmp/kilo/neverhood-cursor-${name}.png` });
  assert.equal(stats.errors, 0);
  assert.equal(stats.mismatches, 0);
  return stats;
}
try {
  await page.goto(`${origin}/hd-demo/`);
  await page.locator('#demo-play').click({ timeout: 30000 });
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 240000 });
  frame = page.frames().find(value => value.url().includes('/player.html?'));
  for (let index = 0; index < 120; index++) {
    if (await frame.evaluate(() => window.roomRendererPrototype?.stats().hdDraws > 0)) break;
    await frame.locator('#canvas').press('Space'); await page.waitForTimeout(400);
  }
  await ticks(40);
  assert.equal((await capture('scene1')).cursor.hd, true);
  await point(300, 300, true); await ticks(140);
  for (let index = 0; index < 3; index++) { await point(75, 360, true); await ticks(190); }
  await point(556, 327, true);
  await frame.waitForFunction(() => window.roomRendererPrototype.stats().activeRoom === 'Scene1002', null, { timeout: 60000 });
  await frame.waitForFunction(() => window.roomRendererPrototype.stats().hdDraws > 0, null, { timeout: 240000 });
  for (const [name, x, y] of [['center', 320, 240], ['left', 1, 240], ['right', 639, 240], ['top', 320, 1], ['bottom', 320, 479]]) {
    await point(x, y); await ticks(12);
    const stats = await capture(`scene2-${name}`);
    assert.equal(stats.cursor.resourceHash, 0x23303124);
    assert.equal(stats.cursor.hd, true);
    assert.equal(stats.cursor.fallbackReason, null);
    assert.equal(stats.cursor.row, 4);
    assert.ok([0, 1, 2].includes(stats.cursor.pose));
    assert.deepEqual([stats.cursor.hotspotX, stats.cursor.hotspotY], [3, 7]);
  }
  const parity = await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame());
  assert.equal(parity.differingPixels, 0);
  await frame.locator('#room-hd-view').selectOption('original');
  await ticks(3); await capture('original');
  assert.equal(await frame.locator('#room-proxy-cursor-viewport').isHidden(), true);
  await frame.locator('#room-hd-view').selectOption('hd');
  await ticks(8);
  assert.equal((await capture('restored')).cursor.hd, true);
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ stages: report.stages.map(({ name, stats }) => ({ name, room: stats.activeRoom, cursor: stats.cursor })), parity }, null, 2));
} catch (error) {
  report.error = error.stack;
  await page.screenshot({ path: '/tmp/kilo/neverhood-cursor-error.png' }).catch(() => {});
  throw error;
} finally {
  await writeFile('/tmp/kilo/neverhood-cursor-report.json', JSON.stringify(report, null, 2));
  await browser.close();
}
