# Full-Game RealESRNet Animation Batch

The active model is **RealESRNet_x4plus**, not SeedVR2. This implementation reuses
the existing lab's EC2/S3 operator infrastructure in the adjacent `aws/` directory.
See the [RealESRNet entry point](../README.md).

## Preserved Sources And Local Catalog

The reviewed installed tree `extracted/app/` contains 14 files, 640,911,293 bytes.
All are preserved privately under `sources/game/installed-tree-v1/`, with native
relative paths, verified SHA256 and encryption. The local inventory distinguishes
original media archives, executable/support files, compatibility additions,
documentation and the one-byte installation-state snapshot. It does not assert
authenticated retail provenance. Distribution wrappers outside `app/` are not
additional game resources and were not silently included.

Authoritative local artifacts live under `private-assets/upscaling/full-game-v1/`:

- `original-files.json`: complete installation inventory and S3 object hashes.
- `jobs.sqlite`: source catalog tables plus deduplicated jobs and frame bindings.
- `manifest.json`: immutable preparation record, input packs and evidence scope.
- `pilot-references.json`, `pilot-approval.json`: actual cached-RGB quality gate.
- `progress.json`: operator's current observation, not a claim of completion.
- `hd-animation-assets.jsonl`: generated only after every output is verified.

**No manifest, SQLite, JSON report or raw log is uploaded for this batch.** The
worker keeps its own checkpoint/summary on encrypted EBS. S3 holds original files,
PNG input packs, the checkpoint/code artifacts and final PNG objects. Per-object
SHA/model/dimension metadata is used for integrity, not as a global frame catalog.

## Coverage

| Measure | Count |
| --- | ---: |
| Physical animation payloads | 287 |
| Physical animation frames | 6813 |
| Winner-selected payloads / frames | 285 / 6793 |
| Superseded physical frames retained and flagged | 20 |
| Unique pixel jobs | 4458 |
| Duplicate frame references, not repeated inference | 2355 |
| Native input PNG bytes | 31862081 |
| STORE ZIP bytes / parts | 32807199 / 1 |

All source aliases, duration ticks, offsets, deltas, collision/capacity information,
palette references and flip recipes remain in the local catalog. No movement
interpolation or assumed frame rate is applied. Identical RGBA jobs are shared;
source identities are never deduplicated away. Flips are not additional GPU jobs.

This is an **embedded-palette source base**, not verified all-game runtime color
closure. Transparency defaults to source index 0. Index 64 is not globally
transparent; context-specific replacement, active palettes, fades, opaque roles
and shadow surfaces require separate evidence. The local context flag remains
unverified. Bitmap/cursor-sheet cells and Smacker videos are not included in this
sprite batch; their original resources are preserved inside the source BLBs.

## Processing Contract

Checkpoint SHA256:
`a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df`.

[job_contract.py](job_contract.py) versions the identity over dimensions, canonical
straight RGBA8, model SHA and preprocessing. Hidden RGB is zero; source alpha is
binary. [prepare-catalog.py](prepare-catalog.py) verifies source blobs, preserves
the catalog and creates bounded STORE packs containing only `<jobkey>.png`, with
no database or manifest inside. Expected count/keyset SHA are passed to the VM
as explicit command values. The worker verifies the entire set before inference.

[model.py](model.py) uses the inference-only RRDBNet with CUDA FP32, TF32 disabled,
foreground-color extension and reflect-8 context. Tiny inputs first extend to a
9-pixel minimum before foreground fill; the final result is cropped back to the
original native dimensions x4. No tiling, quantization or alpha inference is
silently substituted. Original alpha is enlarged with nearest-neighbor and
reattached as exactly 0/255. BasicSR/Real-ESRGAN attribution is retained in code
and [licenses](licenses/BasicSR-LICENSE.txt).

## Pilot Before Full Execution

The 12-frame pilot includes largest, smallest and a verified cached reference.
The observed largest source is 551x333 (183483 pixels); the smallest is 1x1.
Actual pilot checks passed:

