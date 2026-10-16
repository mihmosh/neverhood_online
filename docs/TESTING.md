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

Automatic installed-folder discovery, first room, 4:3/high-DPI geometry and live resizing, actual in-game
Quit, Return to site, replay without reload and stopping during startup:

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

Browser checks reject upload requests and uncaught page errors. They do not prove
a full playthrough, audible sound, actual save/load reliability, phone support or
offline operation. The IDBFS save directory was checked previously with a persisted
probe; save backup and a complete in-game save/load check remain open milestones.
