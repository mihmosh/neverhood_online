import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', reducedMotion: 'reduce' });
  await page.goto(process.env.TEST_ORIGIN || 'http://127.0.0.1:4173');
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(root, 'docs/images/onboarding.png'), fullPage: true });
  console.log('Captured the client interface only, without importing or displaying game assets.');
} finally { await browser.close(); }
