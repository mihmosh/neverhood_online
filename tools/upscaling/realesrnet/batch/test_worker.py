"""Offline synthetic tests. Never imports Torch, contacts AWS, or loads real weights."""

import argparse
from contextlib import closing, redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import signal
import sqlite3
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch
import warnings
import zipfile

import numpy as np
from PIL import Image

import model
import worker
from job_contract import job_key, keyset_digest


def png(image):
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


def pack(entries, compression=zipfile.ZIP_STORED):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(output, 'w', compression=compression) as archive:
            for name, payload in entries:
                archive.writestr(name, payload)
    return output.getvalue()


def fixtures():
    entries = []
    for n in range(7):
        image = Image.new('RGBA', (n + 1, n + 2))
        if n:
            image.putpixel((0, 0), (20 * n, 31, 80, 255))
        key = job_key(*image.size, image.tobytes())
        entries.append((key + '.png', png(image)))
    return entries


class Missing(Exception):
    response = {'Error': {'Code': '404'}}


class FakeS3:
    def __init__(self, entries):
        self.packs = {worker.SOURCE_PREFIX + 'part-00000.zip': pack(entries)}
        self.outputs = {}
        self.puts = []
        self.upload_error = False
        self.active = 0
        self.max_active = 0
        self.mutex = threading.Lock()

    def get_paginator(self, operation):
        assert operation == 'list_objects_v2'
        return self

    def paginate(self, **kwargs):
        assert kwargs['Prefix'] == worker.SOURCE_PREFIX
        yield {'Contents': [{'Key': key, 'Size': len(data)} for key, data in self.packs.items()]}

    def get_object(self, **kwargs):
        data = self.packs[kwargs['Key']]
        return {'ContentLength': len(data), 'Metadata': {'sha256': worker.sha(data)},
                'Body': io.BytesIO(data)}

    def head_object(self, **kwargs):
        if kwargs['Key'] not in self.outputs:
            raise Missing()
        put = self.outputs[kwargs['Key']]
        return {'ContentLength': len(put['Body']), 'ContentType': put['ContentType'],
                'ServerSideEncryption': put['ServerSideEncryption'], 'Metadata': put['Metadata']}

    def put_object(self, **kwargs):
        with self.mutex:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.upload_error:
                raise ConnectionError('synthetic upload interruption')
            assert kwargs['Key'].startswith(worker.OUTPUT_PREFIX)
            assert kwargs['Key'].endswith('.png')
            assert kwargs['ServerSideEncryption'] == 'AES256'
            assert 'ACL' not in kwargs
            self.outputs[kwargs['Key']] = kwargs
            self.puts.append(kwargs)
        finally:
            with self.mutex:
                self.active -= 1


