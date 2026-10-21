# Roadmap And Verification

Neverhood Online is an experimental browser client with a local BYO importer
and a separate externally delivered Original/HD prototype. The game engine is
ScummVM, not a new implementation. This is
neither an official release nor a remaster.

## Available Now

- Import an installed game folder, a supported installer folder, or a nested ZIP.
- Find the game installer even when a ZIP also contains runtime redistributables.
- Parse supported Inno Setup EXE + BIN files locally without executing Windows code.
- Store the seven game archives in OPFS and discover them after a page reload.
- Show one adaptive import/Play/storage/removal panel.
- Keep the launcher controls in the first viewport, without a separate hero section,
  and prominently credit the upstream ScummVM Neverhood engine authors.
- Use an original game-menu-inspired clay interface, with no extracted visual assets,
  a licensed handwritten font and a reduced-motion-aware CSS import indicator.
- Run the original C++ Neverhood engine in WebAssembly, with a 4:3 high-DPI player.
- Exit through the original in-game Quit menu, then play again; a loading-only
  cancel action is available before the game starts.
- Import/export native saves and save ZIPs, with explicit overwrite review,
  atomic pre-import backups and stale-confirmation protection.
- Build a self-contained static site from the repository without an SDK or secrets.
- Serve matching source archives, hashes, build materials and third-party notices.
- Run the HD prototype on the unchanged stock full-game runtime, with 134 room/state
  PNG ZIPs selected through one original-to-HD table and cached on room entry.
- Retain all seven original BLBs and original cutscene/navigation videos through
  S3/CloudFront while their upscaling remains in progress.

## Verified Scope

The automated suite covers import transactions, ZIP framing,
legacy filename decoding, CRC and size checks, source discovery, static packaging,
public-source integrity, server isolation and related error handling.

Real desktop Chromium checks used the full English edition, with 638122574 bytes
of game archives. Tested scenarios include installed folders, nested installer ZIPs,
legacy-encoded names, bundled DirectX/Visual C++ installers, storage after reload,
the first room, Escape menu, live resizing, Quit/replay and removal. Missing BIN,
cancellation and quota failures preserved the preceding library in fault tests.
Browser checks observed no game upload requests or uncaught page errors.

Separate full-game HD checks passed the natural Scene1001 -> Scene1002 ->
Scene1004 route, beyond the old demo boundary, on desktop Chromium and emulated
mobile touch. Each entered room fetched its ZIP; a warm launch fetched none.
Native indexed parity passed. The external release's seven original archives
were verified byte-for-byte over HTTPS, retaining 551 Smacker resources. These
checks do not establish a full playthrough, all HD bindings or physical-device
compatibility, and do not verify the separately deployed public frontend.

Matching source archives were extracted and compiled. The extractor rebuild was
byte-identical; runtime exports were preserved without claiming byte-identical
runtime output. These checks do not constitute an independent security or legal audit.

## Known Limits

- No complete playthrough or comprehensive audible-sound test has been performed.
- Native save transfer and one full in-game save/load cycle passed Chromium tests;
  other engine versions, game editions and browser/native-platform combinations
  still need coverage. Browser data is not a substitute for external backups.
- Game launch copies the library into MEMFS; substantial RAM is needed.
- Installer and ZIP imports use temporary disk space in addition to the final library.
- Desktop Chromium is the primary tested target. Focused emulated-mobile touch
  checks passed; physical devices, mobile import, Firefox and Safari still need
  separate verification. Responsive onboarding alone is not gameplay evidence.
- Only stored/deflated ZIP is supported; encrypted ZIP, ZIP64, RAR and 7z are not.
- Not every repack or installer format is supported.
- Offline operation and widescreen scene reconstruction are not implemented.
  Experimental HD delivery exists, but full palette/state/static coverage and
  video upscaling are not complete. Native output remains the fallback.

## Next Milestones

1. Expand save/load coverage across editions and platforms, and test browser-crash recovery.
2. Replace complete MEMFS resource copies with bounded seekable access from OPFS.
3. Expand browser/device coverage and improve accessible input and touch handling.
4. Design versioned offline caching and safe runtime updates without losing saves.
5. Extend verified external HD bindings, reviewed static candidates and natural
   gameplay-route coverage without changing the current engine. Preserve the
   original videos until restoration candidates are separately accepted.

## Separate Restoration Tasks

As of 2026-10-18, restoration has two independent work briefs:

1. [HD backgrounds and sprites](ROOM_HD_RESTORATION.md): restore room layers and
   sprite sequences for existing gameplay. This does not depend on 3D recovery.
2. [World reconstruction and HD video](WORLD_3D_VIDEO.md): validate location geometry
   and compare direct versus geometry-guided video restoration. Geometry and video
   have separate success criteria; a complete playable remake is not the pilot.

The [sprite upscaling research prompt](SPRITE_UPSCALING_RESEARCH_PROMPT.md) supports
Task 1. The status sections below retain prior evidence; these work briefs do not
authorize model execution, media uploads, cloud spending or publication.

## First-Room Prototype Status

The following paragraphs preserve the original first-room experiment. They are
historical evidence, not the current full-game delivery status above.

