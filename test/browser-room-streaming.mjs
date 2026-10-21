import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/tmp/kilo/node_modules/playwright');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4206';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
await context.addInitScript(() => {
  window.streamPerformance = { tasks: [], gaps: [], interactiveAt: Infinity };
  new PerformanceObserver(list => { for (const entry of list.getEntries()) window.streamPerformance.tasks.push({ at: entry.startTime, ms: entry.duration }); }).observe({ type: 'longtask', buffered: true });
  let last;
  requestAnimationFrame(function next(at) {
    if (last !== undefined && window.streamPerformance.gaps.length < 30000) window.streamPerformance.gaps.push({ at, ms: at - last });
    last = at; requestAnimationFrame(next);
  });
});
const page = await context.newPage(), report = { errors: [], logs: [], stages: [], requests: [] };
page.on('pageerror', error => report.errors.push(error.message));
page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.logs.push(message.text()); });
context.on('request', request => {
  if (/\.blb|\.zip(?:$|\?)/.test(request.url())) report.requests.push({ url: request.url(), range: request.headers().range });
});
context.on('requestfailed', request => report.logs.push(`FAILED ${request.url()}: ${request.failure()?.errorText}`));
const serverStats = async () => (await fetch(`${origin}/__stream-stats`)).json();
const baseline = await serverStats();
let frame;
async function ticks(count) {
  const start = await frame.evaluate(() => roomRendererPrototype.stats().engineFrames);
  await frame.waitForFunction(({ start, count }) => roomRendererPrototype.stats().engineFrames >= start + count,
    { start, count }, { timeout: Math.max(30000, count * 200) });
}
async function click(x, y) {
  const box = await frame.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + box.width * x / 640, box.y + box.height * y / 480);
  if (await frame.evaluate(() => window.originalStreaming?.stats().native?.sceneType === 2)) await page.waitForTimeout(80);
  else await ticks(5);
  await page.mouse.click(box.x + box.width * x / 640, box.y + box.height * y / 480, { delay: 60 });
}
async function capture(name) {
  const state = await frame.evaluate(() => ({ renderer: roomRendererPrototype.stats(), originals: originalStreaming.stats(),
    isolated: crossOriginIsolated, memory: performance.memory?.usedJSHeapSize,
    performance: { maxInteractiveTask: Math.max(0, ...streamPerformance.tasks.filter(t => t.at >= streamPerformance.interactiveAt).map(t => t.ms)),
      maxInteractiveGap: Math.max(0, ...streamPerformance.gaps.filter(t => t.at >= streamPerformance.interactiveAt).map(t => t.ms)) } }));
  const network = await serverStats();
  const stage = { name, ...state, originalBytes: network.original.bytes - baseline.original.bytes,
    hdBytes: network.hd.bytes - baseline.hd.bytes, elapsed: performance.now() - report.started };
  report.stages.push(stage);
  await page.screenshot({ path: `/tmp/kilo/neverhood-integrated-stream-${name}.png` });
  console.log(JSON.stringify({ name, room: state.renderer.activeRoom, hd: state.renderer.hdDraws, ...state.originals,
    originalBytes: stage.originalBytes, hdBytes: stage.hdBytes }));
  await writeFile('/tmp/kilo/neverhood-integrated-stream-report.json', JSON.stringify(report, null, 2));
  return stage;
}
try {
  report.started = performance.now();
  await page.goto(`${origin}/hd-demo/`);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.locator('#demo-play').click({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.src.includes('/player.html?')), null, { timeout: 30000 });
  frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  for (let i = 0; i < 160; i++) {
    if (!frame || frame.isDetached()) throw new Error(`Player frame closed: ${await page.locator('#demo-status').textContent()}`);
    const state = await frame.evaluate(() => window.roomRendererPrototype?.stats());
    if (state?.hdDraws > 0) break;
    await frame.locator('#canvas').press('Space'); await page.waitForTimeout(300);
  }
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 60000 });
  const first = await capture('room1');
  await frame.evaluate(() => { streamPerformance.interactiveAt = performance.now(); });
  assert.equal(first.isolated, true); assert.equal(first.originals.terminal, false);
  assert(first.renderer.hdDraws > 0); assert(first.originalBytes < 32 * 1024 ** 2);
  await click(300, 300); await ticks(140);
  for (let i = 0; i < 3; i++) { await click(75, 360); await ticks(180); }
  await click(556, 327);
  await frame.waitForFunction(() => roomRendererPrototype.stats().activeRoom === 'Scene1002', null, { timeout: 60000 });
  await frame.waitForFunction(() => roomRendererPrototype.stats().hdDraws > 0 && !originalStreaming.stats().preparing, null, { timeout: 60000 });
  await capture('room2');
  if (process.env.MOVIE) {
    await click(300, 430); await ticks(240);
    await click(100, 435); await ticks(180);
    for (const plantX of [174, 206, 238, 270, 302, 334]) { await click(plantX, 410); await ticks(180); }
    await capture('plant-ready');
    await click(370, 120); await ticks(180);
    await click(580, 350);
    await frame.waitForFunction(() => originalStreaming.stats().native?.module === 2300 && originalStreaming.stats().native?.smacker, null, { timeout: 60000 });
    await frame.waitForFunction(() => !originalStreaming.stats().preparing, null, { timeout: 60000 });
    const movie = await capture('navigation-video');
    assert.equal(movie.originals.native.sceneType, 2);
    assert.equal(movie.renderer.hdDraws, 0, 'Native navigation video must not be replaced with HD background');
    assert(movie.originals.readyVideos.includes('2028a041'));
    report.movieReads = await frame.evaluate(() => originalStreaming.trace().filter(read => read.name === 't.blb' && read.position < 96894936 && read.position + read.bytes > 96791928));
    assert(report.movieReads.length > 0, 'The original entry Smacker bytes must actually be read');
    assert.equal(movie.originals.terminal, false);
    assert.equal(movie.originals.synchronousMisses, 0);
    assert(report.requests.every(request => request.range));
    assert.deepEqual(report.errors, []);
    console.log('Native navigation movie 2028A041 verified with original bytes.');
  } else {
  await click(300, 430); await ticks(240); await click(297, 120); await ticks(180);
  await click(480, 435); await ticks(180); await click(64, 420);
  await frame.waitForFunction(() => roomRendererPrototype.stats().activeRoom === 'Scene1004', null, { timeout: 60000 });
  await frame.waitForFunction(() => roomRendererPrototype.stats().hdDraws > 0 && !originalStreaming.stats().preparing, null, { timeout: 60000 });
  await capture('room3');
  await context.setOffline(true);
  const beforeReturn = await serverStats();
  await click(230, 120); await ticks(240);
  await frame.waitForFunction(() => roomRendererPrototype.stats().activeRoom === 'Scene1002' && roomRendererPrototype.stats().hdDraws > 0, null, { timeout: 60000 });
  const returned = await capture('offline-return');
  const afterReturn = await serverStats();
  assert.equal(afterReturn.original.bytes, beforeReturn.original.bytes);
  assert.equal(afterReturn.hd.bytes, beforeReturn.hd.bytes);
  assert.equal(returned.originals.terminal, false);
  assert(report.stages.every(stage => stage.renderer.errors === 0 && stage.renderer.mismatches === 0));
  assert(report.requests.every(request => request.range), 'No complete BLB or HD ZIP download is permitted');
  assert.deepEqual(report.errors, []);
  }
} catch (error) {
  report.failure = error.stack;
  await page.screenshot({ path: '/tmp/kilo/neverhood-integrated-stream-error.png' }).catch(() => {});
  report.finalState = await frame?.evaluate(() => ({ renderer: window.roomRendererPrototype?.stats(), originals: window.originalStreaming?.stats() })).catch(() => null);
  console.error(report.logs.join('\n'));
  throw error;
} finally {
  await writeFile('/tmp/kilo/neverhood-integrated-stream-report.json', JSON.stringify(report, null, 2));
  await browser.close();
}
