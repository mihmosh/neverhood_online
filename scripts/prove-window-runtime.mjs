import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, '');
  options[name] = name === 'direct' ? true : process.argv[++i];
}
const origin = options.origin ?? 'http://127.0.0.1:4201';
const output = resolve(options.output ?? '/tmp/kilo/window-runtime-proof');
await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(options.playwright ?? '/tmp/kilo/node_modules/playwright');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
assert(!options.direct || !options.overlay, 'Direct proof cannot intercept assets');
const report = { origin, direct: options.direct === true, overlay: options.overlay ?? null, stages: [], clicks: [], errors: [], requests: [], responses: [], policy: 'Read-only native heap observations; scene changes exclusively through browser keyboard/mouse input.' };
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => { if (/\.zip(?:$|\?)/.test(request.url())) report.requests.push(request.url()); });
page.on('response', response => { if (/cursor|C084110C|config.json|manifest.json/.test(response.url())) report.responses.push({ url: response.url(), status: response.status() }); });
if (!options.direct) await page.route('**/hd-demo/config.json', route => route.fulfill({ json: { version: 1, manifestURL: `${origin}/__private-demo/manifest.json` } }));
if (options.overlay) {
  await page.route('**/__private-demo/manifest.json', async route => route.fulfill({ body: await readFile(resolve(options.overlay, 'manifest.json')), contentType: 'application/json' }));
  await page.route('**/__window-overlay/rooms/Module1000-C084110C.zip', async route => route.fulfill({ body: await readFile(resolve(options.overlay, 'pack/rooms/Module1000-C084110C.zip')), contentType: 'application/zip' }));
}
let frame;
async function state() {
  return frame.evaluate(async () => {
    const { RenderFrameReader } = await import('/prototype/read-frame.js');
    const abi = await (await fetch('/prototype/render-abi.json')).json();
    const f = new RenderFrameReader(Module, abi, { allRooms: true }).read({ reference: false });
    const data = new DataView(HEAPU8.buffer), ptr = at => data.getUint32(at, true);
    const at = (type, key) => abi.records[type].fields[key].offset;
    const engine = ptr(Module._g_engine), game = ptr(engine + at('Neverhood::NeverhoodEngine', '_gameModule'));
    const module = ptr(game + at('Neverhood::Module', '_childObject'));
    const nativeScene = ptr(module + at('Neverhood::Module1000', '_sceneNum'));
    return { nativeScene, tick: f.tick, available: f.available, reason: f.reason, room: f.room,
      stats: window.roomRendererPrototype.stats(), cursorViewportVisible: !document.querySelector('#room-proxy-cursor-viewport')?.hidden,
      cursor: f.cursor && { x: f.cursor.x, y: f.cursor.y, hotspotX: f.cursor.hotspotX, hotspotY: f.cursor.hotspotY, resourceHash: f.cursor.resourceHash },
      layers: f.items?.map(i => ({ width: i.source.width, height: i.source.height, destX: i.destX, destY: i.destY })) };
  });
}
async function capture(name) {
  const current = await state();
  report.stages.push({ name, state: current });
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(name, JSON.stringify({ nativeScene: current.nativeScene, tick: current.tick, activeRoom: current.stats.activeRoom, frames: current.stats.engineFrames, hdDraws: current.stats.hdDraws, status: current.stats.status }));
  return current;
}
async function ticks(count) {
  const begin = await frame.evaluate(() => window.roomRendererPrototype.stats().engineFrames);
  await frame.waitForFunction(({ begin, count }) => window.roomRendererPrototype.stats().engineFrames >= begin + count, { begin, count }, { timeout: 180000 });
}
async function click(x, y, frames = 120) {
  const before = await state(), box = await frame.locator('#canvas').boundingBox();
  report.clicks.push({ x, y, frames, before: { scene: before.nativeScene, tick: before.tick, engineFrames: before.stats.engineFrames } });
  await page.mouse.click(box.x + box.width * x / 640, box.y + box.height * y / 480, { delay: 100 });
  await ticks(frames);
}
try {
  await page.goto(`${origin}/hd-demo/`);
  await page.locator('#demo-play').click({ timeout: 30000 });
  await page.locator('#demo-loading').waitFor({ state: 'hidden', timeout: 240000 });
  frame = page.frames().find(f => f.url().includes('/player.html?'));
  for (let i = 0; i < 100; i++) {
    if (await frame.evaluate(() => window.roomRendererPrototype?.stats().hdDraws > 0)) break;
    await frame.locator('#canvas').press('Space');
    await page.waitForTimeout(500);
  }
  await ticks(60); await capture('initial');
  await click(300, 300, 160); await capture('awake');
  await click(475, 345, 180); await capture('button');
  await click(345, 260, 200); const window = await capture('window-hd');
  assert.equal(window.nativeScene, 2, 'Natural window hotspot must reach native scene 2');
  if (options.overlay || options.direct) assert.equal(window.stats.activeRoom, 'Module1000-C084110C');
  if (options.direct) {
    assert.equal(window.stats.hdDraws, 1);
    assert.equal(window.stats.cursor.hd, true);
    assert.equal(window.cursorViewportVisible, true);
    assert.equal(window.stats.cursor.resourceHash, 0x41108c00);
  }
  await frame.locator('#room-hd-view').selectOption('original'); await ticks(20); const original = await capture('window-original');
  if (options.direct) assert.equal(original.cursorViewportVisible, false);
  await frame.locator('#room-hd-view').selectOption('hd'); await ticks(20); const restored = await capture('window-hd-restored');
  if (options.direct) { assert.equal(restored.stats.cursor.hd, true); assert.equal(restored.stats.hdDraws, 1); }
  await click(20, 240, 140); const returned = await capture('window-return');
  assert.equal(returned.nativeScene, 0);
  for (let i = 0; i < 3; i++) await click(75, 360, 170);
  await click(556, 327, 180); const second = await capture('room2');
  assert.equal(second.nativeScene, 1);
  assert.equal(second.stats.activeRoom, 'Scene1002');
  assert.equal(report.errors.length, 0);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (frame) await capture('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
