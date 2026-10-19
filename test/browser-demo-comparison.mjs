import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../web/', import.meta.url);
const requests = [];
const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', ttf: 'font/ttf' };
const server = createServer(async (request, response) => {
  requests.push(request.url);
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    // Isolate the comparison from demo availability and all game downloads.
    if (pathname === '/hd-demo/demo.js') return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('');
    if (pathname === '/original.svg' || pathname === '/hd.svg') {
      const previewPath = pathname === '/original.svg' ? process.env.ORIGINAL_PREVIEW_PATH : process.env.HD_PREVIEW_PATH;
      if (previewPath) return response.writeHead(200, { 'Content-Type': 'image/webp' }).end(await readFile(previewPath));
      const color = pathname === '/original.svg' ? '#95653d' : '#d0a26d';
      return response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="1416" height="1062"><path fill="${color}" d="M0 0h1416v1062H0z"/><circle cx="708" cy="531" r="200" fill="#463721"/></svg>`);
    }
    const file = new URL(`.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`, root);
    if (!file.href.startsWith(root.href)) throw new Error('Invalid path');
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[file.pathname.split('.').at(-1)] || 'application/octet-stream' }).end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/hd-demo/`);
  assert.equal(await page.locator('#comparison-status').isVisible(), true);
  await page.evaluate(async () => {
    const { initComparison } = await import('/hd-demo/comparison.js');
    window.cleanupComparison = initComparison({ originalURL: '/original.svg', hdURL: '/hd.svg' });
  });
  await page.locator('#comparison-stage[data-state="ready"]').waitFor();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
    const dimensions = await page.locator('#comparison-stage').evaluate(stage => {
      const a = document.getElementById('comparison-original').getBoundingClientRect();
      const b = document.getElementById('comparison-hd').getBoundingClientRect();
      return { ratio: stage.offsetWidth / stage.offsetHeight, same: a.width === b.width && a.height === b.height };
    });
    assert.ok(Math.abs(dimensions.ratio - 4 / 3) < .01);
    assert.equal(dimensions.same, true);
    if (process.env.ORIGINAL_PREVIEW_PATH && process.env.HD_PREVIEW_PATH && [1440, 390].includes(width)) {
      await page.screenshot({ path: `/tmp/kilo/hd-demo-redesign-${width}.png`, fullPage: true });
    }
  }
  await page.locator('#comparison-range').focus();
  for (const [key, expected] of [['Home', '0'], ['ArrowLeft', '0'], ['ArrowRight', '1'], ['End', '100'], ['ArrowRight', '100'], ['ArrowDown', '99']]) {
    await page.keyboard.press(key);
    assert.equal(await page.locator('#comparison-range').inputValue(), expected);
  }
  assert.equal(await page.locator('#comparison-original').evaluate(img => getComputedStyle(img).clipPath), 'inset(0px 1% 0px 0px)');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#comparison-stage').scrollIntoViewIfNeeded();
  const bounds = await page.locator('#comparison-stage').boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .5);
  assert.ok(Math.abs(Number(await page.locator('#comparison-range').inputValue()) - 25) < 1);
  assert.equal(await page.locator('#demo-play').isDisabled(), true, 'comparison never changes Play availability');
  await page.evaluate(async () => {
    window.cleanupComparison();
    const { initComparison } = await import('/hd-demo/comparison.js');
    initComparison({ originalURL: '/missing.webp', hdURL: '/hd.svg' });
  });
  await page.locator('#comparison-stage[data-state="error"]').waitFor();
  assert.equal(await page.locator('#comparison-original').isHidden(), true);
  assert.equal(await page.locator('#comparison-hd').isHidden(), true);
  assert.equal(await page.locator('#comparison-status').isVisible(), true);
  assert.equal(await page.locator('#comparison-range').isDisabled(), true);
  assert.deepEqual(errors, []);
  assert.equal(requests.some(url => /\.zip|\.blb|\.wasm|room-pack|manifest/.test(url)), false);
  console.log('Comparison browser checks passed: responsive 4:3 layers, keyboard, hover, missing previews, no game requests.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
