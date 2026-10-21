#!/usr/bin/env python3
"""Offline technical checks and diagnostic-only private report. Never calls a model."""

import argparse
import base64
from collections import Counter
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image, ImageFilter


PRIVATE_ROOT = Path(__file__).resolve().parents[3] / "private-assets"
MODEL = "gemini-nano-banana-2.1"
KNOWN_2K = [2400, 1792]
POLICY = {
    "automaticApproval": False, "structuralVerification": "not-performed",
    "diagnosticOnlyPixels": True, "ranking": False,
    "notes": "No scoring, winners, runtime export or paid calls. Low error does not prove structural fidelity. "
             "No OCR: legitimate puzzle marks are not automatically treated as added text. "
             "Text preservation is required only for explicit source-inscriptions profiles: preserve existing "
             "inscriptions and drawings; do not erase, add or rewrite them. Layout diagnostics cannot verify "
             "letter fidelity or promise high-resolution legibility; manual review is required. "
             "Source-resolution reduction can conceal geometry drift. Native results are never resized on disk.",
}
SPEC = importlib.util.spec_from_file_location("bulk_diagnostic_metrics", Path(__file__).with_name("evaluate.py"))
EVALUATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVALUATOR)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected JSON object: " + str(path))
    return value


def private_path(value):
    if not isinstance(value, (str, Path)) or not Path(value).is_absolute():
        raise ValueError("path must be absolute")
    path = Path(value).resolve()
    if not path.is_relative_to(PRIVATE_ROOT.resolve()):
        raise ValueError("artifact must remain under private-assets: " + str(path))
    return path


def issue(entry, kind, reason, severity="hard-technical-failure"):
    image_issue = kind.startswith(("source-", "output-")) or kind == "candidate-missing"
    if severity == "hard-technical-failure" and not image_issue:
        severity = "provenance-warning"
    category = ("image-validity" if severity == "hard-technical-failure" else
                "visual-review" if severity == "heuristic-review-flag" else
                "diagnostic" if severity == "diagnostic" else "provenance")
    entry["issues"].append({"kind": kind, "category": category,
                            "severity": severity, "reason": str(reason)})


def inspect_image(value, expected, entry, role):
    """Read bytes once; decode fully, including palette transparency, before RGB conversion."""
    try:
        path = private_path(value)
        data = path.read_bytes()
        with Image.open(path) as opened:
            opened.load()
            mime = Image.MIME.get(opened.format)
            opaque = opened.convert("RGBA").getchannel("A").getextrema() == (255, 255)
            info = {"path": str(path), "sha256": sha(data), "bytes": len(data),
                    "dimensions": list(opened.size), "mimeType": mime, "opaque": opaque}
            image = opened.convert("RGB")
        for key in ("sha256", "bytes", "dimensions", "mimeType"):
            if key in expected and expected[key] != info[key]:
                issue(entry, role + "-" + key + "-mismatch", f"{role} {key}: declared {expected[key]!r}, observed {info[key]!r}")
        if not expected.get("sha256"):
            issue(entry, role + "-hash-missing", "No declared SHA-256 for " + role +
                  "; observed bytes are hashed independently", "provenance-warning")
        if not opaque:
            issue(entry, role + "-transparency", role + " contains nonopaque pixels")
        if mime not in ("image/png", "image/jpeg"):
            issue(entry, role + "-mime", "Expected PNG or JPEG, decoded " + str(mime))
        return info, image
    except (OSError, ValueError, TypeError, Image.DecompressionBombError) as error:
        issue(entry, role + "-unavailable", error)
        return None, None


def calibration():
    """Secondary pixel metrics only; no pilot judgments or object annotations are imported."""
    path = PRIVATE_ROOT / "upscaling/gemini-experiments/opaque-pilot-v1/eval.json"
    result = {"status": "unavailable-conservative-defaults", "sampleCount": 0,
              "thresholds": {"edgeCosineBelow": 0.35, "absoluteChannelDriftAbove": 20.0,
                             "gridChannelDriftAbove": 45.0, "alignmentPixelsAbove": 8,
                             "alignmentImprovementAbove": 0.25},
              "notes": "Review triggers only, not validated sensitivity or structural ground truth. "
                       "Alignment/grid thresholds are conservative fixed diagnostics, not pilot-trained."}
    try:
        data = path.read_bytes()
        entries = [entry["metrics"] for room in json.loads(data)["rooms"]
                   for entry in room["entries"] if entry.get("kind") == "candidate" and entry.get("metrics")]
        if len(entries) != 8:
            raise ValueError("expected eight successful pilot candidates")
        edges = [float(m["edgeGradientCosine"]) for m in entries]
        drift = [max(abs(float(n)) for n in m["meanDriftRGB"]) for m in entries]
        result.update(status="eight-pilot-secondary-metrics", sampleCount=8, path=str(path), sha256=sha(data),
                      observed={"edgeCosineRange": [min(edges), max(edges)], "maxAbsoluteChannelDrift": max(drift)})
        # Observations contextualize fixed thresholds; never tune away observed drift.
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return result


