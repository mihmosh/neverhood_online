#!/usr/bin/env python3
"""Compare source pixel masks with image-guided contours on frozen Nano RGB."""

import argparse
from copy import deepcopy
import hashlib
import html
from io import BytesIO
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from pipeline import process_asset

ROOT = Path(__file__).resolve().parents[3]
NAMES = {"152c1313": "Left arch", "312c8774": "Ladder", "060000a0": "Lower arch lip",
         "b2a423b0": "Right doorway edge", "316e0772": "Upper platform lip", "b3242310": "Door backing"}
CROSS = ndi.generate_binary_structure(2, 1)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def immutable(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("Existing contour artifact differs: " + str(path))
    else:
        with path.open("xb") as stream:
            stream.write(data)


def save(image, path):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    immutable(path, buffer.getvalue())
    return str(Path(path).resolve())


def matte(rgba):
    yy, xx = np.indices((rgba.height, rgba.width))
    checker = np.where((xx // 16 + yy // 16) % 2, 55, 215).astype(np.uint8)
    base = Image.fromarray(np.repeat(checker[:, :, None], 3, axis=2)).convert("RGBA")
    return Image.alpha_composite(base, rgba)


def boundary(mask):
    return mask & ~ndi.binary_erosion(mask, CROSS, border_value=1)


def overlay(rgb, old, new):
    pixels = np.asarray(rgb).copy()
    red = boundary(old)
    cyan = boundary(new)
    pixels[red] = [255, 68, 56]
    pixels[cyan] = [20, 255, 230]
    return Image.fromarray(pixels)


def zoom_box(mask, content_size):
    edge = boundary(mask)
    width, height = content_size
    edge[:3] = edge[-3:] = False
    edge[:, :3] = edge[:, -3:] = False
    ys, xs = np.nonzero(edge[:height, :width])
    if len(xs):
        selected = np.argmin((xs - width * .5) ** 2 + (ys - height * .4) ** 2)
        x, y = int(xs[selected]), int(ys[selected])
    else:
        x, y = width // 2, height // 2
    side = min(96, width, height)
    left = max(0, min(width - side, x - side // 2))
    top = max(0, min(height - side, y - side // 2))
    return (left, top, left + side, top + side)


def write_report(run_dir, record):
    def picture(path, label, zoom=False):
        uri = html.escape(str(Path(path).relative_to(run_dir)), quote=True)
        return f'<figure><img class="{"zoom" if zoom else ""}" loading="lazy" src="{uri}" alt="{html.escape(label)}"><figcaption>{html.escape(label)}</figcaption></figure>'
    parts = ['<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
             '<title>Image-guided HD contours</title><style>body{background:#ece8de;color:#243025;margin:0;font:15px/1.55 Verdana,sans-serif}main{max-width:1400px;padding:36px;margin:auto}h1,h2{font-family:Georgia,serif;font-weight:400}h1{font-size:48px}h2{font-size:30px;border-top:1px solid #a9ac9e;padding-top:25px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{background:#263229;color:#fff;margin:0;padding:14px;min-width:0}img{display:block;max-width:100%;width:100%;height:310px;object-fit:contain}.zoom{image-rendering:pixelated}figcaption{font-size:12px;margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}a{color:inherit}.status{font-weight:bold;color:#9a3f24}article{margin:40px 0}p{max-width:1100px}@media(max-width:700px){main{padding:17px}h1{font-size:34px}.grid{grid-template-columns:1fr}img{height:290px}}</style><main>',
             '<h1>Follow the object, not its old pixels.</h1>',
             '<p>The native mask supplies object identity, coarse shape and topology. The restored Nano Banana RGB supplies evidence for the HD boundary. Exact equality to the nearest-neighbor mask is not a success criterion.</p>',
             '<p><strong>Red:</strong> old source-NN boundary. <strong>Cyan:</strong> proposed image-guided boundary. The enlarged views use nearest display scaling so the original 4-HD-pixel stair steps cannot be hidden by browser smoothing.</p>',
             '<p>Binary geometric masks are exported separately from subpixel rendering coverage. Antialiasing at the reconstructed contour is not the same as accepting arbitrary soft neural alpha. Low-confidence and rejected candidates remain explicitly labeled. Nothing is deployed.</p>',
             '<p><a href="manifest.json">Full diagnostics and provenance</a></p>']
    parts.append('<nav>' + ' | '.join(f'<a href="#asset-{resource}">{html.escape(name)}</a>' for resource, name in NAMES.items()) + '</nav>')
    for asset in record["assets"]:
        result = asset["result"]
        diagnostics = result["diagnostics"]["refinement"]
        parts.append(f'<article id="asset-{asset["resource"]}"><h2>{html.escape(NAMES[asset["resource"]])} / {asset["resource"]}</h2><p class="status">{html.escape(result["acceptance"])}; {html.escape(diagnostics["verdict"])}</p>')
        parts.append('<p>' + html.escape("; ".join(diagnostics.get("reviewReasons", [])) or "No automatic approval. Image support still needs visual verification.") + '</p><div class="grid">')
        for label, path in asset["previews"].items():
            parts.append(picture(path, label))
        parts.append('</div><h3>Actual edge detail, enlarged</h3><div class="grid">')
        for label, path in asset["zooms"].items():
            parts.append(picture(path, label, True))
        parts.append('</div><details><summary>Displacement, topology and image evidence</summary><pre>' + html.escape(json.dumps(diagnostics, indent=2, sort_keys=True)) + '</pre></details></article>')
    parts.append('<p>This is a bounded image-guided contour candidate, not authenticated high-resolution ground truth. Generated object redesigns must be rejected before mask extraction. Canvas/state changes and gameplay clipping require separate validation.</p></main></html>')
    immutable(run_dir / "report.html", "\n".join(parts).encode())


def run(baseline_manifest, output_root, band_native=3):
    baseline_manifest, output_root = Path(baseline_manifest).resolve(), Path(output_root).resolve()
    baseline = json.loads(baseline_manifest.read_text())
    if baseline.get("scene") != "Scene1002" or baseline.get("scale") != 4:
        raise ValueError("Expected verified Scene1002 bindings")
    background_record = next(item for item in baseline["backgrounds"] if item["id"] == "nano-preservation")
    background_path = Path(background_record["path"])
    if sha(background_path) != background_record["sha256"]:
        raise ValueError("Frozen Nano background changed")
    with Image.open(background_path) as opened:
        background = opened.convert("RGB")
    if background.size != (2560, 1920):
        raise ValueError("Expected explicitly normalized Nano background")
    selected = []
    for resource in NAMES:
        rows = [item for item in baseline["candidates"] if item["assetId"] == resource]
        item = next((row for row in rows if row["variant"] == "nano-preservation"), rows[0])
        source = item["result"]["inputs"]["source"]
        if sha(source["path"]) != source["sha256"]:
            raise ValueError("Native guide mask source changed")
        selected.append(item)
    signature = {"version": 1, "baselineManifestSHA256": sha(baseline_manifest), "backgroundSHA256": sha(background_path),
                 "bandNative": band_native, "scale": 4,
                 "implementationSHA256": {name: sha(Path(__file__).with_name(name)) for name in ("contour_pilot.py", "pipeline.py", "refine.py")}}
    identity = hashlib.sha256(canonical(signature)).hexdigest()[:12]
    run_dir = output_root / identity
    records = []
    for old in selected:
        resource = old["assetId"]
        original = old["result"]
        source = original["inputs"]["source"]
        asset = {"id": resource + "-guided", "kind": original["kind"], "sourcePath": source["path"],
                 "sourceSHA256": source["sha256"], "contentSize": original["contentSize"], "canvasSize": original["canvasSize"],
                 "placement": original["placement"], "sourceIdentity": deepcopy(original["sourceIdentity"])}
        x, y = (value * 4 for value in asset["placement"])
        width, height = (value * 4 for value in asset["contentSize"])
        crop = background.crop((x, y, x + width, y + height))
        crop_path = Path(save(crop, run_dir / "guidance" / (resource + ".png")))
        kwargs = {"background_path": None, "scene_size": None, "rgb_path": None}
        if asset["kind"] == "foreground-occluder":
            asset["backgroundCorrespondence"] = "explicit-scene-binding"
            kwargs.update(background_path=background_path, scene_size=(640, 480))
        else:
            asset["sourceIdentity"]["rgbGuidance"] = {"backgroundSHA256": sha(background_path), "crop": [x, y, width, height], "alphaAuthority": False}
            kwargs["rgb_path"] = crop_path
        result = process_asset(asset, run_dir / "candidates", scale=4, mask_method="image-guided", band_native=band_native, **kwargs)
        with Image.open(result["outputs"]["rgba"]["path"]) as opened:
            rgba = opened.convert("RGBA")
        with Image.open(result["outputs"]["sourceNN"]["path"]) as opened:
            old_mask = np.asarray(opened.getchannel("A")) >= 128
        with Image.open(result["outputs"]["mask"]["path"]) as opened:
            new_mask = np.asarray(opened) >= 128
        with Image.open(result["outputs"]["rawMask"]["path"]) as opened:
            raw_mask = np.asarray(opened).copy()
        with Image.open(result["outputs"]["priorMask"]["path"]) as opened:
            prior_mask = np.asarray(opened).copy()
        padded_rgb = Image.new("RGB", rgba.size)
        padded_rgb.paste(crop, (0, 0))
        source_rgba = padded_rgb.convert("RGBA")
        source_rgba.putalpha(Image.fromarray(old_mask.astype(np.uint8) * 255))
        outline = overlay(padded_rgb, old_mask, new_mask)
        directory = run_dir / "previews" / resource
        previews = {"Source-NN mask on the same Nano RGB": save(matte(source_rgba), directory / "nearest.png"),
                    "Image-guided contour with edge coverage": save(matte(rgba), directory / "guided.png"),
                    "Red source-NN / cyan proposed contour": save(outline, directory / "outline.png")}
        prior_rgba = padded_rgb.convert("RGBA")
        prior_rgba.putalpha(Image.fromarray(prior_mask))
        previews["Geometry-only smooth prior, without RGB inference"] = save(matte(prior_rgba), directory / "prior.png")
        if not np.array_equal(raw_mask >= 128, new_mask):
            raw_rgba = padded_rgb.convert("RGBA")
            raw_rgba.putalpha(Image.fromarray(raw_mask))
            previews["Raw RGB proposal before topology checks (not approved)"] = save(matte(raw_rgba), directory / "raw-proposal.png")
        box = zoom_box(old_mask, (width, height))
        zooms = {"Source-NN edge, enlarged without smoothing": save(matte(source_rgba).crop(box).resize((384, 384), Image.Resampling.NEAREST), directory / "nearest-zoom.png"),
                 "Refined edge, same crop and display scale": save(matte(rgba).crop(box).resize((384, 384), Image.Resampling.NEAREST), directory / "guided-zoom.png"),
                 "Restored RGB with both contours, same enlargement": save(outline.crop(box).resize((384, 384), Image.Resampling.NEAREST), directory / "outline-zoom.png")}
        records.append({"resource": resource, "sourceNNChangedPixels": int(np.count_nonzero(old_mask != new_mask)),
                        "worldCrop": [x, y, width, height], "zoomBoxHD": list(box), "result": result, "previews": previews, "zooms": zooms})
        print(json.dumps({"resource": resource, "acceptance": result["acceptance"], "diagnostics": result["diagnostics"]["refinement"]}))
    record = {"schemaVersion": 1, "policy": "coarse-source-prior-restored-rgb-boundary", "signature": signature,
              "scene": "Scene1002", "assets": records, "runtimePromotion": False, "inferenceRequests": 0}
    immutable(run_dir / "manifest.json", canonical(record))
    write_report(run_dir, record)
    output_root.mkdir(parents=True, exist_ok=True)
    # The mutable landing page points to immutable, content-addressed runs.
    (output_root / "index.html").write_text(f'<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url={identity}/report.html"><title>Image-guided contours</title><a href="{identity}/report.html">Open the latest contour comparison</a></html>', encoding="utf-8")
    (output_root / "latest.json").write_bytes(canonical({"run": identity, "report": str(run_dir / "report.html"), "manifest": str(run_dir / "manifest.json")}))
    print(json.dumps({"report": str(run_dir / "report.html"), "assets": len(records), "inferenceRequests": 0}))
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-manifest", type=Path, default=ROOT / "private-assets/upscaling/static-layers/scene1002-v3/manifest.json")
    parser.add_argument("--output", type=Path, default=ROOT / "private-assets/upscaling/static-layers/scene1002-guided-v1")
    parser.add_argument("--band-native", type=float, default=3)
    args = parser.parse_args()
    run(args.baseline_manifest, args.output, args.band_native)
