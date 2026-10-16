# Architecture

## Product Boundary

A static HTTPS site delivers the interface and ScummVM in WebAssembly.
Installers, BLB archives and user saves are not sent to the server.
The user selects a game/installer folder or ZIP. Nested directories are searched
automatically for a complete game or an installer with adjacent BIN parts.
No technical file-by-file selection is exposed in the interface.
The launcher uses original procedural CSS clay surfaces and a self-hosted OFL
Mansalva font, not extracted game graphics or the game's font. A decorative CSS
bud follows import state: animated while preparing, closed when ready, static for
reduced-motion users. Engine credits and one source/license link share a single
area; packaging changes that link to the same-origin source-download page.
Import, local storage and removal share one responsive panel. The empty state
shows folder/ZIP import without removal; the ready state hides import and exposes
Play, storage and removal. Removing the browser copy returns to the empty state
without touching original source files or IDBFS saves. Checking and recovery states
avoid briefly showing the wrong controls during library discovery.

## Components

1. Client: file selection, set validation, progress, errors and library management.
2. Storage: OPFS for large files and import metadata.
3. Runtime adapter: connects the C++ engine, filesystem, input and saves.
4. ScummVM: the existing Neverhood engine; original game logic stays in C++.
5. Static server: serves only the client and allowlisted runtime artifacts.

## Import And Storage

- Input filenames are normalized; missing files and duplicates are checked.
- Browser capabilities and estimated available space are checked before copying.
- Archives are streamed rather than buffered with a whole-library `arrayBuffer()`.
- Each import writes to a separate staging/generation directory.
- Only a fully completed import becomes active through metadata.
- Errors or insufficient space must not destroy the previous library.
- Replacement needs space for the old and new copies at the same time.
- Persistent storage can be requested where supported; denial is reported.
- Import does not fully verify the integrity or safety of all resources.

Game data is not stored in `localStorage`. OPFS belongs to the site's origin;
clearing site data deletes the library. Browser quotas and persistent storage
do not provide an absolute durability guarantee. Existing version-1 libraries
remain compatible; displayed edition warnings are derived from the saved
`hd.blb` size rather than old localized warning text in the manifest.

## Runtime BLB Access

Client-side OPFS storage and streaming reads from C++ are separate tasks.
Implementing the first does not imply that the second works.

The long-term priority is seekable file access through a suitable Emscripten
backend, preferably in a worker. OPFS compatibility and synchronous C++ I/O must
be tested with the actual build. The current prototype copies OPFS files into
MEMFS: this is a temporary desktop-oriented compromise. The whole library occupies
RAM, with possible extra copies. It is not a mobile streaming implementation.

## Saved Games

The player mounts persistent IDBFS at `/saves`, separate from OPFS game resources.
Save management uses the same IndexedDB database `/saves`, version 21 and `FILE_DATA`
store as the pinned Emscripten 4.0.10 runtime. Records retain its timestamp, mode
and Uint8Array schema. Changing SDK/schema requires an interoperability review;
the save manager must not independently bump the database version.

All reads, exports and imports use the same Web Lock as the whole player session.
Management fails promptly if a player/import in another tab holds it. Reviewed
imports carry a content fingerprint, rechecked after acquiring the lock, so an
older confirmation cannot replace newer progress. Files are revalidated at commit.

Save validation bounds file/batch sizes, checks raw/gzip version-0 Neverhood data,
thumbnail structure, variable references/cycles and gzip/ZIP CRCs. Original byte
streams remain unchanged. ZIP exports contain only flat canonical save filenames.
Limits are 4 MiB per save and 32 MiB per collection; compressed input gets a bounded
ZIP-header overhead allowance. No save data is sent to the server.

Before modifying existing saves, a single IndexedDB transaction writes a ZIP of
the old collection and all imported records. Backups live in the hidden IDBFS
directory `.neverhood-web-backups`; the latest three are retained and downloadable.
The game ignores these as save slots. Backup and replacement writes roll back
together on failure. Unaffected slots and unrelated metadata are preserved.

Storage & more remains accessible without game resources. Removing the OPFS
library does not delete IDBFS progress or disable backup export. Clearing browser
site data or eviction can still remove both; downloaded copies are essential.
The player uses the original game save/load menus, rather than the generic GUI.
Real native imports, byte-exact ZIP roundtrips, quota rollback, stale-plan rejection,
cross-tab locking and one in-game save/exit/reload/load cycle passed Chromium checks.
This is not a complete playthrough or a cross-platform durability guarantee.

