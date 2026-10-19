// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const overlayUnits = ['engines/neverhood/gamemodule', 'engines/neverhood/modules/module1000', 'engines/neverhood/saveload', 'engines/engine', 'backends/fs/emscripten/emscripten-fs-factory'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Upstream demo overlay anchor changed: ${before.slice(0, 100)}`);
  return text.replace(before, after);
}

export function overlaySource(unit, source) {
  const complete = '\n\t\tneverhood_demo_state = 2;\n\t\t_vm->quitGame();\n\t\treturn;\n';
  if (unit === 'engines/neverhood/gamemodule') {
    source = replaceOnce(source, 'namespace Neverhood {', 'namespace Neverhood {\n\nextern "C" { volatile int neverhood_demo_state = 0; }');
    const start = source.indexOf('void GameModule::startup() {');
    const end = source.indexOf('void GameModule::requestRestoreGame()', start);
    if (start < 0 || end < 0) throw new Error('Upstream startup boundaries changed');
    source = source.slice(0, start) + `void GameModule::startup() {
\tneverhood_demo_state = 1;
\t_vm->_isSaveAllowed = false;
\t_vm->gameState().sceneNum = 0;
\t_vm->gameState().which = 0;
\tcreateModule(1000, 0);
}

` + source.slice(end);
    source = replaceOnce(source, 'void GameModule::handleEscapeKey() {', 'void GameModule::handleEscapeKey() {\n\tif (neverhood_demo_state != 2) neverhood_demo_state = 3;\n\t_vm->quitGame();\n\treturn;');
    source = replaceOnce(source, 'void GameModule::createModule(int moduleNum, int which) {', `void GameModule::createModule(int moduleNum, int which) {\n\tif (moduleNum != 1000 || neverhood_demo_state != 1) {${complete}\t}`);
    for (const signature of ['void GameModule::requestRestoreGame()', 'void GameModule::requestRestartGame(bool requestMainMenu)', 'void GameModule::openMainMenu()', 'void GameModule::createMenuModule()']) {
      source = replaceOnce(source, `${signature} {`, `${signature} {\n\treturn;`);
    }
  } else if (unit === 'engines/neverhood/modules/module1000') {
    source = replaceOnce(source, 'namespace Neverhood {', 'namespace Neverhood {\n\nextern "C" volatile int neverhood_demo_state;');
    source = replaceOnce(source, 'void Module1000::createScene(int sceneNum, int which) {', `void Module1000::createScene(int sceneNum, int which) {\n\tif (sceneNum < 0 || sceneNum > 2 || neverhood_demo_state != 1) {${complete}\t}`);
    source = replaceOnce(source, '\t\t\t\tif (_vm->isDemo() && !_vm->isBigDemo())\n\t\t\t\t\t// Demo version returns to the same scene\n\t\t\t\t\tcreateScene(1, 2);\n\t\t\t\telse\n\t\t\t\t\tcreateScene(3, 0);', '\t\t\t\tcreateScene(3, 0);');
  } else if (unit === 'engines/neverhood/saveload') {
    for (const signature of ['bool NeverhoodEngine::savegame(const char *filename, const char *description)', 'bool NeverhoodEngine::loadgame(const char *filename)']) {
      source = replaceOnce(source, `${signature} {`, `${signature} {\n\treturn false;`);
    }
    source = replaceOnce(source, 'Common::Error NeverhoodEngine::removeGameState(int slot) {', 'Common::Error NeverhoodEngine::removeGameState(int slot) {\n\treturn Common::kWritingFailed;');
  } else if (unit === 'engines/engine') {
    source = replaceOnce(source, 'void Engine::openMainMenuDialog() {', 'void Engine::openMainMenuDialog() {\n\treturn;');
  } else if (unit === 'backends/fs/emscripten/emscripten-fs-factory') {
    source = replaceOnce(source, 'EmscriptenFilesystemFactory::EmscriptenFilesystemFactory() {\n\t_initSettings(getenv("HOME"));', 'EmscriptenFilesystemFactory::EmscriptenFilesystemFactory() {');
  } else throw new Error(`Unknown demo overlay unit: ${unit}`);
  return source;
}

export async function prepareOverlays(root) {
  const output = resolve(root, 'scripts/.build/neverhood-demo-web/overlays');
  const manifest = [];
  for (const unit of overlayUnits) {
    const input = await readFile(resolve(root, 'scummvm', `${unit}.cpp`), 'utf8');
    const result = overlaySource(unit, input);
    const target = resolve(output, `${unit}.cpp`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, result);
    manifest.push({ unit, sourceSHA256: sha256(input), overlaySHA256: sha256(result) });
  }
  await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareOverlays(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
