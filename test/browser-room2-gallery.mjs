import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const root = '/home/mosha/neverhood-upscaling/data/room2-hd/baselines-v1';
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], external = [], failed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith('file:')) external.push(request.url()); });
  page.on('requestfailed', request => failed.push(request.url()));
  await page.goto(pathToFileURL(`${root}/index.html`).href);
  await page.waitForFunction(() => Object.keys(window.room2Players || {}).length === 106);
  assert.equal(await page.locator('canvas').count(), 106);
  const selected = [
    ['ring', false], ['flytrap', false], ['ladder-hands', false], ['peek-hand', false], ['Klaymen', true], ['Klaymen', false],
    ['Klaymen', true, '242c0198'], ['Klaymen', false, '242c0198'],
  ];
  const reviewed = [];
  for (const [actor, upper, resource] of selected) {
    const index = manifest.cases.findIndex(item => item.actor === actor && item.remove64 === upper &&
      item.frames.length > 2 && (!resource || item.resource === resource));
    assert.ok(index >= 0);
    const item = manifest.cases[index];
    await page.locator('canvas').nth(index).scrollIntoViewIfNeeded();
    await page.waitForFunction(id => {
      const p = window.room2Players[id], images = p.cache.get(p.index);
      return p.visible && images?.every(image => image.complete && image.naturalWidth > 0);
    }, item.id);
    const current = await page.evaluate(id => window.room2Players[id].index, item.id);
    await page.waitForFunction(({ id, current }) => window.room2Players[id].index !== current, { id: item.id, current });
    const state = await page.evaluate(id => {
      const p = window.room2Players[id];
      return { visible: p.visible, frame: p.index, cachedPairs: p.cache.size,
        otherHiddenCaches: Object.entries(window.room2Players).filter(([key, p]) => key !== id && !p.visible && p.cache.size > 0).length };
    }, item.id);
    assert.ok(state.cachedPairs <= 4); assert.equal(state.otherHiddenCaches, 0);
    await page.locator('#pause').evaluate(button => button.click());
    const paused = await page.evaluate(id => window.room2Players[id].index, item.id);
    await page.evaluate(() => new Promise(resolve => {
      const until = performance.now() + 300;
      const next = () => performance.now() >= until ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next);
    }));
    assert.equal(await page.evaluate(id => window.room2Players[id].index, item.id), paused);
    await page.locator('#pause').evaluate(button => button.click());
    reviewed.push({ id: item.id, resource: item.resource, frames: item.frames.length, ...state });
    if (actor === 'flytrap' || resource === '242c0198') {
      await page.screenshot({ path: `${root}/browser-${actor === 'flytrap' ? 'flytrap' : upper ? 'walking-upper' : 'walking-normal'}.png` });
    }
  }
  await page.screenshot({ path: `${root}/browser-review.png` });
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(failed, []);
  const report = { passed: true, contexts: 106, requestedResources: 69, uniqueNeuralOutputs: 2071,
    reviewed, cacheBoundPairs: 4, errors, externalRequests: external, failedRequests: failed, enabledInGame: false };
  await writeFile(`${root}/browser-verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
