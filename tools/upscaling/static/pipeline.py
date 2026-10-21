"""Offline static RGB processing with image-guided HD object contours.

Foreground RGB is an explicitly bound background crop, not a visual identity
proof. Prop baseline RGB uses premultiplied Lanczos divided by Lanczos coverage;
there is no neural restoration. Native masks constrain identity and coarse
geometry; nearest-neighbor masks are an explicit diagnostic, not the HD target.
"""

from collections import deque
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

import numpy as np
from PIL import Image


def _hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _json(value):
    return json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n"


def _pair(value, name, minimum=0):
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or any(type(v) is not int or v < minimum for v in value)):
        raise ValueError(f"{name} must contain two integers >= {minimum}")
    return tuple(value)


def _alpha(value):
    if isinstance(value, (str, Path)):
        with Image.open(value) as image:
            return _alpha(image)
    if isinstance(value, Image.Image):
        value = np.asarray(value)
    value = np.asarray(value)
    if value.ndim == 3 and value.shape[2] == 4:
        value = value[:, :, 3]
    if value.ndim != 2 or value.size == 0:
        raise ValueError("Alpha must be a nonempty L mask or RGBA image")
    if not np.issubdtype(value.dtype, np.number) or not np.all(np.isfinite(value)):
        raise ValueError("Alpha must contain finite numeric values")
    if np.any(value < 0) or np.any(value > 255):
        raise ValueError("Alpha must be in the 0..255 domain")
    return value


def _regions(mask):
    """Return four-connected region count and count not touching the border."""
    height, width = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    count = enclosed = 0
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        count += 1
        border = False
        pending = deque([(y, x)])
        seen[y, x] = True
        while pending:
            cy, cx = pending.popleft()
            border |= cy == 0 or cx == 0 or cy == height - 1 or cx == width - 1
            for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                if (0 <= ny < height and 0 <= nx < width
                        and mask[ny, nx] and not seen[ny, nx]):
                    seen[ny, nx] = True
                    pending.append((ny, nx))
        enclosed += not border
    return count, enclosed


def _mask_metrics(alpha):
    visible = alpha >= 128
    return {
        "binary": bool(np.all((alpha == 0) | (alpha == 255))),
        "softCount": int(np.count_nonzero((alpha != 0) & (alpha != 255))),
        "opaqueCount": int(np.count_nonzero(alpha == 255)),
        "thresholdVisibleCount": int(np.count_nonzero(visible)),
        "components": _regions(visible)[0],
        "holes": _regions(~visible)[1],
    }


def compare_alpha(reference, candidate) -> dict:
    """Compare raw alpha and >=128 silhouettes; topology is four-connected."""
    reference, candidate = _alpha(reference), _alpha(candidate)
    if reference.shape != candidate.shape:
        raise ValueError("Alpha dimensions differ; diagnostics never resize masks")
    a, b = reference >= 128, candidate >= 128
    union = int(np.count_nonzero(a | b))
    equal = bool(np.array_equal(reference, candidate))
    reference_metrics = _mask_metrics(reference)
    return {
        "exactEquality": equal,
        "mismatchCount": int(np.count_nonzero(reference != candidate)),
        "thresholdMismatchCount": int(np.count_nonzero(a != b)),
        "thresholdIoU": float(np.count_nonzero(a & b) / union) if union else 1.0,
        "threshold": 128,
        "connectivity": 4,
        "reference": reference_metrics,
        "candidate": dict(reference_metrics) if equal else _mask_metrics(candidate),
    }


def _load(path):
    with Image.open(path) as image:
        image.load()
        return image.copy()


def _baseline_rgb(source, size):
    data = np.asarray(source, dtype=np.float32)
    coverage = data[:, :, 3] / 255.0
    resized_coverage = np.asarray(Image.fromarray(coverage).resize(size, Image.Resampling.LANCZOS))
    channels = []
    for channel in range(3):
        premultiplied = data[:, :, channel] * coverage
        filtered = np.asarray(Image.fromarray(premultiplied).resize(size, Image.Resampling.LANCZOS))
        straight = np.divide(filtered, resized_coverage, out=np.zeros_like(filtered),
                             where=resized_coverage > 1e-6)
        channels.append(np.clip(np.rint(straight), 0, 255).astype(np.uint8))
    return np.stack(channels, axis=2)


