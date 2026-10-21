# HD Restoration Workspace

Public source, specifications and experiment records for Neverhood's HD assets.
This is an offline asset-production workspace, not another game engine or a
browser inference service. ScummVM remains responsible for gameplay.

## Structure

| Directory | Purpose | Current Status |
| --- | --- | --- |
| [seedvr2](seedvr2/README.md) | Historical temporal-restoration entry point | Canonical experiments now belong to the animation branch |
| [realesrnet](realesrnet/README.md) | Selected per-frame RGB animation method | Completed embedded-source batch: 6813 frames / 4458 unique PNGs |
| [gemini](gemini/README.md) | Opaque room-background candidates and canonical English handoff | Source-only preservation; one unified manual all-images review |
| [static](static/README.md) | Offline foreground layers and standalone static props | Indexed bulk run: 31 processed contexts across 13 scenes; review and geometry holds retained |
| [masks](masks/README.md) | Geometric masks, rendering coverage and boundary checks | Static image-guided refinement underway; animation policy unchanged |
| [benchmarks](realesrnet/benchmarks/README.md) | Comparable animation clips, provenance, metrics and visual review | Animation branch owns the code and ghosting investigation |
| [configs](configs/README.md) | Shareable settings and manifest conventions | Sanitized experiment configuration, no credentials |
| [references](references/README.md) | Deliberately published photographic references | Five existing backstage/set-photo candidates |
| [tests](tests/README.md) | Rules for small, synthetic pipeline tests | Documentation, IaC and offline probe/analysis checks |

The [AWS runner and infrastructure](realesrnet/aws/README.md) are implemented and
explicitly provisioned. Mask refinement remains experimental. The animation
branch's canonical code, English documentation and orchestrator summary are in
[realesrnet](realesrnet/HANDOFF.md). Private results remain outside Git; historical
API tools are imported explicitly rather than copying the private workspace.

## Current Asset Paths (2026-10-21)

Animation: original RGB frames -> per-frame RealESRNet restoration -> original
binary masks at native 4x -> verified RGBA -> runtime-context review and pack.
SeedVR2 remains a recorded temporal experiment, not the selected full-game method.

Opaque backgrounds: original source only -> `gemini-nano-banana-2.1`
preservation candidate -> rejection checks and visual review -> frozen candidate.
Do not attach photos or use the detailed text-material variant for this policy.
Older reference-guided experiments remain historical evidence, not current defaults.

The [Gemini handoff](gemini/README.md) is the canonical execution/safety guide.
Build its single local manual review with
`python3 tools/upscaling/gemini/all-review.py`, then open
`private-assets/upscaling/gemini-review-all/review.html`. This includes historical
versions and a separate paired-experiment section without new generation.
The confirmed core has 150 unique original RGB backgrounds, 153 independent
final versions and two archival unknown attempts; additional historical
comparison candidates are cataloged separately. Per-run pages below remain
audit snapshots, not additional required manual review passes.

Foreground layers: coarse native source mask as identity/topology prior + matching
exact-canvas HD-background RGB crop -> image-guided binary segmentation of the
restored object boundary -> one-HD-pixel edge coverage for rendering. Background
correspondence must remain explicit; contour inference does not establish binding.

Standalone static props: restored opaque RGB with surrounding-image evidence
-> source-constrained image-guided contour -> candidate RGBA and composites.
Alpha-aware Lanczos/source-nearest remains an explicitly selected diagnostic only.
The offline runner performs no new neural
inference. Roles can overlap; opacity, scene/state, palette and binding context
determine the processing path, not a resource filename alone.

Static `mask_method='image-guided'` is the implemented experimental default: a smooth
source prior plus genuine restored-RGB edge inference in a narrow trust band,
not just smoothing the old pixel staircase. Nearest-4x is diagnostic only; exact
NN equality cannot establish final contour quality. The proposed band is three
native pixels, subject to review rather than universal tuning. Low-contrast image
support requires review; topology mismatch blocks acceptance. No automatic approval.
This correction does not change SeedVR2/animation mask policy.

