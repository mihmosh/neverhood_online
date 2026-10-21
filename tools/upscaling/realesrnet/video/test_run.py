"""Offline movie-runner contract tests; no cloud, torch or GPU."""
import copy
import importlib.util
import json
from pathlib import Path
import struct
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('video_run', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def manifest():
    return {'version': 1, 'private': True, 'kind': 'navigation',
            'source': {'width': 320, 'height': 200, 'frames': 100, 'fps': '1000/67'},
            'selection': {'startFrame': 10, 'frames': 49},
            'target': {'width': 1280, 'height': 800, 'scale': 4},
            'input': {'file': 'input.mp4', 'sha256': 'input-hash'}, 'audio': None}


class VideoRunTests(unittest.TestCase):
    def validate(self, data, decoded_frames=49):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'manifest.json').write_text(json.dumps(data))
            info = {'streams': [{'width': 320, 'height': 200, 'nb_read_frames': str(decoded_frames),
                                 'avg_frame_rate': '1000/67'}]}
            with patch.object(runner.probe, 'sha256', side_effect=lambda p: 'manifest-hash' if p.name == 'manifest.json' else 'input-hash'), patch.object(runner.probe, 'run', return_value=json.dumps(info)):
                return runner.validate_manifest(directory, 'manifest-hash')

    def test_rational_timing_and_exact_range(self):
        self.assertEqual(self.validate(manifest()), manifest())
        with self.assertRaisesRegex(ValueError, 'Decoded'):
            self.validate(manifest(), 48)

    def test_reject_unbounded_or_public_jobs(self):
        for keys, value in [(['private'], False), (['selection', 'frames'], 122),
                            (['selection', 'startFrame'], -1), (['source', 'fps'], '0/1'),
                            (['target', 'width'], 1281), (['input', 'file'], '../input.mp4')]:
            data = copy.deepcopy(manifest())
            target = data
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            with self.subTest(keys=keys), self.assertRaises(ValueError):
                self.validate(data)

    def test_manifest_hash_is_binding(self):
        with patch.object(runner.probe, 'sha256', return_value='wrong'):
            with self.assertRaisesRegex(ValueError, 'Manifest SHA256'):
                runner.validate_manifest(Path('/private'), 'expected')

    def test_command_reuses_baseline_but_not_sprite_geometry(self):
        command = runner.inference_command(Path('/runner'), Path('/private'), Path('/run'), manifest())
        for flag, value in {'--resolution': '800', '--max_resolution': '1280', '--load_cap': '49',
                            '--batch_size': '5', '--seed': '314159', '--output_format': 'png',
                            '--blocks_to_swap': '28',
                            '--dit_model': 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors'}.items():
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn('/private/input.mp4', command)
        self.assertEqual(command[:4], ['timeout', '--signal=TERM', '--kill-after=30s', '15m'])
        self.assertNotIn('--compile_dit', command)
        self.assertEqual(runner.probe.MODEL_VARIANT, '7b')
        self.assertEqual(runner.probe.MODEL_HASHES[runner.probe.DIT],
                         '3d68b5ec0b295ae28092e355c8cad870edd00b817b26587d0cb8f9dd2df19bb2')

    def test_output_validation_and_order(self):
        data = manifest()
        data['selection']['frames'] = 2
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / 'artifacts/frames/input'
            directory.mkdir(parents=True)
            header = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 1280, 800) + b'\x08\x02\0\0\0' + b'\0' * 4
            for i in range(2):
                (directory / f'input_{i:06d}.png').write_bytes(header)
            with patch.object(runner.probe, 'run') as decode:
                self.assertEqual(len(runner.inspect_frames(root, data)), 2)
                self.assertIn('1000/67', decode.call_args.args[0])
                (directory / 'input_000001.png').rename(directory / 'input_000002.png')
                with self.assertRaisesRegex(ValueError, 'ordinals'):
                    runner.inspect_frames(root, data)

    def test_dry_run_never_runs_inference(self):
        args = ['run.py', '--input', '/private', '--manifest-sha256', 'expected', '--run-id', 'pilot']
        with patch.object(runner.sys, 'argv', args), patch.object(runner, 'validate_manifest', return_value=manifest()), patch.object(runner.probe, 'measure_inference') as inference, patch('builtins.print'):
            self.assertEqual(runner.main(), 0)
            inference.assert_not_called()

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_mux_with_fractional_fps_and_audio(self):
        data = manifest()
        data['source'].update(width=16, height=16)
        data['source']['fps'] = '50000/3333'
        data['target'].update(width=64, height=64)
        data['selection']['frames'] = 5
        data['audio'] = {'file': 'audio.mka', 'streams': [{}]}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'runs').mkdir()
            directory = root / 'private'
            directory.mkdir()
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=sample_rate=22050',
                            '-t', '0.335', '-c:a', 'flac', str(directory / 'audio.mka')], check=True)
            original_run = runner.probe.run

            def run(command, *args, **kwargs):
                if command[0] == 'git':
                    return runner.probe.REVISION if 'rev-parse' in command else ''
                return original_run(command, *args, **kwargs)

            def fake_inference(command, log, report):
                frames = root / 'runs/video-synthetic/artifacts/frames/input'
                frames.mkdir(parents=True)
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                                'testsrc=size=64x64:rate=50000/3333', '-frames:v', '5',
                                '-start_number', '0', str(frames / 'input_%06d.png')], check=True)

            argv = ['run.py', '--input', str(directory), '--manifest-sha256', 'expected',
                    '--run-id', 'synthetic', '--root', str(root), '--execute']
            with patch.object(runner.sys, 'argv', argv), patch.object(runner, 'validate_manifest', return_value=data), patch.object(runner.probe, 'MODEL_HASHES', {}), patch.object(runner.probe, 'run', side_effect=run), patch.object(runner.probe, 'measure_inference', side_effect=fake_inference), patch('builtins.print'):
                self.assertEqual(runner.main(), 0)
            report = json.loads((root / 'runs/video-synthetic/report.json').read_text())
            self.assertEqual(report['status'], 'succeeded')
            self.assertEqual(len(report['frames']), 5)
            self.assertFalse(report['approvedForRuntime'])


if __name__ == '__main__':
    unittest.main()
