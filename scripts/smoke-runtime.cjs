// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const runtime = path.resolve(__dirname, '../web/public/runtime');
const allowed = new Set(['scummvm.js', 'scummvm.wasm', 'runtime.json', 'neverhood.dat']);
const server = http.createServer(async (request, response) => {
  const file = request.url.slice(1);
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><canvas id="canvas" width="640" height="480"></canvas>');
  } else if (allowed.has(file)) {
    try {
      const data = await fs.readFile(path.join(runtime, file));
      response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/json');
      response.end(data);
    } catch {
      response.writeHead(404).end();
    }
  } else {
    response.writeHead(404).end();
  }
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      window.midiRequests = 0;
      const requestMIDIAccess = navigator.requestMIDIAccess;
      if (requestMIDIAccess) {
        navigator.requestMIDIAccess = function (...args) {
          window.midiRequests++;
          return requestMIDIAccess.apply(this, args);
        };
      }
      window.runtimeOutput = [];
      window.runtimeReady = new Promise((resolve, reject) => {
        window.Module = {
          canvas: document.getElementById('canvas'),
          noInitialRun: true,
          locateFile: file => `/${file}`,
          print: text => window.runtimeOutput.push(text),
          printErr: text => window.runtimeOutput.push(text),
          onRuntimeInitialized: resolve,
          onAbort: reject,
        };
      });
    });
    await page.addScriptTag({ url: '/scummvm.js' });
    await page.evaluate(() => Promise.race([
      window.runtimeReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('WASM initialization timed out')), 60000)),
    ]));
    const exports = await page.evaluate(() => {
      const { FS, IDBFS, callMain } = window.Module;
      FS.mkdirTree('/game');
      FS.writeFile('/game/test', new Uint8Array([1, 2, 3]));
      return { fs: typeof FS.readFile, idbfs: typeof IDBFS.mount, main: typeof callMain, bytes: Array.from(FS.readFile('/game/test')) };
    });
    assert.deepEqual(exports, { fs: 'function', idbfs: 'function', main: 'function', bytes: [1, 2, 3] });
    const engineDataSize = await page.evaluate(async () => {
      const response = await fetch('/neverhood.dat');
      if (!response.ok) throw new Error('Missing neverhood.dat');
      return (await response.arrayBuffer()).byteLength;
    });
    assert.ok(engineDataSize > 0);
    await page.evaluate(() => window.Module.callMain(['--list-engines']));
    await page.waitForFunction(() => window.runtimeOutput.some(line => line.includes('Neverhood')), { timeout: 30000 });
    assert.equal(await page.evaluate(() => typeof navigator.requestMIDIAccess), 'function');
    assert.equal(await page.evaluate(() => window.midiRequests), 0, 'Neverhood must not request Web MIDI permission');
    assert.deepEqual(errors, []);
    console.log('PASS: Chromium loaded WASM, FS roundtrip, IDBFS export, callMain --list-engines lists Neverhood, zero Web MIDI requests with native API enabled.');
    console.log((await page.evaluate(() => window.runtimeOutput)).join('\n'));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
