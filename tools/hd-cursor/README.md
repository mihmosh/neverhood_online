# HD Cursor Tooling

Blender-based tools for building, rendering and packaging animated volumetric
clay cursors. This is a separate, offline asset-development subproject of
[Neverhood Online](../../README.md), not an engine, browser runtime or official
game release.

**The public part is tooling source and documentation, not a freely licensed
cursor artwork pack.** Rights to the game-inspired models, shape recipes and
renders have not been established. Models, recipes and the full research pack
remain outside public sources; selected pointer artwork is externally delivered
by the HD prototype without established redistribution clearance. A new model or
render does not, by itself, resolve rights in the underlying game artwork. Read
[Rights And Publication](docs/RIGHTS.md) before sharing anything.

## Status And Scope

- The tools support seven cursor rows, three poses per row and 32x32 logical cells.
- The local research pack contains 21 sprites, 1024x1024 masters and 128x128 exports.
- Generated meshes are actual closed volumes, not extruded pixel masks.
- Each gesture uses one mesh with shape keys and a fixed-head tail deformation.
- The pointer row is copied from an explicitly supplied Blender checkpoint and its three master images.
- Other gestures are constructed from a private JSON recipe, not embedded artwork parameters in public code.
- The software does not resolve room palettes or bind the pack to every game resource.
- Running this tool does not change the website, deployed demo or engine cursor bindings.

The repository deliberately does **not** contain the required research
checkpoint, game-specific shape recipes, renders, previews or generated ZIP.
A clean checkout can run the public synthetic tests, but cannot reproduce the
research artwork without separately supplied inputs. This is an explicit input
and rights boundary, not a hidden download step.

## Layout

```text
tools/hd-cursor/
  README.md
  LICENSE.md
  requirements.txt
  docs/
    DEVELOPMENT.md       implementation, maintenance and testing
    FORMAT.md            input/output contracts, coordinates and timing
    HISTORY.md           research lineage and migration notes
    RIGHTS.md            publication boundaries and unresolved questions
  scripts/
    common.py            portable defaults and private output policy
    build_cursors.py     Blender geometry, deformation and rendering
    package_cursors.py   Pillow exports, previews, manifest and ZIP
  tests/
    test_tools.py        public tests with synthetic artwork only
    test_pack.py         optional integration tests against a local pack
  outputs/               ignored local inputs, renders and archives
```

All commands below run from the `neverhood` repository root. No Node service,
Blender MCP addon, cloud account or external image-generation API is required.

## Requirements

| Component | Purpose | Verified Version |
| --- | --- | --- |
| Blender | `bpy`, `bmesh`, bundled NumPy, CPU Cycles | 5.0.1 on Linux |
| Python | Packaging and tests, separate from Blender's Python | 3.12 |
| Pillow | PNG/WebP and alpha-aware resizing | 12.1.1 |

Blender must have Cycles and Python enabled. Pillow must support WebP animation.
Install host dependencies in a virtual environment:

```sh
python3 -m venv tools/hd-cursor/.venv
tools/hd-cursor/.venv/bin/python -m pip install -r tools/hd-cursor/requirements.txt
```

Do not install `bpy` from PyPI for these commands. The render script must run
inside Blender. Pillow is only needed by host packaging/tests; host NumPy is
not required.

## Test Without Artwork

```sh
tools/hd-cursor/.venv/bin/python -W error -m unittest discover \
  -s tools/hd-cursor/tests -p 'test_*.py' -v
```

Public tests build temporary colored-disk fixtures, check output boundaries
and exercise packaging. Integration tests skip if the default private pack is
absent. A skipped integration suite is not a validated render build.

## Build With Authorized Local Inputs

Supply these inputs yourself, with permission appropriate to the intended use:

1. A checkpoint directory containing `cursor-fitted.blend`, `scene-metadata.json` and `f0-clay-1024.png` through `f2-clay-1024.png`.
2. A `gestures.json` file describing the other six shapes.

See [Format](docs/FORMAT.md) for their contracts. The checkpoint is treated as
read-only. Do not place input files in the output pack directory. Treat `.blend`
files as trusted local inputs even with auto-execution disabled.

Set paths to your own private files:

```sh
export HD_CURSOR_CHECKPOINT_DIR=/path/to/authorized/private/checkpoint
export HD_CURSOR_GESTURES=/path/to/authorized/private/gestures.json

blender --background --disable-autoexec \
  --python tools/hd-cursor/scripts/build_cursors.py -- \
  --checkpoint "$HD_CURSOR_CHECKPOINT_DIR" \
  --gestures "$HD_CURSOR_GESTURES"

tools/hd-cursor/.venv/bin/python tools/hd-cursor/scripts/package_cursors.py
```

Default output is `tools/hd-cursor/outputs/hd-cursor/`, with the archive beside
it at `tools/hd-cursor/outputs/hd-cursor.zip`. Default input paths, when flags
are omitted, are `outputs/checkpoint/` and `outputs/inputs/gestures.json`
inside this subproject. These files are not included in Git.

The builder uses 1024x1024 transparent 16-bit RGBA PNG, CPU Cycles, 128 samples,
four threads, seed 17 and no denoising. The first observed seven-row build took
about four minutes on the research machine; this is not a performance promise.
Changing Blender, its bundled NumPy, the scene or Pillow may change output bytes.

## Review And Validate

Inspect `contact-sheet.png`, `all-cursors.webp` and individual sprite animations
locally. Open `hd-cursor.blend` to inspect the seven scenes and three poses.
The screenshots/previews themselves are not approved public documentation media.

```sh
HD_CURSOR_PACK_DIR=tools/hd-cursor/outputs/hd-cursor \
HD_CURSOR_CHECKPOINT_DIR="$HD_CURSOR_CHECKPOINT_DIR" \
tools/hd-cursor/.venv/bin/python -W error -m unittest discover \
  -s tools/hd-cursor/tests -p 'test_*.py' -v
```

The integration tests check row coverage, hotspots, frame timing, master PNG
depth, transparency, atlas cells, input pointer preservation, checksums and ZIP
contents. Geometry statistics are recorded by the builder; tests of that report
do not independently re-open and audit the Blender mesh. See
[Development](docs/DEVELOPMENT.md) for Blender-side validation.

## Existing Private Pack

The pre-migration research outputs remain at `private-assets/hd-cursor/` and
`private-assets/hd-cursor.zip` in the enclosing Neverhood workspace. They were
not moved into the public subproject or relicensed. To package or test that
existing pack, pass `--output private-assets/hd-cursor` and set
`HD_CURSOR_PACK_DIR=private-assets/hd-cursor` respectively. Set the checkpoint
environment variable separately to enable the pointer-preservation check.

The old entry points in `scripts/build-hd-cursors.py`,
`scripts/package-hd-cursors.py` and `test/hd-cursor-pack.test.py` have been moved,
not kept as duplicate wrappers.

## License And Publication

Generic tooling code follows the enclosing project's GPL-3.0-or-later license;
see [License](LICENSE.md). This is not a license to the original game's content,
the modeled cursors, private geometry recipes or rendered outputs. No permission
to distribute those materials is asserted here, and no legal determination of
their status has been made.

Keep private inputs and outputs out of commits, release attachments and public
build artifacts. Git ignore rules are an accident-prevention measure, not legal
clearance. The project source packager also excludes this subproject's
`outputs/`. A separate repository export must include the root `LICENSE` text
and retain the explicit distinction between software and artwork rights.
