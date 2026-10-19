# Neverhood Online

[![CI](https://github.com/mihmosh/neverhood_online/actions/workflows/ci.yml/badge.svg)](https://github.com/mihmosh/neverhood_online/actions/workflows/ci.yml)

Play your own copy of The Neverhood directly in your browser.

Neverhood Online is an independent, open-source browser interface around
[ScummVM](https://www.scummvm.org/)'s existing Neverhood engine, compiled to
WebAssembly with [Emscripten](https://emscripten.org/). It is not a new game
engine, a new reverse-engineering effort, an official release or a remaster.
**You supply the game. No game archives or installers are included.**

[Play in your browser](https://neverhood-online.vercel.app) |
[Source code](https://github.com/mihmosh/neverhood_online) |
[Report a bug](https://github.com/mihmosh/neverhood_online/issues) |
[Contribute](CONTRIBUTING.md)

![Neverhood Online onboarding interface, without game artwork](docs/images/onboarding.png)

The launcher uses original CSS clay surfaces, inset fields and a small animated
bud, plus the independently licensed Mansalva typeface. No game screenshots,
sprites, textures, videos or original game font are used in the site design.
The bud follows actual import state and respects reduced-motion preferences.

## Play With Your Own Copy

1. Open the site in a current desktop Chromium browser using a normal browser profile.
2. Choose a folder or ZIP containing your legally obtained installed game, or a supported Inno Setup installer together with all its adjacent BIN parts.
3. Let the importer find the game inside nested folders and extract it automatically where needed. You do not need to pick individual BLB or installer files.
4. Wait for the local import to finish, then choose **Play**. Press Escape for the game's menu and choose **Quit** to return to the site. The floating fullscreen button only toggles browser fullscreen; it does not end the game.

Import and extraction happen locally in the browser. The Windows installer is
parsed by [innoextract](https://constexpr.org/innoextract/) in a WebAssembly
worker, not executed. ZIP decompression uses [fflate](https://github.com/101arrowz/fflate).
Game files are stored in the site's Origin Private File System (OPFS), not uploaded
to a server, and the stored library is discovered again after reload.

The importer looks for `a.blb`, `c.blb`, `hd.blb`, `i.blb`, `m.blb`, `s.blb`
and `t.blb`. A supported installer folder can be inside a ZIP. Inno Setup 5.4.2
was tested; support for every installer, repack or game edition is not promised.
ZIP supports stored and deflated entries. RAR, 7z, encrypted ZIP and ZIP64 are
unsupported: unpack those containers locally, then choose the resulting folder.

### Move Saved Games

Open **Storage & more -> Saved games**, even before importing the game or after
removing its resource files.

1. Exit any running web player, including other tabs for the same site.
2. Choose native ScummVM saves such as `neverhood.000`, or a save ZIP exported here.
3. Press **Import saves** and review descriptions and slot conflicts. Replacing
   existing slots requires an explicit checkbox and confirmation.
4. Press **Play**, then use the game's **Load game** menu to continue.

Original bytes are preserved, including gzip compression; target prefixes become
`neverhood.###`. Before modifying an existing collection, one atomic transaction
stores a ZIP backup and imports the saves. The latest three backups are retained
and downloadable. Failed writes preserve the old collection; stale confirmations
cannot overwrite newer progress.

**Export saves** downloads the current collection as a ZIP. To transfer it to
native ScummVM, back up its save folder first, then extract the saves there and
review filename conflicts. Linux commonly uses `~/.local/share/scummvm/saves/`.
If the native game uses another target prefix, adjust the filenames to match it
while retaining the three-digit slots. Original Windows `.sav` files are unsupported.

Automatic backups are still browser data, not an independent copy. Download
important progress before clearing site data or changing hostname.

### Storage And Compatibility

- Desktop Chromium is the current verified target. Firefox, Safari and mobile gameplay are not verified.
- Use sufficient free disk space and RAM. Temporary extraction can need additional space alongside the final library; private browsing may impose stricter limits.
- Launch currently copies the game resources from OPFS into the runtime's RAM filesystem. This is not streaming playback or a low-memory mobile implementation.
- Browser storage belongs to the exact site origin. Changing hostname or port creates separate storage; clearing site data or browser eviction can remove your library and saves. Keep your original files.
- Removing the imported library does not delete your source files or intentionally remove the separate save directory. Browser storage is not a backup.

## Project Status

This is an early, working desktop-oriented project, not a promise of complete
game compatibility. Real Chromium checks have covered folder and installer ZIP
import, reload persistence, the first room and Escape menu, focused high-DPI
4:3 rendering, resizing, in-game Quit and replay without reloading.

**Important limitations:**

- A full playthrough and audible sound have not been verified.
- Native save import/export, overwrite backups and one real in-game save/exit/reload/load cycle were tested in Chromium. This does not establish reliability for every edition or platform; keep external backups of important progress.
- Offline relaunch is not ready. Local game storage alone does not make the site available offline.
- HD replacements are limited to the separate two-room demo. This is not a whole-game HD remaster; normal BYO play does not download the demo assets.

The automated suite has passed 228 tests; one compiler-dump comparison is skipped
when its optional local toolchain outputs are absent. This is not a substitute for gameplay
testing. See [testing](docs/TESTING.md) and the [verification log](docs/PLAN.md)
for scope and outstanding work.

## Two-Room HD Demo

[Open HD Demo](https://neverhood-online.vercel.app/hd-demo/) separately from the
normal BYO-import launcher. The demo downloads its data automatically and starts
in the first room. An independently built runtime limits play to the first two
rooms and the first room's window view, completing before any out-of-scope scene
or module is created. Saves, persistent engine settings and full-game menus are
disabled. Original/HD switching does not restart gameplay. HD uses only Gemini
backgrounds and the prepared Blender cursor states, with native cursor fallback
for other gestures and palettes.

Each HD room is delivered as one SHA256-pinned STORE ZIP. The browser validates
and extracts both archives into Cache Storage before play; subsequent launches
read verified images from that cache without downloading the room ZIPs again.
Unavailable or quota-limited storage falls back to session memory. Game data and
derived media live outside Git and the static website, on the configured asset
host. The current game-data bundle is conservative, not a proven minimal resource
closure. Hardware-GPU performance and every puzzle path are not yet certified.

Set this Vercel build-time environment variable, then redeploy:

```text
NEVERHOOD_DEMO_MANIFEST_URL=https://YOUR_ASSET_HOST/manifest.json
```

The asset host must allow anonymous CORS GET/HEAD from the website. Without that
variable the production demo remains explicitly unavailable, while BYO import
continues to work. Local development can use `NEVERHOOD_DEMO_DIR` pointing to a
prepared release outside the repository/public trees. Media preparation uses
`build:demo-data`, `build:demo-cursor` and `prepare:demo`; runtime rebuilds use
`build:demo-runtime`. Normal deployment uses the committed runtime and its matching
corresponding-source archives, without requiring the local game or toolchain.

## Experimental First-Room Renderer

The following lab notes describe the earlier stock-runtime experiment, separate
from the bounded two-room demo above.

Restoration work is split into two independent tasks:
[HD backgrounds and sprites](docs/ROOM_HD_RESTORATION.md), and
[world reconstruction and HD video](docs/WORLD_3D_VIDEO.md).
The [sprite research prompt](docs/SPRITE_UPSCALING_RESEARCH_PROMPT.md) defines the
next model comparison; no best model or approved HD pack has been established.

For local first-room comparison, configure the private pack once when starting
the development server:

```sh
NEVERHOOD_ROOM_PACK_DIR=/home/mosha/neverhood-upscaling/data/room1-hd/pack-v1 npm run dev
```

Normal play then loads HD automatically, with only **HD / Original** and
**Gemini / RealESRNet** controls. No PNG or directory selection is needed. Sprites
remain independent of the selected background. All composition is direct at
2560x1920; other scenes and menus use the original renderer. The opt-in private
route works only on loopback development servers and is unavailable in static
builds; game-derived files are never copied into the website or uploaded.

The detailed renderer lab is developer-only:
`?renderer=room1-proxy&renderer-debug=1`. It retains manual directory/PNG selection
and full per-frame pixel parity checks. Normal gameplay uses versioned source
snapshots and sampled/on-demand checks instead of repeating that diagnostic work
on every frame. This avoids blocking the engine's main thread with verification.
Normal HD also trims transparent padding when decoding textures, prefetches the
next observed animation frames, keeps the hidden native game output at 640x480,
and moves a small clipped 32x32 cursor canvas instead of repainting a screen-sized
cursor overlay. The visible HD canvas remains 2560x1920; input coordinates and
native cursor phase/hotspots are unchanged.

The research producer is `../neverhood-upscaling/scripts/room_pack.py`; its private
output is `../neverhood-upscaling/data/room1-hd/pack-v1/`. It prepares 34 main-screen
resources with the actual room palette, constructor capacities, frame ordinals and
mirrored variants. `--run` resumes completed neural jobs; `--verify` requires both
backgrounds and the complete prepared raster set. Incomplete packs remain visibly
incomplete and unmatched rasters fall back to originals. This is an opt-in comparison,
not an approved whole-game asset pack. Menus, cursor, window-look view and other
rooms keep the original renderer.

For the version-pinned rendering experiment, open
`http://127.0.0.1:4173/?renderer=room1-proxy`, import your copy and press Play.
Skip the intros normally with Space and enter the first room. Open the small
**Room 1 renderer lab** panel in the player.

- The default **1x reference** compositor reconstructs ordered surfaces and checks
  every logical indexed pixel against the stock engine before presenting a frame.
- **Use original / Use proxy** switches presentation without replacing gameplay.
- Export an original observed layer PNG, prepare a private image at exactly 4x
  its displayed source dimensions, then load it for that raster. Preserve alpha.
  The output switches to 2560x1920 and draws the replacement directly, not through
  a 640x480 intermediate. PNGs remain in this session and are never uploaded.
- **Compare displayed 1x** performs an explicit diagnostic RGBA readback. It is
  not enabled as a continuous per-frame GPU readback.
- Menus, videos, other rooms, layout/hash mismatch or a differing reference frame
  retain the original renderer. Experimental controls are absent without the URL flag.

This is a read-only adapter over the stock WASM's compiler-derived private
layouts, **not a stable engine API**. Neither ScummVM source nor the WASM binary
was modified. The original renderer still runs as an oracle/fallback, so this is
not a performance optimization. Raster fingerprints are not resource/frame IDs;
there is no AI upscaler or complete HD animation pack here. A production bridge
needs deliberate engine integration under upstream's authorship/review rules.
Do not put exported game images or private HD replacements into the repository.

## Private Asset Catalog

Maintenance tools can extract a user's own seven BLB archives into an ignored,
private workspace. The catalog contains original payloads, decoded indexed images,
palettes, animation metadata, source hashes, aliases and replacement jobs. It is
not part of the website or public source downloads.

```sh
npm run assets:extract -- --init-private --input "/path/to/your/DATA"
npm run assets:map -- inspect
npm run assets:audit
```

Default output is `private-assets/`: SQLite `catalog.sqlite`, an extraction-time
`index.jsonl` snapshot, `manifest.json` and immutable content-addressed blobs.
Repeating extraction verifies hashes and repairs damaged outputs while retaining
context metadata and jobs. Node's SQLite experimental warning is expected.

The verified local copy produced 2,750 physical entries, 8,192 indexed frames and
551 Smacker video resources. Some frames lack a scene palette. Even an embedded
animation palette may differ from the active game palette; do not invent colors
or automatically treat every exported PNG as a finished AI input.

Prepare jobs with explicit palette and transparency. This English first-room
example matches the tested native background fingerprint:

```sh
npm run assets:map -- prepare --resource 4086520e --frame 0 --palette 4086520e --alpha opaque --key 640x480-640-1bd38d80-pa1e6ba93-opaque
```

The command returns an immutable input PNG, job ID, expected 4x dimensions and
runtime key. Process that image with a local tool of your choice; no AI model is
run by this command. Register an output as a candidate, inspect it, then repeat
with `--reviewed` only after visual approval:

```sh
npm run assets:map -- register --job "JOB_ID" --png "private-assets/output/background-x4.png" --model "YOUR_LOCAL_MODEL"
npm run assets:map -- register --job "JOB_ID" --png "private-assets/output/background-x4.png" --model "YOUR_LOCAL_MODEL" --reviewed
npm run assets:map -- export
```

Only approved jobs appear in `private-assets/replacements/render-map.json`.
This is a private mapping manifest; bulk loading it in the player is not yet
implemented. The renderer lab still accepts individual private PNGs.

Runtime capacities can differ from archive metadata. `assets:associate` accepts
source-bound scene associations rather than guessing. The local first-room lever
association records its 71x73 capacity and background palette, producing a padded
72x73 raster matching the engine. See the architecture and testing documents.

Never add extracted images, videos, databases or AI-derived game artwork to Git.
Outputs require a private marker; public/build/source output paths are refused.
Git ignore rules, source packaging exclusions and the CI audit add safeguards,
not a copyright clearance or image-similarity audit.

## Local Development

Use **Node.js 22.13 or later**. The client, local server and automated tests require
no npm dependencies and no `npm install`. A fresh clone includes the reviewed
WASM artifacts and matching source downloads; normal development does not need
Emscripten, a C++ compiler or game files.

```sh
git clone https://github.com/mihmosh/neverhood_online.git
cd neverhood_online
npm test
npm run build
npm run dev
```

Open `http://127.0.0.1:4173`. To check the packaged static site instead, stop the
development server and run:

```sh
PORT=4174 npm run preview
```

Open `http://127.0.0.1:4174`. This origin has its own browser storage.
Browser integration tests require separately installed Playwright/Chrome and,
for game checks, your own local game files. See [development testing](docs/TESTING.md).

### Rebuilds And Hosting

Only engine/extractor maintainers need to rebuild WASM. The pinned runtime source
revision is `c546a4c80d2daf3bb1d5a3652279e26f762c0204`, built with Emscripten
4.0.10. Follow the [source restoration and rebuild instructions](web/public/sources/README.txt)
and [maintenance commands](docs/TESTING.md). When changing compiled artifacts,
regenerate their corresponding sources and manifest with `npm run package:sources`.
Preserve notices and ship matching sources alongside binaries.

`npm run build` creates an allowlisted `dist/` for static HTTPS hosting; it does
not compile C++ or copy private game data. The local Node server is not a Vercel
function. See [deployment requirements](docs/DEPLOYMENT.md) for headers, source
delivery and `npm run verify:deployment -- <origin>` checks. The existing live
deployment and this public repository may be updated at different times.

## How It Works

The static client discovers the selected game files, validates the set and stages
imports transactionally in OPFS. Dedicated workers handle ZIP and Inno Setup
extraction. On Play, a disposable iframe starts the Neverhood-only ScummVM runtime,
copies the resources into MEMFS and mounts IDBFS for saves. Leaving the player
flushes the save filesystem and disposes that runtime session. Game logic remains
in ScummVM's C++ engine. See [architecture](docs/ARCHITECTURE.md).

| Path | Purpose |
| --- | --- |
| `web/` | Browser interface, import workers, storage and player adapter |
| `web/public/runtime/` | Generated ScummVM WASM, engine helper data and upstream notices |
| `web/public/extractor/` | Generated innoextract WASM and dependency notices |
| `web/public/sources/` | Matching source archives, checksums and rebuild instructions |
| `web/vendor/` | Pinned fflate decoder, license and provenance |
| `scripts/`, `tools/` | Build, packaging and verification tools |
| `test/`, `web/test/` | Automated and browser checks |
| `server.mjs` | Restricted local development/preview server |
| `docs/` | Architecture, testing, deployment and verification history |

An optional local `scummvm/` checkout is upstream source, not required for a normal
site build. Private game directories and toolchain build caches are not publication
inputs.

## Credits And License

The **ScummVM Neverhood engine** is credited upstream to
**[Benjamin Haisch](https://github.com/johndoe123) (`john_doe`)** and
**[Filippos Karapetis](https://github.com/bluegr) (`bluegr`)**.
Their engine work, and the wider ScummVM community's reverse engineering and
maintenance, are what make gameplay possible. This project adds browser import,
storage and a player around that existing engine; it did not recover the game logic.
See the [official engine credits at the bundled revision](https://github.com/scummvm/scummvm/blob/c546a4c80d2daf3bb1d5a3652279e26f762c0204/engines/neverhood/credits.pl).

This project depends on the work of the **ScummVM contributors**, **Emscripten
contributors**, **Daniel Scharrer and innoextract contributors**, **Arjun Barrett
(fflate)**, and the authors of SDL and the other bundled libraries. Their code,
attribution and license terms remain their own. See [third-party notices](THIRD_PARTY_NOTICES.md)
for exact versions and license locations.

Neverhood Online is distributed under the **GNU General Public License, version
3 or (at your option) any later version**, SPDX `GPL-3.0-or-later`; see [LICENSE](LICENSE).
This is also the license election in `package.json`. Individual files with an
explicit MIT SPDX notice and third-party components retain their own licenses;
the root license does not relicense them. Matching binary sources are available
through the site's [source downloads](https://neverhood-online.vercel.app/sources/index.html)
and in `web/public/sources/`.

The Neverhood's name, characters, artwork, music and commercial game data remain
the property of their respective rights holders. Software licensing does not
grant rights to those assets, authorize redistribution of your game copy, or
provide legal immunity. Use only files you are entitled to use and follow
applicable law. No gameplay images, original game archives or installers are
provided by this project.

This is an independent project with AI-assisted first-party development, not an
endorsement by ScummVM, the original game's creators or any rights holder.
Contributions and reports are welcome under [CONTRIBUTING.md](CONTRIBUTING.md);
for sensitive reports, read [SECURITY.md](SECURITY.md).
