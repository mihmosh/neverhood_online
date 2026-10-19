import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/kilo/node_modules/playwright');
const gameDirectory = process.env.GAME_DATA_DIR || '/home/mosha/neverhood/extracted/app/DATA';
const privateDirectory = await realpath('/home/mosha/neverhood-upscaling/data/room1-hd');
const packDirectory = process.env.ROOM_PACK_DIR || join(privateDirectory, 'pack-v1');
const artifactDirectory = await realpath(process.env.ROOM_PACK_ARTIFACT_DIR || privateDirectory);
assert.ok(artifactDirectory === privateDirectory || artifactDirectory.startsWith(privateDirectory + sep), 'Artifacts must remain in the private room1-hd directory');
const artifact = name => resolve(artifactDirectory, name);
const complete = process.env.EXPECT_COMPLETE_PACK === '1';
const profile = await mkdtemp(join(tmpdir(), 'neverhood-room1-pack-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [], uploads = [], logs = [];
const report = { completeExpected: complete, errors, uploads, samples: [] };
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (logs.length < 200) logs.push(message.text()); });
page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url()); });
page.on('dialog', dialog => dialog.accept());
const ticks = (frame, count = 5) => frame.evaluate(count => new Promise(resolve => {
  let n = 0;
  const next = () => ++n >= count ? resolve() : requestAnimationFrame(next);
  requestAnimationFrame(next);
}), count);
let frame;
async function sample(label) {
  const value = await frame.evaluate(async label => {
    const api = window.roomRendererPrototype;
    const { RenderFrameReader } = await import('./prototype/read-frame.js');
    const { updateCRC32 } = await import('./lib/zip-validation.js');
    const abi = await (await fetch('./prototype/render-abi.json')).json();
    await new Promise(requestAnimationFrame);
    const live = new RenderFrameReader(Module, abi).read();
    return { label, stats: api.stats(), layers: api.layers(), draws: api.draws(),
      available: live.available, reason: live.reason,
      paletteCRC: live.available ? ((updateCRC32(0xffffffff, live.palette) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0') : null,
      originalOpacity: getComputedStyle(document.getElementById('canvas')).opacity,
      outputHidden: api.output.hidden, cursorHidden: api.cursorCanvas.hidden };
  }, label);
  report.samples.push(value); return value;
}

const lab = open => frame.locator('#room-proxy-panel').evaluate((panel, open) => { panel.open = open; }, open);
async function roomScreenshot(name) {
  await lab(false); await ticks(frame, 3);
  await page.screenshot({ path: artifact(name) });
  await lab(true);
}
async function clickGame(x, y) {
  const rect = await frame.locator('#canvas').boundingBox();
  assert.ok(rect, 'native input canvas is unavailable');
  await page.mouse.move(rect.x + rect.width * x / 640, rect.y + rect.height * y / 480);
  await page.mouse.click(rect.x + rect.width * x / 640, rect.y + rect.height * y / 480, { delay: 60 });
}
async function backgroundPixels(background) {
  return frame.evaluate(async ({ filePath, backgroundKey }) => {
    const api = window.roomRendererPrototype, draws = api.draws();
    const point = [{ x: 300, y: 10 }, { x: 200, y: 20 }, { x: 350, y: 100 }, { x: 100, y: 20 }]
      .find(point => !draws.some(item => item.key !== backgroundKey && point.x >= item.destX && point.x < item.destX + item.width && point.y >= item.destY && point.y < item.destY + item.height));
    if (!point) throw new Error('No unoccluded background test point');
    const file = [...document.getElementById('proxy-pack').files].find(file => file.webkitRelativePath.endsWith('/' + filePath));
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = new OffscreenCanvas(8, 8), ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, point.x * 4, point.y * 4, 8, 8, 0, 0, 8, 8);
      const expected = ctx.getImageData(0, 0, 8, 8).data;
      const actual = api.output.getContext('2d').getImageData(point.x * 4, point.y * 4, 8, 8).data;
      let differingChannels = 0;
      for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) differingChannels++;
      const signature = [...new Uint8Array(await crypto.subtle.digest('SHA-256', actual))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      return { point, differingChannels, channels: actual.length, signature };
    } finally { bitmap.close(); }
  }, { filePath: background.file, backgroundKey: background.key });
}