def color_patches(source, candidate):
    """Source-defined fixed patches, lowpass HSV; no geometry or quality inference."""
    reduced = candidate.resize(source.size, Image.Resampling.LANCZOS)
    hsv = [np.asarray(im.convert("RGB").filter(ImageFilter.GaussianBlur(4)).convert("HSV"),
                      dtype=float) / 255 for im in (source, reduced)]
    patches = []
    for row in range(6):
        for col in range(8):
            box = [col / 8, row / 6, (col + 1) / 8, (row + 1) / 6]
            x0, y0, x1, y1 = [int(v * size) for v, size in zip(box, source.size * 2)]
            a, b = [v[y0:y1, x0:x1] for v in hsv]
            # Eligibility uses only the source, excluding dark/near-neutral unstable hue.
            mask = (a[..., 1] >= .18) & (a[..., 2] >= .14)
            count = int(mask.sum())
            record = {"id": f"r{row + 1}c{col + 1}", "box": box,
                      "sourceEligibleFraction": float(mask.mean()), "warnings": []}
            if count and mask.mean() >= .20:
                delta = np.abs(a[..., 0] - b[..., 0])
                hue = np.minimum(delta, 1 - delta) * 360
                stable = mask & (b[..., 1] >= .18) & (b[..., 2] >= .14)
                loss = (a[..., 1] - b[..., 1])[mask]
                hue_fraction = float(((hue >= 8) & stable).sum() / count)
                loss_fraction = float((loss >= .15).mean())
                chroma_fraction = float((np.abs(loss) >= .12).mean())
                record.update(medianSaturationLoss=float(np.median(loss)),
                              saturationLossFraction=loss_fraction,
                              saturationDriftFraction=chroma_fraction,
                              hueShiftFraction=hue_fraction,
                              medianHueShiftDegrees=float(np.median(hue[stable])) if stable.any() else None)
                if loss_fraction >= .30:
                    record["warnings"].append("source-chroma-loss")
                elif chroma_fraction >= .30:
                    record["warnings"].append("source-saturation-drift")
                if hue_fraction >= .30:
                    record["warnings"].append("source-hue-shift")
            patches.append(record)
    return {"method": "8x6 source-defined fixed grid; Gaussian sigma 4 source pixels; HSV",
            "thresholds": {"sourceSaturationMin": .18, "valueMin": .14,
                           "sourceEligibleFractionMin": .20, "saturationLossMin": .15,
                           "saturationDriftMin": .12,
                           "hueShiftDegreesMin": 8, "affectedEligibleFractionMin": .30},
            "note": "Warnings only, not quality scores or geometry labels. No warning is not approval.",
            "patches": patches}


def diagnostics(source, candidate):
    result = EVALUATOR.metrics(source, candidate)
    reduced = candidate.resize(source.size, Image.Resampling.LANCZOS)
    arrays = [np.asarray(im.filter(ImageFilter.GaussianBlur(2)), dtype=float)
              for im in (source, reduced)]
    # Fixed geometry grid, not an inventory of semantic objects.
    cells = []
    for row in range(3):
        for col in range(4):
            box = [col / 4, row / 3, (col + 1) / 4, (row + 1) / 3]
            x0, y0, x1, y1 = [int(v * size) for v, size in zip(box, source.size * 2)]
            delta = arrays[1][y0:y1, x0:x1] - arrays[0][y0:y1, x0:x1]
            cells.append({"id": f"r{row + 1}c{col + 1}", "box": box,
                          "meanDriftRGB": delta.mean(axis=(0, 1)).tolist()})
    result["geometryGrid"] = cells
    result["localizedColor"] = color_patches(source, candidate)
    # Search translations on fixed interior support, using low-frequency luminance.
    gray = [a @ np.array([0.2126, 0.7152, 0.0722]) for a in arrays]
    margin = 16
    reference = gray[0][margin:-margin, margin:-margin]
    errors = []
    for dy in range(-12, 13, 2):
        for dx in range(-12, 13, 2):
            shifted = gray[1][margin + dy:source.height - margin + dy,
                              margin + dx:source.width - margin + dx]
            error = float(np.abs(reference - shifted).mean())
            errors.append((error, abs(dx) + abs(dy), dy, dx))
    best = min(errors)
    zero = next(e[0] for e in errors if e[2:] == (0, 0))
    result["alignment"] = {"bestOffsetXY": [best[3], best[2]], "zeroError": zero,
                           "bestError": best[0], "relativeImprovement": (zero - best[0]) / zero if zero else 0,
                           "search": "blur sigma 2, +/-12 source pixels, step 2, fixed 16px interior; not a correction"}
    return result


def documented_native_policy(job):
    policy = job.get("sourceGeometryPolicy")
    return (isinstance(policy, dict) and policy.get("mode") == "preserve-native-aspect"
            and policy.get("sourceDimensions") == [640, 500]
            and isinstance(policy.get("reason"), str) and bool(policy["reason"].strip()))


def native_policy(job, entry):
    dimensions = (entry.get("source") or {}).get("dimensions")
    return (documented_native_policy(job) and dimensions == [640, 500]
            and dimensions[0] * 3 != dimensions[1] * 4)


