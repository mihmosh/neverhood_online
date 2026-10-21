"""Explicit operator upload/SSM submission for the two prepared 7B movie trials."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'aws'))
from operator_aws import operator_session


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--submit', action='store_true')
    args = parser.parse_args()
    repo = HERE.parents[3]
    directory = args.directory.resolve()
    if not directory.is_relative_to(repo / 'private-research'):
        raise ValueError('Trial records must stay private')
    trial = directory.name
    if not trial.startswith('movie-7b-') or not all(c.isalnum() or c == '-' for c in trial):
        raise ValueError('Invalid trial name')
    state_root = repo / 'private-assets/upscaling/aws'
    state = json.loads((state_root / 'stack-state.json').read_text())
    intent = json.loads((state_root / 'create-intent.json').read_text())
    bucket, instance = state['outputs']['BucketName'], state['outputs']['InstanceId']
    spec = importlib.util.spec_from_file_location('movie_runner', HERE / 'run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    inputs = []
    for name in ('cutscene-01', 'navigation-01'):
        local = directory / name
        sha = digest(local / 'manifest.json')
        data = runner.validate_manifest(local, sha)
        inputs.append((name, local, sha, data))
    if not args.submit:
        print(json.dumps({'submit': False, 'trial': trial, 'inputs': [
            {'name': name, 'manifestSHA256': sha, 'selection': data['selection']}
            for name, _, sha, data in inputs]}, indent=2))
        return
    session = operator_session(args.profile, state['region'], intent['account'])
    s3, ssm = session.client('s3'), session.client('ssm')
    ec2, scheduler = session.client('ec2'), session.client('scheduler')
    worker = ec2.describe_instances(InstanceIds=[instance])['Reservations'][0]['Instances'][0]
    if worker['State']['Name'] != 'running' or worker['InstanceType'] != 'g6.2xlarge':
        raise ValueError('Expected running isolated L4 worker')
    guard = scheduler.get_schedule(Name=state['outputs']['AutoStopScheduleName'])
    if (json.loads(guard['Target']['Input']) != {'InstanceIds': [instance]}
            or not guard['Target']['Arn'].endswith(':aws-sdk:ec2:stopInstances')
            or guard['State'] != 'ENABLED' or guard['ScheduleExpressionTimezone'] != 'UTC'):
        raise ValueError('Unexpected cost guard')
    deadline = datetime.fromisoformat(guard['ScheduleExpression'][3:-1]).replace(tzinfo=timezone.utc)
    remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
    if remaining < 420:
        raise ValueError('Less than seven minutes remain before automatic stop')
    active = []
    page = ssm.list_commands(InstanceId=instance)
    while True:
        active.extend(command for command in page['Commands']
                      if command['Status'] in ('Pending', 'InProgress', 'Delayed', 'Cancelling'))
        if not page.get('NextToken'):
            break
        page = ssm.list_commands(InstanceId=instance, NextToken=page['NextToken'])
    if active:
        raise ValueError('Another SSM command is still active')
    record_path = directory / 'aws-submission.json'
    record = {'trial': trial, 'bucket': bucket, 'instance': instance,
              'autoStopAt': deadline.isoformat(), 'modelVariant': '7b', 'maximumAttemptsPerClip': 1,
              'resultPrefix': f'results/{state["stack"]}/{trial}/', 'uploads': []}
    with os.fdopen(os.open(record_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(record, stream, indent=2)
    prefix = f'sources/probes/{trial}'
    remote = f'/opt/neverhood-upscaling/{trial}'
    q = shlex.quote
    commands = ['set -eu', f'install -d -m 0700 -o ubuntu -g ubuntu {remote}']
    files = [(HERE / 'run.py', 'tools/video/run.py'),
             (HERE.parent / 'aws/helper/probe.py', 'tools/aws/helper/probe.py'),
             (HERE.parent / 'aws/helper/probe7b.py', 'tools/aws/helper/probe7b.py')]
    for name, local, _, data in inputs:
        for filename in ['manifest.json', 'input.mp4'] + (['audio.mka'] if data.get('audio') else []):
            files.append((local / filename, f'input/{name}/{filename}'))
    for path, relative in files:
        sha, size, key = digest(path), path.stat().st_size, f'{prefix}/{relative}'
        s3.upload_file(str(path), bucket, key, ExtraArgs={
            'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
            'Metadata': {'sha256': sha}, 'CacheControl': 'private, no-store'})
        head = s3.head_object(Bucket=bucket, Key=key)
        if head['ContentLength'] != size or head['Metadata'].get('sha256') != sha or head['ServerSideEncryption'] != 'AES256':
            raise ValueError('Uploaded source verification failed')
        record['uploads'].append({'key': key, 'sha256': sha, 'bytes': size})
        target = f'{remote}/{relative}'
        commands += [f'install -d -m 0700 -o ubuntu -g ubuntu {q(str(Path(target).parent))}',
                     f'aws s3 cp {q(f"s3://{bucket}/{key}")} {q(target)} --only-show-errors',
                     f'test "$(sha256sum {q(target)} | cut -d " " -f 1)" = {sha}',
                     f'chown ubuntu:ubuntu {q(target)}', f'chmod 0600 {q(target)}']
    commands += ['nvidia-smi --query-compute-apps=pid --format=csv,noheader',
                 'test -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader)"']
    # Each clip gets one independent attempt; failure still archives its report.
    for name, _, sha, data in inputs:
        run_id = f'{trial}-{name}'
        output = f'/opt/neverhood-upscaling/runner/runs/video-{run_id}'
        destination = f's3://{bucket}/{record["resultPrefix"]}{name}'
        invoke = (f'runuser -u ubuntu -- env HOME=/home/ubuntu HF_HUB_OFFLINE=1 '
                  f'/opt/neverhood-upscaling/runner/venv/bin/python {remote}/tools/video/run.py '
                  f'--input {remote}/input/{name} --manifest-sha256 {sha} --run-id {run_id} --execute')
        commands += [f'if {invoke}; then '
                     f'runuser -u ubuntu -- ffmpeg -v error -n -i {output}/artifacts/restored.mp4 '
                     f'-map 0:v:0 -map 0:a:0? -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac '
                     f'-movflags +faststart {output}/artifacts/restored-preview.mp4 '
                     f'|| printf "%s\\n" "preview encoding failed"; '
                     f'runuser -u ubuntu -- ffmpeg -v error -n -i {remote}/input/{name}/input.mp4 '
                     f'-i {output}/artifacts/restored.mp4 -filter_complex '
                     f'"[0:v]scale={data["target"]["width"]}:{data["target"]["height"]}:flags=neighbor[a];'
                     f'[a][1:v]hstack=inputs=2[v]" -map "[v]" -map 1:a:0? '
                     f'-c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -movflags +faststart '
                     f'{output}/artifacts/comparison-preview.mp4 '
                     f'|| printf "%s\\n" "comparison encoding failed"; '
                     f'else printf "%s\\n" "{name}: inference or validation failed; archiving diagnostics"; fi',
                     f'if test -f {output}/report.json; then aws s3 cp {output}/report.json {destination}/report.json '
                     '--sse AES256 --checksum-algorithm SHA256 --only-show-errors; fi',
                     f'if test -d {output}/artifacts; then aws s3 cp {output}/artifacts {destination}/artifacts '
                     '--recursive --sse AES256 --checksum-algorithm SHA256 --only-show-errors; fi',
                     f'aws s3 cp {remote}/input/{name}/manifest.json {destination}/manifest.json '
                     '--sse AES256 --checksum-algorithm SHA256 --only-show-errors']
    result = ssm.send_command(InstanceIds=[instance], DocumentName='AWS-RunShellScript',
                              Parameters={'commands': commands, 'executionTimeout': [str(min(1200, int(remaining) - 60))]},
                              TimeoutSeconds=120, Comment=f'Two authorized SeedVR2 7B movie trials: {trial}; private S3 results')
    record['commandId'] = result['Command']['CommandId']
    record['submittedAt'] = datetime.now(timezone.utc).isoformat()
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    record_path.chmod(0o600)
    print(json.dumps({key: record[key] for key in ('commandId', 'resultPrefix', 'autoStopAt')}, indent=2))


if __name__ == '__main__':
    main()
