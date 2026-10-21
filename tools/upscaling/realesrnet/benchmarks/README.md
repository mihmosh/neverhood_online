# Restoration Benchmarks

## Comparison Protocol

Use complete related actions on a common canvas: an idle/held pose, locomotion,
and a larger pose change. Avoid comparing unrelated actions as one temporal clip.
Keep source data, endpoint holds and quality-evaluation frame ranges explicit.

Use the same source input, target geometry, masks, seed where available and
documented settings. Disable interpolation. Compare synchronized clips at source
cadence, alongside fixed contact sheets and edge samples. Keep lossless RGB/RGBA
outputs for analysis; distinguish them from encoded video previews.

Hard validation covers counts, order, dimensions, hashes, mask domains, placement
and provenance. Color reprojection and repeated-pose temporal error are useful
signals, not universal quality scores. Stop-motion pose changes must not be
mistaken for unwanted flicker. There is no high-resolution ground truth here.

## Open Investigations

[Adjacent-pose ghosting in SeedVR2 output](issues/seedvr2-temporal-ghosting.md)
records a reproducible raw-RGB artifact. A 49-frame roundtrip check found no
pose blending in the input export; the ghost first appears in restored PNGs.
The exact restoration substage is not yet isolated. Inspect raw RGB as well as
masked previews, since alpha can hide part of the failure.

## SeedVR2 Probe: 2026-10-21

[Sanitized run configuration](../configs/seedvr2-probe-v1.json).

| Case | Provider | Result | Reported Predict Seconds |
| --- | --- | --- | ---: |
| A: 3B | zsxkib/seedvr2 | Succeeded | 12.787 |
| B: 7B | zsxkib/seedvr2 | Failed while loading weights: CUDA OOM on H100 80 GB | 9.820 |
| C: 3B + color fix | zsxkib/seedvr2 | Succeeded | 17.835 |
| D: 7B | papina/seedvr2 | Failed before video processing: PyAV missing | 0.008 |

Predict seconds are API metrics, not a bill or total wall time. Four predictions
were attempted across two explicit test requests; failed runs produced no
quality results and were not retried automatically.

Input: resource `000bab02`, labeled "Klaymen, open hands" by the source manifest,
visually a tumble/recovery. All 32 original frames were preserved. The common
384x216 RGB video had 49 frames at 15 fps: 8 initial holds, core indices 8-39,
9 final holds. Source durations total 62 ticks; their real tick rate was not
established by this probe. Ordinal-uniform previews are not gameplay timing.

The successful wrapper returned 1280x720, not native 4x. Analysis resampled RGB
another 1.2x to 1536x864 and restored identical binary nearest-4x source masks.
Its quality comparison is against original nearest-neighbor, not an exact
RealESRNet baseline. A 41ms/tick preview was also produced as a nominal example,
not verified ground truth.

| Descriptive Metric, 0-255 RGB Scale | A: 3B | C: 3B + Color Fix |
| --- | ---: | ---: |
| Mean foreground reprojection MAE | 13.598 | 10.717 |
| Initial repeated-pose temporal MAE | 0.595 | 0.527 |
| Final repeated-pose temporal MAE | 3.839 | 3.375 |

Color fix improved these source-correspondence metrics but did not establish an
overall quality winner or eliminate generated texture instability. The reported
errors also include the hosted video encoder's effects. No conclusion about 7B
image quality can be drawn from failed infrastructure runs.

## Private Artifacts

Earlier scripts, input frames, model responses, previews and reports remain in
the external `neverhood-upscaling` workspace. Do not copy raw responses into Git:
they can contain input media, temporary output URLs or other private information.
Migration of the probe code and reusable synthetic tests is still pending.

## AWS L4: 3B Versus Normal 7B

### Current Per-Frame Control

[prepare-per-frame-baseline.py](prepare-per-frame-baseline.py) restores the existing
lossless RealESRNet cache for the same 32 source frames. It verifies source IDs,
source hashes/metadata, cached neural PNG hashes and native 4x dimensions, then
places them on the common 1536x864 canvas without cropping or movement-delta
accumulation. Endpoint holds reuse their exact cached frame.

