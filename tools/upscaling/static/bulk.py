#!/usr/bin/env python3
"""Index static-use candidates and process every verified image-guided binding."""

import argparse
from collections import Counter
from contextlib import closing
from copy import deepcopy
import fcntl
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

import numpy as np
import PIL
from PIL import Image
import scipy

from contour_pilot import canonical, immutable, matte, overlay, save, sha, zoom_box
from pipeline import process_asset
from prepared import build_prepared_catalog
from resolve import resolve_candidates
from source_inventory import private_output, scan_source

ROOT = Path(__file__).resolve().parents[3]


def select_background(row):
    """Retain upstream caveats; file integrity is not structural approval."""
    entries = [entry for entry in row.get("entries", []) if entry.get("observedStatus") == "succeeded" and entry.get("output")]
    if len(entries) != 1:
        raise ValueError("missing-or-ambiguous-restored-background")
    entry = entries[0]
    if entry.get("modelVersion") != "gemini-nano-banana-2.1":
        raise ValueError("unverified-selected-Nano-background-model")
    return {"roomId": row["id"], "resourceId": row["metadata"]["resourceId"].lower().removeprefix("0x"),
            "source": row["metadata"]["source"], "provenance": row["metadata"]["provenance"],
            "output": entry["output"], "resultPath": entry.get("resultPath"),
            "resultSHA256": entry.get("resultSha256"), "upstreamStatus": entry.get("status"),
            "structuralStatus": entry.get("structuralStatus", "unverified"),
            "technicalStatus": entry.get("technicalStatus"), "issues": entry.get("issues", []),
            "modelVersion": entry["modelVersion"], "generationRequestId": entry["id"], "origin": entry.get("origin"),
            "automaticApproval": False}


def attach_backgrounds(assets, background_check):
    """Join by explicit scene/resource, never by nearest filename or dimensions."""
    selected = []
    for original in assets:
        item = deepcopy(original)
        if item.get("processingStatus") == "mapped-prepared":
            selected.append(item)
            continue
        if item.get("processingStatus") != "eligible":
            selected.append(item)
            continue
        try:
            if "backgroundRef" in item:
                ref = item["backgroundRef"]
                background = select_background(ref) if "entries" in ref else ref
            else:
                matches = [row for row in background_check["rooms"]
                           if row["id"] == item["scene"]
                           and row["metadata"]["resourceId"].lower().removeprefix("0x") == item["backgroundResource"]]
                if len(matches) != 1:
                    raise ValueError("missing-or-ambiguous-scene-background-binding")
                background = select_background(matches[0])
            if item.get("backgroundSourceSHA256") and item["backgroundSourceSHA256"] != background["source"]["sha256"]:
                # PNG byte encodings can differ; compare decoded pixels, not filenames.
                with Image.open(item["backgroundSourcePath"]) as a, Image.open(background["source"]["path"]) as b:
                    if a.size != b.size or not np.array_equal(np.asarray(a.convert("RGB")), np.asarray(b.convert("RGB"))):
                        raise ValueError("original-background-pixels-differ")
            if background["provenance"]["catalogSourceBinding"] != item["asset"]["sourceIdentity"]["sourceBinding"]:
                raise ValueError("background-game-source-binding-differs")
            item["backgroundRef"] = background
        except (KeyError, ValueError, OSError) as error:
            item["processingStatus"] = "blocked"
            item.setdefault("blockedReasons", []).append(str(error))
        selected.append(item)
    return selected


def open_index(path):
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.executescript("""
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, selection_path TEXT, selection_sha256 TEXT, metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS source_uses(run_id TEXT, id TEXT, payload_json TEXT, PRIMARY KEY(run_id,id));
        CREATE TABLE IF NOT EXISTS bindings(run_id TEXT, id TEXT, scene TEXT, resource TEXT,
          kind TEXT, status TEXT, acceptance TEXT, reasons_json TEXT, payload_json TEXT,
          result_path TEXT, result_sha256 TEXT, PRIMARY KEY(run_id,id));
        CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, run_id TEXT, binding_id TEXT,
          status TEXT, worker_pid INTEGER, error TEXT, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT);
        CREATE TABLE IF NOT EXISTS artifacts(run_id TEXT, binding_id TEXT, role TEXT,
          path TEXT, sha256 TEXT, PRIMARY KEY(run_id,binding_id,role));
    """)
    return db


