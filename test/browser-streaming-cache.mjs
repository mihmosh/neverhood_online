import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createStreamingServer } from '../scripts/serve-streaming-demo.mjs';
import { REQUIRED_FILES } from '../web/lib/validation.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/tmp/kilo/node_modules/playwright');
const directory = process.env.NEVERHOOD_STREAMING_DIR || '/home/mosha/neverhood/private-assets/upscaling/gemini-review-all/streaming-demo-graph-local-20261021T201100Z';
const reportPath = '/tmp/kilo/browser-streaming-cache-report.json';
const cacheName = 'neverhood-verified-original-blocks-v1';
const report = { directory, started: new Date().toISOString(), stages: [], requests: [], responses: [],
  pageErrors: [], logs: [], workers: [], claims: { offlineScope: 'Original byte endpoints blocked; app shell, index and HD remain online.',
    quota: 'Not browser-injected; covered by original-streaming-worker.test.mjs.',
    failure: 'Real startup prefetch network failure and Retry UI, not an injected native synchronous-read failure.' } };
let server, browser, phase = 'setup';
const started = performance.now();
const originalURL = url => new URL(url).pathname.startsWith('/__stream-original/');
const flush = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { console.error('Browser cache proof exceeded 170 seconds'); process.exitCode = 1; void browser?.close(); }, 170000);

async function stats() { return (await fetch(`${report.origin}/__stream-stats`)).json(); }

async function newPage(context) {
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
  page.on('pageerror', error => report.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) report.logs.push({ phase, type: message.type(), message: message.text() });
  });
  page.on('worker', worker => report.workers.push({ phase, url: worker.url() }));
  return page;
}

function observe(context) {
  context.on('request', request => {
    if (originalURL(request.url()) || /\.blb$/.test(new URL(request.url()).pathname)) {
      report.requests.push({ phase, url: request.url(), range: request.headers().range });
    }
  });
  context.on('response', response => {
    if (originalURL(response.url())) report.responses.push({ phase, url: response.url(), status: response.status(),
      requestedRange: response.request().headers().range,
      range: response.headers()['content-range'], length: response.headers()['content-length'] });
  });
}

