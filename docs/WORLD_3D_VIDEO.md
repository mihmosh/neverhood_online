# Task 2: World Reconstruction And HD Video

Task split recorded on 2026-10-18. This task is independent of
[HD backgrounds and sprites](ROOM_HD_RESTORATION.md). The working research project
was `../../neverhood-upscaling/`; those research artifacts remain private under `data/`.
This dated task split is historical. Current cutscene/navigation upscaling is
still in progress. Gameplay uses the original Smacker resources retained in all
seven S3-backed BLBs, not incomplete video experiments. Their byte-exact HTTPS
delivery has been verified; see [the current release](DEPLOYMENT.md#current-hd-prototype-release).

## Goal And Boundary

Recover evidence-supported models of locations and camera motion, then test
whether geometry can help produce faithful high-quality navigation movies and
cinematics. A world model and an improved video are distinct deliverables with
separate acceptance tests; success in either does not prove success in the other.

Do not assume all footage is a scan of one static set. A connected, editable world
requires location association, coordinate alignment, state handling and manual
completion where observations are missing. A freely explorable playable remake,
rigged characters and new gameplay are not initial deliverables.

## Established Starting Point

- Inventory: 551 logical video resources / 550 unique streams. Most are 320x240;
  other dimensions and original rational FPS must be preserved individually.
- Two provisional groups, mushroom-approach and courtyard-approach, represent
  different scenes. The remaining 548 streams are unassigned.
- Each prepared shot has FFV1/MKV, an MP4 preview, 25 native PNGs and provenance.
  Lossless-video pixels and selected PNGs were verified against original decoding.
- CPU geometry on the mushroom approach found 45 screened depth points; a local
  three-view test predicted 12/12 held-out middle observations within 2 px
  (median 0.292 px). Courtyard: 44 screened points, 12/12 within 2 px, median 0.245 px.
- These are small exploratory tests with assumed calibration, not dense geometry,
  a complete camera trajectory, corpus-wide success rates or cross-shot registration.
- Turning controls showed degeneracy, calibration sensitivity and lost overlap.
  Many matches and positive triangulated depth are not sufficient evidence.
- No Omega inference, geometry-guided HD video or restored video benchmark is
  established. The inspected Omega GLB is a colored point cloud with camera markers,
  not a textured mesh, upscaler, render-ready scene or complete world.

Primary evidence lives in `../../neverhood-upscaling/evidence/interpretation.json`,
`../../neverhood-upscaling/evidence/hd-fork-probe.json`, and
`../../neverhood-upscaling/OMEGA_SPACE.md`. These record prior work, not new runs.

## Workstream A: Geometry

1. Keep native-resolution inputs immutable. Do not add generative detail or
   interpolate frames before measuring geometry.
2. Start only with mushroom clip `020c1001`, the prepared 25 PNGs spanning source
   frames 0-26. Verify hashes and chronological zero-padded basenames.
3. Recheck the live Omega interface, revision and license. Request explicit approval
   before uploading game-derived imagery. The inspected app retains working
   directories; Clear resets the interface but does not delete those directories.
4. After approval, use images only, confidence 50, cameras visible, point cap
   1000 K, and sky/black/white filters off unless a documented interface change
   requires adjustment. Record exact inputs, settings, revision, time and errors;
   download the available artifact privately.
5. Check forward camera motion/order, overlapping surfaces, noncollapsed depth,
   duplicated structures and distortion. Compare with CPU geometry where possible.
   If only GLB is available, distinguish visual review from numerical camera/depth
   validation; do not claim access to unexported predictions.
6. On failure or inconclusive export, investigate overlap/calibration and a sparse
   SfM baseline before adding more rooms. On a pass, add only demonstrably
   overlapping same-location footage and test held-out views.
7. Organize further footage using contact sheets and engine navigation/resource
   tables. Record evidence/confidence, camera direction, world state, actors,
   transitions and cinematic/non-gameplay status. Keep uncertain footage unassigned;
   neighboring hashes are not location evidence.

Later choose depth layers, a mesh, splats or another representation based on
held-out-view quality and editability. Keep observed, inferred and manually authored
surfaces distinguishable. Do not fill missing world structure and label it measured.

## Workstream B: HD Video

1. Select a short approved shot with known source timing and static-region masks
   where needed. Evaluate the mushroom geometry shot first if suitable.
2. Establish ordinary resampling and a temporally consistent direct-video
   restoration baseline. This may proceed without successful 3D recovery.
3. If geometry passes, compare a geometry-guided restoration/rendering candidate
   on the same shot against the direct baseline, not just against the original.
4. Review static surfaces, moving actors, disocclusions, camera motion, illumination,
   clay texture and puzzle-critical marks. Separate hallucinated detail from
   evidence-supported reconstruction. Evaluate an entire sequence at original speed.
5. Preserve exact frame counts, rational FPS, timestamps, aspect ratio and gameplay
   event alignment. No interpolation in the initial benchmark. The prepared research
   videos omit audio; retain originals and restore original audio/timing for any
   proposed delivery, rather than treating silent previews as complete replacements.
6. Record settings, hashes, licenses, elapsed time, peak VRAM/RAM, errors and review.
   Improve geometry/video fidelity before expanding to other shots.

## Acceptance And Deliverables

Geometry pilot: report pass, fail or inconclusive with camera/surface evidence,
export limitations, and held-out reprojection or view tests where data permit.
A plausible screenshot alone is not a pass.

Video pilot: require stable motion and detail, preserved identity/material/timing,
no severe ghosting or new structural defects, and a reviewed improvement over the
baseline. A geometry-guided method is adopted only if it adds measurable or
consistently reviewed value; direct restoration remains a valid separate outcome.

Initial deliverables are one private reconstruction experiment and one short video
comparison, not a world-wide mesh or whole-game movie pack. Longer-term deliverables
can be separately reviewed location models, a documented world association graph,
and verified high-quality video replacements.

Video integration is another gate. The audited HD fork failed an unchanged Linux
build at `itoa`; its isolated Theora decoder decoded three frames but reported
zero frame count and no seek/rewind. A valid OGV transcode does not establish
replacement compatibility with gameplay. Verify decoder/event contracts before
introducing any restored movie into the game.

## Permissions And Unknowns

Keep media, point clouds, models and restored outputs private under `data/` in the
research project. Do not publish, deploy or modify original assets/engine sources.
No transfer, credential use, gate acceptance, model run or paid resource is
authorized by this document. Heavy neural inference is not for the local 4 GiB GPU;
RTX3090/L4 work requires separate authorization.

Omega's inspected FAIR license restricts outputs/results to noncommercial research.
Recheck code, checkpoints and output terms separately; technical success does not
clear distribution rights to game-derived assets.

Unknowns remain calibration, dense depth, complete trajectories, cross-shot scale
and alignment, state consistency, unseen surfaces, representation choice, temporal
restoration quality and whether geometry offers a useful advantage over direct video.