async function strictInteractions(manifest) {
  const expected = {
    klaymen: ['5a38c110', '527ac970', '00648953', '5420e254', '5900c41e', '5b20c814', 'd122c137', '543cd054',
      '40a0c034', '5120e137', '5c7080d4', '9a7020b8', '242c0198', '1a249001', '5c48c506', 'f234ee31',
      'f135cc21', '8604a152', 'a246a132', '08b28116', 'd820a114', '9b250ad2', '98f88391', '1c02b03d'],
    objects: ['624c0498', '022c90d4', 'c68c2299', '04a98c36'],
    statics: ['2080a3a8', '809861a6', '89c03848', '15288120', '8c066150'],
  };
  const resourceId = value => typeof value === 'number' ? value.toString(16).padStart(8, '0') : String(value).toLowerCase().replace(/^0x/, '').padStart(8, '0');
  // Requested aliases can have identical runtime pixels and share one HD image.
  const inventory = new Set(manifest.entries.flatMap(entry => (entry.sourceResources ?? [entry.resource]).map(resourceId)));
  report.strictInventory = Object.fromEntries(Object.entries(expected).map(([group, resources]) => [group, {
    expected: resources, missingFromManifest: resources.filter(resource => !inventory.has(resource)),
  }]));
  for (const value of Object.values(report.strictInventory)) assert.deepEqual(value.missingFromManifest, [], 'completed pack is missing source-audited resources');
  await lab(false);
  await frame.evaluate(({ entries, backgrounds }) => {
    const known = new Map(entries.map(entry => [entry.key, entry]));
    const backgroundKeys = new Set(backgrounds.map(entry => entry.key));
    const phases = {}, keys = {}, cursorHashes = new Set();
    const recorder = { phase: 'warmup', started: performance.now(), phases, keys, frames: [], stopped: false, lastFrame: -1, sequence: 0 };
    window.__privatePackCoverage = recorder;
    const record = () => {
      if (recorder.stopped) return;
      const api = window.roomRendererPrototype, state = api.stats(), pack = state.pack;
      const phase = phases[recorder.phase] ??= { renderFrames: 0, fallbackRAFs: 0, hits: 0, coldMisses: 0,
        unknownMisses: 0, intentionalOriginal: 0, warmHits: 0, warmColdMisses: 0, warmUnknownMisses: 0,
        keys: {}, resources: {}, maxCacheBytes: 0, maxPending: 0, errors: {} };
      if (api.output.hidden) { phase.fallbackRAFs++; recorder.sequence++; }
      if (pack && !api.output.hidden && recorder.lastFrame !== state.frames) {
        recorder.lastFrame = state.frames; phase.renderFrames++; recorder.sequence++;
        const actor = api.draws().find(draw => draw.sourceWidth === 320 && draw.sourceHeight === 200);
        if (actor) {
          phase.actorX ??= { first: actor.destX, last: actor.destX, min: actor.destX, max: actor.destX };
          phase.actorX.last = actor.destX;
          phase.actorX.min = Math.min(phase.actorX.min, actor.destX);
          phase.actorX.max = Math.max(phase.actorX.max, actor.destX);
        }
        phase.maxCacheBytes = Math.max(phase.maxCacheBytes, pack.cacheBytes);
        phase.maxPending = Math.max(phase.maxPending, pack.pendingLoads);
        Object.assign(phase.errors, pack.errors);
        const hits = new Set(pack.hitKeys);
        const current = [...new Set([...pack.hitKeys, ...pack.missKeys])];
        const warm = performance.now() - recorder.started >= 2000;
        for (const key of current) {
          const descriptor = known.get(key);
          const intentional = backgroundKeys.has(key) && pack.selectedBackground === 'original';
          const category = hits.has(key) ? 'hits' : intentional ? 'intentionalOriginal' : descriptor || backgroundKeys.has(key) ? 'coldMisses' : 'unknownMisses';
          phase[category]++;
          if (warm && category !== 'intentionalOriginal') phase[`warm${category[0].toUpperCase()}${category.slice(1)}`]++;
          const record = keys[key] ??= { hits: 0, coldMisses: 0, unknownMisses: 0, intentionalOriginal: 0,
            warmOccurrences: 0, phases: [], resource: descriptor?.resource ?? null,
            sourceResources: descriptor?.sourceResources ?? (descriptor ? [descriptor.resource] : []), frameId: descriptor?.frameId ?? null,
            longestColdStreakMs: 0, lastMissSequence: -1, missStartedAt: 0 };
          record[category]++; if (warm) record.warmOccurrences++;
          if (category === 'coldMisses') {
            if (record.lastMissSequence !== recorder.sequence - 1) record.missStartedAt = performance.now();
            record.lastMissSequence = recorder.sequence;
            record.longestColdStreakMs = Math.max(record.longestColdStreakMs, performance.now() - record.missStartedAt);
          } else record.lastMissSequence = -1;
          if (!record.phases.includes(recorder.phase)) record.phases.push(recorder.phase);
          phase.keys[key] = (phase.keys[key] || 0) + 1;
          if (descriptor) for (const resource of descriptor.sourceResources ?? [descriptor.resource]) phase.resources[resource] = (phase.resources[resource] || 0) + 1;
        }
        if (state.cursor?.rasterHash) cursorHashes.add(state.cursor.rasterHash);
        if (recorder.frames.length < 4000) recorder.frames.push({ phase: recorder.phase, frame: state.frames,
          background: pack.selectedBackground, keys: api.draws().map(draw => draw.key), hitKeys: pack.hitKeys,
          missKeys: pack.missKeys, pendingLoads: pack.pendingLoads, cacheBytes: pack.cacheBytes });
      }
      recorder.request = requestAnimationFrame(record);
    };
    recorder.cursorHashes = cursorHashes;
    recorder.request = requestAnimationFrame(record);
  }, { entries: manifest.entries.map(({ key, resource, sourceResources, frameId }) => ({ key, resource, sourceResources, frameId })), backgrounds: manifest.backgrounds });
  const phase = async (label, milliseconds, action, until) => {
    console.log('INTERACTION_START', label);
    await frame.evaluate(label => {
      const recorder = window.__privatePackCoverage;
      recorder.phase = label; recorder.started = performance.now(); recorder.lastFrame = -1;
    }, label);
    if (action) await action();
    if (until) {
      await frame.waitForFunction(until, null, { timeout: 60000 });
      await ticks(frame, 3);
    } else await frame.evaluate(milliseconds => new Promise(resolve => {
      const start = performance.now();
      const next = () => performance.now() - start >= milliseconds ? resolve() : requestAnimationFrame(next);
      requestAnimationFrame(next);
    }), milliseconds);
    const result = await sample(label);
    assert.equal(result.stats.errors, 0, `${label}: renderer error`);
    assert.equal(result.stats.maxDifference, 0, `${label}: native indexed parity changed`);
    assert.deepEqual(result.stats.pack.errors, {}, `${label}: decode failure`);
    assert.ok(result.stats.pack.cacheBytes <= 96 * 1024 ** 2, `${label}: cache exceeded budget`);
    console.log('INTERACTION_DONE', label, JSON.stringify({ status: result.stats.status,
      hits: result.stats.pack.hits, misses: result.stats.pack.misses, pending: result.stats.pack.pendingLoads }));
    return result;
  };
  let coverage;
  try {
    await frame.evaluate(() => window.roomRendererPrototype.selectPackBackground('gemini'));
    await phase('cold-idle-sleep', 3000);
    await phase('wake-klaymen', 9000, () => clickGame(300, 300));
    await phase('cold-walk-right', 6000, () => clickGame(440, 440));
    await phase('cold-walk-left', 6000, () => clickGame(180, 440));
    await phase('warm-walk-right', 6000, () => clickGame(430, 440));
    await phase('warm-walk-left', 6000, () => clickGame(180, 440));
    await phase('short-step-right', 4000, () => clickGame(205, 440));
    await phase('short-step-left', 4000, () => clickGame(180, 440));
    const closedWindow = await phase('closed-window-inspect', 10000, () => clickGame(340, 260));
    assert.equal(closedWindow.available, true, 'closed window must not leave the first room');
    const intactDoor = await phase('intact-door-inspect', 10000, () => clickGame(550, 300));
    assert.equal(intactDoor.available, true, 'intact door inspection must not enter the next room');
    // Three genuine lever pulls advance the hammer/door states, without entering the next room.
    let doorCycle;
    for (let pull = 1; pull <= 3; pull++) doorCycle = await phase(`lever-hammer-door-${pull}`, 12000, () => clickGame(75, 350));
    const hasDoor = value => value.draws.some(draw => draw.sourceWidth === 140 && draw.sourceHeight === 242);
    for (let retry = 1; retry <= 2 && hasDoor(doorCycle); retry++) doorCycle = await phase(`lever-hammer-door-retry-${retry}`, 12000, () => clickGame(75, 350));
    assert.equal(hasDoor(doorCycle), false, 'lever/hammer cycle did not reach the busted-door state');
    await roomScreenshot('browser-room1-pack-gemini-door-cycle.png'); await lab(false);
    // Press-button accepts new input during its animation. An early window click can
    // interrupt it before the button's marker opens the window; elapsed time is not readiness.
    assert.ok(doorCycle.draws.some(draw => draw.sourceWidth === 68 && draw.sourceHeight === 129), 'window unexpectedly open before button interaction');
    await phase('button-opens-window', 0, () => clickGame(475, 345), () => {
      const api = window.roomRendererPrototype;
      return !api.output.hidden && !api.draws().some(draw => draw.sourceWidth === 68 && draw.sourceHeight === 129);
    });
    const windowLook = await phase('window-look-scene2-original', 0, () => clickGame(340, 260), () => {
      const api = window.roomRendererPrototype;
      return api.output.hidden && /not room 1001/i.test(api.stats().status);
    });
    assert.equal(windowLook.available, false, 'window click did not reach the native window-look scene');
    assert.equal(windowLook.outputHidden, true);
    assert.equal(windowLook.originalOpacity, '1'); assert.equal(windowLook.cursorHidden, true);
    assert.match(windowLook.stats.status, /not room 1001/i);
    await roomScreenshot('browser-room1-pack-window-native-fallback.png'); await lab(false);
    const returned = await phase('window-return-firstroom', 0, () => clickGame(10, 240), () => {
      const api = window.roomRendererPrototype;
      return !api.output.hidden && /room 1001 \/ proxy verified/.test(api.stats().status);
    });
    assert.equal(returned.available, true, 'edge click did not return from window-look');
    assert.equal(returned.outputHidden, false);
    await phase('warm-button-repeat', 10000, () => clickGame(475, 345));
    await phase('warm-idle-variants', 12000);
    for (const id of ['gemini', 'realesrnet']) {
      const background = manifest.backgrounds.find(value => value.id === id);
      await frame.evaluate(id => window.roomRendererPrototype.selectPackBackground(id), id);
      await frame.waitForFunction(key => window.roomRendererPrototype.stats().pack.hitKeys.includes(key), background.key, { timeout: 120000 });
      await phase(`comparison-${id}`, 3000);
      const pixels = await backgroundPixels(background);
      (report.strictBackgroundPixels ??= {})[id] = pixels;
      assert.equal(pixels.differingChannels, 0, `${id}: wrong background image at 4x`);
      await roomScreenshot(`browser-room1-pack-${id}-awake.png`); await lab(false);
    }
    // Read-only native cursor check, independent of all replacement rasters.
    const rect = await frame.locator('#canvas').boundingBox();
    await page.mouse.move(rect.x + rect.width * 300 / 640, rect.y + rect.height * 100 / 480); await ticks(frame, 8);
    report.strictCursor = await frame.evaluate(async () => {
      const { RenderFrameReader } = await import('./prototype/read-frame.js');
      const abi = await (await fetch('./prototype/render-abi.json')).json();
      await new Promise(requestAnimationFrame);
      const live = new RenderFrameReader(Module, abi).read(), api = window.roomRendererPrototype;
      if (!live.available) throw new Error('First room unavailable during native cursor check');
      const { source, x, y, hotspotX, hotspotY } = live.cursor;
      const actual = api.cursorCanvas.getContext('2d').getImageData(0, 0, 32, 32).data;
      let differingChannels = 0, opaquePixels = 0;
      for (let row = 0; row < 32; row++) for (let col = 0; col < 32; col++) {
        const dx = x - hotspotX + col, dy = y - hotspotY + row;
        if (dx < 0 || dy < 0 || dx >= 640 || dy >= 480) continue;
        const index = source.pixels[row * source.pitch + col], offset = (row * 32 + col) * 4;
        if (index) opaquePixels++;
        if (actual[offset + 3] !== (index ? 255 : 0)) differingChannels++;
        if (index) for (let channel = 0; channel < 3; channel++) if (actual[offset + channel] !== live.palette[index * 4 + channel]) differingChannels++;
      }
      return { differingChannels, opaquePixels, visible: !api.cursorCanvas.hidden,
        width: api.cursorCanvas.width, height: api.cursorCanvas.height, state: api.stats().cursor };
    });
    assert.equal(report.strictCursor.differingChannels, 0);
    assert.ok(report.strictCursor.opaquePixels > 0); assert.equal(report.strictCursor.visible, true);
    assert.equal(report.strictCursor.width, 32); assert.equal(report.strictCursor.height, 32);
  } finally {
    coverage = await frame.evaluate(() => {
      const recorder = window.__privatePackCoverage;
      recorder.stopped = true; cancelAnimationFrame(recorder.request);
      return { phases: recorder.phases, keys: recorder.keys, frames: recorder.frames, cursorHashes: [...recorder.cursorHashes] };
    });
    report.interactions = coverage;
    await writeFile(artifact('browser-room1-pack-interactions.json'), JSON.stringify(coverage, null, 2));
    await lab(true);
  }
  coverage.unknownKeys = Object.entries(coverage.keys).filter(([, value]) => value.unknownMisses).map(([key, value]) => ({ key, ...value }));
  // A later loop is not necessarily cache-warm: the LRU cannot retain an entire
  // long animation. Preserve never-hit diagnostics, but fail actual sustained stalls.
  coverage.neverHitObservedKeys = Object.entries(coverage.keys)
    .filter(([, value]) => value.resource && value.hits === 0).map(([key, value]) => ({ key, ...value }));
  coverage.persistentKnownMisses = Object.entries(coverage.keys)
    .filter(([, value]) => value.resource && value.longestColdStreakMs >= 5000)
    .map(([key, value]) => ({ key, ...value }));
  const hitResources = new Set(Object.values(coverage.keys).filter(value => value.hits && value.resource !== null)
    .flatMap(value => (value.sourceResources ?? [value.resource]).map(resourceId)));
  coverage.resourceCoverage = Object.fromEntries(Object.entries(expected).map(([group, resources]) => [group, {
    observedHits: resources.filter(value => hitResources.has(value)), notObserved: resources.filter(value => !hitResources.has(value)),
  }]));
  coverage.animationKeys = Object.fromEntries([['klaymen', '320x200-'], ['lever', '72x73-'], ['hammer', '180x192-'], ['door', '140x242-'], ['window', '68x129-']]
    .map(([name, prefix]) => [name, Object.entries(coverage.keys).filter(([key, value]) => key.startsWith(prefix) && value.hits).map(([key]) => key)]));
  coverage.resourceRates = {};
  for (const value of Object.values(coverage.keys)) for (const resource of value.sourceResources) {
    const rate = coverage.resourceRates[resourceId(resource)] ??= { hits: 0, coldMisses: 0, observedKeys: 0, hitKeys: 0 };
    rate.hits += value.hits; rate.coldMisses += value.coldMisses; rate.observedKeys++;
    if (value.hits) rate.hitKeys++;
    rate.hitRate = rate.hits / (rate.hits + rate.coldMisses);
  }
  for (const value of Object.values(coverage.phases)) {
    const draws = value.hits + value.coldMisses + value.unknownMisses;
    value.hitRate = draws ? value.hits / draws : null;
    value.coldMissRate = draws ? value.coldMisses / draws : null;
    const warmDraws = value.warmHits + value.warmColdMisses + value.warmUnknownMisses;
    value.warmHitRate = warmDraws ? value.warmHits / warmDraws : null;
  }
  coverage.scope = 'Observed real-input first-room sweep, not proof every source-catalog frame/random idle was displayed. Cold known-key misses are reported, not treated as missing descriptors.';
  await writeFile(artifact('browser-room1-pack-interactions.json'), JSON.stringify(coverage, null, 2));
  assert.deepEqual(coverage.unknownKeys, [], 'unknown live raster/palette keys: see private interaction report');
  assert.deepEqual(coverage.persistentKnownMisses, [], 'known current assets stalled for at least five consecutive seconds');
  for (const name of ['cold-walk-right', 'cold-walk-left', 'warm-walk-right', 'warm-walk-left']) {
    const positions = coverage.phases[name].actorX;
    assert.ok(positions && positions.max - positions.min >= 60, `${name}: input did not move Klaymen across the room`);
  }
  for (const [name, keys] of Object.entries(coverage.animationKeys)) assert.ok(keys.length >= (name === 'klaymen' ? 5 : 2), `${name}: interaction did not display multiple HD animation rasters`);
  assert.deepEqual(coverage.resourceCoverage.objects.notObserved, [], 'not all four animated objects produced HD hits');
  assert.deepEqual(coverage.resourceCoverage.statics.notObserved, [], 'not all five static resources produced HD hits');
  assert.ok(coverage.cursorHashes.length > 1, 'native cursor animation did not advance');
  assert.ok(coverage.phases['window-look-scene2-original'].fallbackRAFs > 0);
}

