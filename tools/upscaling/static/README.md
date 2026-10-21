# Offline Static Layers

## Scope (2026-10-21)

This is an offline foreground/static-prop workflow with an implemented experimental
image-guided contour path, not a
runtime replacement-pack installer. It uses prepared private inputs and performs
no new neural inference, paid API calls or automatic runtime promotion. Animation
and SeedVR2 work remain separate.

The earlier baseline requires Python 3.10 or newer, Pillow and NumPy; the new
image-guided maxflow stage adds SciPy. The earlier local pilot was tested with
Python 3.14.4, Pillow 12.1.1, NumPy 2.3.5 and SciPy 1.16.3. No Torch installation or GPU is
required for these offline paths.

Static taxonomy describes use, not mutually exclusive resource types. An image
can serve multiple roles across scenes or states. Opacity/transparency, source
palette, resource binding, priority, clipping and state context determine the path.
Preserve that context alongside the source canvas, position offsets, right/bottom
padding and flips; do not flatten every bitmap into an opaque background.

## Processing Paths

For both paths, use the native binary source mask as a coarse prior for identity,
shape and topology, not as a final HD contour. The implemented default
is `mask_method='image-guided'`: a smooth geometric prior plus genuine restored-RGB
edge inference via SciPy maxflow within a narrow trust band. Preserve exact source
identity keys, palette/binding, world placement and padded-canvas metadata. Donor
alpha is not the authority. Source-nearest is diagnostic only; exact NN equality
does not establish final contour quality.

Keep binary 0/255 geometric segmentation separate from rendering alpha. The latter
may contain intermediate coverage values within a one-HD-pixel contour, not broad
soft edges inherited from a donor. AA is a rendering step, not segmentation.

| Role | RGB source | Required evidence |
| --- | --- | --- |
| Foreground layer/occluder | Matching crop of the selected exact-canvas HD background | Explicit source-to-background correspondence and extraction geometry |
| Standalone static prop | Restored opaque RGB with surrounding-image evidence; inferred donor alpha is not used | RGB donor identity/hash, source binding and image-supported contour |

Foreground binding and RGB extraction do not establish segmentation. A duplicate-background layer should
match the chosen HD background only if source correspondence is true. An
original-RGB match diagnostic is useful evidence but does not prove that mapping.
Otherwise use the independent-prop path or require review rather than silently
substituting background RGB.

Opaque background production is a separate path: `gemini-nano-banana-2.1`,
preservation, original source only, with no photo attachments or detailed
text-material variant. The static runner consumes prepared backgrounds, not model
requests. Historical photo/text experiments are not current defaults.

For original 640x480 scenes, the foreground core requires an exact 2560x1920
background at 4x. A 2400x1792 Nano output is not native 4x: prepare an explicit,
recorded resample before extraction, retaining original/output hashes, dimensions
and filter. Do not hide a crop or auto-resize inside the core. Record RGB/mask
provenance separately under the [manifest contract](../configs/manifest.md).

## Image-Guided Contour Pilot

The pilot consumes frozen Scene1002-v3 sources and the selected Nano background.
Its command from the repository root is:

```sh
python3 tools/upscaling/static/contour_pilot.py
```

The private report root is
`private-assets/upscaling/static-layers/scene1002-guided-v1`; immutable runs have a
content-hash suffix and `latest.json` identifies the current report. Compare original NN, geometry-smoothed
and image-guided boundaries with outlines, zooms and composites at the same world
placement and padding. Six real layers were processed with no paid regeneration
or live promotion. Five are direct RGB-supported proposals. The ladder mask differs
from nearest-4x at 7,687 pixels and follows the restored rung boundaries; this count
proves that the mask changed, not that it is correct. Its upper opening needs an
explicit six-pixel exterior reconnection near the arch, retained as
`review-required-context-correction`, not claimed to be RGB-proven.
The raw RGB proposal, smooth prior, geometric mask, coverage and composites are
exported separately. A trust band of three native pixels needs review;
it is not a universal tuning promise.

## Historical Scene1002-v3 Baseline

Run from the repository root after preparing the private inputs:

```sh
python3 tools/upscaling/static/pilot.py --output private-assets/upscaling/static-layers/nearest-controls
```

The default prepared-data root is
`../neverhood-upscaling/data/room2-hd`. An explicit `--output` is now required so this
historical nearest-mask control generator cannot be mistaken for the final path.
The original frozen run remains in ignored
`private-assets/upscaling/static-layers/scene1002-v3`.
Use `--prepared-root`, `--catalog-root`, `--output`, and `--nano-result` to supply
explicit alternative private paths. Existing differing outputs are not overwritten;
choose a new output directory when the inputs or implementation change.