def freeze_context(selection, run_dir):
    for name, expected in selection["signature"].get("implementationSHA256", {}).items():
        data = Path(__file__).with_name(name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Implementation changed after selection preparation")
        immutable(run_dir / "implementation" / name, data)
    for record in selection["sourceInventory"].get("files", []):
        source = (ROOT / record["path"]).resolve()
        if not source.is_relative_to(ROOT / "scummvm/engines/neverhood"):
            raise ValueError("Source evidence escapes the declared engine scope")
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("Engine source evidence changed after selection preparation")
        immutable(run_dir / "source-evidence" / source.relative_to(ROOT), data)


def verify_result(path, expected_hash):
    path = Path(path)
    if sha(path) != expected_hash:
        raise ValueError("Indexed result manifest changed")
    record = json.loads(path.read_text())
    digest = record.pop("manifestSHA256")
    if hashlib.sha256(canonical(record)).hexdigest() != digest:
        raise ValueError("Result manifest integrity failure")
    for artifact in [*record["inputs"].values(), *record["outputs"].values()]:
        if sha(artifact["path"]) != artifact["sha256"]:
            raise ValueError("Indexed input or output changed")
    record["manifestSHA256"] = digest
    record["resultPath"] = str(path)
    return record


def verify_binding_result(item, record, run_dir):
    expected = item["asset"]
    actual = record["sourceIdentity"]
    if (not Path(record["resultPath"]).resolve().is_relative_to((run_dir / "candidates").resolve())
            or actual.get("bulkBindingId") != item["id"]
            or any(actual.get(key) != value for key, value in expected["sourceIdentity"].items())
            or record["inputs"]["source"]["sha256"] != expected["sourceSHA256"]
            or any(record[key] != list(expected[key]) for key in ("contentSize", "canvasSize", "placement"))):
        raise ValueError("Result binding metadata differs from the frozen selection")


def normalize_background(background, directory):
    original, output = background["source"], background["output"]
    if sha(original["path"]) != original["sha256"] or sha(output["path"]) != output["sha256"]:
        raise ValueError("Background source or restored bytes changed")
    with Image.open(original["path"]) as source:
        if source.size != (640, 480):
            raise ValueError("Unreviewed source scene dimensions")
    with Image.open(output["path"]) as image:
        if image.mode not in ("RGB", "RGBA") or (image.mode == "RGBA" and image.getchannel("A").getextrema() != (255, 255)):
            raise ValueError("Restored background is not opaque RGB context")
        native_size = list(image.size)
        rgb = image.convert("RGB")
    method = "unchanged exact runtime canvas"
    if rgb.size != (2560, 1920):
        rgb = rgb.resize((2560, 1920), Image.Resampling.LANCZOS)
        method = "explicit Lanczos normalization to exact 4x; not native 4x generation"
    path = Path(save(rgb, directory / (output["sha256"] + "-2560x1920.png")))
    return path, {"sourceRestoredSHA256": output["sha256"], "nativeSize": native_size,
                  "outputSize": list(rgb.size), "processing": method, "path": str(path), "sha256": sha(path)}


def process_binding(item, run_dir, band_native):
    asset = deepcopy(item["asset"])
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "-", str(item.get("scene", "static")))
    asset["id"] = f"{safe_id}-{item.get('resource') or 'unresolved'}-{hashlib.sha256(str(item['id']).encode()).hexdigest()[:16]}"
    background_path, normalized = normalize_background(item["backgroundRef"], run_dir / "backgrounds")
    source_identity = asset["sourceIdentity"]
    source_identity["bulkBindingId"] = item["id"]
    source_identity["normalizedRGBGuidance"] = normalized
    kwargs = {}
    if asset["kind"] == "foreground-occluder":
        asset["backgroundCorrespondence"] = "explicit-scene-binding"
        kwargs.update(background_path=background_path, scene_size=(640, 480))
    else:
        x, y = (value * 4 for value in asset["placement"])
        width, height = (value * 4 for value in asset["contentSize"])
        with Image.open(background_path) as image:
            rgb = image.crop((x, y, x + width, y + height)).convert("RGB")
        donor = save(rgb, run_dir / "guidance" / (asset["id"] + ".png"))
        source_identity["guidanceCropHD"] = [x, y, width, height]
        kwargs["rgb_path"] = Path(donor)
    return process_asset(asset, run_dir / "candidates", scale=4, mask_method="image-guided",
                         band_native=band_native, **kwargs)


