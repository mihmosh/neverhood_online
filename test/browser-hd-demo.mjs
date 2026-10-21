import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readSaveFiles } from '../web/lib/save-format.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../web/', import.meta.url);
const runtimeMock = `
export async function discoverRuntime() { return { available: false, reason: 'UI fixture' }; }
export async function discoverDemoRuntime({ manifestURL }) {
  window.checkedManifest = manifestURL;
  if (window.demoScenario === 'unavailable') return { available: false, reason: 'Demo assets are not available.' };
  return { available: true, async start({ container, onStatus, signal }) {
    if (window.demoScenario === 'error') throw new Error('A demo download failed.');
    onStatus('Loading the rooms...', 35, 'loading');
    window.demoStatus = onStatus;
    await new Promise((resolve, reject) => {
      window.finishDemo = resolve;
      window.failDemo = () => reject(new Error('The player stopped unexpectedly.'));
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      if (window.demoScenario === 'playing') {
        const frame = document.createElement('iframe');
        frame.title = 'Demo game';
        container.append(frame);
        onStatus('Explore the rooms.', 100, 'playing');
      }
    });
  } };
}`;
const types = { css: 'text/css', js: 'text/javascript', json: 'application/json', html: 'text/html', ttf: 'font/ttf' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/lib/runtime.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(runtimeMock);
      return;
    }
    if (pathname === '/hd-demo/config.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: 1, manifestURL: null }));
      return;
    }
    const file = new URL(`.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`, root);
    if (!file.href.startsWith(root.href)) throw new Error('Invalid path');
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[file.pathname.split('.').at(-1)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
// Structural save fixture only; this is deliberately not a playable game save.
function syntheticSave(description) {
  const text = Buffer.from(description);
  const thumbnail = 5 + text.length;
  const bytes = Buffer.alloc(thumbnail + 26 + 17 + 4 + 12);
  bytes[4] = text.length;
  text.copy(bytes, 5);
  bytes.write('THMB', thumbnail);
  bytes.writeUInt32BE(26, thumbnail + 4);
  bytes[thumbnail + 8] = 2;
  bytes.writeUInt16BE(2, thumbnail + 9);
  bytes.writeUInt16BE(1, thumbnail + 11);
  bytes[thumbnail + 13] = 2;
  bytes.set([3, 2, 3, 8, 11, 5, 0, 0], thumbnail + 14);
  bytes.writeUInt32LE(1, thumbnail + 43);
  bytes.writeInt16LE(-1, bytes.length - 4);
  bytes.writeInt16LE(-1, bytes.length - 2);
  return bytes;
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function visit(scenario = 'ready', url = `${origin}/hd-demo/`) {
    await page.addInitScript(value => { window.demoScenario = value; }, scenario);
    await page.goto(url);
    await page.locator('#demo-actions[aria-busy="false"]').waitFor();
    if (url.startsWith(origin)) await page.waitForFunction(() => !document.getElementById('save-files').disabled);
  }
  async function locked(expected) {
    const held = await page.evaluate(() => navigator.locks.request('neverhood-library-write-v1', { ifAvailable: true }, lock => lock === null));
    assert.equal(held, expected, 'The shared library/save lock must span the entire runtime.start promise');
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), expected,
      'beforeunload protects an active runtime, but not the idle page');
  }
  async function review(buffer) {
    await page.locator('#save-files').setInputFiles({ name: 'neverhood.001', mimeType: 'application/octet-stream', buffer });
    await page.locator('#import-saves').click();
    await page.locator('#save-import-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#demo-play').isDisabled(), true, 'Save review blocks launching the runtime');
  }
  async function confirm(overwrite = false) {
    if (overwrite) {
      assert.equal(await page.locator('#confirm-save-import').isDisabled(), true);
      await page.locator('#allow-save-overwrite').check();
    }
    await page.locator('#confirm-save-import').click();
    await page.locator('#save-import-dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.getElementById('save-files').disabled);
    assert.equal(await page.locator('#save-status.error').count(), 0);
  }
  async function download(selector) {
    const [item] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
    const chunks = [];
    for await (const chunk of await item.createReadStream()) chunks.push(chunk);
    return readSaveFiles([new File([Buffer.concat(chunks)], item.suggestedFilename())]);
  }
  await visit();
  await page.locator('details.demo-saves > summary').click();
  assert.equal(await page.evaluate(() => window.checkedManifest), '/__private-demo/manifest.json');
  assert.equal(await page.locator('#demo-play').isEnabled(), true);
  assert.equal(await page.locator('input[type="file"]:not(#save-files)').count(), 0, 'No game-resource import inputs');
  assert.equal(await page.locator('#demo-exit').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Exit demo', exact: true }).count(), 0);
  await locked(false);
  const original = syntheticSave('HD original progress');
  const replacement = syntheticSave('HD replacement progress');
  await review(original);
  await confirm();
  assert.deepEqual(Buffer.from((await download('#export-saves'))[0].bytes), original);
  await review(replacement);
  await page.locator('#cancel-save-import').click();
  await page.locator('#save-import-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(Buffer.from((await download('#export-saves'))[0].bytes), original, 'Canceled overwrite preserves saves');
  await review(replacement);
  await confirm(true);
  assert.deepEqual(Buffer.from((await download('#export-save-backup'))[0].bytes), original);
  assert.deepEqual(Buffer.from((await download('#export-saves'))[0].bytes), replacement);
  const main = await page.context().newPage();
  await main.goto(origin);
  await main.locator('details.advanced > summary').click();
  await main.locator('#save-status').filter({ hasText: '1 saved game' }).waitFor();
  assert.equal(await main.locator('#save-list').innerText().then(text => text.includes('HD replacement progress')), true,
    'HD and main page read the same persistent save storage');
  await main.close();
  await page.reload();
  await page.locator('details.demo-saves > summary').click();
  await page.waitForFunction(() => !document.getElementById('demo-play').disabled && !document.getElementById('save-files').disabled);
  assert.deepEqual(Buffer.from((await download('#export-saves'))[0].bytes), replacement);
  const owner = await context.newPage();
  await owner.goto(origin);
  await owner.evaluate(() => new Promise(resolve => {
    window.held = navigator.locks.request('neverhood-library-write-v1', () => new Promise(release => {
      window.releaseSaveLock = release;
      resolve();
    }));
  }));
  await page.locator('#demo-play').click();
  await page.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'neverhood-library-write-v1'));
  assert.equal(await page.evaluate(() => typeof window.finishDemo), 'undefined', 'Runtime must not start before the shared lock is acquired');
  await page.locator('#demo-cancel').click();
  await page.locator('#demo-session').waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => !(await navigator.locks.query()).pending.some(lock => lock.name === 'neverhood-library-write-v1'));
  await owner.evaluate(async () => { window.releaseSaveLock(); await window.held; });
  await owner.close();
  await locked(false);
  for (const width of [1366, 1024, 768, 540, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.screenshot({ path: '/tmp/kilo/hd-demo-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/kilo/hd-demo-mobile.png', fullPage: true });
  await page.route('https://www.youtube-nocookie.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Video fixture</title>' }));
  assert.equal(await page.locator('#demo-video-host iframe').count(), 1);
  await page.locator('#demo-play').click();
  await page.waitForFunction(() => typeof window.finishDemo === 'function');
  await locked(true);
  for (const id of ['save-files', 'import-saves', 'export-saves', 'save-backups', 'export-save-backup']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} is blocked during startup`);
  }
  const blocked = await page.evaluate(async () => {
    try { await (await import('/lib/save-store.js')).exportSaves(); return ''; }
    catch (error) { return error.message; }
  });
  assert.match(blocked, /Close the game/);
  assert.equal(await page.locator('#demo-video-host iframe').count(), 1, 'Standard YouTube iframe remains in the page');
  assert.equal(await page.locator('#demo-session').isVisible(), true);
  assert.equal(await page.locator('#demo-progress').getAttribute('value'), '35');
  await page.evaluate(() => { window.demoStatus('Checking cached files...', 12, 'loading'); window.demoStatus('Verifying the first room...', undefined, 'loading'); });
  assert.equal(await page.locator('#demo-progress').getAttribute('value'), '35', 'startup progress never reverses or becomes indeterminate');
  assert.equal(await page.locator('#demo-page').evaluate(node => node.inert), true);
  await page.locator('#demo-cancel').click();
  await page.locator('#demo-session').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#demo-play').evaluate(node => node === document.activeElement), true);
  assert.match(await page.locator('#demo-status').innerText(), /cancelled/);
  await locked(false);
  await visit('error');
  await page.locator('#demo-play').click();
  await page.getByRole('button', { name: 'Retry demo' }).waitFor();
  assert.match(await page.locator('#demo-status').innerText(), /download failed/);
  await locked(false);
  await visit('playing');
  await page.locator('#demo-play').click();
  await page.waitForFunction(() => typeof window.finishDemo === 'function');
  await locked(true);
  assert.equal(await page.locator('#demo-loading').isHidden(), true);
  assert.equal(await page.locator('#demo-cancel').isHidden(), true);
  await page.evaluate(() => window.demoStatus('Downloading HD room 2...', 25, 'background'));
  assert.equal(await page.locator('#demo-loading').isHidden(), true, 'background prefetch cannot cover gameplay');
  assert.match(await page.locator('#demo-background-status').innerText(), /room 2.*25%/);
  await page.evaluate(() => window.demoStatus('Late startup status', 40, 'loading'));
  assert.equal(await page.locator('#demo-loading').isHidden(), true, 'late startup events cannot cover gameplay');
  await page.evaluate(() => window.demoStatus('Preparing HD room 2...', 40, 'room-loading'));
  assert.equal(await page.locator('#demo-loading').isVisible(), true);
  assert.equal(await page.locator('#demo-cancel').isHidden(), true, 'Room-loading cannot re-enable startup cancellation');
  await locked(true);
  assert.equal(await page.locator('#demo-progress').getAttribute('value'), '40');
  await page.evaluate(() => { window.demoStatus('Verifying room 2...', 15, 'room-loading'); window.demoStatus('HD room 2 is ready.', 100, 'background'); });
  assert.equal(await page.locator('#demo-progress').getAttribute('value'), '40');
  assert.equal(await page.locator('#demo-loading').isVisible(), true, 'cache completion must not expose an unverified frame');
  await page.evaluate(() => window.demoStatus('Enjoy Neverhood!', 100, 'playing'));
  assert.equal(await page.locator('#demo-loading').isHidden(), true);
  for (const width of [1366, 390, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const toolbar = await page.locator('.demo-toolbar').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }));
    assert.ok(toolbar.scroll <= toolbar.width, `player toolbar overflow at ${width}px`);
  }
  await page.evaluate(() => window.demoStatus('Flushing saved games...', undefined, 'stopping'));
  await locked(true);
  // Model the runtime's final IDBFS flush while its outer lock is still held.
  await page.evaluate(async bytes => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('/saves');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('FILE_DATA', 'readwrite');
        tx.objectStore('FILE_DATA').put({ timestamp: new Date(), mode: 33206, contents: new Uint8Array(bytes) }, '/saves/neverhood.002');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    window.finishDemo();
  }, [...original]);
  await page.locator('#demo-session').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#demo-play').isEnabled(), true, 'Normal completion permits replay');
  await page.locator('details.demo-saves > summary').click();
  await page.locator('#save-status').filter({ hasText: '2 saved games' }).waitFor();
  assert.equal(await page.locator('#save-list li').count(), 2, 'Completion refreshes saves after the final flush');
  await locked(false);
  await page.locator('#demo-play').click();
  await page.waitForFunction(() => document.getElementById('demo-loading').hidden);
  await page.evaluate(() => window.finishDemo());
  await page.locator('#demo-session').waitFor({ state: 'hidden' });
  await visit('unavailable');
  assert.equal(await page.locator('#demo-play').isDisabled(), true);
  assert.equal(await page.locator('#demo-recheck').isVisible(), true);
  await page.route('http://demo.example/**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await visit('ready', 'http://demo.example/hd-demo/?manifestURL=https://untrusted.example/manifest.json');
  assert.equal(await page.locator('#demo-play').isDisabled(), true);
  assert.match(await page.locator('#demo-status').innerText(), /has not been published/);
  assert.equal(await page.evaluate(() => window.checkedManifest), undefined, 'query cannot enable arbitrary asset discovery');
  assert.deepEqual(errors, []);
  console.log('HD demo UI: save transfer/backups/shared storage, runtime lock/beforeunload/refresh, responsive layout, loading-only cancel, retry/restart, completion, unavailable and unpublished states passed (mocked runtime).');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