async function shell(page) {
  await page.goto(`${report.origin}/hd-demo/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#demo-play').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#demo-play').disabled, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
}

async function playable(page, name) {
  phase = name;
  const before = await stats(), at = performance.now();
  await page.locator('#demo-play').click({ timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.src.includes('/player.html?')), null, { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame =>
    frame.src.includes('/player.html?') && frame.contentWindow?.location.pathname === '/player.html'), null, { timeout: 15000 });
  const frame = page.frames().find(frame => frame.url().includes('/player.html?'));
  const timeout = performance.now() + 40000;
  for (;;) {
    if (frame.isDetached()) throw new Error(`Player closed during ${name}: ${await page.locator('#demo-status').textContent()}`);
    const ready = await frame.evaluate(() => {
      const renderer = window.roomRendererPrototype?.stats(), originals = window.originalStreaming?.stats();
      return renderer?.hdDraws > 0 && originals?.native?.id === '1000:0' && !originals.preparing;
    });
    if (ready) break;
    assert(performance.now() < timeout, `${name}: first native room did not become playable`);
    if (await frame.locator('#canvas').count()) await frame.locator('#canvas').press('Space', { timeout: 2000 });
    await page.waitForTimeout(200);
  }
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 15000 });
  // Native Screen._ticks is observed read-only; never infer native progress from intro HD frame counts.
  const tick = await frame.evaluate(() => originalStreaming.stats().native.tick);
  await frame.waitForFunction(tick => originalStreaming.stats().native.tick !== tick, tick, { timeout: 10000 });
  const state = await frame.evaluate(names => {
    const backing = names.map(name => {
      const node = Module.FS.lookupPath(`/game/${name}`).node;
      return { name, size: Module.FS.stat(`/game/${name}`).size, backingBytes: node.contents?.byteLength ?? node.contents?.length ?? 0 };
    });
    return { renderer: roomRendererPrototype.stats(), originals: originalStreaming.stats(), backing,
      isolated: crossOriginIsolated, wasmMemoryBytes: HEAPU8.byteLength };
  }, REQUIRED_FILES);
  const after = await stats();
  const stage = { name, elapsedMs: performance.now() - at, ...state,
    originalNetworkBytes: after.original.bytes - before.original.bytes,
    originalNetworkRequests: after.original.requests - before.original.requests,
    hdNetworkBytes: after.hd.bytes - before.hd.bytes };
  report.stages.push(stage);
  assert.equal(state.isolated, true); assert.equal(state.originals.terminal, false);
  assert.equal(state.originals.synchronousMisses, 0);
  assert.equal(state.renderer.errors, 0); assert.equal(state.renderer.mismatches, 0);
  assert(state.renderer.hdDraws > 0); assert(state.renderer.verified > 0);
  assert.equal(state.backing.reduce((sum, file) => sum + file.backingBytes, 0), 0, 'Sparse BLBs must not allocate whole-file backing');
  assert(state.originals.maxMemoryBytes < 128 * 1024 ** 2);
  await page.screenshot({ path: `/tmp/kilo/browser-streaming-cache-${name}.png` });
  console.log(JSON.stringify({ name, elapsedMs: stage.elapsedMs, room: state.originals.native.id,
    hd: state.renderer.hdDraws, originalNetworkBytes: stage.originalNetworkBytes,
    cacheHits: state.originals.cacheHits, corruptions: state.originals.corruptions ?? 0 }));
  await flush();
  return stage;
}

try {
  server = await createStreamingServer({ directory });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  observe(context);
  let page = await newPage(context);
  await shell(page);
  assert.equal(await page.evaluate(name => caches.has(name), cacheName), false, 'Fresh browser context must start without original cache');
  const cold = await playable(page, 'cold');
  assert(cold.originalNetworkBytes > 0 && cold.originalNetworkBytes < 32 * 1024 ** 2);

  // Closing the page kills its iframe and module worker, without clearing the context's CacheStorage.
  await page.close({ runBeforeUnload: false });
  const blocked = [];
  const blockOriginal = route => { blocked.push({ phase, url: route.request().url() }); return route.abort('internetdisconnected'); };
  await context.route('**/__stream-original/**', blockOriginal);
  page = await newPage(context); await shell(page);
  const warm = await playable(page, 'warm-original-endpoints-blocked');
  assert(warm.originals.cacheHits > 0);
  assert.equal(warm.originalNetworkBytes, 0); assert.equal(warm.originalNetworkRequests, 0);
  assert.equal(blocked.length, 0, 'Verified warm startup must not even attempt an original network fetch');
  assert.equal(warm.renderer.activeRoom, cold.renderer.activeRoom);
  assert.equal(warm.originals.native.sceneType, cold.originals.native.sceneType);
  await page.close({ runBeforeUnload: false });
  await context.unroute('**/__stream-original/**', blockOriginal);

  page = await newPage(context); await shell(page);
  report.corruptedEntry = await page.evaluate(async name => {
    const index = await (await fetch('/__private-demo/streaming-index.json')).json();
    const ref = index.bootstrap[0], hash = index.files[ref.name].hashes[ref.index];
    const cache = await caches.open(name);
    const key = (await cache.keys()).find(key => key.url.endsWith(`/${hash}`));
    if (!key) throw new Error('Cold startup did not persist the selected bootstrap block');
    const response = await cache.match(key), bytes = new Uint8Array(await response.arrayBuffer());
    bytes[Math.floor(bytes.length / 2)] ^= 255;
    await cache.put(key, new Response(bytes, { headers: response.headers }));
    return { url: key.url, hash, name: ref.name, index: ref.index, bytes: bytes.length,
      declaredLength: response.headers.get('Content-Length') };
  }, cacheName);
  assert.equal(Number(report.corruptedEntry.declaredLength), report.corruptedEntry.bytes);
  const repaired = await playable(page, 'corrupt-cache-repaired');
  assert.equal(repaired.originals.corruptions, 1);
  assert.equal(repaired.originalNetworkRequests, 1);
  assert.equal(repaired.originalNetworkBytes, report.corruptedEntry.bytes);
  assert.equal(repaired.renderer.activeRoom, cold.renderer.activeRoom);
  assert.equal(repaired.originals.native.sceneType, cold.originals.native.sceneType);
  report.repairedEntry = await page.evaluate(async ({ name, url }) => {
    const cache = await caches.open(name), response = await cache.match(url), bytes = await response.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { hash, bytes: bytes.byteLength };
  }, { name: cacheName, url: report.corruptedEntry.url });
  assert.equal(report.repairedEntry.hash, report.corruptedEntry.hash);
  await context.close();

  phase = 'controlled-prefetch-failure';
  const failedContext = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  observe(failedContext);
  const failedAttempts = [];
  const failOriginal = route => { failedAttempts.push(route.request().url()); return route.abort('internetdisconnected'); };
  await failedContext.route('**/__stream-original/**', failOriginal);
  const retryPage = await newPage(failedContext); await shell(retryPage);
  const beforeFailure = await stats();
  await retryPage.locator('#demo-play').click();
  await retryPage.waitForFunction(() => /Retry demo/.test(document.querySelector('#demo-play').textContent)
    && !document.querySelector('#demo-play').disabled, null, { timeout: 30000 });
  assert.equal(await retryPage.locator('iframe[src*="/player.html?"]').count(), 0);
  report.failureUI = { status: await retryPage.locator('#demo-status').textContent(),
    button: await retryPage.locator('#demo-play').textContent(), blockedRequests: failedAttempts.length,
    originalNetworkBytes: (await stats()).original.bytes - beforeFailure.original.bytes };
  assert(report.failureUI.status.trim().length > 0); assert(failedAttempts.length > 0);
  assert.equal(report.failureUI.originalNetworkBytes, 0);
  await retryPage.screenshot({ path: '/tmp/kilo/browser-streaming-cache-retry-ui.png' });
  await failedContext.unroute('**/__stream-original/**', failOriginal);
  const retried = await playable(retryPage, 'retry-fresh-session');
  assert(retried.originalNetworkBytes > 0 && retried.originalNetworkBytes < 32 * 1024 ** 2);
  assert.equal(retried.originals.native.id, cold.originals.native.id);
  await failedContext.close();

  assert(report.workers.filter(worker => worker.url.endsWith('/workers/original-bytes.js')).length >= 5,
    'Each cold/warm/repair/failure/retry session must construct its own actual original worker');
  for (const request of report.requests) {
    assert(originalURL(request.url), 'Original BLBs must only use the bounded streaming endpoint');
    assert.match(request.range ?? '', /^bytes=\d+-\d+$/, 'No full original BLB request permitted');
  }
  for (const response of report.responses) {
    assert.equal(response.status, 206);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.range ?? '');
    assert(match); assert.equal(Number(response.length), Number(match[2]) - Number(match[1]) + 1);
    assert.equal(response.requestedRange, `bytes=${match[1]}-${match[2]}`);
    assert(Number(response.length) <= 65536);
    assert(Number(response.length) < Number(match[3]));
  }
  const unexpected = report.pageErrors.filter(error => error.phase !== 'controlled-prefetch-failure');
  assert.deepEqual(unexpected, []);
  report.allowedFailurePageErrors = report.pageErrors.filter(error => error.phase === 'controlled-prefetch-failure');
  assert(report.allowedFailurePageErrors.every(error => /Aborted\(Original streaming stopped:/.test(error.message)),
    'Only an explicit controlled runtime abort may escape in the failure branch');
  report.success = true;
} catch (error) {
  report.failure = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  report.elapsedMs = performance.now() - started;
  if (server) report.serverStats = structuredClone(server.streamingStats);
  await browser?.close();
  if (server?.listening) {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await closed;
  }
  await flush();
  console.log(`Browser cache report: ${reportPath}; success=${report.success === true}`);
}
