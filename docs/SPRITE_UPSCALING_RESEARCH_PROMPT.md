# Deep Research Prompt: Faithful Sprite Upscaling

Copy the prompt below into a research-capable system. This requests research and
an experiment recommendation, not uploads, cloud provisioning or model execution.
It supports [Task 1](ROOM_HD_RESTORATION.md), not the world reconstruction task.

---

Research the best currently available models and techniques for faithful upscaling
of low-resolution pre-rendered clay/stop-motion game sprites, specifically The
Neverhood. State the actual research date. Starting date for this request is
2026-10-18: verify current releases from live primary sources instead of relying
on an older memorized ranking. If live research is unavailable, explicitly state
the knowledge cutoff and do not present a current leaderboard.

## Project Context

- This is stylized physical clay photographed/rendered into low-resolution game
  imagery, not conventional hand-drawn pixel art, anime or a modern game texture set.
- The task is offline restoration of backgrounds, foreground layers, objects and
  animated sprites for existing 2D rooms. We are not redesigning art, generating
  new animations, recovering a 3D world or making cinematics in this research.
- There are 8192 decoded indexed frames. Palettes can be scene-dependent; 1081
  frames still need a resolved scene palette. Some source sprites are very small.
- Inputs have resource/frame identities, original dimensions, padded runtime
  rasters, offsets, flips, clipping and exact animation timing. These must survive.
- A prototype can display true 4x replacements on a 2560x1920 canvas without a
  640x480 intermediate. Its resolution path is proven with synthetic detail, not
  with a quality-approved AI pack. The initial target is exactly 4x.
- Alpha may represent binary cutouts or source-specific translucent behavior.
  Palette index zero and black RGB do not universally mean transparency.
- The first benchmark is one first-room background, a complete short lever
  animation, and a reviewed small character/object sequence where available.
  Treat the last sequence as a proposed selection, not an already prepared input.
- The local GPU has 4 GiB VRAM and must not run heavy neural inference. Potential
  separately authorized benchmark targets are an RTX3090 or full L4, each 24 GiB.
- Original and derived game media are private. Do not request or assume upload
  permission, proprietary service access, accepted gated licenses or paid compute.

## Research Questions

1. Which runnable models currently give the best fidelity for these sprites?
   Compare conservative restoration/SR, GAN and transformer methods, modern
   diffusion/image restoration, and sequence-aware or reference-guided approaches.
   Include pixel-art-specific methods only if relevant evidence supports transfer
   to clay imagery. Do not rank all asset classes by one attractive example.
2. Which methods preserve clay fingerprints, asymmetry, silhouettes, faces, hands,
   teeth, small puzzle marks and original lighting without inventing features?
   Separate restoration from generative reinterpretation. Assess the effect of
   degradation mismatch: indexed colors, old compression, soft edges and tiny inputs.
3. How should alpha and edge colors be processed? Compare separate RGB/alpha,
   mask-guided processing, edge extension/background conditioning and other
   justified options. Explain straight versus premultiplied alpha, fringe risks,
   transparent RGB, and testing over both light/dark backgrounds and the real room.
   Distinguish model-native RGBA support from wrapper behavior.
4. How can sprite animations preserve identity and texture across moving poses,
   loops and occlusion? Compare independent frames, aligned sequences, reference
   conditioning and video SR. Discuss motion-estimation failures, cropped/unequal
   canvases, atlas/sprite-sheet boundaries, and artificial texture stabilization.
   Do not erase deliberate stop-motion motion or interpolate frames.
5. Should backgrounds and sprites use different models/settings? How can material,
   lighting, sharpness and detail scale remain consistent when composited?
6. What is reproducibly runnable today? For each finalist verify official code,
   released checkpoint, exact model variant, inference entry point, maintenance,
   dependencies, tiling behavior, determinism and native scale. Distinguish code,
   checkpoint and output licenses, research-only restrictions and gated access.
7. What are measured VRAM, RAM and runtime for representative inputs at 4x on
   RTX3090/L4? Label published measurements, estimates and unknowns separately.
   Do not convert A100 results into asserted 3090/L4 performance. Discuss minimum
   input size, padding and tiled-context effects, not only megapixel throughput.

## Evidence Standard

Use papers, official repositories, model cards, licenses and reproducible independent
comparisons. Give URLs, release/revision dates and access dates. Use community
sprite/restoration experiments as supplementary evidence with their limitations.
Distinguish results on actual comparable sprites from results on natural photos,
anime or synthetic benchmarks. Absence of sprite-specific evidence is a finding.

Do not assume the newest or largest model is best. Separate detail preference,
source fidelity, temporal consistency, alpha correctness and operational readiness.
No single no-reference aesthetic score establishes correctness. With no true HD
reference, do not claim PSNR/SSIM, source downsampling consistency or optical-flow
residual alone proves recovered detail. Explain what each diagnostic can miss.

## Required Output

Answer in Russian; keep model names, commands and technical identifiers unchanged.
Prioritize a practical decision over an encyclopedic report.

1. Give a short dated conclusion and separate recommendations for backgrounds,
   isolated sprites and sprite sequences. State uncertainties explicitly.
2. Provide a comparison table of no more than eight credible candidates: exact
   variant/release, official links, applicable evidence, fidelity/hallucination,
   temporal/alpha handling, scale, license, hardware evidence and main failure mode.
3. Choose at most three runnable pipelines for our first test, plus a documented
   non-generative scaling baseline. Specify preprocessing, alpha policy, settings
   or parameter sweep, sequence handling, output contract and expected risks.
   Mark untested settings as proposed rather than proven optimal.
4. Design a small reproducible benchmark with fixed native inputs, complete
   animations and seeds where meaningful; inspect intended-size and magnified
   composites, loop playback, edge displacement, color drift and temporal artifacts.
   Include blind review and runtime/memory logging. Explain pass/fail/stop criteria
   and how thresholds will be calibrated before comparing candidates.
5. End with the single experiment that most reduces uncertainty, exact missing
   evidence, and what would justify staying with conservative upscaling rather
   than using a generative model. Do not recommend whole-game processing yet.
