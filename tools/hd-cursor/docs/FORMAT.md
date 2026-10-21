# Input And Pack Format

## Coordinates And Timing

The logical cursor canvas is 32x32, with `(0, 0)` at the top left and positive
Y pointing down. Geometry input uses logical X/Y and actual depth Z. Mesh
coordinates are transformed to `(x - 16, 16 - y, z)` for a 32-unit orthographic
camera looking down the Z axis. Inputs must supply a suitable camera and lights.

The export scale is 4, making each display cell 128x128. The 1024x1024 masters
use scale 32, but do not change the logical coordinate system or hotspot.

| Row | Name | Logical Hotspot | 128px Hotspot |
| --- | --- | --- | --- |
| 0 | `forward` | `(15, 5)` | `(60, 20)` |
| 1 | `restricted` | `(17, 25)` | `(68, 100)` |
| 2 | `down` | `(17, 30)` | `(68, 120)` |
| 3 | `up` | `(14, 1)` | `(56, 4)` |
| 4 | `pointer` | `(3, 7)` | `(12, 28)` |
| 5 | `right` | `(30, 18)` | `(120, 72)` |
| 6 | `left` | `(1, 18)` | `(4, 72)` |

These are functional registration values, not permissions to use the artwork.
Blender frames 1, 2, 3 correspond to pose ordinals 0, 1, 2. Shape-key
interpolation is constant. The engine's six-update mapping is
`[0, 0, 1, 1, 2, 2]`; at a nominal 41ms update this gives 82ms per pose and
246ms per loop. WebP previews loop at that pose duration.

Runtime consumers should use the engine-presented pose ordinal, not introduce
an independent animation clock. The authored tail swing is not a reconstruction
of the original animation's exact motion.

## Checkpoint Directory

```text
checkpoint/
  cursor-fitted.blend
  scene-metadata.json
  f0-clay-1024.png
  f1-clay-1024.png
  f2-clay-1024.png
```

The active scene in the `.blend` supplies the world, lights and orthographic
camera. `scene-metadata.json` identifies the clay material and pointer object:

```json
{
  "material": "Your clay material name",
  "poses": [{"object": "Your animated pointer mesh name"}]
}
```

The named mesh must be linked to the active scene and provide the three poses
at Blender frames 1, 2, 3. The three supplied PNG files must be 1024x1024,
16-bit RGBA masters. The build copies them verbatim for row 4, avoiding
accidental changes to that checkpoint's renders. The saved pack also contains
a copy of its mesh and shape keys. It does not embed the original input file
as a separate archive member.

This is a **trusted local asset** interface, not an untrusted `.blend` sandbox.
Scripts are opened with `use_scripts=False` and commands use
`--disable-autoexec`, but those flags are not a comprehensive security guarantee.

## Private Gesture Recipe

This JSON is an artwork input, intentionally absent from public source. Its
top-level contract is `version: 1` and a `rows` object containing string keys
`0`, `1`, `2`, `3`, `5`, `6`. Row 4 comes from the checkpoint.

Each row object contains:

| Field | Meaning |
| --- | --- |
| `primitive` | `arrow` or `flared-rod` |
| `parameters` | Primitive-specific geometry parameters |
| `junction` | Two-element logical XY fixed-joint anchor |
| `tail` | Two-element logical XY free-end reference for deformation |

For `arrow`, `parameters` contains `tip`, `base`, `end` (three-element XYZ
coordinates), `radius` (arrowhead radius), optional `stem_radius` (default 3.2)
and optional `bend` (XYZ quadratic centerline control point). If no bend is
specified, the stem centerline is straight. Circular sections and rounded caps
are generated and voxel-fused; no source-image mask is read.

For `flared-rod`, parameters are `start`, `end` (XYZ), `shaftRadius`,
`flareRadius`, `falloff` and `capLength`. Radius along normalized position `t`
is `shaftRadius + flareRadius * (exp(-t*falloff) + exp(-(1-t)*falloff))`.
Caps follow the rod axis. All radii and lengths should be positive and the
endpoints distinct. Keep the full shape, including the animated poses, inside
the logical canvas.

Recipes are numeric trusted inputs, not code plugins. The tool does not validate
every degenerate geometry case or guarantee a good silhouette for arbitrary
parameters. Review the resulting volumes and renders. Do not add the existing
game-specific recipe to a public example or fixture.

## Output Directory

```text
hd-cursor/
  hd-cursor.blend
  build.json
  cursor.json
  SHA256SUMS
  sprite-sheet-128.png
  contact-sheet.png
  all-cursors.webp
  sprites/
    r0-forward/ ... r6-left/
      f0-clay-1024.png ... f2-clay-1024.png
      f0-alpha-1024.png ... f2-alpha-1024.png
      f0-clay-128.png ... f2-clay-128.png
      animation.webp
hd-cursor.zip
```

Masters remain 16-bit RGBA PNG. Host Pillow loads them as 8-bit RGBA for display
exports. The `alpha-1024` files are therefore **8-bit alpha extracted during
packaging**, not separate native 16-bit Cycles alpha passes. Display sprites
are resized in premultiplied-alpha space using Lanczos, then converted back to
straight RGBA. This avoids dark transparency fringes; it is not linear-light
color resampling. Previews have 8-bit display colors.

The atlas is 384x896, laid out as three columns by seven rows. Frame `(row, pose)`
has rectangle `[pose*128, row*128, 128, 128]`. Never crop, recenter or independently
normalize each pose; the hotspot assumes the full canvas. `alphaBBox` is a
diagnostic bounding box at alpha >= 128, not a replacement canvas size.

## Manifest Version 1

`build.json` is the Blender-stage report. `cursor.json` extends it during
packaging. Existing pre-migration packs may lack newer optional metadata such
as `recipesSHA256` and `mediaRights`.

| Field | Meaning |
| --- | --- |
| `version`, `revision` | Format version and model revision label |
| `blender` | Blender version used by the builder |
| `sourceSHA256` | SHA256 of the input checkpoint `.blend` |
| `recipesSHA256` | SHA256 of the input recipe JSON, for new builds |
| `logicalSize`, `masterSize`, `cellSize` | `[32,32]`, `[1024,1024]`, `128` |
| `phaseMapping`, `poseDurationMs` | Six-update pose mapping and preview timing |
| `rows` | Row ID/name, hotspots, Blender scene/object names and mesh statistics |
| `frames` | 21 records with row/ordinal, image/master paths, atlas rectangle, alpha box and sprite SHA256 |
| `image`, `atlasSize` | Atlas filename and `[384,896]` dimensions |
| `scope`, `animation`, `alpha`, `runtimeIntegration` | Human-readable limitations and processing notes |
| `mediaRights` | `not-evaluated` notice; not a license grant or legal clearance |

Paths in `frames` are relative to the pack directory. `SHA256SUMS` covers the
curated deliverable list, excluding itself. The ZIP contains those files plus
`SHA256SUMS` under a single `hd-cursor/` prefix. Unrelated notes, source inputs,
backup files or arbitrary files left in the output folder are not ZIP members.
With a custom output directory, the archive path is `output.with_suffix('.zip')`.

## Consumer Responsibilities

This manifest is not a drop-in replacement for the two-room demo's separate
`cursor.json` binding. The demo exporter/loader has its own resource, palette
and source-pixel matching contract. Importing the atlas alone does not enable
other game states. Keep native fallback until resource identity, palette
behavior, hotspot alignment and phase synchronization have been verified.

No `.cur`/`.ani` operating-system theme or installer is produced. This is a
sprite/Blender research pack format, not a whole-game palette-variant archive.
