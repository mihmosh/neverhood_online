"""Offline submission safety tests; never contact AWS or execute GPU commands."""
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

try:
    import boto3
except ModuleNotFoundError:
    boto3 = None

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
if boto3 is not None:
    spec = importlib.util.spec_from_file_location('video_aws_trials', HERE / 'aws_trials.py')
    trials = importlib.util.module_from_spec(spec)
    original_path = sys.path[:]
    try:
        spec.loader.exec_module(trials)
    finally:
        sys.path[:] = original_path


@unittest.skipIf(boto3 is None, 'Optional boto3 SDK is not installed')
class AwsTrialsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='movie-7b-test-', dir=REPO / 'private-research')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name) / 'movie-7b-test-trial'
        self.directory.mkdir()
        self.record = self.directory / 'aws-submission.json'
        self.inputs = {}
        for name in ('cutscene-01', 'navigation-01'):
            local = self.directory / name
            local.mkdir()
            data = {'selection': {'startFrame': 0, 'frames': 49},
                    'target': {'width': 1280, 'height': 960},
                    'audio': {'file': 'audio.mka'} if name == 'cutscene-01' else None}
            (local / 'manifest.json').write_text(json.dumps(data))
            (local / 'input.mp4').write_bytes(b'dummy video ' + name.encode('ascii'))
            if data['audio']:
                (local / 'audio.mka').write_bytes(b'dummy audio')
            self.inputs[name] = data
        self.state = {'outputs': {'BucketName': 'offline-bucket', 'InstanceId': 'i-offline',
                                 'AutoStopScheduleName': 'offline-stop'},
                      'region': 'offline-region', 'stack': 'offline-stack'}
        self.now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
        self.guard = {'State': 'ENABLED', 'ScheduleExpressionTimezone': 'UTC',
                      'ScheduleExpression': 'at(2026-10-21T12:15:00)',
                      'Target': {'Arn': 'arn:aws:scheduler:::aws-sdk:ec2:stopInstances',
                                 'Input': json.dumps({'InstanceIds': ['i-offline']})}}
        self.worker = {'State': {'Name': 'running'}, 'InstanceType': 'g6.2xlarge'}
        self.clients = {name: Mock(name=name) for name in ('s3', 'ssm', 'ec2', 'scheduler')}
        self.clients['ec2'].describe_instances.return_value = {
            'Reservations': [{'Instances': [self.worker]}]}
        self.clients['scheduler'].get_schedule.return_value = self.guard
        self.clients['ssm'].list_commands.return_value = {'Commands': []}
        self.clients['ssm'].send_command.return_value = {'Command': {'CommandId': 'offline-command'}}
        self.uploaded = {}

        def upload(filename, bucket, key, ExtraArgs):
            self.assertEqual(bucket, 'offline-bucket')
            self.uploaded[key] = {'ContentLength': Path(filename).stat().st_size,
                                  'Metadata': ExtraArgs['Metadata'],
                                  'ServerSideEncryption': ExtraArgs['ServerSideEncryption']}

        self.clients['s3'].upload_file.side_effect = upload
        self.clients['s3'].head_object.side_effect = lambda Bucket, Key: self.uploaded[Key]
        stack = ExitStack()
        self.addCleanup(stack.close)
        session = Mock()
        session.client.side_effect = self.clients.__getitem__
        self.operator = stack.enter_context(patch.object(trials, 'operator_session', return_value=session))
        clock = stack.enter_context(patch.object(trials, 'datetime', wraps=datetime))
        clock.now.return_value = self.now
        real_read = Path.read_text

        def read_text(path, *args, **kwargs):
            if path == REPO / 'private-assets/upscaling/aws/stack-state.json':
                return json.dumps(self.state)
            if path == REPO / 'private-assets/upscaling/aws/create-intent.json':
                return json.dumps({'account': 'offline-account'})
            return real_read(path, *args, **kwargs)

        stack.enter_context(patch.object(Path, 'read_text', read_text))
        self.validate = Mock(side_effect=lambda local, sha: self.inputs[local.name])

    def invoke(self, submit=True):
        argv = ['aws_trials.py', '--directory', str(self.directory), '--profile', 'offline-profile']
        if submit:
            argv.append('--submit')
        runner = SimpleNamespace(validate_manifest=self.validate)
        spec = SimpleNamespace(loader=Mock())
        with patch.object(sys, 'argv', argv), patch.object(
                trials.importlib.util, 'spec_from_file_location', return_value=spec), patch.object(
                trials.importlib.util, 'module_from_spec', return_value=runner), patch(
                'sys.stdout', new_callable=io.StringIO) as output:
            trials.main()
        return json.loads(output.getvalue())

    def assert_no_writes(self):
        self.clients['s3'].upload_file.assert_not_called()
        self.clients['ssm'].send_command.assert_not_called()
        self.assertFalse(self.record.exists())

    def test_submit_required_before_any_api(self):
        result = self.invoke(submit=False)
        self.assertFalse(result['submit'])
        self.operator.assert_not_called()
        self.assert_no_writes()
        for item, call in zip(result['inputs'], self.validate.call_args_list):
            local = self.directory / item['name']
            expected = hashlib.sha256((local / 'manifest.json').read_bytes()).hexdigest()
            self.assertEqual(item['manifestSHA256'], expected)
            self.assertEqual(call.args, (local, expected))

    def test_worker_and_exact_instance_cost_guard(self):
        mutations = [(self.worker, 'InstanceType', 'g6.xlarge'),
                     (self.worker, 'State', {'Name': 'stopped'}),
                     (self.guard['Target'], 'Input', json.dumps({'InstanceIds': ['i-other']})),
                     (self.guard['Target'], 'Input', json.dumps({'InstanceIds': ['i-offline', 'i-other']})),
                     (self.guard['Target'], 'Input', json.dumps({'InstanceIds': ['i-offline'], 'DryRun': True})),
                     (self.guard['Target'], 'Arn', 'arn:aws:scheduler:::aws-sdk:ec2:startInstances'),
                     (self.guard, 'State', 'DISABLED'),
                     (self.guard, 'ScheduleExpressionTimezone', 'Europe/London')]
        for target, key, value in mutations:
            with self.subTest(key=key, value=value), patch.dict(target, {key: value}):
                with self.assertRaisesRegex(ValueError, 'Expected running|Unexpected cost guard'):
                    self.invoke()
                self.assert_no_writes()
        self.clients['ec2'].describe_instances.assert_called_with(InstanceIds=['i-offline'])
        self.clients['scheduler'].get_schedule.assert_called_with(Name='offline-stop')

    def test_seven_minute_deadline_boundary(self):
        for seconds in (0, 419, 420):
            self.guard['ScheduleExpression'] = f'at({(self.now + timedelta(seconds=seconds)).replace(tzinfo=None).isoformat()})'
            with self.subTest(seconds=seconds):
                if seconds < 420:
                    with self.assertRaisesRegex(ValueError, 'Less than seven minutes'):
                        self.invoke()
                    self.clients['ssm'].list_commands.assert_not_called()
                    self.assert_no_writes()
                else:
                    self.invoke()
                    self.assertEqual(self.clients['ssm'].send_command.call_args.kwargs[
                        'Parameters']['executionTimeout'], ['360'])

    def test_active_ssm_blocks_submission(self):
        for status in ('Pending', 'InProgress', 'Delayed', 'Cancelling'):
            with self.subTest(status=status):
                self.clients['ssm'].list_commands.return_value = {'Commands': [{'Status': status}]}
                with self.assertRaisesRegex(ValueError, 'Another SSM command'):
                    self.invoke()
                self.clients['ssm'].list_commands.assert_called_with(InstanceId='i-offline')
                self.assert_no_writes()

    def test_unique_intent_precedes_upload_and_survives_failure(self):
        def fail_upload(*args, **kwargs):
            record = json.loads(self.record.read_text())
            self.assertEqual(record['modelVariant'], '7b')
            self.assertEqual(record['maximumAttemptsPerClip'], 1)
            self.assertNotIn('commandId', record)
            raise RuntimeError('offline upload failure')

        self.clients['s3'].upload_file.side_effect = fail_upload
        with self.assertRaisesRegex(RuntimeError, 'offline upload failure'):
            self.invoke()
        self.assertEqual(self.record.stat().st_mode & 0o777, 0o600)
        original = self.record.read_bytes()
        self.clients['s3'].upload_file.reset_mock()
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual(self.record.read_bytes(), original)
        self.clients['s3'].upload_file.assert_not_called()
        self.clients['ssm'].send_command.assert_not_called()

    def test_active_ssm_on_later_page_blocks_submission(self):
        self.clients['ssm'].list_commands.side_effect = [
            {'Commands': [{'Status': 'Success'}], 'NextToken': 'next'},
            {'Commands': [{'Status': 'InProgress'}]}]
        with self.assertRaisesRegex(ValueError, 'Another SSM command'):
            self.invoke()
        self.clients['ssm'].list_commands.assert_called_with(InstanceId='i-offline', NextToken='next')
        self.assert_no_writes()

    def test_two_independent_7b_runs_and_encrypted_verified_transfers(self):
        # Importing the actual runner only builds commands; validation stays mocked.
        spec = importlib.util.spec_from_file_location('offline_video_runner', HERE / 'run.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        self.assertEqual(runner.probe.MODEL_VARIANT, '7b')
        self.clients['ssm'].list_commands.return_value = {'Commands': [{'Status': 'Success'}]}
        result = self.invoke()
        self.operator.assert_called_once_with('offline-profile', 'offline-region', 'offline-account')
        self.assertEqual(result['commandId'], 'offline-command')
        record = json.loads(self.record.read_text())
        self.assertEqual(self.record.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(record['uploads']), 8)
        for call, entry in zip(self.clients['s3'].upload_file.call_args_list, record['uploads']):
            filename, bucket, key = call.args
            sha = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
            self.assertEqual(call.kwargs['ExtraArgs'], {
                'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
                'Metadata': {'sha256': sha}, 'CacheControl': 'private, no-store'})
            self.assertEqual(entry, {'key': key, 'sha256': sha, 'bytes': Path(filename).stat().st_size})
            self.assertIn(unittest.mock.call(Bucket=bucket, Key=key),
                          self.clients['s3'].head_object.call_args_list)
        request = self.clients['ssm'].send_command.call_args.kwargs
        self.assertEqual(request['InstanceIds'], ['i-offline'])
        self.assertEqual(request['DocumentName'], 'AWS-RunShellScript')
        commands = request['Parameters']['commands']
        invocations = [command for command in commands if command.startswith('if runuser ')]
        self.assertEqual(len(invocations), 2)
        for name, command in zip(self.inputs, invocations):
            tokens = shlex.split(command)
            run_id = f'{self.directory.name}-{name}'
            self.assertEqual(tokens[tokens.index('--run-id') + 1], run_id)
            self.assertIn('HF_HUB_OFFLINE=1', tokens)
            self.assertIn('--execute;', tokens)
            sha = hashlib.sha256((self.directory / name / 'manifest.json').read_bytes()).hexdigest()
            self.assertEqual(tokens[tokens.index('--manifest-sha256') + 1], sha)
            self.assertIn(f'/runs/video-{run_id}/artifacts/restored.mp4', command)
            self.assertTrue(command.endswith('fi'))
            self.assertIn('else printf', command)
            inference = runner.inference_command(Path('/runner'), self.directory / name,
                                                 Path('/output'), self.inputs[name])
            self.assertIn('seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors', inference)
        archives = [command for command in commands if 'aws s3 cp' in command and '--sse ' in command]
        self.assertEqual(len(archives), 6)
        for command in archives:
            self.assertIn('--sse AES256 --checksum-algorithm SHA256', command)
        self.assertEqual(sum('sha256sum ' in command for command in commands), 8)
        for field, value in [('ContentLength', -1), ('Metadata', {'sha256': 'wrong'}),
                             ('ServerSideEncryption', 'aws:kms')]:
            with self.subTest(corrupt=field):
                self.record.unlink()
                self.clients['ssm'].send_command.reset_mock()
                with patch.object(self.clients['s3'], 'head_object', return_value={
                        'ContentLength': (HERE / 'run.py').stat().st_size,
                        'Metadata': {'sha256': trials.digest(HERE / 'run.py')},
                        'ServerSideEncryption': 'AES256', field: value}):
                    with self.assertRaisesRegex(ValueError, 'Uploaded source verification failed'):
                        self.invoke()
                self.clients['ssm'].send_command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