def make_previews(item, result, run_dir):
    identifier = hashlib.sha256(item["id"].encode()).hexdigest()[:20]
    folder = run_dir / "previews" / identifier
    with Image.open(result["outputs"]["rgba"]["path"]) as image:
        rgba = image.convert("RGBA")
    with Image.open(result["outputs"]["sourceNN"]["path"]) as image:
        old_mask = np.asarray(image.getchannel("A")) >= 128
    with Image.open(result["outputs"]["mask"]["path"]) as image:
        new_mask = np.asarray(image) >= 128
    guide = result["inputs"]["background" if result["kind"] == "foreground-occluder" else "rgb"]
    with Image.open(guide["path"]) as image:
        if result["kind"] == "foreground-occluder":
            x, y = result["scaledPlacement"]
            width, height = result["scaledContentSize"]
            rgb = image.crop((x, y, x + width, y + height)).convert("RGB")
        else:
            rgb = image.convert("RGB")
    padded = Image.new("RGB", rgba.size)
    padded.paste(rgb, (0, 0))
    old = padded.convert("RGBA")
    old.putalpha(Image.fromarray(old_mask.astype(np.uint8) * 255))
    outlined = overlay(padded, old_mask, new_mask)
    box = zoom_box(old_mask, result["scaledContentSize"])
    return {"sourceControl": save(matte(old), folder / "nearest.png"),
            "candidate": save(matte(rgba), folder / "guided.png"),
            "contours": save(outlined, folder / "contours.png"),
            "sourceZoom": save(matte(old).crop(box).resize((384, 384), Image.Resampling.NEAREST), folder / "nearest-zoom.png"),
            "candidateZoom": save(matte(rgba).crop(box).resize((384, 384), Image.Resampling.NEAREST), folder / "guided-zoom.png")}


