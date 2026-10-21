# Research History And Migration

## Preserved Pointer

The precursor study modeled the normal diagonal pointer, cursor row 4, as a
rounded volumetric cone fused to a tapered stem. The preserved checkpoint is
known as `tail-swing-v4`; its historical folder was named `fitted-v2` despite
the newer revision. It used one connected mesh with shared topology, three
poses and a fixed joint rather than separately fitted meshes per frame.

The pointer's source resource identity was `6520a400`, with the first-room
palette `4086520e`. These identifiers describe provenance and engine binding;
they do not establish artwork rights. The local scene's metadata identifies
the actual material/object names, which may have numeric suffixes.

The original study produced 1024px masters and true 16-bit Blender alpha
passes, plus 128px sprites. The later packager's extracted alpha files have a
different contract: 8-bit Pillow alpha. See [Format](FORMAT.md).

Earlier independent-pose fitting experiments were rejected for unstable
attachments. They are not part of this subproject's supported pipeline. Neither
the old optimizer nor its reference images, machine-specific MCP setup or raw
research logs are required by this renderer.

## Seven-Gesture Pack, 2026-10-21

The first full local pack extended the pointer to seven standard gesture rows,
three poses each. Its revision label is `clay-seven-gestures-v1`. The pointer
master PNGs were copied verbatim from the preserved checkpoint. The other six
forms were authored as round solids using the checkpoint's material, world,
lights and camera. Their motion is an authored fixed-head tail swing, not a
claim of exact original frame reconstruction.

The build used Blender 5.0.1, CPU Cycles, 128 samples, four threads, seed 17 and
no denoising. It produced seven scenes, 21 masters and a 384x896 atlas. The
recorded build checks reported positive volume and no non-manifold edges for
each model. Seven artifact integration checks passed for the original pack.
Those results do not prove legal clearance or whole-game runtime coverage.

The current full pack was saved under the enclosing workspace's
`private-assets/hd-cursor/`, with `private-assets/hd-cursor.zip` beside it.
Its files remain private and were not copied into documentation or public
source directories.

## Code Extraction

The initial local scripts were:

```text
scripts/build-hd-cursors.py
scripts/package-hd-cursors.py
test/hd-cursor-pack.test.py
```

They now live in `tools/hd-cursor/scripts/` and `tools/hd-cursor/tests/`.
Machine-specific input paths were replaced with flags/environment variables.
The game's modeled shape coordinates were removed from the public builder and
retained in a private JSON recipe under ignored `outputs/inputs/`. The rod
primitive now caps along its axis, so new builds are not promised to match the
pre-migration pack byte for byte. Existing rendered outputs were not changed.

The source project intentionally retains an explicit checkpoint dependency.
Recreating the game-derived pointer from public fitted parameters was not added:
those parameters can themselves encode the unresolved artwork. A clean public
checkout tests the tool on unrelated synthetic fixtures instead.

The software license is separate from all cursor artwork rights. At the user's
request, models, recipes and renders are not represented as cleared for open
distribution. See [Rights](RIGHTS.md) for the publication boundary.

## Runtime Boundary

This extraction does not change `scripts/build-demo-cursor.mjs`, the demo
release exporter or the browser's `web/prototype/demo-cursor.js` loader.
Those are application integration code with their own source matching and
palette gates, not part of the offline tool's pack format. The seven-row pack
is a standalone research deliverable, not evidence that all seven states or
all scene palette variants are enabled in the current HD prototype. The original
two-room deployment was the integration target at extraction time; later
full-game delivery does not by itself establish seven-gesture coverage.
