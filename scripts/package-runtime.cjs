// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'scummvm');
  const build = path.join(__dirname, '.build/neverhood-web');
  const output = path.join(root, 'web/public/runtime');
  const emsdk = process.argv[2] || '4.0.10';
  const wasm = await fs.readFile(path.join(build, 'scummvm.wasm'));
  if (!WebAssembly.validate(wasm)) throw new Error('Built WebAssembly failed validation');
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(wasm));
  if (!exports.some(entry => entry.name === 'g_engine' && entry.kind === 'global')) {
    throw new Error('Built WebAssembly is missing the g_engine lifecycle data export');
  }
  for (const name of ['SDL_GL_GetCurrentWindow', 'SDL_GetKeyboardFocus', 'SDL_GetWindowID', 'SDL_SetWindowSize']) {
    if (!exports.some(entry => entry.name === name && entry.kind === 'function')) throw new Error(`Built WebAssembly is missing active-window resizing: ${name}`);
  }
  const config = await fs.readFile(path.join(build, 'config.mk'), 'utf8');
  const value = name => config.match(new RegExp(`^${name}\\s*[:+]?=\\s*(.*)$`, 'm'))?.[1] || '';
  const descriptor = {
    available: true,
    api: 'emscripten-global-module',
    module: 'scummvm.js',
    wasm: 'scummvm.wasm',
    engine: 'neverhood',
    engineData: ['neverhood.dat'],
    filesystem: 'MEMFS',
    saves: 'IDBFS',
    lifecycle: {
      enginePointerAddress: 'Module._g_engine',
      readEnginePointer: "Module.getValue(Module._g_engine, '*')",
      stopped: 'A nonzero engine pointer followed by zero means the engine was destroyed. Hide and stop the isolated player, flush saves, then remove its iframe.',
      exitRuntime: true,
      pauseMainLoop: 'Module._emscripten_pause_main_loop',
    },
    viewport: {
      activeWindow: 'Module._SDL_GL_GetCurrentWindow() || Module._SDL_GetKeyboardFocus()',
      windowIdentity: 'Module._SDL_GetWindowID(window)',
      resize: 'Module._SDL_SetWindowSize(window, width, height)',
      note: 'Window IDs change when the renderer recreates its SDL window; never assume ID 1.',
    },
    emsdk,
    sourceRevision: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    configureFlags: value('SAVED_CONFIGFLAGS'),
    configuredLinkFlags: value('LDFLAGS'),
    libraries: value('LIBS'),
    linkerOverrides: await fs.readFile(path.join(__dirname, 'runtime.mk'), 'utf8'),
    sourceCompliance: 'Before public binary distribution provide corresponding ScummVM, SDL and toolchain library source and build scripts as required by their licenses. A revision URL alone is not a complete GPL source offer.',
  };
  await fs.mkdir(path.join(output, 'LICENSES'), { recursive: true });
  for (const file of ['scummvm.js', 'scummvm.wasm']) {
    await fs.copyFile(path.join(build, file), path.join(output, file));
  }
  for (const file of ['COPYING', 'COPYRIGHT', 'AUTHORS']) {
    await fs.copyFile(path.join(source, file), path.join(output, file));
  }
  for (const file of await fs.readdir(path.join(source, 'LICENSES'))) {
    await fs.copyFile(path.join(source, 'LICENSES', file), path.join(output, 'LICENSES', file));
  }
  const sdl = path.join(source, `dists/emscripten/emsdk-${emsdk}/upstream/emscripten/cache/ports/sdl3`);
  const sdlVersion = (await fs.readdir(sdl)).find(name => name.startsWith('SDL-release-'));
  if (!sdlVersion) throw new Error('SDL license source not found');
  await fs.copyFile(path.join(sdl, sdlVersion, 'LICENSE.txt'), path.join(output, 'LICENSES', 'SDL.txt'));
  await fs.copyFile(path.join(source, 'dists/engine-data/neverhood.dat'), path.join(output, 'neverhood.dat'));
  await fs.writeFile(path.join(output, 'runtime.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  console.log(`Validated and packaged runtime: ${output}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