The checkpoint is `RealESRNet_x4plus`, SHA256
`a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df`,
matching the current room-method checkpoint. These are existing CPU-float32
outputs quantized to 8-bit RGBA PNG, not a new timed inference run or WebP Q90.
The probe's embedded palette differs from the runtime room palette, so this is a
method control on identical probe inputs, not a byte-for-byte live room pack.

The main control normalizes alpha to the same original binary mask used for
SeedVR2 masked views. Historical neural-alpha samples remain separate. Its raw
comparison canvas is composed over gray using that mask, unlike the whole-canvas
SeedVR2 raw prediction; zero outside-mask signal is therefore not a cross-method
quality score. Cache provenance and this distinction are recorded in metadata.

The separate NumZ runner completed both variants on the same full L4. Inputs,
seed 314159, batch 5, zero input/latent noise, color correction none, VAE and output
geometry were shared. Both returned 49 lossless RGB PNGs at 1536x864 (exact 4x).
The 32 original core ordinals were compared with identical binary masks.

| Measurement | 3B FP8 | Normal 7B FP8 Mixed Block35 FP16 |
| --- | ---: | ---: |
| Inference seconds, excluding downloads | 134.683 | 183.163 |
| Swapped blocks | 16 | 28 |
| Device-wide sampled peak MiB | Not measured | 7752 |
| Mean foreground reprojection MAE | 9.879 | 11.412 |
| Initial held-pose temporal MAE | 2.728 | 3.829 |
| Final held-pose temporal MAE | 2.665 | 3.851 |
| Clip-8 next-pose-only departure from gray | 8.241 | 16.816 |

These are measurements of the tested configurations, not a general model ranking.
Offload settings differ, so runtime is not a pure architecture comparison. Raw RGB
contains visible adjacent-pose ghosts in both variants; source masking hides some
of that failure. Neither is approved for game integration on this evidence.

[compare-seedvr2-aws.py](compare-seedvr2-aws.py) creates raw/default and masked
black/white previews, contact sheets, preserved timing metadata and detailed
metrics from private downloaded results. No GPU or API is used by the analyzer.
[serve-comparison.mjs](serve-comparison.mjs) serves a generated private analysis
directory on loopback, with origin checks and video range support.
Generated viewers autoplay the visible animation muted and loop it; explicit
Play/Pause and Restart controls remain available when a browser blocks autoplay.
Technical notes are collapsed so the actual video is visible first. A static
contact sheet is not a replacement for the moving comparison.

## Repeated-Frame Mitigation

The maintainer proposed tripling each input frame and keeping only the middle
output. [prepare-triplicate-probe.py](prepare-triplicate-probe.py) implements the
exact timeline: all 49 frames repeated three times plus two end pads, 149 at 45fps.
The selected 49 centers are `1+3*i`; quality uses 32 centers `25+3*i` at display
15fps. No motion interpolation or model RGB resampling is introduced.

[compare-triplicate-probe.py](compare-triplicate-probe.py) compares each baseline
to its own middle-frame result, using the same masks and large raw/masked labels.

| Measurement | 3B Baseline -> Triple | 7B Baseline -> Triple |
| --- | --- | --- |
| Core-0 ghost-region signal | 8.241 -> 4.846 (-41%) | 16.816 -> 2.365 (-86%) |
| Foreground reprojection MAE | 9.879 -> 6.964 | 11.412 -> 8.264 |
| Initial held-pose MAE | 2.728 -> 1.880 | 3.829 -> 3.323 |
| Final held-pose MAE | 2.665 -> 2.537 | 3.851 -> 3.915 |
| Inference seconds | 134.683 -> 382.229 | 183.163 -> 518.025 |

Both runs succeeded, with measured sampled GPU peaks of 7016 MiB (triple 3B) and
7752 MiB (triple 7B). Original 3B peak remains unmeasured. The reduction is useful
but local to this clip/configuration; 7B's final hold did not improve. Do not
equate these metrics with recovered true HD detail or a confirmed VAE diagnosis.
