#!/usr/bin/env python3
"""Prepare a bounded, private, local video pilot without running inference."""

import argparse
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import subprocess


PRIVATE_ROOT = Path(__file__).resolve().parents[4] / "private-research"
TIMEOUT = 120


def run(command):
    return subprocess.run(command, check=True, capture_output=True, text=True,
                          timeout=TIMEOUT)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def probe(path):
    result = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                  "-count_frames", "-show_streams", "-of", "json", str(path)])
    if result.stderr.strip():
        raise ValueError(f"Media decode errors: {result.stderr.strip()}")
    return json.loads(result.stdout)["streams"]


def video_info(streams):
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(videos) != 1:
        raise ValueError("Expected exactly one video stream")
    stream = videos[0]
    try:
        width, height = int(stream["width"]), int(stream["height"])
        count = int(stream["nb_read_frames"])
        nominal = Fraction(stream["r_frame_rate"])
        # Smacker demuxing reports avg_frame_rate=0/0 despite exact frame ticks.
        if stream.get("codec_name") == "smackvideo" and stream.get("avg_frame_rate") == "0/0":
            fps = 1 / Fraction(stream["time_base"])
        else:
            fps = Fraction(stream["avg_frame_rate"])
    except (KeyError, ValueError, ZeroDivisionError) as error:
        raise ValueError("Video needs decoded frame count, dimensions and rational FPS") from error
    if width < 1 or height < 1 or count < 1 or fps <= 0 or fps != nominal:
        raise ValueError("Video must have positive dimensions/count and constant rational FPS")
    return stream, width, height, count, fps


def rational(value):
    return f"{value.numerator}/{value.denominator}"


def verify_timeline(path, stream, width, height, count, fps):
    """Reject VFR, resolution changes and nonzero origins rather than retime them."""
    result = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                  "-select_streams", "v:0", "-show_frames", "-show_entries",
                  "frame=best_effort_timestamp,width,height", "-of", "json", str(path)])
    if result.stderr.strip():
        raise ValueError("Source frame timeline could not be decoded cleanly")
    decoded = json.loads(result.stdout)["frames"]
    tick = Fraction(stream["time_base"])
    if len(decoded) != count:
        raise ValueError("Source decoded frame count changed")
    for index, frame in enumerate(decoded):
        try:
            timestamp = int(frame["best_effort_timestamp"]) * tick
            geometry = (int(frame["width"]), int(frame["height"]))
        except (KeyError, ValueError) as error:
            raise ValueError("Source frame lacks timing or geometry") from error
        # One tick accommodates e.g. rational FPS in millisecond Matroska timebases.
        if geometry != (width, height) or abs(timestamp - Fraction(index, 1) / fps) > min(tick, 1 / (fps * 2)):
            raise ValueError("Source must have constant geometry and a zero-origin CFR timeline")


def seconds(value):
    # ffmpeg duration expressions accept decimals, not rational fractions.
    with localcontext() as context:
        context.prec = 40
        return format(Decimal(value.numerator) / Decimal(value.denominator), "f")