def export_index(db, run_id, run_dir, selection):
    rows = db.execute("SELECT * FROM bindings WHERE run_id=? ORDER BY scene,resource,id", (run_id,)).fetchall()
    documents, summary = [], Counter()
    page = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
            '<title>Static asset branch processing index</title><style>body{margin:0;background:#eee9df;color:#263128;font:15px/1.5 Verdana,sans-serif}main{max-width:1400px;margin:auto;padding:30px}h1,h2{font-family:Georgia,serif;font-weight:400}h1{font-size:44px}h2{border-top:1px solid #b3b8ab;padding-top:20px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}figure{margin:0;background:#263128;padding:12px;color:#fff}img{width:100%;height:260px;object-fit:contain}figcaption{font-size:12px}code,pre{overflow-wrap:anywhere;white-space:pre-wrap;font-size:11px}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:9px;text-align:left;border-bottom:1px solid #bbb;overflow-wrap:anywhere}article{margin:28px 0}a{color:inherit}@media(max-width:700px){main{padding:15px}.grid{grid-template-columns:1fr}h1{font-size:32px}table{display:block;overflow:auto}}</style><main>',
            '<h1>Static asset branch: processing ledger</h1><p>Every discovered use retains source evidence and a disposition. Candidate-use counts are not unique physical asset counts. All eligible bindings are processed; unresolved palettes, states and RGB remain blocked rather than guessed. No automatic approval or live runtime replacement.</p>',
            '<p><a href="index.jsonl">Per-binding JSONL index</a> | <a href="selection.json">Frozen selection</a> | <a href="source-inventory.json">Whole-source use inventory</a> | <a href="summary.json">Summary</a></p>']
    blocked_rows = []
    for row in rows:
        summary[row["status"]] += 1
        item = json.loads(row["payload_json"])
        document = {"id": row["id"], "scene": row["scene"], "resource": row["resource"], "kind": row["kind"],
                    "processingStatus": row["status"], "acceptance": row["acceptance"],
                    "blockedReasons": json.loads(row["reasons_json"]), "metadata": item,
                    "resultPath": row["result_path"], "resultSHA256": row["result_sha256"], "automaticApproval": False}
        document["attempts"] = [dict(attempt) for attempt in db.execute("SELECT id,status,worker_pid,error,started_at,finished_at FROM attempts WHERE run_id=? AND binding_id=? ORDER BY id", (run_id, row["id"]))]
        if row["status"] == "succeeded":
            result = verify_result(row["result_path"], row["result_sha256"])
            verify_binding_result(item, result, run_dir)
            document["result"] = result
            previews = make_previews(item, result, run_dir)
            document["previews"] = previews
            page.append(f'<article><h2>{html.escape(str(row["scene"]))} / {html.escape(str(row["resource"]))}</h2><p>{html.escape(row["acceptance"] or "review-required")}</p><code>{html.escape(row["id"])}</code><div class="grid">')
            for label, path in previews.items():
                uri = html.escape(str(Path(path).relative_to(run_dir)), quote=True)
                page.append(f'<figure><img loading="lazy" src="{uri}" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>')
            links = ' | '.join(f'<a href="{html.escape(str(Path(artifact["path"]).relative_to(run_dir)), quote=True)}">{html.escape(role)}</a>' for role, artifact in result["outputs"].items())
            page.append('</div><p>Native artifacts: ' + links + '</p><details><summary>Full contour diagnostics</summary><pre>' + html.escape(json.dumps(result["diagnostics"], indent=2, sort_keys=True)) + '</pre></details></article>')
        else:
            blocked_rows.append(f'<tr><td>{html.escape(str(row["scene"]))}</td><td>{html.escape(str(row["resource"]))}</td><td>{html.escape(row["status"])}</td><td>{html.escape("; ".join(document["blockedReasons"]))}</td></tr>')
        documents.append(document)
    acceptance_counts = dict(Counter(row["acceptance"] for row in rows if row["acceptance"]))
    page.insert(4, '<p><strong>Processing dispositions:</strong> ' + html.escape(json.dumps(dict(summary), sort_keys=True))
                + '</p><p><strong>Separate contour decisions:</strong> ' + html.escape(json.dumps(acceptance_counts, sort_keys=True))
                + '</p><p>Processing success is not mask approval. Geometry-blocked results must not be loaded into the game.</p>')
    page.append('<h2>Blocked and unresolved uses</h2><table><thead><tr><th>Context</th><th>Resource</th><th>Status</th><th>Reason</th></tr></thead><tbody>' + ''.join(blocked_rows) + '</tbody></table></main></html>')
    source_coverage = selection["sourceCoverage"]
    summary_doc = {"schemaVersion": 1, "run": run_id, "sourceCoverage": source_coverage,
                   "preparedBindings": selection["preparedBindings"], "indexedBindings": len(rows),
                   "processingCounts": dict(summary), "wholeGameSemanticClosureProven": False,
                   "acceptanceCounts": acceptance_counts,
                   "sourceUseCount": len(selection["sourceUses"]), "runtimePromotion": False, "inferenceRequests": 0,
                   "scopeLimits": selection["scopeLimits"], "reportPath": str(run_dir / "report.html"),
                   "indexPath": str(run_dir / "index.jsonl"), "databasePath": str(run_dir.parent.parent / "index.sqlite")}
    (run_dir / "index.jsonl").write_text(''.join(json.dumps(document, sort_keys=True) + '\n' for document in documents), encoding="utf-8")
    (run_dir / "summary.json").write_bytes(canonical(summary_doc))
    (run_dir / "report.html").write_text('\n'.join(page), encoding="utf-8")
    return summary_doc


