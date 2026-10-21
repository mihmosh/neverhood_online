#!/usr/bin/env python3
"""Triplicate a verified local 49-frame probe without changing its context."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_path(root, relative, expected):
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or sha256(path) != expected:
        raise ValueError(f"Invalid path or SHA256 mismatch: {relative}")
    return path


def make_timeline(original):
    if len(original) != 49 or [f["clipFrame"] for f in original] != list(range(49)):
        raise ValueError("Expected all 49 original processing frames in order")
    timeline = []
    for frame in original:
        for role in ("tripleFirst", "middle", "last"):
            timeline.append({"outputFrame": len(timeline), "originalClipFrame": frame["clipFrame"],
                             "sourceOrdinal": frame["sourceOrdinal"], "role": role,
                             "originalRole": frame["role"], "selected": role == "middle",
                             "useForQuality": role == "middle" and frame["useForQuality"],
                             "durationTicks": frame["durationTicks"],
                             "originalRGBFile": frame["rgbFile"], "originalRGBSHA256": frame["rgbSHA256"]})
    for _ in range(2):
        timeline.append({**timeline[-1], "outputFrame": len(timeline), "role": "endpad",
                         "selected": False, "useForQuality": False})
    return timeline


def prepare(input_dir, output):
    input_dir, output = input_dir.resolve(), output.resolve()
    if output == input_dir or output.is_relative_to(input_dir):
        raise ValueError("Output must not modify original input directory")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Refusing to overwrite nonempty output")
    metadata_path = input_dir / "source-metadata.json"
    metadata = json.loads(metadata_path.read_text())
    if metadata["canvas"] != [384, 216] or metadata["fps"] != 15 or metadata["clipFrameCount"] != 49:
        raise ValueError("Expected prepared 384x216, 49-frame, 15fps input")
    timeline = make_timeline(metadata["timeline"])
    selected = [f["outputFrame"] for f in timeline if f["selected"]]
    core = [f["outputFrame"] for f in timeline if f["useForQuality"]]
    if selected != [1 + 3 * i for i in range(49)] or core != [25 + 3 * i for i in range(32)]:
        raise ValueError("Original core/hold mapping differs from expected probe")
    video = metadata["videos"]["input.mp4"]
    checked_path(input_dir, video["file"], video["sha256"])
    arrays = []
    for frame in metadata["timeline"]:
        path = checked_path(input_dir, frame["rgbFile"], frame["rgbSHA256"])
        with Image.open(path) as image:
            if image.mode != "RGB" or image.size != (384, 216):
                raise ValueError("Original RGB PNG format mismatch")
            arrays.append(np.array(image))
    for source in metadata["sourceFrames"]:
        rgba_path = checked_path(input_dir, source["alignedRGBA"], source["alignedSHA256"])
        mask_path = checked_path(input_dir, source["mask"], source["maskSHA256"])
        with Image.open(rgba_path) as rgba, Image.open(mask_path) as mask:
            if rgba.mode != "RGBA" or mask.mode != "L" or rgba.size != (384, 216) or mask.size != rgba.size:
                raise ValueError("Original sidecar format mismatch")
            alpha = np.asarray(rgba)[:, :, 3]
            if set(np.unique(alpha).tolist()) != {0, 255} or not np.array_equal(alpha, np.asarray(mask)):
                raise ValueError("Original mask/alpha is not exact binary alpha")
    output.mkdir(parents=True, exist_ok=True)
    # Feed original RGB bytes directly; no resampling, interpolation or PNG duplicates.
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-n", "-f", "rawvideo",
               "-pixel_format", "rgb24", "-video_size", "384x216", "-framerate", "45", "-i", "pipe:0",
               "-frames:v", "149", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "0",
               "-pix_fmt", "yuv444p", "-fps_mode", "cfr", "-movflags", "+faststart", str(output / "input.mp4")]
    raw = b"".join(arrays[f["originalClipFrame"]].tobytes() for f in timeline)
    subprocess.run(command, input=raw, check=True)
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                               "-count_frames", "-show_entries",
                                               "stream=width,height,pix_fmt,nb_read_frames,r_frame_rate,duration:frame=best_effort_timestamp_time",
                                               "-of", "json", str(output / "input.mp4")], text=True))
    stream = probe["streams"][0]
    if (stream["width"], stream["height"], stream["pix_fmt"], stream["nb_read_frames"], stream["r_frame_rate"]) != (384, 216, "yuv444p", "149", "45/1"):
        raise ValueError("Encoded stream dimensions/count/format/rate mismatch")
    pts = np.array([float(f["best_effort_timestamp_time"]) for f in probe["frames"]])
    if len(pts) != 149 or not np.allclose(pts, np.arange(149) / 45, atol=0.000002):
        raise ValueError("Encoded stream is not exact CFR45")
    decoded = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(output / "input.mp4"),
                                       "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
    decoded = np.frombuffer(decoded, dtype=np.uint8).reshape(149, 216, 384, 3)
    for index in range(49):
        a, b, c = decoded[3 * index:3 * index + 3]
        if not np.array_equal(a, b) or not np.array_equal(b, c):
            raise ValueError(f"Decoded copies differ within triple {index}")
    if not np.array_equal(decoded[146], decoded[147]) or not np.array_equal(decoded[147], decoded[148]):
        raise ValueError("Decoded end padding differs from last frame")
    max_delta = max(int(np.abs(decoded[f["outputFrame"]].astype(np.int16) -
                               arrays[f["originalClipFrame"]].astype(np.int16)).max()) for f in timeline)
    examples = [0, 1, 2, 23, 24, 25, 26, 27, 28, 116, 117, 118, 119, 120, 121, 146, 147, 148]
    contact = Image.new("RGB", (384 * 3, 240 * 6), (24, 24, 24))
    draw = ImageDraw.Draw(contact)
    for tile, index in enumerate(examples):
        x, y = tile % 3 * 384, tile // 3 * 240
        contact.paste(Image.fromarray(decoded[index]), (x, y))
        frame = timeline[index]
        draw.text((x + 4, y + 220), f'{index}: clip {frame["originalClipFrame"]} {frame["role"]}', fill="white")
    contact.save(output / "contact-sheet.png")
    mapping = {"version": 1, "private": True, "sourceInputDir": str(input_dir),
               "sourceMetadataSHA256": sha256(metadata_path), "originalInputSHA256": video["sha256"],
               "inputSHA256": sha256(output / "input.mp4"), "canvas": [384, 216], "fps": 45,
               "clipFrameCount": 149, "clipDurationSeconds": 149 / 45,
               "originalProcessingDurationSeconds": 49 / 15, "extraPaddingDurationSeconds": 2 / 45,
               "selectedMiddleIndices": selected, "coreMiddleIndices": core, "timeline": timeline,
               "validation": {"allSourceRGBHashesVerified": True, "originalInputHashVerified": True,
                              "alignedRGBAAndMaskHashesVerified": True, "alphaValues": [0, 255],
                              "decodedTripleCopiesIdentical": True, "decodedEndPadsIdentical": True,
                              "maxRGBRoundtripDelta": max_delta, "maxRGBRoundtripDeltaLE1": max_delta <= 1,
                              "cfr45Verified": True},
               "notes": ["All original 49 processing frames tripled, including endpoint holds.",
                         "Select middle indices only; exclude original holds from core quality.",
                         "No interpolation/resampling; RGB-to-YUV conversion can change RGB values.",
                         "Original RGBA and masks remain local at sourceInputDir; not duplicated.",
                         "Upload only input.mp4 and manifests; private manifests contain local paths."],
               "ffprobeStream": stream}
    (output / "triplicate-mapping.json").write_text(json.dumps(mapping, indent=2) + "\n")
    sidecar = {**metadata, **{k: mapping[k] for k in ("canvas", "fps", "clipFrameCount", "clipDurationSeconds", "timeline")},
               "sourceInputDir": str(input_dir), "sourceMetadataSHA256": mapping["sourceMetadataSHA256"],
               "originalInputSHA256": video["sha256"], "mappingFile": "triplicate-mapping.json",
               "sourceSidecarPathsRelativeTo": "sourceInputDir", "originalTimeline": metadata["timeline"],
               "selectedMiddleIndices": selected, "coreMiddleIndices": core,
               "originalHoldsBefore": metadata["holdsBefore"], "originalHoldsAfter": metadata["holdsAfter"],
               "holdsBefore": metadata["holdsBefore"] * 3, "holdsAfter": metadata["holdsAfter"] * 3,
               "endPaddingFrames": 2,
               "expectedWrapperOutput": [1536, 864], "expectedWrapperScale": 4,
               "postprocessPlan": "Keep only explicitly mapped middle outputs; no RGB resizing; reattach original nearest-4x binary masks",
               "paddingPolicy": "Original endpoint holds tripled without removal; two extra last-frame endpads never selected",
               "coreClipRangeInclusive": [25, 118], "coreClipRangeIsSparse": True,
               "timingPolicy": "Triples at CFR45 retain CFR15 processing duration plus 2/45s end padding; original ticks unchanged",
               "videos": {"input.mp4": {"file": "input.mp4", "sha256": mapping["inputSHA256"]}},
               "validation": mapping["validation"]}
    (output / "source-metadata.json").write_text(json.dumps(sidecar, indent=2) + "\n")
    print(json.dumps({"output": str(output), "inputSHA256": mapping["inputSHA256"],
                      "originalInputSHA256": video["sha256"], "frames": 149, "fps": 45,
                      "canvas": [384, 216], "selectedFrames": len(selected), "coreFrames": len(core),
                      "bytes": (output / "input.mp4").stat().st_size, "validation": mapping["validation"]}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.input_dir, args.output)
