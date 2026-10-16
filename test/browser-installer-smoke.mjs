import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const exe = process.env.INSTALLER_EXE;
const bin = process.env.INSTALLER_BIN;
if (!exe || !bin) throw new Error('Set INSTALLER_EXE and INSTALLER_BIN for the installer fault tests.');
const profile = await mkdtemp(join(tmpdir(), 'neverhood-installer-faults-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const page = await context.newPage();
const errors = [];
const uploads = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url()); });

async function run(mode) {
  return page.evaluate(async mode => {
    const { importInstaller, discoverExtractor } = await import('/lib/installer.js');
    const controller = new AbortController();
    let files = [...document.getElementById('test-files').files];
    if (mode === 'missing') files = files.filter(file => /\.exe$/i.test(file.name));
    if (mode === 'quota') navigator.storage.estimate = async () => ({ quota: 1, usage: 0 });
    try {
      const result = await importInstaller(files, progress => {
        if (mode === 'cancel' && progress.phase === 'extract') controller.abort();
      }, { signal: controller.signal, descriptor: (await discoverExtractor()).descriptor });
      return { total: result.total, directory: result.directory };
    } catch (error) { return { error: error.name, message: error.message }; }
    finally { if (mode === 'quota') delete navigator.storage.estimate; }
  }, mode);
}

try {
  await page.goto(process.env.TEST_ORIGIN || 'http://127.0.0.1:4173');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'test-files'; input.type = 'file'; input.multiple = true; input.hidden = true;
    document.body.append(input);
  });
  await page.locator('#test-files').setInputFiles([exe, bin]);
  const baseline = await run('valid');
  assert.equal(baseline.total, 638122574, JSON.stringify(baseline));
  for (const mode of ['missing', 'cancel', 'quota']) {
    const result = await run(mode);
    assert.ok(result.error, `${mode}: expected a failure`);
    if (mode === 'cancel') assert.equal(result.error, 'AbortError');
    if (mode === 'quota') assert.equal(result.error, 'QuotaExceededError');
    const state = await page.evaluate(async () => {
      const library = await (await import('/lib/storage.js')).getLibrary();
      const root = await navigator.storage.getDirectory();
      const stage = await root.getDirectoryHandle('neverhood-installer-staging-v1');
      const temporary = [];
      for await (const name of stage.keys()) temporary.push(name);
      return { directory: library.directory, temporary };
    });
    assert.equal(state.directory, baseline.directory);
    assert.deepEqual(state.temporary, []);
    console.log(`${mode}: previous library preserved, temporary output removed`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(uploads, []);
  console.log('Installer fault tests passed with real browser File inputs');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
