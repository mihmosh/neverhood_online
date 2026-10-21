# Open Investigation: Adjacent-Pose Ghosting In SeedVR2 Output

Status: observed locally, root cause not isolated, not yet filed upstream.
Date: 2026-10-21. Do not treat masked previews as evidence that this is fixed.

## Reproduction Context

- Complete original action: resource `000bab02`, 32 source frames.
- Processing clip: 384x216, 49 frames at 15 fps, neutral RGB(128,128,128).
- Timeline: 8 leading holds, source ordinals 0-31, 9 trailing holds.
- Input SHA256: `e2f9fdbeeadff553da72d1881dfdb01ec10fa682c7268abf3a409e2e614cb201`.
- NumZ runner: `4490bd1f482e026674543386bb2a4d176da245b9`.
- Observed model: `seedvr2_ema_3b_fp8_e4m3fn.safetensors`.
- DiT SHA256: `3bf1e43ebedd570e7e7a0b1b60d6a02e105978f505c8128a241cde99a8240cff`.
- VAE SHA256: `20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1`.
- Output: 49 raw RGB PNGs, 1536x864. No output video encoding precedes inspection.
- Settings: seed 314159, batch 5, uniform batches, SDPA, compilation off,
  input/latent noise 0, color correction none, 16 swapped blocks, CPU offload,
  tiled VAE encode/decode with tile 512 and overlap 64.

## Symptom

Output clip frame 8 (source ordinal 0) contains the main pose plus a faint displaced
pose resembling the following source frame. The following input frame 9 contains
source ordinal 1. The restored file is `rgb24`, without an alpha channel: the
faint pose is mixed RGB content against gray, not a partially transparent sprite.

Observed raw frame SHA256:
`e96c6394269ed9bfbc54d61214d7609a50558fe02d4b52236d0e689cf7a32050`.

## Confirmed Stage Checks

| Check | Observed Result |
| --- | --- |
| Original RGBA -> prepared RGB | Exact match to original binary mask composited over gray for every input frame |
| Prepared RGB -> decoded input MP4 | All 49 frames checked; maximum RGB channel change 1/255 |
| Mean encoding roundtrip MAE | 0.0226083/255 |
| Decoded initial held pose, frames 0-8 | Identical; maximum inter-frame change 0 |
| Decoded input clip frame 8 | No displaced pose visible |
| Raw restored PNG frame 8 | Displaced pose already visible |

In the region occupied by the next pose but outside the current source mask
(49,600 output pixels), input distance from gray is exactly 0. The restored
frame's mean channel distance from gray is 8.2413/255. This is a descriptive
artifact measurement, not proof of a particular internal model mechanism.

These checks rule out cross-frame blending in this PNG-to-MP4 export as the
source of the visible artifact. They localize it to the restoration block, but
do not distinguish DiT inference, temporal VAE behavior or runner batch handling.

## 7B Corroboration

The requested normal 7B run also succeeded on the same L4 and input. It used
`seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors`, SHA256
`3d68b5ec0b295ae28092e355c8cad870edd00b817b26587d0cb8f9dd2df19bb2`,
the same VAE and quality settings, and 28 swapped blocks rather than 16.

Raw clip frame 8 SHA256:
`34e97983ab3f617167f33491b5ce8edea17eac3b0381d19f9c08bb3b195ca7ec`.

The faint adjacent pose is visible in 7B too. On the identical 49,600-pixel
next-pose-only region, mean distance from gray is 16.8163/255, versus 8.2413/255
for 3B and exactly zero for the input. This is one local artifact measure, not
an overall ranking or proof of a specific failure mechanism.

Inference wall times were 134.683 seconds (3B) and 183.163 seconds (7B), excluding
first-time setup/model downloads. 7B device-wide sampled peak memory was 7,752
MiB with offloading. The initial 3B run did not record a comparable peak.

## Diagnostic Tool

```bash
python3 tools/upscaling/realesrnet/benchmarks/check-input-roundtrip.py \
  --input-dir "$PRIVATE_PROBE/input" \
  --model-frame "$PRIVATE_AWS/runs/3b/frames/input/input_000008.png" \
  --clip-frame 8 \
  --output "$PRIVATE_AWS/diagnostics/roundtrip-frame8"
```