The stock engine and binary remain unchanged. A compiler-derived, exact-WASM
read-only adapter feeds a separate compositor for module 1000/scene 0. It retains
the original renderer for validation and fallback, not as a final architecture.
Initial real runs reconstructed more than 300 frames with zero indexed differences,
zero sampled presented-RGBA differences, and seven observed lever rasters during
actual interaction. A synthetic private PNG retained independent adjacent 4x pixels.

No AI art was generated and no complete HD animation pack exists yet. Semantic
asset IDs, video, palette effects across rooms, production performance and a
stable human-maintained engine bridge remain separate work. Private layouts and
raster fingerprints must not be mistaken for an upstream rendering API.

## Private Asset Extraction

The local English archive set (638122574 bytes) was fully inventoried and extracted:
2750 physical records, 2666 payloads, 84 aliases, 2748 selected logical resources,
8192 indexed frames and 551 Smacker video resources. No extraction/image-decode
errors were reported. There are 7111 embedded-palette PNGs and 1081 frames whose
scene palette is unresolved; explicit scene associations add further colored views.
Original sound/music payloads are retained, but 322 are not identified by ffprobe
and are not mislabeled as ordinary audio files.

The approximately 1.1 GiB workspace, SQLite catalog and media remain private.
Native background/lever raster and palette fingerprints were cross-checked.
Two real first-room jobs are prepared, not AI-processed or approved. Candidate
outputs require visual review before private mapping export.

## Video To 3D Assessment

The actual video inventory has 551 resources / 550 unique payloads and approximately
3995 seconds (66.6 minutes) of footage. Probed source dimensions are 512 clips at
320x240, 24 at 320x200 and 15 at 448x240, at roughly 12-15 fps. This is not a
continuous calibrated scan and the total includes material not useful for world geometry.

Physical clay sets make a coherent reconstruction plausible, but do not supply
digital meshes. Fixed cameras give little background triangulation; pans without
translation do not establish depth. Moving characters, highlights, cuts, separate
sets and changed world states must not be merged as one static capture. Invisible
surfaces and global scale/connectivity remain inference or manual design work.

Recommended private pilot:
1. Select one static set and a shot with real camera translation; include relevant
   still backgrounds, and inspect making-of footage separately if it reveals angles.
2. Decode original frames and choose distinct keyframes; mask moving characters.
   Do not use generative upscale/interpolation as measured geometric evidence.
3. Compare COLMAP with a license-reviewed learned camera/depth initializer.
4. Evaluate held-out, genuinely different views and camera/reprojection consistency.
5. Prefer a 2.5D/depth or limited-view splat when evidence is insufficient. A clean
   editable mesh needs topology/UV cleanup and missing geometry in Blender.
6. Keep characters/rigs and major environment-state transformations separate.

A complete playable free-camera world is a remake, not an automatic conversion.
No model weights were downloaded or trained and no footage was uploaded. Tool/checkpoint
licenses and rights to derived game assets require separate review.

Primary technical references: [COLMAP](https://colmap.github.io/tutorial.html),
[VGGT](https://github.com/facebookresearch/vggt), [gsplat](https://github.com/nerfstudio-project/gsplat),
[NeRF](https://www.matthewtancik.com/nerf). VGGT checkpoints have differing terms;
the original INRIA 3DGS implementation and several research models restrict
commercial use. Apache-2.0 gsplat code does not clear rights to game-derived assets.

## Remote Evaluation Preparation

Local assessment sources and offline evidence live under ignored
`private-research/`, not in the website. The pinned HD fork, BasicVSR++, SeedVR,
FlashVSR, Upscale-A-Video, COLMAP and gsplat code were downloaded. Restricted or
gated reconstruction components retain metadata/licenses only; no license gate
was accepted. No model checkpoint payloads were downloaded.

The private root has component manifests, file-level SHA-256 inventory, an
independently verified transfer archive, original-frame candidate metadata,
three manually selected-case templates, model-specific environment drafts and
a read-only future-host preflight. GPU inference, installation, cloud resources
and game-media uploads are not performed by preparation tools.

Intended GPU targets are an RTX3090 or a full AWS L4, each nominally 24 GiB.
The current workstation remains a GTX1650/4 GiB. The AWS G6 plan records
g6.4xlarge as a 16-vCPU/64-GiB host candidate, without provisioning, price or
availability claims. Run preflight and a short representative benchmark before
assuming VRAM fit or throughput. Separate environments are required across
legacy MMCV, diffusion and reconstruction stacks.

Checkpoint downloads should occur directly on the approved GPU host, using
pinned official revisions/file hashes and only after exact license review.
The complete original corpus stays in `private-assets/`; preparation references
it but does not silently copy/upload it. Select reviewed clips with fixed camera,
camera translation, and puzzle-critical details rather than three random files.

Any graphics experiment must respect game rights and upstream contribution rules.
No original or upscaled game asset pack is included or promised for distribution.

## Public Release Checklist

- Keep source, credits, licenses, limitations and reproducible build instructions visible.
- Include only client UI screenshots unless separate game-image rights are established.
- Keep original archives, installers, saves, credentials and build caches out of Git.
- Run tests and a fresh-checkout static build before publishing.
- Verify the actual hosted files, headers and source download hashes after deployment.
- Clearly separate a repository update from a Vercel Git connection or domain change.

Community announcements, videos, analytics and domain purchases are separate owner
decisions. No forum posts, telemetry or tracking are enabled by this roadmap.
