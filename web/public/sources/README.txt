CORRESPONDING SOURCE AND REBUILD INSTRUCTIONS

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
ScummVM c546a4c80d2daf3bb1d5a3652279e26f762c0204, GPL-3.0-or-later: full Neverhood
engine, shared audio/backend/base/common/graphics/gui/image/math/video code,
top-level build inputs, all engine configure descriptors, Emscripten backend
scripts, and neverhood.dat plus its generator sources. Unrelated engines and
their assets are not part of the binary and are deliberately omitted.
SDL SDL-release-3.2.4: actual cache URL https://github.com/libsdl-org/SDL/archive/release-3.2.4.zip.
IMPORTANT: the installed Emscripten 4.0.10 port is SDL 3.2.4, NOT 3.2.10;
tools/ports/sdl3.py and include/SDL3/SDL_version.h identify that actual version.
SDL includes its port-generated SDL_build_config.h as used by compilation.
Emscripten 4.0.10, revision b7dc6e5747465580df5984e723b9d1f10d8e804b:
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