def check_settings(job, entry):
    settings = job.get("settings", {})
    if job.get("model") != MODEL:
        issue(entry, "model-mismatch", "Expected " + MODEL + "; observed " + str(job.get("model")))
    config = settings.get("imageConfig", {}) if isinstance(settings, dict) else {}
    native = native_policy(job, entry)
    valid = (isinstance(config, dict) and config.get("imageSize") == "2K"
             and ("aspectRatio" not in config if native else config.get("aspectRatio") == "4:3")
             and (settings.get("responseModalities") == ["TEXT", "IMAGE"] if native else
                  "IMAGE" in settings.get("responseModalities", [])))
    if not valid:
        issue(entry, "settings-mismatch", "Expected TEXT/IMAGE modes and imageSize 2K with aspectRatio omitted for documented native source" if native else
              "Expected IMAGE modality, imageSize 2K and aspectRatio 4:3")
    if job.get("sourceGeometryPolicy") is not None and not native:
        issue(entry, "geometry-policy-mismatch", "Native exception requires documented preserve-native-aspect policy matching decoded 640x500 source")
    return native and valid


def check_candidate(run, job, entry, usage):
    """Fail closed while retaining readable artifacts for failure analysis."""
    image = None
    try:
        identifier = job.get("id")
        if entry["origin"] == "generation":
            if not isinstance(identifier, str) or identifier in ("", ".", "..") or Path(identifier).name != identifier:
                raise ValueError("invalid immediate-child job ID")
            path = run / "jobs" / identifier / "result.json"
        else:
            path = private_path(job.get("resultPath"))
        path = private_path(path)
        entry["resultPath"] = str(path)
        artifact = read_json(path)
        entry["observedStatus"] = artifact.get("status", "unknown")
        entry["responseId"] = artifact.get("responseId")
        entry["httpStatus"] = artifact.get("httpStatus")
        entry["startedAt"] = artifact.get("startedAt")
        entry["error"] = artifact.get("error")
        entry["resultSha256"] = sha(path.read_bytes())
        entry["usage"] = artifact.get("usage") or {}
        usage_index = len(usage)
        usage.append((str(path), entry["usage"], artifact.get("responseId"), isinstance(artifact.get("httpStatus"), int)))
        if artifact.get("status") != "succeeded":
            issue(entry, "result-not-successful", "Saved status: " + str(artifact.get("status", "unknown")) +
                  "; error: " + json.dumps(artifact.get("error"), ensure_ascii=True) +
                  "; outcome metadata is not visual evidence; never automatically resubmit")
        saved_finals = [i for i in artifact.get("images", []) if isinstance(i, dict)
                        and not i.get("thought") and str(i.get("mimeType", "")).startswith("image/")]
        if saved_finals:
            entry["output"], image = inspect_image(saved_finals[0].get("path"), saved_finals[0], entry, "output")
        entry["savedFinalImageCount"] = len(saved_finals)
        try:
            request = read_json(path.with_name("request.json"))
        except (OSError, ValueError) as error:
            request = {}
            issue(entry, "request-evidence-unavailable", error)
        expected = job if entry["origin"] == "generation" else {**request, **job}
        native = check_settings(expected, entry)
        policy = expected.get("sourceGeometryPolicy")
        frozen_policy = request.get("sourceGeometryPolicy")
        policy_matches = policy == frozen_policy
        if not policy_matches:
            issue(entry, "request-sourceGeometryPolicy-mismatch", "Frozen request disagrees with manifest: sourceGeometryPolicy")
        entry["inputGeometryPolicy"] = {"declared": policy, "frozenRequest": frozen_policy,
                                        "frozenRequestMatches": policy_matches,
                                        "sourceDimensionsMatch": native_policy(expected, entry),
                                        "nativeAspectExceptionAccepted": native and policy_matches
                                        and request.get("settings") == expected.get("settings"),
                                        "manualFullViewRequired": policy is not None}
        for key in ("requestHash", "model", "settings"):
            if expected.get(key) is None or request.get(key) != expected.get(key):
                issue(entry, "request-" + key + "-mismatch", "Frozen request disagrees with manifest: " + key)
        for key in ("requestHash", "model"):
            if artifact.get(key) != expected.get(key):
                issue(entry, "result-" + key + "-mismatch", "Saved result disagrees with expected request: " + key)
        source_attachments = [a for a in request.get("attachments", []) if a.get("role") == "source-composition"]
        if (len(source_attachments) != 1 or not entry.get("source") or
                source_attachments[0].get("sha256") != entry["source"]["sha256"]):
            issue(entry, "request-source-mismatch", "Frozen request must bind exactly one matching source-composition hash")
        raw_path = path.with_name("response-raw.json")
        try:
            raw = read_json(raw_path)
            entry["rawResponse"] = {"path": str(raw_path), "sha256": sha(raw_path.read_bytes())}
        except (OSError, ValueError) as error:
            raw = {}
            issue(entry, "raw-response-unavailable", error)
        entry["usage"] = artifact.get("usage") or raw.get("usageMetadata") or {}
        usage[usage_index] = (str(path), entry["usage"], artifact.get("responseId") or raw.get("responseId"),
                              bool(raw) or isinstance(artifact.get("httpStatus"), int))
        if artifact.get("usage") is not None and artifact.get("usage") != raw.get("usageMetadata"):
            issue(entry, "usage-mismatch", "Result usage differs from full raw response")
        for key in ("responseId", "modelVersion"):
            if raw.get(key) is not None and raw.get(key) != artifact.get(key):
                issue(entry, "response-" + key + "-mismatch", "Result metadata disagrees with raw response: " + key)
        entry["modelVersion"] = raw.get("modelVersion", artifact.get("modelVersion"))
        if raw.get("error") or not isinstance(artifact.get("httpStatus"), int) or not 200 <= artifact["httpStatus"] < 300:
            issue(entry, "response-error", "Expected successful HTTP status and no provider error; observed " +
                  json.dumps({"httpStatus": artifact.get("httpStatus"), "error": raw.get("error")}, ensure_ascii=True))
        candidates = raw.get("candidates", [])
        finishes = [c.get("finishReason") for c in candidates]
        entry["finishReasons"] = finishes
        if not finishes or any(f != "STOP" for f in finishes) or artifact.get("finishReasons") != finishes:
            issue(entry, "invalid-finish", "All returned candidates and saved finishReasons must be STOP: " + str(finishes))
        images = artifact.get("images", [])
        if not isinstance(images, list) or any(not isinstance(i, dict) for i in images):
            raise ValueError("invalid saved images list")
        observed = []
        raw_finals = []
        raw_final_count = 0
        indexed = {}
        for saved in images:
            key = (saved.get("candidateIndex"), saved.get("partIndex"))
            if key in indexed:
                issue(entry, "duplicate-image-index", "Duplicate saved candidate/part indices")
            indexed[key] = saved
        for ci, candidate in enumerate(candidates):
            for pi, part in enumerate(candidate.get("content", {}).get("parts", [])):
                inline = part.get("inlineData", {})
                if not inline.get("data"):
                    continue
                is_final = not part.get("thought") and inline.get("mimeType", "").startswith("image/")
                raw_final_count += int(is_final)
                saved = indexed.pop((ci, pi), None)
                if not saved:
                    issue(entry, "unsaved-response-part", f"Raw response part {ci}/{pi} has no saved artifact")
                    continue
                data = base64.b64decode(inline["data"], validate=True)
                if saved.get("sha256") != sha(data) or saved.get("bytes") != len(data):
                    issue(entry, "raw-image-mismatch", f"Raw bytes differ from saved metadata at {ci}/{pi}")
                if (saved.get("mimeType") != inline.get("mimeType") or
                        saved.get("thought") is not bool(part.get("thought", False))):
                    issue(entry, "raw-image-metadata-mismatch", f"MIME/thought disagreement at {ci}/{pi}")
                info, decoded = inspect_image(saved.get("path"), saved, entry, "output-part")
                observed.append(info)
                if info and info["sha256"] != sha(data):
                    issue(entry, "raw-saved-bytes-mismatch", f"Saved bytes differ from raw response at {ci}/{pi}")
                if is_final:
                    raw_finals.append((info, decoded))
        if indexed:
            issue(entry, "unmatched-saved-part", "Saved image parts absent from raw response")
        entry["observedImageParts"] = observed
        entry["rawFinalImageCount"] = raw_final_count if raw else None
        entry["finalImageCount"] = raw_final_count if raw else len(saved_finals)
        if raw and raw_final_count != 1:
            issue(entry, "final-image-ambiguity" if raw_final_count > 1 else "final-image-missing",
                  f"Expected exactly one non-thought final image; observed {raw_final_count}")
        if raw_finals:
            # First is for failure display only when ambiguous, never an approved selection.
            entry["output"], image = raw_finals[0]
        if entry.get("output"):
            dimensions = entry["output"]["dimensions"]
            source_dimensions = (entry.get("source") or {}).get("dimensions")
            if source_dimensions:
                source_ratio = source_dimensions[0] / source_dimensions[1]
                output_ratio = dimensions[0] / dimensions[1]
                entry["geometryDiagnostics"] = {"sourceDimensions": source_dimensions,
                    "outputDimensions": dimensions, "sourceAspectRatio": source_ratio,
                    "outputAspectRatio": output_ratio, "aspectRatioDelta": output_ratio - source_ratio,
                    "relativeAspectRatioDelta": output_ratio / source_ratio - 1,
                    "manualFullViewRequired": True, "automaticApproval": False,
                    "note": "Inspect full native views for crop/pad/stretch; aspect agreement is not geometry verification. No disk resizing."}
            native_accepted = entry["inputGeometryPolicy"]["nativeAspectExceptionAccepted"]
            if min(dimensions) < 1500 or max(dimensions) < 2000:
                issue(entry, "output-not-highres", "Native result is not plausible 2K: " + str(dimensions))
            elif native_accepted and max(dimensions) > 3072:
                issue(entry, "output-unexpected-dimensions", "Authorized native result exceeds plausible 2K envelope: " + str(dimensions))
            if dimensions != KNOWN_2K:
                issue(entry, "output-unexpected-dimensions", "Expected observed Nano2K native dimensions [2400, 1792], got " + str(dimensions),
                      "caveat" if native_accepted else "provenance-warning" if documented_native_policy(expected) else "hard-technical-failure")
            if documented_native_policy(expected):
                issue(entry, "native-geometry-review", "CAVEAT: inspect complete native source/output for crop, padding or stretch; dimensions do not establish fidelity", "heuristic-review-flag")
            if dimensions == KNOWN_2K and policy is None:
                issue(entry, "model-approximate-aspect", "2400/1792 is model-approximate 4:3, not exact source 640/480; native bytes preserved", "caveat")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        issue(entry, "result-evidence-unavailable", error)
    return image


