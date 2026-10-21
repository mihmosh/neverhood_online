# Common Asset Manifest Contract

This is a design specification, not a new implemented runtime-pack schema.
The current runtime continues using its existing validated room-pack format.

## Input

Every asset has an ID, kind (`sprite-animation`, `background`, `static-sprite`),
source identifiers and SHA256 hashes. Never use a machine-specific absolute path
as the only identity of an input.

For animation, record each original ordinal, file hash, dimensions, placement,
duration ticks, movement deltas and binary-mask hash. Record the sequence's fixed
canvas and origin. Explicitly map padding/held frames to source ordinals and mark
which output frames are eligible for quality evaluation.

Do not infer a tick rate from a uniformly encoded processing video. Preserve both
timelines and retain unknown timing fields as unknown.

## Processing

Record model/weights identity and hash when known, provider or runner revision,
dependency versions, precision, seed, resize/padding policy, noise controls,
temporal batch/window/overlap and all relevant exposed settings. Mark hidden
provider choices as unknown. Keep each RGB and mask branch separately identifiable.

For Gemini, additionally record the prompt-file hash, exact source attachment,
reference-catalog IDs/hashes, requested constraints and available model/request
version information. Reference photos are not the scene-geometry authority.
Historical reference experiments retain those fields; the current opaque-background
policy (2026-10-21) is `gemini-nano-banana-2.1`, preservation, source-only, with no
photos or detailed text-material prompt. Record the actual policy rather than
silently relabeling an older candidate.

## Static Layer Provenance

Static roles are contextual and may overlap: opaque background, foreground/occluder,
standalone prop and state-dependent layer are not mutually exclusive file types.
Retain opacity/transparency semantics and the scene, state, layer/priority and
palette/resource binding that establish how a bitmap is used. A resource ID alone
does not identify a rendering context. Preserve source-palette identity and hashes,
canvas dimensions, position offsets, right/bottom padding, flip and clip metadata.
Do not infer unknown gameplay metadata from an image.

Record RGB, categorical segmentation and rendering coverage provenance separately.
For static assets the native binary source mask is a coarse identity/topology prior,
not the final HD contour. Record `mask_method='image-guided'`, smooth-prior settings,
restored-RGB identity/hash, image-guided edge/maxflow settings and dependency versions.
Record the trust-band width, coordinate definition, units and review decisions;
three native pixels is a proposed starting band, not universal tuning.
Source-nearest and geometry-smoothed outputs are separate diagnostic baselines.
Do not accept a refined contour by exact equality to source NN or use donor alpha
as authority. Preserve exact source/runtime identity keys throughout refinement.

Hash the binary 0/255 geometric segmentation separately from rendering alpha and
final RGBA. Record the one-HD-pixel coverage rule and edge-localization checks;
intermediate coverage values are permitted only at the contour, not as general
softness. Record shape adherence to restored RGB, coarse consistency, thin-part
preservation, four-connected components/holes, extra-object checks, IoU/bounds and
changed-pixel trust-band membership and separately measured boundary displacement.
The symmetric distance between raster boundary-pixel centers is not a hard bound
equal to the native signed-distance band width. Low-contrast support requires review; topology mismatch
blocks acceptance. No automatic approval follows from passing numeric diagnostics.
This static contract does not modify the separate animation binary-mask policy.

For foreground RGB, record the chosen HD-background identity/hash, original scene
size, exact extraction rectangle and explicit source-to-background correspondence.
Do not infer correspondence from original-RGB match diagnostics. If correspondence
is not established, require review or process as an independent prop. For standalone
props, record the restored opaque contextual RGB donor/hash. Masked hidden RGB is
not boundary evidence; source Lanczos/nearest is an explicitly selected diagnostic,
not the default HD contour. The offline runner does not
launch neural inference.

For a 640x480 scene, exact 4x means 2560x1920. A 2400x1792 Nano background needs
an explicit preparatory resample, with original/output hashes, dimensions and filter
recorded; never label it native 4x. No hidden crop or core auto-resize is permitted.
Record old neural-alpha comparisons separately from source-mask outputs.

## Indexed Static Runs

The static bulk branch stores per-run immutable selections and a persistent SQLite
ledger under private `static-all-v1`. Binding identity includes source scene/use,
resource/frame, palette, raster, state, canvas and placement. Source aliases remain
indexed even when they map to an existing prepared context.

Preserve original and restored RGB hashes, model version/request identity,
normalization, per-role artifact hashes, source-code evidence, exact implementation
snapshots, attempt timestamps and failure/recovery history. Per-run JSONL exports
contain the complete binding metadata, not just result filenames. Completed output
hashes and binding identity are verified on resume; metadata must not be reassigned
between contexts.

Processing status (`pending`, `running`, `succeeded`, `failed`, `blocked`) is separate
from contour acceptance (`review-required`, context-correction review, geometry
block). A successful local job is not an approved asset. Missing state RGB and
unresolved source contexts remain visible in the index instead of being guessed.
Whole-game semantic closure and runtime acceptance are separate claims.

## Output And Acceptance

Record actual dimensions/counts, file hashes, color representation, alpha domain,
source-ordinal mapping, crop/padding and any resampling or encoding. Never hide an
extra interpolation step inside an "exact 4x" label.

Record failures with their stage and sanitized category. Do not invent output
frames or quality metrics for a failed job. A paid job must have an intent record
and prediction ID before an uncertain request is retried.

Separate deterministic invariant results, heuristic metric results, visual-review
notes and approval status. Approved outputs are immutable by identity/hash; a new
generation is a new candidate, not an invisible replacement.

For static layers, separate binary segmentation and localized rendering coverage,
padded geometry, topology, restored-RGB boundary adherence and composite checks
from original-RGB correspondence diagnostics and visual judgments. Keep the earlier
12-candidate Scene1002-v3 measurements historical: they established unchanged NN
blockiness, not final contour quality. The new six-layer run records restored-RGB
proposals, including a ladder overlap case with an explicit review-required
six-pixel exterior reconnection. Preserve raw proposal, smooth prior and corrected
mask hashes, correction bounds and exact changed coordinates separately. A coarse
topology mismatch near an occluder is not permission to silently fill an opening,
copy the old mask, or declare the correction RGB-proven.
Offline pilot output is not runtime approval or pack promotion. Gameplay remains
unvalidated until an in-engine fixture checks priorities, state transitions,
part-3 deletion and hand clipping against the source behavior.

Secrets and signed URLs belong only in ignored local records. This specification
does not authorize additional paid jobs or public distribution of asset media.
