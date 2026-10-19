// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256 } from './demo-runtime-overlays.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'scripts/.build/neverhood-demo-web');
const source = resolve(root, 'scummvm');
const output = resolve(root, 'web/public/demo-runtime');

export async function checkSource() {
  const runtime = JSON.parse(await readFile(resolve(root, 'web/public/runtime/runtime.json')));
  const abi = JSON.parse(await readFile(resolve(root, 'web/prototype/render-abi.json')));
  const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceRuntimeSHA256 = sha256(await readFile(resolve(root, 'web/public/runtime/scummvm.wasm')));
  if (revision !== runtime.sourceRevision || revision !== abi.sourceRevision || runtime.emsdk !== '4.0.10' || abi.emsdk !== runtime.emsdk || sourceRuntimeSHA256 !== abi.wasmSHA256) throw new Error('Source/runtime/render ABI/SDK mismatch');
  if (execFileSync('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Upstream tracked files modified');
  if (sha256(await readFile(resolve(root, 'scripts/.build/neverhood-web/config.mk'))) !== abi.buildConfigSHA256) throw new Error('Base build configuration differs from source ABI');
  return { runtime, abi, sourceRuntimeSHA256 };
}

export async function packageDemoRuntime() {
  const { runtime, abi, sourceRuntimeSHA256 } = await checkSource();
  const wasm = await readFile(resolve(build, 'scummvm.wasm'));
  if (!WebAssembly.validate(wasm)) throw new Error('Invalid demo WebAssembly');
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(wasm));
  for (const [name, kind] of [['neverhood_demo_state', 'global'], ['g_engine', 'global'], ['SDL_GL_GetCurrentWindow', 'function'], ['SDL_GetKeyboardFocus', 'function'], ['SDL_GetWindowID', 'function'], ['SDL_SetWindowSize', 'function']]) {
    if (!exports.some(entry => entry.name === name && entry.kind === kind)) throw new Error(`Missing demo export: ${name}`);
  }
  const generatedJS = await readFile(resolve(build, 'scummvm.js'), 'utf8');
  if (!generatedJS.includes('Module["_emscripten_pause_main_loop"]') || !generatedJS.includes('Module["_neverhood_demo_state"]')) throw new Error('Generated JavaScript is missing demo lifecycle exports');
  const runtimeSHA256 = sha256(wasm);
  if (runtimeSHA256 === sourceRuntimeSHA256) throw new Error('Demo WebAssembly is identical to full runtime');
  const overlays = JSON.parse(await readFile(resolve(build, 'overlays/manifest.json')));
  const verified = JSON.parse(await readFile(resolve(build, 'demo-layouts.json')));
  if (verified.sourceABISHA256 !== sha256(await readFile(resolve(root, 'web/prototype/render-abi.json'))) || JSON.stringify(verified.records) !== JSON.stringify(abi.records)) throw new Error('Demo ABI layout verification missing or stale');
  for (const entry of overlays) {
    if (sha256(await readFile(resolve(source, `${entry.unit}.cpp`))) !== entry.sourceSHA256 || sha256(await readFile(resolve(build, 'overlays', `${entry.unit}.cpp`))) !== entry.overlaySHA256) throw new Error(`Demo overlay changed after compilation: ${entry.unit}`);
  }
  const config = await readFile(resolve(build, 'config.mk'));
  const baseConfig = await readFile(resolve(root, 'scripts/.build/neverhood-web/config.mk'));
  const configHeader = await readFile(resolve(build, 'config.h'));
  const baseHeader = await readFile(resolve(root, 'scripts/.build/neverhood-web/config.h'));
  if (!config.equals(baseConfig) || !configHeader.equals(baseHeader)) throw new Error('Demo configuration differs from the ABI-pinned base build');
  const descriptor = {
    ...runtime,
    demo: true,
    runtimeSHA256,
    wasmSHA256: runtimeSHA256,
    sourceRuntimeSHA256,
    abi: 'render-abi.json',
    saves: false,
    settings: { filesystem: 'MEMFS', persistence: false, bootstrapFetch: false, note: 'The demo filesystem factory leaves HOME in MEMFS. No HOME IDBFS mount, sync or scummvm.ini download.' },
    lifecycle: { ...runtime.lifecycle, stopped: 'A nonzero engine pointer followed by zero means teardown completed. Read demoState to distinguish completion from user quit. Remove the isolated iframe; demo saves are disabled and must not be flushed or mounted.' },
    demoPolicy: { module: 1000, scenes: [0, 1, 2], start: { module: 1000, scene: 0, which: 0 }, load: false, save: false, menus: false, escape: 'quit', completion: 'Engine-side guards execute before creating any scene outside 0/1/2 or module outside 1000; room 2 exits both complete the demo.' },
    demoState: { address: 'Module._neverhood_demo_state', read: "Module.getValue(Module._neverhood_demo_state, 'i32')", states: { startup: 0, running: 1, completed: 2, quit: 3 }, note: 'State 2 is set synchronously before quitGame; state remains readable after engine teardown. Startup is not completion.' },
    hdPackCompatibility: { sourceRuntimeSHA256, policy: 'Packs built for this exact source runtime may be used with the demo ABI; class layout is unchanged. The pack runtime hash identifies the source runtime, not this variant.' },
    overlays,
    linkerOverrides: await readFile(resolve(root, 'scripts/demo-runtime.mk'), 'utf8'),
    baseLinkerOverrides: await readFile(resolve(root, 'scripts/runtime.mk'), 'utf8'),
  };
  const demoABI = {
    ...abi,
    purpose: 'Version-pinned read-only two-room demo adapter, not a production API',
    runtimeSHA256,
    sourceRuntimeSHA256,
    wasmSHA256: runtimeSHA256,
    wasmBytes: wasm.length,
    buildConfigSHA256: sha256(config),
    demo: true,
    sourceABI: { path: 'web/prototype/render-abi.json', sha256: verified.sourceABISHA256, wasmSHA256: sourceRuntimeSHA256, layout: 'Clang record-layout dumps for demo overlays and unmodified rendering units match every source ABI record. Same source revision, SDK, configuration and headers; no class members changed.' },
    commands: verified.commands,
    overlays,
  };
  const allowed = new Set(['scummvm.js', 'scummvm.wasm', 'neverhood.dat', 'runtime.json', 'render-abi.json', 'COPYING', 'COPYRIGHT', 'AUTHORS', 'LICENSES']);
  const sourceLicenses = await readdir(resolve(source, 'LICENSES'));
  const allowedLicenses = new Set([...sourceLicenses, 'SDL.txt']);
  await mkdir(resolve(output, 'LICENSES'), { recursive: true });
  for (const file of await readdir(output)) if (!allowed.has(file)) throw new Error(`Unexpected demo runtime output (no game media allowed): ${file}`);
  for (const file of await readdir(resolve(output, 'LICENSES'))) if (!allowedLicenses.has(file)) throw new Error(`Unexpected demo runtime license output: ${file}`);
  for (const file of ['scummvm.js', 'scummvm.wasm']) await copyFile(resolve(build, file), resolve(output, file));
  for (const file of ['COPYING', 'COPYRIGHT', 'AUTHORS']) await copyFile(resolve(source, file), resolve(output, file));
  for (const file of sourceLicenses) await copyFile(resolve(source, 'LICENSES', file), resolve(output, 'LICENSES', file));
  const sdl = resolve(source, 'dists/emscripten/emsdk-4.0.10/upstream/emscripten/cache/ports/sdl3');
  const sdlVersion = (await readdir(sdl)).find(name => name.startsWith('SDL-release-'));
  if (!sdlVersion) throw new Error('SDL license source not found');
  await copyFile(resolve(sdl, sdlVersion, 'LICENSE.txt'), resolve(output, 'LICENSES/SDL.txt'));
  await copyFile(resolve(source, 'dists/engine-data/neverhood.dat'), resolve(output, 'neverhood.dat'));
  await writeFile(resolve(output, 'render-abi.json'), `${JSON.stringify(demoABI, null, 2)}\n`);
  await writeFile(resolve(output, 'runtime.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  console.log(JSON.stringify({ output, runtimeSHA256, sourceRuntimeSHA256, wasmBytes: wasm.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check-source')) await checkSource();
  else await packageDemoRuntime();
}