def artifact(path):
    return {"path": str(path.resolve()), "sha256": sha(path.read_bytes()), "bytes": path.stat().st_size}


def text_layout(source, candidate, profile=None):
    """Fixed source columns and source-only contrast threshold; never OCR or letter judgment."""
    band = (profile or {}).get("band", [0, 0, 1, 1])
    if (not isinstance(band, list) or len(band) != 4
            or not all(type(v) in (int, float) and np.isfinite(v) for v in band)
            or not (0 <= band[0] < band[2] <= 1 and 0 <= band[1] < band[3] <= 1)):
        band = [0, 0, 1, 1]
    reduced = candidate.resize(source.size, Image.Resampling.LANCZOS) if candidate is not None else None
    gray = np.asarray(source.convert("L"), dtype=float)
    background = np.asarray(source.convert("L").filter(ImageFilter.GaussianBlur(3)), dtype=float)
    source_contrast = np.abs(gray - background)
    threshold = max(8.0, float(np.percentile(source_contrast, 75)))
    masks = [source_contrast >= threshold]
    if reduced is not None:
        masks.append(np.abs(np.asarray(reduced.convert("L"), dtype=float) - np.asarray(
            reduced.convert("L").filter(ImageFilter.GaussianBlur(3)), dtype=float)) >= threshold)
    regions = []
    for col in range(4):
        box = [band[0] + (band[2] - band[0]) * col / 4, band[1],
               band[0] + (band[2] - band[0]) * (col + 1) / 4, band[3]]
        bounds = tuple(int(v * size) for v, size in zip(box, source.size * 2))
        crops = [m[bounds[1]:bounds[3], bounds[0]:bounds[2]] for m in masks]
        region = {"id": f"text-column-{col + 1}", "box": box}
        for role, mask in zip(("source", "candidate"), crops):
            rows = mask.mean(axis=1)
            columns = mask.mean(axis=0)
            active = rows >= .10
            region[role] = {"inkDensity": float(mask.mean()),
                            "rowDensityProjection": rows.tolist(),
                            "columnDensityProjection": columns.tolist(),
                            "contrastBandCount": int(np.count_nonzero(active & ~np.r_[False, active[:-1]]))}
        if len(crops) == 2:
            union = np.logical_or(*crops).sum()
            region["contrastShapeOverlap"] = float(np.logical_and(*crops).sum() / union) if union else None
            region["contrastBandCountDelta"] = region["candidate"]["contrastBandCount"] - region["source"]["contrastBandCount"]
        regions.append(region)
    return {"kind": "source-inscriptions", "method": "four fixed normalized source columns; absolute local contrast, Gaussian sigma 3 source pixels",
            "profileDefinedBy": "source-only; fixed columns and source contrast threshold independent of candidate",
            "band": band, "sourceContrastThreshold": threshold, "ocrPerformed": False, "automaticApproval": False,
            "letterFidelityAssessed": False, "manualReviewRequired": True,
            "note": "Generic regions, not OCR or recognized words. Shape overlap and contrast-band counts describe layout only; count differences are manual hints, not bad images or approval/rejection. Preserve existing inscriptions and drawings; no erase/add/rewrite. No legibility promise.",
            "regions": regions}


