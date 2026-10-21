"""Upload an explicit ignored plan; short-lived AWS credentials remain in memory."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError
from operator_aws import operator_session

plan_path = Path(sys.argv[1]).resolve()
plan = json.loads(plan_path.read_text())
profile = os.environ.get('AWS_PROFILE', 'default')
session = operator_session(profile, plan['region'], plan['account'])
s3 = session.client('s3', config=Config(retries={'max_attempts': 5, 'mode': 'adaptive'}))
transfer = TransferConfig(max_concurrency=2, multipart_threshold=8 * 1024 ** 2, multipart_chunksize=8 * 1024 ** 2)
records = []
for index, entry in enumerate(plan['objects'], 1):
    key, path = entry['key'], Path(entry['path'])
    if not key.startswith(('sources/', 'results/', 'releases/hd-demo/')) or any(part in ('', '.', '..') for part in key.split('/')):
        raise SystemExit('Unsafe upload key')
    if path.resolve() != path or path.is_symlink() or not path.is_file():
        raise SystemExit('Non-regular input')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 ** 2), b''):
            digest.update(block)
    if path.stat().st_size != entry['bytes'] or digest.hexdigest() != entry['sha256']:
        raise SystemExit(f'Input changed after plan creation: {key}')
    try:
        existing = s3.head_object(Bucket=plan['bucket'], Key=key)
    except ClientError as error:
        if str(error.response['Error']['Code']) not in ('404', 'NoSuchKey', 'NotFound'):
            raise
        existing = None
    changed = not existing or existing.get('Metadata', {}).get('sha256') != entry['sha256'] or existing['ContentLength'] != entry['bytes']
    if changed:
        s3.upload_file(str(path), plan['bucket'], key, Config=transfer, ExtraArgs={
            'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
            'Metadata': {'sha256': entry['sha256']}, 'ContentType': entry['contentType'], 'CacheControl': entry['cacheControl']})
    verified = s3.head_object(Bucket=plan['bucket'], Key=key)
    if verified['ContentLength'] != entry['bytes'] or verified.get('Metadata', {}).get('sha256') != entry['sha256'] or verified.get('ServerSideEncryption') != 'AES256':
        raise SystemExit(f'Upload verification failed: {key}')
    records.append({'key': key, 'bytes': entry['bytes'], 'sha256': entry['sha256'], 'versionId': verified.get('VersionId')})
    if changed or index % 50 == 0:
        print(f'{index}/{len(plan["objects"])} {"uploaded" if changed else "verified"}: {key}', flush=True)
result = {'bucket': plan['bucket'], 'uploadedAtUnix': time.time(), 'objects': records,
          'objectCount': len(records), 'totalBytes': sum(entry['bytes'] for entry in records)}
destination = plan_path.with_name('uploaded-objects.json' if plan_path.name == 'upload-plan.json' else f'{plan_path.stem}-receipt.json')
temporary = destination.with_suffix('.json.tmp')
temporary.write_text(json.dumps(result, indent=2) + '\n')
temporary.chmod(0o600)
temporary.replace(destination)
print(json.dumps({'objectCount': result['objectCount'], 'totalBytes': result['totalBytes']}), flush=True)
