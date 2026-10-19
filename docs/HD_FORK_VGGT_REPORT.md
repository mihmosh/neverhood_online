# Neverhood HD Fork And VGGT-Omega Assessment

Assessment date: 2026-10-17. This is a source-based report, not a successful fork
build, full playthrough, CUDA compatibility test or reconstruction benchmark.
No model weights were loaded, engine source modified, or game media uploaded.

## Executive Decision

These projects solve different problems. The HD fork presents replacement 2D
images/animations/video inside the existing game. VGGT-Omega estimates geometry,
camera and depth information from observations; it does not produce an HD asset
pack or a complete playable world. They can be complementary, not substitutes.

Keep the current working engine as the production baseline. Treat the fork as
an existing design/code reference and a separate build experiment. Treat Omega
as an offline, one-location camera/depth pilot after checkpoint/license approval.

## Evidence And Existing Inputs

- Fork: [sergio256256/scummvm_neverhood_4k](https://github.com/sergio256256/scummvm_neverhood_4k), branch `n4k`, pinned
  `cb7c522c184ae3ce8c7cd7596550ce398de70ad1` (2025-01-25).
- Local immutable source assessment: `private-research/hd-fork/audit.md`; checkout
  `private-research/hd-fork/source`, source archive hash recorded in its manifest.
- Original corpus: 551 video resources, 550 unique streams, 55270 header frames;
  mostly 320x240 at approximately 12-15 fps. These are not 550 calibrated views
  of one static object, nor 55270 independent camera positions.
- Asset catalog: 8192 decoded indexed frames with explicit aliases, palettes,
  offsets, timing, scene context and source fingerprints; media remains private.
- Compute target: RTX3090 or full L4, nominally 24 GiB. Current workstation is
  GTX1650/4 GiB, used for inspection and preparation only.

## HD Fork: What Already Exists

The fork has substantive engine changes, not just bigger images:

- Resource-hash PNG overrides and animation-frame PNG sequences.
- RGBA drawing/alpha code and RGB-offset approximations for fades/lighting.
- Replacement OGV/Theora playback.
- Extensive physical-coordinate scaling in engine and scene code.
- Changes to shared Graphics::Surface and pixel-format behaviour.

This confirms the feasibility of replacing art while retaining much of the game
logic. It does not establish a reliable optional HD mode or compatibility with
today's browser build. The deeper source audit found deterministic gameplay
contract defects even with a complete pack; this is not just a packaging problem.

## Asset Contract And Export Work

The loose-file loader expects uppercase eight-digit requested resource hashes:

```text
loose_4k/images/HASH.png
loose_4k/images/HASH-000.png
loose_4k/images/HASH-001.png
loose_4k/videos/HASH.ogv
```

The default scale is 9/2 (4.5x): 640x480 becomes 2880x2160, not 3840x2160.
Our proxy's 4x output is 2560x1920. Its padded, already-flipped runtime rasters
are not the same as the fork's cropped source-frame PNG contract. A converter
must preserve original frame ordinals, timing, offsets and orientation rather
than rename the existing exports. The catalog contains the required provenance.

PNG production also needs a strict pack validator: expected RGBA layout, row
pitch, dimensions, alpha policy, complete frame counts and exact scale. Ordinary
non-paletted RGB images are expanded by this tree's PNG decoder. Its opaque
indexed branch is the problematic case, because the fork globally changes the
meaning of CLUT8 while that decoder branch still writes palette indices.

## HD Fork: Important Risks

| Risk | Source-verified issue | Consequence |
| --- | --- | --- |
| Partial packs | Animation scanning stops at the first missing file; metadata conversion checks frame 000 for all frames | Missing/corrupt frames are not a safe selective fallback |
| Decoder capability | Theora's video track reports inherited frame count 0 and lacks the required seek/rewind implementation | Radio entry's gotoFrame(0) reaches an explicit error; completion-driven puzzles can stall |
| Video fallback | Loose OGV is opened without a successful-open check and replaces the supplied decoder stream | Original Smacker is not automatically retained when a replacement is absent |
| Pixel-format coupling | Global createFormatCLUT8 returns RGBA; original one-byte unpackers remain | Stock fallback and unrelated shared code require audit |
| Configuration order | Graphics initialize before reading the scale INI | A changed ratio can disagree with the initialized backend |
| Pointer arithmetic | Frame offsets are computed between separate allocations and narrowed | Undefined behaviour; wasm32 does not make it valid |
| Fades/alpha | RGB offsets and custom blending replace palette-based behaviour | Some effects and translucent edges need scene-level validation |
| Porting | Older engine/backend APIs and new PNG/Theora/Vorbis requirements | Existing browser/WASM support is not a verified current build |
| Persistence/input | V_KLAYMEN_SAVED_X stores scaled physical coordinates with no scale marker | Some stock/fork saves restore a semantically wrong X despite identical version 0 headers |
| Capacity safety | Replacement animation width/height are not checked against the allocated surface before drawing | A mistaken scale or oversized image can write beyond destination storage |

These are static findings, not claims that every path fails at runtime. The fork
must first be built and observed unchanged in an isolated environment.

### Concrete Failure Paths

- Radio Scene2802 calls `gotoFrame(0)` on entry. The replaced decoder reports zero
  frames, so `forceSeekToFrame` checks `0 >= 0` and calls `error()`. The disk player
  and cannon also depend on frame completion/count semantics, and frame 133 awards
  a disk-player key. A generic OGV transcode is not a substitute for those APIs.
- Missing OGV open success is ignored. Theora reads the unopened Common::File,
  reaching an assertion or invalid-handle read, not original-Smacker fallback.
  The separately created BLB substream wrapper is leaked on this path.
- Missing later PNGs can overwrite original animation offsets with null-derived
  values. A failed decoder can shift all subsequent decoded frames down an index.
  The fallback RLE reader then lacks intact original metadata.
- Scale-dependent namespace-static geometry is initialized before the INI too.
  A later scale change can mix default and configured geometry, even beyond the
  already initialized backend. Zero divisors are not validated. Singleton deletion
  also leaves a dangling pointer for same-process engine restart.
- Scene1404's tint is applied during unpacking and again during final blit.
  Scene2208's copy helper copies nonzero bytes, not RGBA pixels, so valid zero
  color channels may retain stale destination data. Font paths scale numeric row
  counts/character origins, while the menu atlas still has unscaled glyph sizes.

Key anchors at the pinned fork revision:
[video adapter](https://github.com/sergio256256/scummvm_neverhood_4k/blob/cb7c522c184ae3ce8c7cd7596550ce398de70ad1/engines/neverhood/smackerplayer.cpp#L80-L152),
[radio caller](https://github.com/sergio256256/scummvm_neverhood_4k/blob/cb7c522c184ae3ce8c7cd7596550ce398de70ad1/engines/neverhood/modules/module2800.cpp#L475-L486),
[animation metadata](https://github.com/sergio256256/scummvm_neverhood_4k/blob/cb7c522c184ae3ce8c7cd7596550ce398de70ad1/engines/neverhood/resource.cpp#L202-L236),
[saved X](https://github.com/sergio256256/scummvm_neverhood_4k/blob/cb7c522c184ae3ce8c7cd7596550ce398de70ad1/engines/neverhood/modules/module2800.cpp#L1808-L1813).

## Memory Is A Core Design Constraint

Measured from the actual private catalog, the 8192 decoded image frames contain
188384132 source pixels. Expanding every frame to 4x in RGBA would require
12056584448 bytes (about 11.23 GiB) if all were resident. This is not a PNG disk
estimate or a claim that the engine necessarily loads them all simultaneously.

The largest physical animation resource groups contain approximately 180-286 MiB
of cropped 4x RGBA pixels. Some may contain multiple requested animations; use
their actual selectors before attributing all bytes to one active animation.
The fork eagerly decodes discovered PNG sequences. Add original game data,
padded sprite capacities, framebuffers, decoder buffers and GPU copies. A real
browser HD mode needs bounded scene/animation caches, not whole-pack MEMFS loading.

## Recommended Fork Experiment

1. Resolve build prerequisites in a separate environment, without replacing the
   current production engine or editing protected upstream code automatically.
2. Export a controlled first-room baseline pack using conservative scaling,
   not expensive AI, so renderer bugs can be separated from artwork changes.
3. Test original-only, complete baseline, missing static PNG, missing middle
   frame, corrupt PNG and missing OGV cases. Record errors rather than hide them.
4. Exercise lever/hammer, clipping, cursor, Escape/Quit, transitions and native
   save import/export. Keep input coordinates and presentation scale explicit.
5. Measure process RSS, peak decoded resources, GPU texture usage, frame pacing
   and unload behaviour. Only then choose reuse, limited adaptation or rejection.

The resource/file contract is readily reusable. Blindly transplanting the global
Surface/pixel-format and scene-scaling changes is a high-risk shortcut.

## VGGT-Omega

Reviewed official source: [facebookresearch/vggt-omega](https://github.com/facebookresearch/vggt-omega),
pinned `48b23c8ce72c9a8fcf987f0d7f43d8e4870759f6` (2026-09-22). The private
offline snapshot, SHA-256 inventory and detailed findings are under
`private-research/vggt-omega/`. Public checkpoint metadata revision is
`1041e80fc0e911235d3426b0a3d9a81075111a53`. No weights were requested or loaded.

### Actual Outputs

The released model predicts a 9D camera encoding, dense depth and depth confidence.
The demo decodes cameras, unprojects depth and saves NumPy data plus a GLB.
That GLB contains a **point cloud and camera-cone meshes**, not reconstructed scene
triangles. Camera cones must not be mistaken for room geometry.

There is no supplied textured/watertight mesh, Gaussian-splat/NeRF optimization,
novel-view renderer, character rig, collision representation or game-world export.
The released forward path has no optical-flow/tracking/segmentation output head.
Dynamic-scene training does not turn moving actors into separate canonical assets;
concatenating all per-frame point maps can accumulate ghost characters.

This is useful initialization for another reconstruction pipeline, not its end.
It could help estimate cameras/depth for matching shared surfaces between navigation
clips, or produce rough room geometry. It does not itself restore HD textures.

### Implementation And Scaling

The aggregator alternates per-frame and inter-frame transformer blocks, including
full global frame/patch attention. Compute grows quadratically with the global
frame-token count. Memory-efficient attention avoids materializing the full score
matrix, but does not make arbitrarily long clips inexpensive.

`frames_chunk_size=8` chunks the dense output head only: all input frames already
passed through the whole-sequence aggregator. Training checkpointing is not an
inference streaming mode. There is no released scene-chunk merger or persistent
inference cache that makes 55270 frames one reconstruction.

Separate runs do not guarantee common scale/origin. Merging needs genuine shared
static observations, robust similarity alignment, outlier rejection and global
validation. Pure rotation/fixed camera can make camera-center alignment degenerate.
Disconnected clips cannot be joined faithfully just by matching game adjacency.

### Preprocessing Pitfalls

- The video demo samples using OpenCV FPS and rounded intervals, defaulting to
  1 fps. That is a view-selection convenience, not preservation of source PTS/audio.
- Filenames are sorted lexicographically. Use unique zero-padded names and keep
  original frame IDs/timestamps in a sidecar.
- RGB conversion composites RGBA on white. An alpha mask is not an attention mask;
  painting actors white does not remove their influence on inferred cameras.
- Balanced resolution 512 transforms a 320x240 input into **592x448**, not 512x384
  or the memory table's 624x416. Patch rounding changes aspect by about -0.89%.
  `max_size=512` gives 512x384 for this input. It does not create extra evidence.
- Extreme aspect ratios may be center-cropped and mixed shapes white-padded. The
  loader returns tensors, not inverse transform/mask records. Our wrapper must
  preserve crop/resize/pad transforms and map results back to original pixels.
- Cameras assume centered principal points and independent horizontal/vertical
  FoVs, with no lens distortion model or shared-calibration constraint.

### Confidence Is Not Ground Truth

Depth confidence is `1 + exp(logits)`, not a calibrated 0-1 probability. The demo's
slider thresholds a global percentile. Its display masks (depth edges, colors,
optional sky) do not identify actor motion and do not undo its effect on inference.
Sky masking can download another checkpoint and should stay off unless authorized.

The evaluation code fits independent per-frame scale/shift using ground-truth
depth before some scores. Camera metrics emphasize rotation and normalized
translation angles; they do not validate metric distance or world scale. The
supplied ETH3D/Sintel evaluation is not directly applicable to Neverhood, which
has no provided camera/depth ground truth. A pretty point cloud or leaderboard
score cannot replace independent landmark and held-out-view validation.

The repository also records reproduction/contamination questions and recommends
a separate 416 reproduction checkpoint for benchmark comparison, while the 512
checkpoint is recommended in the wild. The reviewed evaluation wrapper still
hardcodes 512 preprocessing: check exact checkpoint/config before claiming a
reproduction. This is a configuration concern, not an accusation of misconduct.

### RTX3090 / L4 Expectations

Official author-reported end-to-end peak GPU memory for the 512 checkpoint,
single A100, actual 624x416 inputs:

| Views | Peak GPU memory |
| --- | ---: |
| 25 | 7.80 GB |
| 50 | 9.66 GB |
| 100 | 13.37 GB |
| 200 | 20.82 GB |
| 300 | 28.26 GB |

These include loading/inference, not host export memory, and are not 3090/L4
measurements. Both targets have nominal 24 GiB, not identical performance. Start
with 25-50 informative views; 200 leaves little headroom and is not certified.
Point-count reduction occurs after full inference/unprojection, so reducing the
GLB point cap does not solve model VRAM pressure. 64+ GiB host RAM is prudent
headroom, not an upstream minimum or a substitute for VRAM.

Requirements declare Python >=3.10, torch >=2.6 and torchvision >=0.21. Released
inference uses PyTorch SDPA, not a mandatory external FlashAttention package.
Confirm the actual attention backend on the target. Hopper-only FlashAttention-3
is not appropriate for RTX3090 SM86 or L4 SM89. No target environment was installed
and no speed, memory-fit or cloud-cost benchmark was performed.

### License And Access

The inspected source and checkpoint license use the **FAIR Noncommercial Research
License**, including restrictions on materials **and outputs/results**. A free
fan site is not automatically a determination of permitted use. Inherited DINOv3
notices also require review. This is not an Apache/MIT production dependency.

Current public card/license requests returned 200, unlike earlier cached 401
responses, but actual checkpoints remain access-gated. No application, personal
details or click-through approval were submitted. No territory exclusion like
HY-World's EU/UK restriction was found in FAIR; do not mix those licenses.

Source anchors at the reviewed revision:
[README/memory](https://github.com/facebookresearch/vggt-omega/blob/48b23c8ce72c9a8fcf987f0d7f43d8e4870759f6/README.md#L118-L136),
[demo](https://github.com/facebookresearch/vggt-omega/blob/48b23c8ce72c9a8fcf987f0d7f43d8e4870759f6/demo_gradio.py),
[point-cloud export](https://github.com/facebookresearch/vggt-omega/blob/48b23c8ce72c9a8fcf987f0d7f43d8e4870759f6/visual_util.py),
[metrics](https://github.com/facebookresearch/vggt-omega/blob/48b23c8ce72c9a8fcf987f0d7f43d8e4870759f6/eval/metrics.py),
[license](https://github.com/facebookresearch/vggt-omega/blob/48b23c8ce72c9a8fcf987f0d7f43d8e4870759f6/LICENSE).

## Relative Complexity And Recommendation

| Work package | Complexity | Principal uncertainty |
| --- | --- | --- |
| Reuse fork filenames and metadata for an exporter | Low to medium | Crop, orientation, RGBA and 4x/4.5x contract validation |
| Build unchanged fork as a native experiment | Medium | Old APIs/toolchain and codec prerequisites; not yet built |
| Dependable optional HD mode in current browser engine | High | Fallback, video semantics, palettes, memory, saves and isolation |
| Omega 25-50-view private pilot | Medium, after license/access | Geometric observability and actual 24-GiB host compatibility |
| Useful static set / limited-view reconstruction | Medium to high | Masks, alignment, downstream representation and missing surfaces |
| Editable connected full-world remake | Very high / art project | Topology, unseen geometry, rigs, transformations and gameplay |

These are relative work estimates, not delivery dates. The first quarter of the
game carries most fixed renderer costs and is not one quarter of the engineering.
Calendar estimates require build/failure probes and an actual GPU pilot.

Recommended sequence:
1. Preserve the working engine and external prototype. Do not replace them with
   this fork merely because its name says 4K.
2. Run the fork's failure-oriented micro-pack, including radio frame seeking and
   a saved-coordinate transition. Use conservative authorized baseline media first.
3. Select one first-person navigation segment with actual camera translation,
   plus its standing/action views. Keep changed world states separate.
4. After exact checkpoint approval, compare Omega with COLMAP on identical original
   derivatives and static masks. Use 25-50 independently informative views and two
   genuinely different held-out views where available; mark unobservable cases.
5. Accept geometry only if independently matched static landmarks, reprojected
   camera motion, depth consistency and subset/chunk alignment remain credible.
   Do not use per-frame ground-truth alignment or the model's own confidence as proof.
6. Add splat/mesh processing only after camera/depth quality passes. Keep HD-video
   restoration and runtime integration as independently testable tracks.

The near-term value is a faithful HD presentation and better camera/reference
alignment, not automatic free-camera conversion of the entire physical world.

## Rights And Policy Boundaries

ScummVM fork code retains GPLv3-or-later and its third-party notices. That does
not license original or upscaled game art. Model code, weights, outputs and game
IP have separate terms. The public site continues requiring the user's own copy.
Keep footage, frame datasets, checkpoints and reconstructed game assets private.

Engine-source work must follow the applicable repository contribution/authorship
rules. This report does not authorize automatic C++ rewrites or submission of
generated media to upstream ScummVM. Cost/region choices do not bypass licenses.