The pilot scope is four LadderArch foreground resources (`152c1313`, `060000a0`,
`b2a423b0`, `316e0772`) plus standalone props `312c8774` (ladder) and `b3242310`
(door backing). Review original source masks, independent nearest-4x masks, old
neural-mask comparisons and composites.

The pilot creates eight foreground candidates (four layers on the existing demo
background and on the selected Nano preservation background) and four prop
candidates (two props with source-Lanczos and existing-restored-RGB methods).
The Nano candidate is explicitly resampled from 2400x1792 to 2560x1920 for this
offline comparison; this is not a new native-4x image-generation claim.

The earlier completed local run produced 12 review-required candidates with exact
nearest-4x source alpha and zero intermediate alpha values. The ladder resource
`312c8774` retains four enclosed holes. Its legacy prepared RGBA contains 36,002
intermediate-alpha pixels. These measurements concern the inspected prepared pack,
not proof of which release is currently deployed. They proved unchanged NN
blockiness, not final HD contour quality; preserve them as historical baselines.

Artifacts include `report.html`, immutable per-candidate `result.json` records,
separate mask/RGBA/source-NN images, black/white/checkerboard previews, two
synthetic scene probes, `manifest.json`, and `candidate-bindings.json`. The binding
file is explicitly **not** a loadable room pack; alternative candidates retain
duplicate runtime keys until review selects one version.

Source RGBA is checked against the read-only catalog's indexed pixels and scene
palette. Runtime keys, padded raster hashes, frame placement, source-game binding,
RGB-donor provenance, and the original background are verified before processing.
The pilot covers unflipped source contexts only. Other orientations and state
variants require their own verified raster bindings, not a guessed filename.

## Reusable Core And Contour Update

[`pipeline.py`](pipeline.py) exports `process_asset(...)` and `compare_alpha(...)`.
The core accepts an explicit asset record containing `id`, `kind`, absolute
`sourcePath`, `sourceSHA256`, `contentSize`, padded `canvasSize`, native `placement`,
and `sourceIdentity`. The identity records scene/resource/frame, palette and
transparency context, crop/flip information, and runtime binding separately from
image paths.

Current core placement is nonnegative, and foreground content must fit within the
scene. Off-screen/clipped source contexts need an explicit additional extraction
recipe rather than implicit cropping or anchor changes.

Foreground calls require `backgroundCorrespondence: "explicit-scene-binding"`,
an exact-canvas RGB `background_path`, and native `scene_size`. Image-guided prop
calls require opaque contextual RGB through `rgb_path`, at either scaled content
or padded-canvas dimensions. A masked RGBA donor is rejected because hidden colors
are not trustworthy boundary evidence. Without restored RGB, callers must explicitly
request diagnostic `mask_method='source-nearest'`; only that control path permits
premultiplied source RGB Lanczos filtering and coverage unpremultiplication.
The earlier baseline applied the NN binary mask; the image-guided default instead
separates refined binary geometry from localized rendering coverage. Hidden RGB
handling does not establish contour correctness.

Results are published atomically as one per-asset directory. Repeating an identical
request checks the fingerprint, canonical manifest hash and all output hashes;
changed or corrupted artifacts fail rather than being silently replaced.

Synthetic verification:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 test/upscaling-static.test.py
PYTHONDONTWRITEBYTECODE=1 python3 test/upscaling-static-pilot.test.py
PYTHONDONTWRITEBYTECODE=1 python3 test/upscaling-refine.test.py
PYTHONDONTWRITEBYTECODE=1 python3 test/upscaling-contour-pilot.test.py
```

## Indexed Bulk Processing

The static branch maintains a source-use inventory separately from the background
inventory. A restored background does not establish palette, placement, visibility
or alternate-state RGB for every sprite in that scene. Bitmap format and a single
frame are not sufficient semantic classification.

Prepare the private selection and metadata index without processing:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/upscaling/static/bulk.py
```

