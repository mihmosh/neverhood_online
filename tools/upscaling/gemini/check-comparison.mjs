import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [url, screenshotDirectory = '/tmp/kilo'] = process.argv.slice(2);
if (!url) throw Error('Usage: node check-comparison.mjs URL [SCREENSHOT_DIRECTORY]');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  for (const [label, width, height] of [['desktop', 1360, 960], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', locale: 'ru-RU' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.comparisonReady);
    assert.equal(await page.locator('.chapter').count(), 2);
    assert.equal(await page.locator('.card').count(), 6);
    assert.equal(await page.locator('.rejection').count(), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: horizontal overflow`);
    const interactions = await page.evaluate(() => {
      const room = document.querySelector('.chapter');
      const a = room.querySelector('[data-select=a]'), b = room.querySelector('[data-select=b]');
      const choices = room.querySelectorAll('[data-pick]');
      choices[1].click();
      if (b.value !== choices[1].dataset.pick) return false;
      room.querySelector('[data-mode=side]').click();
      if (room.querySelector('.viewer').dataset.mode !== 'side') return false;
      const oldA = a.value, oldB = b.value;
      room.querySelector('.swap').click();
      if (a.value !== oldB || b.value !== oldA) return false;
      const region = room.querySelector('.region-picker select');
      region.selectedIndex = 1;
      region.dispatchEvent(new Event('change'));
      if (!room.querySelector('[data-crop=a]').src.includes(region.value)) return false;
      room.querySelector('[data-mode=wipe]').click();
      const slider = room.querySelector('input[type=range]');
      slider.value = 73;
      slider.dispatchEvent(new Event('input'));
      return room.querySelector('.viewer').style.getPropertyValue('--split') === '73%';
    });
    assert.equal(interactions, true, `${label}: comparison controls`);
    const broken = await page.evaluate(async () => {
      document.querySelectorAll('img').forEach(image => image.loading = 'eager');
      await Promise.all([...document.images].map(image => image.decode().catch(() => null)));
      return [...document.images].filter(image => !image.naturalWidth).map(image => image.src);
    });
    assert.deepEqual(broken, [], `${label}: broken images`);
    assert.deepEqual(errors, [], `${label}: JavaScript errors`);
    await page.evaluate(() => scrollTo(0, 0));
    const screenshot = path.join(screenshotDirectory, `gemini-comparison-${label}.png`);
    await page.screenshot({ path: screenshot });
    await page.locator('.viewer').first().screenshot({ path: path.join(screenshotDirectory, `gemini-comparison-${label}-viewer.png`) });
    console.log(JSON.stringify({ viewport: label, width, controls: 'passed', images: 'loaded', screenshot }));
    await page.close();
  }
} finally {
  await browser.close();
}
