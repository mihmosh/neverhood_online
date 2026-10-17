import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  await page.locator('#library-panel[data-state="preparing"]').waitFor();
  assert.equal(await page.locator('.jaw-top').evaluate(jaw => getComputedStyle(jaw).animationName), 'chew-top');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.jaw-top').evaluate(jaw => getComputedStyle(jaw).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
  assert.equal(await page.locator('.jaw-top').evaluate(jaw => getComputedStyle(jaw).animationName), 'none');
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
  assert.equal(await page.locator('.game-toolbar, #stop-game').count(), 0, 'no toolbar or site exit during play');
  const host = await page.locator('#player-host').boundingBox();
  assert.equal(host.y, 0);
  assert.equal(host.height, overlay.height, 'the game must use the full viewport height');
  await page.locator('#game-loading').waitFor({ state: 'hidden', timeout: 180000 });
  const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  assert.ok(frame);
  await waitForGameFrame(frame, 'room');
  await frame.waitForFunction(() => Math.abs(document.getElementById('canvas').height - document.getElementById('canvas').getBoundingClientRect().height * devicePixelRatio) < 10);
  const geometry = await frame.locator('#canvas').evaluate(canvas => ({
    width: canvas.width, height: canvas.height,
    cssWidth: canvas.getBoundingClientRect().width, cssHeight: canvas.getBoundingClientRect().height,
  }));
  assert.ok(Math.abs(geometry.cssWidth / geometry.cssHeight - 4 / 3) < 0.01);
  assert.ok(geometry.width >= 640 && geometry.height >= 480);
  console.log('Player geometry:', geometry);
  return frame;
}

async function quit(frame) {
  await frame.locator('#canvas').press('Escape');
  await waitForGameFrame(frame, 'menu');
  assert.equal(await page.locator('#game').isVisible(), true, 'Escape opens the original menu, not the site');
  const box = await frame.locator('#canvas').boundingBox();
  const x = box.x + box.width * 95 / 640;
  const y = box.y + box.height * 400 / 480;
  await page.mouse.move(x, y);
  await frame.evaluate(() => new Promise(resolve => {
    let frames = 0;
    const tick = () => ++frames === 5 ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }));
  await page.mouse.click(x, y, { delay: 60 });
  await page.locator('#game').waitFor({ state: 'hidden', timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  assert.equal(await page.locator('#playframe').count(), 0);
  assert.equal(await page.locator('#play').isEnabled(), true);
  assert.equal(await page.locator('#play').evaluate(button => document.activeElement === button), true);
  assert.equal(await page.locator('#site').evaluate(site => site.inert), false);
}

async function checkPlayerControls(frame) {
  assert.equal(await frame.locator('#game-menu').isVisible(), true);
  assert.equal(await page.locator('#cancel-loading').isHidden(), true);
  // Even a stale/programmatic click must not abort a running engine.
  await page.locator('#cancel-loading').dispatchEvent('click');
  assert.equal(await page.locator('#game-loading').isHidden(), true);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 800, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const button = await page.locator('#fullscreen').boundingBox();
    const canvas = await frame.locator('#canvas').boundingBox();
    const host = await page.locator('#player-host').boundingBox();
    assert.equal(host.height, viewport.height);
    assert.equal(host.y, 0);
    assert.equal(button.width, 44);
    assert.equal(button.height, 44);
    if (viewport.width === 1440) assert.ok(button.x >= canvas.x + canvas.width, 'fullscreen must stay in the right letterbox');
    if (viewport.width === 390) assert.ok(button.y + button.height <= canvas.y, 'fullscreen must stay in the top letterbox');
    assert.ok(button.x >= 0 && button.y >= 0 && button.x + 44 <= viewport.width && button.y + 44 <= viewport.height);
    const menu = await frame.locator('#game-menu').boundingBox();
    assert.ok(menu.width >= 44 && menu.height >= 44, 'Menu must have a touch-sized target');
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= viewport.width && menu.y + menu.height <= viewport.height);
    assert.ok(menu.x + menu.width <= button.x || menu.y + menu.height <= button.y || button.y + button.height <= menu.y, 'Menu and fullscreen must not overlap');
  }
  // Exercise the actual engine on a phone-sized viewport, not just a DOM event spy.
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.locator('#game-menu').click();
  await waitForGameFrame(frame, 'menu');
  assert.equal(await page.locator('#game').isVisible(), true, 'Menu must not stop the session');
  await frame.locator('#canvas').press('Escape');
  await waitForGameFrame(frame, 'room');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'), 'Leave full screen');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('#game').isVisible(), true, 'leaving browser fullscreen must not end the game');
  assert.equal(await page.locator('#game-loading').isHidden(), true);
  assert.equal(await page.locator('#site').evaluate(site => site.inert), true);
  console.log('Floating fullscreen stays in letterboxing; toggle and stale startup cancel preserve the game');
}

try {
  await page.goto(process.env.TEST_ORIGIN || 'http://127.0.0.1:4173');
  assert.equal(await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some(font => font.family === 'Mansalva' && font.status === 'loaded'); }), true);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  assert.equal(await page.locator('.game-panel').count(), 1);
  assert.equal(await page.locator('#delete').isHidden(), true);
  assert.equal(await page.locator('#import-state').isVisible(), true);
  assert.equal(await page.locator('#archives').count(), 0, 'manual BLB controls must not remain');
  assert.equal(await page.locator('.intro').count(), 0);
  assert.equal(await page.locator('[data-source-link]').count(), 1);
  const chooser = page.waitForEvent('filechooser');
  await page.waitForFunction(() => !document.getElementById('game-folder').disabled);
  await page.locator('label[for="game-folder"]').click();
  const emptyFolder = join(profile, 'empty-import-folder');
  await mkdir(emptyFolder);
  await (await chooser).setFiles(emptyFolder);
  await page.waitForFunction(() => !document.getElementById('game-folder').disabled);
  await page.locator('#game-folder').focus();
  assert.equal(await page.locator('#game-folder').evaluate(input => document.activeElement === input && parseFloat(getComputedStyle(input.parentElement).outlineWidth) >= 3), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.jaw-top').evaluate(jaw => getComputedStyle(jaw).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
      await checkPlayerControls(frame);
      await page.setViewportSize({ width: 1200, height: 800 });
      await frame.waitForFunction(() => Math.abs(document.getElementById('canvas').height - document.getElementById('canvas').getBoundingClientRect().height * devicePixelRatio) < 10);
      await waitForGameFrame(frame, 'room');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await frame.waitForFunction(() => Math.abs(document.getElementById('canvas').height - document.getElementById('canvas').getBoundingClientRect().height * devicePixelRatio) < 10);
      console.log('Live resize preserved the high-DPI drawable and game frame');
      if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.game.png') });
      await quit(frame);
      console.log('In-game Quit returned to the site without a launcher');
      await quit(await play());
      console.log('Two actual in-game Quit/replay cycles completed without page reload');
      let releaseStartup;
      const startupHeld = new Promise(resolve => { releaseStartup = resolve; });
      await page.route('**/player.html?*', async route => { await startupHeld; await route.continue(); });
      const startupRequest = page.waitForRequest('**/player.html?*');
      await page.locator('#play').click();
      await startupRequest;
      await page.locator('#cancel-loading').click();
      releaseStartup();
      await page.locator('#game').waitFor({ state: 'hidden', timeout: 15000 });
      await page.unroute('**/player.html?*');
      await page.waitForFunction(() => !document.getElementById('play').disabled);
      assert.equal(await page.locator('#playframe').count(), 0);
      console.log('Cancel loading releases a deliberately stalled startup');
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