def prepare(source, output, kind, start_frame=0, frames=1, private_root=PRIVATE_ROOT,
            preserve_audio=True, max_target_pixels=1536 * 1024):
    """Create a new private pilot directory; return its version-one manifest."""
    if kind not in ("cutscene", "navigation"):
        raise ValueError("kind must explicitly be cutscene or navigation")
    if type(start_frame) is not int or start_frame < 0:
        raise ValueError("start_frame must be a nonnegative integer")
    if type(frames) is not int or not 1 <= frames <= 121:
        raise ValueError("frames must be between 1 and 121")
    if type(max_target_pixels) is not int or not 0 < max_target_pixels <= 1792 * 960:
        raise ValueError("Explicit pixel bound must not exceed the audited full-corpus 1792x960 maximum")
    source = Path(source).expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError("source must be a local file")
    root = Path(private_root).expanduser().resolve()
    requested_output = Path(output).expanduser().absolute()
    output = requested_output.resolve()
    if output == root or not output.is_relative_to(root):
        raise ValueError("output must be inside the private research root")
    if any(part.lower() in {"web", "dist", "public", "www", "wwwroot", "htdocs"}
           for part in output.parts):
        raise ValueError("output must not be in a public directory")
    if requested_output.is_symlink() or output.exists():
        raise ValueError("output must be a new directory; refusing overwrite")

    source_hash = digest(source)
    streams = probe(source)
    stream, width, height, total, fps = video_info(streams)
    if width > 640 or height > 480:
        raise ValueError("source dimensions exceed the 640x480 pilot bound")
    target_width, target_height = width * 4, height * 4
    if (target_width % 16 or target_height % 16 or max(target_width, target_height) > 2048
            or target_width * target_height > max_target_pixels):
        raise ValueError("4x target must be multiples of 16, at most 2048 per side and within the explicit pixel bound")
    if start_frame + frames > total:
        raise ValueError("selected frame range exceeds source frame count")
    # Delayed tracks need a separate synchronization policy; do not silently shift them.
    for item in streams:
        if item.get("codec_type") in ("video", "audio"):
            try:
                origin = Fraction(item.get("start_time", "0"))
            except (ValueError, ZeroDivisionError) as error:
                raise ValueError("Source stream start time is unknown") from error
            if origin != 0:
                raise ValueError("Source video/audio streams must start at zero; delayed tracks are unsupported")
    verify_timeline(source, stream, width, height, total, fps)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.mkdir(mode=0o700)
    input_path = output / "input.mp4"
    base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-n",
            "-protocol_whitelist", "file,pipe", "-i", str(source)]
    end_frame = start_frame + frames - 1
    run(base + ["-map", f"0:{stream['index']}", "-vf",
                f"select=between(n\\,{start_frame}\\,{end_frame}),setpts=PTS-STARTPTS",
                "-frames:v", str(frames), "-fps_mode", "passthrough", "-an", "-sn", "-dn",
                "-c:v", "libx264", "-preset", "slow", "-crf", "0", "-pix_fmt", "yuv444p",
                "-video_track_timescale", str(fps.numerator), "-movflags", "+faststart",
                str(input_path)])
    os.chmod(input_path, 0o600)
    prepared_streams = probe(input_path)
    prepared, actual_w, actual_h, actual_count, actual_fps = video_info(prepared_streams)
    if (actual_w, actual_h, actual_count, actual_fps) != (width, height, frames, fps):
        raise ValueError("Prepared input count, frame rate or dimensions changed")
    if (prepared.get("codec_name") != "h264" or prepared.get("pix_fmt") != "yuv444p"
            or any(s.get("codec_type") == "audio" for s in prepared_streams)):
        raise ValueError("Prepared input must be silent H.264 yuv444p")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror",
         "-protocol_whitelist", "file,pipe", "-i", str(input_path),
         "-map", "0:v:0", "-f", "null", "-"])

    audio = None
    tracks = [s for s in streams if s.get("codec_type") == "audio"]
    start, duration = Fraction(start_frame, 1) / fps, Fraction(frames, 1) / fps
    if preserve_audio and tracks:
        audio_path = output / "audio.mka"
        mappings = [arg for track in tracks for arg in ("-map", f"0:{track['index']}")]
        run(base + mappings + ["-vn", "-sn", "-dn", "-af",
                               f"atrim=start={seconds(start)}:duration={seconds(duration)},asetpts=PTS-STARTPTS",
                               "-c:a", "flac", str(audio_path)])
        os.chmod(audio_path, 0o600)
        actual_tracks = [s for s in probe(audio_path) if s.get("codec_type") == "audio"]
        if len(actual_tracks) != len(tracks) or any(s.get("codec_name") != "flac" for s in actual_tracks):
            raise ValueError("Audio sidecar did not retain all tracks as FLAC")
        audio = {"file": "audio.mka", "sha256": digest(audio_path),
                 "start": rational(start), "duration": rational(duration),
                 "streams": [{"sourceIndex": s["index"], "codec": "flac",
                              "channels": int(s["channels"]), "sampleRate": int(s["sample_rate"])}
                             for s in tracks]}
    if digest(source) != source_hash:
        raise ValueError("Source changed during preparation")
    manifest = {"version": 1, "private": True, "kind": kind,
                "source": {"sha256": source_hash, "width": width, "height": height,
                           "fps": rational(fps), "frames": total},
                "selection": {"startFrame": start_frame, "frames": frames},
                "target": {"width": width * 4, "height": height * 4, "scale": 4},
                "input": {"file": "input.mp4", "sha256": digest(input_path)}, "audio": audio}
    with (output / "manifest.json").open("x", encoding="utf-8") as handle:
        os.chmod(handle.name, 0o600)
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--kind", choices=("cutscene", "navigation"), required=True)
    parser.add_argument("--start-frame", type=int, default=0)
    parser.add_argument("--frames", type=int, required=True)
    parser.add_argument("--scale", type=int, choices=(4,), default=4)
    parser.add_argument("--no-audio", action="store_true")
    args = parser.parse_args(argv)
    try:
        prepare(args.source, args.output, args.kind, args.start_frame, args.frames,
                preserve_audio=not args.no_audio)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Preparation failed: {error}\n")
    print(args.output / "manifest.json")


if __name__ == "__main__":
    main()
