// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseLayouts } from './generate-render-abi.mjs';
import { sha256 } from './demo-runtime-overlays.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'scripts/.build/neverhood-demo-web');
const sdk = resolve(root, 'scummvm/dists/emscripten/emsdk-4.0.10');
const compiler = resolve(sdk, 'upstream/emscripten/em++');
const env = { ...process.env, EMSDK: sdk, EM_CACHE: resolve(sdk, 'upstream/emscripten/cache') };
const run = (command, args) => execFileSync(command, args, { cwd: build, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const abi = JSON.parse(await readFile(resolve(root, 'web/prototype/render-abi.json')));
const layouts = {};
const commands = [];
const compilerVersion = run(compiler, ['--version']).trim();
if (compilerVersion !== abi.compilerVersion) throw new Error('Demo compiler differs from source ABI compiler');

for (const unit of ['screen', 'gamemodule', 'modules/module1000', 'mouse', 'scene']) {
  const relative = `engines/neverhood/${unit}.cpp`;
  const input = resolve(unit === 'gamemodule' || unit === 'modules/module1000' ? resolve(build, 'overlays') : resolve(root, 'scummvm'), relative);
  const recipe = run('make', ['-f', resolve(root, 'scripts/demo-runtime.mk'), '-n', '-o', 'configure', '-o', 'config.mk', '-o', 'config.h', '-o', 'configure.stamp', '-W', input, 'VERBOSE_BUILD=1', `engines/neverhood/${unit}.o`]);
  const line = recipe.split('\n').find(value => value.startsWith('em++ '));
  if (!line) throw new Error(`Missing demo compiler recipe for ${unit}`);
  const flags = line.slice('em++ '.length).replace(/-MMD -MF "[^"]+" -MQ "[^"]+" -MP /, '').replace(/ -c .*$/, '');
  const command = `"${compiler}" ${flags} -Xclang -fdump-record-layouts -fsyntax-only "${input}"`;
  commands.push({ cwd: build, command });
  for (const [name, record] of Object.entries(parseLayouts(run('bash', ['-c', command])))) {
    if (layouts[name] && JSON.stringify(layouts[name]) !== JSON.stringify(record)) throw new Error(`Demo cross-TU layout mismatch: ${name}`);
    layouts[name] = record;
  }
}
for (const [name, record] of Object.entries(abi.records)) {
  if (JSON.stringify(layouts[name]) !== JSON.stringify(record)) throw new Error(`Demo class layout differs from source ABI: ${name}`);
}
const result = { compilerVersion, commands, records: abi.records, sourceABISHA256: sha256(await readFile(resolve(root, 'web/prototype/render-abi.json'))) };
await writeFile(resolve(build, 'demo-layouts.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Verified ${Object.keys(abi.records).length} unchanged demo ABI record layouts with Clang`);
