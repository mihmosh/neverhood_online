# Archived SeedVR2 Replicate Probe

Canonical, portable copies of four authored standalone tools from the historical
private upscaling workspace's `scripts/` directory. The external originals remain
untouched. This is an **archived API experiment**, not the current RealESRNet
pipeline, a new model benchmark, or a production service.

Historical status: the 3B API runs succeeded; the tested 7B API wrappers failed.
`zsxkib/seedvr2` supplied the A/B/C comparison; `papina/seedvr2` supplied a separate
7B attempt. Failed runs have no output frames, quality scores, or synthetic
substitutes. This migration did not rerun or independently revalidate those jobs.
Their private prediction records and media are not included. Wrapper failures do
not establish that the underlying 7B model fails in every runtime.

## Files

| Canonical Script | Historical Script | Role |
| --- | --- | --- |
| [prepare-seedvr2-probe.py](prepare-seedvr2-probe.py) | `prepare_seedvr2_probe.py` | Local source verification, alignment, sidecars and input clip |
| [seedvr2-replicate-probe.mjs](seedvr2-replicate-probe.mjs) | `seedvr2_replicate_probe.mjs` | Explicit authenticated inspection or guarded paid API experiment |
| [analyze-seedvr2-probe.py](analyze-seedvr2-probe.py) | `analyze_seedvr2_probe.py` | Offline analysis of the historical fixed-geometry experiment |
| [serve-seedvr2-probe.mjs](serve-seedvr2-probe.mjs) | `serve_seedvr2_probe.mjs` | Thin CLI adapter to [the canonical comparison server](../../benchmarks/serve-comparison.mjs) |

The new [test-private-cli.py](test-private-cli.py) covers offline CLI/path guards
using synthetic data and a disabled API fetch function.

## Private Inputs

Run commands below from the repository root. Set `PRIVATE_MANIFEST` to the selected
source input `manifest.json`, `PRIVATE_PROBE` to a separate existing private
experiment directory, and `RESOURCE_ID` to an inspected complete resource ID.
All are caller-supplied local paths/values. Neither private location may be a
public web root. **All output must be outside the repository**, including ignored
directories; output beneath the original manifest directory is also rejected.
Use trusted local directories, not shared writable directories. Symlinked API
write paths and symlinked analysis/serve roots are rejected.

No credentials, source media, prediction JSON, raw outputs, or weights belong in
this subtree. These scripts do not download model weights or run neural models
locally. They do not depend on modules in the historical external workspace.

The manifest must have `sourceBinding` and `cases`; each case has `resource`,
`label`, and ordered `frames`. Each frame supplies `file`, `sha256`, `size`,
`index`, `frameId`, and `metadata` containing `frameIndex`, `x`, `y`, `width`,
`height`, `durationTicks`, `deltaX`, and `deltaY`. Files are relative to the
manifest directory and must remain within it. Only original RGBA with the full
binary alpha domain `{0,255}` is accepted. Existing source hashes are checked,
not regenerated to hide changes.

## Local Preparation

```sh
python3 tools/upscaling/realesrnet/experiments/replicate/prepare-seedvr2-probe.py \
  --manifest "$PRIVATE_MANIFEST" --output "$PRIVATE_PROBE/input" --inspect

python3 tools/upscaling/realesrnet/experiments/replicate/prepare-seedvr2-probe.py \
  --manifest "$PRIVATE_MANIFEST" --output "$PRIVATE_PROBE/input" --resource "$RESOURCE_ID"
```

- `--manifest` is required; no repository-derived input default remains.
- `--output` is required even with `--inspect`; it is the private **input** output directory, not the experiment base. Its parent must already exist.
- `--inspect` reads the manifest and prints case geometry/ticks only. It does not read source media, encode clips, or contact a service.
- `--resource` selects one complete case after inspection; no overwrite of nonempty output is allowed, including partial failed preparation.

