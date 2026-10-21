#!/usr/bin/env python3
"""Prepare explicit nearest-mask diagnostic controls, not final HD contours."""

import argparse
from copy import deepcopy
from contextlib import closing
import hashlib
import html
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import zlib

import numpy as np
from PIL import Image, ImageDraw

from pipeline import compare_alpha, process_asset

ROOT = Path(__file__).resolve().parents[3]
OCCLUDERS = ("152c1313", "060000a0", "b2a423b0", "316e0772")
PROPS = ("312c8774", "b3242310")
PRIORITIES = {"152c1313": 1015, "060000a0": 1200, "b2a423b0": 1100,
              "316e0772": 1100, "312c8774": 1100, "b3242310": 825,
              "06149428": 1100, "316c4bb4": 1015,
              "2080a3a8": 1300, "809861a6": 950, "89c03848": 1100,
              "15288120": 100, "8c066150": 200}
NANO_JOB = "Scene1002-gemini-nano-banana-2.1-preservation-none-746b2548033b"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def immutable_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"Existing artifact differs; choose a new output directory: {path}")
    else:
        with path.open("xb") as handle:
            handle.write(data)


def save_image(image, path):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    immutable_bytes(path, buffer.getvalue())
    return str(Path(path).resolve())


def checked_path(root, relative):
    path = (Path(root) / relative).resolve()
    if not path.is_relative_to(Path(root).resolve()):
        raise ValueError("Asset path escapes its declared root")
    return path


def blob(db, root, identity):
    row = db.execute("SELECT path,size FROM blobs WHERE sha256=?", (identity,)).fetchone()
    if row is None:
        raise ValueError("Missing decoded catalog blob")
    data = checked_path(root, row["path"]).read_bytes()
    if len(data) != row["size"] or digest(data) != identity:
        raise ValueError("Decoded catalog blob integrity failure")
    return data


