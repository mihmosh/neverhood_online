#!/usr/bin/env python3
"""Offline, diagnostic-only evaluation of a Gemini experiment directory."""

import argparse
import html
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import textwrap
from urllib.parse import quote

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


DISCLAIMER = (
    "These metrics do not prove the absence of hallucinations. Resizing to the "
    "source aspect ratio can obscure geometric drift. No images are approved "
    "or exported to runtime by this report."
)
OBJECT_REGIONS_PATH = Path(__file__).with_name("object-regions.json")
EVALUATION_POLICY = {"primary": "object-first", "diagnosticOnlyPixels": True,
                     "automaticApproval": False}


def validate_profiles(profile):
    if profile.get("schemaVersion") != 1 or not isinstance(profile.get("rooms"), dict):
        raise ValueError("invalid object region profiles")
    for regions in profile["rooms"].values():
        ids = set()
        if not isinstance(regions, list) or not regions:
            raise ValueError("object regions must be a nonempty list")
        for region in regions:
            identifier, box = region["id"], region["box"]
            if (not isinstance(identifier, str) or not identifier or identifier in ids
                    or not isinstance(region["label"], str) or not isinstance(box, list) or len(box) != 4
                    or any(type(value) not in (int, float) or not math.isfinite(value)
                           or not 0 <= value <= 1 for value in box)
                    or box[0] >= box[2] or box[1] >= box[3]):
                raise ValueError("invalid object region")
            ids.add(identifier)
    return profile["rooms"]


def load_profiles():
    return validate_profiles(json.loads(OBJECT_REGIONS_PATH.read_text(encoding="utf-8")))


