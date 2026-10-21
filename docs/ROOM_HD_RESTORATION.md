# Task 1: HD Backgrounds And Sprites

Task split recorded on 2026-10-18. This is an experimental work brief, not a
claim that an HD pack exists. The independent second task is
[world reconstruction and video restoration](WORLD_3D_VIDEO.md).

## Current Static Direction (2026-10-21)

This section updates static restoration policy. The sections below preserve the
2026-10-18 task split and experiment context; their starting-point statements are
historical, not a current claim that no subsequent work exists. Animation/SeedVR2
work and the independent world/video task are unaffected by this static update.

- Opaque backgrounds use `gemini-nano-banana-2.1`, preservation, original source
  only. No photographic attachments or detailed text-material variant are part of
  the current policy. Preserve earlier experiments as history, not defaults.
- Classify static use by opacity, scene/state, palette and resource binding,
  priority and clipping context. Background, foreground/occluder and standalone
  prop roles may overlap; archive bitmap counts are not semantic asset counts.
- Use the native binary source mask as a coarse identity/topology prior, not a
  final HD mask. The implemented experimental static default is
  `mask_method='image-guided'`: smooth prior plus genuine edge inference against
  restored RGB in a narrow trust band. Preserve offsets, right/bottom padding,
  flips, clipping, state metadata, source palette and exact identity/binding keys.
- Separate binary geometric segmentation from rendering coverage alpha localized
  to a one-HD-pixel contour. The refined render alpha need not be binary; broad
  donor softness is not acceptable. Source-nearest is diagnostic only, and exact
  NN equality cannot establish final contour quality.
- Foreground RGB uses an exact-canvas crop of the chosen HD background only with
  explicit source-to-background correspondence. Boundary inference does not prove binding.
  Original-RGB matching is diagnostic, not proof. If correspondence is not true,
  treat the layer as an independent prop or require review.
- Standalone props use opaque contextual RGB from restored images; masked hidden
  donor colors are not boundary evidence. Alpha-aware Lanczos/source-nearest is
  available only as an explicitly selected diagnostic control. The
  offline runner performs no new neural inference and does not promote runtime
  assets. No paid API or new session is needed for this pilot.
- Source scenes are 640x480; exact 4x backgrounds are 2560x1920. A 2400x1792 Nano
  candidate needs an explicitly recorded preparatory resample, not a native-4x
  label. No hidden crop or automatic resize in the processing core is permitted.

The image-guided contour update is implemented experimentally. The contour pilot
consumes frozen Scene1002-v3 sources and the selected Nano background, without paid
regeneration or live promotion. Its command from the repository root is:

```sh
python3 tools/upscaling/static/contour_pilot.py
```

The ignored report root is
`private-assets/upscaling/static-layers/scene1002-guided-v1`; immutable runs have a
content-hash suffix and `latest.json` identifies the current run. The pilot
targets four LadderArch foreground resources (`152c1313`, `060000a0`, `b2a423b0`,
`316e0772`) and two standalone props (`312c8774` ladder and `b3242310` door backing).
Compare original NN, geometry-smoothed and image-guided contours with outlines,
zooms and composites at identical world placement and padding. The earlier
12-candidate Scene1002-v3 measurements remain a historical baseline: they proved
unchanged blockiness, not final contour quality.
The new run processes all six layers: five direct RGB-supported proposals and one
ladder context correction requiring review. The ladder's upper opening conflicts
with the original exterior connection near the arch. A six-pixel reconnection is
recorded alongside the raw proposal, not claimed to be an RGB-proven boundary.
See the [static workflow](../tools/upscaling/static/README.md) and
[manifest contract](../tools/upscaling/configs/manifest.md).

Existing preparation ran RealESRNet on RGB and alpha separately. That old alpha
default is not validated segmentation or contour-localized coverage; hidden RGB in fully transparent
pixels is not itself a visible defect. Check restored-RGB shape adherence, coarse
consistency, four-connected holes/components, thin parts, no extra objects and
changed-pixel membership within the native-SDF trust band. Symmetric raster-boundary
distance is a separate diagnostic, not a hard bound equal to the band width.
Three native pixels is a starting band
for review, not a universal tuning promise. Low-contrast support requires review;
topology mismatch blocks acceptance. Check edge-localized AA separately from
segmentation; no automatic approval or general contour-quality guarantee is claimed.
Runtime gameplay remains unvalidated until an
in-engine fixture exercises priority/state transitions, part-3 deletion and hands.

