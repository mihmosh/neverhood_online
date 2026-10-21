# Animation Upscaling Branch

Canonical source folder for this branch of the unified Neverhood HD repository.
Code, documentation and handoff notes are in English. Cursor and background
implementations belong to separate branches and are not modified here.

Start with [HANDOFF.md](HANDOFF.md) for the orchestrator review and integration
boundaries. [BRANCH_SCOPE.json](BRANCH_SCOPE.json) is a review inventory, not an
automatic staging or deployment instruction.

## Layout

| Directory | Contents |
| --- | --- |
| [batch](batch/README.md) | Completed full-game RealESRNet batch, local catalog, worker, integrity gates and tests |
| [aws](aws/README.md) | Isolated EC2/S3/CloudFront IaC, SSM operations and bounded GPU probes |
| [benchmarks](benchmarks/README.md) | Frame preparation, input diagnostics, synchronized comparisons and private viewer |
| [configs](configs/README.md) | Sanitized historical settings, with no credentials or input media |
| [experiments/seedvr2](experiments/seedvr2/README.md) | Temporal-restoration research and its limitations |
| [experiments/replicate](experiments/replicate/README.md) | Historical API probe/preparation/analysis tools with explicit private paths |

The selected production-candidate method is **RealESRNet_x4plus**. SeedVR2 remains
an experiment; it is not silently substituted into the full-game batch.

## Verified Result

The 2026-10-21 batch completed 4458 unique lossless RGBA PNGs, mapped locally to
all 6813 physical type-4 animation frames in 287 payloads. Duplicate references
were retained without repeated inference. The outputs total 413927203 bytes,
with native 4x dimensions and original nearest-neighbor binary alpha (0/255).

All output object metadata were reconciled, 22 downloaded PNG bodies passed
independent integrity/geometry/alpha checks, and a pilot matched verified cached
CPU RGB within 1/255. The full invocation took 617.06 seconds; the lab VM stopped
after successful completion. These measurements do not establish all-game runtime
palette, replacement or shadow-context closure.

## Shared Repository Dependencies

- [tools/assets](../../assets): existing extraction and format readers; no duplicate game parser.
- [Common manifest design](../configs/manifest.md): cross-pipeline provenance contract.
- [Binary-mask policy](../masks/README.md): shared constraints, not a new mask-refinement implementation.
- [Photographic references](../references/README.md): deliberately selected shared material.
- The repository's corresponding-source packaging and private-asset audit.

Shared files remain canonical outside this folder so the orchestrator can combine
the animation, cursor and static-image branches without divergent copies.

## Private Data And Secrets

Game files, extracted frames, model weights, generated media, catalogs and
credentials are not part of this source folder. The local batch workspace is
`private-assets/upscaling/full-game-v1/`; earlier probe media remain in the
external private upscaling workspace until deliberately migrated.

Original installed files and result PNGs are private in S3. Catalogs, SQLite,
global manifests and raw logs are not uploaded for the full-game batch.
Secrets come only from local environment/credential mechanisms. On EC2 the
worker uses its restricted instance role, not operator credentials.

## Safety

No normal import, unit test or website build launches inference, downloads models
or creates cloud resources. Paid operations require explicit operator commands.
No commit/push, online-demo asset replacement or Vercel environment change is
performed by organizing this branch. Read each runner's instructions before
restarting a stopped instance or re-arming a compute window.
