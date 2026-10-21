import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readSaveFiles } from '../web/lib/save-format.js';
import { waitForGameFrame } from './browser-game.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// HD_SAVES=1 reuses the exact transfer and real-game roundtrip against the HD
// launcher. Serve a full-game release; bounded historical demo saves are disabled.
const hd = process.env.HD_SAVES === '1';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4173';
const launcher = hd ? `${origin}/hd-demo/` : origin;
const playButton = hd ? '#demo-play' : '#play';
const loadingPanel = hd ? '#demo-loading' : '#game-loading';
const sessionPanel = hd ? '#demo-session' : '#game';
if (!process.env.NATIVE_SAVE_DIR) throw new Error('Set NATIVE_SAVE_DIR to your ScummVM save folder. Native files are read only.');
const names = Array.from({ length: 6 }, (_, slot) => `neverhood.${String(slot).padStart(3, '0')}`);
const native = await Promise.all(names.map(async name => ({ name, bytes: await readFile(join(process.env.NATIVE_SAVE_DIR, name)) })));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = native.map(file => ({ name: file.name, sha256: digest(file.bytes) }));
const paths = names.map(name => join(process.env.NATIVE_SAVE_DIR, name));
const changed = Buffer.from(gunzipSync(native[0].bytes));
const thumbnail = 5 + changed[4];
const playTime = thumbnail + changed.readUInt32BE(thumbnail + 4) + 13;
changed.writeUInt32LE(changed.readUInt32LE(playTime) + 5, playTime);
const changedBytes = gzipSync(changed);
const profile = await mkdtemp(join(tmpdir(), 'neverhood-saves-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const uploads = [];
const logs = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => logs.push(message.text()));
page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url()); });
page.on('dialog', dialog => dialog.accept());

const state = () => page.evaluate(async () => (await import('/lib/save-store.js')).listSaves());
async function review(files) {
  await page.locator('#save-files').setInputFiles(files);
  await page.locator('#import-saves').click();
  await page.locator('#save-import-dialog').waitFor({ state: 'visible' });
}
async function confirm(overwrite = false) {
  if (overwrite) {
    assert.equal(await page.locator('#confirm-save-import').isDisabled(), true);
    await page.locator('#allow-save-overwrite').check();
  }
  await page.locator('#confirm-save-import').click();
  await page.locator('#save-import-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.getElementById('import-saves').disabled === !document.getElementById('save-files').files.length);
  assert.equal(await page.locator('#save-status.error').count(), 0, await page.locator('#save-status').innerText());
}
async function download(button) {
  const [item] = await Promise.all([page.waitForEvent('download'), page.locator(button).click()]);
  const chunks = [];
  for await (const chunk of await item.createReadStream()) chunks.push(chunk);
  return { name: item.suggestedFilename(), bytes: Buffer.concat(chunks) };
}
async function checkArchive(archive, hashes = expected) {
  const records = await readSaveFiles([new File([archive.bytes], archive.name)]);
  assert.deepEqual(records.map(file => ({ name: file.name, sha256: digest(file.bytes) })), hashes);
}
async function hashes() {
  return page.evaluate(async () => {
    const archive = await (await import('/lib/save-store.js')).exportSaves();
    return (await (await import('/lib/save-format.js')).readSaveFiles([new File([archive.bytes], archive.name)])).map(({ name, sha256 }) => ({ name, sha256 }));
  });
}

async function waitForSaveScreen(frame, previous, left = false) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const png = await frame.locator('#canvas').screenshot();
    const ready = await frame.evaluate(async ({ image, previous, left }) => {
      const pixels = async value => {
        const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(64, 48);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0, 64, 48);
        bitmap.close();
        return context.getImageData(0, 0, 64, 48).data;
      };
      const now = await pixels(image);
      if (previous) {
        const before = await pixels(previous);
        let delta = 0;
        for (let i = 0; i < now.length; i += 4) delta += Math.abs(now[i] - before[i]) + Math.abs(now[i + 1] - before[i + 1]) + Math.abs(now[i + 2] - before[i + 2]);
        return delta / (64 * 48 * 3) > 25;
      }
      let black = 0;
      for (let y = 16; y < 40; y++) for (let x = left ? 7 : 28; x < (left ? 36 : 57); x++) {
        const i = (y * 64 + x) * 4;
        if (now[i] < 30 && now[i + 1] < 30 && now[i + 2] < 30) black++;
      }
      return black > 600;
    }, { image: png.toString('base64'), previous, left });
    if (ready) return png.toString('base64');
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  throw new Error(previous ? 'Loading the native save did not leave the save list' : 'The original save list did not appear');
}

