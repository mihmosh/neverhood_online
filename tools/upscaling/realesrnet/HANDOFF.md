# Animation Branch Handoff

## Purpose And Ownership

Review this folder as the animation-restoration branch of the single Neverhood HD
repository. RealESRNet is selected; SeedVR2 experiments are retained as evidence,
not the active asset-generation method. Documentation and code are in English.

Cursor is already handled by its own branch. Static/background work is concurrent
in the Gemini/static branch. Do not overwrite, re-stage indiscriminately or claim
ownership of those files. See [BRANCH_SCOPE.json](BRANCH_SCOPE.json) for source and
shared-integration boundaries. This handoff is not a new Git branch or commit.

## Implemented Components

- [Batch](batch/README.md): read-only source enumeration, verified RGBA input jobs,
  content deduplication, bounded STORE packs, local SQLite, GPU worker and operator.
- [AWS](aws/README.md): independent VPC/L4/SSM infrastructure, private retained S3,
  OAC delivery restricted to approved demo releases and exact-instance stop guards.
- [Benchmarks](benchmarks/README.md): repeat-frame preparation, cache controls,
  raw/masked video comparison, readable labels, muted autoplay and private serving.
- [SeedVR2 evidence](experiments/seedvr2/README.md) and
  [API tools](experiments/replicate/README.md): explicit experiments, not build hooks.
- [Ghosting issue](benchmarks/issues/seedvr2-temporal-ghosting.md): observations,
  exact source hashes, export checks, unconfirmed mechanisms and mitigation results.

## Completed Data Work

| Item | Verified Result |
| --- | --- |
| Installed-game snapshot | 14 files, 640911293 bytes, private S3, local inventory |
| Physical animation frames / payloads | 6813 / 287 |
| Winner-selected frames / payloads | 6793 / 285 |
| Unique RGB/alpha jobs | 4458 |
| Duplicate frame references preserved | 2355 |
| Full unique PNG outputs | 4458, 413927203 bytes, native 4x |
| Full invocation | 4446 additional jobs after the 12-frame pilot, 617.06 seconds |
| Independent remote validation | All object metadata; 22 downloaded PNG body checks |
| Final compute state | Stopped; no further inference started by this packaging task |

The model checkpoint is `RealESRNet_x4plus`, SHA256
`a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df`.
RGB runs FP32, TF32 disabled. Alpha is not sent through the network: original
index-0 masks are enlarged with nearest-neighbor and remain exactly 0/255.
Source placement, durations, deltas, aliases and palette evidence remain local.

The GPU pilot matched verified CPU-cache foreground RGB with maximum delta 1/255
and MAE 0.00006469/255. This is numerical implementation agreement, not proof that
all generated details are correct. No high-resolution ground truth exists.

## Private Operator Artifacts

These are deliberately outside Git; obtain them through the authorized local
workspace, not by making the S3 source/result prefixes public:

```text
private-assets/upscaling/full-game-v1/
  original-files.json
  manifest.json
  jobs.sqlite
  hd-animation-assets.jsonl
  pilot-approval.json
  sample-validation.json
  completion.json
```

Cloud account/resource IDs and lifecycle records are under ignored
`private-assets/upscaling/aws/`. S3 has separate `sources/`, `results/` and
`releases/hd-demo/` prefixes. Full-game manifests/databases/logs are local only;
only final PNGs are uploaded by the batch. The S3 public-access blocks remain on.
The worker cannot write sources or publish releases, and cannot read Parameter Store.

This branch consolidation did not switch Vercel/R2 delivery; that statement is
historical, not the current integration status. A later external integration
published `releases/hd-demo/full-game-lossless-v1/`: 134 room/state PNG ZIPs and
all seven original BLBs, retaining all original videos. The checked-in frontend
selects this S3/CloudFront release and uses the unchanged stock full-game runtime.
The Vercel environment setting was reported changed; updated public frontend
deployment must still be verified separately. Generation counts do not establish
complete HD runtime-context closure or a full playthrough.

## Experiment Findings

- Hosted SeedVR2 3B worked; two hosted 7B attempts failed in provider infrastructure.
- Self-hosted normal 3B/7B both ran on a full L4 with offloading.
- Input PNG-to-video roundtrip did not blend poses: 49 frames checked, max channel
  delta 1, repeated initial poses identical. Ghosts already existed in raw restored PNGs.
- Tripling the input and selecting middle outputs reduced the example ghost-region
  signal about 41% for 3B and 86% for 7B, but did not eliminate temporal instability.
- These findings do not identify a VAE/DiT/windowing root cause. No VAE-only run
  was performed. User-selected RealESRNet remains the current method.
- RealESRNet control images came from exact lossless cached source frames and
  the same checkpoint, not an invented or re-encoded baseline. The probe palette
  differs from the runtime room palette; this is a method comparison, not literal
  room-pack byte identity. Shared binary alpha is disclosed in the comparison.

Private comparison viewers use ports 4195, 4196 and 4197. Their generated media
are not source assets and must not be committed.

## Integration Limits And Review Priorities

1. The completed set is **embedded-source type-4 animation data**, not proven
   runtime palette/replacement/shadow closure. Never make index 64 globally transparent.
2. Keep all source references, including 20 superseded physical frames flagged as
   non-winning. Do not convert raw ticks into an asserted global FPS.
3. Bitmap/cursor sheets and Smacker footage were preserved in original archives
   but not upscaled by this animation batch. Other branches own cursor/background work.
4. Results are not automatically approved/published room packs. Reuse the existing
   runtime pack validator and require room/context verification before integration.
5. Review worker/operator paths, S3 prefix isolation, resume hashes and one-window
   cost guards. Paid actions must remain explicit; tests/builds must never launch them.
6. Do not mix per-frame cache timing with newly measured GPU time, or infer image
   quality solely from low-resolution reprojection MAE.
7. Keep secrets, weights and derived game media out of Git and corresponding-source
   exports. Shared backstage photos are the explicit, provenance-recorded exception.

## Checks For The Orchestrator

Run only focused checks initially; no original data or GPU is needed for synthetic
worker/catalog tests. Real-data validation is separate and already recorded in
the ignored completion artifacts. Follow the individual runbooks for required
Python packages and private input paths.

```bash
python3 -m unittest discover -s tools/upscaling/realesrnet/batch -p 'test_*.py'
python3 -m unittest discover -s tools/upscaling/realesrnet/benchmarks -p 'test_*.py'
python3 tools/upscaling/realesrnet/experiments/replicate/test-private-cli.py
node --test test/upscaling-aws.test.mjs
npm run package:sources
node --test test/upscaling-docs.test.mjs
npm run assets:audit
```

No commit, push, public-asset replacement, model download or paid prediction is
performed as part of consolidating this handoff. Review the other branches'
handoffs before creating a combined integration commit.

## Consolidation Checks

- Batch synthetic tests: 32 passed after relocation.
- AWS template tests: 7 passed at the canonical path.
- Benchmark tests: 26 ran successfully, including 4 optional-data skips.
- Historical private-CLI checks: 6 passed; analyzer synthetic self-test passed.
- Batch/operator `--help` and JavaScript/Python/shell syntax were checked without
  cloud calls or inference. Help does not read the local deployment state.
- Private comparison servers were restarted at the new canonical source path;
  the same 4195/4196/4197 URLs returned HTTP 200. Existing game/static servers
  were not restarted.

These are focused source/packaging checks, not a claim that the complete website
suite or a new real-model integration run was executed during consolidation.
