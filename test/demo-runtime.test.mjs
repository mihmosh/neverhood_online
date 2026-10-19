// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { overlaySource, overlayUnits, sha256 } from '../scripts/demo-runtime-overlays.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceAvailable = existsSync(resolve(root, 'scummvm/engines/neverhood/gamemodule.cpp'));
const readSource = unit => readFile(resolve(root, 'scummvm', `${unit}.cpp`), 'utf8');

function functionText(source, signature) {
  const start = source.indexOf(`${signature} {`);
  assert.notEqual(start, -1, signature);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function: ${signature}`);
}

test('demo overlays are fail-closed and never alter class declarations', { skip: !sourceAvailable }, async () => {
  for (const unit of overlayUnits) {
    const input = await readSource(unit);
    const result = overlaySource(unit, input);
    assert.notEqual(input, result);
    assert.throws(() => overlaySource(unit, ''), /changed/);
  }
  assert.throws(() => overlaySource('unknown', ''), /Unknown demo overlay/);
  const source = overlaySource('engines/neverhood/gamemodule', await readSource('engines/neverhood/gamemodule'));
  const startup = functionText(source, 'void GameModule::startup()');
  assert.match(startup, /neverhood_demo_state = 1/);
  assert.match(startup, /_isSaveAllowed = false/);
  assert.match(startup, /createModule\(1000, 0\)/);
  assert.doesNotMatch(startup, /1500|load|restore/i);
  for (const signature of ['void GameModule::requestRestoreGame()', 'void GameModule::requestRestartGame(bool requestMainMenu)', 'void GameModule::openMainMenu()', 'void GameModule::createMenuModule()']) assert.match(functionText(source, signature), /\{\s*return;/);
  const saves = overlaySource('engines/neverhood/saveload', await readSource('engines/neverhood/saveload'));
  assert.match(functionText(saves, 'bool NeverhoodEngine::savegame(const char *filename, const char *description)'), /\{\s*return false;/);
  assert.match(functionText(saves, 'bool NeverhoodEngine::loadgame(const char *filename)'), /\{\s*return false;/);
  const engine = overlaySource('engines/engine', await readSource('engines/engine'));
  assert.match(functionText(engine, 'void Engine::openMainMenuDialog()'), /\{\s*return;/);
});

test('demo filesystem overlay removes only the persistent HOME initializer call', { skip: !sourceAvailable }, async () => {
  const unit = 'backends/fs/emscripten/emscripten-fs-factory';
  const input = await readSource(unit);
  const output = overlaySource(unit, input);
  assert.equal(output, input.replace('\n\t_initSettings(getenv("HOME"));', ''));
  assert.doesNotMatch(functionText(output, 'EmscriptenFilesystemFactory::EmscriptenFilesystemFactory()'), /_initSettings|IDBFS|syncfs|fetch/);
  assert.match(output, /EM_ASYNC_JS\(void, _initSettings,/);
  assert.match(output, /_httpNodes = new Common::HashMap/);
  assert.equal(overlayUnits.length, 5);
  const makefile = await readFile(resolve(root, 'scripts/demo-runtime.mk'), 'utf8');
  assert.match(makefile, /backends\/fs\/emscripten\/emscripten-fs-factory\.o/);
});

test('compiled C++ demo guards precede scene/module resource constructors', { skip: !sourceAvailable || spawnSync('g++', ['--version']).status !== 0 }, async () => {
  const game = overlaySource('engines/neverhood/gamemodule', await readSource('engines/neverhood/gamemodule'));
  const module = overlaySource('engines/neverhood/modules/module1000', await readSource('engines/neverhood/modules/module1000'));
  const functions = [
    functionText(game, 'void GameModule::startup()'),
    functionText(game, 'void GameModule::createModule(int moduleNum, int which)'),
    functionText(game, 'void GameModule::handleEscapeKey()'),
    functionText(module, 'void Module1000::createScene(int sceneNum, int which)'),
    functionText(module, 'void Module1000::updateScene()'),
  ].join('\n');
  const fixture = await readFile(resolve(import.meta.dirname, 'fixtures/demo-runtime-policy.cpp'), 'utf8');
  const scratch = await mkdtemp(join(tmpdir(), 'neverhood-demo-test-'));
  try {
    const cpp = join(scratch, 'policy.cpp');
    const binary = join(scratch, 'policy');
    await writeFile(cpp, fixture.replace('// DEMO_OVERLAY_FUNCTIONS', functions));
    execFileSync('g++', ['-std=c++11', '-Wall', '-Werror=return-type', cpp, '-o', binary], { encoding: 'utf8' });
    assert.equal(execFileSync(binary, [], { encoding: 'utf8' }).trim(), 'demo native guards passed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('demo artifacts pin the variant hash and unchanged layouts without game media', { skip: !existsSync(resolve(root, 'web/public/demo-runtime/runtime.json')) }, async () => {
  const output = resolve(root, 'web/public/demo-runtime');
  const descriptor = JSON.parse(await readFile(resolve(output, 'runtime.json')));
  const abi = JSON.parse(await readFile(resolve(output, 'render-abi.json')));
  const baseABI = JSON.parse(await readFile(resolve(root, 'web/prototype/render-abi.json')));
  const wasm = await readFile(resolve(output, descriptor.wasm));
  assert.ok(WebAssembly.validate(wasm));
  assert.equal(descriptor.runtimeSHA256, sha256(wasm));
  assert.equal(abi.wasmSHA256, descriptor.runtimeSHA256);
  assert.equal(descriptor.wasmSHA256, descriptor.runtimeSHA256);
  assert.equal(descriptor.sourceRuntimeSHA256, baseABI.wasmSHA256);
  assert.equal(abi.sourceRuntimeSHA256, baseABI.wasmSHA256);
  assert.notEqual(descriptor.runtimeSHA256, descriptor.sourceRuntimeSHA256);
  assert.deepEqual(abi.records, baseABI.records);
  assert.deepEqual(descriptor.demoPolicy.scenes, [0, 1, 2]);
  assert.deepEqual(descriptor.demoState.states, { startup: 0, running: 1, completed: 2, quit: 3 });
  assert.equal(descriptor.saves, false);
  assert.equal(descriptor.settings.filesystem, 'MEMFS');
  assert.equal(descriptor.settings.persistence, false);
  assert.equal(descriptor.settings.bootstrapFetch, false);
  assert.deepEqual(descriptor.overlays.map(entry => entry.unit), overlayUnits);
  assert.equal(descriptor.demo, true);
  assert.equal(descriptor.hdPackCompatibility.sourceRuntimeSHA256, baseABI.wasmSHA256);
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(wasm));
  assert.ok(exports.some(entry => entry.name === 'neverhood_demo_state' && entry.kind === 'global'));
  assert.ok(exports.some(entry => entry.name === 'g_engine' && entry.kind === 'global'));
  assert.deepEqual((await readdir(output)).sort(), ['AUTHORS', 'COPYING', 'COPYRIGHT', 'LICENSES', 'neverhood.dat', 'render-abi.json', 'runtime.json', 'scummvm.js', 'scummvm.wasm'].sort());
  if (sourceAvailable) assert.deepEqual((await readdir(resolve(output, 'LICENSES'))).sort(), [...await readdir(resolve(root, 'scummvm/LICENSES')), 'SDL.txt'].sort());
  assert.equal(abi.sourceABI.sha256, sha256(await readFile(resolve(root, 'web/prototype/render-abi.json'))));
});
