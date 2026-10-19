// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const runtime = resolve(import.meta.dirname, '../web/public/demo-runtime');
const game = process.env.GAME_DATA_DIR && resolve(process.env.GAME_DATA_DIR);
const gameFiles = game ? (await readdir(game)).filter(file => /^[a-z0-9_-]+\.blb$/i.test(file)) : [];
const allowed = new Set(['scummvm.js', 'scummvm.wasm', 'neverhood.dat', 'render-abi.json']);
const server = createServer(async (request, response) => {
  const name = request.url.slice(1);
  if (request.url === '/') return response.setHeader('Content-Type', 'text/html').end('<!doctype html><canvas tabindex="0" id="canvas" width="640" height="480"></canvas>');
  const target = allowed.has(name) ? resolve(runtime, name) : gameFiles.includes(name) ? resolve(game, name) : null;
  if (!target) return response.writeHead(404).end();
  try {
    const bytes = await readFile(target);
    response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const route of game ? ['escape', 'ladder', 'outside'] : ['exports']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    const iniRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/\.ini$/i.test(new URL(request.url()).pathname)) iniRequests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
    await page.evaluate(() => {
      window.output = [];
      window.idbRequests = [];
      for (const method of ['open', 'deleteDatabase']) {
        const original = IDBFactory.prototype[method];
        IDBFactory.prototype[method] = function (...args) {
          window.idbRequests.push({ method, name: args[0] });
          return original.apply(this, args);
        };
      }
      window.ready = new Promise((resolve, reject) => {
        window.Module = {
          noInitialRun: true, canvas: document.getElementById('canvas'), locateFile: name => `/${name}`,
          print: text => window.output.push(text), printErr: text => window.output.push(text),
          onRuntimeInitialized: resolve, onAbort: reject, onExit: code => { window.exitCode = code; },
        };
      });
    });
    await page.addScriptTag({ url: '/scummvm.js' });
    await page.evaluate(() => window.ready);
    assert.equal(await page.evaluate(() => Module.getValue(Module._neverhood_demo_state, 'i32')), 0);
    if (game) {
      await page.evaluate(async files => {
        const fs = Module.FS;
        for (const dir of ['/game', '/engine-data', '/saves']) fs.mkdirTree(dir);
        for (const name of files) fs.writeFile(`/game/${name}`, new Uint8Array(await (await fetch(`/${name}`)).arrayBuffer()));
        fs.writeFile('/engine-data/neverhood.dat', new Uint8Array(await (await fetch('/neverhood.dat')).arrayBuffer()));
        fs.writeFile('/tmp/demo.ini', '[scummvm]\ngui_return_to_launcher_at_exit=false\nconfirm_exit=false\noriginalsaveload=true\nautosave_period=0\n');
        window.abi = await (await fetch('/render-abi.json')).json();
        window.locations = () => {
          const field = (type, name) => window.abi.records[`Neverhood::${type}`].fields[name].offset;
          const ptr = address => Module.getValue(address, '*');
          const engine = ptr(Module._g_engine);
          const gameModule = engine && ptr(engine + field('NeverhoodEngine', '_gameModule'));
          const module = gameModule && ptr(gameModule + field('Module', '_childObject'));
          return { engine, gameModule, module, scene: module ? Module.getValue(module + field('Module1000', '_sceneNum'), 'i32') : -1, field };
        };
        try {
          Module.callMain(['--path=/game', '--extrapath=/engine-data', '--savepath=/saves', '--save-slot=99', '--config=/tmp/demo.ini', '--no-fullscreen', '--window-size=640,480', 'neverhood']);
        } catch (error) { if (error !== 'unwind') throw error; }
      }, gameFiles);
      await page.waitForFunction(() => Module.getValue(Module._neverhood_demo_state, 'i32') === 1 && window.locations().scene === 0, null, { timeout: 60000 });
      if (route === 'escape') {
        await page.locator('#canvas').press('Escape');
      } else {
        // Test-only injection of the normal scene-completion message state.
        // The runtime's C++ guards, not this test, perform the boundary check.
        const transition = async (scene, result) => {
          await page.evaluate(result => {
            const { module, field } = window.locations();
            Module.setValue(module + field('Module', '_moduleResult'), result, 'i32');
            Module.setValue(module + field('Module', '_done'), 1, 'i8');
          }, result);
          if (scene !== null) await page.waitForFunction(scene => window.locations().scene === scene, scene, { timeout: 10000 });
        };
        await transition(2, 2);
        await transition(0, 0);
        await transition(1, 0);
        await transition(null, route === 'ladder' ? 2 : 1);
      }
      await page.waitForFunction(expected => Module.getValue(Module._neverhood_demo_state, 'i32') === expected && Module.getValue(Module._g_engine, '*') === 0, route === 'escape' ? 3 : 2, { timeout: 30000 });
      const result = await page.evaluate(() => ({ state: Module.getValue(Module._neverhood_demo_state, 'i32'), engine: Module.getValue(Module._g_engine, '*'), exitCode: window.exitCode ?? null, saves: Module.FS.readdir('/saves'), output: window.output }));
      // Emscripten may retain the process after engine teardown. The exported
      // state, not onExit delivery, is the demo's completion contract.
      if (result.exitCode !== null) assert.equal(result.exitCode, 0, result.output.join('\n'));
      assert.deepEqual(result.saves, ['.', '..']);
      console.log(JSON.stringify({ route, state: result.state, engine: result.engine, exitCode: result.exitCode, saves: result.saves }));
    } else {
      await page.evaluate(() => Module.callMain(['--list-engines']));
      assert.ok(await page.evaluate(() => window.output.some(line => line.includes('Neverhood'))));
      assert.equal(await page.evaluate(() => Module.getValue(Module._neverhood_demo_state, 'i32')), 0);
      console.log('Demo runtime initialized in Chromium; exports and --list-engines passed. GAME_DATA_DIR not provided, gameplay routes not run.');
    }
    const persistence = await page.evaluate(async () => {
      const mounts = [];
      const visit = mount => {
        if (mount.type === Module.IDBFS) mounts.push(mount.mountpoint);
        for (const child of mount.mounts || []) visit(child);
      };
      visit(Module.FS.root.mount);
      return { databases: await indexedDB.databases(), idbRequests: window.idbRequests, idbMounts: mounts };
    });
    assert.deepEqual(persistence, { databases: [], idbRequests: [], idbMounts: [] }, `${route}: demo touched persistent browser storage`);
    assert.deepEqual(iniRequests, [], `${route}: demo requested an ini file`);
    console.log(JSON.stringify({ route, databases: persistence.databases, idbRequests: persistence.idbRequests, idbMounts: persistence.idbMounts, iniRequests }));
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