Process every eligible binding and verify completed outputs on resume:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/upscaling/static/bulk.py --execute
```

The default root is `private-assets/upscaling/static-all-v1`. It contains:

| Artifact | Purpose |
| --- | --- |
| `index.sqlite` | Persistent runs, source-use aliases, per-context binding states, attempt history and artifact hashes |
| `latest.json` | Current run, summary and report paths |
| `runs/<hash>/selection.json` | Immutable source, implementation, dependency and processing selection |
| `runs/<hash>/source-inventory.json` | Hashed C++/header evidence, candidate/excluded-call coverage and unresolved expressions |
| `runs/<hash>/implementation/` | Exact implementation source snapshots matching the recorded hashes |
| `runs/<hash>/source-evidence/` | Exact read-only engine-source snapshots used to classify the bindings |
| `runs/<hash>/index.jsonl` | Full per-binding metadata, state rules, blocked reasons, result paths and attempts |
| `runs/<hash>/report.html` | Candidate comparisons plus blocked/unresolved-use ledger |
| `runs/<hash>/candidates/` | Independent binary geometry, rendering coverage, raw/prior masks, RGBA and source controls |

Binding identity includes scene, resource/frame, palette, raster, placement and
state context. It is not a bare resource filename. Native content, padded canvas,
runtime key, clip/visibility/priority evidence, original and restored RGB hashes,
normalization, implementation versions and review status remain attached.

The first authoritative prepared scope contains 13 bindings across Scene1001 and
Scene1002. The pressed-button overlay `15288120` is initially hidden and displayed
only on activation; it requires its own restored-state RGB and must not inherit the
unpressed room crop. Held animation `004a4495` is not silently converted into static
scenery. All other source uses retain a disposition even when context is unresolved.

The completed bulk run indexed 448 candidate source-use sites from 70 C++ files and
69 headers. Twelve source sites map to the prepared set, giving 449 binding records
after adding the thirteen prepared contexts without dropping source aliases.
These are context/use counts, not a count of unique physical game assets.

| Completed run result | Count |
| --- | ---: |
| Eligible contexts processed across 13 scenes | 31 |
| Processing failures or pending eligible jobs | 0 |
| Ordinary visual-review candidates | 19 |
| Review-required overlap/connectivity correction | 1 |
| Generated candidates held by geometry checks | 11 |
| Context records blocked before processing | 418 |
| Authoritative image artifacts indexed | 186 |
| New model/API requests | 0 |

All 31 completed contexts were replay-verified and skipped without new processing
attempts. Geometry-blocked candidates remain distinct from processing failures and
must not be promoted. Blocked source-use records primarily require helper/state,
background, target-geometry, palette or independent-RGB resolution. The ledger does
not claim that all static assets in the game are complete.

Cross-room direct-source candidates need explicit source/catalog/palette evidence,
opaque contextual RGB and exact visible-color correspondence with the original
background. This correspondence is a crop-binding safeguard, not a final quality
metric. Unresolved palettes, state-dependent RGB, transforms or donor context stay
blocked rather than being inferred from filenames or nearby code.

Execution is local CPU contour processing; it submits no new model requests and
does not promote a runtime pack. The worker holds an exclusive output-root lock,
checks every completed input/output hash before skipping it, and reconciles
interrupted attempts through immutable per-asset publication. Failed attempts are
not retried unless `--retry-failed` is explicitly supplied. Metadata preserves both
failed and successful attempts with timestamps.
Frozen binding metadata is checked against result identity as well as file hashes;
a valid result from another context cannot be silently reassigned. Run history is
retained: filter SQLite queries by the run in `latest.json`, rather than counting
all historical plans as additional assets.

`succeeded` means that processing and artifact verification completed. It does not
override contour review, context correction, upstream background caveats or runtime
acceptance. Whole-game semantic closure remains unproven while source-use records
are blocked; processed images and candidate-call counts must never be reported as
the number of completed unique assets for the entire game.

## Checks And Limits

Earlier preparation ran RealESRNet on RGB and grayscale alpha separately, then
reattached the inferred alpha. That is not validated geometric segmentation or
localized coverage: it can change topology and introduce broad soft edges. This
does not prohibit the new contour-localized rendering AA. Retain the old output only
as a historical comparison. Hidden RGB in transparent pixels is not automatically a
visible defect; evaluate the masked result and its composites.

Check shape adherence to restored RGB, coarse source consistency, four-connected
components/holes, thin parts and absence of extra objects. Record bounds, mask IoU
and contour displacement without requiring exact
NN equality. Check that AA is localized to the one-HD-pixel edge rather than general
donor softness, and inspect light/dark/checkerboard composites. Low-contrast image
support requires review; topology mismatch blocks acceptance. No automatic approval
follows from these diagnostics. Keep original-RGB correspondence evidence separate
from segmentation and visual review. See [mask policy](../masks/README.md).

Offline checks cannot establish gameplay fidelity. Do not promote outputs until
an in-engine fixture validates source placement, priority/state transitions,
clipping, part-3 deletion and hands. The synthetic colored underlay is an occlusion
diagnostic, not a gameplay capture. Image-guided candidates are implemented, but no
in-engine acceptance or universal contour-quality guarantee is claimed. This update
is static only and does not change the separate SeedVR2/animation mask policy.