def failure_artifacts(assets, index, entry, source, candidate):
    text = entry.get("textDiagnostics")
    entry["judgingInputs"] = {"kind": "source-defined-text-columns-not-OCR" if text else "fixed-geometry-grid-not-hand-inventoried-objects",
                              "fullPair": {"source": entry.get("source"), "candidate": entry.get("output")}, "crops": []}
    regions = text["regions"] if text else [
        {"id": f"r{row + 1}c{col + 1}", "box": [col / 4, row / 3, (col + 1) / 4, (row + 1) / 3]}
        for row in range(3) for col in range(4)]
    for region in regions:
        box = region["box"]
        crop = {"id": region["id"], "box": box}
        for role, image in (("source", source), ("candidate", candidate)):
            crop[role] = None
            if image is not None:
                bounds = tuple(int(v * size) for v, size in zip(box, image.size * 2))
                path = assets / f"{index}-{region['id']}-{role}.png"
                image.crop(bounds).save(path)
                path.chmod(0o600)
                crop[role] = artifact(path)
        entry["judgingInputs"]["crops"].append(crop)


def usage_totals(records):
    totals = Counter()
    modalities = {}
    seen = set()
    count = cached = missing_usage = 0
    for path, usage, response_id, response_observed in records:
        key = response_id or path
        if key in seen:
            continue
        seen.add(key)
        count += int(response_observed)
        missing_usage += int(not usage)
        if isinstance(usage, dict):
            for key, value in usage.items():
                if type(value) in (int, float):
                    totals[key] += value
                elif key.endswith("TokensDetails") and isinstance(value, list):
                    details = modalities.setdefault(key, Counter())
                    for detail in value:
                        if isinstance(detail, dict) and type(detail.get("tokenCount")) in (int, float):
                            details[str(detail.get("modality", "UNKNOWN"))] += detail["tokenCount"]
            cached += int(usage.get("cachedContentTokenCount", 0) > 0)
    output = modalities.get("candidatesTokensDetails", {})
    unclassified = totals.get("candidatesTokenCount", 0) - sum(output.values())
    input_tokens = totals.get("promptTokenCount", 0)
    cached_tokens = totals.get("cachedContentTokenCount", 0)
    estimate = ((input_tokens - cached_tokens) * 1.5 + cached_tokens * .15 + output.get("IMAGE", 0) * 30
                + (output.get("TEXT", 0) + totals.get("thoughtsTokenCount", 0)) * 7.5) / 1_000_000
    return {"returnedResponseRecords": count, "observedCacheHits": cached, "numericTotals": dict(totals),
             "recordsWithMissingUsage": missing_usage,
             "modalityTotals": {key: dict(value) for key, value in modalities.items()},
            "catalogPriceEstimate": {"usd": estimate, "confirmedBilling": False,
                                     "unclassifiedCandidateTokens": unclassified,
                                     "ratesUsdPerMillionTokens": {"input": 1.5, "cachedInput": .15, "imageOutput": 30, "textAndThoughtOutput": 7.5},
                                     "note": "Catalog estimate for returned usage only, not invoice cost. Unknown calls may add charges; reused usage is historical, not new spend. Unclassified tokens are not priced; no credits assumed."},
            "notes": "Returned usage only; unknown/missing responses have unknown usage. Reused usage is historical, not new spend."}


