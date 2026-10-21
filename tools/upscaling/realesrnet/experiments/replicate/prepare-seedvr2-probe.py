#!/usr/bin/env python3
"""Prepare a private, local, non-neural SeedVR2 input and exact source sidecars."""

import argparse
import hashlib
import io
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def private_directory(path):
    path = path.expanduser().resolve()
    repo = Path(__file__).resolve().parents[5]
    if path == repo or path.is_relative_to(repo):
        raise ValueError("Output must be outside the repository, including ignored/public trees")
    if any(part.lower() in ('public', 'www', 'wwwroot', 'htdocs') for part in path.parts):
        raise ValueError("Output must not be in a public directory")
    return path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="Private selected-source input manifest")
    parser.add_argument("--output", type=Path, required=True, help="New/empty private input directory outside the repository")
    parser.add_argument("--inspect", action="store_true", help="Print manifest cases only; no media writes or network")
    parser.add_argument("--resource", help="Complete resource case to prepare")
    args = parser.parse_args()
    manifest_path = args.manifest.expanduser().resolve()
    output = private_directory(args.output)
    if output == manifest_path.parent or output.is_relative_to(manifest_path.parent):
        parser.error("Output must not be inside the source manifest directory")
    manifest = json.loads(manifest_path.read_text())
    if args.inspect:
        for case in manifest["cases"]:
            frames = case["frames"]
            boxes = [f["metadata"] for f in frames]
            bounds = [min(m["x"] for m in boxes), min(m["y"] for m in boxes),
                      max(m["x"] + m["width"] for m in boxes),
                      max(m["y"] + m["height"] for m in boxes)]
            print(json.dumps({"resource": case["resource"], "label": case["label"],
                              "frames": len(frames), "bounds": bounds,
                              "durationTicks": sum(m["durationTicks"] for m in boxes)}))
        return
    if not args.resource:
        parser.error("select a complete case with --resource after --inspect")
    case = next(c for c in manifest["cases"] if c["resource"] == args.resource)
    frames = case["frames"]
    if not 1 <= len(frames) <= 97:
        raise ValueError("Complete case must fit a 49, 65 or 97-frame probe")
    images = []
    for ordinal, frame in enumerate(frames):
        path = (manifest_path.parent / frame["file"]).resolve()
        if not path.is_relative_to(manifest_path.parent):
            raise ValueError(f"Source frame escapes manifest directory: {path}")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != frame["sha256"]:
            raise ValueError(f"Source SHA256 mismatch: {path}")
        image = Image.open(io.BytesIO(raw))
        image.load()
        if image.mode != "RGBA":
            raise ValueError(f"Expected real source RGBA: {path}: {image.mode}")
        if set(np.unique(np.asarray(image)[:, :, 3]).tolist()) != {0, 255}:
            raise ValueError(f"Nonbinary or incomplete source alpha domain: {path}")
        meta = frame["metadata"]
        if list(image.size) != frame["size"] or image.size != (meta["width"], meta["height"]):
            raise ValueError(f"Source dimensions disagree with metadata: {path}")
        if frame["index"] != ordinal or meta["frameIndex"] != ordinal:
            raise ValueError("Noncontiguous original source ordinals")
        images.append(image)
    boxes = [f["metadata"] for f in frames]
    left = min(m["x"] for m in boxes)
    top = min(m["y"] for m in boxes)
    right = max(m["x"] + m["width"] for m in boxes)
    bottom = max(m["y"] + m["height"] for m in boxes)
    union_w, union_h = right - left, bottom - top
    # Exact 16:9 takes precedence over 32-pixel padding: the wrapper then has no crop.
    width, height = next((w, h) for w, h in [(320, 180), (384, 216), (512, 288),
                                           (640, 360), (768, 432), (1024, 576)]
                         if union_w + 16 <= w and union_h + 16 <= h)
    origin = [(width - union_w) // 2 - left, (height - union_h) // 2 - top]
    if not output.parent.is_dir():
        raise ValueError(f"Parent must be created and verified first: {output.parent}")
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Refusing to overwrite nonempty output: {output}")
    output.mkdir(exist_ok=True)
    for name in ("source_frames", "masks", "rgb_frames", "preview_frames"):
        (output / name).mkdir()
    yy, xx = np.indices((height, width))
    checker = np.where(((xx // 8 + yy // 8) % 2)[..., None], 176, 112)
    checker = Image.fromarray(np.repeat(checker, 3, axis=2).astype(np.uint8), "RGB")
    aligned, rgb, previews, source_records = [], [], [], []
    for ordinal, (frame, image) in enumerate(zip(frames, images)):
        meta = frame["metadata"]
        x, y = origin[0] + meta["x"], origin[1] + meta["y"]
        if not (0 <= x and 0 <= y and x + image.width <= width and y + image.height <= height):
            raise ValueError("Source would be cropped")
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        canvas.paste(image, (x, y))
        if not np.array_equal(np.asarray(canvas)[y:y + image.height, x:x + image.width], np.asarray(image)):
            raise ValueError("Native source pixels changed")
        mask = canvas.getchannel("A")
        background = Image.new("RGB", canvas.size, (128, 128, 128))
        background.paste(canvas.convert("RGB"), mask=mask)
        preview = checker.copy()
        preview.paste(canvas.convert("RGB"), mask=mask)
        source_file = f"source_frames/{ordinal:04d}.png"
        mask_file = f"masks/{ordinal:04d}.png"
        canvas.save(output / source_file)
        mask.save(output / mask_file)
        aligned.append(canvas)
        rgb.append(background)
        previews.append(preview)
        source_records.append({"sourceOrdinal": ordinal, "sourceFile": frame["file"],
                               "sourceSHA256": frame["sha256"], "sourceSHA256Verified": True,
                               "sourceFrameId": frame["frameId"], "durationTicks": meta["durationTicks"],
                               "deltaX": meta["deltaX"], "deltaY": meta["deltaY"],
                               "metadata": meta, "canvasXY": [x, y], "alignedRGBA": source_file,
                               "alignedSHA256": digest(output / source_file), "mask": mask_file,
                               "maskSHA256": digest(output / mask_file), "alphaValues": [0, 255]})
    total = next(n for n in (49, 65, 97) if n >= len(frames))
    before = (total - len(frames)) // 2
    after = total - len(frames) - before
    ordinals = [0] * before + list(range(len(frames))) + [len(frames) - 1] * after
    timeline = []
    for index, ordinal in enumerate(ordinals):
        role = "first_hold" if index < before else "last_hold" if index >= before + len(frames) else "core"
        rgb_file = f"rgb_frames/{index:04d}.png"
        preview_file = f"preview_frames/{index:04d}.png"
        rgb[ordinal].save(output / rgb_file)
        previews[ordinal].save(output / preview_file)
        timeline.append({"clipFrame": index, "sourceOrdinal": ordinal, "role": role,
                         "useForQuality": role == "core", "rgbFile": rgb_file,
                         "rgbSHA256": digest(output / rgb_file),
                         "durationTicks": frames[ordinal]["metadata"]["durationTicks"]})
    fps = 15
    for directory, filename in (("rgb_frames", "input.mp4"), ("preview_frames", "source-preview.mp4")):
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-n", "-framerate", str(fps),
                        "-i", str(output / directory / "%04d.png"), "-frames:v", str(total),
                        "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "0", "-pix_fmt", "yuv444p",
                        "-movflags", "+faststart", str(output / filename)], check=True)
    contact = Image.new("RGB", (width * 4, (height + 24) * ((len(frames) + 3) // 4)), (32, 32, 32))
    draw = ImageDraw.Draw(contact)
    for ordinal, preview in enumerate(previews):
        x, y = ordinal % 4 * width, ordinal // 4 * (height + 24)
        contact.paste(preview, (x, y))
        draw.text((x + 6, y + height + 5), f"source {ordinal:02d} / clip {before + ordinal:02d}", fill="white")
    contact.save(output / "contact-sheet.png")
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                                               "-show_entries", "stream=width,height,pix_fmt,nb_read_frames,r_frame_rate,duration",
                                               "-of", "json", str(output / "input.mp4")], text=True))
    stream = probe["streams"][0]
    if (stream["width"], stream["height"], int(stream["nb_read_frames"]), stream["pix_fmt"]) != (width, height, total, "yuv444p"):
        raise ValueError("Encoded clip geometry, frame count or pixel format mismatch")
    metadata = {"version": 1, "private": True, "sourceManifest": str(manifest_path),
                "sourceManifestSHA256": digest(manifest_path), "sourceBinding": manifest["sourceBinding"],
                "resource": case["resource"], "label": case["label"], "sourceFrameCount": len(frames),
                "sourceDurationTicks": sum(m["durationTicks"] for m in boxes),
                "sourceTickRateKnown": False, "canvas": [width, height], "origin": origin,
                "sourceMetadataUnion": [left, top, right, bottom], "alphaValues": [0, 255],
                "palettePolicy": "Source RGBA is hash-verified; original indexed palette is not reconstructed; model RGB is not palette-preserving",
                "placement": "fixed origin plus metadata x/y; deltaX/Y retained, not accumulated",
                "canvasPolicy": "Exact 16:9, minimum 8px margin; takes precedence over multiples32/min256 short side",
                "inputPixelProcessing": "native pixels; binary alpha composited over RGB(128,128,128); no neural processing",
                "encoding": "libx264 CRF0 yuv444p; lossless YUV encoding, RGB-YUV conversion is not RGB-bit-exact",
                "fps": fps, "clipFrameCount": total, "clipDurationSeconds": total / fps,
                "timingPolicy": "one frame per source ordinal, source ticks preserved as metadata, NOT tick-accurate playback",
                "holdsBefore": before, "holdsAfter": after, "coreClipRangeInclusive": [before, before + len(frames) - 1],
                "loop": False, "paddingPolicy": "balanced endpoint holds; padding excluded from quality; no repeated action boundary",
                "expectedWrapperOutput": [1280, 720], "expectedWrapperScale": 1280 / width,
                "expectedWrapperCropPixels": [0, 0], "desired4xCanvas": [width * 4, height * 4],
                "postprocessPlan": "If wrapper scale differs from 4, resample RGB output to desired4xCanvas before original-mask restoration; evaluate core only",
                "sourceFrames": source_records, "timeline": timeline, "ffprobe": probe,
                "videos": {name: {"file": name, "sha256": digest(output / name)}
                           for name in ("input.mp4", "source-preview.mp4")}}
    (output / "source-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({k: metadata[k] for k in ("resource", "label", "sourceFrameCount", "sourceDurationTicks", "canvas",
                                              "origin", "clipFrameCount", "holdsBefore", "holdsAfter", "expectedWrapperScale")}, indent=2))
    print(output / "source-metadata.json")


if __name__ == "__main__":
    main()
