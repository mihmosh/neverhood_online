# Task 1: HD Backgrounds And Sprites

Task split recorded on 2026-10-18. This is an experimental work brief, not a
claim that an HD pack exists. The independent second task is
[world reconstruction and video restoration](WORLD_3D_VIDEO.md).

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
