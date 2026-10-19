import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';

const { chromium, firefox } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const usingFirefox = process.env.TEST_BROWSER === 'firefox';
const browser = await (usingFirefox ? firefox.launch({ headless: true }) : chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true }));
const real = process.env.REAL_YOUTUBE === '1';
const report = { realYouTube: real, errors: [], thirdPartyRequests: [] };
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => { if (Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'credentialless')?.configurable) delete HTMLIFrameElement.prototype.credentialless; });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => { if (/youtube|ytimg|googlevideo/.test(new URL(request.url()).hostname)) report.thirdPartyRequests.push(request.url()); });
  if (!real) await page.route('https://www.youtube-nocookie.com/embed/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Video embed fixture</title><button id="video-ready">Video ready</button>' }));
  await page.goto(`${process.env.TEST_ORIGIN || 'http://127.0.0.1:4191'}/hd-demo/`);
  await page.locator('#demo-actions[aria-busy="false"]').waitFor();
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  assert.equal(await page.evaluate(() => 'credentialless' in HTMLIFrameElement.prototype), false);
  assert.equal(await page.locator('#demo-video-host iframe').count(), 1);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const embed = page.locator('#demo-video-host iframe');
  await embed.scrollIntoViewIfNeeded();
  assert.equal(await embed.evaluate(frame => !!frame.credentialless), false);
  assert.equal(await embed.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  assert.equal(await page.evaluate(() => crossOriginIsolated), false);
  await page.waitForFunction(() => document.querySelector('#demo-video-host iframe')?.contentWindow !== null);
  if (!real) await page.frameLocator('#demo-video-host iframe').locator('#video-ready').waitFor({ timeout: 30000 });
  else {
    const frame = await (await embed.elementHandle()).contentFrame();
    await frame.waitForLoadState('domcontentloaded', { timeout: 45000 });
    report.playerURL = frame.url();
    await frame.getByRole('button', { name: /play/i }).first().click({ timeout: 15000 });
    await frame.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 2 && !video.paused && video.currentTime >= 1; }, null, { timeout: 45000 });
    report.video = await frame.evaluate(() => ({ readyState: document.querySelector('video')?.readyState, currentTime: document.querySelector('video')?.currentTime }));
  }
  await page.screenshot({ path: `/tmp/kilo/hd-demo-video-${real ? 'real' : 'fixture'}.png`, fullPage: true });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, realYouTube: real, standardIframe: true, video: report.video }, null, 2));
} catch (error) {
  report.error = error.stack;
  report.frameText = await Promise.all(page.frames().filter(frame => /youtube/.test(frame.url())).map(async frame => ({ url: frame.url(), text: await frame.locator('body').innerText().catch(() => '') })));
  console.error(error); process.exitCode = 1;
}
finally { await writeFile(`/tmp/kilo/hd-demo-video-${real ? 'real' : 'fixture'}-${usingFirefox ? 'firefox' : 'chrome'}-report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
