# Architecture

## Product Boundary

A static HTTPS site delivers the interface and ScummVM in WebAssembly.
In BYO mode, installers, imported BLBs and user saves are not uploaded.
The user selects a game/installer folder or ZIP. Nested directories are searched
automatically for a complete game or an installer with adjacent BIN parts.
No technical file-by-file selection is exposed in the interface.
The separate HD prototype downloads an explicitly configured S3/CloudFront
release: seven original BLBs plus on-entry HD room ZIPs. This is external asset
delivery, not an upload of a BYO user's local copy. The static frontend itself
does not bundle commercial game data.
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
6. HD release host: serves pinned original media and lossless room/state ZIPs;
   the external compositor and Cache Storage remain separate from engine logic.

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
Filtering is enabled for the stock/BYO high-DPI path. That scaling alone is not
an HD asset replacement; the separate HD compositor is described below.
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

## Private Asset Catalog

Offline Node tools range-read the original archives without loading the entire
game into memory. Every physical entry, archive checksum, timestamp, extension
pointer and alias is retained. DCL payloads are decoded independently in the
project's JavaScript tooling, outside the unchanged engine source.

SQLite stores normalized provenance, decoded frames, palettes, logical aliases,
raster variants, explicit scene associations and replacement jobs. Large payloads
live in immutable SHA-256-addressed files, not database BLOB columns. A JSONL index
is an interchange snapshot refreshed by extraction/association; SQLite remains
authoritative for later job changes.

Frame IDs include requested/resolved provenance, animation list and ordinal;
nonunique animation message hashes are metadata only. Runtime variants reproduce
aligned surfaces, zero padding and frame-rectangle flips. Scene associations
record constructor capacities and active palettes when archive metadata alone
is insufficient. For room 1001, the background and flipped lever CRCs match the
live renderer, including its padded 72x73 lever surface.

PNG previews with embedded palettes do not establish scene-correct transparency
or colors. Job preparation explicitly chooses the scene palette and alpha mode,
verifies indexed raster SHA/CRC, and emits a matching padded PNG. Replacement
registration checks expected 4x dimensions, PNG framing/CRCs and alpha presence;
only explicit owner-reviewed jobs enter the private runtime map. These checks
do not certify perceptual fidelity or prove a model preserved every alpha pixel.

Default outputs remain under ignored `private-assets/`, with a required private
marker, symlink checks and source/public/build-path refusal. The public build does
not copy this workspace; source packaging skips private/marker-bearing trees and
database/media files. CI audits Git and public trees, but does not perform an
artwork-similarity scan. These catalog commands operate locally without invoking
models; separately documented upscaling tools and historical cloud runs have
their own execution/acceptance boundaries.

## Current External HD Delivery

The current prototype uses the unchanged stock full-game runtime. It does not
load the historical restricted demo binary or introduce new engine exports,
source overlays or WASM patches. A read-only adapter follows common Module/Scene
fields; it does not interpret every module as the Module1000 subclass.

One private original-to-HD table records native identities, geometry, used-palette
RGB proofs, replacement PNG hashes and room membership. It preserves the two
working legacy room mappings. Existing version-2 room ZIPs opt into lossless PNG
images; the same loader validates and caches them. The current release contains
134 room/state packs, not 134 unique rooms or proof of complete HD coverage.

Native background fingerprints select a room pack on entry. Indexed composition
is checked against the native backbuffer before HD presentation. Palette proofs
ignore unrelated palette slots and the unused fourth byte, but reject changed
used colors. Menus, unsupported output, ambiguous contexts and absent HD assets
retain native output. Inactive decoded room packs are released while verified
Cache Storage entries survive reload; hashes are checked again on reuse.

