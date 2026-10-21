"""Operator-only staging and bounded compute windows for the full 7B corpus."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shlex
import sys

from aws_trials import digest, operator_session

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
RATE_USD = 0.9776
MAX_WINDOWS = 6
WINDOW_HOURS = 12


def save(path, value, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    with os.fdopen(os.open(path, flags, 0o600), 'w') as stream:
        json.dump(value, stream, indent=2, default=str)
        stream.write('\n')


def upload(s3, bucket, path, key):
    sha, size = digest(path), path.stat().st_size
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
    except s3.exceptions.ClientError as error:
        if error.response['Error']['Code'] not in ('404', 'NoSuchKey', 'NotFound'):
            raise
        head = None
    if head:
        if head['Metadata'].get('sha256') != sha or head['ContentLength'] != size:
            raise ValueError('Refusing to overwrite a changed staged object: ' + key)
    else:
        s3.upload_file(str(path), bucket, key, ExtraArgs={
            'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
            'Metadata': {'sha256': sha}, 'CacheControl': 'private, no-store'})
        head = s3.head_object(Bucket=bucket, Key=key)
    if head['Metadata'].get('sha256') != sha or head['ContentLength'] != size or head.get('ServerSideEncryption') != 'AES256':
        raise ValueError('Staging integrity/encryption check failed')
    return {'key': key, 'sha256': sha, 'bytes': size}


def active_commands(ssm, instance):
    result, token = [], None
    while True:
        page = ssm.list_commands(InstanceId=instance, **({'NextToken': token} if token else {}))
        result.extend(command for command in page['Commands']
                      if command['Status'] in ('Pending', 'InProgress', 'Delayed', 'Cancelling'))
        token = page.get('NextToken')
        if not token:
            return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('stage-sources', 'start-window', 'status', 'stop'))
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_relative_to(REPO / 'private-research'):
        raise ValueError('Private run directory required')
    plan_path = directory / 'plan.json'
    plan, sha = json.loads(plan_path.read_text()), digest(plan_path)
    if (plan['private'] is not True or plan['modelVariant'] != '7b'
            or plan['runId'] != directory.name or not plan['runId'].startswith('movie-7b-full-')):
        raise ValueError('Not a private complete-corpus 7B plan')
    state = json.loads((REPO / 'private-assets/upscaling/aws/stack-state.json').read_text())
    intent = json.loads((REPO / 'private-assets/upscaling/aws/create-intent.json').read_text())
    session = operator_session(args.profile, state['region'], intent['account'])
    s3, ec2, ssm = session.client('s3'), session.client('ec2'), session.client('ssm')
    bucket, instance = state['outputs']['BucketName'], state['outputs']['InstanceId']
    prefix = f'results/{state["stack"]}/{plan["runId"]}/'
    if args.action == 'stage-sources':
        def stage(video):
            path = REPO / 'private-assets/blobs' / video['id'][:2] / (video['id'] + '.smk')
            if digest(path) != video['sourceSHA256'] or path.stat().st_size != video['sourceBytes']:
                raise ValueError('Original changed after full probe')
            return upload(s3, bucket, path, video['sourceKey'])
        with ThreadPoolExecutor(max_workers=4) as pool:
            objects = list(pool.map(stage, plan['videos']))
        objects.append(upload(s3, bucket, plan_path, f'sources/probes/{plan["runId"]}/plan-{sha}.json'))
        receipt = {'planSHA256': sha, 'bucket': bucket, 'objects': objects,
                   'stagedAt': datetime.now(timezone.utc).isoformat()}
        save(directory / 'staging-receipt.json', receipt)
        print(json.dumps({'stagedOriginals': len(plan['videos']), 'bytes': sum(item['bytes'] for item in objects)}))
        return
    if args.action == 'status':
        worker = ec2.describe_instances(InstanceIds=[instance])['Reservations'][0]['Instances'][0]
        result = {'instance': instance, 'state': worker['State']['Name'],
                  'activeCommands': [{'id': command['CommandId'], 'comment': command.get('Comment')}
                                     for command in active_commands(ssm, instance)]}
        for name in ('progress.json', 'coverage.json'):
            try:
                result[name] = json.loads(s3.get_object(Bucket=bucket, Key=prefix + name)['Body'].read())
            except s3.exceptions.NoSuchKey:
                result[name] = None
        save(directory / 'operator-status.json', result)
        print(json.dumps(result, indent=2, default=str))
        return
    if args.action == 'stop':
        print(json.dumps(ec2.stop_instances(InstanceIds=[instance]), default=str))
        return
    receipt = json.loads((directory / 'staging-receipt.json').read_text())
    if receipt['planSHA256'] != sha or receipt['bucket'] != bucket or len(receipt['objects']) != len(plan['videos']) + 1:
        raise ValueError('Full source staging not verified')
    expected_objects = {video['sourceKey']: (video['sourceSHA256'], video['sourceBytes']) for video in plan['videos']}
    expected_objects[f'sources/probes/{plan["runId"]}/plan-{sha}.json'] = (sha, plan_path.stat().st_size)
    if {item['key']: (item['sha256'], item['bytes']) for item in receipt['objects']} != expected_objects:
        raise ValueError('Full source staging object identities do not match the plan')
    if active_commands(ssm, instance):
        raise ValueError('Another SSM command is active; do not overlap compute')
    worker = ec2.describe_instances(InstanceIds=[instance])['Reservations'][0]['Instances'][0]
    if worker['State']['Name'] != 'stopped' or worker['InstanceType'] != 'g6.2xlarge':
        raise ValueError('Expected stopped isolated L4')
    tags = {tag['Key']: tag['Value'] for tag in worker['Tags']}
    if tags.get('Purpose') != 'upscaling' or tags.get('Project') != 'neverhood':
        raise ValueError('Unexpected worker identity')
    windows = sorted(directory.glob('window-*.json'))
    if len(windows) >= MAX_WINDOWS:
        raise ValueError('72-hour aggregate maximum reached; no automatic budget extension')
    for file in windows:
        previous = json.loads(file.read_text())
        if 'commandId' not in previous:
            raise ValueError('Uncertain earlier submission; reconcile SSM before retrying')
    window = len(windows) + 1
    name = f'nh-video-7b-{plan["runId"][-8:]}-w{window:03d}-stop'
    now = datetime.now(timezone.utc)
    deadline = now + timedelta(hours=WINDOW_HOURS)
    window_file = directory / f'window-{window:03d}.json'
    record = {'window': window, 'planSHA256': sha, 'instance': instance, 'bucket': bucket,
              'resultPrefix': prefix, 'startedAt': now.isoformat(), 'deadline': deadline.isoformat(),
              'schedule': name, 'computeHoursCap': WINDOW_HOURS,
              'approximateWindowComputeUSD': WINDOW_HOURS * RATE_USD,
              'aggregateHoursCap': MAX_WINDOWS * WINDOW_HOURS}
    save(window_file, record, exclusive=True)
    role_name = next(item['id'] for item in state['resources'] if item['logicalId'] == 'AutoStopRole')
    iam = session.client('iam')
    role = iam.get_role(RoleName=role_name)['Role']['Arn']
    policy = iam.get_role_policy(RoleName=role_name, PolicyName='StopOnlyThisWorker')['PolicyDocument']
    expected_arn = f'arn:aws:ec2:{state["region"]}:{intent["account"]}:instance/{instance}'
    if policy['Statement'] != [{'Effect': 'Allow', 'Action': 'ec2:StopInstances', 'Resource': expected_arn}]:
        raise ValueError('Stop role is not scoped exclusively to the trial worker')
    scheduler = session.client('scheduler')
    scheduler.create_schedule(Name=name, ScheduleExpression=f'at({deadline.strftime("%Y-%m-%dT%H:%M:%S")})',
                              ScheduleExpressionTimezone='UTC', FlexibleTimeWindow={'Mode': 'OFF'},
                              State='ENABLED', ActionAfterCompletion='DELETE',
                              Description='Full movie 7B window cost guard; exact isolated worker only',
                              Target={'Arn': 'arn:aws:scheduler:::aws-sdk:ec2:stopInstances', 'RoleArn': role,
                                      'Input': json.dumps({'InstanceIds': [instance]}),
                                      'RetryPolicy': {'MaximumEventAgeInSeconds': 3600, 'MaximumRetryAttempts': 3}})
    # Record immutable executable hashes for every window, including operator fixes.
    control = [(HERE / filename, 'video/' + filename) for filename in ('bulk.py', 'run.py', 'prepare.py')]
    control += [(HERE.parent / 'aws/helper' / filename, 'aws/helper/' + filename) for filename in ('probe.py', 'probe7b.py')]
    record['control'] = []
    for file, relative in control:
        key = f'sources/probes/{plan["runId"]}/control/{digest(file)}/{relative}'
        record['control'].append({**upload(s3, bucket, file, key), 'relative': relative})
    save(window_file, record)
    ec2.start_instances(InstanceIds=[instance])
    ec2.get_waiter('instance_running').wait(InstanceIds=[instance], WaiterConfig={'Delay': 10, 'MaxAttempts': 30})
    ec2.get_waiter('instance_status_ok').wait(InstanceIds=[instance], WaiterConfig={'Delay': 15, 'MaxAttempts': 24})
    remote = f'/opt/neverhood-upscaling/video-bulk/{plan["runId"]}'
    commands = ['set -eu', f'install -d -m 0700 -o ubuntu -g ubuntu {remote} {remote}/work']
    staged = record['control'] + [{'key': f'sources/probes/{plan["runId"]}/plan-{sha}.json', 'sha256': sha, 'relative': 'plan.json'}]
    for file in staged:
        target = remote + '/' + file['relative']
        commands += [f'install -d -m 0700 -o ubuntu -g ubuntu {shlex.quote(str(Path(target).parent))}',
                     f'aws s3 cp s3://{bucket}/{file["key"]} {target} --only-show-errors',
                     f'test "$(sha256sum {target} | cut -d " " -f 1)" = {file["sha256"]}',
                     f'chown ubuntu:ubuntu {target}', f'chmod 0600 {target}']
    command = (f'runuser -u ubuntu -- env HOME=/home/ubuntu HF_HUB_OFFLINE=1 '
               f'HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 CUDA_VISIBLE_DEVICES=0 PYTHONUNBUFFERED=1 '
               f'/opt/neverhood-upscaling/runner/venv/bin/python {remote}/video/bulk.py '
               f'--plan {remote}/plan.json --plan-sha256 {sha} --bucket {bucket} --result-prefix {prefix} '
               f'--workdir {remote}/work --root /opt/neverhood-upscaling/runner --deadline {deadline.isoformat()}')
    commands += ['test -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader)"',
                 f'if {command} > {remote}/worker-window-{window:03d}.log 2>&1; then result=0; else result=$?; fi',
                 'shutdown -h +1', 'exit "$result"']
    result = ssm.send_command(InstanceIds=[instance], DocumentName='AWS-RunShellScript',
                              Parameters={'commands': commands, 'executionTimeout': [str(WINDOW_HOURS * 3600 - 120)]},
                              TimeoutSeconds=600, Comment=f'{plan["runId"]} full7B checkpointed window{window:03d}')
    record['commandId'] = result['Command']['CommandId']
    save(window_file, record)
    print(json.dumps({key: record[key] for key in ('window', 'commandId', 'deadline', 'approximateWindowComputeUSD', 'aggregateHoursCap')}, indent=2))


if __name__ == '__main__':
    main()
