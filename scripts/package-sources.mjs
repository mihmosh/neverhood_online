// SPDX-License-Identifier: MIT
// Run locally after building both binaries; deployment only copies the outputs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'web/public/sources');
const sdkRelative = 'scummvm/dists/emscripten/emsdk-4.0.10';
const emRelative = `${sdkRelative}/upstream/emscripten`;
const em = path.join(root, emRelative);
const revision = 'c546a4c80d2daf3bb1d5a3652279e26f762c0204';
const chunkSize = 16 * 1024 * 1024;
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: root, maxBuffer: 64 * 1024 * 1024, ...options,
});
const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const archives = [];
const files = [];
const inventory = [];
const excluded = /(^|\/)(\.git|node_modules|__pycache__|\.DS_Store)(\/|$)|\.(o|a|wasm|pyc|blb|exe|dll|sav|sve|\d{3})$/i;
let previousManifest;
let previousInventory;
try {
  previousManifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json')));
  previousInventory = JSON.parse(await fs.readFile(path.join(output, 'inventory.json')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function walk(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (excluded.test(name)) continue;
    if (entry.isDirectory()) result.push(...await walk(name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unexpected non-regular source input: ${name}`);
  }
  return result;
}

async function publish(name, data, list = files, extra = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Unsafe output name: ${name}`);
  await fs.writeFile(path.join(output, name), data);
  const record = { name, bytes: data.length, sha256: hash(data), ...extra };
  list.push(record);
  return record;
}

const temporary = await fs.mkdtemp(path.join(tmpdir(), 'neverhood-sources-'));
try {
  if (run('git', ['-C', 'scummvm', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) {
    throw new Error('ScummVM revision differs from distributed runtime');
  }
  if (run('git', ['-C', 'scummvm', 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
    throw new Error('Tracked upstream modifications need explicit source packaging review');
  }
  const runtime = JSON.parse(await fs.readFile(path.join(root, 'web/public/runtime/runtime.json')));
  const extractor = JSON.parse(await fs.readFile(path.join(root, 'web/public/extractor/extractor.json')));
  if (runtime.sourceRevision !== revision || runtime.emsdk !== '4.0.10') throw new Error('Runtime provenance mismatch');
  if (runtime.libraries.trim() !== '-sUSE_SDL=3' || extractor.version !== '1.9' ||
      extractor.build.emscripten !== '4.0.10' ||
      json(extractor.build.dependencies) !== json({ innoextract: '1.9', boost: '1.75.0', xz: '5.6.4', zlib: '1.3.1', bzip2: '1.0.8' })) {
    throw new Error('Review changed linked dependencies before packaging sources');
  }
  const sdlTag = (await fs.readFile(path.join(em, 'cache/ports/sdl3/.emscripten_url'), 'utf8')).trim();
  const sdlDirectory = `SDL-${sdlTag.match(/(release-[0-9.]+)\.zip$/)?.[1]}`;
  if (sdlDirectory !== 'SDL-release-3.2.4') throw new Error('Review changed SDL port before packaging');
  await fs.mkdir(output, { recursive: true });

  async function archive(component, entries) {
    const stage = path.join(temporary, component);
    await fs.mkdir(stage);
    for (const [source, destination] of entries.sort((a, b) => a[1].localeCompare(b[1], 'en'))) {
      if (excluded.test(destination) || destination.startsWith('/') || destination.split('/').includes('..')) {
        throw new Error(`Forbidden archive member: ${destination}`);
      }
      const contents = await fs.readFile(source);
      const target = path.join(stage, destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, { mode: (await fs.stat(source)).mode & 0o777 });
      inventory.push({ component, path: destination, bytes: contents.length, sha256: hash(contents) });
    }
    const previousParts = previousManifest?.archives?.filter(item => item.component === component);
    if (previousParts?.length && json(previousInventory.members.filter(item => item.component === component)) ===
        json(inventory.filter(item => item.component === component))) {
      const chunks = [];
      for (const part of previousParts) {
        if (path.basename(part.name) !== part.name) throw new Error('Unsafe previous archive name');
        const data = await fs.readFile(path.join(output, part.name));
        if (data.length !== part.bytes || hash(data) !== part.sha256) throw new Error(`Corrupt previous archive: ${part.name}`);
        chunks.push(data);
      }
      if (hash(Buffer.concat(chunks)) !== previousParts[0].archiveSha256) throw new Error('Corrupt previous archive stream');
      archives.push(...previousParts);
      console.log(`${component}: reused verified unchanged archive (${entries.length} files)`);
      return;
    }
    const archivePath = path.join(temporary, `${component}.tar.xz`);
    run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-cJf', archivePath, '-C', stage, '.'], { env: { ...process.env, XZ_OPT: '-6 -T1' } });
    const data = await fs.readFile(archivePath);
    const parts = Math.ceil(data.length / chunkSize);
    for (let i = 0; i < parts; i++) {
      const name = `${component}.tar.xz${parts > 1 ? `.part${String(i + 1).padStart(3, '0')}` : ''}`;
      await publish(name, data.subarray(i * chunkSize, (i + 1) * chunkSize), archives, {
        component, archive: `${component}.tar.xz`, part: i + 1, parts,
        archiveBytes: data.length, archiveSha256: hash(data),
      });
    }
    console.log(`${component}: ${entries.length} files, ${data.length} compressed bytes, ${parts} part(s)`);
  }

  const tracked = run('git', ['-C', 'scummvm', 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const shared = /^(audio|backends|base|common|graphics|gui|image|math|video|LICENSES)\//;
  const selected = tracked.filter(name => !excluded.test(name) && (
    !name.includes('/') || shared.test(name) || /^engines\/[^/]+$/.test(name) ||
    name.startsWith('engines/neverhood/') || /^engines\/[^/]+\/configure.engine$/.test(name) ||
    name.startsWith('dists/emscripten/') || name === 'dists/engine-data/neverhood.dat' ||
    name.startsWith('devtools/create_neverhood/') || /^devtools\/[^/]+$/.test(name) ||
    /^(po|doc|test)\/module.mk$/.test(name)
  ));
  // Compiler-generated dependency files catch accidental omission of used sources/headers.
  const dependencies = (await walk(path.join(root, 'scripts/.build/neverhood-web'))).filter(name => name.endsWith('.d'));
  const selectedSet = new Set(selected);
  for (const dependency of dependencies) {
    const text = await fs.readFile(dependency, 'utf8');
    for (const match of text.matchAll(new RegExp(`${root}/scummvm/([^\\s\\\\:]+)`, 'g'))) {
      if (!match[1].startsWith('dists/emscripten/emsdk-') && !selectedSet.has(match[1])) {
        if (!tracked.includes(match[1]) || excluded.test(match[1])) throw new Error(`Unexpected used input: ${match[1]}`);
        selectedSet.add(match[1]);
      }
    }
  }
  if (!dependencies.length) throw new Error('Missing compiler dependency evidence');
  await archive('scummvm-neverhood', [...selectedSet].map(name => [path.join(root, 'scummvm', name), `scummvm/${name}`]));

  const boost = path.join(root, 'scripts/.build/extractor/src/boost_1_75_0');
  const boostFiles = [];
  for (const directory of ['boost', ...['filesystem', 'date_time', 'iostreams', 'program_options', 'system'].map(x => `libs/${x}`)]) {
    boostFiles.push(...await walk(path.join(boost, directory)));
  }
  for (const name of await fs.readdir(boost, { withFileTypes: true })) {
    if (name.isFile() && !excluded.test(name.name)) boostFiles.push(path.join(boost, name.name));
  }
  await archive('boost-1.75.0-selected', boostFiles.map(name => [name,
    `scripts/.build/extractor/src/boost_1_75_0/${path.relative(boost, name)}`]));

  const deps = [];
  for (const name of ['innoextract-1.9', 'xz-5.6.4', 'zlib-1.3.1', 'bzip2-1.0.8']) {
    const directory = path.join(root, 'scripts/.build/extractor/src', name);
    deps.push(...(await walk(directory)).map(file => [file, path.relative(root, file)]));
  }
  await archive('extractor-dependencies', deps);

  const emFiles = [];
  for (const directory of ['src', 'system', 'tools', 'third_party', 'cmake']) emFiles.push(...await walk(path.join(em, directory)));
  for (const name of await fs.readdir(em, { withFileTypes: true })) {
    if (name.isFile() && !excluded.test(name.name)) emFiles.push(path.join(em, name.name));
  }
  await archive('emscripten-4.0.10-sources', emFiles.map(name => [name, `corresponding/emscripten/${path.relative(em, name)}`]));

  const sdl = path.join(em, 'cache/ports/sdl3', sdlDirectory);
  const sdlFiles = [];
  for (const directory of ['src', 'include', 'cmake', 'build-scripts']) sdlFiles.push(...await walk(path.join(sdl, directory)));
  for (const name of await fs.readdir(sdl, { withFileTypes: true })) {
    if (name.isFile() && !excluded.test(name.name)) sdlFiles.push(path.join(sdl, name.name));
  }
  await archive('sdl-3.2.4-sources', sdlFiles.map(name => [name, `corresponding/${sdlDirectory}/${path.relative(sdl, name)}`]));

  const projectFiles = [];
  for (const directory of ['scripts', 'tools', 'web']) {
    for (const name of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      if (name.isFile() && !excluded.test(name.name)) projectFiles.push(path.join(root, directory, name.name));
    }
  }
  for (const directory of ['tools/extractor-deps', 'web/lib', 'web/vendor', 'web/data', 'web/test', 'test', 'docs', '.github']) projectFiles.push(...await walk(path.join(root, directory)));
  for (const name of ['package.json', 'vercel.json', 'server.mjs', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes']) projectFiles.push(path.join(root, name));
  const projectEntries = projectFiles.map(name => [name, path.relative(root, name)]);
  for (const [source, destination] of [
    ['web/public/runtime/runtime.json', 'build-records/runtime.json'],
    ['web/public/extractor/extractor.json', 'build-records/extractor.json'],
    ['scripts/.build/neverhood-web/config.h', 'build-records/runtime-config.h'],
    ['scripts/.build/neverhood-web/config.mk', 'build-records/runtime-config.mk'],
  ]) projectEntries.push([path.join(root, source), destination]);
  await archive('project-build-sources', projectEntries);

  const runtimeScript = await fs.readFile(path.join(root, 'scripts/build-runtime.sh'), 'utf8');
  const extractorScript = await fs.readFile(path.join(root, 'scripts/build-extractor.sh'), 'utf8');
  const rebuild = `#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Generated from the distributed build recipes; run from the restored root.
set -euo pipefail
ROOT="$PWD"
SOURCE="$ROOT/scummvm"
SDK_VERSION=4.0.10
export EMSDK_VERSION=4.0.10
SDK="$SOURCE/dists/emscripten/emsdk-$SDK_VERSION"
JOBS="\${JOBS:-4}"
(cd "$SOURCE" && bash dists/emscripten/build.sh setup)
# Restore the supplied actual library/runtime sources, not compiler binaries.
cp -a corresponding/emscripten/. "$SDK/upstream/emscripten/"
mkdir -p "$SDK/upstream/emscripten/cache/ports/sdl3"
cp -a corresponding/${sdlDirectory} "$SDK/upstream/emscripten/cache/ports/sdl3/"
printf '%s\\n' '${sdlTag}' > "$SDK/upstream/emscripten/cache/ports/sdl3/.emscripten_url"
BUILD="$ROOT/scripts/.build/neverhood-web"
${runtimeScript.slice(runtimeScript.indexOf('set +u'), runtimeScript.indexOf('# Deliberate allowlist:'))}
cd "$ROOT"
BUILD="$ROOT/scripts/.build/extractor"
mkdir -p "$BUILD/prefix"
${extractorScript.slice(extractorScript.indexOf('set +u')).replace(/^node .*package-extractor.*$/m, '')}
printf '%s\\n' 'Built scripts/.build/neverhood-web/scummvm.{js,wasm} and scripts/.build/extractor/inno/innoextract.js (plus .wasm).'
`;
  await publish('REBUILD.sh', Buffer.from(rebuild));
  await publish('inventory.json', Buffer.from(json({ version: 1, members: inventory })));
  const binaryRecords = [];
  for (const name of ['runtime/scummvm.js', 'runtime/scummvm.wasm', 'runtime/neverhood.dat', 'extractor/innoextract.js', 'extractor/innoextract.wasm']) {
    const data = await fs.readFile(path.join(root, 'web/public', name));
    binaryRecords.push({ name, bytes: data.length, sha256: hash(data) });
  }
  await publish('README.txt', Buffer.from(`CORRESPONDING SOURCE AND REBUILD INSTRUCTIONS

These downloads are actual source files, served beside the binaries on the same
static website. No access to the private project repository is required.
Download manifest.json and every files[].name from this
directory. All URLs are simple sibling filenames. SHA-256 and byte lengths are
in manifest.json; inventory.json additionally hashes every archived source file.

RESTORE (Linux, GNU tar, xz, Node.js 22+, Bash, Python 3, Git, wget/curl,
CMake 3.16+, Ninja, make and a native C++ compiler for optional data tools)
1. Verify the download hashes against manifest.json, for example:
   node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const m=JSON.parse(fs.readFileSync("manifest.json")); for(const f of m.files) {const b=fs.readFileSync(f.name);if(b.length!==f.bytes||createHash("sha256").update(b).digest("hex")!==f.sha256)throw Error(f.name)}'
2. Work in a new empty directory. Extract each independent .tar.xz there:
   tar -xJf /path/to/download/component.tar.xz
   If an archive is split, concatenate its parts in manifest part order first:
   cat component.tar.xz.part* > component.tar.xz
   tar -xJf component.tar.xz
   Extract ALL components into the SAME directory; do not strip path prefixes.
3. Copy downloaded REBUILD.sh into that restored root; run:
   JOBS=4 bash REBUILD.sh
   This installs the standard Emscripten SDK 4.0.10 from upstream, restores the
   supplied Emscripten/SDL source trees into it, and compiles both binaries using
   the original recipes and flags. No private downloads or game data are needed.
   SDK compiler executables, LLVM and Node are standard build tools downloaded
   by upstream setup, deliberately not in these source archives.
4. Runtime outputs: scripts/.build/neverhood-web/scummvm.js and scummvm.wasm.
   Extractor outputs: scripts/.build/extractor/inno/innoextract.js and .wasm.
   The generated REBUILD.sh omits only network source fetches (dependencies are
   already supplied) and final site packaging. Original scripts are included.
   package-runtime.cjs obtains provenance from a Git checkout; this extracted
   source subset intentionally has no .git, so use the compiled outputs directly.
   Copy scummvm/dists/engine-data/neverhood.dat alongside runtime outputs.
   The upstream devtools/create_neverhood generator is included for provenance.
   It extracts tables from a particular original nhc.exe (MD5 checked in source),
   so regenerating neverhood.dat additionally needs that legitimately obtained
   upstream input, which is NOT included. Rebuilding either WASM does not need it;
   use the unchanged upstream neverhood.dat supplied in this package.

VERSIONS AND SCOPE
ScummVM ${revision}, GPL-3.0-or-later: full Neverhood
engine, shared audio/backend/base/common/graphics/gui/image/math/video code,
top-level build inputs, all engine configure descriptors, Emscripten backend
scripts, and neverhood.dat plus its generator sources. Unrelated engines and
their assets are not part of the binary and are deliberately omitted.
SDL ${sdlDirectory}: actual cache URL ${sdlTag}.
IMPORTANT: the installed Emscripten 4.0.10 port is SDL 3.2.4, NOT 3.2.10;
tools/ports/sdl3.py and include/SDL3/SDL_version.h identify that actual version.
SDL includes its port-generated SDL_build_config.h as used by compilation.
Emscripten 4.0.10, revision ${(await fs.readFile(path.join(em, 'emscripten-revision.txt'), 'utf8')).trim()}:
full system/ library sources (musl, libc++, libc++abi, compiler-rt, libunwind,
malloc implementations and others), src/ JavaScript runtime, tools/ build and
port recipes, third_party/ support and headers. No compiled system libraries,
sysroot cache, compiler binaries or node_modules are distributed here.
Extractor: innoextract 1.9, xz 5.6.4, zlib 1.3.1, bzip2 1.0.8 (source trees).
Boost 1.75.0: ALL boost/ dependency headers plus full filesystem, date_time,
iostreams, program_options and system library directories and root build/license
files. Other Boost libraries' implementation/test/doc trees are not compiled by
tools/extractor-deps/CMakeLists.txt and are omitted. date_time is included, not
only the four components sometimes mentioned in summaries.

All upstream notices/licenses remain in their source trees. Project build
scripts retain their SPDX notices. Build flags, dependency URLs/original archive
hashes and configuration are in build-records/{runtime,extractor}.json and
runtime-config.{h,mk}; scripts/runtime.mk contains exact external linker changes.
Original ScummVM source files are unmodified; no source overlay is used.
Build-record configurations retain original absolute build paths as provenance;
REBUILD.sh regenerates them for your directory rather than using those paths.

LIMITATIONS
This is a scoped corresponding-source package for the identified binaries,
not the full upstream development/test/media distribution and not independent
legal certification. Compiler-generated ScummVM dependency files are checked by
the packager for omitted used upstream source/header inputs. Standard compiler
and host tool installation still needs network access. Bit-for-bit WASM identity
is not promised (dates, paths and tool versions can affect builds). The original
download archive hashes describe upstream release archives, not our repackaged
component archives; use manifest.json for these downloads. No commercial game
BLB files, installers, extracted game files, credentials or private .git history
are included. A future binary/source/flag change requires rerunning the packager
and deploying the matching complete manifest set together.
`));
  const totalBytes = [...archives, ...files].reduce((sum, file) => sum + file.bytes, 0);
  const manifest = { version: 1, archives, files: [...archives, ...files], totalBytes, chunkMaximumBytes: chunkSize,
    runtimeRevision: revision, extractorVersion: extractor.version,
    sourceRevision: revision, emscripten: '4.0.10', sdl: '3.2.4', binaries: binaryRecords,
    dependencyFilesChecked: dependencies.length };
  await fs.writeFile(path.join(output, 'manifest.json'), json(manifest));
  // Remove only previous generated flat outputs, never arbitrary source inputs.
  const retained = new Set(['manifest.json', ...archives.map(x => x.name), ...files.map(x => x.name)]);
  for (const name of await fs.readdir(output)) {
    if (!retained.has(name)) throw new Error(`Unexpected stale source output; review manually: ${name}`);
  }
  console.log(`Total downloadable sources: ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MiB)`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
