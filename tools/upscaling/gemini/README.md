# Gemini Background Handoff

Canonical English handoff for offline opaque-background production and manual
review. Run commands from the repository root. Generation is stopped for human
review; this handoff does not authorize new paid calls or runtime promotion.
Animation, foreground layers and masks have separate pipelines in the
[parent workspace](../README.md).

## One Manual Review

Build the unified local review without generation:

```sh
python3 tools/upscaling/gemini/all-review.py
```

Open `private-assets/upscaling/gemini-review-all/review.html`. This is the single
manual entry point for all saved final background candidates, including older
model/prompt/reference experiments, multiple versions and archival unknown
attempts. The paired-lighting output belongs in a separate experimental section
on that same page, not in two source/result pairs. No model call is needed to
build or use the page. Per-run `review.html` and technical `report.html` files
remain provenance snapshots, not additional required review passes.

Decisions and notes are browser-local; export the review JSON for handoff or
backup. A decision must bind to both source SHA-256 and output SHA-256. Import
old decisions only through explicit migration with matching artifact hashes;
never inherit approval by scene name, row order, filename or a newer version.
Accept/return/defer is a human decision, not an automatic retry or runtime export.

Confirmed core data as of 2026-10-21:

- **150 unique original RGB backgrounds**: 112 main states plus 39 coverage
  sources, with one exact source overlap. These are states/views, not 150 rooms.
- **153 independent final versions**: 114 main old/new versions plus 39 coverage
  versions. Two historical unknown attempts remain visible for audit.
- The main snapshots contain 116 + 39 = 155 rows, including those two unknowns.
  One additional paired experiment returned one continuous final image, not two
  valid outputs; its source-to-state mapping is inconclusive.
- Earlier Pro/reference/text-material and comparison candidates also belong in
  the unified catalog. Use the generated catalog for its actual total, rather
  than treating the core counts above as a grand total of all historical images.

Inspect every version, inscriptions and geometry manually. `StatueHall`
(Scene2810) is distinct from the `HallOfRecordsScene` text-wall family. The
coverage page actually contained 38 wall originals plus the full Scene1402
original; one wall overlaps a prior Scene2247 alias. Do not infer uniqueness from
resource IDs or display labels alone.

## Inputs And Prerequisites

- Node.js 22 with the `node:sqlite` support required by shared asset tooling;
  Python 3 with Pillow and NumPy; the repository's existing asset readers.
- A legally obtained private game archive and the matching extracted source
  blobs, inventories, source selections and frozen run artifacts under
  `private-assets/`. A public source checkout alone cannot reproduce the review.
- For authorized cloud execution only: Google Cloud CLI, Application Default
  Credentials (ADC), Vertex AI access, quota and billing for the approved project.
- Optional browser checks: Playwright, with `PLAYWRIGHT_MODULE` pointing to an
  installed module if normal resolution fails, and `CHROME_BIN` for Chrome when
  its default executable is unavailable.

Keep original game media, generated PNGs, review pages/screenshots, raw requests
and responses, ledgers and credentials private and ignored by Git. Transfer them
only through an authorized private channel; software source licensing does not
grant redistribution rights to game assets or reference photographs. Never add
game images to public web assets or source bundles. Do not print access tokens,
copy ADC files into the workspace, or log Authorization headers.

Existing manifests can contain absolute paths. Historical planners also require
the private request template at
`private-assets/upscaling/gemini-experiments/static-pilot-v1-2096d1751ccd/jobs/Scene1001-gemini-nano-banana-2.1-preservation-none-7cbaffb18ab8/request.json`.
The earliest experiment planner additionally references a sibling
`../neverhood-upscaling/data/` baseline. Those are real portability dependencies,
not public downloads. Preserve original artifacts and hashes; arrange an audited
path relocation/import before execution on another machine. Do not edit frozen
manifests, discard submission history or silently regenerate missing templates.

## Selected Request Policy

Production candidates use **`gemini-nano-banana-2.1`**, Vertex AI REST
`generateContent`, location **`global`**, project **`gen-lang-client-0665493034`**.
The current project is fixed in the runners and request hashes; setting a
different gcloud default project does not redirect those requests. Project or
policy changes require a separately reviewed plan, not in-place manifest edits.
Credentials come from `gcloud auth application-default print-access-token`.
An authorized operator can establish ADC with
`gcloud auth application-default login`; do not run cloud setup merely to review.

Each independent job attaches exactly one original source PNG and no backstage
photos. Preserve composition, palette, lighting, full field of view and gameplay
geometry with restrained source-supported texture. Do not use the historical
detail-heavy material variant as the production default. Text walls explicitly
preserve existing inscriptions without translating, correcting or inventing text.

The frozen settings are `responseModalities: ['TEXT', 'IMAGE']` and
`imageConfig: { aspectRatio: '4:3', imageSize: '2K' }`, except the complete
640x500 Scene1402 source deliberately omits `aspectRatio`. Native results are
**2400x1792**, or **2336x1824** for that source. Keep those files unchanged: 2K
does not mean exact runtime 4x. A 640x480 runtime canvas requires 2560x1920;
any later resample, placement or pack conversion needs explicit provenance and
separate acceptance. Never hide a crop, stretch or padding operation.

Historical `gemini-3-pro-image` comparison outputs remain reviewable but are not
the selected production model. `gemini-4-argon` is a historical paid judge, not
a required reviewer. `gemini-3.8-flash` appears only in connectivity probes.

The saved capability evidence is in
`private-assets/upscaling/gemini-capabilities/`. For the selected model, official
batch evidence limited image output to 1K, so the 2K runs used an ordinary
concurrency-two queue, **not official batch**. Explicit caching was rejected;
no returned positive counters confirmed implicit-cache savings. Do not claim
discounts, fixed billed costs or deterministic reproduction from a fixed seed.