def process_asset(asset: dict, output_dir: Path, *, scale: int = 4,
                  background_path: Path | None = None,
                  scene_size: tuple | None = None,
                  rgb_path: Path | None = None,
                  mask_method: str = "image-guided", band_native: float = 3) -> dict:
    """Publish one immutable per-asset directory, or verify an identical resume.

    Donor alpha is ignored. All RGB hidden by the authoritative alpha is zero.
    Existing artifacts are never repaired or overwritten, even on corruption.
    """
    if type(scale) is not int or scale <= 0:
        raise ValueError("scale must be a positive integer, not a boolean")
    if mask_method not in ("image-guided", "source-nearest"):
        raise ValueError("Unsupported mask_method")
    identifier = asset.get("id")
    if (not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", identifier)
            or identifier in (".", "..")):
        raise ValueError("asset.id must be a safe single path component")
    kind = asset.get("kind")
    if kind not in ("foreground-occluder", "static-prop"):
        raise ValueError("Unsupported static asset kind")
    content = _pair(asset.get("contentSize"), "contentSize", 1)
    canvas = _pair(asset.get("canvasSize"), "canvasSize", 1)
    placement = _pair(asset.get("placement"), "placement")
    if any(c < n for c, n in zip(canvas, content)):
        raise ValueError("canvasSize must contain contentSize at the top-left origin")
    if not isinstance(asset.get("sourceIdentity"), dict):
        raise ValueError("sourceIdentity must be a dictionary")
    source_path = Path(asset["sourcePath"])
    if not source_path.is_absolute():
        raise ValueError("sourcePath must be absolute")
    source_hash = _hash(source_path)
    if source_hash != asset.get("sourceSHA256"):
        raise ValueError("Source SHA256 mismatch")
    source = _load(source_path)
    # Image.copy loses format; verify the container independently.
    with Image.open(source_path) as original:
        if original.format != "PNG" or original.mode != "RGBA":
            raise ValueError("Source must be an RGBA PNG with an explicit alpha channel")
    if source.size != content:
        raise ValueError("Source dimensions must equal authoritative contentSize")
    source_data = np.asarray(source)
    alpha = source_data[:, :, 3]
    if not np.all((alpha == 0) | (alpha == 255)):
        raise ValueError("Source alpha must be binary 0/255, without soft alpha")
    if not np.any(alpha):
        raise ValueError("Source must not be all transparent")
    if scene_size is not None:
        scene_size = _pair(scene_size, "scene_size", 1)
    scaled_content = tuple(v * scale for v in content)
    scaled_canvas = tuple(v * scale for v in canvas)
    scaled_placement = tuple(v * scale for v in placement)
    expected = np.zeros((scaled_canvas[1], scaled_canvas[0]), dtype=np.uint8)
    expected[:scaled_content[1], :scaled_content[0]] = np.repeat(np.repeat(alpha, scale, axis=0), scale, axis=1)
    baseline = np.zeros((*expected.shape, 4), dtype=np.uint8)
    baseline[:scaled_content[1], :scaled_content[0]] = np.asarray(source.resize(scaled_content, Image.Resampling.NEAREST))
    baseline[:, :, 3] = expected
    baseline[expected == 0, :3] = 0
    inputs = {"source": {"path": str(source_path), "sha256": source_hash}}
    diagnostics = {}
    if kind == "foreground-occluder":
        if asset.get("backgroundCorrespondence") != "explicit-scene-binding":
            raise ValueError("Foreground requires explicit-scene-binding background correspondence")
        if background_path is None or scene_size is None or rgb_path is not None:
            raise ValueError("Foreground requires background_path and scene_size, and no rgb_path")
        background_path = Path(background_path).resolve()
        background = _load(background_path)
        if background.mode != "RGB" or background.size != tuple(v * scale for v in scene_size):
            raise ValueError("Background must be exact scene_size * scale RGB; no autoresize")
        if any(p + n > s for p, n, s in zip(placement, content, scene_size)):
            raise ValueError("Foreground content crop is outside scene bounds")
        x, y = scaled_placement
        rgb = np.asarray(background.crop((x, y, x + scaled_content[0], y + scaled_content[1])))
        method = "explicit-scene-background-rgb-crop"
        inputs["background"] = {"path": str(background_path), "sha256": _hash(background_path)}
        if asset.get("originalBackgroundPath"):
            original_path = Path(asset["originalBackgroundPath"]).resolve()
            original = _load(original_path)
            if original.mode != "RGB" or original.size != scene_size:
                raise ValueError("Original background must be native scene-size RGB")
            x, y = placement
            crop = np.asarray(original.crop((x, y, x + content[0], y + content[1])))
            delta = np.abs(source_data[:, :, :3].astype(np.int16) - crop.astype(np.int16))[alpha == 255]
            diagnostics["sourceOriginalBackgroundVisibleRGB"] = {
                "exactMatch": bool(np.all(delta == 0)), "meanAbsoluteError": float(delta.mean()),
                "maxAbsoluteError": int(delta.max()),
                "interpretation": "Visual diagnostic only; neither identity nor proof the background crop is valid.",
            }
            inputs["originalBackground"] = {"path": str(original_path), "sha256": _hash(original_path)}
    else:
        if background_path is not None:
            raise ValueError("Static props do not consume a background")
        if rgb_path is not None:
            rgb_path = Path(rgb_path).resolve()
            donor = _load(rgb_path)
            if donor.size not in (scaled_content, scaled_canvas):
                raise ValueError("Prop RGB donor must match scaled content or padded canvas dimensions")
            if mask_method == "image-guided" and donor.mode != "RGB":
                raise ValueError("Image-guided props require opaque RGB context, not masked donor colors")
            rgb = np.asarray(donor.convert("RGB").crop((0, 0, *scaled_content)))
            method = "provided-rgb-alpha-ignored-top-left-content-crop"
            inputs["rgb"] = {"path": str(rgb_path), "sha256": _hash(rgb_path),
                             "size": list(donor.size), "cropOrigin": [0, 0], "alphaIgnored": True}
        else:
            if mask_method == "image-guided":
                raise ValueError("Image-guided props require restored RGB; source-nearest is only an explicit diagnostic baseline")
            rgb = _baseline_rgb(source, scaled_content)
            method = "deterministic-premultiplied-rgb-lanczos-coverage-unpremultiply-baseline"
    output = np.zeros_like(baseline)
    output[:scaled_content[1], :scaled_content[0], :3] = rgb
    geometry_mask = expected.copy()
    raw_geometry_mask = expected.copy()
    prior_geometry_mask = expected.copy()
    coverage = expected.copy()
    if mask_method == "image-guided":
        refinement_path = Path(__file__).with_name("refine.py")
        spec = importlib.util.spec_from_file_location("neverhood_static_refine", refinement_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        refined = module.refine_mask(source.getchannel("A"), Image.fromarray(rgb), scale=scale, band_native=band_native, return_debug_masks=True)
        binary = np.asarray(refined["binaryMask"])
        alpha_coverage = np.asarray(refined["coverageAlpha"])
        shape = (scaled_content[1], scaled_content[0])
        if binary.shape != shape or alpha_coverage.shape != shape or not np.all((binary == 0) | (binary == 255)):
            raise ValueError("Refinement returned invalid mask dimensions or nonbinary geometry")
        geometry_mask[:shape[0], :shape[1]] = binary
        raw_geometry_mask[:shape[0], :shape[1]] = np.asarray(refined["rawCandidateMask"])
        prior_geometry_mask[:shape[0], :shape[1]] = np.asarray(refined["priorMask"])
        coverage[:shape[0], :shape[1]] = alpha_coverage
        diagnostics["refinement"] = refined["diagnostics"]
        inputs["refinementImplementation"] = {"path": str(refinement_path), "sha256": _hash(refinement_path)}
        # RGB at a partially covered edge must not retain the baked background mix.
        from scipy.ndimage import distance_transform_edt
        partial = (coverage > 0) & (coverage < 255)
        if np.any(partial) and np.any(coverage == 255):
            nearest = distance_transform_edt(coverage != 255, return_distances=False, return_indices=True)
            output[partial, :3] = output[nearest[0][partial], nearest[1][partial], :3]
    output[:, :, 3] = coverage
    output[coverage == 0, :3] = 0
    fingerprint_data = {"version": 3, "asset": asset, "scale": scale,
                        "sceneSize": scene_size, "inputs": inputs, "method": method,
                        "maskMethod": mask_method, "bandNative": band_native}
    fingerprint = hashlib.sha256(_json(fingerprint_data).encode()).hexdigest()
    output_dir = Path(output_dir).resolve()
    destination = output_dir / identifier

    def resume():
        try:
            result = json.loads((destination / "result.json").read_text())
            recorded_manifest_hash = result.get("manifestSHA256")
            unsigned = {key: value for key, value in result.items() if key != "manifestSHA256"}
            if hashlib.sha256(_json(unsigned).encode()).hexdigest() != recorded_manifest_hash:
                raise ValueError("Existing result manifest hash mismatch")
            if result["fingerprint"] != fingerprint:
                raise ValueError("Existing result has stale or differing inputs/parameters")
            for name, filename in (("rgba", "rgba.png"), ("mask", "mask.png"), ("rawMask", "raw-mask.png"), ("priorMask", "prior-mask.png"), ("coverage", "coverage.png"), ("sourceNN", "source-nn.png")):
                recorded = result["outputs"][name]
                path = destination / filename
                if recorded["path"] != str(path) or _hash(path) != recorded["sha256"]:
                    raise ValueError("Existing output hash/path mismatch")
            return result
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise ValueError("Existing result is incomplete or invalid; refusing overwrite") from error

    if destination.exists():
        return resume()
    output_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{identifier}-", dir=output_dir))
    try:
        outputs = {}
        for name, filename, image in (("rgba", "rgba.png", Image.fromarray(output)),
                                      ("mask", "mask.png", Image.fromarray(geometry_mask)),
                                      ("rawMask", "raw-mask.png", Image.fromarray(raw_geometry_mask)),
                                      ("priorMask", "prior-mask.png", Image.fromarray(prior_geometry_mask)),
                                      ("coverage", "coverage.png", Image.fromarray(coverage)),
                                      ("sourceNN", "source-nn.png", Image.fromarray(baseline))):
            image.save(staging / filename, format="PNG")
            outputs[name] = {"path": str(destination / filename), "sha256": _hash(staging / filename),
                             "size": list(scaled_canvas)}
        checks = compare_alpha(expected, output[:, :, 3])
        geometry_checks = compare_alpha(expected, geometry_mask)
        topology_preserved = all(geometry_checks["reference"][key] == geometry_checks["candidate"][key]
                                 for key in ("components", "holes"))
        coverage_topology_preserved = all(checks["reference"][key] == checks["candidate"][key]
                                          for key in ("components", "holes"))
        refinement_diagnostics = diagnostics.get("refinement", {})
        context_corrected = bool(refinement_diagnostics.get("candidateCorrected", False))
        refinement_rejected = bool((refinement_diagnostics.get("candidateRejected", False) and not context_corrected)
                                  or refinement_diagnostics.get("changedOutsideTrustBand", 0))
        acceptance = "blocked-refinement-geometry"
        if topology_preserved and coverage_topology_preserved and not refinement_rejected:
            acceptance = "review-required-context-correction" if context_corrected else "review-required"
        result = {"id": identifier, "kind": kind, "fingerprint": fingerprint,
                  "resultPath": str(destination / "result.json"), "outputs": outputs,
                  "sourceIdentity": asset["sourceIdentity"], "inputs": inputs,
                  "scale": scale, "contentSize": list(content), "canvasSize": list(canvas),
                  "scaledContentSize": list(scaled_content), "size": list(scaled_canvas),
                  "placement": list(placement), "scaledPlacement": list(scaled_placement),
                  "processingMethods": {"rgb": method, "alpha": mask_method,
                                        "coverageRGB": "nearest-full-coverage-edge-color" if mask_method == "image-guided" else "unchanged",
                                        "padding": "transparent-right-bottom", "hiddenRGB": "zero",
                                        "sourceNN": "source-nearest-neighbor-zero-hidden-rgb"},
                  "alphaRepresentation": "localized-edge-coverage" if mask_method == "image-guided" else "binary-diagnostic",
                  "geometryMaskDomain": [0, 255],
                  "acceptance": acceptance,
                  "diagnostics": diagnostics, "invariants": {"alpha": checks,
                      "sourceMaskComparisonIsAcceptanceCriterion": False,
                      "geometryMask": geometry_checks, "topologyPreserved": topology_preserved,
                      "coverageTopologyPreserved": coverage_topology_preserved,
                      "hiddenRGBZero": bool(np.all(output[coverage == 0, :3] == 0)),
                      "placementPreserved": True, "sourceIdentityPreserved": True}}
        # This hashes canonical manifest contents excluding this field, not the file itself.
        result["manifestSHA256"] = hashlib.sha256(_json(result).encode()).hexdigest()
        (staging / "result.json").write_text(_json(result), encoding="utf-8")
        try:
            os.rename(staging, destination)
        except OSError:
            if destination.exists():
                return resume()
            raise
        return result
    finally:
        if staging.exists():
            shutil.rmtree(staging)
