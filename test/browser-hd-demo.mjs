import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../web/', import.meta.url);
const runtimeMock = `
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
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function visit(scenario = 'ready', url = `${origin}/hd-demo/`) {
    await page.addInitScript(value => { window.demoScenario = value; }, scenario);
    await page.goto(url);
    await page.locator('#demo-actions[aria-busy="false"]').waitFor();
  }
  await visit();
  assert.equal(await page.evaluate(() => window.checkedManifest), '/__private-demo/manifest.json');
  assert.equal(await page.locator('#demo-play').isEnabled(), true);
  assert.equal(await page.locator('input[type="file"]').count(), 0, 'no import or save inputs');
  for (const width of [1366, 1024, 768, 540, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.screenshot({ path: '/tmp/kilo/hd-demo-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/kilo/hd-demo-mobile.png', fullPage: true });
  await page.route('https://www.youtube-nocookie.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Video fixture</title>' }));
  await page.locator('#demo-video-play').click();
  assert.equal(await page.locator('#demo-video-host iframe').count(), 1);
  await page.locator('#demo-play').click();
  assert.equal(await page.locator('#demo-video-host iframe').count(), 0, 'Starting the game stops the video');
  assert.equal(await page.locator('#demo-session').isVisible(), true);
  assert.equal(await page.locator('#demo-progress').getAttribute('value'), '35');
  await page.evaluate(() => { window.demoStatus('Checking cached files...', 12, 'loading'); window.demoStatus('Verifying the first room...', undefined, 'loading'); });
  assert.equal(await page.locator('#demo-progress').getAttribute('value'), '35', 'startup progress never reverses or becomes indeterminate');
  assert.equal(await page.locator('#demo-page').evaluate(node => node.inert), true);
  await page.locator('#demo-cancel').click();
  await page.locator('#demo-session').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#demo-play').evaluate(node => node === document.activeElement), true);
  assert.match(await page.locator('#demo-status').innerText(), /cancelled/);
  await visit('error');
  await page.locator('#demo-play').click();
  await page.getByRole('button', { name: 'Retry demo' }).waitFor();
  assert.match(await page.locator('#demo-status').innerText(), /download failed/);
  await visit('playing');
  await page.locator('#demo-play').click();
  assert.equal(await page.locator('#demo-loading').isHidden(), true);
  await page.evaluate(() => window.demoStatus('Downloading HD room 2...', 25, 'background'));
  assert.equal(await page.locator('#demo-loading').isHidden(), true, 'background prefetch cannot cover gameplay');
  assert.match(await page.locator('#demo-background-status').innerText(), /room 2.*25%/);
  await page.evaluate(() => window.demoStatus('Late startup status', 40, 'loading'));
  assert.equal(await page.locator('#demo-loading').isHidden(), true, 'late startup events cannot cover gameplay');
  await page.evaluate(() => window.demoStatus('Preparing HD room 2...', 40, 'room-loading'));
  assert.equal(await page.locator('#demo-loading').isVisible(), true);
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
  await page.evaluate(() => window.finishDemo());
  await page.getByRole('button', { name: 'Restart demo' }).waitFor();
  await page.locator('#demo-play').click();
  await page.locator('#demo-exit').click();
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
  console.log('HD demo UI: responsive layout, loading/cancel, retry/restart, exit, unavailable and unpublished states passed.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
