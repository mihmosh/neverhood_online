# Development

## Pipeline

`scripts/common.py` defines paths relative to this subproject, not a user's home
directory. Render and packaging outputs must be strict children of
`tools/hd-cursor/outputs/` or the enclosing Neverhood workspace's existing
`private-assets/`. Roots and paths that resolve outside them are rejected.
This restriction is intentional: media should not land in public source or
the website's assets directory. Inputs may be outside the repository.

`scripts/build_cursors.py` runs inside Blender:

1. Parse flags after Blender's `--` delimiter and validate required private inputs.
2. Open the checkpoint without script auto-execution and retain its camera, lights, world and material.
3. Create one scene per row. For row 4, copy the checkpoint mesh and master PNGs.
4. For other rows, generate circular-section solids from the recipe, join and voxel-remesh them, then smooth the fused joint.
5. Add shape keys to one shared mesh. Apply a smooth free-tail displacement with a fixed head/junction area.
6. Check non-manifold edges and positive mesh volume, then render the three poses.
7. Remove unused scenes, set constant keyframe interpolation and save a new pack `.blend` plus `build.json`.

The input `.blend` is never saved over. Checkpoint and output directories must
not overlap. The builder opens a new background process in the documented
command; do not run it against an unsaved interactive editing session.

`scripts/package_cursors.py` runs under host Python:

1. Load the build report and 21 master images.
2. Extract alpha, make alpha-aware 128px sprites and reject empty/edge-touching half-alpha silhouettes.
3. Assemble the atlas, static contact sheet and animated WebP previews.
4. Write the extended manifest, including a notice that media rights were not evaluated.
5. Hash known deliverables and ZIP only the explicit deliverable list.

Stages overwrite generated files in their selected output directory. They are
not transactional: an interrupted or failed render can leave partial output,
and a previous ZIP is not evidence the current build completed. Re-run the
failed stage and the integration suite before using a pack. The ZIP is not
byte-reproducible because its entry timestamps are not normalized.

## Tests

Host dependencies are listed in `requirements.txt`. Public tests run with:

```sh
python3 -W error -m unittest discover -s tools/hd-cursor/tests -p 'test_*.py' -v
```

`test_tools.py` always runs and uses temporary synthetic colored-disk fixtures
under ignored `outputs/`. It tests directory boundaries, symlink escapes,
packaging, atlas dimensions, the media-rights notice and exclusion of unrelated
files from ZIP/checksums. Its placeholder `.blend` is explicitly not a geometry
fixture; these tests do not need Blender or game assets.

`test_pack.py` is an optional seven-check integration suite. It uses
`HD_CURSOR_PACK_DIR`, defaulting to `outputs/hd-cursor`, and skips the suite if
there is no `cursor.json`. The pointer-preservation check also needs
`HD_CURSOR_CHECKPOINT_DIR`, defaulting to `outputs/checkpoint`. Other pack tests
remain runnable without the checkpoint.

These tests are separate from the parent project's `npm test` command. Run the
Python commands explicitly. Unit-test fixtures are not the original game
artwork and must not be replaced with research renders for convenience.

## Blender-Side Inspection

Open the saved file and inspect every scene at frames 1, 2, 3. Each should have
one mesh, the expected camera and lighting, a 32-unit orthographic view and the
correct logical hotspot scene property. Check that the head stays anchored,
the joint is stable and the tail does not clip or detach.

For a basic independent saved-file structure check:

```sh
blender --background --disable-autoexec \
  tools/hd-cursor/outputs/hd-cursor/hd-cursor.blend \
  --python-expr 'import bpy; assert len(bpy.data.scenes) == 7; assert all(len([o for o in s.objects if o.type == "MESH"]) == 1 and s.camera.data.ortho_scale == 32 for s in bpy.data.scenes); print("Scene structure checked")'
```

This checks structure, not artistic fidelity, mesh connectivity, rights or live
runtime behavior. Before integrating a pack, test all row/pose combinations,
hotspots, viewport clipping, scale changes, palette transitions, hidden cursors
and native fallback in the actual consumer. No automated image metric replaces
that review.

## Dependencies And Reproducibility

The observed build environment is Blender 5.0.1 with CPU Cycles and host Python
3.12/Pillow 12.1.1. Blender supplies NumPy. Earlier research used Blender 4.0.2;
the current code handles both legacy action curves and newer layered actions,
but this is not a claim that every Blender release has been tested.

No MCP, cloud API, browser, Node dependency or neural image model is involved
in cursor generation. No installation step downloads a checkpoint. Input scene
names are read from metadata; they are not assumed to match the historical
research object names.

Use the input hashes, Blender version and output checksums to identify a build.
Do not promise bit-identical renders across versions, hardware or changed
inputs. The revision label identifies the modeling family, not a proof of
identical bytes.

## Source Publication

See [Rights](RIGHTS.md) first. Do not put game-specific recipe coordinates back
into Python defaults, public examples or tests. Keep generic algorithms public
and unresolved artwork-bearing inputs private.

The parent `scripts/package-sources.mjs` includes this subproject's source/docs
and excludes its `outputs/`, environments and caches. Changing source here does
not automatically rebuild or publish the website's existing source downloads.
Rebuild those downloads only as part of the deliberate parent release process;
do not hand-edit their manifests or inventory.