- Native x4 output dimensions and original binary alpha exact for all 12.
- Hidden output RGB zero; source/model/output hashes verified.
- Cached CPU reference maximum RGB delta 1/255, mean 0.00006469/255.
- Peak Torch reserved memory 2912944128 bytes, about 12.1% of actual device memory.

The pilot gate requires at least 20% reserved-memory headroom and measured cached
RGB agreement. [verify-pilot.py](verify-pilot.py) runs locally without GPU/API.
An installation dependency and an IMDS profile initialization error were fixed
before GPU pilot success; no actual inference was retried for those failures.

## Operator Commands

Use the local operator SDK environment from the [AWS instructions](../aws/README.md).
Set an explicit authenticated `AWS_PROFILE`. Example commands:

```bash
python manage_batch.py upload-originals
python manage_batch.py upload-inputs
python manage_batch.py arm-start
python manage_batch.py stage-runtime
python manage_batch.py pilot
python manage_batch.py collect-pilot
python verify-pilot.py --work-dir PRIVATE_WORK_DIR
python manage_batch.py start-full
python manage_batch.py progress
```

Run from this directory or supply the full script path. Commands are not implicit
test/build hooks. `arm-start` re-arms an exact-instance UTC auto-stop **before**
starting the existing stopped L4, then records one four-hour paid window (up to
$3.9104 compute at the checked rate, storage/transfer extra). It does not create
another GPU instance or automatically extend the window. After a failed/uncertain
submission, recover the recorded command rather than launching duplicates.

The worker is controlled through SSM with no inbound ports or operator keys on
the VM. It uses its restricted instance role. Installation adds SciPy/boto3 to
the existing venv and does not replace drivers.

## Checkpoints, Outputs And Completion

VM checkpoint: `/opt/neverhood-upscaling/realesrnet/state/neverhood-full-v1.sqlite`.
Each committed frame records source identity, output hash and upload state.
SIGTERM/deadline stops new work with grace for the in-flight frame/uploads.
Resume validates existing output metadata and does not recompute completed jobs.

Private outputs:
`results/neverhood-upscaling-lab/full-realesrnet-v1/images/<jobkey>.png`.
The worker cannot publish these under `releases/`. No online demo is modified by
this batch. WebP/room-archive packaging and runtime-context approval are later stages.

`progress` independently lists object keys against all expected local jobs. Once
the sets match, it verifies every object's hashes/provenance/dimensions/encryption,
updates local SQLite and writes all 6813 physical frame bindings locally. Merely
having submitted a command or seen some objects is not completion.

The full SSM invocation schedules OS shutdown after two minutes **only after**
its local summary confirms 4458 finished outputs. Failure/checkpoint does not
trigger that shortcut; the independent four-hour stop remains. EBS and S3 remain
billable while compute is stopped. No automatic retry of failed inference, mask
policy change, or public release is performed.

## Completed Batch: 2026-10-21

The first full batch finished successfully: 4458 unique lossless RGBA PNGs,
413927203 bytes (about 394.75 MiB), mapped locally to all 6813 physical animation
frames. The full invocation processed 4446 new images, reusing the 12 completed
pilot outputs, in 617.06 seconds including its ingestion/output work.

The operator independently verified every remote object's key, source/model
identity, dimensions, encryption and declared output hash. Twenty-two downloaded
PNG bodies (20 fixed-seed random plus native minimum/maximum) additionally passed
actual SHA256, native x4 geometry, exact original binary alpha and hidden-RGB
checks. These body samples are not represented as an exhaustive second download.

Local completion artifacts are `completion.json`, `hd-animation-assets.jsonl`,
updated `jobs.sqlite`, `sample-validation.json` and the retained input manifest.
No manifest/database was uploaded. The worker was confirmed stopped after its
early-completion shutdown; the independent four-hour timer was not extended.

This completes the embedded-source animation base. It does not approve every
runtime palette/replacement/shadow state or modify the existing online demo.
