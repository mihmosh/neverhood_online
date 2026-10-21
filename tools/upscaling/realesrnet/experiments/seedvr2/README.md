# SeedVR2 Animation Pipeline

## Scope

Process a complete related animation, not independent tight-cropped images.
Preserve source ordinals, fixed placement, duration ticks, deltas and action
boundaries. Do not interpolate motion or treat an animated GIF as proof that the
model uses temporal context. Mask processing is a [separate stage](../../../masks/README.md).

## Implementations

- [Official ByteDance code](https://github.com/ByteDance-Seed/SeedVR) and weights:
  [3B](https://huggingface.co/ByteDance-Seed/SeedVR2-3B),
  [7B](https://huggingface.co/ByteDance-Seed/SeedVR2-7B).
- [NumZ standalone CLI / ComfyUI integration](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler):
  practical candidate for CPU offload, BlockSwap, tiled VAE and PNG output.
- [AWS sample](https://github.com/aws-samples/sample-sagemaker-video-upscaler):
  a SageMaker Processing Job around the NumZ runner, not a distinct model.

The AWS sample pins NumZ v2.5.23 and configures 3B FP8, 540p, batch size 81 on
`ml.g5.4xlarge` (A10G, 24 GB). These are sample settings, not universal minimums.
Its infrastructure includes an ongoing NAT Gateway charge and a five-day maximum
job runtime; do not deploy it unchanged for short experiments.

## Controlled Local Or AWS Run

The intended execution unit is the same pinned batch runner on either a machine
with RTX 3090 or EC2 G6 with a full L4. Both GPUs have 24 GB VRAM; L4 does not
automatically provide more capacity or better throughput. The implemented
[AWS lab](../../aws/README.md) has completed 3B FP8 and normal 7B FP8 probes on a full L4.
That confirms these short configurations fit, not arbitrary resolutions/windows.

Start with 3B, short temporal windows and no compilation. Evaluate 7B separately,
with offloading or quantization as needed. Do not start with a Sharp variant when
investigating unwanted grain. Record quantization as part of the experiment.
Do not load multiple model variants concurrently for a fidelity comparison.

Use lossless inputs/outputs where supported. A CLI directory of PNG files can mean
independent image jobs rather than a temporal sequence: use a sequence-aware
workflow or an explicitly controlled lossless video intermediate. Validate frame
count, ordering and dimensions even when a runner promises to preserve them.

## Offline Operation

Stage code, dependencies, DiT/VAE weights, conditioning files and codecs first.
Missing or invalid files may trigger network downloads. An offline claim requires
a cold-start inference test with egress blocked, not just an environment flag.
Keep all model files in ignored storage and record their hashes in the run.

## Existing Probe

The 2026-10-21 experiment used one 32-frame Klaymen action and a shared 49-frame
RGB input, including explicit endpoint holds. It produced two usable 3B outputs.
Two different hosted 7B attempts failed for infrastructure reasons. A subsequent
self-hosted AWS run completed both sizes; inspect their raw RGB because a
[ghosting issue](../../benchmarks/issues/seedvr2-temporal-ghosting.md) remains.
See the [experiment record](../../benchmarks/README.md) and
[sanitized configuration](../../configs/seedvr2-probe-v1.json).

Existing external API scripts are not yet fully migrated. AWS installation,
bounded probes, output verification and operator tools are available under
[aws](../../aws/README.md); approval of restored game assets is a separate step.

## Game Movie Pilot

The separate [movie tools](../../video/prepare.py) prepare explicitly selected
cutscene or navigation excerpts, rather than treating movies as RGBA sprite jobs.
This is an offline pilot, **not** in-game HD movie playback or whole-corpus approval.
No script in this path starts EC2, uploads assets or changes AWS permissions.

Prepare a private excerpt locally (FFmpeg and ffprobe required):

```bash
python3 tools/upscaling/realesrnet/video/prepare.py \
  --source private-assets/path/to/video.smk \
  --output private-research/video-pilot/navigation-01 \
  --kind navigation --start-frame 0 --frames 49
sha256sum private-research/video-pilot/navigation-01/manifest.json
```

Use `--kind cutscene` for a separately reviewed cutscene. Roles are operator
annotations, not inferred from duration or resource names. The source FPS is kept
as a rational number; no interpolation, sprite holds or frame triplication is used.
The model input is silent H.264 CRF 0 / YUV444; this avoids further quantization
but is not a claim of bit-exact RGB roundtrip. Available source audio tracks are
trimmed separately and saved as FLAC in `audio.mka`; audio is never synthesized.
The pilot rejects variable-frame-rate sources, changing geometry and nonzero
video/audio start offsets rather than silently retiming or shifting tracks.
The manifest binds the source hash, original frame range, decoded geometry,
model-input hash and audio hash. Original files are never modified.

On the existing GPU VM, stage the prepared private directory and these source
files through the established private operator workflow. Preserve the repository
layout for `video/run.py`, `aws/helper/probe.py` and `aws/helper/probe7b.py`; execute as the existing
unprivileged runner user, with no other GPU jobs active. The model environment is
the existing `/opt/neverhood-upscaling/runner`. Preview the validated command:

```bash
python3 tools/upscaling/realesrnet/video/run.py \
  --input /private/path/navigation-01 \
  --manifest-sha256 ACTUAL_MANIFEST_SHA256 --run-id navigation-01
```

Adding `--execute` explicitly starts one bounded GPU attempt. It reuses the pinned
SeedVR2 **7B normal** FP8 mixed-block35 FP16 model, VAE hashes, seed, batch size 5,
BlockSwap 28, CPU offload and tiled VAE from the existing 7B L4 probe. This is not
the 3B model or the Sharp variant. Weights must already be staged; no downloader is invoked.
The default is validation only, not inference. Inputs are limited to 121 frames;
the pilot runner additionally requires exact source-relative 4x targets divisible
by 16, no more than 1536x1024 pixels and at most 2048 pixels per side. Other sizes
fail rather than silently resize. These limits are safeguards, not a guarantee
that every allowed clip fits VRAM or finishes within the 15-minute timeout.

Results stay under `runner/runs/video-RUN_ID/`: raw restored PNGs, a CRF 0 MP4
master with the separately preserved FLAC audio tracks, and `report.json` recording
provenance, elapsed inference time and sampled device-wide GPU memory. Existing
run IDs are never overwritten. Failed validation never marks a run successful;
partial files are diagnostic only. Raw local inference logs are not for publication.

Inspect both the PNG sequence and motion playback for ghosting, flicker, camera
pan consistency, clay texture and puzzle symbols before approving any assets.
Source-relative 4x is not necessarily game-display-relative 4x: Smacker ring
frames, scene doubling, looping, skip events and subtitles still need runtime
mapping. The existing browser video fallback remains unchanged.

Offline tests (synthetic media only; no AWS or GPU):

```bash
python3 -m unittest discover -s tools/upscaling/realesrnet/video -p 'test_*.py' -v
```

For an explicitly authorized pair of real trials, the operator helper stages only
the two prepared directories `cutscene-01/` and `navigation-01/` plus the pinned
control files. It requires the existing isolated L4 to be running, verifies the
operator account and active exact-instance UTC stop guard, rejects overlapping
SSM commands, records intent and submits at most one attempt per clip. It neither
starts the instance nor extends the compute window. An uncertain submission must
be reconciled in SSM; do not delete its intent record to retry.

```bash
OPERATOR_PYTHON tools/upscaling/realesrnet/video/aws_trials.py \
  --directory private-research/video-pilot/movie-7b-TRIAL_ID \
  --profile OPERATOR_PROFILE --submit
OPERATOR_PYTHON tools/upscaling/realesrnet/video/verify_trials.py \
  --directory private-research/video-pilot/movie-7b-TRIAL_ID \
  --profile OPERATOR_PROFILE --wait
```

`OPERATOR_PYTHON` denotes the existing operator virtual environment with the
[operator requirements](../../aws/requirements-operator.txt), not the inference
environment. Without `--submit`, the upload helper only validates local inputs.
Inputs/control files use `sources/probes/TRIAL_ID/`; outputs use the worker's
existing `results/STACK_NAME/TRIAL_ID/` permission boundary. The worker uploads
raw PNGs, the FLAC-preserving MP4 master, browser MP4 previews, side-by-side comparisons
(nearest-neighbor original on the left) and reports with AES256 encryption and
S3 SHA256 checksums. Raw inference logs remain on the VM. The verifier downloads
private results, checks frame/movie/manifest hashes, and archives verification
and source-selection evidence. Success means technical validity, not visual
approval or an automatic runtime release. Stop the exact trial worker after
verification; its scheduled stop remains the fallback.

The first real movie pilot exposed Matroska rounding of `50000/3333` FPS. New
masters use an explicit MP4 video timescale and copied FLAC (`-strict -2` for
older FFmpeg); browser previews use AAC instead. For the already-recorded exact
MKV timing-validation failure only, `verify_trials.py --repair-mux` can verify
the completed PNGs and repackage on the operator CPU, with **no new inference**.
It creates a separate `packaged-v2/` S3 prefix and retains the original failed
packaging report and frame hashes as provenance. Existing local recovery outputs
are not overwritten. Visual checks of the real navigation pilot found displaced
and duplicated edges; successful technical verification is not release approval.

## Full Corpus Batch

The explicit full-video request is separate from approval for in-game replacement.
`create_bulk_plan.py` hashes and fully probes every original in the private video
catalog, validating decoded ordinals, constant geometry, exact rational FPS and
audio origins. It does not guess that every non-navigation movie is a cutscene:
the catalog also contains turns, idles, disk-player and puzzle/inset Smacker media.
All unique payloads remain included, with every resource alias and original flag.
Source-relative 4x is not game-display-relative 4x.

```bash
python3 tools/upscaling/realesrnet/video/create_bulk_plan.py \
  --output private-research/video-bulk/movie-7b-full-20261021/plan.json
OPERATOR_PYTHON tools/upscaling/realesrnet/video/bulk_operator.py stage-sources \
  --directory private-research/video-bulk/movie-7b-full-20261021 --profile OPERATOR_PROFILE
OPERATOR_PYTHON tools/upscaling/realesrnet/video/bulk_operator.py start-window \
  --directory private-research/video-bulk/movie-7b-full-20261021 --profile OPERATOR_PROFILE
OPERATOR_PYTHON tools/upscaling/realesrnet/video/bulk_operator.py status \
  --directory private-research/video-bulk/movie-7b-full-20261021 --profile OPERATOR_PROFILE
```

The audited corpus has 550 unique videos / 551 resource aliases / 55,270 frames.
The 15 wider 448x240 originals explicitly use 1792x960 targets; they are neither
excluded nor silently resized to the pilot pixel cap. Video masters preserve
source FPS and all embedded audio as verified sample-identical FLAC. External
gameplay sounds are not embedded movie tracks and remain independent.

`bulk.py` runs only the pinned 7B configuration. It processes 49-frame cores with
up to four source-context frames on each side, discards context output, and keeps
an explicit source-frame map. There is no output interpolation or overlap blending.
Verified chunks and their reports are committed to S3 before local scratch removal.
The report is the chunk commit marker; the movie manifest is the movie commit marker.
Resume validates the plan/source and all committed object checksums, and does not
pay for completed inference again. An uncertain partial inference is not retried
automatically; complete local PNGs or packaged chunks can be recovered.

Outputs use `results/neverhood-upscaling-lab/movie-7b-full-20261021/SOURCE_SHA/`:
`chunks/START/master.mp4`, `chunks/START/report.json`, full `master.mp4`, browser
`preview.mp4` and `manifest.json`. Shared `progress.json` is a checkpoint, not proof
of completion. Only a verified `coverage.json` covering every planned source and
frame may report completion. The full raw PNG corpus is not retained: checksums
and packaged chunk masters preserve the archival/provenance boundary without
accumulating hundreds of GiB of intermediate data on the worker.

The operator creates an exact-instance stop schedule **before** starting the L4,
using the existing narrowly scoped shutdown role. Each window is at most 12 hours;
at most six windows are submitted, an aggregate 72-hour compute ceiling. Approximate
g6.2xlarge compute at $0.9776/hour is $70.39 at that ceiling, excluding storage and
transfer. Extrapolations from short probes are not a runtime or cost guarantee.
The worker stops starting chunks before its deadline; the wrapper schedules host
shutdown when it returns, and EventBridge Scheduler is the independent fallback.
Starting another window requires the prior instance to be stopped and no active
SSM command. Uncertain submissions must be reconciled, not blindly resent.