class FakeProcessor:
    def __init__(self, failure=False, term=False):
        self.calls = 0
        self.failure, self.term, self.closed = failure, term, False

    def __call__(self, image):
        self.calls += 1
        if self.failure:
            raise MemoryError('synthetic OOM; no retry/tiling')
        if self.term:
            signal.raise_signal(signal.SIGTERM)
        return image.resize((image.width * 4, image.height * 4), Image.Resampling.NEAREST), {
            'peak_allocated_bytes': 1024, 'peak_reserved_bytes': 2048}

    def close(self):
        self.closed = True


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.entries = fixtures()
        self.checkpoint = self.base / 'mock.pth'
        self.checkpoint.write_bytes(b'synthetic checkpoint, never torch-loaded')
        self.model_patch = patch.object(worker, 'MODEL_SHA256', worker.sha(self.checkpoint.read_bytes()))
        self.model_patch.start()
        self.addCleanup(self.model_patch.stop)
        self.args = argparse.Namespace(bucket='private-test-bucket', checkpoint=self.checkpoint,
            expected_job_count=len(self.entries),
            expected_keyset_sha256=keyset_digest(name[:-4] for name, _ in self.entries),
            state_dir=self.base / 'state', pilot_only=False, pilot_count=4, max_jobs=100,
            max_frame_pixels=1000, max_wall_seconds=100,
            deadline_utc=datetime.now(timezone.utc) + timedelta(hours=1), grace_seconds=180)

    def execute(self, s3=None, processor=None):
        s3 = s3 or FakeS3(self.entries)
        processor = processor or FakeProcessor()
        with redirect_stdout(io.StringIO()):
            code = worker.run(self.args, s3, processor)
        self.assertTrue(processor.closed)
        summary = json.loads((self.args.state_dir / 'summary.json').read_text())
        return code, summary, s3, processor

    def test_full_batch_then_resume_never_reinfers_or_reuploads(self):
        code, summary, s3, processor = self.execute()
        self.assertEqual((code, summary['status'], processor.calls), (0, 'complete', 7))
        self.assertEqual(summary['counts'], {'done': 7})
        self.assertLessEqual(s3.max_active, 2)
        self.assertEqual(len(s3.puts), 7)
        for put in s3.puts:
            with Image.open(io.BytesIO(put['Body'])) as image:
                self.assertEqual(image.mode, 'RGBA')
                self.assertTrue(set(np.unique(np.asarray(image)[:, :, 3])) <= {0, 255})
            self.assertEqual(put['Metadata']['sha256'], worker.sha(put['Body']))
        code, _, _, resumed = self.execute(s3)
        self.assertEqual(code, 0)
        self.assertEqual(resumed.calls, 0)
        self.assertEqual(len(s3.puts), 7)

    def test_pilot_only_is_bounded_and_includes_extremes_transparent(self):
        self.args.pilot_only = True
        code, summary, s3, processor = self.execute()
        self.assertEqual((code, processor.calls, len(s3.puts)), (0, 4, 4))
        self.assertEqual(summary['status'], 'pilot-complete')
        keys = set(summary['pilot_keys'])
        self.assertIn(self.entries[0][0][:-4], keys)
        self.assertIn(self.entries[-1][0][:-4], keys)

    def test_pilot_failure_never_enters_production_and_records_failed(self):
        code, summary, s3, processor = self.execute(processor=FakeProcessor(failure=True))
        self.assertEqual(code, 1)
        self.assertEqual(processor.calls, 1)
        self.assertFalse(s3.puts)
        self.assertEqual(summary['counts']['failed'], 1)
        code, _, _, resumed = self.execute(s3)
        self.assertEqual(code, 1)
        self.assertEqual(resumed.calls, 0)

    def test_expected_keyset_rejects_before_inference(self):
        self.args.expected_keyset_sha256 = '0' * 64
        code, _, s3, processor = self.execute()
        self.assertEqual(code, 1)
        self.assertEqual(processor.calls, 0)
        self.assertFalse(s3.puts)

    def test_count_mismatch_rejects_before_inference(self):
        self.args.expected_job_count += 1
        code, _, _, processor = self.execute()
        self.assertEqual((code, processor.calls), (1, 0))

    def test_checkpoint_mismatch_rejects_before_s3_access(self):
        self.checkpoint.write_bytes(b'changed')
        s3 = FakeS3(self.entries)
        s3.get_paginator = Mock(side_effect=AssertionError('must not contact S3'))
        code, _, _, processor = self.execute(s3)
        self.assertEqual((code, processor.calls), (1, 0))
        s3.get_paginator.assert_not_called()

    def test_budget_cannot_bypass_unfinished_pilot(self):
        self.args.max_jobs = 2
        code, summary, s3, processor = self.execute()
        self.assertEqual((code, summary['status'], processor.calls), (3, 'checkpointed', 2))
        self.assertFalse(summary['pilot_passed'])
        self.assertEqual(len(s3.puts), 2)

    def test_upload_failure_resume_uses_local_ready_output(self):
        s3 = FakeS3(self.entries)
        s3.upload_error = True
        code, summary, _, first = self.execute(s3)
        self.assertEqual(code, 1)
        self.assertIn('ready', summary['counts'])
        completed_inferences = first.calls
        s3.upload_error = False
        code, _, _, second = self.execute(s3)
        self.assertEqual(code, 0)
        self.assertEqual(second.calls + completed_inferences, 7)

    def test_sigterm_checkpoints_and_resumes(self):
        code, summary, s3, first = self.execute(processor=FakeProcessor(term=True))
        self.assertEqual((code, summary['status'], first.calls), (3, 'checkpointed', 1))
        code, _, _, second = self.execute(s3)
        self.assertEqual((code, first.calls + second.calls), (0, 7))

    def test_expired_deadline_does_not_start(self):
        self.args.deadline_utc = datetime.now(timezone.utc)
        code, _, _, processor = self.execute()
        self.assertEqual((code, processor.calls), (3, 0))

    def test_existing_remote_metadata_tampering_is_fatal_not_overwritten(self):
        _, _, s3, _ = self.execute()
        for put in s3.puts:
            put['Metadata']['mask-policy'] = 'neural-alpha'
        old_puts = len(s3.puts)
        code, _, _, processor = self.execute(s3)
        self.assertEqual((code, processor.calls, len(s3.puts)), (1, 0, old_puts))

    def test_done_object_missing_reuploads_local_png_without_inference(self):
        _, _, s3, _ = self.execute()
        s3.outputs.clear()
        code, _, _, processor = self.execute(s3)
        self.assertEqual((code, processor.calls, len(s3.puts)), (0, 0, 14))

    def test_upload_crash_gap_is_adopted_from_remote_metadata(self):
        _, _, s3, _ = self.execute()
        with closing(sqlite3.connect(self.args.state_dir / 'neverhood-full-v1.sqlite')) as db:
            with db:
                db.execute("UPDATE jobs SET status='processing',output_sha=NULL")
        code, _, _, processor = self.execute(s3)
        self.assertEqual((code, processor.calls, len(s3.puts)), (0, 0, 7))

    def test_changed_db_binding_is_rejected(self):
        self.execute()
        self.args.expected_job_count += 1
        code, _, _, processor = self.execute()
        self.assertEqual((code, processor.calls), (1, 0))

    def test_duplicate_across_packs_rejects(self):
        s3 = FakeS3(self.entries)
        s3.packs[worker.SOURCE_PREFIX + 'part-00001.zip'] = pack(self.entries[:1])
        code, _, _, processor = self.execute(s3)
        self.assertEqual((code, processor.calls), (1, 0))

    def test_pack_validation_positive(self):
        data = pack(self.entries)
        result = worker.validate_pack(data, worker.sha(data), 1000)
        self.assertEqual(len(result), 7)

    def test_pack_rejections(self):
        name, payload = self.entries[0]
        cases = [pack([('../' + name, payload)]), pack([('sub/' + name, payload)]),
                 pack([('manifest.json', b'{}')]), pack([(name, payload), (name, payload)]),
                 pack([(name, payload)], zipfile.ZIP_DEFLATED), pack([('dir/', b'')]),
                 pack([(name, b'not PNG')]), pack([('0' * 64 + '.png', payload)]), pack([])]
        for data in cases:
            with self.subTest(size=len(data)):
                with self.assertRaises((ValueError, OSError)):
                    worker.validate_pack(data, worker.sha(data), 1000)
        data = pack(self.entries)
        with self.assertRaises(ValueError):
            worker.validate_pack(data, '0' * 64, 1000)
        with patch.object(worker, 'MAX_PACK_BYTES', 100):
            with self.assertRaises(ValueError):
                worker.validate_pack(data, worker.sha(data), 1000)

    def test_decode_rejects_hidden_rgb_partial_alpha_and_bound(self):
        for color in ((4, 0, 0, 0), (4, 0, 0, 128)):
            image = Image.new('RGBA', (2, 2), color)
            key = job_key(*image.size, image.tobytes())
            with self.assertRaises(ValueError):
                worker.decode_input(png(image), key, 100)
        image = Image.new('RGBA', (20, 20))
        with self.assertRaises(ValueError):
            worker.decode_input(png(image), job_key(*image.size, image.tobytes()), 100)

    def test_tiny_frame_and_binary_mask_preprocessing(self):
        image = Image.new('RGBA', (1, 2))
        image.putpixel((0, 0), (17, 49, 81, 255))
        padded = model.prepare_rgb(image)
        self.assertEqual(padded.shape, (25, 25, 3))
        np.testing.assert_array_equal(padded, np.broadcast_to([17, 49, 81], padded.shape))
        result = model.attach_mask(np.full((36, 36, 3), 123, np.uint8), image)
        worker.validate_output(result, image)
        self.assertEqual(result.size, (4, 8))
        self.assertEqual(result.getpixel((0, 7)), (0, 0, 0, 0))

    def test_all_transparent_does_not_import_torch_or_load_model(self):
        processor = model.Processor(self.base / 'absent.pth')
        with patch.dict('sys.modules', {'torch': None}):
            image, metrics = processor(Image.new('RGBA', (2, 1)))
        self.assertTrue(metrics['transparent_fastpath'])
        self.assertEqual(image.size, (8, 4))
        self.assertEqual(image.tobytes(), bytes(8 * 4 * 4))
        processor.close()

    def test_mock_checkpoint_hash_checked_before_safe_load_and_ema_preferred(self):
        torch, network = Mock(), Mock()
        torch.load.return_value = {'params_ema': {'ema': 1}, 'params': {'raw': 1}}
        with self.assertRaises(ValueError):
            model.load_weights(torch, network, self.checkpoint, expected_sha='0' * 64)
        torch.load.assert_not_called()
        model.load_weights(torch, network, self.checkpoint,
                           expected_sha=worker.sha(self.checkpoint.read_bytes()))
        torch.load.assert_called_once_with(self.checkpoint, map_location='cpu', weights_only=True)
        network.load_state_dict.assert_called_once_with({'ema': 1}, strict=True)

    def test_exact_rrdb_convolution_shapes_without_importing_torch(self):
        class Module:
            pass
        nn = types.SimpleNamespace(Module=Module, Conv2d=Mock(), Sequential=Mock())
        fake = types.SimpleNamespace(nn=nn)
        fake.nn.functional = Mock()
        network = model.build_network(fake)
        self.assertEqual(type(network).__name__, 'RRDBNet')
        self.assertEqual(nn.Conv2d.call_count, 23 * 3 * 5 + 6)
        self.assertEqual(len(nn.Sequential.call_args.args), 23)
        shapes = [call.args for call in nn.Conv2d.call_args_list]
        self.assertEqual(shapes[0], (3, 64, 3, 1, 1))
        self.assertEqual(shapes[1:6], [(64, 32, 3, 1, 1), (96, 32, 3, 1, 1),
            (128, 32, 3, 1, 1), (160, 32, 3, 1, 1), (192, 64, 3, 1, 1)])
        self.assertEqual(shapes[-1], (64, 3, 3, 1, 1))

    def test_instance_role_resolver_has_no_operator_credential_fallback(self):
        boto3 = types.ModuleType('boto3')
        boto3.Session = Mock()
        core = types.ModuleType('botocore')
        core.session = types.ModuleType('botocore.session')
        core.session.Session = Mock()
        config = types.ModuleType('botocore.config')
        config.Config = Mock()
        credentials = types.ModuleType('botocore.credentials')
        credentials.CredentialResolver, credentials.InstanceMetadataProvider = Mock(), Mock()
        utils = types.ModuleType('botocore.utils')
        utils.InstanceMetadataFetcher = Mock()
        session = core.session.Session.return_value
        session.get_credentials.return_value.method = 'iam-role'
        modules = {'boto3': boto3, 'botocore': core, 'botocore.session': core.session,
                   'botocore.config': config, 'botocore.credentials': credentials,
                   'botocore.utils': utils}
        with patch.dict('sys.modules', modules):
            worker.instance_s3()
            credentials.CredentialResolver.assert_called_once_with([
                credentials.InstanceMetadataProvider.return_value])
            session.set_config_variable.assert_any_call('config_file', '/dev/null')
            session.set_config_variable.assert_any_call('credentials_file', '/dev/null')
            session.set_config_variable.assert_any_call('profile', None)
            boto3.Session.assert_called_once_with(botocore_session=session, region_name='us-east-2')
            session.get_credentials.return_value.method = 'env'
            with self.assertRaises(RuntimeError):
                worker.instance_s3()


if __name__ == '__main__':
    unittest.main()
