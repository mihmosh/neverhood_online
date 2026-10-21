# Third-Party Notices

## Private Asset Extraction

`tools/assets/dcl.mjs` is an altered JavaScript implementation based on the format
and tables of Mark Adler's blast 1.3, copyright 2003, 2012, 2013 Mark Adler. Its
zlib-style notice is retained verbatim in that source file; this is not the
original implementation. See [upstream blast](https://github.com/madler/zlib/tree/master/contrib/blast).
The tool extracts a user's private game data; its source/license inclusion does
not grant distribution rights to extracted media or derived artwork.

Neverhood Online integrates existing open-source software. This index identifies
the bundled components and their retained notices; it does not replace their
license texts, remove attribution or relicense their code. Copyright remains
with the respective authors. The project's GPL-3.0-or-later election does not
override explicit MIT notices in individual project files or any third-party
license.

## Backstage Restoration References

Five existing photographic references are included at the maintainer's explicit
request in [tools/upscaling/references/backstage](tools/upscaling/references/backstage/README.md).
Their [catalog](tools/upscaling/references/backstage/catalog.json) records byte
sizes and SHA256. Photographer, original source URL and reuse license are
currently unspecified; the project's software license does not relicense these
photographs. They are reference material, not bundled game-resource exports.

## Cursor Research Tooling

The [HD cursor tools](tools/hd-cursor/README.md) use Blender (including its
bundled NumPy) and host Pillow as separately installed dependencies; those
packages are not vendored by the subproject. The repository software license
does not establish or grant rights to the input models, game-specific geometry
recipes or generated cursor artwork. Their distribution rights are unresolved,
and they remain outside the public source set. See
[Rights And Publication](tools/hd-cursor/docs/RIGHTS.md).

## ScummVM Runtime

- Project: [ScummVM](https://www.scummvm.org/), copyright (C) 2001-2026 ScummVM contributors, with individual credits retained below.
- Exact source revision: `c546a4c80d2daf3bb1d5a3652279e26f762c0204`; only the Neverhood engine is enabled in this runtime.
- Credited Neverhood engine authors: **Benjamin Haisch (`john_doe`)** and **Filippos Karapetis (`bluegr`)**. See [upstream engine credits](https://github.com/scummvm/scummvm/blob/c546a4c80d2daf3bb1d5a3652279e26f762c0204/engines/neverhood/credits.pl). These are the engine reimplementation credits, separate from the original game's creative team.
- License: GNU GPL version 3 or later, with upstream component notices preserved.
- Copies: [COPYING](web/public/runtime/COPYING), [COPYRIGHT](web/public/runtime/COPYRIGHT), [AUTHORS](web/public/runtime/AUTHORS) and [LICENSES/](web/public/runtime/LICENSES/).
- Build flags, filesystem exports and external linker overrides: [runtime.json](web/public/runtime/runtime.json). The original ScummVM source is not manually modified by this integration.

`web/public/runtime/neverhood.dat` is the upstream ScummVM engine helper data,
separate from the seven commercial game BLB archives. BYO users supply those
locally; the HD prototype downloads them from its configured external release. It
contains tables extracted by ScummVM's `devtools/create_neverhood` tool from a
specific original executable; it is not an independently authored replacement
game or a grant of rights to the original game's content. The corresponding
source package includes the upstream helper and generator. Regenerating that
helper additionally requires the original input identified by the generator,
which is not distributed here. See the [source package instructions](web/public/sources/README.txt).

The runtime's retained `LICENSES/` directory contains `SDL.txt`,
`CatharonLicense.txt`, `COPYING.Apache`, `COPYING.BSD`, `COPYING.BSL`,
`COPYING.GLAD`, `COPYING.ISC`, `COPYING.LGPL`, `COPYING.LUA`, `COPYING.MIT`,
`COPYING.MKV`, `COPYING.MPL`, `COPYING.OFL` and `COPYING.TINYGL`. These are
upstream notices, not a claim that every upstream optional component is linked
into the Neverhood-only binary.

## Emscripten And SDL

- [Emscripten](https://emscripten.org/) SDK **4.0.10**, source revision `b7dc6e5747465580df5984e723b9d1f10d8e804b`, supplies the WebAssembly/JavaScript runtime and system libraries. Emscripten's main license offers MIT or University of Illinois/NCSA terms; see [emscripten-LICENSE.txt](web/public/extractor/emscripten-LICENSE.txt).
- [SDL](https://www.libsdl.org/) **3.2.4**, copyright Sam Lantinga and contributors, is the actual Emscripten port used by the runtime. It is **not 3.2.10**. Its zlib-style license is retained at [SDL.txt](web/public/runtime/LICENSES/SDL.txt).
- System-library notices are retained at [musl-COPYRIGHT.txt](web/public/extractor/musl-COPYRIGHT.txt), [libcxx-LICENSE.txt](web/public/extractor/libcxx-LICENSE.txt), [libcxxabi-LICENSE.txt](web/public/extractor/libcxxabi-LICENSE.txt) and [compiler-rt-LICENSE.txt](web/public/extractor/compiler-rt-LICENSE.txt). These preserve the applicable permissive, LLVM and exception terms instead of treating the toolchain libraries as uniformly GPL.

The Emscripten source download includes the matching system library and runtime
sources and their own notices. Standard SDK compiler executables are build tools,
not bundled application dependencies. See the source manifest for the precise
source package and binary bindings.

## Installer Extraction

[innoextract](https://constexpr.org/innoextract/) **1.9**, copyright (C) 2011-2020
Daniel Scharrer and contributors, parses supported Inno Setup installers. It is
compiled to WASM and does not execute the selected Windows installer.
Its zlib-style notice is retained at
[innoextract-LICENSE.txt](web/public/extractor/innoextract-LICENSE.txt).
Exact dependency URLs, hashes, build options and artifact hashes are recorded in
[extractor.json](web/public/extractor/extractor.json).

| Dependency | Version | License/Notice Copy |
| --- | --- | --- |
| Boost, Boost authors and contributors | 1.75.0 | Boost Software License 1.0: [boost-LICENSE.txt](web/public/extractor/boost-LICENSE.txt) |
| XZ Utils/liblzma, XZ Utils authors and contributors | 5.6.4 | liblzma: BSD Zero Clause; package scope: [xz-COPYING.txt](web/public/extractor/xz-COPYING.txt), [xz-0BSD.txt](web/public/extractor/xz-0BSD.txt) |
| zlib, Jean-loup Gailly and Mark Adler | 1.3.1 | zlib license: [zlib-LICENSE.txt](web/public/extractor/zlib-LICENSE.txt) |
| bzip2, Julian Seward | 1.0.8 | bzip2 license: [bzip2-LICENSE.txt](web/public/extractor/bzip2-LICENSE.txt) |

Boost's supplied source includes headers and the filesystem, date_time,
iostreams, program_options and system libraries. XZ's package includes files
under other licenses; the summary above describes linked liblzma, not a blanket
license for all XZ utilities or build files. Emscripten system-library notices
listed above also accompany the extractor.

## ZIP Decompression

[fflate](https://github.com/101arrowz/fflate) **0.8.2**, copyright (c) 2023 Arjun
Barrett, is used under the MIT License. The vendored browser module is
`web/vendor/fflate-0.8.2.js`; its full notice is
[fflate-LICENSE](web/vendor/fflate-LICENSE). The pinned source revision
`d3243651cb142e3e04f3e4bc037b9e985878f444`, upstream archive and checksums are
recorded in [fflate-provenance.json](web/vendor/fflate-provenance.json).

## Handwritten Menu Font

[Mansalva](https://github.com/carolinashort/mansalva) **2.112**, designed by
**Carolina Short**, is bundled unmodified as
`web/assets/fonts/Mansalva-Regular.ttf` under the **SIL Open Font License 1.1**
(`OFL-1.1`), independently of the application code's license.

The font and Google Fonts metadata state:
Copyright 2022 The Mansalva Project Authors (https://github.com/carolinashort/mansalva).
The verbatim accompanying license notice states:
Copyright 2019 The Mansalva Project Authors (https://github.com/carolinashort/mansalva).
Both are retained without changing upstream notices. The complete license is
[OFL.txt](web/assets/fonts/OFL.txt).

The source is the official [Google Fonts family directory at revision
`4e5f06dbb274a27ebe71ed54ea706b3ee40eabd9`](https://github.com/google/fonts/tree/4e5f06dbb274a27ebe71ed54ea706b3ee40eabd9/ofl/mansalva).
[provenance.json](web/assets/fonts/provenance.json) records immutable download
URLs, SHA-256 checksums, Git blob IDs and author/license metadata;
`node scripts/vendor-menu-font.mjs` verifies and reproduces the local copies.
The original source TTF is used directly without conversion and is included with
its license and provenance in the source package. No Google Fonts runtime
request is needed. This font is not copied from The Neverhood or its assets.

## Corresponding Sources And Redistribution

Matching sources, preserved upstream notices and build materials are distributed
in [web/public/sources/](web/public/sources/), with a
[manifest](web/public/sources/manifest.json), per-file inventory and
[rebuild instructions](web/public/sources/README.txt). The deployed site exposes
these downloads at `/sources/` beside its binaries without requiring GitHub
authentication. The manifest identifies SDL 3.2.4 and binds the source set to the
specific runtime/extractor artifacts by SHA-256.

If you change or redistribute binaries, preserve all applicable notices, review
the actual licenses and distribute the matching corresponding source and build
materials as required. A link to an upstream revision alone is not a substitute
for the applicable source-distribution obligations. This index is not an
independent legal certification of compliance.

## Original Game Rights

The Neverhood name, characters, artwork, audio and commercial game data belong
to their respective rights holders. Commercial BLBs and installers are not
included in this repository or its static frontend. BYO users provide files they
are entitled to use. The separately configured S3/CloudFront prototype release
serves original BLBs, original videos inside those BLBs, and selected derived
graphics. Operator authorization to publish is not rights-holder permission or
legal clearance. Open-source software licenses do not grant rights to those
game assets or legal immunity, and this project is not affiliated with or
endorsed by ScummVM or the game's rights holders.
