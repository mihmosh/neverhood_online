"""Explicit local batch administration. Manifests/SQLite stay local, never in S3."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import sqlite3
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor

from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE.parent / 'aws'))
from operator_aws import operator_session

LOCAL = ROOT / 'private-assets/upscaling/full-game-v1'
AWS_LOCAL = ROOT / 'private-assets/upscaling/aws'
deployment, intent = {}, {}
REGION = 'us-east-2'
BUCKET = INSTANCE = STACK = None
PROFILE = os.environ.get('AWS_PROFILE', 'default')


def save(name, value):
    path = LOCAL / name
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, default=lambda item: item.isoformat() if isinstance(item, datetime) else str(item)) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 ** 2), b''):
            result.update(block)
    return result.hexdigest()


def session():
    return operator_session(PROFILE, REGION, intent['account'])


def inventory():
    source = ROOT / 'extracted/app'
    classes = {**{f'DATA/{name}.blb': 'original-game-media' for name in ('a', 'c', 'hd', 'i', 'm', 's', 't')},
               'NHC.exe': 'installation-executable-retail-provenance-unverified',
               'Smackw32.dll': 'installation-support-library', 'readme.txt': 'installation-documentation',
               'ddraw.dll': 'compatibility-addition', 'nvhpatch.dll': 'compatibility-addition',
               'The Neverhood Manual.pdf': 'documentation-provenance-unverified',
               'saves/config.dat': 'local-installation-state-snapshot'}
    actual = sorted(path for path in source.rglob('*') if path.is_file())
    if {path.relative_to(source).as_posix() for path in actual} != set(classes):
        raise RuntimeError('Installation differs from the reviewed fourteen-file scope; review before upload')
    files = []
    for path in actual:
        if path.is_symlink() or path.resolve() != path:
            raise RuntimeError('Original installation contains a symlink')
        relative = path.relative_to(source).as_posix()
        files.append({'relativePath': relative, 'localPath': str(path), 'bytes': path.stat().st_size,
                      'sha256': digest(path), 'classification': classes[relative],
                      's3Key': f'sources/game/installed-tree-v1/{relative}'})
    result = {'version': 1, 'localOnly': True, 'source': str(source), 'bucket': BUCKET,
              'files': files, 'fileCount': len(files), 'bytes': sum(item['bytes'] for item in files),
              'note': 'Complete installed tree, not authenticated retail originals. Distribution wrappers outside app are excluded.'}
    save('original-files.json', result)
    return result


def head(s3, key):
    try:
        return s3.head_object(Bucket=BUCKET, Key=key)
    except ClientError as error:
        if str(error.response['Error']['Code']) in ('404', 'NotFound', 'NoSuchKey'):
            return None
        raise


def upload_originals():
    record = inventory()
    s3 = session().client('s3')
    for item in record['files']:
        found = head(s3, item['s3Key'])
        matching = lambda value: value and value['ContentLength'] == item['bytes'] and value.get('Metadata', {}).get('sha256') == item['sha256']
        if not matching(found):
            legacy = 'sources/game/original-v1/' + Path(item['relativePath']).name if item['relativePath'].startswith('DATA/') else None
            previous = head(s3, legacy) if legacy else None
            if matching(previous):
                s3.copy_object(Bucket=BUCKET, Key=item['s3Key'], CopySource={'Bucket': BUCKET, 'Key': legacy},
                               CopySourceIfMatch=previous['ETag'], ServerSideEncryption='AES256', MetadataDirective='COPY')
            else:
                s3.upload_file(item['localPath'], BUCKET, item['s3Key'], ExtraArgs={'ServerSideEncryption': 'AES256',
                    'Metadata': {'sha256': item['sha256'], 'classification': item['classification']},
                    'CacheControl': 'private, no-store', 'ChecksumAlgorithm': 'SHA256'})
        verified = head(s3, item['s3Key'])
        if not matching(verified) or verified.get('ServerSideEncryption') != 'AES256':
            raise RuntimeError('Original upload verification failed: ' + item['relativePath'])
        item['s3VersionId'] = verified.get('VersionId')
        print('Verified original: ' + item['relativePath'], flush=True)
    record['verifiedAtUnix'] = time.time()
    save('original-files.json', record)
    print(json.dumps({'fileCount': record['fileCount'], 'bytes': record['bytes'], 'manifestLocalOnly': True,
                      's3Prefix': f's3://{BUCKET}/sources/game/installed-tree-v1/'}))


def upload_inputs():
    from job_contract import MODEL_SHA256
    plan = json.loads((LOCAL / 'manifest.json').read_text())
    s3 = session().client('s3')
    uploaded = []
    selected = [(LOCAL / item['file'], 'sources/full-game/realesrnet-inputs/embedded-v1/packs/' + Path(item['file']).name,
                 item['sha256']) for item in plan['packs']]
    selected.append((ROOT.parent / 'neverhood-upscaling/data/room-baselines/models/RealESRNet_x4plus.pth',
                     f'sources/models/realesrnet-x4plus/{MODEL_SHA256}.pth', MODEL_SHA256))
    for path, key, expected in selected:
        if digest(path) != expected:
            raise RuntimeError('Input/model changed after local preparation')
        existing = head(s3, key)
        size = path.stat().st_size
        if not existing or existing.get('Metadata', {}).get('sha256') != expected or existing['ContentLength'] != size:
            s3.upload_file(str(path), BUCKET, key, ExtraArgs={'ServerSideEncryption': 'AES256',
                'Metadata': {'sha256': expected}, 'CacheControl': 'private, no-store', 'ChecksumAlgorithm': 'SHA256'})
        verified = head(s3, key)
        if verified['ContentLength'] != size or verified.get('Metadata', {}).get('sha256') != expected:
            raise RuntimeError('Staged input verification failed')
        uploaded.append({'key': key, 'sha256': expected, 'bytes': size, 'versionId': verified.get('VersionId')})
        print('Verified input: ' + key, flush=True)
    save('staged-inputs.json', {'bucket': BUCKET, 'objects': uploaded, 'manifestsUploaded': False})


def local_stats():
    db = sqlite3.connect(f'file:{LOCAL / "jobs.sqlite"}?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    row = db.execute('SELECT count(*),min(width),min(height),max(width),max(height),max(width*height),sum(width*height),sum(fully_transparent) FROM jobs').fetchone()
    result = dict(zip(['uniqueJobs', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'maxFramePixels', 'nativePixels', 'transparentJobs'], row))
    result['largest'] = [dict(zip(['jobKey', 'width', 'height'], item)) for item in db.execute('SELECT job_key,width,height FROM jobs ORDER BY width*height DESC,job_key LIMIT 5')]
    db.close()
    save('source-stats.json', result)
    print(json.dumps(result, indent=2))


def arm_start():
    window_path = LOCAL / 'runtime-window.json'
    if window_path.exists():
        raise RuntimeError('A paid batch window is already recorded; inspect/resume it explicitly rather than extending automatically')
    cloud = session()
    ec2, scheduler, cfn = cloud.client('ec2'), cloud.client('scheduler'), cloud.client('cloudformation')
    instance = ec2.describe_instances(InstanceIds=[INSTANCE])['Reservations'][0]['Instances'][0]
    if instance['InstanceType'] != 'g6.2xlarge' or instance['State']['Name'] != 'stopped' or instance['MetadataOptions']['HttpTokens'] != 'required':
        raise RuntimeError('Expected the reviewed stopped IMDSv2 L4 worker')
    previous = json.loads((AWS_LOCAL / 'scheduler-state.json').read_text())
    if json.loads(previous['Target']['Input']).get('InstanceIds') != [INSTANCE] or not previous['Target']['Arn'].endswith(':aws-sdk:ec2:stopInstances'):
        raise RuntimeError('Refusing any stop target other than this lab instance')
    deadline = datetime.now(timezone.utc) + timedelta(hours=4)
    stamp = deadline.strftime('%Y-%m-%dT%H:%M:%S')
    request = {key: previous[key] for key in ('Name', 'GroupName', 'Description', 'FlexibleTimeWindow', 'Target') if key in previous}
    request.update(ScheduleExpression=f'at({stamp})', ScheduleExpressionTimezone='UTC', State='ENABLED', ActionAfterCompletion='DELETE')
    window = {'instanceId': INSTANCE, 'region': REGION, 'plannedAt': datetime.now(timezone.utc).isoformat(),
              'deadlineUtc': stamp + 'Z', 'maximumInitialHours': 4, 'maximumComputeUSD': 3.9104,
              'automaticExtensionsAllowed': False, 'scheduleName': previous['Name']}
    save('runtime-window-intent.json', window)
    try:
        found = scheduler.get_schedule(Name=previous['Name'], GroupName=previous.get('GroupName', 'default'))
    except scheduler.exceptions.ResourceNotFoundException:
        found = None
    if found:
        if json.loads(found['Target']['Input']).get('InstanceIds') != [INSTANCE]:
            raise RuntimeError('Existing schedule targets a different instance')
        scheduler.update_schedule(**request)
    else:
        scheduler.create_schedule(**request)
    guard = scheduler.get_schedule(Name=previous['Name'], GroupName=previous.get('GroupName', 'default'))
    if guard['State'] != 'ENABLED' or guard['ScheduleExpression'] != f'at({stamp})':
        raise RuntimeError('Auto-stop was not armed; refusing paid start')
    change = cfn.update_stack(StackName=STACK, UsePreviousTemplate=True, Capabilities=['CAPABILITY_IAM'],
        Parameters=[{'ParameterKey': 'AutoStopAt', 'ParameterValue': stamp}] +
        [{'ParameterKey': name, 'UsePreviousValue': True} for name in ('ImageId', 'RootDeviceName', 'AvailabilityZone')])
    window['stackUpdate'] = change['StackId']
    response = ec2.start_instances(InstanceIds=[INSTANCE])
    window['startResult'] = response['StartingInstances']
    save('runtime-window.json', window)
    print(json.dumps({'instanceId': INSTANCE, 'state': response['StartingInstances'][0]['CurrentState']['Name'],
                      'autoStopUtc': window['deadlineUtc'], 'maximumComputeUSD': window['maximumComputeUSD']}))


def stage_runtime():
    s3 = session().client('s3')
    files = ['worker.py', 'model.py', 'job_contract.py', 'install-worker.sh', 'run-worker.sh', 'licenses/BasicSR-LICENSE.txt']
    records = []
    for name in files:
        path = HERE / name
        value = digest(path)
        key = 'sources/tools/full-realesrnet-v1/' + name
        existing = head(s3, key)
        if not existing or existing.get('Metadata', {}).get('sha256') != value:
            s3.upload_file(str(path), BUCKET, key, ExtraArgs={'ServerSideEncryption': 'AES256',
                'Metadata': {'sha256': value}, 'CacheControl': 'private, no-store', 'ContentType': 'text/plain'})
        verified = head(s3, key)
        if verified.get('Metadata', {}).get('sha256') != value:
            raise RuntimeError('Control upload verification failed')
        records.append({'file': name, 'key': key, 'sha256': value, 'bytes': path.stat().st_size})
    save('staged-runtime.json', {'files': records, 'stateUploaded': False})
    print(json.dumps({'reviewedControlFiles': len(records), 'manifestOrDatabaseUploaded': False}))


def command_arguments():
    from job_contract import MODEL_SHA256, keyset_digest
    db = sqlite3.connect(f'file:{LOCAL / "jobs.sqlite"}?mode=ro', uri=True)
    keys = [row[0] for row in db.execute('SELECT job_key FROM jobs ORDER BY job_key')]
    maximum = db.execute('SELECT max(width*height) FROM jobs').fetchone()[0]
    db.close()
    window = json.loads((LOCAL / 'runtime-window.json').read_text())
    return ['--bucket', BUCKET, '--checkpoint', f'/opt/neverhood-upscaling/realesrnet/models/{MODEL_SHA256}.pth',
            '--expected-job-count', str(len(keys)), '--expected-keyset-sha256', keyset_digest(keys),
            '--max-frame-pixels', str(maximum), '--deadline-utc', window['deadlineUtc'], '--pilot-count', '12']


def pilot():
    import shlex
    from job_contract import MODEL_SHA256
    record_path = LOCAL / 'pilot-command.json'
    if record_path.exists() or (LOCAL / 'pilot-intent.json').exists():
        raise RuntimeError('Pilot already submitted; inspect its result instead of duplicating')
    cloud = session()
    info = cloud.client('ssm').describe_instance_information(Filters=[{'Key': 'InstanceIds', 'Values': [INSTANCE]}])
    if not info['InstanceInformationList'] or info['InstanceInformationList'][0]['PingStatus'] != 'Online':
        raise RuntimeError('SSM is not online yet')
    controls = json.loads((LOCAL / 'staged-runtime.json').read_text())['files']
    commands = ['#!/bin/bash', 'set -euo pipefail', 'nvidia-smi',
                'install -d -m 0755 /opt/neverhood-upscaling/control/full-game/licenses']
    commands += [f'aws s3 cp s3://{BUCKET}/{item["key"]} /opt/neverhood-upscaling/control/full-game/{item["file"]} --region us-east-2 --only-show-errors --no-progress' for item in controls]
    commands += ['bash /opt/neverhood-upscaling/control/full-game/install-worker.sh',
                 f'aws s3 cp s3://{BUCKET}/sources/models/realesrnet-x4plus/{MODEL_SHA256}.pth /opt/neverhood-upscaling/realesrnet/models/{MODEL_SHA256}.pth --region us-east-2 --only-show-errors --no-progress',
                 f'chown ubuntu:ubuntu /opt/neverhood-upscaling/realesrnet/models/{MODEL_SHA256}.pth',
                 'bash /opt/neverhood-upscaling/realesrnet/bin/run-worker.sh pilot 900 ' + shlex.join(command_arguments() + ['--max-jobs', '12'])]
    save('pilot-intent.json', {'instance': INSTANCE, 'submittedAt': datetime.now(timezone.utc).isoformat(), 'maximumJobs': 12})
    result = cloud.client('ssm').send_command(InstanceIds=[INSTANCE], DocumentName='AWS-RunShellScript',
        Parameters={'commands': commands, 'executionTimeout': ['1500']}, TimeoutSeconds=300,
        Comment='Twelve representative RealESRNet frames; no automatic full batch until quality gate')
    save('pilot-command.json', result['Command'])
    print(json.dumps({'commandId': result['Command']['CommandId'], 'instance': INSTANCE, 'pilotJobs': 12}))


def recover_pilot():
    request = json.loads((LOCAL / 'pilot-intent.json').read_text())
    since = datetime.fromisoformat(request['submittedAt'])
    commands = session().client('ssm').list_commands(InstanceId=INSTANCE, MaxResults=50)['Commands']
    matching = [item for item in commands if item.get('Comment') == 'Twelve representative RealESRNet frames; no automatic full batch until quality gate'
                and item['RequestedDateTime'] >= since - timedelta(seconds=2)]
    if len(matching) != 1:
        raise RuntimeError('Cannot safely identify the single submitted pilot; refusing a duplicate')
    save('pilot-command.json', matching[0])
    print(json.dumps({'recoveredCommandId': matching[0]['CommandId'], 'status': matching[0]['Status'], 'newCommandsCreated': 0}))


def retry_pilot_dependencies():
    command = json.loads((LOCAL / 'pilot-command.json').read_text())
    result = session().client('ssm').get_command_invocation(CommandId=command['CommandId'], InstanceId=INSTANCE)
    if result['Status'] != 'Failed' or result['ResponseCode'] != 1 or "No module named 'scipy'" not in result['StandardErrorContent'] or 'Worker installed' in result['StandardOutputContent']:
        raise RuntimeError('Only the verified pre-inference SciPy installation failure may be retried here')
    save('pilot-dependency-failure.json', result)
    for name in ('pilot-command.json', 'pilot-intent.json'):
        (LOCAL / name).rename(LOCAL / (name.replace('.json', '-dependency-failure.json')))
    pilot()


def retry_pilot_imds():
    command = json.loads((LOCAL / 'pilot-command.json').read_text())
    result = session().client('ssm').get_command_invocation(CommandId=command['CommandId'], InstanceId=INSTANCE)
    summaries = []
    for line in result.get('StandardOutputContent', '').splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and 'status' in value:
                summaries.append(value)
        except json.JSONDecodeError:
            pass
    summary = summaries[-1] if summaries else {}
    if result['Status'] != 'Failed' or summary.get('error_type') != 'ProfileNotFound' or summary.get('attempted') != 0:
        raise RuntimeError('Only the verified zero-inference profile initialization failure may be retried')
    save('pilot-imds-failure.json', result)
    for name in ('pilot-command.json', 'pilot-intent.json'):
        (LOCAL / name).rename(LOCAL / (name.replace('.json', '-imds-failure.json')))
    pilot()


def collect_pilot():
    cloud = session()
    command = json.loads((LOCAL / 'pilot-command.json').read_text())
    result = cloud.client('ssm').get_command_invocation(CommandId=command['CommandId'], InstanceId=INSTANCE)
    save('pilot-invocation.json', result)
    if result['Status'] != 'Success':
        print(json.dumps({'status': result['Status'], 'code': result['ResponseCode']}))
        return
    summaries = []
    for line in result['StandardOutputContent'].splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and 'status' in value:
                summaries.append(value)
        except json.JSONDecodeError:
            pass
    if not summaries or summaries[-1].get('status') != 'pilot-complete':
        raise RuntimeError('No successful pilot summary')
    summary = summaries[-1]
    save('pilot-summary.json', summary)
    import re
    memory = re.search(r'(\d+)MiB\s*\|', result['StandardOutputContent'])
    # The reviewed instance type is a full L4; parse its actual nvidia-smi total.
    memory = re.search(r'\d+MiB\s*/\s*(\d+)MiB', result['StandardOutputContent'])
    if not memory:
        raise RuntimeError('Actual GPU capacity missing from pilot output')
    save('localhardware.json', {'totalMemoryBytes': int(memory.group(1)) * 1024 ** 2, 'source': 'pilot nvidia-smi'})
    destination = LOCAL / 'pilot-output'
    destination.mkdir(exist_ok=True)
    metadata = {}
    s3 = cloud.client('s3')
    for key in summary['pilot_keys']:
        if not re.fullmatch('[a-f0-9]{64}', key):
            raise RuntimeError('Unsafe pilot result key')
        response = s3.get_object(Bucket=BUCKET, Key=f'results/{STACK}/full-realesrnet-v1/images/{key}.png')
        data = response['Body'].read()
        if hashlib.sha256(data).hexdigest() != response['Metadata'].get('sha256'):
            raise RuntimeError('Pilot download checksum mismatch')
        (destination / f'{key}.png').write_bytes(data)
        metadata[key] = response['Metadata']
    save('pilot-output-metadata.json', metadata)
    print(json.dumps({'status': summary['status'], 'downloaded': len(metadata), 'elapsedSeconds': summary['elapsed_seconds'],
                      'peakReservedBytes': summary['peak_reserved_bytes']}))


def start_full():
    import shlex
    approval = json.loads((LOCAL / 'pilot-approval.json').read_text())
    if approval.get('passed') is not True:
        raise RuntimeError('Full execution requires the measured local quality approval')
    if (LOCAL / 'full-command.json').exists() or (LOCAL / 'full-intent.json').exists():
        raise RuntimeError('Full batch was already submitted; inspect or resume explicitly')
    for item in json.loads((LOCAL / 'staged-runtime.json').read_text())['files']:
        if digest(HERE / item['file']) != item['sha256']:
            raise RuntimeError('Runtime code changed after pilot; repeat the review instead of mixing versions')
    window = json.loads((LOCAL / 'runtime-window.json').read_text())
    remaining = datetime.fromisoformat(window['deadlineUtc'].replace('Z', '+00:00')) - datetime.now(timezone.utc)
    if remaining.total_seconds() < 1800:
        raise RuntimeError('Insufficient remaining budget for full-batch launch')
    cloud = session()
    scheduler = cloud.client('scheduler')
    schedule = scheduler.get_schedule(Name=window['scheduleName'])
    if schedule['State'] != 'ENABLED' or schedule['ScheduleExpression'] != f'at({window["deadlineUtc"][:-1]})' or json.loads(schedule['Target']['Input']).get('InstanceIds') != [INSTANCE]:
        raise RuntimeError('Auto-stop does not match the approved worker/window')
    if schedule.get('ActionAfterCompletion') != 'DELETE':
        update = {key: schedule[key] for key in ('Name', 'GroupName', 'Description', 'ScheduleExpression', 'ScheduleExpressionTimezone', 'State', 'FlexibleTimeWindow', 'Target') if key in schedule}
        scheduler.update_schedule(**update, ActionAfterCompletion='DELETE')
    commands = ['#!/bin/bash', 'set -euo pipefail',
        'bash /opt/neverhood-upscaling/realesrnet/bin/run-worker.sh full 14400 ' + shlex.join(command_arguments() + ['--max-jobs', '4458']),
        '/opt/neverhood-upscaling/runner/venv/bin/python -c \'import json; d=json.load(open("/opt/neverhood-upscaling/realesrnet/state/summary.json")); assert d["status"]=="complete" and d["counts"].get("done")==4458; print("Full batch verified: 4458 unique images, checkpoint local")\'',
        'shutdown -h +2 "Verified Neverhood RealESRNet batch complete; stop only this worker"']
    save('full-intent.json', {'at': datetime.now(timezone.utc).isoformat(), 'instance': INSTANCE,
        'deadlineUtc': window['deadlineUtc'], 'maximumNewJobs': 4458, 'shutdownOnVerifiedSuccess': True})
    result = cloud.client('ssm').send_command(InstanceIds=[INSTANCE], DocumentName='AWS-RunShellScript',
        Parameters={'commands': commands, 'executionTimeout': ['15000']}, TimeoutSeconds=300,
        Comment='Full 4458-image RealESRNet batch after measured pilot; stop worker after verified completion')
    save('full-command.json', result['Command'])
    print(json.dumps({'commandId': result['Command']['CommandId'], 'instance': INSTANCE,
                      'uniqueJobs': 4458, 'sourceFrames': 6813, 'autoStopUtc': window['deadlineUtc']}))


def progress():
    import re
    from job_contract import MODEL_SHA256, PREPROC_SPEC, keyset_digest
    cloud = session()
    command = json.loads((LOCAL / 'full-command.json').read_text())
    invocation = cloud.client('ssm').get_command_invocation(CommandId=command['CommandId'], InstanceId=INSTANCE)
    save('full-invocation.json', invocation)
    s3 = cloud.client('s3')
    prefix = f'results/{STACK}/full-realesrnet-v1/images/'
    db = sqlite3.connect(LOCAL / 'jobs.sqlite')
    db.row_factory = sqlite3.Row
    expected = {row['job_key']: dict(row) for row in db.execute('SELECT job_key,width,height,input_sha256 FROM jobs')}
    listed = {}
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=prefix):
        for item in page.get('Contents', []):
            name = item['Key'][len(prefix):]
            if not re.fullmatch('[a-f0-9]{64}\\.png', name) or name[:-4] not in expected:
                raise RuntimeError('Unexpected key in this batch output prefix')
            listed[name[:-4]] = item
    status = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'commandStatus': invocation['Status'],
              'expectedUniqueJobs': len(expected), 'remoteObjectsSeen': len(listed), 'physicalFrames': db.execute('SELECT count(*) FROM frame_jobs').fetchone()[0],
              'outputPrefix': f's3://{BUCKET}/{prefix}', 'localOnly': True,
              'allObjectsVerified': False, 'runtimeContextClosureVerified': False}
    if set(listed) == set(expected):
        def verify(key):
            info = s3.head_object(Bucket=BUCKET, Key=prefix + key + '.png')
            metadata = info.get('Metadata', {})
            source = expected[key]
            if (metadata.get('input-jobkey') != key or metadata.get('input-sha256') != source['input_sha256']
                    or metadata.get('model-sha256') != MODEL_SHA256 or metadata.get('preproc-spec') != PREPROC_SPEC
                    or metadata.get('mask-policy') != 'index0-binary-nearest4x-hiddenrgb0'
                    or metadata.get('width') != str(source['width'] * 4) or metadata.get('height') != str(source['height'] * 4)
                    or metadata.get('scale') != '4' or not re.fullmatch('[a-f0-9]{64}', metadata.get('sha256', ''))
                    or info.get('ServerSideEncryption') != 'AES256'):
                raise RuntimeError('Output metadata contract mismatch')
            return key, metadata['sha256'], info['ContentLength'], info.get('VersionId')
        with ThreadPoolExecutor(max_workers=8) as pool:
            verified = list(pool.map(verify, sorted(listed)))
        db.execute('CREATE TABLE IF NOT EXISTS hd_outputs(job_key TEXT PRIMARY KEY REFERENCES jobs(job_key),s3_key TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,version_id TEXT)')
        with db:
            db.executemany('INSERT OR REPLACE INTO hd_outputs VALUES(?,?,?,?,?)', [(key, prefix + key + '.png', sha, size, version) for key, sha, size, version in verified])
            db.executemany("UPDATE jobs SET status='uploaded-verified' WHERE job_key=?", [(key,) for key in listed])
        rows = db.execute('''SELECT f.id AS source_frame_id,f.width,f.height,f.list_index,f.frame_index,f.metadata_json,
                   fj.original_list_id,fj.is_winner,fj.retain_flag,fj.context_status,fj.job_key,
                   o.s3_key,o.sha256 AS output_sha256,o.bytes AS output_bytes
            FROM frame_jobs fj JOIN decodedframes f ON f.id=fj.frame_id JOIN hd_outputs o ON o.job_key=fj.job_key
            ORDER BY f.id''')
        final_path = LOCAL / 'hd-animation-assets.jsonl'
        temporary = final_path.with_suffix('.jsonl.tmp')
        count = 0
        with temporary.open('w') as stream:
            for row in rows:
                value = dict(row)
                value['metadata'] = json.loads(value.pop('metadata_json'))
                value['scale'] = 4
                value['bucket'] = BUCKET
                value['alphaPolicy'] = 'source-index0-binary-nearest4x'
                value['runtimeContextVerified'] = False
                stream.write(json.dumps(value, sort_keys=True) + '\n')
                count += 1
        if count != status['physicalFrames']:
            raise RuntimeError('Final local frame mapping is incomplete')
        temporary.replace(final_path)
        status.update(allObjectsVerified=True, uniqueOutputs=len(verified), mappedPhysicalFrames=count,
                      keysetSHA256=keyset_digest(listed), outputBytes=sum(item[2] for item in verified),
                      localAssetManifest=str(final_path))
    save('progress.json', status)
    db.close()
    print(json.dumps(status, indent=2))


def download_samples():
    import random
    db = sqlite3.connect(f'file:{LOCAL / "jobs.sqlite"}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    rows = [dict(row) for row in db.execute('SELECT j.job_key,j.width,j.height,j.input_path,j.input_sha256,o.s3_key,o.sha256,o.bytes FROM jobs j JOIN hd_outputs o ON o.job_key=j.job_key ORDER BY j.job_key')]
    db.close()
    if len(rows) != 4458:
        raise RuntimeError('Sample only after all expected metadata are reconciled')
    chosen = {row['job_key']: row for row in random.Random(314159).sample(rows, 20)}
    for row in (min(rows, key=lambda item: item['width'] * item['height']), max(rows, key=lambda item: item['width'] * item['height'])):
        chosen[row['job_key']] = row
    s3 = session().client('s3')
    directory = LOCAL / 'verified-samples'
    directory.mkdir(exist_ok=True)
    for row in chosen.values():
        data = s3.get_object(Bucket=BUCKET, Key=row['s3_key'])['Body'].read()
        if hashlib.sha256(data).hexdigest() != row['sha256'] or len(data) != row['bytes']:
            raise RuntimeError('Sample body differs from the verified metadata')
        file = directory / (row['job_key'] + '.png')
        file.write_bytes(data)
        row['downloaded_path'] = str(file)
    save('sample-downloads.json', {'seed': 314159, 'files': list(chosen.values()), 'localOnly': True})
    print(json.dumps({'verifiedDownloadedSamples': len(chosen), 'directory': str(directory)}))


def finalize_local():
    observation = json.loads((LOCAL / 'progress.json').read_text())
    samples = json.loads((LOCAL / 'sample-validation.json').read_text())
    invocation = json.loads((LOCAL / 'full-invocation.json').read_text())
    if not observation['allObjectsVerified'] or observation['uniqueOutputs'] != 4458 or not samples['passed'] or invocation['Status'] != 'Success':
        raise RuntimeError('Completion requires independent metadata, pixel samples and successful worker execution')
    summaries = []
    for line in invocation['StandardOutputContent'].splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict) and value.get('status') == 'complete':
                summaries.append(value)
        except json.JSONDecodeError:
            pass
    if len(summaries) != 1 or summaries[0]['counts'].get('done') != 4458:
        raise RuntimeError('Worker completion count is not established')
    instance = session().client('ec2').describe_instances(InstanceIds=[INSTANCE])['Reservations'][0]['Instances'][0]
    result = {**observation, 'completed': True, 'completedAt': datetime.now(timezone.utc).isoformat(),
              'worker': summaries[0], 'independentPixelSamples': samples['sampleCount'],
              'localManifestSHA256': digest(LOCAL / 'hd-animation-assets.jsonl'),
              'localDatabaseSHA256': digest(LOCAL / 'jobs.sqlite'),
              'instanceState': instance['State']['Name'], 'manifestAndDatabaseUploaded': False,
              'publicReleaseModified': False, 'scope': 'All physical type-4 animation frames using embedded palettes and default index-0 masks; runtime context closure unverified'}
    save('completion.json', result)
    print(json.dumps({key: result[key] for key in ('completed', 'uniqueOutputs', 'mappedPhysicalFrames', 'outputBytes', 'independentPixelSamples', 'instanceState', 'manifestAndDatabaseUploaded')}, indent=2))


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['inventory-originals', 'upload-originals', 'upload-inputs', 'local-stats', 'arm-start', 'stage-runtime', 'pilot', 'recover-pilot', 'retry-pilot-deps', 'retry-pilot-imds', 'collect-pilot', 'start-full', 'progress', 'download-samples', 'finalize-local'])
args = parser.parse_args()
LOCAL.mkdir(parents=True, exist_ok=True, mode=0o700)
if args.action not in ('inventory-originals', 'local-stats'):
    deployment = json.loads((AWS_LOCAL / 'stack-state.json').read_text())
    intent = json.loads((AWS_LOCAL / 'create-intent.json').read_text())
    REGION = deployment['region']
    BUCKET, INSTANCE, STACK = deployment['outputs']['BucketName'], deployment['outputs']['InstanceId'], deployment['stack']
if args.action == 'inventory-originals':
    result = inventory()
    print(json.dumps({key: result[key] for key in ('fileCount', 'bytes', 'localOnly')}))
elif args.action == 'upload-originals':
    upload_originals()
elif args.action == 'upload-inputs':
    upload_inputs()
elif args.action == 'local-stats':
    local_stats()
elif args.action == 'arm-start':
    arm_start()
elif args.action == 'stage-runtime':
    stage_runtime()
elif args.action == 'pilot':
    pilot()
elif args.action == 'recover-pilot':
    recover_pilot()
elif args.action == 'retry-pilot-deps':
    retry_pilot_dependencies()
elif args.action == 'retry-pilot-imds':
    retry_pilot_imds()
elif args.action == 'collect-pilot':
    collect_pilot()
elif args.action == 'start-full':
    start_full()
elif args.action == 'progress':
    progress()
elif args.action == 'download-samples':
    download_samples()
elif args.action == 'finalize-local':
    finalize_local()
