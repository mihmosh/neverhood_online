# Masks And Restored Boundaries

## Static Correction (2026-10-21)

Nearest-neighbor source masks are not final HD masks. They preserve the original
pixel staircase, not necessarily the actual object boundary in restored Nano
Banana RGB. The static goal is to approximate that restored boundary while
retaining source identity, coarse shape and topology. This correction is static
only: the separate SeedVR2/animation binary-mask policy is unchanged.

The implemented experimental static default is `mask_method='image-guided'`:
coarse native binary source prior -> smooth geometric prior -> genuine image-guided
edge inference against restored RGB within a narrow trust band. The SciPy maxflow
stage uses image evidence; synthetic tests change RGB while holding the source mask
fixed and require the inferred contour to change appropriately. A default band of
three native pixels needs asset review;
there is no universal tuning or quality guarantee.

Keep two distinct outputs: categorical geometric segmentation is binary 0/255;
rendering alpha adds coverage only at the contour, within a one-HD-pixel edge.
Intermediate rendering alpha is allowed there, not as general donor softness or
a substitute for boundary inference. Ignore restored donor alpha as an authority.

## Comparisons And Checks

Compare original nearest-4x, geometry-smoothed and image-guided masks on the same
restored RGB, world placement and padded canvas. Source NN is diagnostic only.
Exact NN equality proves unchanged blockiness, not acceptance of a final HD contour.

- Inspect adherence to the actual restored-RGB boundary with outlines and zooms.
- Check coarse source consistency, four-connected components and holes, thin parts,
  and absence of extra objects. Topology mismatch blocks acceptance.
- Restrict changed pixels to the recorded native-SDF trust band; retain IoU, bounds
  and displacement diagnostics without using exact-NN equality as the goal.
- Flag weak or low-contrast image support for review rather than automatic approval.
- Verify coverage alpha is localized to the one-HD-pixel contour, with solid
  interiors and transparent exteriors rather than broad soft donor edges.
- Preserve source canvas, position offsets, right/bottom padding, flips, clipping,
  scene/state context, palette and exact resource/runtime identity keys.
- Composite over light, dark and checkerboard backgrounds at matched placement.

The [contour pilot](../static/README.md) processed six real layers using the Nano
background. Five have direct RGB-supported proposals. The ladder's raw proposal
closes a source opening near the arch; a six-pixel exterior reconnection is retained
as an explicitly review-required context correction, not an RGB-proven edge. Raw,
smooth-prior and corrected masks are exported for inspection. This is not quality
acceptance or gameplay validation. Earlier Scene1002-v3 measurements remain
historical baselines.
Old preparation ran RealESRNet on RGB and grayscale alpha separately; its neural
alpha is comparison evidence, not geometry or calibrated rendering coverage.
Hidden RGB in transparent pixels is not by itself a visible defect.

Foreground RGB comes from the chosen HD background only when source-to-background
correspondence is explicit. Original-RGB matching does not prove that binding or
segmentation. Otherwise use the independent-prop path or require review.
Contour and composite checks do not validate gameplay: priority/state transitions,
part-3 deletion and hand clipping still require an in-engine fixture.

The trust band constrains changed-pixel membership in an interpolated native signed
distance field. Symmetric distances between raster boundary-pixel centers are
different diagnostics, not a hard bound equal to that numeric band. A crop/occlusion
context disagreement must be reviewed rather than forcing the old pixel path or
silently accepting a newly closed opening.

## Animation Boundary

The existing SeedVR2 probe uses unchanged nearest-4x source masks and binary alpha.
Keep RGB and mask branches separate, preserve ordinals, offsets and timing, and
check repeated poses/action boundaries for jitter. No static contour or coverage
change here authorizes changing animation masks in the parallel workflow.