## Installer And ZIP Import

The browser receives only files selected by the user, not an arbitrary local path.
The current local example needs an Inno Setup 5.4.2 EXE and its adjacent BIN.
innoextract 1.9 is compiled to WASM, runs in a worker and never executes Windows code.
WORKERFS mounts File objects without copying the whole input; a 16 MiB bounded
read-ahead cache prevents pathological tiny FileReaderSync calls. A silent listing
provides exact sizes and paths before extraction. Seven anchored includes, guarded
writes and exact output sizes limit what is extracted. Limits: 2 GiB input,
1 GiB game output and 512 MiB per BLB. Only validated BLBs are adopted transactionally.

ZIP input uses vendored fflate 0.8.2 with a checked central directory, stored/deflated
methods, size limits and CRC32. A dedicated worker writes to temporary OPFS using
synchronous access handles, bounded input chunks and backpressure. Selected outputs
are kept only for the import callback. Unsafe paths, duplicates, links, encryption,
ZIP64, overlaps, suspicious ratios and unsupported methods are rejected.
Flagged UTF-8 names are decoded strictly. Unflagged names accept valid UTF-8 or
fall back to ZIP's CP437 mapping; no language-dependent codepage guessing is used.
Info-ZIP Unicode Path overrides require version 1 and the matching raw-name CRC.
Central-only overrides are supported, while local raw names must match central
bytes and any valid local Unicode override must agree. Both legacy and Unicode
aliases retain traversal and duplicate-name checks.

Each temporary pipeline has its own lock; only final library adoption takes the
library lock. Abort, missing parts and quota denial preserve the previous library.
Temporary staging is removed afterwards, or swept on the next matching import if
the tab/process was interrupted. Installer staging and final library coexist;
ZIP-wrapped installers additionally require disk space for the unpacked input.
Support for arbitrary repacks is not promised. A folder with installed game data
is discovered through the same interface and skips installer extraction.

## Player Lifecycle

Each Play creates a same-origin iframe with a fresh Emscripten runtime. Parent and
child check origin, message source and a session nonce. Loading appears immediately
in a fixed viewport overlay, with background scrolling and interaction disabled.
SDL manages the drawable, high-DPI scale and resizing; CSS contains the scene in 4:3.
Filtering is enabled. This scales original art; it is not an HD asset replacement.
Resize handling follows the actual SDL GL/keyboard-focus window and its ID,
including renderer recreation and later graphics initialization. It reapplies the
embedded viewport through SDL if the drawable no longer matches the requested
high-DPI size; it never directly changes the GL canvas dimensions.

The browser backend intentionally reports NoQuit, so game Quit otherwise returns
to ScummVM's launcher and `onExit` alone is insufficient. External linker flags
export the existing `g_engine` address and `getValue`, without source changes.
After the pointer has been nonzero, a zero marks actual engine destruction.
The child hides the canvas, pauses the game loop, flushes IDBFS and reports exit.
The parent removes the iframe, releases the library lock and enables Play again.
Normal exit uses the game's own Quit menu; there is no site-level stop button
during play. Loading can be cancelled before the engine starts. A bounded timeout
disposes a wedged frame and warns if saving could not complete. The canvas uses
the whole viewport without a top toolbar; fullscreen controls float in available
letterbox margins, with a minimal corner fallback if there is no margin.

## Future HD Replacements

Game logic remains at 640x480. An optional pack maps resources and animation
frames to HD textures without changing timing, offsets, collisions or events.
Missing replacements fall back to the original. This is a proposed interface,
not an existing ScummVM Neverhood feature.

The first experiment covers one room, one background and one animated object.
Internal x4 composition (2560x1920) is a possible starting point; on UHD displays,
the 4:3 area is 2880x2160 with side bars. HD assets must not first be reduced to
the old 640x480 buffer. Palettes, clipping, cursor, menus and inverse input mapping
need separate checks to avoid applying existing backend scaling twice.

## Verification And Limits

Desktop Chromium is the first target. Firefox and mobile Safari require separate
checks. File size, peak RAM and GPU memory must be measured separately.
Successfully reaching the first room does not prove a complete playthrough,
save reliability, offline support or mobile compatibility.
