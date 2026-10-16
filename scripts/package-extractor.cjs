// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const build = path.join(root, 'scripts/.build/extractor');
const output = path.join(root, 'web/public/extractor');
fs.mkdirSync(output, { recursive: true });
for (const name of ['innoextract.js', 'innoextract.wasm']) {
  fs.copyFileSync(path.join(build, 'inno', name), path.join(output, name));
}
const notices = [
  ['innoextract-1.9/LICENSE', 'innoextract-LICENSE.txt'],
  ['boost_1_75_0/LICENSE_1_0.txt', 'boost-LICENSE.txt'],
  ['xz-5.6.4/COPYING', 'xz-COPYING.txt'],
  ['xz-5.6.4/COPYING.0BSD', 'xz-0BSD.txt'],
  ['zlib-1.3.1/LICENSE', 'zlib-LICENSE.txt'],
  ['bzip2-1.0.8/LICENSE', 'bzip2-LICENSE.txt'],
];
for (const [source, name] of notices) fs.copyFileSync(path.join(build, 'src', source), path.join(output, name));
const sdk = path.join(root, 'scummvm/dists/emscripten/emsdk-4.0.10/upstream/emscripten');
const runtimeNotices = [
  ['LICENSE', 'emscripten-LICENSE.txt'],
  ['system/lib/libc/musl/COPYRIGHT', 'musl-COPYRIGHT.txt'],
  ['system/lib/libcxx/LICENSE.TXT', 'libcxx-LICENSE.txt'],
  ['system/lib/libcxxabi/LICENSE.TXT', 'libcxxabi-LICENSE.txt'],
  ['system/lib/compiler-rt/LICENSE.TXT', 'compiler-rt-LICENSE.txt'],
];
for (const [source, name] of runtimeNotices) fs.copyFileSync(path.join(sdk, source), path.join(output, name));
const sources = [...fs.readFileSync(path.join(root, 'scripts/build-extractor.sh'), 'utf8').matchAll(/^fetch (\S+) ([a-f0-9]{64}) (https:\/\/\S+) (\S+)$/gm)]
  .map(([, archive, sha256, url, directory]) => ({ archive, sha256, url, directory }));
const descriptor = {
  available: true,
  api: 'emscripten-modularize',
  factory: 'createInnoextract',
  module: 'innoextract.js',
  wasm: 'innoextract.wasm',
  version: '1.9',
  inputFilesystem: 'WORKERFS',
  outputFilesystem: 'MEMFS',
  exports: ['FS', 'WORKERFS', 'NODEFS', 'callMain'],
  freshModulePerOperation: true,
  memory: { wasmMaximumBytes: 2147483648, outputMaximumBytes: 1073741824, fileMaximumBytes: 536870912, limitsEnforcedBy: 'Browser integration must validate listed and actual output sizes; MEMFS is JavaScript memory outside the WASM heap limit', baseline: '64-bit desktop browser; input File objects mounted without copying; extracted output held in MEMFS' },
  cli: { list: ['--list', '--silent', '--list-sizes', '--color=false', '--progress=false'], listingFormat: '<decimal-byte-size> <archive-path>', extract: ['--extract', '--silent', '--color=false', '--progress=false', '--output-dir=/output'], include: '--include=/<archive-path> (repeat per file; case-insensitive, anchored, no glob)' },
  build: { emscripten: '4.0.10', dependencies: { innoextract: '1.9', boost: '1.75.0', xz: '5.6.4', zlib: '1.3.1', bzip2: '1.0.8' }, recipe: 'scripts/build-extractor.sh', sources, optimization: '-O2', cxxStandard: 'C++14', exceptions: true },
  licenses: [...notices, ...runtimeNotices].map(([, name]) => name),
  artifacts: Object.fromEntries(['innoextract.js', 'innoextract.wasm'].map(name => [name, { bytes: fs.statSync(path.join(output, name)).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex') }])),
};
fs.writeFileSync(path.join(output, 'extractor.json'), JSON.stringify(descriptor, null, 2) + '\n');
console.log(`Packaged real innoextract ${descriptor.version} WASM in ${output}`);