def write_report(run, result, filename="report.html"):
    def text(value):
        return html.escape(str(value), quote=True)

    def pre(value):
        return "<pre>" + text(json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False)) + "</pre>"

    def frame(info, label, css):
        if not info:
            return f"<figure class='{css}'><figcaption>{text(label)}</figcaption><p class='missing'>Missing/unavailable image: explicit placeholder</p></figure>"
        uri = text(quote(os.path.relpath(info["path"], run), safe="/"))
        return (f"<figure class='{css}'><figcaption>{text(label)}; native {text(info.get('dimensions', 'crop'))}</figcaption>"
                f"<a href='{uri}'><img loading='lazy' src='{uri}' alt='{text(label)}'></a></figure>")

    page = ["<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
            "<title>Private Bulk Technical Diagnostics</title><style>",
            "body{font:16px system-ui;margin:24px;background:#eee;color:#222;overflow-wrap:anywhere}article{padding:18px;background:white;margin:20px 0}"
            ".frames{display:grid;grid-template-columns:1fr 1fr;gap:14px}figure{margin:0;min-width:0}img{width:100%;height:auto}"
            "pre{white-space:pre-wrap;overflow-wrap:anywhere}button{padding:8px;margin:4px}.missing{padding:35px;border:2px dashed #777}"
            ".ab-a .candidate,.ab-b .source{display:none}.ab-a .frames,.ab-b .frames{display:block}"
            "@media(max-width:700px){body{margin:8px}.frames{grid-template-columns:1fr}}",
            "</style><body><h1>Private Bulk Technical Diagnostics</h1>", pre(result["policy"]),
            "<h2>Aggregate</h2>", pre({k: result[k] for k in ("counts", "observedCounters", "usage", "nativeDimensions")}),
            "<details><summary>Excluded and Unresolved Original Bindings (" + str(len(result["exclusions"])) + ")</summary>", pre(result["exclusions"]), "</details>",
            "<details><summary>Conservative Calibration</summary>", pre(result["calibration"]), "</details>",
            "<h2>Failure Analysis (Authored Separately, Not Automatic Approval)</h2>",
            pre(result.get("failureAnalysis", "Not yet authored; structural fidelity remains unverified."))]
    page.append("<nav>" + " | ".join(f"<a href='#room-{i}'>" + text(room["id"]) + "</a>" for i, room in enumerate(result["rooms"])) + "</nav>")
    for index, room in enumerate(result["rooms"]):
        page.extend([f"<h2 id='room-{index}'>" + text(room["id"]) + "</h2><details><summary>Original Source Provenance and Room Aliases</summary>",
                     pre(room["metadata"]), "</details>"])
        for entry in room["entries"]:
            page.extend(["<article><h3>" + text(entry["id"]) + ": " + text(entry["status"]) + "</h3>",
                         "<h4>Image Validity / Availability</h4>", pre(entry["imageStatus"]),
                         pre([i for i in entry["issues"] if i["category"] == "image-validity"]),
                         "<h4>Provenance Completeness (Not Image Quality)</h4>", pre(entry["provenanceStatus"]),
                         pre([i for i in entry["issues"] if i["category"] == "provenance"]),
                         "<h4>Visual Review Warnings (Nonblocking)</h4>", pre(entry["visualReviewStatus"]),
                         pre([i for i in entry["issues"] if i["category"] in ("visual-review", "diagnostic")]),
                         "<section class='comparison'><button onclick=\"this.parentNode.className='comparison'\">Side by side</button>"
                         "<button onclick=\"this.parentNode.className='comparison ab-a'\">A: original</button>"
                         "<button onclick=\"this.parentNode.className='comparison ab-b'\">B: result</button><div class='frames'>",
                         frame(entry.get("source"), "A: original", "source"),
                         frame(entry.get("output"), "B: result (unverified)", "candidate"), "</div></section>",
                         "<details><summary>Evidence Hashes and Diagnostic Metrics (No MAE Ranking)</summary>", pre(entry), "</details>"])
            if entry.get("judgingInputs"):
                page.append("<details><summary>Fixed Geometry Grid Diagnostics, Not Hand-Inventoried Objects</summary>")
                for crop in entry["judgingInputs"]["crops"]:
                    page.extend(["<h4>" + crop["id"] + "</h4><div class='frames'>",
                                 frame(crop["source"], "Source crop", "source"),
                                 frame(crop["candidate"], "Candidate crop", "candidate"), "</div>"])
                page.append("</details>")
            page.append("</article>")
    page.append("</body></html>")
    path = private_path(run / filename)
    path.write_text("\n".join(page), encoding="utf-8")
    path.chmod(0o600)


