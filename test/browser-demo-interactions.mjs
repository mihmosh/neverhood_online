import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const report = { transitionInjection: false, fullGameplayRoute: false, naturalExit: false, stages: [], errors: [], httpErrors: [] };
let page, frame;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push(response.url()); });
  await page.goto(`${process.env.TEST_ORIGIN || 'http://127.0.0.1:4191'}/hd-demo/`);
  await page.waitForFunction(() => !document.getElementById('demo-play').disabled);
  await page.locator('#demo-play').click();
  await page.locator('#playframe').waitFor();
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 180000 });
  frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  const stage = async name => {
    report.stage = name;
    const state = frame && !frame.isDetached() ? await frame.evaluate(() => ({
      stats: window.roomRendererPrototype.stats(), draws: window.roomRendererPrototype.draws(),
    })) : null;
    report.stages.push({ name, at: new Date().toISOString(), state });
  };
  const ticks = async count => {
    const start = await frame.evaluate(() => window.roomRendererPrototype.stats().engineFrames);
    await frame.waitForFunction(({ start, count }) => window.roomRendererPrototype.stats().engineFrames >= start + count, { start, count }, { timeout: Math.max(30000, count * 150) });
  };
  const click = async (x, y) => {
    report.lastClick = { x, y, stage: report.stage };
    const box = await frame.locator('#canvas').boundingBox();
    await page.mouse.move(box.x + box.width * x / 640, box.y + box.height * y / 480);
    await ticks(5);
    await page.mouse.click(box.x + box.width * x / 640, box.y + box.height * y / 480, { delay: 60 });
  };
  await stage('wake');
  await click(300, 300);
  await ticks(140);
  for (let attempt = 0; attempt < 3; attempt++) {
    await stage(`lever-${attempt + 1}`);
    await click(75, 360);
    await ticks(180);
  }
  report.room1 = await frame.evaluate(() => window.roomRendererPrototype.stats());
  await page.screenshot({ path: '/tmp/kilo/hd-demo-interactions-lever.png' });
  assert.ok(report.room1.leverVariants >= 7, 'Lever interaction did not complete');
  await stage('door-to-room2');
  await click(556, 327);
  await frame.waitForFunction(() => window.roomRendererPrototype.stats().activeRoom === 'Scene1002', null, { timeout: 60000 });
  await ticks(100);
  report.room2 = await frame.evaluate(() => window.roomRendererPrototype.stats());
  assert.equal(report.room2.activeRoom, 'Scene1002');
  assert.equal(report.room2.errors, 0);
  report.room2Parity = await frame.evaluate(() => window.roomRendererPrototype.verifyNativeFrame());
  assert.equal(report.room2Parity.differingPixels, 0);
  await stage('room2-jump-to-floor');
  await click(300, 430);
  await ticks(240);
  await stage('room2-ring2');
  await click(297, 120);
  await ticks(180);
  report.afterRing = await frame.evaluate(() => window.roomRendererPrototype.stats());
  await page.screenshot({ path: '/tmp/kilo/hd-demo-interactions-room2.png' });
  await stage('room2-drop-from-ring');
  await click(480, 435);
  await ticks(180);
  await stage('room2-ladder-exit');
  await click(64, 420);
  await page.locator('#demo-session').waitFor({ state: 'hidden', timeout: 30000 });
  report.exitStatus = await page.locator('#demo-status').textContent();
  assert.match(report.exitStatus, /Your little visit is over/);
  report.naturalExit = true;
  report.fullGameplayRoute = true;
  report.stages.push({ name: 'completed', at: new Date().toISOString() });
  assert.deepEqual(report.errors, []); assert.deepEqual(report.httpErrors, []);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, transitionInjection: false, leverVariants: report.room1.leverVariants,
    room2Parity: report.room2Parity, room2PackErrors: report.afterRing.pack.errors,
    naturalExit: report.naturalExit, fullGameplayRoute: report.fullGameplayRoute }, null, 2));
} catch (error) {
  report.error = error.stack;
  await page?.screenshot({ path: '/tmp/kilo/hd-demo-interactions-error.png' });
  if (frame && !frame.isDetached()) report.lastState = await frame.evaluate(() => ({ stats: window.roomRendererPrototype.stats(), draws: window.roomRendererPrototype.draws() }));
  console.error(error); process.exitCode = 1;
}
finally { await writeFile('/tmp/kilo/hd-demo-interactions-report.json', JSON.stringify(report, null, 2)); await browser.close(); }