## Indexed Static Asset Processing

The static branch can process its full eligible inventory using
`python3 tools/upscaling/static/bulk.py --execute`. Its source-use ledger is distinct
from the restored-background inventory. Source-backed candidates retain unresolved
expressions, palette/state ambiguity and missing RGB as blocked records rather than
being guessed or silently omitted.

The private `static-all-v1/index.sqlite` and per-run `index.jsonl` preserve source
identity, frame and palette context, native content, padded canvas, placement,
visibility/clipping/priority evidence, donor hashes, normalization, contour outputs,
review status and attempt history. Immutable selections and verified resumes keep
the relationship between originals and generated masks reproducible.

The thirteen prepared two-room bindings are a verified starting set, not all static
assets in the game. Additional direct source bindings require their own contextual
proofs. An activation-only button must not use the unpressed room's RGB. Whole-game
closure and runtime promotion remain separate, unproven steps.

## Goal And Boundary

Restore backgrounds, foreground layers, objects and animated sprites for
high-quality rendering inside the existing rooms. Preserve the original game
logic, camera framing, interaction coordinates, animation timing and clay art.

This task does not require a reconstructed 3D world, camera recovery or Omega.
Do not block a useful 2D restoration pilot on Task 2. Full-screen navigation
movies and cinematics belong to Task 2; sprite animation sequences remain here.

## Animation Direction After The First Pilot

User review on 2026-10-18 found independent-frame neural animation restoration
visibly unstable even when individual frames looked good. RealESRNet/RealESRGAN
frame-wise outputs are now provisional baselines, not the intended final animation
pipeline. Still backgrounds and static sprites remain separate decisions.

The next animation-quality experiment should export a complete, offset-aligned
sequence as a short video and compare sequence-aware restoration against these
baselines. Preserve source frame identity, exact duration counters, loop boundary,
native canvas and alpha separately; do not introduce motion interpolation or smooth
away deliberate stop-motion movement. Prefer lossless RGB/alpha research inputs
and explicitly document any duplicated timing frames or VFR timestamp encoding.
Do not infer native transparency support from a video wrapper. Re-import only after
checking frame correspondence, timing, silhouettes and all original gameplay events.

No video-SR model was selected or run by recording this direction. A second-room
frame-wise pack is useful for rendering/performance tests, not proof that animation
quality is accepted. Runtime fallback flashes and texture-cache stalls must also be
measured separately from the model's intrinsic temporal inconsistency.

## Full-Game Room Mapping (2026-10-21)

The full-game extension uses the existing external compositor and version-2 room
ZIP/cache loader. The stock full-game JS/WASM remains unchanged. The current
CloudFront manifest is
`https://d3gutt3a0gjwwo.cloudfront.net/full-game-lossless-v1/manifest.json`.
Original videos remain in the seven original BLBs (638,122,574 shared startup
bytes), not room-local HD downloads. `scripts/verify-demo-videos.mjs` verified
every original byte over HTTPS and counted 551 retained Smacker resources;
the private evidence is `private-assets/upscaling/full-game-release/original-video-audit-v1.json`.
Video upscaling remains in progress and is not substituted into gameplay.

The authoritative private original-to-HD table is
`private-assets/upscaling/full-game-release/asset-map-v3/asset-map.json`.
It records resource/frame aliases, indexed source identity, geometry, palette
proofs, HD PNG hashes and room membership. `--mapping` packaging reads this table
instead of recomputing associations from filenames or running inference:

```sh
node scripts/prepare-hd-room-packs.mjs \
  --mapping private-assets/upscaling/full-game-release/asset-map-v3/asset-map.json \
  --write --summary --output "$PWD/private-assets/upscaling/full-game-release/room-packs-new"
```

The table preserves the two previously working rooms through
`scripts/import-demo-png-mapping.py`. Their PNG inputs are not modified. Explicit
alpha-bound crops and reversible horizontal reflections deduplicate shared images;
decoded cropped RGBA is checked byte-for-byte after lossless PNG encoding.

The current table emits 134 room/state ZIPs, not 134 unique game rooms. Palette
proofs compare only source-used RGB entries; changes to unrelated palette slots or
the unused fourth byte cannot invalidate a correct binding. Used-color changes,
ambiguous bindings and absent HD assets retain the native renderer. A complete
runtime palette/state closure and a full playthrough are not established by the
asset counts. The existing static review/geometry gates still apply.