def execute_selection(selection, output_root, *, execute=False, retry_failed=False, processor=process_binding):
    output_root = Path(output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    run_id = hashlib.sha256(canonical(selection)).hexdigest()[:20]
    run_dir = output_root / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    with (output_root / ".execution.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        freeze_context(selection, run_dir)
        immutable(run_dir / "selection.json", canonical(selection))
        immutable(run_dir / "source-inventory.json", canonical(selection["sourceInventory"]))
        with closing(open_index(output_root / "index.sqlite")) as db, db:
            db.execute("INSERT OR IGNORE INTO runs(id,selection_path,selection_sha256,metadata_json) VALUES(?,?,?,?)", (run_id, str(run_dir / "selection.json"), sha(run_dir / "selection.json"), json.dumps(selection["signature"], sort_keys=True)))
            for use in selection["sourceUses"]:
                db.execute("INSERT OR IGNORE INTO source_uses VALUES(?,?,?)", (run_id, use["id"], json.dumps(use, sort_keys=True)))
            for item in selection["bindings"]:
                status = "pending" if item["processingStatus"] == "eligible" else "blocked"
                db.execute("INSERT OR IGNORE INTO bindings VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                           (run_id, item["id"], item.get("scene"), item.get("resource"), item.get("kind"), status,
                            None, json.dumps(item.get("blockedReasons", [])), json.dumps(item, sort_keys=True), None, None))
            db.commit()
            if execute:
                for item in selection["bindings"]:
                    row = db.execute("SELECT * FROM bindings WHERE run_id=? AND id=?", (run_id, item["id"])).fetchone()
                    if row["payload_json"] != json.dumps(item, sort_keys=True):
                        raise ValueError("Indexed binding metadata differs from the frozen selection")
                    if row["status"] == "succeeded":
                        result = verify_result(row["result_path"], row["result_sha256"])
                        verify_binding_result(item, result, run_dir)
                        print(json.dumps({"id": item["id"], "action": "verified-resume-skip"}), flush=True)
                        continue
                    if row["status"] == "blocked" or (row["status"] == "failed" and not retry_failed):
                        continue
                    if row["status"] == "running":
                        db.execute("UPDATE attempts SET status='interrupted-before-reconciliation',finished_at=CURRENT_TIMESTAMP,error=? WHERE run_id=? AND binding_id=? AND status='running'",
                                   ("Previous worker no longer holds the exclusive execution lock", run_id, item["id"]))
                    cursor = db.execute("INSERT INTO attempts(run_id,binding_id,status,worker_pid) VALUES(?,?,?,?)", (run_id, item["id"], "running", os.getpid()))
                    attempt = cursor.lastrowid
                    db.execute("UPDATE bindings SET status='running' WHERE run_id=? AND id=?", (run_id, item["id"]))
                    db.commit()
                    try:
                        result = processor(item, run_dir, selection["signature"]["bandNative"])
                        result_path = result["resultPath"]
                        result_hash = sha(result_path)
                        verify_result(result_path, result_hash)
                        verify_binding_result(item, result, run_dir)
                        db.execute("UPDATE bindings SET status='succeeded',acceptance=?,reasons_json='[]',result_path=?,result_sha256=? WHERE run_id=? AND id=?",
                                   (result["acceptance"], result_path, result_hash, run_id, item["id"]))
                        for role, artifact in result["outputs"].items():
                            db.execute("INSERT OR REPLACE INTO artifacts VALUES(?,?,?,?,?)", (run_id, item["id"], role, artifact["path"], artifact["sha256"]))
                        db.execute("UPDATE attempts SET status='succeeded',finished_at=CURRENT_TIMESTAMP WHERE id=?", (attempt,))
                        print(json.dumps({"id": item["id"], "status": "succeeded", "acceptance": result["acceptance"]}), flush=True)
                    except Exception as error:
                        db.execute("UPDATE bindings SET status='failed',reasons_json=? WHERE run_id=? AND id=?", (json.dumps([str(error)]), run_id, item["id"]))
                        db.execute("UPDATE attempts SET status='failed',finished_at=CURRENT_TIMESTAMP,error=? WHERE id=?", (str(error), attempt))
                        print(json.dumps({"id": item["id"], "status": "failed", "error": str(error)}), flush=True)
                    db.commit()
            summary = export_index(db, run_id, run_dir, selection)
        (output_root / "latest.json").write_bytes(canonical(summary))
        (output_root / "index.html").write_text(f'<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=runs/{run_id}/report.html"><title>Static processing index</title><a href="runs/{run_id}/report.html">Open current static processing report</a></html>', encoding="utf-8")
    return summary


def prepare(root, prepared_root, catalog_root, output_root, background_check_path, band_native=3):
    root, output_root = Path(root).resolve(), Path(output_root).resolve()
    source_inventory = scan_source(root)
    prepared = build_prepared_catalog(root, Path(prepared_root), Path(catalog_root))
    background_check = json.loads(Path(background_check_path).read_text())
    resolved = resolve_candidates(root, Path(catalog_root), source_inventory, background_check, prepared["assets"], output_root / "sources")
    bindings = attach_backgrounds(prepared["assets"] + [row for row in resolved if row.get("processingStatus") != "mapped-prepared"], background_check)
    ids = [item["id"] for item in bindings]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate binding identities")
    mapped = {row["id"]: row for row in resolved}
    uses = [{**use, "resolution": {key: mapped.get(use["id"], {}).get(key) for key in ("processingStatus", "blockedReasons", "preparedBindingIds")}} for use in source_inventory["uses"]]
    signature = {"version": 1, "sourceBinding": prepared["sourceBinding"], "scale": 4, "bandNative": band_native,
                 "backgroundCheckSHA256": sha(background_check_path),
                 "implementationSHA256": {name: sha(Path(__file__).with_name(name)) for name in ("bulk.py", "source_inventory.py", "prepared.py", "resolve.py", "pipeline.py", "refine.py", "contour_pilot.py", "pilot.py")},
                 "dependencies": {"python": sys.version.split()[0], "pillow": PIL.__version__, "numpy": np.__version__, "scipy": scipy.__version__}}
    return {"schemaVersion": 1, "signature": signature, "bindings": bindings, "sourceUses": uses,
            "sourceInventory": source_inventory, "sourceCoverage": source_inventory["coverage"],
            "preparedBindings": len(prepared["assets"]),
            "preparedFiles": [{key: value for key, value in item.items() if key != "metadata"} for item in prepared["files"]],
            "scopeLimits": ["Prepared-catalog scope: " + value for value in prepared["scopeLimits"]]
            + ["Source-scanner scope: " + value for value in source_inventory["scopeLimits"]] + [
                "Every indexed use has a disposition; unresolved resource expressions and missing context are not silently processed.",
                "Direct cross-room processing additionally requires exact original visible-RGB correspondence and conservative palette/geometry checks.",
                "Activation-only or independent-state RGB must not be replaced with base-background pixels.",
                "Upstream restored-background caveats remain attached; successful processing is not structural or runtime approval."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "private-assets/upscaling/static-all-v1")
    parser.add_argument("--prepared-root", type=Path, default=ROOT.parent / "neverhood-upscaling/data")
    parser.add_argument("--catalog-root", type=Path, default=ROOT / "private-assets")
    parser.add_argument("--background-check", type=Path, default=ROOT / "private-assets/upscaling/gemini-experiments/opaque-all-v1/bulk-check.json")
    parser.add_argument("--band-native", type=float, default=3)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    args = parser.parse_args()
    args.output = private_output(args.output / "latest.json").parent
    selection = prepare(ROOT, args.prepared_root, args.catalog_root, args.output, args.background_check, args.band_native)
    summary = execute_selection(selection, args.output, execute=args.execute, retry_failed=args.retry_failed)
    print(json.dumps(summary, indent=2))