try {
  const url = new URL(process.env.TEST_ORIGIN || 'http://127.0.0.1:4189');
  url.searchParams.set('renderer', 'room1-proxy');
  url.searchParams.set('renderer-debug', '1');
  await page.goto(url.href);
  await page.locator('#library-panel[data-state="empty"]').waitFor();
  await page.locator('#game-folder').setInputFiles(gameDirectory);
  await page.locator('#prepare').click();
  await page.locator('#library-panel[data-state="ready"]').waitFor({ timeout: 180000 });
  await page.waitForFunction(() => !document.getElementById('play').disabled);
  await page.locator('#play').click();
  await page.locator('#game-loading').waitFor({ state: 'hidden', timeout: 180000 });
  frame = page.frames().find(value => value.url().includes('/player.html?'));
  assert.ok(frame, 'runtime frame did not start');
  for (let i = 0; i < 90; i++) {
    if (await frame.evaluate(() => window.roomRendererPrototype?.stats().verified > 0)) break;
    await frame.locator('#canvas').press('Space'); await ticks(frame, 15);
  }
  await frame.waitForFunction(() => window.roomRendererPrototype?.stats().verified > 0);
  const initial = await sample('initial-original-1x');
  assert.equal(initial.stats.maxDifference, 0);
  assert.equal(initial.stats.errors, 0);
  assert.equal((await frame.evaluate(() => window.roomRendererPrototype.verify1x())).differingChannels, 0);
  assert.equal(await frame.locator('#proxy-pack-enabled').isDisabled(), true);
  await frame.locator('#room-proxy-panel summary').click();
  // Take one browser FileList snapshot. Do not reload while the producer is working.
  await frame.locator('#proxy-pack').setInputFiles(packDirectory);
  const manifest = await frame.locator('#proxy-pack').evaluate(async input => {
    const file = [...input.files].find(file => file.webkitRelativePath.endsWith('/room-pack.json'));
    if (!file) throw new Error('No selected manifest');
    return JSON.parse(await file.text());
  });
  report.manifest = manifest;
  const live = await sample('selected-pack-key-check');
  const background = manifest.backgrounds.find(value => value.id === 'gemini');
  assert.ok(background, 'Gemini candidate missing from selected pack');
  const backgroundDraws = live.draws.filter(item => item.sourceWidth === 640 && item.sourceHeight === 480);
  report.backgroundKeyCheck = { expected: background.key, liveBackgrounds: backgroundDraws, paletteCRC: live.paletteCRC,
    matches: backgroundDraws.some(item => item.key === background.key) };
  console.log('BACKGROUND_KEY_CHECK', JSON.stringify(report.backgroundKeyCheck));
  await writeFile(artifact('browser-room1-pack-key-check.json'), JSON.stringify(report.backgroundKeyCheck, null, 2));
  assert.ok(report.backgroundKeyCheck.matches, `BACKGROUND KEY MISMATCH: ${JSON.stringify(report.backgroundKeyCheck)}`);
  await frame.waitForFunction(() => !window.roomRendererPrototype.stats().packLoading, null, { timeout: 180000 });
  const installed = await sample('pack-installed-off');
  report.importStatus = await frame.locator('#proxy-pack-status').textContent();
  assert.ok(installed.stats.pack?.loaded, report.importStatus);
  assert.equal(installed.stats.packEnabled, false);
  assert.equal(installed.stats.pack.cacheBytes, 0);
  assert.equal(installed.stats.pack.selectedBackground, 'original');
  assert.equal(await frame.locator('#proxy-pack-enabled').isChecked(), false);
  assert.equal(installed.stats.outputWidth, 640);
  if (complete) {
    assert.equal(manifest.coverage?.complete, true, 'strict run requires completed manifest');
    assert.ok(manifest.entries.length > 0, 'strict run requires sprites/layers');
    assert.ok(manifest.backgrounds.some(value => value.id === 'realesrnet'), 'strict run requires RealESRNet');
  }
  await frame.locator('#proxy-pack-enabled').check();
  await frame.locator('#proxy-pack-background').selectOption('gemini');
  await frame.waitForFunction(key => {
    const state = window.roomRendererPrototype.stats();
    return state.outputWidth === 2560 && state.outputHeight === 1920 && state.pack?.hitKeys.includes(key);
  }, background.key, { timeout: 120000 });
  const hd = await sample('gemini-4x');
  assert.equal(hd.stats.pack.selectedBackground, 'gemini');
  assert.ok(hd.stats.hdDraws > 0);
  assert.equal(hd.outputHidden, false);
  assert.equal(hd.stats.errors, 0);
  assert.ok(hd.stats.pack.cacheBytes <= 96 * 1024 ** 2);
  assert.deepEqual(hd.stats.pack.errors, {});
  // Compare a visible background pixel patch with the actual selected local PNG.
  report.backgroundPixels = await backgroundPixels(background);
  assert.equal(report.backgroundPixels.differingChannels, 0, 'HD background was not painted from selected PNG');
  await roomScreenshot('browser-room1-pack-gemini.png');
  await frame.locator('#proxy-pack-background').selectOption('original'); await ticks(frame, 8);
  const originalBackground = await sample('original-background-pack-sprites');
  assert.equal(originalBackground.stats.pack.selectedBackground, 'original');
  assert.ok(!originalBackground.stats.pack.hitKeys.includes(background.key));
  assert.equal(originalBackground.stats.outputWidth, 2560);
  if (manifest.backgrounds.some(value => value.id === 'realesrnet')) {
    await frame.locator('#proxy-pack-background').selectOption('realesrnet');
    await frame.waitForFunction(key => window.roomRendererPrototype.stats().pack.hitKeys.includes(key), background.key, { timeout: 120000 });
    const nn = await sample('realesrnet-4x');
    assert.equal(nn.stats.pack.selectedBackground, 'realesrnet');
    assert.deepEqual(nn.stats.pack.errors, {});
    report.realesrnetBackgroundPixels = await backgroundPixels(manifest.backgrounds.find(value => value.id === 'realesrnet'));
    assert.equal(report.realesrnetBackgroundPixels.differingChannels, 0);
    await roomScreenshot('browser-room1-pack-realesrnet.png');
  } else assert.equal(await frame.locator('#proxy-pack-background option[value="realesrnet"]').isDisabled(), true);
  if (complete) await strictInteractions(manifest);
  await frame.locator('#proxy-toggle').click(); await ticks(frame);
  const originalRenderer = await sample('original-renderer');
  assert.equal(originalRenderer.outputHidden, true);
  assert.equal(originalRenderer.originalOpacity, '1');
  assert.equal(originalRenderer.cursorHidden, true);
  await frame.locator('#proxy-toggle').click(); await ticks(frame, 8);
  assert.equal((await sample('proxy-restored')).outputHidden, false);
  await frame.locator('#proxy-pack-clear').click(); await ticks(frame, 5);
  const unloaded = await sample('pack-unloaded');
  assert.equal(unloaded.stats.pack, null);
  assert.equal(unloaded.stats.packEnabled, false);
  assert.equal(await frame.locator('#proxy-pack-enabled').isDisabled(), true);
  await frame.locator('#room-proxy-panel summary').click();
  await frame.locator('#canvas').press('Escape');
  await frame.waitForFunction(() => window.roomRendererPrototype.output.hidden);
  const menu = await sample('menu-fallback');
  assert.equal(menu.originalOpacity, '1'); assert.equal(menu.cursorHidden, true);
  assert.match(menu.stats.status, /menu|outside/i);
  assert.deepEqual(errors, []); assert.deepEqual(uploads, []);
  report.passed = true;
  console.log('Private room pack browser check PASSED', JSON.stringify({ key: background.key, paletteCRC: live.paletteCRC,
    entries: manifest.entries.length, backgrounds: manifest.backgrounds.map(value => value.id), pixels: report.backgroundPixels,
    artifacts: artifactDirectory }));
} catch (error) {
  report.passed = false; report.failure = error.stack; report.console = logs;
  console.error(error.stack);
  if (frame) await lab(false).catch(() => {});
  await page.screenshot({ path: artifact('browser-room1-pack-failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(artifact('browser-room1-pack-report.json'), JSON.stringify(report, null, 2));
  await context.close(); await rm(profile, { recursive: true, force: true });
}