Room manifests retain their existing schema with `lossless: true` and shared PNGs.
Lossless archives have a bounded 512 MiB ceiling; the older WebP release keeps its
128 MiB delivery ceiling. Decoded image retention remains separately bounded.
One ZIP loads on room entry, the inactive decoded pack is released, and persistent
cache entries are verified again before reuse. The release and room index pin the
asset-table SHA256. The tested natural route is Scene1001 -> Scene1002 -> Scene1004,
including passage beyond the old demo boundary, checked native indexed parity
and a zero-ZIP-download warm start. Desktop and emulated-mobile touch passed;
this is not a complete playthrough or physical-device certification.

## Local Cursor And Window Verification (2026-10-21)

The stock runtime remains byte-for-byte unchanged, with WASM SHA256
`31bdb5fa1afcdf80a6895e2fe5c87a5a999a245af85de7326df20f0756e0d83c`.
These are local opt-in changes, not an upload or production switch.

The seven-gesture cursor export uses existing private artwork, not a new render.
`node scripts/build-demo-cursor.mjs private-assets/demo-cursor-seven-v1 --all-gestures`
produces 21 exact resource/row bindings for `6520a400`, `41108c00` and `23303124`.
The loader pins the complete prepared manifest's canonical JSON SHA256, then checks
every raster/palette and the atlas image hash. Each presented 32x32 indexed raster
selects its own pose and only its nonzero used palette indices; colors used solely
by other poses do not invalidate it. Native hotspots, visibility and the repeated
six-frame phase remain authoritative. The compositor selects the appropriate
128x128 cell in the 384x896 atlas and reports resource, row, pose and an explicit
native fallback reason. Shipped version-1 `tail-swing-v4` manifests remain supported.
Unknown resources/rasters, changed used RGB, menus and unsupported render states
remain native. If identical native rasters correspond to distinct HD animation
poses, `pose-ambiguous` retains native output rather than guessing a phase. Source
fingerprints are not evidence of full-game gesture coverage.

The user explicitly accepted single-available-candidate pending background groups.
The private receipt is
`gemini-review-all/user-20261021T183214Z-single-available-pending.json`: 15 new
approvals, retaining the two previous receipt approvals. Multiple-candidate groups,
the unmapped paired-lighting experiment and the existing conflict were not silently
resolved. Approval does not authorize publishing or accepting unrelated candidates.

The accepted window output `a3b85c90380de0b289fa1f759cc186e903c6cc965540ae56b4f5e342394902dc`
was explicitly resampled from 2400x1792 to 2560x1920 with Lanczos, no crop/padding,
and encoded as lossless RGB PNG. Normalized SHA256 is
`cfa107d1ab5fb517bf347964fea876b7789f16cf8c99ec51cd46d32030cdd793`.
`scripts/prepare-window-overlay.mjs` uses the ordinary provenance-checking mapping
and ZIP packer with an empty animation catalog. It emits just one 6,096,753-byte
window ZIP with identity `Module1000-C084110C`, SHA256
`b5b7981538623dae8ca0ca6da4ec85e053a9107e463cc69793a4113a819dd4de`.
It does not regenerate or copy all legacy packs. The window is a native static
scene, never a navigation-video substitution.

On isolated origin 4201, native input opened the window via the red button and
window hotspot, selected the approved room identity, switched HD/Original/HD,
returned to Scene1001, and reached Scene1002 through three lever pulls and the
door. The window had one HD background draw, zero renderer mismatches/errors and
no page errors. Separate DPR-2 browser testing confirmed HD resource `23303124`
at all four edges of Scene1002 and indexed native parity of 0/307200 differing
pixels. These proofs do not certify every module, physical mobile device, gesture
context or a complete playthrough. Reproduce with `scripts/prove-window-runtime.mjs`
and `test/browser-demo-cursor.mjs`; private image/pack inputs are required.

The combined local release is served at `http://127.0.0.1:4204/hd-demo/` by
`scripts/serve-visual-demo.mjs`. Its direct, non-intercepted browser proof also
confirmed the window cursor resource `41108c00` as HD. The assembly links declared
legacy inputs without copying their bytes, and copies only the new approved window
and cursor files. It does not reduce the browser's original-data startup download.

## Established Starting Point

- Seven source archives were cataloged: 8192 indexed frames, including 7111
  embedded-palette PNGs and 1081 frames with unresolved scene palettes.
- Source hashes, frame ordinals, offsets, aliases and palette context are retained.
  A decoded PNG is not automatically the correct runtime-colored model input.
