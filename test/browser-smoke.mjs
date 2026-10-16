import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForGameFrame } from './browser-game.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const profile = await mkdtemp(join(tmpdir(), 'neverhood-browser-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors = [];
const uploads = [];
const logs = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => logs.push(message.text()));
page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url()); });
page.on('dialog', dialog => dialog.accept());

async function checkCompactLayout(action) {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 360, height: 740 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${viewport.width}px`);
    const box = await page.locator(action).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `${action} requires scrolling at ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`);
    if (viewport.width > 800) {
      for (const name of ['Benjamin Haisch', 'Filippos Karapetis']) {
        const credit = await page.getByText(name, { exact: true }).boundingBox();
        assert.ok(credit && credit.y >= 0 && credit.y + credit.height <= viewport.height, `engine author is below the fold: ${name}`);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function prepare(selector, path) {
  if (await page.locator('#delete').isVisible()) await removeGame();
  await page.locator(selector).setInputFiles(path);
  await page.waitForFunction(() => !document.getElementById('prepare').disabled);
  await page.locator('#prepare').click();
  await page.waitForFunction(() => document.getElementById('progress-wrap').hidden, null, { timeout: 600000 });
  assert.equal(await page.locator('#message.error').count(), 0, await page.locator('#message').innerText());
  await page.locator('#library-status').filter({ hasText: 'Your game is ready' }).waitFor();
  const library = await page.evaluate(async () => (await import('/lib/storage.js')).getLibrary());
  assert.equal(library.files.length, 7);
  assert.equal(library.total, 638122574);
  assert.equal(await page.locator('#import-state').isHidden(), true);
  assert.equal(await page.locator('#ready-state').isVisible(), true);
  assert.equal(await page.locator('#delete').isVisible(), true);
  await checkCompactLayout('#play');
  console.log(`${selector}: ${library.total} game bytes adopted`);
}

async function removeGame() {
  await page.locator('#delete').click();
  await page.locator('#delete-dialog button[value="delete"]').click();
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  assert.equal(await page.locator('#import-state').isVisible(), true);
  assert.equal(await page.locator('.intro').count(), 0);
  await checkCompactLayout('#prepare');
  assert.equal(await page.locator('#ready-state').isHidden(), true);
  assert.equal(await page.locator('#delete').isHidden(), true);
}

async function play() {
  await page.locator('#play').click();
  await page.locator('#game').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.body.classList.contains('playing')), true);
  const overlay = await page.locator('#game').boundingBox();
  assert.equal(overlay.y, 0, 'player must be visible immediately without scrolling');
  await page.locator('#game-loading').waitFor({ state: 'hidden', timeout: 180000 });
  const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  assert.ok(frame);
  await waitForGameFrame(frame, 'room');
  const geometry = await frame.locator('#canvas').evaluate(canvas => ({
    width: canvas.width, height: canvas.height,
    cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height,
  }));
  assert.ok(Math.abs(geometry.cssWidth / geometry.cssHeight - 4 / 3) < 0.01);
  assert.ok(geometry.width >= 640 && geometry.height >= 480);
  console.log('Player geometry:', geometry);
  return frame;
}

try {
  await page.goto(process.env.TEST_ORIGIN || 'http://127.0.0.1:4173');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  assert.equal(await page.locator('.game-panel').count(), 1);
  assert.equal(await page.locator('#delete').isHidden(), true);
  assert.equal(await page.locator('#import-state').isVisible(), true);
  assert.equal(await page.locator('#archives').count(), 0, 'manual BLB controls must not remain');
  assert.equal(await page.locator('.intro').count(), 0);
  await checkCompactLayout('#prepare');
  if (process.env.GAME_DATA_DIR) await prepare('#game-folder', process.env.GAME_DATA_DIR);
  if (process.env.INSTALLER_DIR) await prepare('#game-folder', process.env.INSTALLER_DIR);
  if (process.env.INSTALLER_ZIP) await prepare('#game-archive', process.env.INSTALLER_ZIP);
  if (process.env.GAME_DATA_DIR || process.env.INSTALLER_DIR || process.env.INSTALLER_ZIP) {
    await page.reload();
    await page.locator('#library-status').filter({ hasText: 'Your game is ready' }).waitFor();
    assert.equal(await page.locator('#import-state').isHidden(), true);
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.ready.png'), fullPage: true });
    if (process.env.TEST_RUNTIME === '1') {
      const frame = await play();
      await page.setViewportSize({ width: 1200, height: 800 });
      await frame.waitForFunction(() => Math.abs(document.getElementById('canvas').height - document.getElementById('canvas').getBoundingClientRect().height * devicePixelRatio) < 10);
      await waitForGameFrame(frame, 'room');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await frame.waitForFunction(() => Math.abs(document.getElementById('canvas').height - document.getElementById('canvas').getBoundingClientRect().height * devicePixelRatio) < 10);
      console.log('Live resize preserved the high-DPI drawable and game frame');
      if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.game.png') });
      await frame.locator('#canvas').press('Escape');
      await waitForGameFrame(frame, 'menu');
      const box = await frame.locator('#canvas').boundingBox();
      await page.mouse.click(box.x + box.width * 95 / 640, box.y + box.height * 400 / 480);
      await page.locator('#game').waitFor({ state: 'hidden', timeout: 30000 });
      await page.waitForFunction(() => !document.getElementById('play').disabled);
      assert.equal(await page.locator('#playframe').count(), 0);
      assert.equal(await page.locator('#play').isEnabled(), true);
      console.log('In-game Quit returned to the site without a launcher');
      await play();
      await page.locator('#stop-game').click();
      await page.locator('#game').waitFor({ state: 'hidden', timeout: 15000 });
      await page.waitForFunction(() => !document.getElementById('play').disabled);
      assert.equal(await page.locator('#playframe').count(), 0);
      assert.equal(await page.locator('#play').isEnabled(), true);
      console.log('Replay and Return to site completed without page reload');
      await page.locator('#play').click();
      await page.locator('#stop-game').click();
      await page.locator('#game').waitFor({ state: 'hidden', timeout: 15000 });
      console.log('Stopping during startup also releases the player');
    }
    await removeGame();
    console.log('Adaptive panel: empty -> ready -> reload -> remove -> empty');
  }
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(uploads, []);
  console.log('Browser smoke passed: automatic discovery, focused player, no uploads or page errors');
} catch (error) {
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.failure.png'), fullPage: true }).catch(() => {});
  console.error(logs.join('\n'));
  throw error;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
