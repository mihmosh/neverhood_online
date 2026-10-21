import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const runDir = path.resolve(process.argv[2]);
assert(runDir.includes(`${path.sep}private-assets${path.sep}`), 'Private pilot directory required');
const readJson = file => readFile(file, 'utf8').then(JSON.parse);
const plan = await readJson(path.join(runDir, 'experiment.json'));
const bulk = process.argv.includes('--bulk');
assert.equal(plan.jobs.length, bulk ? plan.maximumRequests : 10);
const jobs = bulk ? [...plan.jobs, ...plan.reused] : plan.jobs;
assert.equal(new Set(jobs.map(job => job.requestHash)).size, jobs.length);
const finals = [];
for (const job of jobs) {
  const result = await readJson(job.resultPath ?? path.join(runDir, 'jobs', job.id, 'result.json'));
  assert.equal(result.requestHash, job.requestHash);
  if (result.status !== 'succeeded') continue;
  const image = result.images.filter(image => !image.thought && image.mimeType.startsWith('image/')).at(-1);
  const bytes = await readFile(image.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
  const metadata = JSON.parse(execFileSync('python3', ['-c',
    'import sys,io,json; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({"size":list(im.size),"mode":im.mode,"opaque":im.convert("RGBA").getchannel("A").getextrema()==(255,255)}))'], { input: bytes, encoding: 'utf8' }));
  assert.deepEqual(metadata.size, image.dimensions ?? [2400, 1792]);
  assert(metadata.opaque, 'Opaque room output required');
  finals.push({ roomId: job.roomId, ...metadata, sha256: image.sha256 });
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
const checks = [];
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(runDir, 'report.html')).href, { waitUntil: 'load' });
    await page.evaluate(() => { for (const image of document.images) image.loading = 'eager'; return Promise.all([...document.images].map(image => image.decode().catch(() => {}))); });
    assert.equal(await page.locator('img').evaluateAll(images => images.filter(image => !image.complete || !image.naturalWidth).length), 0);
    for (const room of plan.rooms) assert(await page.locator('h2').filter({ hasText: room.id }).count());
    const comparison = page.locator('section.comparison').first();
    const source = bulk ? '.source' : '.original';
    const restored = bulk ? '.candidate' : '.restored';
    await comparison.getByRole('button', { name: 'A: original', exact: true }).click();
    assert(await comparison.locator(source).isVisible());
    assert(!await comparison.locator(restored).isVisible());
    await comparison.getByRole('button', { name: 'B: result', exact: true }).click();
    assert(!await comparison.locator(source).isVisible());
    assert(await comparison.locator(restored).isVisible());
    await comparison.getByRole('button', { name: 'Side by side', exact: true }).click();
    assert(await comparison.locator(source).isVisible());
    assert(await comparison.locator(restored).isVisible());
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${name}: no horizontal overflow`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(runDir, `report-${name}.png`) });
    checks.push({ name, width, height, brokenImages: 0, overflow: false, abAndSideBySide: true, errors });
    await page.close();
  }
} finally { await browser.close(); }
const result = { schemaVersion: 1, successfulFinalImages: finals.length, finals, browser: checks };
await writeFile(path.join(runDir, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
