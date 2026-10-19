import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const directory = '/home/mosha/neverhood-upscaling/data/animation-tests/comparison-v1';
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
assert.equal(manifest.completedSequences, 20);
assert.equal(manifest.comparedSourceFrames, 464);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith('file:')) requests.push(request.url()); });
  await page.goto(pathToFileURL(`${directory}/index.html`).href);
  await page.waitForFunction(() => Object.values(window.animationPlayers).length === 20 &&
    Object.values(window.animationPlayers).every(player => player.ready), null, { timeout: 120000 });
  assert.equal(await page.locator('canvas').count(), 20);
  const firstResource = manifest.sequences[0].resource;
  const original = await page.evaluate(id => window.animationPlayers[id].index, firstResource);
  await page.waitForFunction(({ id, index }) => window.animationPlayers[id].index !== index, { id: firstResource, index: original });
  await page.locator('#pause-all').click();
  const paused = await page.evaluate(() => Object.values(window.animationPlayers).map(player => player.index));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => Object.values(window.animationPlayers).map(player => player.index)), paused);
  for (let i = 0; i < 20; i++) {
    const id = await page.locator('[data-step]').nth(i).getAttribute('data-step');
    const before = await page.evaluate(id => {
      const player = window.animationPlayers[id];
      return { index: player.index, length: player.images.length };
    }, id);
    await page.locator('[data-step]').nth(i).click();
    const after = await page.evaluate(id => window.animationPlayers[id].index, id);
    assert.equal(after, (before.index + 1) % before.length);
  }
  await page.locator('#background').selectOption('light');
  assert.equal(await page.locator('canvas').first().evaluate(canvas => getComputedStyle(canvas).backgroundColor), 'rgb(238, 238, 238)');
  await page.locator('#background').selectOption('dark');
  assert.equal(await page.locator('canvas').first().evaluate(canvas => getComputedStyle(canvas).backgroundColor), 'rgb(17, 17, 17)');
  await page.locator('#background').selectOption('checker');
  await page.locator('[data-seek]').first().evaluate(input => {
    input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(id => window.animationPlayers[id].index, firstResource), 0);
  await page.locator('#play-all').click();
  await page.waitForFunction(id => window.animationPlayers[id].index !== 0, firstResource);
  await page.locator('#pause-all').click();
  assert.deepEqual(await page.evaluate(() => window.loadingErrors), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  const report = { sequences: 20, sourceFrames: 464, neuralFrames: 928,
    readyPlayers: await page.evaluate(() => Object.values(window.animationPlayers).filter(player => player.ready).length),
    loadedFrameImages: await page.evaluate(() => Object.values(window.animationPlayers).reduce((n, player) => n + player.images.length * 3, 0)),
    playback: true, pauseAll: true, stepAll: true, seek: true, backgrounds: true, errors, externalRequests: requests };
  await writeFile(`${directory}/browser-verification.json`, JSON.stringify(report, null, 2));
  await page.locator('h1').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/browser-review.png` });
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