def verify_binding(db, catalog_root, base, manifest, runtime, resource):
    cases = [case for case in manifest["cases"] if case["resource"] == resource and not case["remove64"]]
    if len(cases) != 1 or cases[0]["actor"] != "static" or len(cases[0]["frames"]) != 1:
        raise ValueError("Expected one explicitly static source case")
    case, frame = cases[0], cases[0]["frames"][0]
    matches = [entry for entry in runtime["entries"] if entry["resource"] == resource and entry["frameId"] == frame["frameId"] and not entry["flipX"]]
    if len(matches) != 1:
        raise ValueError("Ambiguous runtime binding")
    entry = matches[0]
    jobs = [job for job in manifest["jobs"] if job["id"] == frame["job"]]
    if len(jobs) != 1:
        raise ValueError("Ambiguous prepared source")
    job = jobs[0]
    source = checked_path(base, job["file"])
    if digest(source.read_bytes()) != job["sha256"]:
        raise ValueError("Prepared source PNG changed")
    row = db.execute("SELECT * FROM decodedframes WHERE id=?", (frame["frameId"],)).fetchone()
    if row is None or row["indexed_blob"] != frame["sourceIndexedSHA256"] or row["requested_hash"] != int(resource, 16):
        raise ValueError("Source frame differs from catalog identity")
    indexed = blob(db, catalog_root, row["indexed_blob"])
    palette = blob(db, catalog_root, manifest["paletteSHA256"])
    width, height = row["width"], row["height"]
    if len(indexed) != width * height or len(palette) != 1024 or job["size"] != [width, height]:
        raise ValueError("Source raster or palette dimensions differ")
    indices = np.frombuffer(indexed, np.uint8).reshape(height, width)
    colors = np.frombuffer(palette, np.uint8).reshape(256, 4)
    expected = np.empty((height, width, 4), np.uint8)
    expected[:, :, :3] = colors[indices, :3]
    expected[:, :, 3] = np.where(indices == 0, 0, 255)
    with Image.open(source) as image:
        if image.mode != "RGBA" or not np.array_equal(np.asarray(image), expected):
            raise ValueError("Prepared source is not the authoritative indexed/palette/alpha recipe")
    variants = [item for item in frame["rasterVariants"] if not item["flipX"]]
    if len(variants) != 1:
        raise ValueError("Expected one unflipped runtime raster")
    canvas = variants[0]["surfaceSize"]
    if canvas != [entry["width"] // 4, entry["height"] // 4] or entry["nativeSize"] != [width, height]:
        raise ValueError("Padded runtime dimensions differ")
    padded = np.zeros((canvas[1], canvas[0]), np.uint8)
    padded[:height, :width] = indices
    padded_hash = digest(padded.tobytes())
    key = f"{canvas[0]}x{canvas[1]}-{canvas[0]}-{zlib.crc32(padded.tobytes()):08x}-p{zlib.crc32(palette):08x}-0"
    if padded_hash != entry["sourceSHA256"] or padded_hash != variants[0]["indexedSHA256"] or key != entry["key"]:
        raise ValueError("Runtime palette, transparency, padding or pixel identity differs")
    if frame["metadata"] != json.loads(row["metadata_json"]):
        raise ValueError("Placement metadata differs from source catalog")
    identity = {
        "resource": resource, "frameId": frame["frameId"], "frame": frame["index"],
        "indexedSHA256": row["indexed_blob"], "runtimeIndexedSHA256": padded_hash,
        "paletteResource": manifest["paletteResource"], "paletteSHA256": manifest["paletteSHA256"],
        "paletteCRC32": runtime["paletteCRC32"], "transparentIndex": 0,
        "runtimeKey": key, "runtimeCrop": entry.get("crop"), "flipX": False,
        "capacity": case["capacity"], "nativeMetadata": frame["metadata"],
        "sourceBinding": runtime["sourceBinding"], "initialPriority": PRIORITIES[resource],
        "stateRules": "Part3 is removed at the original y>230 transition; main arch priority changes remain engine-owned. No runtime state changes are implemented here.",
    }
    return {"id": resource, "sourcePath": str(source), "sourceSHA256": job["sha256"],
            "contentSize": [width, height], "canvasSize": canvas,
            "placement": [frame["metadata"]["x"], frame["metadata"]["y"]],
            "sourceIdentity": identity}, entry, job


def checker(size):
    yy, xx = np.indices((size[1], size[0]))
    values = np.where((xx // 24 + yy // 24) % 2, 65, 205).astype(np.uint8)
    return Image.fromarray(np.repeat(values[:, :, None], 3, axis=2)).convert("RGBA")


def matte(image, path):
    return save_image(Image.alpha_composite(checker(image.size), image), path)


def render_report(output, record):
    def uri(path):
        return html.escape(str(Path(path).relative_to(output)), quote=True)
    page = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
            '<title>Scene1002 Static Layer Pilot</title><style>body{margin:0;background:#ece8de;color:#252d26;font:15px/1.55 Georgia,serif}main{max-width:1400px;margin:auto;padding:36px}h1{font-size:48px;font-weight:400}h2{border-top:1px solid #92978d;padding-top:25px}p,summary,pre{font-family:Verdana,sans-serif}p{max-width:1000px}pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}figure{margin:0;background:#222c25;padding:15px;color:#eee}img{display:block;width:100%;height:350px;object-fit:contain}figcaption{margin-top:10px}.scene img{height:auto}article{margin:40px 0}a{color:inherit}@media(max-width:750px){main{padding:18px}h1{font-size:34px}.grid{grid-template-columns:1fr}img{height:300px}}</style><main>',
            '<h1>Static layers, independent masks.</h1><p>Scene1002 offline pilot: four foreground occluders and two static props. All candidate alpha comes from the verified original indexed mask, nearest-neighbor 4x, with original runtime padding. No inference, runtime integration or asset promotion is performed.</p>',
            '<p>Background-matched RGB is a candidate, not proof that the regenerated background preserves every occlusion boundary. Original foreground/background mismatches are retained as diagnostics. Existing neural RGB is reused only for comparison; its neural alpha is never adopted.</p>',
            '<p><a href="manifest.json">Full provenance</a> | <a href="candidate-bindings.json">Unapproved candidate bindings</a></p>']
    for scene in record["scenes"]:
        page.append(f'<h2>{html.escape(scene["label"])}: synthetic occlusion probe</h2><p>The colored grid is a synthetic underlay, not a character or gameplay capture. The source-owned part3 deletion and dynamic priorities still require in-engine regression testing.</p><div class="grid scene">')
        for label, path in scene["previews"].items():
            page.append(f'<figure><img src="{uri(path)}" loading="lazy" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>')
        page.append('</div>')
    for item in record["candidates"]:
        page.append(f'<article><h2>{html.escape(item["assetId"])} / {html.escape(item["variant"])}</h2><p>Source placement {item["placement"]}; content {item["contentSize"]}; padded canvas {item["canvasSize"]}. Status: review required, not approved.</p><div class="grid">')
        for label, path in item["previews"].items():
            page.append(f'<figure><img src="{uri(path)}" loading="lazy" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>')
        page.append('</div><details><summary>Mask and source diagnostics</summary><pre>' + html.escape(json.dumps({"legacyAlpha": item["legacyAlpha"], "candidateAlpha": item["candidateAlpha"], "processing": item["result"]}, indent=2, sort_keys=True)) + '</pre></details></article>')
    page.append('<p>Formal mask invariants do not prove visual correctness, original silhouette recovery beyond source resolution, or gameplay acceptance. No whole-game processing is implied.</p></main></html>')
    immutable_bytes(output / "report.html", "\n".join(page).encode())


def run(prepared_root, catalog_root, output, nano_result):
    prepared_root, catalog_root, output = (Path(p).resolve() for p in (prepared_root, catalog_root, output))
    base = prepared_root / "baselines-v1"
    manifest_path = base / "manifest.json"
    runtime_path = prepared_root / "runtime-map-v1.json"
    manifest = json.loads(manifest_path.read_text())
    runtime = json.loads(runtime_path.read_text())
    if manifest["scene"] != "Scene1002" or manifest["paletteResource"] != "12c23307" or runtime["room"] != "Scene1002" or runtime["scale"] != 4:
        raise ValueError("Pilot requires the audited Scene1002 source context")
    if runtime["sourceManifestSHA256"] != digest(manifest_path.read_bytes()):
        raise ValueError("Runtime map has a different source manifest")
    catalog_manifest = json.loads((catalog_root / "manifest.json").read_text())
    if catalog_manifest["sourceBinding"] != runtime["sourceBinding"]:
        raise ValueError("Runtime map has a different game source binding")
    original_path = base / "original-background.png"
    with Image.open(original_path) as image:
        original = image.convert("RGB")
    if original.size != (640, 480):
        raise ValueError("Original room canvas differs")
    output.mkdir(parents=True, exist_ok=True)
    backgrounds = []
    demo_path = prepared_root / "pack-v1/backgrounds/gemini.png"
    nano_record = json.loads(Path(nano_result).read_text())
    if nano_record["status"] != "succeeded":
        raise ValueError("Selected Nano background request did not succeed")
    final = [item for item in nano_record["images"] if not item.get("thought")][-1]
    nano_path = Path(final["path"])
    if digest(nano_path.read_bytes()) != final["sha256"]:
        raise ValueError("Selected Nano candidate changed")
    for name, source in (("existing-demo", demo_path), ("nano-preservation", nano_path)):
        with Image.open(source) as opened:
            image = opened.convert("RGB")
        native_size = list(image.size)
        method = "unchanged exact runtime canvas"
        if image.size != (2560, 1920):
            if name != "nano-preservation":
                raise ValueError("Existing demo background must already use the exact runtime canvas")
            image = image.resize((2560, 1920), Image.Resampling.LANCZOS)
            method = "explicit Lanczos mapping to 2560x1920; not native 4x generation; no crop"
        path = Path(save_image(image, output / "backgrounds" / (name + ".png")))
        backgrounds.append({"id": name, "path": str(path), "sourcePath": str(source),
                            "sourceSHA256": digest(source.read_bytes()), "nativeSize": native_size,
                            "outputSize": list(image.size), "sha256": digest(path.read_bytes()), "processing": method})

    records, assets, bindings = [], {}, []
    with closing(sqlite3.connect(f"file:{catalog_root / 'catalog.sqlite'}?mode=ro", uri=True)) as db, db:
        db.row_factory = sqlite3.Row
        palette_rows = db.execute("SELECT DISTINCT p.blob FROM palettes p JOIN aliases a ON a.resolved_id=p.resource_id WHERE a.requested_hash=?", (int("12c23307", 16),)).fetchall()
        if len(palette_rows) != 1 or palette_rows[0]["blob"] != manifest["paletteSHA256"]:
            raise ValueError("Scene palette association differs from the source catalog")
        background_rows = db.execute("SELECT * FROM decodedframes WHERE requested_hash=?", (int("12c23307", 16),)).fetchall()
        if len(background_rows) != 1 or (background_rows[0]["width"], background_rows[0]["height"]) != original.size:
            raise ValueError("Original background catalog binding differs")
        source_background = np.frombuffer(blob(db, catalog_root, background_rows[0]["indexed_blob"]), np.uint8).reshape(480, 640)
        palette = np.frombuffer(blob(db, catalog_root, manifest["paletteSHA256"]), np.uint8).reshape(256, 4)
        if runtime["paletteCRC32"] != f"{zlib.crc32(palette.tobytes()):08x}":
            raise ValueError("Runtime palette CRC differs")
        if not np.array_equal(np.asarray(original), palette[source_background, :3]):
            raise ValueError("Original background differs from its scene-palette indexed source")
        for resource in (*OCCLUDERS, *PROPS):
            asset, entry, job = verify_binding(db, catalog_root, base, manifest, runtime, resource)
            assets[resource] = (asset, entry, job)
            legacy_path = checked_path(prepared_root / "pack-v1", entry["file"])
            with Image.open(legacy_path) as image:
                legacy = image.convert("RGBA")
            expected_size = tuple(value * 4 for value in asset["canvasSize"])
            if legacy.size != expected_size:
                raise ValueError("Legacy padded canvas differs")
            legacy_copy = Path(save_image(legacy, output / "controls" / (resource + ".png")))
            variants = [(background["id"], background["path"], None) for background in backgrounds] if resource in OCCLUDERS else [("source-lanczos", None, None), ("existing-restored-rgb", None, str(base / "neural" / (job["id"] + ".png")))]
            for variant, background_path, rgb_path in variants:
                item = deepcopy(asset)
                item["id"] = resource + "-" + variant
                item["kind"] = "foreground-occluder" if resource in OCCLUDERS else "static-prop"
                item["originalBackgroundPath"] = str(original_path)
                if resource in OCCLUDERS:
                    item["backgroundCorrespondence"] = "explicit-scene-binding"
                if rgb_path:
                    origin = json.loads((base / "origins" / (job["id"] + ".json")).read_text())
                    if digest(Path(rgb_path).read_bytes()) != origin["outputSHA256"] or origin["inputSHA256"] != job["sha256"]:
                        raise ValueError("Existing RGB donor provenance differs")
                    item["sourceIdentity"]["rgbDonor"] = {"path": rgb_path, "sha256": origin["outputSHA256"], "model": origin.get("model"), "alphaDiscarded": True}
                result = process_asset(item, output / "candidates", scale=4, background_path=Path(background_path) if background_path else None,
                                       scene_size=(640, 480) if background_path else None, rgb_path=Path(rgb_path) if rgb_path else None,
                                       mask_method="source-nearest")
                candidate_path = Path(result["outputs"]["rgba"]["path"])
                baseline_path = Path(result["outputs"]["sourceNN"]["path"])
                with Image.open(candidate_path) as image:
                    candidate = image.convert("RGBA")
                with Image.open(baseline_path) as image:
                    baseline = image.convert("RGBA")
                preview_dir = output / "previews" / item["id"]
                previews = {"Source nearest 4x": matte(baseline, preview_dir / "source.png"),
                            "Legacy neural RGB and alpha": matte(legacy, preview_dir / "legacy.png"),
                            "Candidate RGB and source mask": matte(candidate, preview_dir / "candidate.png")}
                for name, color in (("black", "black"), ("white", "white")):
                    previews["Candidate on " + name] = save_image(Image.alpha_composite(Image.new("RGBA", candidate.size, color), candidate), preview_dir / (name + ".png"))
                records.append({"assetId": resource, "variant": variant, "placement": asset["placement"],
                                "contentSize": asset["contentSize"], "canvasSize": asset["canvasSize"],
                                "result": result, "legacyPath": str(legacy_copy),
                                "legacySourcePath": str(legacy_path), "legacySourceSHA256": digest(legacy_path.read_bytes()),
                                "legacyAlpha": compare_alpha(baseline.getchannel("A"), legacy.getchannel("A")),
                                "candidateAlpha": compare_alpha(baseline.getchannel("A"), candidate.getchannel("A")),
                                "previews": previews})
                binding = deepcopy(entry)
                binding["file"] = str(candidate_path.relative_to(output))
                binding["candidateVariant"] = variant
                binding["outputSHA256"] = digest(candidate_path.read_bytes())
                binding["sourceIdentity"] = asset["sourceIdentity"]
                bindings.append(binding)

    scenes = []
    for background in backgrounds:
        canvas = Image.open(background["path"]).convert("RGBA")
        draw = ImageDraw.Draw(canvas)
        # Synthetic underlays reveal occlusion without importing animated actors.
        for x0, y0, x1, y1 in ((24, 220, 130, 465), (555, 245, 590, 448)):
            for y in range(y0 * 4, y1 * 4, 32):
                for x in range(x0 * 4, x1 * 4, 32):
                    color = "#ee47b0" if (x // 32 + y // 32) % 2 else "#fcdb49"
                    draw.rectangle((x, y, min(x + 31, x1 * 4 - 1), min(y + 31, y1 * 4 - 1)), fill=color)
        previews = {"Unoccluded synthetic underlay": save_image(canvas, output / "scenes" / (background["id"] + "-underlay.png"))}
        for label, legacy in (("Legacy neural masks", True), ("Source-derived masks and matched RGB", False)):
            composite = canvas.copy()
            for resource in sorted(OCCLUDERS, key=lambda identifier: PRIORITIES[identifier]):
                record = next(item for item in records if item["assetId"] == resource and item["variant"] == background["id"])
                path = record["legacyPath"] if legacy else record["result"]["outputs"]["rgba"]["path"]
                with Image.open(path) as layer:
                    composite.alpha_composite(layer.convert("RGBA"), tuple(value * 4 for value in record["placement"]))
            previews[label] = save_image(composite, output / "scenes" / (background["id"] + ("-legacy.png" if legacy else "-candidate.png")))
        scenes.append({"label": background["id"], "previews": previews})
    record = {"schemaVersion": 1, "scene": "Scene1002", "scale": 4, "private": True,
              "acceptance": "review-required", "runtimePromotion": False, "inferenceRequests": 0,
              "sourceManifestSHA256": digest(manifest_path.read_bytes()), "runtimeMapSHA256": digest(runtime_path.read_bytes()),
              "sourceBinding": runtime["sourceBinding"],
              "implementationSHA256": {"pilot": digest(Path(__file__).read_bytes()), "pipeline": digest(Path(__file__).with_name("pipeline.py").read_bytes())},
              "backgrounds": backgrounds, "candidates": records, "scenes": scenes,
              "limitations": ["No in-engine gameplay regression performed.", "Binary source mask is preserved, not subpixel contour reconstruction.",
                              "Background alignment and material correspondence require visual review.", "RGB donor alpha is intentionally discarded; donor color may still contain reconstruction artifacts."]}
    immutable_bytes(output / "manifest.json", (json.dumps(record, indent=2, sort_keys=True) + "\n").encode())
    immutable_bytes(output / "candidate-bindings.json", (json.dumps({"schemaVersion": 1, "runtimePromotion": False, "loadableRoomPack": False,
                    "note": "Review-only binding records; duplicate runtime keys represent alternative candidates, not a merged pack.", "entries": bindings}, indent=2, sort_keys=True) + "\n").encode())
    render_report(output, record)
    print(json.dumps({"report": str(output / "report.html"), "candidates": len(records), "inferenceRequests": 0}))
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared-root", type=Path, default=ROOT.parent / "neverhood-upscaling/data/room2-hd")
    parser.add_argument("--catalog-root", type=Path, default=ROOT / "private-assets")
    parser.add_argument("--output", type=Path, required=True, help="Explicit output for diagnostic nearest-mask controls only")
    parser.add_argument("--nano-result", type=Path, default=ROOT / "private-assets/upscaling/gemini-experiments/static-pilot-v1-2096d1751ccd/jobs" / NANO_JOB / "result.json")
    args = parser.parse_args()
    run(args.prepared_root, args.catalog_root, args.output, args.nano_result)