Preparation retains native pixels at a fixed metadata-based origin and preserves
original metadata and source hashes. `deltaX/Y` are retained, not accumulated.
It composites binary alpha over RGB(128,128,128), pads with balanced endpoint
holds to 49/65/97 frames, and encodes at 15 ordinal frames/second with libx264
CRF0 yuv444p. Lossless YUV encoding is not bit-exact RGB round-trip preservation.
The source tick rate remains unknown. Original indexed palette reconstruction
is not claimed, and subsequent model RGB is not palette-preserving.

## API Commands

**No automatic paid calls.** Importing, checking syntax, preparing, analyzing,
and serving do not launch predictions. The API runner requires an explicit mode;
there is no implicit `inspect` default. Even `inspect` contacts Replicate, so it
must not be used as an offline validation command.
`--help` on either Node script is offline, needs no token/base, reads no experiment
data, and opens no server listener. Python scripts also support `--help`.

The token is read **only** from `REPLICATE_API_TOKEN` in the process environment.
If using Node's `--env-file`, pass the path of a private env file, never a token
value. Do not place an env file in this subtree. No script loads a default env
file, prints the token, or accepts a token CLI flag.

Explicit, non-prediction API inspection, only when authorized:

```sh
node --env-file="$PRIVATE_ENV_FILE" \
  tools/upscaling/realesrnet/experiments/replicate/seedvr2-replicate-probe.mjs \
  inspect --base "$PRIVATE_PROBE"
```

The following are **paid commands, not setup/verification steps**. Execute only
with a separate decision to spend the API budget:

```sh
node --env-file="$PRIVATE_ENV_FILE" \
  tools/upscaling/realesrnet/experiments/replicate/seedvr2-replicate-probe.mjs \
  run --base "$PRIVATE_PROBE" --allow-paid

node --env-file="$PRIVATE_ENV_FILE" \
  tools/upscaling/realesrnet/experiments/replicate/seedvr2-replicate-probe.mjs \
  papina --base "$PRIVATE_PROBE" --allow-paid
```

- `--base` is the existing private experiment directory containing `input/`. If omitted, only `NEVERHOOD_SEEDVR2_PROBE_DIR` can provide it; there is no fallback path.
- `inspect` retrieves the `zsxkib/seedvr2` schema and writes private `runs/model.json`. It refuses a changed pinned model version. It does not create predictions.
- `run --allow-paid` permits at most three A/B/C prediction slots per experiment: 3B without color fix, 7B without color fix, and 3B with color fix.
- `papina --allow-paid` permits at most one separate D slot using the papina 7B wrapper, with explicit 720/1280 resolution settings.
- Both paid modes use seed 314159, one sampling step, CFG 1, SP size 1, and metadata FPS. Both validate the input hash and enforce a 4 MiB input data-URL limit.
- Both preserve request-digest resume checks and refuse settings/input/version mismatches. An intent without a prediction ID blocks retry because creation may already have incurred a charge. Do not delete intent files to bypass this guard.
- Intent creation is exclusive, reducing duplicate creation risk from concurrent invocations. Existing completed failures are not automatically retried. Do not run concurrent writers in one experiment directory.
- Requests retain `Cancel-After: 3m`, a bounded 210-second polling wait, and a cancellation request on deadline. This is not a monetary cost guarantee.
- Downloads accept only HTTPS Replicate delivery hosts, at most four redirect attempts and 128 MiB per output. An existing different output is never replaced; identical output can be resumed.

The caps are per experiment directory, not account-wide budgets. A new directory
or manually altered records can invalidate that accounting. `papina` writes
`runs/D-papina-7b/result.json` separately; the analyzer consumes A/B/C
`runs/summary.json`, not the papina record. No speculative replacement jobs or
fallback model requests are made. `papina` exits 2 for a recorded non-success;
runtime errors exit 1. A/B/C terminal status is recorded in the summary and must
be inspected rather than inferred from a zero process exit.

## Offline Analysis