- The opt-in first-room compositor was reported to reproduce more than 300 real
  frames without indexed differences, with zero sampled presented-RGBA differences.
- A synthetic 4x image preserved independent adjacent HD pixels through the
  2560x1920 output path. This verifies resolution transport, not restored detail.
- Two real first-room jobs were prepared. No AI-processed, visually approved pack
  is established; the private replacement map was empty at this task split.
- The current read-only adapter is tied to private layouts of an exact WASM build.
  It is not a stable resource/frame API or production integration for all rooms.

Evidence: [roadmap](PLAN.md#first-room-prototype-status),
[architecture](ARCHITECTURE.md), [tests](TESTING.md), and the local
`private-assets/manifest.json` and `private-assets/replacements/render-map.json`.
These summarize recorded runs; creating this document did not rerun experiments.

## First Experiment

1. Verify the prepared first-room background and lever inputs against actual
   runtime palette, transparency, padded dimensions, offsets and orientation.
   Include a complete short animation with fixed original frame ordinals.
2. Use the [sprite research prompt](SPRITE_UPSCALING_RESEARCH_PROMPT.md) to select
   at most three runnable candidates spanning conservative and generative methods.
   Include original scaling and a documented non-generative resampling baseline.
   No model has been selected as best yet.
3. Compare the background separately from sprites. Test native-input 4x restoration
   for this compositor; its 4x contract is not the audited fork's 4.5x contract.
4. Evaluate sprites over the actual room and contrasting light/dark diagnostic
   backgrounds, at intended display size, magnified, and in repeated animation.
5. Load only reviewed candidates into the private first-room compositor. Exercise
   the lever, occlusion, original/proxy switching, menus and original fallback.
6. Record pass, fail or inconclusive per asset and sequence. Expand only after a
   complete small background-plus-animation set passes, not after one attractive still.

## Fidelity And Export Contract

- Preserve physical clay irregularity, fingerprints, silhouettes, lighting, color
  relationships and puzzle-critical marks. Do not substitute anime, pixel-art
  aesthetics, invented texture, extra teeth/fingers or redesigned faces.
- Preserve exact frame count, ordinals, durations, loop boundaries and event frames.
  No interpolation, inserted frames or pose/reframing changes in the first pilot.
- Resolve palette and alpha policy explicitly per job. Palette index zero is not
  universally transparent. Do not infer alpha solely from black RGB pixels.
- Preserve each source's cutout or translucent semantics. Define straight versus
  premultiplied alpha at processing/export boundaries and avoid fringe contamination.
  A research candidate may propose edge refinement, but must validate silhouette
  changes rather than silently applying them.
- Preserve logical canvas, pivots, padded rows, clipping and flipped orientation.
  Map output to the declared input contract, not a guessed crop or filename.
- Retain input/output hashes, resource/frame binding, model/checkpoint revision,
  license, settings, seed where applicable, preprocessing, runtime, peak memory,
  errors and review status. Keep originals and reversible candidate outputs.

## Acceptance And Unknowns

An accepted pilot must improve intended-size readability without redesigning
objects, introducing visible temporal shimmer, changing gameplay, or breaking
edges, occlusion and placement. Review the full animation, not selected frames.

Use side-by-side and preferably blinded review. Record silhouette/edge displacement,
color drift, temporal residuals after accounting for real motion, and gameplay
defects. Calibrate numeric thresholds on the original/baseline before ranking.
Without true HD ground truth, PSNR/SSIM against the source or downsampled consistency
is only a diagnostic; perceptual/no-reference scores do not prove faithful detail.

Open questions: best model for this clay material, alpha-safe processing,
cross-frame and background/sprite consistency, palette effects, production memory,
and a supported semantic resource/frame bridge. The small prototype answers none
of these globally. Stop or choose conservative restoration if generative detail
cannot remain faithful and stable.

## Deliverable And Permissions

Deliver a private reviewed first-room mini-pack, reproducible comparison manifest,
short animated comparisons and an explicit integration decision. Whole-game
batch processing and engine redesign are later decisions.

Keep all game-derived inputs/outputs in ignored `private-assets/` or other approved
private storage, never website/public sources or Git. Do not alter originals or
engine sources for this research. No model inference is authorized by this plan.
Heavy neural runs on the local 4 GiB GPU are excluded; RTX3090/L4 use, paid cloud,
credentials, gated agreements and third-party media transfer need separate approval.
Review code, checkpoint and output licenses separately from rights to game assets.