## Safe Operation

Preparation is local and does not authorize execution. The commands below
without `--execute` verify inputs and prepare or validate frozen manifests:

```sh
node tools/upscaling/gemini/prepare-opaque-sources.mjs --all
node tools/upscaling/gemini/bulk.mjs
node tools/upscaling/gemini/repair-sources.mjs --freeze
node tools/upscaling/gemini/repair.mjs
python3 tools/upscaling/gemini/coverage-sources.py
node tools/upscaling/gemini/coverage.mjs
node tools/upscaling/gemini/paired-lighting.mjs
```

These replay historical scopes, not a generic new batch. They require the private
archive, selections, templates and original authorization-page snapshots. Keep
immutable `experiment.json`, attachment/request/output hashes, raw responses,
`result.json`, summaries, review exports and the shared
`private-assets/upscaling/gemini-request-ledger/` together during handoff.

Adding `--execute` to a generation runner or `judge.mjs` can incur charges.
**Do not run it under this handoff.** Prior authorizations covered exact completed
manifests, not additional generations, changed settings or automatic retries.
`probe.mjs` is an important exception: invoking it directly sends billable
synthetic requests without an `--execute` gate. `capabilities.mjs --probe-safe`
contacts cloud services even though it is not an image-generation command.

The canonical generation runners use the shared request-hash ledger and durable
pre-send reservation. An exclusive run lock prevents concurrent owners; atomic,
fsynced raw responses permit local recovery. Run one owner/recovery process at
a time. A failed, timed-out or unknown call is never automatically resent and
may still have incurred a charge. Preserve its reservation and investigate
saved/provider evidence; never delete locks or ledger entries to force a retry.

A genuinely new attempt needs explicit user authorization and a separate audited
receipt binding its attempt ID, source SHA, prior request and target job. The four
historical repair receipts authorize only those exact attempts. Reuse successful
saved artifacts, preserve every version and reject altered manifests. A nonzero
exit can reflect archival unknowns or a paired-output protocol mismatch even
when all new independent requests succeeded; inspect the summary before acting.

Returned token usage supports catalog-price estimates, not verified invoices.
Unknown responses have unknown usage, and cached/reused historical artifacts
are not new spend. No further generation or paid judge is required for review.

## Canonical Modules

| Module | Responsibility |
| --- | --- |
| `experiment.mjs` | Request identity, frozen manifests, durable execution and historical two-room/pilot planners |
| `bulk.mjs` | Shared bounded queue, history reuse and complete/blocked outcomes |
| `bulk-sources.mjs`, `prepare-opaque-sources.mjs` | Original archive/decoder/palette/binding evidence and initial source selection |
| `repair-sources.mjs`, `repair.mjs` | Additional palette/state proofs and the exact authorized versioned repair pass |
| `coverage-sources.py`, `coverage.mjs` | Frozen coverage-page originals, inscription and native-aspect requests |
| `bulk-check.py` | Offline hash/decode/opacity/provenance checks and nonbinding localized diagnostics |
| `all-review.py` | Canonical all-images catalog and unified manual review page |
| `manual-review.py`, `coverage-review.py` | Historical per-run manual and source-coverage snapshots |
| `paired-lighting.mjs` | Historical two-state protocol experiment; one combined final is inconclusive |
| `evaluate.py`, `judge.mjs`, `prepare-flagged-review.mjs` | Historical diagnostics/judging; not automatic approval or required paid execution |
| `comparison.py`, `comparison.html`, `check-comparison.mjs` | Historical model/prompt/reference comparison, not production defaults |
| `pilot-summary.mjs`, `repair-summary.mjs` | Saved outcome/usage summaries |
| `check-manual-review.mjs`, `check-pilot.mjs` | Optional local browser checks of historical pages |
| `capabilities.mjs`, `probe.mjs` | Capability evidence and explicitly billable connectivity experiments respectively |

Do not delete historical tools: other modules and frozen artifacts can depend
on them. The original [prompt](prompts/room-background-original.txt) is immutable
historical evidence. Its literal `image_20.png` is not a repository asset or a
universal source name. Initial model/settings/attachments not supplied with that
prompt must not be invented; later run manifests record their actual mapping.
Selected [backstage references](../references/backstage/README.md) explain older
experiments only. Mentioning a filename in a prompt never attaches the image.

## Offline Checks

```sh
python3 tools/upscaling/gemini/bulk-check.py private-assets/upscaling/gemini-experiments/opaque-coverage-v1
node --test test/gemini-experiment.test.mjs test/gemini-bulk.test.mjs test/gemini-repair.test.mjs test/gemini-coverage.test.mjs
python3 test/gemini-bulk-check.test.py
python3 test/gemini-manual-review.test.py
python3 test/gemini-coverage-sources.test.py
```

`bulk-check.py` writes technical reports in the selected private run and returns
nonzero for invalid or unavailable images. Provenance and visual warnings remain
separate from image validity and do not by themselves change its exit status.
Review snapshots are not overwritten by default; historical `manual-review.py` rebuilds require
explicit `--overwrite` when a snapshot already exists. Browser checks are
optional and use local private pages; keep screenshots private as well.

Hash/decode checks prove formal invariants only. Lowpass HSV/color, edge,
alignment, text-column and contrast diagnostics are review triggers, not OCR
ground truth, semantic proof or a global pixel-error ranking. Exclude thought
images from final candidates, retain all raw parts for audit, and never describe
automated checks as proof of no hallucinated detail. Human approval freezes the
chosen source/output hashes; runtime integration remains a separate operation.