The contour pilot consumes frozen Scene1002-v3 sources and the selected Nano
background, comparing original NN, geometry-smoothed and image-guided contours
at identical world placement/padding with outlines and zooms. Its private
report root is `private-assets/upscaling/static-layers/scene1002-guided-v1`
(immutable runs use a content-hash suffix; `latest.json` identifies the current run).
Six real layers were processed: five direct RGB-supported candidates and a ladder
candidate requiring explicit overlap/connectivity review. None is runtime-approved.

The [static branch](static/README.md#indexed-bulk-processing) now provides an
indexed bulk runner, `python3 tools/upscaling/static/bulk.py --execute`. It scans
source-backed static uses, verifies prepared and directly resolvable contexts,
processes every eligible binding and records all blocked uses. Its private SQLite
and JSONL indexes retain frame, palette, canvas, placement, state, source evidence,
RGB donor, contour artifacts and attempt history. Background coverage and static
binding coverage are reported separately; neither successful processing nor a raw
bitmap count proves whole-game semantic closure or runtime acceptance.

These static outputs are offline candidates, not runtime promotions. Source
640x480 scenes require exact 2560x1920 backgrounds for 4x extraction. A Nano
2400x1792 image requires an explicitly recorded resample; it is not native 4x.
The core must not hide a crop or automatically resize mismatched inputs.

The shared [manifest contract](configs/manifest.md) keeps source frame order,
placement, durations and processing provenance outside the model. Reuse the
existing [asset readers](../assets) and [runtime pack validator](../../web/prototype/replacement-pack.js)
rather than inventing another BLB parser or delivery format.

## Authorized Coverage Page Pass (2026-10-21)

The user explicitly authorized every original on the supplied coverage page at
11:23 UTC, including text walls and the full native640x500 source. All **39/39
requests succeeded**, with no automatic retries or unknown outcomes. Open:

`private-assets/upscaling/gemini-experiments/opaque-coverage-v1/review.html`

It includes all39original/result pairs, local decisions/notes/export and a link
to the prior112-state review. The old authorization page, images and decisions
remain unchanged. The page has38wall originals, not37; one is also present under
a priorScene2247alias. Its old candidate is retained; the new request explicitly
preserves existing inscriptions rather than carrying the old no-text wording.

Thirty-eight native outputs are2400x1792. The complete640x500 Scene1402 source
was submitted unmodified with aspectRatio intentionally omitted; its native
result is2336x1824 and is retained without cropping, padding or stretching.
All39finals decode, match their saved hashes and are opaque. Text-column crops
and contrast/layout diagnostics are not OCR or proof of letter accuracy.
Inscriptions and fine geometry still require manual inspection.

Returned usage:55,363input,66,216candidate and23,345thought tokens,144,924total.
Catalog-price estimate:$2.228952, not verified billing. No paid judge or confirmed
cache hit. Generation is stopped for human review.

```sh
# Offline source/authorization replay and fixed-manifest verification:
python3 tools/upscaling/gemini/coverage-sources.py
node tools/upscaling/gemini/coverage.mjs
# Completed authorized execution; a rerun reuses existing records:
node tools/upscaling/gemini/coverage.mjs --execute
# Offline checks and manual page (existing snapshots require explicit --overwrite):
python3 tools/upscaling/gemini/bulk-check.py private-assets/upscaling/gemini-experiments/opaque-coverage-v1
python3 tools/upscaling/gemini/manual-review.py private-assets/upscaling/gemini-experiments/opaque-coverage-v1
node tools/upscaling/gemini/check-manual-review.mjs private-assets/upscaling/gemini-experiments/opaque-coverage-v1 --generic
```

## Authorized Repairs And Palette States (2026-10-21)

At 10:22 UTC the user explicitly authorized new attempts for the two historical
unknowns and both Scene1201 variants with reported color drift, plus missing
scenic originals. This is a new versioned pass, not permission to remove old
request reservations or automatically repeat failures. `repair.mjs` freezes
`private-assets/upscaling/gemini-experiments/opaque-repair-v1/experiment.json`.
The exact four attempts have immutable authorization receipts in the shared
ledger; changing their source, prior request, target room or attempt identity
is rejected. Required corrective jobs must succeed even if an older image exists.

Resolving palette operations and validated static table fields recovered **70
additional unique RGB states** from 56 bitmap IDs. These are not 70 different
rooms. The combined view covers 112 original room/view/state images. The pass
has 74 independent requests (70 additions plus four approved retries), with one
separate paired-lighting request capped at one. Existing candidates, manifests,
raw responses and user review snapshots remain unchanged.

The pass is finished: **74/74 independent requests succeeded**, including all
four approved retries. Every one of the 112 selected original states now has a
saved result. The new manual page contains 114 available old/new image versions
and two preserved archival unknown-attempt rows; those old rows are not missing
current scenes. All independent final images remain opaque native2400x1792.

Open `private-assets/upscaling/gemini-experiments/opaque-repair-v1/review.html`.
Search supports room IDs, resource IDs and `StatueHall`; Scene2810 is explicitly
named. Scene1201 has v1/v2 choices and candidate-to-candidate comparison. Header
counts distinct scenes with results rather than treating archived attempts as
missing scenes. Old decisions can migrate only by explicit import and matching
source+output hashes. Desktop1440x1000 and mobile390x844 checks visited all116
candidate rows, tested version comparison, persistence/export, stale rejection
and old-artifact-only migration; smoke-test decisions were cleared.

For Scene1201-4019A2C4, left-portal hue shift in the inspected cells decreased
from about9.88-11.29degrees to1.41degrees, and local warning cells changed5to0.
This is targeted color improvement, not an overall automated quality verdict.
The other Scene1201 variant had0warningcells before and after, so counts alone
cannot pick a winner. Both versions remain in manual review.

The one paired request returned **one continuous final scene, not two separate
images**. Missing/ambiguous state mapping remains inconclusive; no fallback or
retry occurred. Its saved output is separate in
`private-assets/upscaling/gemini-experiments/paired-lighting-v1/report.html` and
is not silently counted as two restored states or adopted for bulk generation.
The combined worker's nonzero exit reflects that protocol mismatch, not failure
of the74independent requests.

`repair-summary.json` consolidates factual outcomes, color analysis, browser
checks and usage. Returned usage estimates at catalog rates are $4.295391 for
the74independent calls and $0.065484 for the paired experiment ($4.360875 total).
These are not verified invoice charges; historical reused usage is not new
spend. No positive cache counters or savings were confirmed. No new paid judge
was used. Generation is stopped for human review.

```sh
# Offline verification/preparation; no inference:
node tools/upscaling/gemini/repair-sources.mjs --freeze
node tools/upscaling/gemini/repair.mjs
node tools/upscaling/gemini/paired-lighting.mjs
# Authorized one-time execution / guarded resume:
node tools/upscaling/gemini/repair.mjs --execute
node tools/upscaling/gemini/paired-lighting.mjs --execute
# Offline views after responses are saved:
python3 tools/upscaling/gemini/coverage-review.py private-assets/upscaling/gemini-experiments/opaque-repair-v1
python3 tools/upscaling/gemini/bulk-check.py private-assets/upscaling/gemini-experiments/opaque-repair-v1
python3 tools/upscaling/gemini/manual-review.py private-assets/upscaling/gemini-experiments/opaque-repair-v1
```

Existing review snapshots are not overwritten by default. A deliberate rebuild
requires `--overwrite`; existing browser decisions still bind to exact image
identities. The reproducible browser check and final summary commands are:

```sh
node tools/upscaling/gemini/check-manual-review.mjs private-assets/upscaling/gemini-experiments/opaque-repair-v1
node tools/upscaling/gemini/repair-summary.mjs private-assets/upscaling/gemini-experiments/opaque-repair-v1
```

Additional originals use unchanged preservation. Scene1201 retries append a
short, frozen instruction to preserve each surface's hue/saturation/brightness;
both original embedded palettes were independently verified correct. Its two
originals differ in bridge geometry, not only lighting. The genuine same-view
lighting pilot uses Scene2803 on/off originals, demands two independent image
parts with adjacent STATE_A/STATE_B markers and forbids a collage. A missing,
combined, unlabelled or ambiguous return is inconclusive, never silently split,
mapped or regenerated. Protocol validity is not a visual-quality approval.

The statue hall is Scene2810, already in the earlier run, displayed as
`StatueHall` in the unified manual review. HallOfRecordsScene is a different
text-wall corridor family, excluded from the earlier no-text scope. The later
coverage pass processed all 38 wall originals shown on its authorization page;
one overlaps a prior Scene2247 alias. The earlier 37-original estimate was not
the final page count. Historical exclusions remain in `coverage-review.html`.
The native640x500 Scene1402 original is retained uncropped; two runtime-blackfill
endpoints are not synthesized as supposed original-palette sources.

Diagnostics now separate image validity/availability, provenance completeness
and localized color warnings. Legacy missing raw metadata no longer labels a
good saved PNG as failed. Low edge agreement is diagnostic only. Source-defined
8x6 lowpass HSV patches can identify local red-to-orange/chroma shifts without
ranking by global pixel error; warnings are nonblocking and no warning is not
approval. No new paid judge is used for this pass.

The new manual page keeps each old/new candidate as a separately reviewable
version. Decisions are bound to source+output hashes; explicitly imported old
decisions migrate only to matching artifacts, never automatically approve a
new version. Old review pages and browser storage are not overwritten.

## Authorized Opaque Background Run (2026-10-21)

The user separately authorized all verified scenic backgrounds at 09:02 UTC,
superseding the pilot-only stop gate below. The fixed bulk run is
`private-assets/upscaling/gemini-experiments/opaque-all-v1/`. Its immutable
manifest covers 42 unique originals: 30 new jobs and 12 historical submissions
reused or blocked without regeneration, including both unknown pilot outcomes.
Coverage is 80/80 module `setBackground` sites and 114 total binding sites;
129 expanded binding dispositions include 42 eligible, 82 excluded and five
unresolved. These are binding counts, not 129 distinct scenic backgrounds.
Full originals, aliases, palette/archive/decoding evidence, exclusions and
unresolved dynamic bindings are in the private source registry.

The queue finished with **30/30 new successful responses**, no new unknowns and
no paid retries. There are **40 saved final RGB opaque 2400x1792 PNGs** including
ten historical results. Scene2101/Scene2201 retain unknown prior outcomes, so
the queue's nonzero exit does not mean the thirty new generations failed.
Deterministic checks found one new edge-diagnostic review flag (Module1000),
plus two historical missing-raw-provenance blocks and the two prior unknowns.
The one additional flagged-case Argon response was HTTP200/STOP but invalid
JSON, not a successful structural assessment; it was not retried. Failure
analysis and original artifacts remain available without automatic approval.

For human review, open the separate private **`review.html`** in the bulk run
directory. It presents originals/results with A/B and side-by-side inspection,
notes and per-image accept/return/defer decisions. Decisions are browser-local;
export the review JSON to preserve/share them. Import validates the manifest
and exact image hashes so stale approvals cannot silently carry over. The page
does not upload images, invoke a model, change runtime assets or automatically
act on a return-to-processing decision. `report.html` is the separate technical
diagnostic report, not the primary manual-review interface.

Rebuild the manual page offline with
`python3 tools/upscaling/gemini/manual-review.py private-assets/upscaling/gemini-experiments/opaque-all-v1`.
Its eight tests are in `test/gemini-manual-review.test.py`; desktop/mobile
browser checks covered all 42 scenes, decisions/notes reload persistence,
export and rejection of stale imported decisions. The generated page embeds its
private review data, so opening it does not require a local HTTP server.

The thirty new responses used 40,140 input, 50,528 candidate and 25,636 thought
tokens (116,304 total). Catalog-price estimate is $1.76544 for generation plus
$0.133176 for the one flagged-case judge request. These are not verified billing
charges; historical reuse is not counted as new spend. No returned counters
confirmed an implicit-cache hit.

```sh
# Offline source verification and fixed-manifest preparation; no inference:
node tools/upscaling/gemini/prepare-opaque-sources.mjs --all
node tools/upscaling/gemini/bulk.mjs
# Authorized paid execution or safe resume, one runner only:
node tools/upscaling/gemini/bulk.mjs --execute
# Offline report and checks, including historical reuse:
python3 tools/upscaling/gemini/bulk-check.py private-assets/upscaling/gemini-experiments/opaque-all-v1
```

Execution retains the exact selected 2K request, one original per job and
concurrency two; it is not official batch. All generation entry points claim
the shared request-hash ledger before fetch. An exclusive run lock prevents
concurrent owners, atomic/fsynced raw responses permit local-only recovery,
and existing failed/unknown submissions never trigger automatic paid retries.
Run only one worker or stale-lock recovery at a time. Queue traversal can finish
while `complete` remains false because historical unknowns remain unresolved;
the CLI reports nonzero status rather than claiming all images succeeded.

`bulk-check.json` and local `report.html` separate hard technical failures,
heuristic review flags and technically valid but structurally unverified outputs.
Hash/decode/MIME/opacity/size/finish and request checks are deterministic;
color/edge/alignment diagnostics are review triggers, never hallucination
clearance or pixel-error ranking. Failed/flagged cases have full pairs and
explicitly non-semantic fixed-grid diagnostic crops for subsequent analysis.
This run does not apply the old room ROI profiles to new backgrounds and does
not automatically send every image to a paid judge. Native results stay private
and unchanged; no runtime pack, alpha, mask, character or animation is modified.

## Opaque Background Pilot (2026-10-21)

Local review page:
`private-assets/upscaling/gemini-experiments/opaque-pilot-v1/report.html`.
It includes all ten originals, eight native candidates, unknown-result
placeholders, existing Scene1001/Scene1002 controls, A/B and side-by-side views,
paired object crops, structural evidence and separate subjective appearance notes.
`pilot-summary.json`, `verification.json` and `reconciliation.json` in that
directory contain measured usage, image/browser checks and recovery evidence.

Exactly ten generation requests were submitted: eight saved successes and two
unknown outcomes (Scene2101/Scene2201), never resent. Eight objects-v2 judge
requests produced seven successful assessments and one timeout (Scene1308).
Decisions: zero reject, zero review, three blocked and seven
`no-structural-change-detected`, which is **not approval**. No runtime promotion.

Offline preparation/report reproduction, with no inference:

```sh
node tools/upscaling/gemini/prepare-opaque-sources.mjs
node tools/upscaling/gemini/experiment.mjs --opaque-pilot
python3 tools/upscaling/gemini/evaluate.py private-assets/upscaling/gemini-experiments/opaque-pilot-v1
node tools/upscaling/gemini/pilot-summary.mjs private-assets/upscaling/gemini-experiments/opaque-pilot-v1
python3 tools/upscaling/gemini/evaluate.py private-assets/upscaling/gemini-experiments/opaque-pilot-v1
```

Preparation verifies original archive ranges/hashes, existing decoding,
embedded palettes, byte-identical opaque PNGs and engine background/palette
bindings. Source inventories and 51 ROIs were frozen before candidates. The
fixed ten-job manifest refuses changed inputs/settings and extra jobs. Requests
use the exact preservation prompt, one source PNG, ADC, Vertex global, the
selected Nano model and TEXT+IMAGE/4:3/2K settings. Native 2400x1792 RGB outputs
are retained unchanged, not converted into exact 2560x1920 runtime replacements.

The historical execution command was
`node tools/upscaling/gemini/experiment.mjs --opaque-pilot --execute`.
Exclusive fsynced pre-send records suppress concurrent duplicates and all
completed/failed/unknown resubmissions. Synchronous generateContent has no
long-running operation handle for recovering a disconnected response. Preserve
unknown records and investigate provider evidence; never delete locks and retry
blindly. Raw responses and every image part stay private; evaluation excludes
thought images. Judge requests have separate durable records and usage.

Official selected-model batch supports image input/output but only 1K output,
so this 2K pilot used an ordinary concurrency-two queue, **not official batch**.
Live metadata/countTokens, empty batch validation, explicit-cache rejection and
official documentation are archived in
`private-assets/upscaling/gemini-capabilities/`. No explicit cache was created.
Implicit caching is documented but no returned counters confirmed a hit; its
exact selected-model minimum is not published explicitly. No padding, added
references, measured savings or confirmed billing cost is claimed. Usage totals
exclude unknown responses, which may still incur charges.

Offline tests: `node --test test/gemini-experiment.test.mjs
test/gemini-opaque-pilot.test.mjs`, `python3 test/gemini-eval.test.py`, and
`python3 test/gemini-comparison.test.py`. The local browser/image check is
`node tools/upscaling/gemini/check-pilot.mjs
private-assets/upscaling/gemini-experiments/opaque-pilot-v1`; set
`PLAYWRIGHT_MODULE` to an installed module if normal resolution fails, and use
`CHROME_BIN` to override the default Chrome executable. Screenshots remain inside
the private pilot directory.

**Stopped for visual review. Further generation requires separate user
authorization regardless of evaluator results.**

## What Belongs In Git

- Code, prompts, configuration, hashes, model download pointers and synthetic tests.
- Small sanitized experiment summaries, including failed runs.
- The explicitly selected [backstage photographs](references/backstage/README.md),
  with provenance limitations recorded separately from the software license.

Keep original games, extracted frames, model weights, caches, generated images,
videos, raw API responses and credentials outside this tree. Use the ignored
`private-assets/upscaling/` workspace, or an explicitly configured external path.
The current operator-selected lossless release is served through the existing
S3/CloudFront `releases/hd-demo/full-game-lossless-v1/` prefix, not through Git or
the static frontend. It has 134 room/state ZIPs and all seven original BLBs,
including original cutscene/navigation videos while video upscaling is unfinished.
R2 and the `nonvideo-zip-v2` bundle are legacy delivery, not the current source
configuration. Publishing assets does not itself deploy a changed Vercel frontend.
Operator selection/publication is not a statement of rights clearance. See
[current deployment](../../docs/DEPLOYMENT.md#current-hd-prototype-release).

## Reproducibility And Acceptance

Pin model artifacts, runner revisions, dependencies, seed, input hashes and all
settings. Do not silently replace an approved output with a new generation.
Fixed seeds do not guarantee identical results across GPUs or software versions.

Deterministic checks can establish formal invariants, not that a generative model
invented no details. See [mask checks](masks/README.md),
[static-image acceptance](gemini/README.md) and [benchmark limitations](benchmarks/README.md).
Inspect a small number of synchronized clips or static candidates before approval.

## Consolidation And Remaining Integration

1. The SeedVR2 probe tools have been consolidated under `realesrnet/experiments/` with configurable paths and tests.
2. Isolate the observed temporal ghosting before approving either AWS model for assets.
3. Review static image-guided contours against diagnostic NN and geometry-smoothed baselines, separately from animation policy.
4. Review the [offline static pilot](static/README.md) under the source-only background policy without changing historical prompts.
5. The current selected outputs already feed one original-to-HD table and the existing room-pack builder. Integrate additional reviewed outputs and unresolved runtime contexts without treating that as absence of the current release.

Tests and website builds do not implicitly start cloud resources, model downloads
or paid inference. Explicit AWS deployment/probe commands do incur costs.