The tool performs no inference, API calls or uploads. It writes a report and an
input/restored/next-frame contact sheet in private storage. Original game frames
and these generated images are intentionally not included in this source tree.

## Unconfirmed Explanations

- Temporal VAE encoding/decoding may spread abrupt pose changes over adjacent frames.
- The restoration model may introduce temporal blending or motion hallucination.
- Independent temporal windows, their boundaries or reconstruction may contribute.

None of these is established by the current diagnostic. Larger parameter count
does not itself establish that a model avoids this artifact.

## Next Tests

1. Compare raw 3B and 7B outputs on the identical input before applying masks.
2. Run VAE encode/decode only, without DiT restoration, as a separately authorized test.
3. Compare held-pose segments and window boundaries with one setting changed at a time.
4. Verify frame correspondence/count after each stage; never silently interpolate.

Restoring the original binary alpha removes a ghost outside its silhouette, but
cannot repair blended colors/details inside it. Masking is not a root-cause fix.

## Maintainer-Proposed Triple-Frame Test

Hypothesis: repeat every input frame three times and select the middle restored
frame, reducing contamination from a different adjacent pose. This is an
experiment, not an established fix: the temporal receptive field may exceed one
neighbor and the VAE/window layout may interact with triplet alignment.

The entire baseline 49-frame timeline, including endpoint holds, is tripled to
147 frames. Two last-frame pads produce 149 frames (4n+1). CFR45 preserves the
baseline CFR15 processing duration apart from 2/45s padding. The selected 49
middle indices are `1+3*i`; the 32 quality indices are `25+3*i`, ending at 118.
The final two pads are not selected. This is repetition, not interpolation.

Prepared MP4 SHA256:
`7848d6a64008e95e874c5f9c8e4b242aa81ad3018eedcf6acd00e7f203310f0a`.
All decoded triples were verified internally identical; RGB encoding roundtrip
maximum channel delta remained 1/255. The new
[preparer](../prepare-triplicate-probe.py) and
[comparator](../compare-triplicate-probe.py) retain the exact selection map and
use the same model quality settings and original binary masks.

The measured 3B triple run completed: 149 raw PNGs at 1536x864, 382.229s inference.
Selecting the defined middle frames gave these results on the same clip:

| Descriptive Measurement | Baseline 3B | Triple-Frame 3B Centers |
| --- | ---: | ---: |
| Core-0 next-pose-only departure from gray | 8.2413 | 4.8459 |
| Mean foreground reprojection MAE | 9.8795 | 6.9644 |
| Initial held-pose temporal MAE | 2.7283 | 1.8798 |
| Final held-pose temporal MAE | 2.6652 | 2.5366 |

The example ghost-region signal decreased about 41%, but remains nonzero.
Fidelity/held-pose signals improved unevenly. This supports a partial mitigation
in this configuration, not elimination of ghosts or a confirmed root cause.
Inspect raw contact sheets and moving previews; do not hide a failed hypothesis
by showing only masked output.

The separately bounded normal 7B repeat also completed: 149 PNGs, 518.025s
inference, identical input and middle-index map. No stop deadline was extended
beyond the single extra 30-minute experiment window.

| Descriptive Measurement | Baseline 7B | Triple-Frame 7B Centers |
| --- | ---: | ---: |
| Core-0 next-pose-only departure from gray | 16.8163 | 2.3646 |
| Mean foreground reprojection MAE | 11.4123 | 8.2640 |
| Initial held-pose temporal MAE | 3.8287 | 3.3227 |
| Final held-pose temporal MAE | 3.8515 | 3.9153 |

The example ghost signal decreased about 86%, supporting the maintainer's
mitigation hypothesis for this configuration. It is not complete temporal
consistency: the final held-pose metric slightly worsened. Full raw videos and
contact sheets remain required. The experiment changes temporal sampling/window
alignment as well as repeated context; it does not isolate the responsible model
substage. No VAE-only test was run.
