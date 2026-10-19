# Development Testing

## Unit Tests

```sh
npm test
```

Covers the restricted static server, English UI/docs, game discovery, BLB headers,
transactional import/cancellation, bounded worker reads, ZIP framing, path and size
limits, CRC validation, decompression and temporary-storage cleanup. Mock filesystem
tests do not replace real browser checks.
Static packaging tests additionally verify allowlisted output, correct artifact
paths, missing/invalid-build failures, source revision/size/hash checks, symlink
rejection, real 404s and Vercel worker-isolation headers.

## Static Production Preview

```sh
npm run build
PORT=4174 npm run preview
```

Set `TEST_ORIGIN=http://127.0.0.1:4174` on the browser checks below to test the
packaged `dist/` tree rather than the development aliases. The full game launch,
resize, Quit/replay and adaptive-panel checks passed against this output.
This validates the local static bundle, not an actual Vercel redeployment.
`npm run verify:deployment -- <origin>` checks the hosted static output, including
all public source-file byte counts and hashes. The same check can target a local
preview origin before pushing.

## Builds

```sh
npm run build:runtime
npm run build:extractor
npm run package:sources
npm run vendor:zip
NODE_PATH="$(npm root -g)" node scripts/smoke-runtime.cjs
node tools/smoke-extractor.cjs
```

Builds use Emscripten 4.0.10 and ignored `scripts/.build/` directories. The first
build needs network access and SDK/dependency disk space. No apt changes or game/demo
downloads are performed. Extractor dependencies and the ZIP vendor package are pinned
by SHA-256; generated metadata records versions and licenses. The native Node extractor
smoke compares every real output BLB's SHA-256 against the private reference extraction.
These are maintenance operations, not Vercel deployment steps. The committed WASM
and matching source bundles let a fresh repository checkout run `npm run build`
without the upstream checkout, SDK, game files, secrets or environment settings.

## Browser Checks

Start `npm run dev`. Tests require Playwright and Chrome, installed separately from
the dependency-free production client. All checks use a temporary, disk-backed Chrome
profile, never the user's browser profile. Test data stays local and is removed after
the test; a successful run does not import a library into the user's normal browser.

Basic English/responsive interface:

```sh
PLAYWRIGHT_MODULE="$(npm root -g)/playwright" node test/browser-smoke.mjs
```

Layout checks cover 1366x768, 1280x720, 1024x768, 390x844, 360x740 and 320x568.
Prepare and Play must fit in the first viewport without horizontal scrolling.
The credited engine authors must also be visible in the desktop first viewport.
Mobile checks cover the launcher layout, not mobile gameplay compatibility.
The theme checks also cover the real labeled native folder chooser, visible
keyboard focus, locally loaded font, actual import-state animation and reduced
motion. Player checks require no top toolbar, fullscreen controls outside the
canvas when a letterbox is available, no site-level stop action while playing,
two real in-game Quit/replay cycles and cancellation of a stalled startup.

Automatic installed-folder discovery, first room, 4:3/high-DPI geometry and live resizing, actual in-game
Quit, replay without reload, loading cancellation and fullscreen controls:

```sh
PLAYWRIGHT_MODULE="$(npm root -g)/playwright" \
GAME_DATA_DIR="/path/to/your/installed-game" \
TEST_RUNTIME=1 \
SCREENSHOT_PATH=/tmp/neverhood-player.png \
node test/browser-smoke.mjs
```

Add `INSTALLER_DIR` for a folder containing the EXE and adjacent BIN, or
`INSTALLER_ZIP` for a ZIP containing that folder, possibly nested. All supplied
sources are prepared sequentially, removing the preceding browser copy through the
UI before choosing another source. Empty/ready states, hidden import/remove controls,
reload persistence, responsive width and the final removal transition are asserted.
A real local
638122574-byte game and nested installer ZIP were tested, including a ZIP with
legacy-encoded non-UTF8 parent directory names. `test/zip-fixture.mjs` creates a
streamed private stored ZIP with raw filename bytes for this regression.
Room/menu visual checks
are heuristics for this English edition, not generic full-game correctness proofs.

Real worker failure, cancellation, quota denial and preservation of the old library:

```sh
PLAYWRIGHT_MODULE="$(npm root -g)/playwright" \
INSTALLER_EXE="/path/to/your/installer/setup.exe" \
INSTALLER_BIN="/path/to/your/installer/setup-1.bin" \
node test/browser-installer-smoke.mjs
```

