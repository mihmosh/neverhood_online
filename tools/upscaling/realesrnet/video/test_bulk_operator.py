"""Offline operator safeguards using synthetic private state and mocked AWS only."""
from contextlib import ExitStack, redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

try:
    import boto3
    from botocore.exceptions import ClientError
except ModuleNotFoundError:
    boto3 = None

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
if boto3 is not None:
    spec = importlib.util.spec_from_file_location('video_bulk_operator', HERE / 'bulk_operator.py')
    operator = importlib.util.module_from_spec(spec)
    original_path = sys.path[:]
    try:
        sys.path.insert(0, str(HERE))
        spec.loader.exec_module(operator)
    finally:
        sys.path[:] = original_path


@unittest.skipIf(boto3 is None, 'Optional boto3 SDK is not installed')
class BulkOperatorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='bulk-operator-test-', dir=REPO / 'private-research')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'private-research/movie-7b-full-offline'
        self.directory.mkdir(parents=True)
        state_root = self.root / 'private-assets/upscaling/aws'
        state_root.mkdir(parents=True)
        self.state = {'region': 'offline-region', 'stack': 'offline-stack',
                      'outputs': {'BucketName': 'offline-bucket', 'InstanceId': 'i-offline'},
                      'resources': [{'logicalId': 'AutoStopRole', 'id': 'offline-stop-role'}]}
        (state_root / 'stack-state.json').write_text(json.dumps(self.state))
        (state_root / 'create-intent.json').write_text(json.dumps({'account': 'offline-account'}))
        videos = []
        for index in range(2):
            resource = f'{index + 1:08x}'
            source = self.root / 'private-assets/blobs' / resource[:2] / (resource + '.smk')
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b'not a real movie ' + bytes([index]))
            videos.append({'id': resource, 'sourceSHA256': operator.digest(source),
                           'sourceBytes': source.stat().st_size, 'sourceKey': f'sources/offline/{resource}.smk'})
        self.plan = {'private': True, 'modelVariant': '7b', 'runId': self.directory.name, 'videos': videos}
        self.plan_path = self.directory / 'plan.json'
        self.plan_path.write_text(json.dumps(self.plan))
        self.worker = {'State': {'Name': 'stopped'}, 'InstanceType': 'g6.2xlarge',
                       'Tags': [{'Key': 'Purpose', 'Value': 'upscaling'},
                                {'Key': 'Project', 'Value': 'neverhood'}]}
        self.clients = {name: Mock(name=name) for name in ('s3', 'ec2', 'ssm', 'iam', 'scheduler')}
        self.calls = Mock()
        for name, client in self.clients.items():
            self.calls.attach_mock(client, name)
        self.clients['ec2'].describe_instances.return_value = {'Reservations': [{'Instances': [self.worker]}]}
        self.clients['ssm'].list_commands.return_value = {'Commands': []}
        self.clients['ssm'].send_command.return_value = {'Command': {'CommandId': 'offline-command'}}
        self.policy = {'Statement': [{'Effect': 'Allow', 'Action': 'ec2:StopInstances',
                                     'Resource': 'arn:aws:ec2:offline-region:offline-account:instance/i-offline'}]}
        self.clients['iam'].get_role.return_value = {'Role': {'Arn': 'arn:aws:iam::offline-account:role/offline-stop-role'}}
        self.clients['iam'].get_role_policy.return_value = {'PolicyDocument': self.policy}
        self.objects = {}
        s3 = self.clients['s3']
        s3.exceptions.ClientError = ClientError
        s3.exceptions.NoSuchKey = type('NoSuchKey', (Exception,), {})

        def head(Bucket, Key):
            self.assertEqual(Bucket, 'offline-bucket')
            if Key not in self.objects:
                raise ClientError({'Error': {'Code': '404'}}, 'HeadObject')
            return deepcopy(self.objects[Key]['head'])

        def upload(filename, bucket, key, ExtraArgs):
            self.assertEqual(bucket, 'offline-bucket')
            self.assertNotIn(key, self.objects, 'Immutable staged keys must not be overwritten')
            data = Path(filename).read_bytes()
            self.objects[key] = {'body': data, 'head': {'ContentLength': len(data),
                                 'Metadata': deepcopy(ExtraArgs['Metadata']),
                                 'ServerSideEncryption': ExtraArgs['ServerSideEncryption']}}

        s3.head_object.side_effect = head
        s3.upload_file.side_effect = upload
        self.now = datetime(2026, 10, 21, 12, tzinfo=timezone.utc)
        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.object(operator, 'REPO', self.root))
        session = Mock()
        session.client.side_effect = self.clients.__getitem__
        self.session = patches.enter_context(patch.object(operator, 'operator_session', return_value=session))
        clock = patches.enter_context(patch.object(operator, 'datetime', wraps=datetime))
        clock.now.return_value = self.now

    def invoke(self, action, directory=None):
        argv = ['bulk_operator.py', action, '--directory', str(directory or self.directory),
                '--profile', 'offline-profile']
        with patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()) as output:
            operator.main()
        return json.loads(output.getvalue())

    def stage(self):
        result = self.invoke('stage-sources')
        self.calls.reset_mock()
        return result

    def assert_not_started(self):
        self.clients['ec2'].start_instances.assert_not_called()
        self.clients['ssm'].send_command.assert_not_called()

    def test_staging_is_hash_bound_encrypted_and_immutable(self):
        result = self.stage()
        self.assertEqual(result['stagedOriginals'], 2)
        receipt = json.loads((self.directory / 'staging-receipt.json').read_text())
        self.assertEqual(receipt['planSHA256'], operator.digest(self.plan_path))
        self.assertEqual(receipt['bucket'], 'offline-bucket')
        self.assertEqual(len(receipt['objects']), 3)
        for item in receipt['objects']:
            stored = self.objects[item['key']]
            self.assertEqual(item['sha256'], hashlib.sha256(stored['body']).hexdigest())
            self.assertEqual(item['bytes'], len(stored['body']))
            self.assertEqual(stored['head']['Metadata'], {'sha256': item['sha256']})
            self.assertEqual(stored['head']['ServerSideEncryption'], 'AES256')
        self.invoke('stage-sources')
        self.clients['s3'].upload_file.assert_not_called()
        source = self.root / 'private-assets/blobs/00/00000001.smk'
        for field, value in [('Metadata', {'sha256': 'changed'}), ('ContentLength', 999),
                             ('ServerSideEncryption', 'aws:kms')]:
            with self.subTest(field=field):
                head = self.objects[self.plan['videos'][0]['sourceKey']]['head']
                with patch.dict(head, {field: value}):
                    with self.assertRaisesRegex(ValueError, 'overwrite|integrity'):
                        operator.upload(self.clients['s3'], 'offline-bucket', source,
                                        self.plan['videos'][0]['sourceKey'])
                self.clients['s3'].upload_file.assert_not_called()
        source.write_bytes(b'changed original')
        with self.assertRaisesRegex(ValueError, 'Original changed'):
            self.invoke('stage-sources')
        self.assert_not_started()

    def test_upload_verifies_post_upload_metadata_and_propagates_denial(self):
        s3 = self.clients['s3']
        source = self.plan_path
        s3.head_object.side_effect = [ClientError({'Error': {'Code': '404'}}, 'HeadObject'),
                                     {'Metadata': {'sha256': 'wrong'}, 'ContentLength': source.stat().st_size,
                                      'ServerSideEncryption': 'AES256'}]
        with self.assertRaisesRegex(ValueError, 'integrity'):
            operator.upload(s3, 'offline-bucket', source, 'sources/bad-post-upload')
        extra = s3.upload_file.call_args.kwargs['ExtraArgs']
        self.assertEqual(extra['ChecksumAlgorithm'], 'SHA256')
        self.assertEqual(extra['CacheControl'], 'private, no-store')
        s3.upload_file.reset_mock()
        s3.head_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'HeadObject')
        with self.assertRaises(ClientError):
            operator.upload(s3, 'offline-bucket', source, 'sources/denied')
        s3.upload_file.assert_not_called()

    def test_worker_identity_and_paginated_active_commands_block_start(self):
        self.stage()
        mutations = [('State', {'Name': 'running'}), ('InstanceType', 'g6.xlarge'),
                     ('Tags', [{'Key': 'Purpose', 'Value': 'other'}, {'Key': 'Project', 'Value': 'neverhood'}]),
                     ('Tags', [{'Key': 'Purpose', 'Value': 'upscaling'}])]
        for key, value in mutations:
            with self.subTest(key=key, value=value), patch.dict(self.worker, {key: value}):
                with self.assertRaisesRegex(ValueError, 'stopped isolated|worker identity'):
                    self.invoke('start-window')
                self.assert_not_started()
        ssm = self.clients['ssm']
        for status in ('Pending', 'InProgress', 'Delayed', 'Cancelling'):
            with self.subTest(status=status):
                ssm.list_commands.reset_mock()
                ssm.list_commands.side_effect = [
                    {'Commands': [{'Status': 'Success'}], 'NextToken': 'page-two'},
                    {'Commands': [{'Status': status, 'CommandId': 'busy'}]}]
                with self.assertRaisesRegex(ValueError, 'do not overlap'):
                    self.invoke('start-window')
                self.assertEqual(ssm.list_commands.call_args_list[1].kwargs,
                                 {'InstanceId': 'i-offline', 'NextToken': 'page-two'})
                self.assert_not_started()
        self.clients['scheduler'].create_schedule.assert_not_called()
        self.assertFalse(list(self.directory.glob('window-*.json')))

    def test_role_is_exact_instance_and_schedule_failure_never_starts(self):
        self.stage()
        statement = self.policy['Statement'][0]
        for resource in ('*', 'arn:aws:ec2:offline-region:offline-account:instance/i-other'):
            with self.subTest(resource=resource), patch.dict(statement, {'Resource': resource}):
                with self.assertRaisesRegex(ValueError, 'scoped exclusively'):
                    self.invoke('start-window')
                self.assert_not_started()
                self.clients['scheduler'].create_schedule.assert_not_called()
                intent = self.directory / 'window-001.json'
                self.assertEqual(intent.stat().st_mode & 0o777, 0o600)
                intent.unlink()
        self.clients['scheduler'].create_schedule.side_effect = RuntimeError('offline scheduler failure')
        with self.assertRaisesRegex(RuntimeError, 'scheduler failure'):
            self.invoke('start-window')
        self.assert_not_started()
        self.assertNotIn('commandId', json.loads((self.directory / 'window-001.json').read_text()))
        with self.assertRaisesRegex(ValueError, 'Uncertain earlier submission'):
            self.invoke('start-window')

    def test_six_twelve_hour_windows_and_uncertain_intent_fail_closed(self):
        self.stage()
        for number in range(1, 6):
            (self.directory / f'window-{number:03d}.json').write_text(json.dumps({'commandId': f'old-{number}'}))
        result = self.invoke('start-window')
        self.assertEqual(result['window'], 6)
        self.assertEqual(result['aggregateHoursCap'], 72)
        record = json.loads((self.directory / 'window-006.json').read_text())
        self.assertEqual(record['computeHoursCap'], 12)
        self.assertEqual(datetime.fromisoformat(record['deadline']) - datetime.fromisoformat(record['startedAt']),
                         timedelta(hours=12))
        self.calls.reset_mock()
        with self.assertRaisesRegex(ValueError, '72-hour aggregate maximum'):
            self.invoke('start-window')
        self.assert_not_started()
        self.clients['scheduler'].create_schedule.assert_not_called()
        (self.directory / 'window-006.json').unlink()
        (self.directory / 'window-005.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Uncertain earlier submission'):
            self.invoke('start-window')
        self.assert_not_started()

    def test_start_script_hashes_checkpoint_deadline_shutdown_and_cli_contract(self):
        self.stage()
        result = self.invoke('start-window')
        record = json.loads((self.directory / 'window-001.json').read_text())
        names = [call[0] for call in self.calls.mock_calls]
        self.assertLess(names.index('scheduler.create_schedule'), names.index('ec2.start_instances'))
        self.assertLess(names.index('ec2.start_instances'), names.index('ssm.send_command'))
        schedule = self.clients['scheduler'].create_schedule.call_args.kwargs
        self.assertEqual(json.loads(schedule['Target']['Input']), {'InstanceIds': ['i-offline']})
        self.assertEqual(schedule['Target']['Arn'], 'arn:aws:scheduler:::aws-sdk:ec2:stopInstances')
        self.assertEqual(schedule['ScheduleExpression'], 'at(2026-10-22T00:00:00)')
        self.assertEqual(schedule['ScheduleExpressionTimezone'], 'UTC')
        self.assertEqual(schedule['FlexibleTimeWindow'], {'Mode': 'OFF'})
        self.assertEqual(schedule['State'], 'ENABLED')
        self.assertEqual(schedule['ActionAfterCompletion'], 'DELETE')
        self.clients['ec2'].start_instances.assert_called_once_with(InstanceIds=['i-offline'])
        sent = self.clients['ssm'].send_command.call_args.kwargs
        self.assertEqual(sent['InstanceIds'], ['i-offline'])
        self.assertEqual(sent['DocumentName'], 'AWS-RunShellScript')
        self.assertEqual(sent['Parameters']['executionTimeout'], ['43080'])
        commands = sent['Parameters']['commands']
        self.assertEqual(commands[-2:], ['shutdown -h +1', 'exit "$result"'])
        self.assertIn('nvidia-smi --query-compute-apps=pid', commands[-4])
        self.assertEqual({item['relative'] for item in record['control']},
                         {'video/bulk.py', 'video/run.py', 'video/prepare.py', 'aws/helper/probe.py', 'aws/helper/probe7b.py'})
        for item in record['control']:
            sha = hashlib.sha256(self.objects[item['key']]['body']).hexdigest()
            self.assertEqual(item['sha256'], sha)
            self.assertIn('/control/' + sha + '/', item['key'])
            self.assertTrue(any('sha256sum ' in line and sha in line for line in commands))
        plan_sha = operator.digest(self.plan_path)
        self.assertTrue(any(f'plan-{plan_sha}.json' in line for line in commands))
        self.assertTrue(any('sha256sum ' in line and plan_sha in line for line in commands))
        runner = commands[-3]
        self.assertIn('HF_HUB_OFFLINE=1', runner)
        self.assertIn('if runuser -u ubuntu', runner)
        self.assertIn('then result=0; else result=$?; fi', runner)
        tokens = shlex.split(runner)
        expected = {'--plan-sha256': plan_sha, '--bucket': 'offline-bucket',
                    '--result-prefix': f'results/offline-stack/{self.directory.name}/',
                    '--root': '/opt/neverhood-upscaling/runner',
                    '--deadline': result['deadline']}
        for flag, value in expected.items():
            self.assertEqual(tokens[tokens.index(flag) + 1], value)
        self.assertTrue(tokens[tokens.index('--plan') + 1].endswith('/plan.json'))
        self.assertTrue(tokens[tokens.index('--workdir') + 1].endswith('/work'))
        self.assertEqual(record['commandId'], 'offline-command')

    def test_status_projects_s3_without_cloud_mutation_or_public_writes(self):
        prefix = f'results/offline-stack/{self.directory.name}/'
        self.clients['ssm'].list_commands.side_effect = [
            {'Commands': [{'Status': 'Success', 'CommandId': 'finished'}], 'NextToken': 'two'},
            {'Commands': [{'Status': 'InProgress', 'CommandId': 'active', 'Comment': 'offline progress'}]}]

        def get_object(Bucket, Key):
            self.assertEqual(Bucket, 'offline-bucket')
            if Key == prefix + 'progress.json':
                return {'Body': io.BytesIO(b'{"completed": 2, "total": 550}')}
            self.assertEqual(Key, prefix + 'coverage.json')
            raise self.clients['s3'].exceptions.NoSuchKey()

        self.clients['s3'].get_object.side_effect = get_object
        before = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        result = self.invoke('status')
        self.assertEqual(result['progress.json'], {'completed': 2, 'total': 550})
        self.assertIsNone(result['coverage.json'])
        self.assertEqual(result['activeCommands'], [{'id': 'active', 'comment': 'offline progress'}])
        status_path = self.directory / 'operator-status.json'
        self.assertEqual(json.loads(status_path.read_text()), result)
        after = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(set(after) - set(before), {status_path})
        self.assertTrue(all(after[path] == contents for path, contents in before.items()))
        self.assertEqual(status_path.stat().st_mode & 0o777, 0o600)
        self.assert_not_started()
        self.clients['ec2'].stop_instances.assert_not_called()
        self.clients['s3'].upload_file.assert_not_called()
        self.clients['scheduler'].create_schedule.assert_not_called()

    def test_public_directory_and_changed_staging_receipt_rejected(self):
        public = self.root / 'web/public/movie-7b-full-offline'
        public.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'Private run directory required'):
            self.invoke('status', directory=public)
        self.session.assert_not_called()
        self.stage()
        receipt_path = self.directory / 'staging-receipt.json'
        receipt = json.loads(receipt_path.read_text())
        for key, value in [('planSHA256', 'changed'), ('bucket', 'another-bucket'), ('objects', [])]:
            with self.subTest(key=key):
                receipt_path.write_text(json.dumps({**receipt, key: value}))
                with self.assertRaisesRegex(ValueError, 'staging not verified'):
                    self.invoke('start-window')
                self.assert_not_started()
        self.clients['scheduler'].create_schedule.assert_not_called()


if __name__ == '__main__':
    unittest.main()