def profile_fingerprint(regions):
    # IEEE-754 bytes preserve every coordinate bit identically in both runtimes.
    value = [[region["id"], region["label"], [struct.pack(">d", float(n)).hex() for n in region["box"]]]
             for region in regions]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def object_crop(image, box, max_edge):
    bounds = (int(box[0] * image.width), int(box[1] * image.height),
              max(int(box[0] * image.width) + 1, int(box[2] * image.width)),
              max(int(box[1] * image.height) + 1, int(box[3] * image.height)))
    crop = image.crop(bounds)
    scale = max_edge / max(crop.size)
    return crop.resize((max(1, round(crop.width * scale)),
                        max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)


def validated_judge(path, source_hash, candidate_hash, regions, crop_regions=None, frozen=False):
    judge = json.loads(path.read_text(encoding="utf-8"))
    if (judge.get("schemaVersion") != 2 or judge.get("evaluationVersion") != "objects-v2"
            or judge.get("status") != "succeeded" or not judge.get("model")):
        raise ValueError("missing successful objects-v2 judgment")
    inputs = judge["inputs"]
    for role, digest in (("source", source_hash), ("candidate", candidate_hash)):
        matches = [item for item in inputs if item.get("role") == role]
        if len(matches) != 1 or matches[0].get("sha256") != digest:
            raise ValueError("stale or invalid objects-v2 input hashes")
    if frozen or "profileFingerprint" in judge:
        if judge.get("profileFingerprint") != profile_fingerprint(regions):
            raise ValueError("stale or missing objects-v2 profile fingerprint")
        if not crop_regions:
            raise ValueError("missing current object crops")
        for region in crop_regions:
            for role in ("source", "candidate"):
                matches = [item for item in inputs if item.get("role") == f"{role}-crop:{region['id']}"]
                digest = hashlib.sha256(Path(region[role + "Path"]).read_bytes()).hexdigest()
                if len(matches) != 1 or matches[0].get("sha256") != digest:
                    raise ValueError("stale or invalid objects-v2 crop hashes")
    elif "rubric" in judge:
        # Concrete legacy records contain the registered profile in their prompt.
        marker = "\nRegistered regions: "
        if marker not in judge["rubric"] or json.loads(judge["rubric"].split(marker)[-1]) != regions:
            raise ValueError("stale objects-v2 registered regions")
    judgment = judge["judgment"]
    objects = judgment["objects"]
    ids = [item["id"] for item in objects]
    if len(ids) != len(set(ids)) or set(ids) != {region["id"] for region in regions}:
        raise ValueError("objects-v2 coverage does not match configured regions")
    statuses = []
    for item in objects:
        statuses.extend(item[key] for key in ("presence", "silhouette", "internalGeometry", "count"))
        if not isinstance(item["evidence"], str):
            raise ValueError("invalid object evidence")
    global_result = judgment["global"]
    statuses.append(global_result["composition"]["status"])
    if (any(status not in ("preserved", "changed", "uncertain") for status in statuses)
            or not isinstance(global_result["composition"]["evidence"], str)
            or not isinstance(global_result["addedObjects"], list)
            or not isinstance(global_result["removedObjects"], list)
            or not isinstance(judgment["uncertainties"], list)
            or any(not isinstance(item, str) for item in judgment["uncertainties"])):
        raise ValueError("invalid objects-v2 judgment")
    decision = judge["decision"]
    if (decision["verdict"] not in ("reject", "review", "no-structural-change-detected")
            or decision.get("automaticApproval") is not False
            or not isinstance(decision["reasons"], list)
            or any(not isinstance(reason, str) for reason in decision["reasons"])):
        raise ValueError("invalid objects-v2 decision")
    # Never allow an inconsistent model decision to hide structural changes.
    if ("changed" in statuses or global_result["addedObjects"] or global_result["removedObjects"]):
        decision = {**decision, "verdict": "reject",
                    "reasons": decision["reasons"] + ["Structural change detected"]}
    elif ("uncertain" in statuses or judgment["uncertainties"]) and decision["verdict"] != "reject":
        decision = {**decision, "verdict": "review",
                    "reasons": decision["reasons"] + ["Structural uncertainty requires review"]}
    return {**judge, "decision": decision}


def load_rgb(path):
    with Image.open(path) as image:
        return image.convert("RGB")


def metrics(source, candidate):
    """Measure RGB errors in 8-bit units; drift is candidate minus source."""
    reduced = candidate.resize(source.size, Image.Resampling.LANCZOS)
    original = np.asarray(source, dtype=np.float64)
    delta = np.asarray(reduced, dtype=np.float64) - original
    low_delta = (
        np.asarray(reduced.filter(ImageFilter.GaussianBlur(2)), dtype=np.float64)
        - np.asarray(source.filter(ImageFilter.GaussianBlur(2)), dtype=np.float64)
    )
    gradients = []
    for image in (source, reduced):
        luminance = np.asarray(image, dtype=np.float64) @ np.array([0.2126, 0.7152, 0.0722])
        gradients.append(np.concatenate((np.diff(luminance, axis=0).ravel(),
                                         np.diff(luminance, axis=1).ravel())))
    norms = [float(np.linalg.norm(gradient)) for gradient in gradients]
    cosine = (float(np.dot(*gradients) / (norms[0] * norms[1]))
              if all(norms) else float(norms[0] == norms[1]))
    return {
        "rgbMAE": float(np.abs(delta).mean()),
        "rgbRMSE": float(np.sqrt(np.square(delta).mean())),
        "meanDriftRGB": delta.mean(axis=(0, 1)).tolist(),
        "lowpassMAE": float(np.abs(low_delta).mean()),
        "edgeGradientCosine": float(np.clip(cosine, -1, 1)),
        "aspectRatioRelativeError": abs((candidate.width / candidate.height)
                                        / (source.width / source.height) - 1),
        "nativeDimensions": [candidate.width, candidate.height],
        "scaleX": candidate.width / source.width,
        "scaleY": candidate.height / source.height,
    }


def relative_uri(path, run_dir):
    return quote(Path(os.path.relpath(path, run_dir)).as_posix(), safe="/")


def label_for(entry):
    if entry["kind"] == "source":
        return "Source (original)"
    if entry["kind"] == "control":
        return "CONTROL: " + entry["control"]
    return " | ".join(str(entry.get(key, "?")) for key in
                      ("id", "promptVariant", "referenceMode", "model"))


def metric_label(entry):
    value = entry.get("metrics")
    if not value:
        return ""
    drift = ", ".join(f"{channel:.2f}" for channel in value["meanDriftRGB"])
    return (f"MAE {value['rgbMAE']:.3f}; RMSE {value['rgbRMSE']:.3f}; "
            f"lowpass {value['lowpassMAE']:.3f}; edge {value['edgeGradientCosine']:.4f}; "
            f"aspect error {value['aspectRatioRelativeError']:.4%}; "
            f"drift RGB [{drift}]; {value['nativeDimensions'][0]}x"
            f"{value['nativeDimensions'][1]}; scale {value['scaleX']:.3f}x,"
            f"{value['scaleY']:.3f}y")


def evaluate(run_dir):
    run_dir = Path(run_dir).resolve()
    run_dir.chmod(0o700)
    with (run_dir / "experiment.json").open(encoding="utf-8") as handle:
        experiment = json.load(handle)
    if experiment.get("schemaVersion") != 1:
        raise ValueError("experiment.json must have schemaVersion 1")
    assets = run_dir / "eval-assets"
    assets.mkdir(mode=0o700, exist_ok=True)
    assets.chmod(0o700)
    try:
        frozen = "regionProfiles" in experiment
        profiles = (validate_profiles({"schemaVersion": 1, **experiment["regionProfiles"]})
                    if frozen else load_profiles())
        profile_error = None
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        profiles, profile_error = {}, "Object region profiles unavailable or invalid: " + str(error)
    result = {"schemaVersion": 1, "disclaimer": DISCLAIMER,
              "evaluationPolicy": EVALUATION_POLICY, "private": True,
              "metricNotes": {
                  "comparison": "RGB, Lanczos resized to original source dimensions",
                  "meanDriftRGB": "candidate minus source, in RGB order, 0..255 units",
                  "lowpassMAE": "Gaussian sigma 2 pixels on source and reduced candidate",
                  "edgeGradientCosine": "forward finite gradients of Rec.709 luminance; both flat = 1, one flat = 0",
               }, "rooms": [], "skipped": []}
    rooms = list(experiment.get("rooms", []))
    for control in experiment.get("controls", []):
        identifier = control.get("roomId", control.get("id"))
        if control.get("sourcePath") and not any(str(room.get("id")) == str(identifier) for room in rooms):
            rooms.append({"id": identifier, "sourcePath": control["sourcePath"], "controlOnly": True})

    def resolve(value):
        path = Path(value)
        return path if path.is_absolute() else run_dir / path

    def skipped(identifier, error):
        reason = str(error).replace(str(run_dir) + os.sep, "")
        result["skipped"].append({"id": str(identifier), "reason": reason})

    report = ["<!doctype html><html><head><meta charset='utf-8'>",
              "<title>Offline Gemini Evaluation</title><style>",
              "body{font:16px sans-serif;margin:24px;background:#eee;color:#222}"
              "img{max-width:100%;height:auto}article{background:white;padding:16px;margin:16px 0}"
              ".frames{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}"
              ".frames figure{min-width:0;margin:0}.frames img{width:100%;height:auto}"
              ".ab .frames{display:block}.ab .frames figure{display:none}"
              ".ab.a .frames .original,.ab.b .frames .restored{display:block}"
              "button{padding:8px;margin:4px}nav a{margin-right:12px}"
              "@media(max-width:650px){body{margin:10px}.frames{grid-template-columns:1fr}}"
               ".crops{display:flex;gap:12px}.crops figure{flex:1;min-width:0;margin:0}"
               ".crops img{width:100%;object-fit:contain}"
              "p{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>",
              "<h1>Private Pilot Evaluation</h1><p>Local private artifacts only. " + html.escape(DISCLAIMER) + "</p>",
              "<h2>Object-First Evaluation Policy</h2><p>Hallucinations, object presence, silhouette, "
              "internal geometry, count and composition determine structural status. "
              "diagnosticOnlyPixels: true. Pixel metrics never rank or approve candidates. "
              "Missing or stale objects-v2 judgments are blocked. No automatic approval.</p>",
              "<p>Errors use 8-bit RGB units at source resolution. Drift is candidate minus source. "
              "Lowpass uses Gaussian sigma 2; edge cosine uses finite luminance gradients. "
              "Both flat gradients score 1; one flat scores 0. Crops use identical normalized "
                "coordinates in each native image. Controls are not experiment candidates.</p>"]
    report.append("<nav>" + " ".join(
        f"<a href='#room-{i}'>{html.escape(str(room.get('id', i)))}</a>"
        for i, room in enumerate(rooms)) + "</nav>")
    for filename, title in (("run-summary.json", "Aggregate Run Summary"),
                            ("pilot-summary.json", "Aggregate Pilot Summary"),
                             ("capability.json", "Capability Evidence"),
                             ("capability-report.json", "Capability Report"),
                             ("reconciliation.json", "Unknown Outcome Recovery Evidence"),
                             ("visual-review.json", "Subjective Appearance Notes (Not Structural Evidence)")):
        optional = run_dir / filename
        if optional.exists():
            try:
                value = json.loads(optional.read_text(encoding="utf-8"))
                result[filename.removesuffix(".json")] = value
                report.append("<details><summary>" + title + "</summary><pre>"
                              + html.escape(json.dumps(value, indent=2)) + "</pre></details>")
            except (OSError, ValueError) as error:
                skipped(filename, error)
    if "pilot-summary" in result:
        summary = result["pilot-summary"]
        rows = {key: summary.get(key) for key in ("planned", "submitted", "succeeded", "failed", "unknown", "structuralDecisions", "transport")}
        rows["Confirmed Cache Hits"] = {key: summary.get(key, {}).get("observedCacheHits", 0) for key in ("generationUsage", "judgeUsage")}
        rows["Cost"] = summary.get("cost", {}).get("status", "unverified")
        report.append("<h2>Pilot Status</h2><table>" + "".join(
            "<tr><th>" + html.escape(key) + "</th><td>" + html.escape(json.dumps(value)) + "</td></tr>"
            for key, value in rows.items()) + "</table><p>Stopped after ten submissions. Unknown outcomes were not retried. "
            "No structural change detected is not approval. Usage covers returned responses only; cost remains unverified.</p>")
    if "visual-review" not in result:
        report.append("<p>Subjective appearance notes: not yet authored. Structural judgments below "
                      "do not evaluate beauty, texture preference or perceived realism.</p>")
    findings_path = run_dir / "findings.json"
    if findings_path.exists():
        findings = json.loads(findings_path.read_text(encoding="utf-8"))
        result["findings"] = findings
        report.append("<details><summary>Historical findings (superseded; not an active "
                      "object-first decision)</summary><pre>"
                      + html.escape(json.dumps(findings, indent=2)) + "</pre></details>")
    object_findings_path = run_dir / "object-findings.json"
    if object_findings_path.exists():
        object_findings = json.loads(object_findings_path.read_text(encoding="utf-8"))
        result["objectFindings"] = object_findings
        report.append("<h2>Object-First Findings</h2><pre>"
                      + html.escape(json.dumps(object_findings, indent=2)) + "</pre>")
    for room_index, room in enumerate(rooms):
        room_id = str(room.get("id", room_index))
        try:
            source_path = resolve(room["sourcePath"])
            source = load_rgb(source_path)
        except (OSError, ValueError, TypeError, KeyError) as error:
            skipped(room_id, error)
            continue
        slug = re.sub(r"[^A-Za-z0-9_.-]", "_", room_id).strip(".") or "room"
        prefix = f"{room_index}-{slug}"
        regions = profiles.get(room_id, [])
        source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
        entries = [{"kind": "source", "path": str(source_path)}]
        unavailable_jobs = []
        control_path = assets / f"{prefix}-lanczos4x.png"
        source.resize((source.width * 4, source.height * 4), Image.Resampling.LANCZOS).save(control_path)
        entries.append({"kind": "control", "control": "Source Lanczos 4x", "path": str(control_path)})
        if room.get("baselinePath") and resolve(room["baselinePath"]).exists():
            entries.append({"kind": "control", "control": "Existing Gemini baseline",
                            "path": str(resolve(room["baselinePath"]))})
        for control in experiment.get("controls", []):
            if str(control.get("roomId", control.get("id"))) == room_id:
                try:
                    entries.append({"kind": "control", "control": control.get("label", control.get("id", "Existing control")),
                                    "path": str(resolve(control["path"]))})
                except (TypeError, KeyError) as error:
                    skipped(control.get("id", "control"), error)
        for job in experiment.get("jobs", []):
            if room.get("controlOnly"):
                continue
            if job.get("roomId") != room.get("id"):
                continue
            job_id = job.get("id")
            try:
                # Job IDs name immediate children, never arbitrary filesystem paths.
                if not isinstance(job_id, str) or not job_id or job_id in (".", "..") or Path(job_id).name != job_id:
                    raise ValueError("invalid job id")
                with (run_dir / "jobs" / job_id / "result.json").open(encoding="utf-8") as handle:
                    artifact = json.load(handle)
                if artifact.get("status") != "succeeded":
                    skipped(job_id, "job did not succeed")
                    unavailable_jobs.append({"id": job_id, "status": artifact.get("status", "unknown"),
                                             "verdict": "blocked", "reason": "No saved successful final image; never retry an unknown paid outcome"})
                    continue
                finals = [image for image in artifact.get("images", [])
                          if isinstance(image, dict) and not image.get("thought", False)]
                if not finals:
                    raise ValueError("no final non-thought image")
                entries.append({**{key: job.get(key) for key in
                                   ("id", "model", "promptVariant", "referenceMode")},
                                "kind": "candidate", "path": str(resolve(finals[-1]["path"]))})
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                skipped(job_id, error)
                unavailable_jobs.append({"id": job_id, "status": "unavailable", "verdict": "blocked",
                                         "reason": str(error).replace(str(run_dir) + os.sep, "")})
        evaluated = []
        cards = []
        report.append(f"<h2 id='room-{room_index}'>" + html.escape(room_id) + "</h2>"
                      + f"<p>Original native dimensions: {source.width}x{source.height}</p>")
        for unavailable in unavailable_jobs:
            report.append("<article><h3>Result unavailable: blocked</h3><pre>"
                          + html.escape(json.dumps(unavailable, indent=2)) + "</pre></article>")
        metadata = {key: room[key] for key in ("provenance", "inventory", "resourceId") if key in room}
        if metadata:
            report.append("<details><summary>Source Provenance and Inventory</summary><pre>"
                          + html.escape(json.dumps(metadata, indent=2)) + "</pre></details>")
        visual_review = result.get("visual-review", {})
        appearance_rooms = visual_review.get("rooms", {}) if isinstance(visual_review, dict) else {}
        appearance = appearance_rooms.get(room_id) if isinstance(appearance_rooms, dict) else None
        report.append("<h3>Subjective Appearance Notes</h3><p>Separate from structural decisions; "
                      "not an approval or a pixel ranking.</p><pre>"
                      + html.escape(json.dumps(appearance, indent=2) if appearance is not None
                                    else "Not yet authored for this room.") + "</pre>")
        for index, entry in enumerate(entries):
            try:
                image = load_rgb(entry["path"])
            except (OSError, ValueError, TypeError) as error:
                skipped(entry.get("id", entry.get("control", room_id)), error)
                continue
            if entry["kind"] != "source":
                entry["metrics"] = metrics(source, image)
            entry["sha256"] = hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest()
            entry["nativeDimensions"] = list(image.size)
            entry["objectRegions"] = []
            if entry["kind"] == "candidate":
                job_dir = run_dir / "jobs" / entry["id"]
                for region_index, region in enumerate(regions):
                    # Native normalized coordinates; never warp to source aspect ratio.
                    box = region["box"]
                    native_edge = max(max(1, int(box[2] * image.width) - int(box[0] * image.width)),
                                      max(1, int(box[3] * image.height) - int(box[1] * image.height)))
                    display_edge = min(768, native_edge)
                    paths = {}
                    for role, original in (("source", source), ("candidate", image)):
                        crop_path = assets / f"{prefix}-{index}-object{region_index}-{role}.png"
                        object_crop(original, box, display_edge).save(crop_path)
                        paths[role + "Path"] = str(crop_path.resolve())
                    entry["objectRegions"].append({**region, **paths})
                manifest = {"schemaVersion": 1, "sourceSha256": source_hash,
                             "candidateSha256": entry["sha256"], "regions": entry["objectRegions"],
                             "profileFingerprint": profile_fingerprint(regions)}
                (job_dir / "object-inputs.json").write_text(json.dumps(manifest, indent=2) + "\n",
                                                            encoding="utf-8")
                try:
                    if not regions:
                        raise ValueError(profile_error or "No object regions configured for room")
                    entry["semanticJudge"] = validated_judge(job_dir / "judge-objects-v2.json",
                                                               source_hash, entry["sha256"], regions,
                                                               entry["objectRegions"], frozen=frozen)
                    entry["decision"] = entry["semanticJudge"]["decision"]
                except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                    reason = str(error).replace(str(run_dir) + os.sep, "")
                    entry["decision"] = {"verdict": "blocked", "status": "not-evaluated",
                                         "reasons": [reason], "automaticApproval": False}
            entry["uri"] = relative_uri(entry["path"], run_dir)
            label = label_for(entry)
            details = metric_label(entry)
            structural = ("Blind judge decision: " + entry["decision"]["verdict"]
                          if entry["kind"] == "candidate" else "Reference only; not a candidate")
            report.append(f"<article><h3>{html.escape(label)}</h3><h4>{html.escape(structural)}</h4>")
            if entry.get("decision"):
                report.append("<pre>" + html.escape(json.dumps(entry["decision"], indent=2)) + "</pre>")
            report.append(f"<details><summary>Diagnostic pixel metrics only (not a decision)</summary>"
                          f"<p>{html.escape(details)}</p></details>")
            report.append("<section class='comparison'><p>"
                          "<button type='button' onclick=\"this.closest('section').className='comparison'\">Side by side</button>"
                          "<button type='button' onclick=\"this.closest('section').className='comparison ab a'\">A: original</button>"
                          "<button type='button' onclick=\"this.closest('section').className='comparison ab b'\">B: result</button>"
                          "</p><div class='frames'>")
            for css, frame_path, caption, dimensions in (
                    ("original", source_path, "A: original", source.size),
                    ("restored", entry["path"], "B: " + label, image.size)):
                uri = html.escape(relative_uri(frame_path, run_dir), quote=True)
                report.append(f"<figure class='{css}'><figcaption>{html.escape(caption)}; native "
                              f"{dimensions[0]}x{dimensions[1]}</figcaption><a href='{uri}'>"
                              f"<img src='{uri}' alt='{html.escape(caption, quote=True)}'></a></figure>")
            report.append("</div></section>")
            object_statuses = {item["id"]: item for item in
                               entry.get("semanticJudge", {}).get("judgment", {}).get("objects", [])}
            for region in entry["objectRegions"]:
                report.append("<h4>" + html.escape(region["label"]) + "</h4><div class='crops'>")
                for role in ("source", "candidate"):
                    crop_uri = relative_uri(region[role + "Path"], run_dir)
                    report.append(f"<figure><figcaption>{role.title()}</figcaption>"
                                  f"<img src='{html.escape(crop_uri, quote=True)}' "
                                  f"alt='{role} object crop'></figure>")
                report.append("</div><pre>" + html.escape(json.dumps(
                    object_statuses.get(region["id"], {"status": "not-evaluated"}), indent=2)) + "</pre>")
            if entry.get("semanticJudge"):
                report.append("<p>Blinded model-assisted judgment (not ground truth):</p><pre>"
                              + html.escape(json.dumps({key: entry["semanticJudge"][key] for key in
                                                        ("model", "status", "judgment", "decision")}, indent=2))
                               + "</pre>")
            report.append("</article>")
            card = Image.new("RGB", (640, 480), "white")
            thumbnail = image.copy()
            thumbnail.thumbnail((620, 330), Image.Resampling.LANCZOS)
            card.paste(thumbnail, ((640 - thumbnail.width) // 2, 5))
            draw = ImageDraw.Draw(card)
            # Pillow's built-in font is deliberately used to avoid host font dependencies.
            caption = (label + "\n" + structural + "\nPixels: diagnostic only; no automatic approval").encode("ascii", "replace").decode("ascii")
            lines = []
            for line in caption.splitlines():
                lines.extend(textwrap.wrap(line, width=85))
            draw.multiline_text((10, 345), "\n".join(lines), fill="black", spacing=3)
            cards.append(card)
            evaluated.append(entry)
        sheet = Image.new("RGB", (640 * 3, 480 * math.ceil(len(cards) / 3)), "#dddddd")
        for index, card in enumerate(cards):
            sheet.paste(card, ((index % 3) * 640, (index // 3) * 480))
        sheet_path = assets / f"{prefix}-contact.jpg"
        sheet.save(sheet_path, quality=90)
        report.append(f"<p><a href='{relative_uri(sheet_path, run_dir)}'>Room contact sheet</a></p>")
        result["rooms"].append({"id": room.get("id"), "sourceDimensions": list(source.size),
                                **metadata, "entries": evaluated, "contactSheet": relative_uri(sheet_path, run_dir)})
    report.append("<h2>Skipped Artifacts</h2><ul>")
    for item in result["skipped"]:
        report.append("<li>" + html.escape(item["id"] + ": " + item["reason"]) + "</li>")
    report.append("</ul></body></html>")
    (run_dir / "eval.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    (run_dir / "report.html").write_text("\n".join(report), encoding="utf-8")
    assets.chmod(0o700)
    for output in [run_dir / "eval.json", run_dir / "report.html", *assets.iterdir(),
                   *run_dir.glob("jobs/*/object-inputs.json")]:
        output.chmod(0o600)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    evaluate(args.run_dir)
    print(args.run_dir / "eval.json")
    print(args.run_dir / "report.html")


if __name__ == "__main__":
    main()