## First-Room Render Experiment

```sh
npm run prototype:abi
PLAYWRIGHT_MODULE="$(npm root -g)/playwright" \
GAME_DATA_DIR="/path/to/your/installed-game" \
SCREENSHOT_PATH=/tmp/neverhood-room1.png \
node test/browser-room1.mjs
```

Generating layouts requires the pinned existing WASM build, SDK and upstream
checkout. It compiles only existing source translation units for layout data,
without source edits, objects or dependency output. Normal builds use the committed
metadata; the layout-dump comparison test skips when local compiler dumps are absent.

The real-browser test compares all native indexed pixels, explicitly checks the
presented 1x RGBA output, exercises Klaymen/lever input and raster changes, and
loads a synthetic private 4x PNG. Two adjacent output pixels must retain distinct
colors impossible through a 640x480 intermediate. It also checks runtime-hash
rejection, original/proxy switching, menu fallback and normal Quit. Synthetic PNGs
prove the pipeline, not AI image quality. No original game images are committed.

## Private Assets And Mapping

```sh
npm run assets:extract -- --init-private --input "/path/to/your/DATA"
npm run assets:extract -- --input "/path/to/your/DATA"
npm run assets:map -- inspect
npm run assets:audit
```

The second extraction validates and resumes content-addressed output. Tests use
synthetic archives and a private temporary SQLite catalog, never committed game
media. They cover DCL bounds, bitmap/RLE decoding, animation ordinals, PNG CRCs,
alias failures, corruption repair, private path refusal, padded/flipped rasters,
contextual capacities/palettes and approval-gated replacement registration.

Real archive validation found no extraction or image-decode errors. Background
pixel CRC 1bd38d80 / palette a1e6ba93 and lever CRC 78605358 on a padded 72x73
flipped raster match live engine observations. Native cursor tests compare every
cursor pixel at four positions (including edges), hotspot 3,7, three animation
frames, mobile alignment, UI hiding, HD ordering and injected read-failure fallback.
Cursor pixels remain separate from the scene's exact 1x comparison.

SQLite needs Node 22.13+; its experimental warning is expected. ffprobe is optional
for extraction but was available for the real video inventory. Native sound/music
probe failures are metadata limitations, not discarded payloads. Source/public
audits are filename/boundary checks, not perceptual recognition of copyrighted art.

## Private Evaluation Kit

`private-research/README.md` is the local entry point after source downloads. It is
not committed or required by the app. `evaluation:inputs` records exact Smacker
headers/timing and a manual selection template; `evaluation:bundle` inventories
downloaded code/metadata and creates a local transfer archive. Neither uploads
anything or runs models. Git internals, credentials and virtual environments are
excluded. Source symlinks must remain within the portable workspace.

`npm run evaluation:verify` checks every inventoried file. The kit also contains
`verify-inventory.py`, usable after extraction with Python's standard library.
The real bundle was extracted independently and all 16885 files verified.
The future-host preflight and license/environment plans are private planning
artifacts, not a claim of a tested CUDA environment or benchmark result.

## Save Transfer And Recovery

The save regression uses six local native ScummVM files, `neverhood.000` through
`neverhood.005`, as a read-only fixture. They are never committed or modified.

```sh
PLAYWRIGHT_MODULE="$(npm root -g)/playwright" \
NATIVE_SAVE_DIR="/path/to/your/six-slot-native-fixture" \
GAME_DATA_DIR="/path/to/your/installed-game" \
SCREENSHOT_PATH=/tmp/neverhood-save-load.png \
node test/browser-saves.mjs
```

Without GAME_DATA_DIR, only transfer/recovery checks run. With game resources,
the test additionally loads native slot 000 through the original menu, creates a
new in-game save, exports it, exits, reloads the page and loads that new slot.
It checks that removing resources preserves progress and save export access.

Other checks include byte-exact native/ZIP roundtrips, explicit overwrite consent,
cancelled reviews, pre-import restoration, three-backup retention, quota-induced
transaction rollback, stale-plan rejection, cross-tab locking and reload persistence.
The IndexedDB implementation is exercised in a real disk-backed Chrome profile,
including its interoperability with the actual Emscripten IDBFS mount.

Browser checks reject upload requests and uncaught page errors. They do not prove
a full playthrough, audible sound, reliability for every engine/version/edition,
phone support or offline operation. Keep external backups of important progress.
