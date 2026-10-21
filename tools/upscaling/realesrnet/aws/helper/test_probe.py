"""Offline tests: no AWS, torch, models, or GPU required."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('probe.py'))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
SPEC7B = importlib.util.spec_from_file_location('probe7b', Path(__file__).with_name('probe7b.py'))
probe7b = importlib.util.module_from_spec(SPEC7B)
with patch.dict('sys.modules', {'probe': probe}):
    SPEC7B.loader.exec_module(probe7b)


class ProbeTests(unittest.TestCase):
    def test_normal_7b_registry_and_quality_parity(self):
        baseline = probe.inference_command(Path('/runner'), Path('/run'))

        def check_config():
            self.assertEqual(probe.REVISION, '4490bd1f482e026674543386bb2a4d176da245b9')
            self.assertEqual(probe.MODEL_VARIANT, '7b')
            self.assertEqual(probe.MODEL_PRECISION, 'fp8_e4m3fn_mixed_block35_fp16')
            self.assertEqual(probe.DIT, 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors')
            self.assertEqual(probe.MODEL_HASHES[probe.DIT], '3d68b5ec0b295ae28092e355c8cad870edd00b817b26587d0cb8f9dd2df19bb2')
            self.assertNotIn('sharp', probe.DIT)
            self.assertEqual(probe.RUN_SUFFIX, '-7b')
            self.assertEqual(probe.RESULT_SUBPREFIX, '7b/')
            self.assertEqual(probe.BLOCKS_TO_SWAP, 28)
            self.assertLessEqual(probe.BLOCKS_TO_SWAP, 36)
            command = probe.inference_command(Path('/runner'), Path('/run'))
            for flag in ['--dit_model', '--blocks_to_swap']:
                command[command.index(flag) + 1] = baseline[baseline.index(flag) + 1]
            self.assertEqual(command, baseline)
            return 0

        with patch.dict(probe.__dict__), patch.object(probe, 'main', side_effect=check_config):
            self.assertEqual(probe7b.main(), 0)
        self.assertEqual(probe.MODEL_VARIANT, '3b')

    def test_7b_separate_run_and_upload_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'runs/stack/artifacts').mkdir(parents=True)
            calls = []

            def fake_run(command, *args, **kwargs):
                calls.append(command)
                if 'rev-parse' in command:
                    raise RuntimeError('preflight deliberately stopped')
                return ''

            with patch.dict(probe.__dict__), patch.object(probe, 'ROOT', root), patch.object(probe, 'run', side_effect=fake_run), patch.object(probe.sys, 'argv', ['probe7b', 'neverhood-upscaling-lab', 'stack']):
                self.assertEqual(probe7b.main(), 1)
                report = json.loads((root / 'runs/stack-7b/artifacts/report.json').read_text())
                self.assertEqual(report['modelVariant'], '7b')
                self.assertEqual(report['modelStyle'], 'normal')
                self.assertEqual(report['inferenceAttempts'], 0)
                self.assertTrue(any('s3://neverhood-upscaling-lab/results/stack/7b/report.json' in cmd for cmd in calls))
                self.assertEqual(list((root / 'runs/stack/artifacts').iterdir()), [])
                with self.assertRaises(FileExistsError):
                    probe7b.main()

    def test_measured_gpu_peak_on_success_and_failure(self):
        for failure in [False, True]:
            report = {}
            with patch.object(probe.subprocess, 'check_output', return_value='12345\n') as sample:
                def inference(*args, **kwargs):
                    # Wait for the actual sampler thread, without requiring a GPU.
                    for _ in range(100):
                        if sample.called:
                            break
                        probe.time.sleep(0.001)
                    if failure:
                        raise RuntimeError('inference failed')

                with patch.object(probe, 'run', side_effect=inference):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, 'inference failed'):
                            probe.measure_inference(['inference'], Path('/log'), report)
                    else:
                        probe.measure_inference(['inference'], Path('/log'), report)
            self.assertEqual(report['gpuMemory']['peakUsedMiB'], 12345)
            self.assertGreaterEqual(report['gpuMemory']['samples'], 1)
            self.assertGreaterEqual(report['inferenceSeconds'], 0)
            self.assertEqual(sample.call_args.kwargs['timeout'], 5)

    def test_unavailable_gpu_measurement_is_not_fabricated(self):
        report = {}
        with patch.object(probe.subprocess, 'check_output', side_effect=FileNotFoundError('nvidia-smi')), patch.object(probe, 'run'):
            probe.measure_inference(['inference'], Path('/log'), report)
        self.assertIsNone(report['gpuMemory']['peakUsedMiB'])
        self.assertEqual(report['gpuMemory']['samples'], 0)
        self.assertTrue(report['gpuMemory']['errors'])

    def test_fixed_single_smoke_command(self):
        command = probe.inference_command(Path('/runner'), Path('/run'))
        self.assertEqual(command[:4], ['timeout', '--signal=TERM', '--kill-after=30s', '15m'])
        for flag, expected in {'--resolution': '864', '--max_resolution': '1536',
                               '--batch_size': '5', '--seed': '314159', '--load_cap': '49',
                               '--attention_mode': 'sdpa', '--output_format': 'png',
                               '--dit_model': probe.DIT, '--blocks_to_swap': '16'}.items():
            self.assertEqual(command[command.index(flag) + 1], expected)
        self.assertFalse(any('7b' in arg or arg.startswith('--compile') for arg in command))
        self.assertIn('--vae_encode_tiled', command)
        self.assertIn('--vae_decode_tiled', command)

    def test_sanitize_secrets_and_signed_urls(self):
        text = 'https://huggingface.co/file?X-Amz-Signature=abcdef AKIA1234567890123456 hf_abcdef token=private'
        safe = probe.sanitize(text)
        for secret in ['https://', 'abcdef', 'AKIA123', 'private']:
            self.assertNotIn(secret, safe)

    def test_exact_input_contract(self):
        info = {'streams': [{'width': 384, 'height': 216, 'nb_read_frames': '49', 'avg_frame_rate': '15/1'}]}
        with patch.object(probe, 'run', side_effect=lambda *_: json.dumps(info)), patch.object(probe, 'sha256', return_value=probe.INPUT_HASH):
            self.assertEqual(probe.inspect_input(Path('/input'))['sha256'], probe.INPUT_HASH)
            info['streams'][0]['nb_read_frames'] = '48'
            with self.assertRaises(ValueError):
                probe.inspect_input(Path('/input'))

    def test_reject_wrong_input_hash(self):
        info = {'streams': [{'width': 384, 'height': 216, 'nb_read_frames': '49', 'avg_frame_rate': '15/1'}]}
        with patch.object(probe, 'run', return_value=json.dumps(info)), patch.object(probe, 'sha256', return_value='wrong'):
            with self.assertRaisesRegex(ValueError, 'SHA256'):
                probe.inspect_input(Path('/input'))

    def test_output_order_dimensions_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            header = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 1536, 864) + b'\x08\x02\0\0\0' + b'\0' * 4
            for i in range(49):
                (directory / f'input_{i:06d}.png').write_bytes(header)
            with patch.object(probe, 'run', return_value='') as decoder:
                result = probe.inspect_frames(directory)
                self.assertEqual(decoder.call_args.args[0][0], 'ffmpeg')
            self.assertEqual(result['frames'], 49)
            self.assertEqual(len(result['files']), 49)
            self.assertEqual(len(result['files'][0]['sha256']), 64)
            (directory / 'input_000048.png').unlink()
            with self.assertRaisesRegex(ValueError, '49 contiguous'):
                probe.inspect_frames(directory)
            (directory / 'input_000048.png').write_bytes(header[:16] + struct.pack('>II', 1280, 720) + header[24:])
            with self.assertRaisesRegex(ValueError, 'dimensions'):
                probe.inspect_frames(directory)

    def test_failure_report_upload_and_no_implicit_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'runs').mkdir()
            calls = []

            def fake_run(command, *args, **kwargs):
                calls.append(command)
                if 'rev-parse' in command:
                    return probe.REVISION
                if '--porcelain' in command:
                    return ''
                if command == ['aws', '--version']:
                    return 'aws-cli/2.31.0'
                if command == ['nvidia-smi']:
                    return 'mock L4'
                if '-c' in command:
                    raise RuntimeError('runtime failed token=private')
                return ''

            with patch.object(probe, 'ROOT', root), patch.object(probe, 'run', side_effect=fake_run), patch.object(probe.sys, 'argv', ['probe', 'test-bucket', 'smoke-1']):
                self.assertEqual(probe.main(), 1)
                report = json.loads((root / 'runs/smoke-1/artifacts/report.json').read_text())
                self.assertEqual(report['stage'], 'preflight')
                self.assertEqual(report['status'], 'failed')
                self.assertEqual(report['inferenceAttempts'], 0)
                self.assertNotIn('private', report['error'])
                self.assertTrue(any('s3://test-bucket/results/smoke-1/report.json' in cmd for cmd in calls))
                with self.assertRaises(FileExistsError):
                    probe.main()


if __name__ == '__main__':
    unittest.main()
