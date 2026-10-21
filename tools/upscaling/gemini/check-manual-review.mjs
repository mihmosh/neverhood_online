import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const run = path.resolve(process.argv[2]);
assert(run.includes(`${path.sep}private-assets${path.sep}`));
const data = JSON.parse(await readFile(path.join(run, 'manual-review-data.json'), 'utf8'));
const generic = process.argv.includes('--generic');
const roomCount = new Set(data.rooms.map(r => r.roomId)).size;
const availableRooms = new Set(data.rooms.filter(r => r.available).map(r => r.roomId)).size;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
  downloadsPath: run, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const results = [];
const button = (page, room) => page.locator(`button.room[data-room=${JSON.stringify(room.id)}]`);
async function imagesReady(page) {
  const images = await page.evaluate(async () => {
    const images = ['imageA', 'imageB'].map(id => document.getElementById(id)).filter(img => !img.hidden && img.hasAttribute('src'));
    for (const image of images) image.loading = 'eager';
    await Promise.all(images.map(image => image.decode()));
    return images.map(image => ({ width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }));
  });
  assert(images.every(image => image.width > 0 && image.height > 0 && image.complete));
}
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, acceptDownloads: true });
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(run, 'review.html')).href, { waitUntil: 'load' });
    await imagesReady(page);
    assert((await page.locator('#summary').textContent()).includes(`${availableRooms} / ${roomCount} сцен`));
    await page.locator('#search').fill(generic ? 'HallOfRecordsScene' : 'зал славы');
    assert.equal(await page.locator('button.room').count(), generic ? data.rooms.filter(r => r.roomId.startsWith('HallOfRecordsScene')).length : 1);
    if (!generic) assert((await page.locator('button.room').textContent()).includes('Scene2810'));
    await page.locator('button.room').first().click();
    await imagesReady(page);
    await page.locator('#search').fill('');
    const visited = [];
    for (const room of data.rooms) {
      await button(page, room).click();
      await imagesReady(page);
      assert.equal(await page.locator('#approve').isDisabled(), !room.canApprove);
      visited.push(room.id);
    }
    assert.equal(new Set(visited).size, data.rooms.length);
    const newer = generic ? data.rooms.filter(r => r.available)[1] : data.rooms.find(r => r.roomId === 'Scene1201-4019A2C4' && r.origin === 'new');
    const older = generic ? data.rooms.find(r => r.available) : data.rooms.find(r => r.roomId === newer?.roomId && r.origin === 'historical' && r.available);
    assert(newer && older && newer.output.sha256 !== older.output.sha256);
    await button(page, newer).click();
    if (!generic) await page.locator('#compareVersion').selectOption(older.id);
    await imagesReady(page);
    assert.equal(await page.locator('#imageA').getAttribute('src'), generic ? newer.source.url : older.output.url);
    assert.equal(await page.locator('#imageB').getAttribute('src'), newer.output.url);
    await page.getByRole('button', { name: 'Только A', exact: true }).click();
    assert(await page.locator('#figureA').isVisible());
    assert(!await page.locator('#figureB').isVisible());
    await page.getByRole('button', { name: 'Только B', exact: true }).click();
    assert(!await page.locator('#figureA').isVisible());
    assert(await page.locator('#figureB').isVisible());
    await page.getByRole('button', { name: 'A / B', exact: true }).click();
    await button(page, older).click();
    await page.locator('#notes').fill('Automated smoke test; not a user decision');
    await page.getByRole('button', { name: 'Принять', exact: true }).click();
    await page.reload({ waitUntil: 'load' });
    await button(page, older).click();
    assert.equal(await page.locator('#approve').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#notes').inputValue(), 'Automated smoke test; not a user decision');
    await button(page, newer).click();
    assert.equal(await page.locator('#defer').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#notes').inputValue(), '');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт JSON', exact: true }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let text = '';
    for await (const chunk of stream) text += chunk;
    const exported = JSON.parse(text);
    assert.equal(exported.manifestSha256, data.manifestSha256);
    assert.equal(exported.candidates.length, data.rooms.length);
    assert.equal(exported.decisions.find(item => item.id === older.id).decision, 'approved');
    assert.equal(exported.decisions.find(item => item.id === newer.id).decision, 'pending');
    await download.delete();
    await page.locator('#importFile').setInputFiles({ name: 'stale.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...exported, manifestSha256: 'stale' })) });
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('отклонён'));
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload({ waitUntil: 'load' });
    const oldIdentity = { id: older.roomId, candidateId: older.candidateId, sourceSha256: older.source.sha256, outputSha256: older.output.sha256 };
    await page.locator('#migrate').check();
    await page.locator('#importFile').setInputFiles({ name: 'old-artifact.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      schemaVersion: 1, manifestSha256: 'historical-test-manifest', candidates: [oldIdentity],
      decisions: [{ ...oldIdentity, decision: 'approved', notes: 'Explicit migration smoke test' }],
    })) });
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('Импорт проверен'));
    await button(page, older).click();
    assert.equal(await page.locator('#approve').getAttribute('aria-pressed'), 'true');
    await button(page, newer).click();
    assert.equal(await page.locator('#defer').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload({ waitUntil: 'load' });
    await page.locator('#search').fill(generic ? (name === 'desktop' ? 'HallOfRecordsScene' : 'Scene1402') : (name === 'desktop' ? 'зал славы' : 'Scene1201-4019A2C4'));
    await page.locator('button.room').first().click();
    await imagesReady(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(run, `manual-review-${name}.png`) });
    results.push({ name, width, height, visitedCandidates: visited.length, uniqueRooms: roomCount,
      brokenActiveImages: 0, horizontalOverflow: false, sourceSearch: true, searchHall: !generic, versionComparison: !generic,
      decisionsAndNotesPersist: true, exportValid: true, staleImportRejected: true,
      explicitMigrationPreservesOldArtifactOnly: true, testDecisionsCleared: true });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(run, 'manual-review-verification.json'), JSON.stringify({ schemaVersion: 1, results }, null, 2) + '\n');
console.log(JSON.stringify({ results }, null, 2));