All seven original BLBs (638,122,574 bytes) remain shared startup data in MEMFS,
including all 551 original Smacker resources. Cutscene/navigation upscaling is
in progress, so original videos remain in use without transcoding. This delivery
does not stream the original game by room and is not a low-memory mobile design.
See [the current mapping contract](ROOM_HD_RESTORATION.md#full-game-room-mapping-2026-10-21)
and [deployment](DEPLOYMENT.md#current-hd-prototype-release).

### Room-Scoped Original And HD Loading

The selected release is `https://d3gutt3a0gjwwo.cloudfront.net/room-streaming-v1/manifest.json`.
The compiled stock JS/WASM remains unchanged. The external player creates seven
read-only sparse FS nodes with exact native BLB sizes instead of downloading their
full 638 MB. A dedicated Worker fetches SHA256-pinned 64 KiB physical ranges and
maintains a separate verified persistent cache. The player asynchronously prepares
bootstrap/current-room dependencies and neighbor entry resources before accepting
new input; neighboring navigation movies continue prefetching in the background.

The source-derived graph records 244 native scene IDs, 135 HD mappings and 475
explicitly associated original video bundles. Navigation lists are decoded from
the original engine data; movies are not replaced with static HD backgrounds.
Existing room ZIPs remain logical containers, but pinned member indexes allow
strict HTTP 206 reads of individual PNGs instead of whole-room ZIP downloads.
Each returned member is independently verified; partial delivery is never reported
as verification of the complete ZIP. Missing optional HD images retain their
native layers without discarding an available verified HD background.

Cold first-room verification loaded 22,740,992 original bytes in about 5.3 seconds;
a fresh page/Worker reused 347 cached blocks with zero original network traffic.
The native first-room -> second-room -> courtyard navigation movie `2028A041`
route completed with zero synchronous misses and maximum original FS read below
1 ms. Three-room offline backtracking also retained HD output. Corrupt cached
blocks are rehashed and repaired; transport failures show Retry and start a fresh
native session rather than returning false EOF or resuming a failed native read.

Original memory is capped at 128 MiB, original persistent blocks at 256 MiB, and
the HD encoded/persistent caches at 32/256 MiB respectively. Startup originals
have a 32 MiB preflight ceiling. COOP `same-origin` and COEP `require-corp` are
required on both the parent page and player iframe. CDN CORS exposes Content-Range;
the client rejects a full-file 200 response to a Range request.

Static dependency closure remains explicitly qualified for dynamic references and
unresolved edges. These checks are not a complete playthrough or physical-device
certification. An unexpected unready native read has a bounded terminal failure,
never invented bytes. The previous full-download release remains available at
`full-game-lossless-v1` as the reference path, not a silent fallback.

### Earlier Transport Experiments

Before the implementation above, the 2026-10-21 transport experiment retained the
reference launcher. Stock `Module.FS` permits per-file read-only
`stream_ops.read`/`llseek` overrides, with real file sizes and no full-file backing
allocation. Memory hits, independent descriptors, positioned reads, cross-block
reads, `SEEK_END` and short EOF reads were verified on the unchanged artifact.
Promise-based fetching cannot complete a synchronous native read by itself.

The first independent-provider candidate, synchronous Window XHR to a controlling
Service Worker, failed in Chrome 156: synchronous requests bypassed the SW and got
origin 404 responses even after the same URL had been verified and cached through
asynchronous fetch. This invalidates that transport, not all external transports.

A second experiment used a dedicated Worker, SharedArrayBuffer and atomic
completion under COOP `same-origin` / COEP `require-corp`. The Worker independently
fetched exact 64 KiB physical BLB ranges, verified SHA256 and used Cache Storage.
The Window synchronously read completed bytes through a bounded atomic spin; it
never called unsupported Window `Atomics.wait`, substituted zeroes, or treated a
missing block as EOF. Physical block addressing also covered shadowed archive
entries, gaps and tails omitted from the historical resource-only index.

This transport actually launched the stock game with 2,555,904 original bytes
before the first confirmed room frame in one run (2.54 seconds). Menu/return worked;
the maximum interactive long task on that short route was 82 ms. Persistent-cache
reads while offline and after Worker restart succeeded. Corruption, unavailable
network and a dead Worker produced finite errors, not invented bytes. The Worker
script was restarted online before the offline check; a fully offline application
restart was not established.

It is not a safe general cache-miss architecture. An added 150 ms response delay
blocked the Window for 175.82 ms and consumed roughly 0.20 renderer CPU-seconds.
Another cold natural Scene1001 -> Scene1002 -> Scene1004 trace downloaded
8,060,928 original bytes but produced 172 ms and 119 ms interactive long tasks.
That fails the experimental 100 ms interactive-stall target; the 32 MiB startup
target alone is insufficient. Scene1004 is an ordinary ladder room, not proof of
a navigation movie. Startup long tasks also exceeded 100 ms.

A second fresh-context route prefetched only those 123 verified blocks
asynchronously before entry. With an added 150 ms delay per network response this
took 5.156 seconds, then native Scene1001 -> Scene1002 -> Scene1004 -> Scene1002
completed with the return performed offline: zero redownloads, no unexpected cold
misses/spins, maximum FS read 1.095 ms and maximum interactive RAF gap 83.335 ms.
This is evidence for prefetch on that observed route, not a validated per-room
dependency graph. No post-room1 Smacker was read or decoded; the startup video
resource is not a navigation-video proof. Return all the way to Scene1001 and the
required navigation-movie/camera-return slice were not established.

Timeout/error here aborts a current synchronous read; it does not safely suspend
and resume its native continuation. No safe arbitrary-miss retry has been proved.
Therefore no room graph, original/HD/video bundling migration or mass repack was
started. Verified async prefetch plus proven dependency closure and pre-entry
barriers remain prerequisites; a small successful trace is not that closure.
Neither COOP/COEP deployment to the real asset CDN nor mobile support was certified.
The stable reference and port-4204 visual release still fetch all original BLBs at launch;
the selected streaming release does not.

The isolated executable experiments and full traces remain under `/tmp/kilo`:
`neverhood-sparse-proof.mjs`, `neverhood-sparse-transport-check.mjs`,
`neverhood-sab-proof.mjs`, `neverhood-sab-browser.mjs`, `neverhood-sab-jitter.mjs`,
`neverhood-sab-route.mjs`, `neverhood-sab-route-cold.json` and
`neverhood-sab-route-warm.json`. They are diagnostic experiments, not public runtime
modules or production delivery contracts. The public source archives contain the
implemented visual fixes and this failure/measurement record, not private BLB bytes.

## Historical First-Room Adapter Experiment

The following describes the earlier isolated prototype, not current delivery.

The opt-in `?renderer=room1-proxy` experiment reads the completed render queue from
the exact stock WASM identified by SHA-256. Clang layouts are generated from
existing human-authored translation units with `-fsyntax-only`; no C++ probe,
overlay or engine source changes are used. The runtime hash is captured from the
actual instantiated bytes, avoiding a second-fetch deployment race.

The adapter gates module 1000/scene 0, rejects menu swaps, pending restores,
video/full-refresh modes, incomplete queues, unsupported surfaces and invalid
heap ranges. It refreshes the existing global HEAPU8 after memory growth. It must
not retain borrowed heap views across asynchronous work.

The authentic mouse is not in the scene render queue: Neverhood sends it through
CursorMan to a separate backend pass. The proxy reads its bounded original indexed
surface, visibility, position and hotspot through additional compiler layouts,
then draws a transparent input-pass-through cursor canvas above the scene/HD output.
It follows the game palette, preserves clipping, hides over lab UI and on blur,
and yields entirely to the original backend in fallback modes. Cursor failure
restores the whole original frame; scene pixel comparisons exclude cursor pixels.

An independent indexed compositor is checked against the 640x480 native back
buffer. Only exact matches may replace the visual output. A separate Canvas2D
compositor retains logical coordinates, original input, ordered layers and masks.
Private 4x PNG replacements bypass the low-resolution output. Content/shape/palette
fingerprints identify observed rasters, not semantic resource IDs. CRC collisions
are checked against captured bytes; mismatches fail back to the original.

Limits include 8 MiB of interned indexed rasters, bounded decoded canvases, 64 MiB
of replacement textures and 2048 catalog entries. The 1x displayed-pixel oracle
is an explicit diagnostic readback, not a per-frame GPU readback. Other engine
rendering continues normally. This is a prototype of one room, not a supported
generic rendering or memory API; a future engine-side bridge should replace it.

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