def check(run_dir, report_name="report.html"):
    run = private_path(Path(run_dir).resolve())
    if not isinstance(report_name, str) or Path(report_name).name != report_name or not report_name.endswith(".html"):
        raise ValueError("report name must be an immediate-child HTML filename")
    manifest = read_json(run / "experiment.json")
    if manifest.get("schemaVersion", 1) != 1:
        raise ValueError("unsupported experiment schemaVersion")
    run.chmod(0o700)
    assets = private_path(run / "bulk-check-assets")
    assets.mkdir(mode=0o700, exist_ok=True)
    assets.chmod(0o700)
    result = {"schemaVersion": 1, "private": True, "manifest": artifact(run / "experiment.json"),
               "policy": POLICY, "calibration": calibration(), "rooms": [], "failures": [],
               "provenanceWarnings": [], "visualReviewWarnings": [],
               "exclusions": manifest.get("exclusions", manifest.get("sourceRegistry", {}).get("exclusions",
                   [d for d in manifest.get("sourceRegistry", {}).get("dispositions", [])
                    if d.get("disposition", "").startswith(("excluded", "unresolved"))])),
              "counts": {}, "observedCounters": {}, "nativeDimensions": {}}
    rooms = list(manifest.get("rooms", []))
    for job in manifest.get("reused", []):
        if not any(r["id"] == job.get("roomId") for r in rooms):
            rooms.append({"id": job.get("roomId"), "sourcePath": job.get("sourcePath"),
                          "source": job.get("source", {}), "provenance": job.get("provenance"),
                          "aliases": job.get("aliases", [])})
    # Do not silently drop orphan jobs.
    for job in manifest.get("jobs", []):
        if not any(r["id"] == job.get("roomId") for r in rooms):
            rooms.append({"id": job.get("roomId"), "sourcePath": None, "source": {}})
    usage = {"generation": [], "reused": []}
    all_entries = []
    for room in rooms:
        room_result = {"id": room.get("id"), "metadata": room, "entries": []}
        result["rooms"].append(room_result)
        jobs = [(origin, job) for origin, key in (("generation", "jobs"), ("reused", "reused"))
                for job in manifest.get(key, []) if job.get("roomId") == room.get("id")]
        if not jobs:
            jobs = [("missing", {"id": "no-candidate", "roomId": room.get("id")})]
        for origin, job in jobs:
            entry = {"id": job.get("id", job.get("roomId")), "roomId": room.get("id"),
                      "origin": origin, "issues": [], "structuralStatus": "unverified", "automaticApproval": False}
            for key in ("attemptId", "retryOf", "authorization", "authorizedAttempt"):
                if key in job:
                    entry[key] = job[key]
            source_meta = room.get("source") or {}
            # Historical reused entries can recover frozen source metadata without trusting image bytes.
            if not source_meta.get("sha256") and origin == "reused":
                try:
                    request = read_json(private_path(job["resultPath"]).with_name("request.json"))
                    source_meta = next(a for a in request.get("attachments", []) if a.get("role") == "source-composition")
                except (OSError, ValueError, KeyError, StopIteration):
                    pass
            source_info, source = inspect_image(room.get("sourcePath"), source_meta, entry, "source")
            entry["source"] = source_info
            if source_info and source_info["dimensions"] != [640, 480]:
                if documented_native_policy(job):
                    if not native_policy(job, entry):
                        issue(entry, "geometry-policy-mismatch", "Declared geometry policy does not match actual native source dimensions")
                else:
                    issue(entry, "source-dimensions", "Original source must be native 640x480")
            if origin == "missing":
                candidate = None
                issue(entry, "candidate-missing", "No generation or reused candidate declared for room")
            else:
                candidate = check_candidate(run, job, entry, usage[origin])
            profile = room.get("textInspection", {})
            if isinstance(profile, dict) and profile.get("required") is True and profile.get("kind") == "source-inscriptions":
                entry["textInspection"] = profile
                if source is not None:
                    entry["textDiagnostics"] = text_layout(source, candidate, profile)
                issue(entry, "text-preservation-review", "Explicit source-inscriptions profile: paired native crops and full views require manual inscription/drawing preservation review; no OCR or letter-fidelity verdict", "diagnostic")
            if source is not None and candidate is not None and min(source.size) > 32:
                entry["diagnostics"] = diagnostics(source, candidate)
                metrics = entry["diagnostics"]
                thresholds = result["calibration"]["thresholds"]
                if metrics["edgeGradientCosine"] < thresholds["edgeCosineBelow"]:
                    issue(entry, "low-edge-agreement", "Low edge cosine can reflect texture cleanup; not evidence of bad geometry", "diagnostic")
                for patch in metrics["localizedColor"]["patches"]:
                    if patch["warnings"]:
                        issue(entry, "localized-color-warning", json.dumps(patch, ensure_ascii=True), "heuristic-review-flag")
                if max(abs(n) for n in metrics["meanDriftRGB"]) > thresholds["absoluteChannelDriftAbove"]:
                    issue(entry, "large-color-drift", "Large whole-frame mean RGB drift", "heuristic-review-flag")
                if any(max(abs(n) for n in c["meanDriftRGB"]) > thresholds["gridChannelDriftAbove"] for c in metrics["geometryGrid"]):
                    issue(entry, "local-color-drift", "Large mean RGB drift within fixed geometry grid", "heuristic-review-flag")
                alignment = metrics["alignment"]
                if (max(abs(n) for n in alignment["bestOffsetXY"]) > thresholds["alignmentPixelsAbove"] and
                        alignment["relativeImprovement"] > thresholds["alignmentImprovementAbove"]):
                    issue(entry, "alignment-drift", "Large translation improves low-frequency diagnostic agreement; inspect composition", "heuristic-review-flag")
            hard = any(i["severity"] == "hard-technical-failure" for i in entry["issues"])
            flagged = any(i["severity"] == "heuristic-review-flag" for i in entry["issues"])
            available = source is not None and candidate is not None
            entry["imageStatus"] = "unavailable" if not available else "invalid" if hard else "valid"
            entry["provenanceStatus"] = "incomplete-or-inconsistent" if any(i["category"] == "provenance" and i["severity"] != "caveat" for i in entry["issues"]) else "complete"
            entry["visualReviewStatus"] = "not-assessed" if not available else "warnings" if flagged else "manual-review-required"
            entry["status"] = "unavailable" if not available else "blocked" if hard else "heuristic-review-flag" if flagged else "technical-valid-but-structurally-unverified"
            entry["technicalStatus"] = entry["imageStatus"]
            if hard or flagged or entry.get("textDiagnostics"):
                failure_artifacts(assets, len(all_entries), entry, source, candidate)
            panel = {k: entry[k] for k in ("id", "roomId", "origin", "status", "imageStatus", "provenanceStatus", "visualReviewStatus", "issues")}
            if entry.get("judgingInputs"):
                panel["judgingInputs"] = entry["judgingInputs"]
            if entry["imageStatus"] != "valid":
                result["failures"].append(panel)
            if flagged:
                result["visualReviewWarnings"].append(panel)
            if entry["provenanceStatus"] != "complete":
                result["provenanceWarnings"].append(panel)
            room_result["entries"].append(entry)
            all_entries.append(entry)
        room_result["counts"] = dict(Counter(e["status"] for e in room_result["entries"]))
    result["counts"] = {"rooms": len(rooms), "generationPlanned": len(manifest.get("jobs", [])),
                        "reusedPlanned": len(manifest.get("reused", [])), "entries": len(all_entries),
                         "statuses": dict(Counter(e["status"] for e in all_entries)),
                         "imageStatuses": dict(Counter(e["imageStatus"] for e in all_entries)),
                         "provenanceStatuses": dict(Counter(e["provenanceStatus"] for e in all_entries)),
                         "visualReviewStatuses": dict(Counter(e["visualReviewStatus"] for e in all_entries)),
                        "issueKinds": dict(Counter(i["kind"] for e in all_entries for i in e["issues"])),
                        "heuristicFlagged": sum(any(i["severity"] == "heuristic-review-flag" for i in e["issues"]) for e in all_entries)}
    result["observedCounters"] = {origin: {"savedStatuses": dict(Counter(e.get("observedStatus", "missing") for e in all_entries if e["origin"] == origin)),
                                          "withStartedAt": sum(bool(e.get("startedAt")) for e in all_entries if e["origin"] == origin),
                                          "savedImageParts": sum(len(e.get("observedImageParts", [])) for e in all_entries if e["origin"] == origin)}
                                  for origin in usage}
    result["usage"] = {origin: usage_totals(records) for origin, records in usage.items()}
    result["nativeDimensions"] = dict(Counter("x".join(map(str, e["output"]["dimensions"])) for e in all_entries if e.get("output")))
    analysis = run / "failure-analysis.json"
    if analysis.exists():
        try:
            result["failureAnalysis"] = read_json(analysis)
        except (OSError, ValueError) as error:
            result["failureAnalysis"] = {"error": str(error)}
    path = private_path(run / "bulk-check.json")
    path.write_text(json.dumps(result, indent=2, ensure_ascii=True, allow_nan=False) + "\n", encoding="utf-8")
    path.chmod(0o600)
    write_report(run, result, report_name)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    result = check(args.run_dir)
    print(json.dumps({"counts": result["counts"], "json": str(args.run_dir.resolve() / "bulk-check.json"),
                      "report": str(args.run_dir.resolve() / "report.html")}))
    return 1 if any(e["imageStatus"] != "valid" for r in result["rooms"] for e in r["entries"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