async function gameClick(frame, x, y) {
  const box = await frame.locator('#canvas').boundingBox();
  const px = box.x + box.width * x / 640;
  const py = box.y + box.height * y / 480;
  await page.mouse.move(px, py);
  // The original widgets read the cursor sprite from the preceding game tick.
  await frame.evaluate(() => new Promise(resolve => {
    let frames = 0;
    const tick = () => ++frames === 5 ? resolve() : requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  }));
  await page.mouse.click(px, py, { delay: 60 });
}

try {
  // The HD page embeds a third-party video. Isolate it from this local-only
  // save test while retaining the strict assertion against every upload.
  if (hd) await page.route('https://www.youtube-nocookie.com/embed/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Video fixture</title>',
  }));
  if (hd && process.env.DEMO_MANIFEST_URL) await page.route('**/hd-demo/config.json', route => route.fulfill({
    json: { version: 1, manifestURL: process.env.DEMO_MANIFEST_URL },
  }));
  await page.goto(launcher);
  if (hd) assert.equal(await page.locator('#demo-exit').count(), 0);
  else {
    await page.locator('#library-panel[data-state="empty"]').waitFor();
    await page.locator('details.advanced > summary').click();
  }
  if (await page.locator('#save-files').isHidden()) await page.locator(hd ? 'details.demo-saves > summary' : 'details.advanced > summary').click();
  await page.locator('#save-status').filter({ hasText: 'No saved games' }).waitFor();
  await review(paths);
  assert.equal(await page.locator('#save-import-files li').count(), 6);
  assert.equal(await page.locator('#save-overwrite-review').isHidden(), true);
  await confirm();
  assert.equal((await state()).files.length, 6);
  assert.deepEqual(await hashes(), expected);
  const exported = await download('#export-saves');
  await checkArchive(exported);
  console.log('Six real native gzip saves imported and exported byte-exactly, without game resources');

  const originalState = await state();
  await review(paths);
  assert.equal(await page.locator('#save-import-conflicts li').count(), 6);
  assert.equal(await page.locator('#confirm-save-import').isDisabled(), true);
  await page.locator('#cancel-save-import').click();
  await page.locator('#save-import-dialog').waitFor({ state: 'hidden' });
  assert.equal((await state()).revision, originalState.revision);
  assert.equal((await state()).backups.length, 0);

  await review({ name: names[0], mimeType: 'application/octet-stream', buffer: changedBytes });
  await confirm(true);
  assert.equal((await state()).backups.length, 1);
  const previous = await download('#export-save-backup');
  await checkArchive(previous);
  assert.notDeepEqual(await hashes(), expected);
  await review({ name: previous.name, mimeType: 'application/zip', buffer: previous.bytes });
  await confirm(true);
  assert.deepEqual(await hashes(), expected);
  console.log('Overwrite requires explicit consent; automatic pre-import backup restores all original bytes');

  const rollback = await state();
  const failure = await page.evaluate(async bytes => {
    const api = await import('/lib/save-store.js');
    const plan = await api.prepareSaveImport([new File([new Uint8Array(bytes)], 'neverhood.000')]);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'FILE_DATA' && key === '/saves/neverhood.000') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    try { await api.importSaves(plan, { overwrite: true }); return 'unexpected success'; }
    catch (error) { return error.name; }
    finally { IDBObjectStore.prototype.put = put; }
  }, [...changedBytes]);
  assert.equal(failure, 'QuotaExceededError');
  assert.deepEqual(await state(), rollback);
  console.log('Quota failure rolled back the backup and every save write atomically');

  await review({ name: names[0], mimeType: 'application/octet-stream', buffer: changedBytes });
  await page.evaluate(async bytes => {
    const api = await import('/lib/save-store.js');
    const plan = await api.prepareSaveImport([new File([new Uint8Array(bytes)], 'neverhood.001')]);
    await api.importSaves(plan, { overwrite: true });
  }, [...changedBytes]);
  const afterChange = await state();
  await page.locator('#allow-save-overwrite').check();
  await page.locator('#confirm-save-import').click();
  await page.locator('#save-dialog-status.error').filter({ hasText: 'changed in another tab' }).waitFor();
  assert.equal((await state()).revision, afterChange.revision);
  await page.locator('#cancel-save-import').click();
  await page.locator('#save-import-dialog').waitFor({ state: 'hidden' });
  console.log('A stale overwrite confirmation cannot replace newer saves');

  const other = await context.newPage();
  await other.goto(hd ? origin : `${origin}/hd-demo/`);
  await other.evaluate(() => new Promise(resolve => {
    window.held = navigator.locks.request('neverhood-library-write-v1', () => new Promise(release => { window.releaseSaveLock = release; resolve(); }));
  }));
  const blocked = await page.evaluate(async () => {
    try { await (await import('/lib/save-store.js')).exportSaves(); return ''; }
    catch (error) { return error.message; }
  });
  assert.match(blocked, /Close the game/);
  await other.evaluate(async () => { window.releaseSaveLock(); await window.held; });
  await other.close();

  await page.evaluate(async bytes => {
    const api = await import('/lib/save-store.js');
    for (let i = 0; i < 4; i++) {
      const plan = await api.prepareSaveImport([new File([new Uint8Array(bytes)], 'neverhood.000')]);
      await api.importSaves(plan, { overwrite: true });
    }
  }, [...native[0].bytes]);
  assert.equal((await state()).backups.length, 3);
  await review(paths);
  await confirm(true);
  assert.deepEqual(await hashes(), expected);
  await page.reload();
  if (await page.locator('#save-files').isHidden()) await page.locator(hd ? 'details.demo-saves > summary' : 'details.advanced > summary').click();
  await page.locator('#save-status').filter({ hasText: '6 saved games' }).waitFor();
  assert.deepEqual(await hashes(), expected);
  console.log('Cross-tab lock, three-backup retention and persistence after reload passed');

  if (hd || process.env.GAME_DATA_DIR) {
    if (!hd) {
      await page.locator('#game-folder').setInputFiles(process.env.GAME_DATA_DIR);
      await page.locator('#prepare').click();
      await page.locator('#library-panel[data-state="ready"]').waitFor({ timeout: 180000 });
    }
    await page.locator(playButton).waitFor();
    await page.waitForFunction(selector => !document.querySelector(selector).disabled, playButton);
    await page.locator(playButton).click();
    await page.locator(loadingPanel).waitFor({ state: 'hidden', timeout: 240000 });
    const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
    await waitForGameFrame(frame, 'room');
    if (hd) {
      assert.equal(await page.locator('#demo-cancel').isHidden(), true);
      assert.equal(await frame.locator('#game-menu').isVisible(), true, 'HD must use the full game with its native menu');
      const other = await context.newPage();
      await other.goto(origin);
      const blocked = await other.evaluate(async () => {
        try { await (await import('/lib/save-store.js')).exportSaves(); return ''; }
        catch (error) { return error.message; }
      });
      assert.match(blocked, /Close the game/, 'HD runtime must hold the same lock as the main save manager');
      await other.close();
    }
    const importedFiles = await frame.evaluate(() => {
      const fs = window.Module.FS;
      return Array.from({ length: 6 }, (_, slot) => fs.readFile(`/saves/neverhood.${String(slot).padStart(3, '0')}`).length);
    });
    assert.deepEqual(importedFiles, native.map(file => file.bytes.length));
    await frame.locator('#canvas').press('Escape');
    await waitForGameFrame(frame, 'menu');
    const click = (x, y) => gameClick(frame, x, y);
    await click(80, 205);
    const loadScreen = await waitForSaveScreen(frame);
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.load-menu.png') });
    await click(350, 150);
    await click(76, 130);
    await waitForSaveScreen(frame, loadScreen);
    await waitForGameFrame(frame);
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    assert.ok(!logs.some(line => /Error loading savegame|Error reading savegame|Game not loaded/i.test(line)));
    await frame.locator('#canvas').press('Escape');
    await waitForGameFrame(frame, 'menu');
    await click(80, 275);
    await waitForSaveScreen(frame, undefined, true);
    await frame.locator('#canvas').pressSequentially('web roundtrip', { delay: 120 });
    await click(560, 130);
    await frame.waitForFunction(() => window.Module.FS.readdir('/saves').filter(name => /^neverhood\.\d{3}$/.test(name)).length === 7, null, { timeout: 15000 });
    await waitForGameFrame(frame, 'menu');
    await click(95, 400);
    await page.locator(sessionPanel).waitFor({ state: 'hidden', timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('export-saves').disabled);
    await page.locator('#save-status').filter({ hasText: '7 saved games' }).waitFor();
    console.log('Actual WASM player populated imported saves and loaded native slot 000 through the original game menu');
    const roundtrip = await download('#export-saves');
    const records = await readSaveFiles([new File([roundtrip.bytes], roundtrip.name)]);
    assert.equal(records.length, 7);
    // Original Quit may autosave slot 000; all other native slots stay byte-exact.
    for (const file of expected.filter(file => file.name !== 'neverhood.000')) assert.equal(records.find(record => record.name === file.name)?.sha256, file.sha256);
    const created = records.find(record => !names.includes(record.name));
    assert.ok(created?.description.length);
    console.log('Created and exported an in-game web save; original Quit may update browser autosave slot 000');
    await page.reload();
    await page.waitForFunction(selector => !document.querySelector(selector).disabled, playButton);
    await page.locator(playButton).click();
    await page.locator(loadingPanel).waitFor({ state: 'hidden', timeout: 240000 });
    const reopened = page.frames().find(frame => frame.url().includes('/player.html?'));
    await waitForGameFrame(reopened, 'room');
    await reopened.locator('#canvas').press('Escape');
    await waitForGameFrame(reopened, 'menu');
    await gameClick(reopened, 80, 205);
    const restoredMenu = await waitForSaveScreen(reopened);
    await gameClick(reopened, 350, 150 + created.slot * 17);
    await gameClick(reopened, 76, 130);
    await waitForSaveScreen(reopened, restoredMenu);
    await waitForGameFrame(reopened);
    await reopened.locator('#canvas').press('Escape');
    await waitForGameFrame(reopened, 'menu');
    await gameClick(reopened, 95, 400);
    await page.locator(sessionPanel).waitFor({ state: 'hidden', timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('export-saves').disabled);
    const afterReplay = await hashes();
    console.log('Real in-game save -> exit -> page reload -> new player -> load cycle passed');
    if (hd) {
      await page.goto(origin);
      await page.locator('details.advanced > summary').click();
      await page.locator('#save-status').filter({ hasText: '7 saved games' }).waitFor();
      assert.deepEqual(await hashes(), afterReplay, 'The main launcher exports progress made in HD');
      console.log('HD native load -> in-game save -> Quit -> refresh/export -> reload -> load passed; main launcher sees identical saves');
    } else {
      await page.locator('#delete').click();
      await page.locator('#delete-dialog button[value="delete"]').click();
      await page.locator('#library-panel[data-state="empty"]').waitFor();
      assert.equal((await state()).files.length, 7);
      if (!await page.locator('details.advanced').evaluate(details => details.open)) await page.locator('details.advanced > summary').click();
      const afterRemoval = await readSaveFiles([new File([(await download('#export-saves')).bytes], 'saves.zip')]);
      assert.deepEqual(afterRemoval.map(({ name, sha256 }) => ({ name, sha256 })), afterReplay);
      console.log('Removing game resources preserves progress and keeps save export available');
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(uploads, []);
  for (let i = 0; i < native.length; i++) assert.equal(digest(await readFile(paths[i])), expected[i].sha256, 'native source file changed');
  console.log('Save transfer browser checks passed; native files unchanged, no uploads or uncaught page errors');
} catch (error) {
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '.failure.png'), fullPage: true }).catch(() => {});
  console.error(logs.join('\n'));
  throw error;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