```sh
python3 tools/upscaling/realesrnet/experiments/replicate/analyze-seedvr2-probe.py \
  --base "$PRIVATE_PROBE"

TMPDIR=/tmp/kilo python3 \
  tools/upscaling/realesrnet/experiments/replicate/analyze-seedvr2-probe.py --self-test

PYTHONDONTWRITEBYTECODE=1 python3 \
  tools/upscaling/realesrnet/experiments/replicate/test-private-cli.py
```

`--base` defaults only to `NEVERHOOD_SEEDVR2_PROBE_DIR`; otherwise it is required.
`--self-test` ignores the base and uses temporary synthetic media, no private
inputs or API calls. Keep `TMPDIR` outside the repository. Analysis writes only
new/empty `BASE/analysis`, refuses nonempty output, and verifies original source,
aligned RGBA, mask, input timeline, and successful output hashes.

The analyzer intentionally remains specific to the historical probe: 384x216
source canvas, 32 original ordinals, 62 source ticks, 49 clip frames, 8/9 endpoint
holds, and core clip indices 8..39. It is not a generic analyzer for every case
the preparer supports. It requires local successful 1280x720, 49-frame outputs
at metadata FPS. Wrapper RGB receives another 1.2x Lanczos resize to the true
1536x864 4x canvas; original binary alpha is restored with exact nearest 4x,
never generated by the model. Source binding, available original frame metadata,
model/version from the records, and palette/alpha limitations are reported
without inventing missing provenance.

Core order and ordinal timing are retained. The separate nominal cadence view
uses **assumed** 41 ms/tick, not a verified source clock. Reprojection MAE is a
source-faithfulness metric, not proof of perceptual improvement. Hold temporal
MAE measures repeated-input instability, not optical flow or action quality.
There is no reference ground truth, automatic winner, or claimed RealESRNet
model baseline. Failed runs display their recorded error; a generic tile no
longer asserts a specific GPU/OOM cause independently of the record. The
historical generated offline comparison page is retained, not a new app/UI.

## Local Viewing

```sh
node tools/upscaling/realesrnet/experiments/replicate/serve-seedvr2-probe.mjs \
  --base "$PRIVATE_PROBE" --port 4195
```

`--base` has the same environment fallback. `--port` overrides `PORT`; otherwise
the canonical server default is 4195. Valid ports are integers 1024..65535.
Only `BASE/analysis` is served. The adapter delegates HTTP, loopback binding,
host/origin checks, symlink checks and range handling to
[`../../benchmarks/serve-comparison.mjs`](../../benchmarks/serve-comparison.mjs).
No duplicate HTTP implementation or historical port compatibility callback is
retained. Serving opens a loopback listener; it is not part of offline syntax
verification and does not publish the assets.

## Dependencies And Verification

Python 3.10+ (`Path.is_relative_to` and strict `zip`), Pillow with `Image.Resampling` (9.1+), NumPy,
and FFmpeg/ffprobe with libx264 and the cadence options used above are required.
Node.js 22+ is recommended for built-in fetch, argument parsing, abort timeouts,
and `--env-file`; there are no npm dependencies. No dependency installation or
model download is performed by these scripts.

Safe syntax-only checks, from the repository root:

```sh
node --check tools/upscaling/realesrnet/experiments/replicate/seedvr2-replicate-probe.mjs
node --check tools/upscaling/realesrnet/experiments/replicate/serve-seedvr2-probe.mjs
PYTHONPYCACHEPREFIX=/tmp/kilo/seedvr2-pycache python3 -m py_compile \
  tools/upscaling/realesrnet/experiments/replicate/prepare-seedvr2-probe.py \
  tools/upscaling/realesrnet/experiments/replicate/analyze-seedvr2-probe.py
```

Migration verification uses syntax checks and offline synthetic/negative tests
only. No AWS action, API inspection, paid prediction, private media analysis,
network test, or model download is required or implied.
