"""Local-only preparation tests; integration media is generated synthetically."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("video_prepare", Path(__file__).with_name("prepare.py"))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def video(frames=10, fps="30000/1001", width=64, height=48):
    return {"index": 0, "codec_type": "video", "codec_name": "h264",
            "pix_fmt": "yuv444p", "width": width, "height": height,
            "nb_read_frames": str(frames), "avg_frame_rate": fps, "r_frame_rate": fps}


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.smk"
        self.source.write_bytes(b"synthetic mock source")
        self.output = self.root / "private" / "pilot"
        timeline = patch.object(prepare, "verify_timeline")
        timeline.start()
        self.addCleanup(timeline.stop)

    def prepare(self, **kwargs):
        options = dict(source=self.source, output=self.output, kind="cutscene",
                       start_frame=2, frames=5, private_root=self.root / "private")
        options.update(kwargs)
        return prepare.prepare(**options)

    def fake_run(self, command):
        if command[-1] != "-":
            Path(command[-1]).write_bytes(b"synthetic encoded result")
        return subprocess.CompletedProcess(command, 0, "", "")

    def test_manifest_and_exact_frame_selection(self):
        with patch.object(prepare, "probe", side_effect=[[video()], [video(frames=5)]]), \
                patch.object(prepare, "run", side_effect=self.fake_run) as run:
            result = self.prepare()
        self.assertEqual(result["version"], 1)
        self.assertIs(result["private"], True)
        self.assertEqual(result["source"]["sha256"], prepare.digest(self.source))
        self.assertEqual(result["source"]["fps"], "30000/1001")
        self.assertEqual(result["selection"], {"startFrame": 2, "frames": 5})
        self.assertEqual(result["target"], {"width": 256, "height": 192, "scale": 4})
        self.assertEqual(result["input"]["file"], "input.mp4")
        self.assertIsNone(result["audio"])
        self.assertEqual(json.loads((self.output / "manifest.json").read_text()), result)
        command = run.call_args_list[0].args[0]
        self.assertEqual(command[command.index("-vf") + 1],
                         "select=between(n\\,2\\,6),setpts=PTS-STARTPTS")
        self.assertEqual(command[command.index("-fps_mode") + 1], "passthrough")
        self.assertEqual(command[command.index("-crf") + 1], "0")
        self.assertNotIn("-r", command)
        self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        for name in ("input.mp4", "manifest.json"):
            self.assertEqual((self.output / name).stat().st_mode & 0o777, 0o600)

    def test_reject_invalid_arguments_before_subprocess(self):
        with patch.object(prepare, "run") as run:
            for options in ({"kind": None}, {"kind": "other"}, {"frames": 0},
                            {"frames": 122}, {"frames": True}, {"start_frame": -1},
                            {"start_frame": 0.5}, {"output": self.root / "public"},
                            {"output": self.root / "private"},
                            {"output": self.root / "private" / "web" / "clip"}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    self.prepare(**options)
        run.assert_not_called()

    def test_reject_existing_directory_and_symlink_escape(self):
        self.output.mkdir(parents=True)
        with self.assertRaises(ValueError):
            self.prepare()
        link = self.output.parent / "escape"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.prepare(output=link / "outside")

    def test_reject_source_bounds_and_range(self):
        for stream in (video(width=641), video(height=481), video(frames=3),
                       video(width=640, height=480), video(width=320, height=202)):
            with self.subTest(stream=stream), patch.object(prepare, "probe", return_value=[stream]), \
                    self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse(self.output.exists())

    def test_reject_nonzero_stream_origins(self):
        for streams in ([dict(video(), start_time="1.0")],
                        [video(), {"codec_type": "audio", "start_time": "0.01"}]):
            with self.subTest(streams=streams), patch.object(prepare, "probe", return_value=streams), \
                    self.assertRaisesRegex(ValueError, "must start at zero"):
                self.prepare()
        self.assertFalse(self.output.exists())

    def test_audited_wide_movies_need_explicit_bulk_pixel_bound(self):
        streams = [video(width=448, height=240)]
        with patch.object(prepare, "probe", return_value=streams), self.assertRaises(ValueError):
            self.prepare()
        with patch.object(prepare, "probe", side_effect=[streams, [video(frames=5, width=448, height=240)]]), \
                patch.object(prepare, "run", side_effect=self.fake_run):
            result = self.prepare(max_target_pixels=1792 * 960)
        self.assertEqual(result['target'], {'width': 1792, 'height': 960, 'scale': 4})

    def test_reject_invalid_probe_information(self):
        for streams in ([], [video(), video()], [video(fps="0/0")],
                        [dict(video(), nb_read_frames="N/A")],
                        [dict(video(), r_frame_rate="15/1")]):
            with self.subTest(streams=streams), self.assertRaises(ValueError):
                prepare.video_info(streams)

    def test_smacker_uses_exact_demuxer_tick_when_average_is_unavailable(self):
        stream = dict(video(fps="50000/3333"), codec_name="smackvideo",
                      avg_frame_rate="0/0", time_base="3333/50000")
        self.assertEqual(prepare.video_info([stream])[-1], prepare.Fraction(50000, 3333))
        stream["time_base"] = "1/15"
        with self.assertRaises(ValueError):
            prepare.video_info([stream])

    def test_reject_decoded_input_mismatch(self):
        for change in ({"frames": 4}, {"fps": "25/1"}, {"width": 65}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                with patch.object(prepare, "probe", side_effect=[[video()], [video(**change)]]), \
                        patch.object(prepare, "run", side_effect=self.fake_run), self.assertRaises(ValueError):
                    self.prepare(output=Path(directory) / "clip", private_root=directory)
                self.assertFalse((Path(directory) / "clip" / "manifest.json").exists())

    def test_source_change_prevents_manifest(self):
        with patch.object(prepare, "probe", side_effect=[[video()], [video(frames=5)]]), \
                patch.object(prepare, "run", side_effect=self.fake_run), \
                patch.object(prepare, "digest", side_effect=["before", "after"]), \
                self.assertRaisesRegex(ValueError, "Source changed"):
            self.prepare()
        self.assertFalse((self.output / "manifest.json").exists())

    def test_audio_multiple_tracks_and_fractional_timing(self):
        tracks = [{"index": index, "codec_type": "audio", "codec_name": "flac",
                   "channels": 1, "sample_rate": "48000"} for index in (1, 2)]
        with patch.object(prepare, "probe", side_effect=[[video()] + tracks, [video(frames=5)], tracks]), \
                patch.object(prepare, "run", side_effect=self.fake_run) as run:
            result = self.prepare()
        self.assertEqual(result["audio"]["start"], "1001/15000")
        self.assertEqual(result["audio"]["duration"], "1001/6000")
        self.assertEqual([s["sourceIndex"] for s in result["audio"]["streams"]], [1, 2])
        command = run.call_args_list[2].args[0]
        self.assertIn("0:1", command)
        self.assertIn("0:2", command)
        self.assertIn("atrim=start=0.06673333333333333333333333333333333333333", command[command.index("-af") + 1])

    def test_probe_uses_timeout_and_reports_decode_errors(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"streams": []}', "")) as run:
            self.assertEqual(prepare.probe(self.source), [])
        self.assertEqual(run.call_args.kwargs["timeout"], 120)
        self.assertIn("-count_frames", run.call_args.args[0])
        with patch.object(prepare, "run", return_value=subprocess.CompletedProcess([], 0, '{}', "decode failed")), \
                self.assertRaisesRegex(ValueError, "decode"):
            prepare.probe(self.source)

    def test_cli_requires_kind_and_fixed_scale(self):
        for extra in ([], ["--kind", "cutscene", "--scale", "2"]):
            with self.subTest(extra=extra), patch("sys.stderr"), self.assertRaises(SystemExit) as error:
                prepare.main(["--source", str(self.source), "--output", str(self.output), "--frames", "1"] + extra)
            self.assertEqual(error.exception.code, 2)


class TimelineTests(unittest.TestCase):
    def test_timeline_rejects_vfr_and_geometry_changes(self):
        for frames in ([{"best_effort_timestamp": 0, "width": 64, "height": 48},
                        {"best_effort_timestamp": 200, "width": 64, "height": 48}],
                       [{"best_effort_timestamp": 0, "width": 64, "height": 48},
                        {"best_effort_timestamp": 40, "width": 65, "height": 48}]):
            result = subprocess.CompletedProcess([], 0, json.dumps({"frames": frames}), "")
            with self.subTest(frames=frames), patch.object(prepare, "run", return_value=result), \
                    self.assertRaises(ValueError):
                prepare.verify_timeline(Path("synthetic"), {"time_base": "1/1000"},
                                        64, 48, 2, prepare.Fraction(25))

    def test_timeline_accepts_container_tick_rounding(self):
        frames = [{"best_effort_timestamp": timestamp, "width": 64, "height": 48}
                  for timestamp in (0, 33, 67, 100)]
        result = subprocess.CompletedProcess([], 0, json.dumps({"frames": frames}), "")
        with patch.object(prepare, "run", return_value=result):
            prepare.verify_timeline(Path("synthetic"), {"time_base": "1/1000"},
                                    64, 48, 4, prepare.Fraction(30000, 1001))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe unavailable")
class SyntheticMediaTests(unittest.TestCase):
    def test_fractional_fps_multiple_audio_and_exact_selected_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mkv"
            prepare.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-n",
                         "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=30000/1001:duration=1",
                         "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
                         "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
                         "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264",
                         "-crf", "0", "-pix_fmt", "yuv444p", "-c:a", "flac", str(source)])
            result = prepare.prepare(source, root / "private" / "clip", "navigation", 3, 7,
                                     private_root=root / "private")
            self.assertEqual(result["source"]["fps"], "30000/1001")
            self.assertEqual(result["selection"]["frames"], 7)
            self.assertEqual(len(result["audio"]["streams"]), 2)
            output = root / "private" / "clip" / "input.mp4"
            common = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i"]
            expected = subprocess.run(common + [str(source), "-vf", "select=between(n\\,3\\,9)",
                                                "-fps_mode", "passthrough", "-an", "-pix_fmt", "yuv444p",
                                                "-f", "rawvideo", "-"], check=True, capture_output=True, timeout=120)
            actual = subprocess.run(common + [str(output), "-an", "-pix_fmt", "yuv444p", "-f", "rawvideo", "-"],
                                    check=True, capture_output=True, timeout=120)
            self.assertEqual(actual.stdout, expected.stdout)
            self.assertEqual(len(actual.stdout), 64 * 48 * 3 * 7)

    def test_single_frame_without_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            prepare.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi",
                         "-i", "testsrc2=size=32x24:rate=15:duration=1", "-c:v", "libx264", str(source)])
            result = prepare.prepare(source, root / "clip", "cutscene", 14, 1, private_root=root)
            self.assertIsNone(result["audio"])
            self.assertEqual(result["selection"], {"startFrame": 14, "frames": 1})
            self.assertEqual(result["source"]["fps"], "15/1")


if __name__ == "__main__":
    unittest.main()
