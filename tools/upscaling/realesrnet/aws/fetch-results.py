"""Download only this lab's sanitized model artifacts and verify output PNG hashes."""
import argparse
import hashlib
import json
import os
from pathlib import Path

from operator_aws import operator_session

parser = argparse.ArgumentParser()
parser.add_argument('--variant', choices=['3b', '7b'], required=True)
parser.add_argument('--experiment', choices=['baseline', 'triplicate'], default='baseline')
parser.add_argument('--destination', type=Path, required=True, help='Private runs directory; variant is appended')
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
state = json.loads((root / 'private-assets/upscaling/aws/stack-state.json').read_text())
intent = json.loads((root / 'private-assets/upscaling/aws/create-intent.json').read_text())
destination = args.destination.resolve() / args.variant
if destination.is_relative_to(root) and not destination.is_relative_to(root / 'private-assets'):
    raise SystemExit('Model outputs must remain outside public/source trees')
session = operator_session(os.environ.get('AWS_PROFILE', 'default'), state['region'], intent['account'])
s3 = session.client('s3')
bucket = state['outputs']['BucketName']
prefix = f'results/{state["stack"]}/' + (f'triplicate/{args.variant}/' if args.experiment == 'triplicate' else '7b/' if args.variant == '7b' else '')
report_bytes = s3.get_object(Bucket=bucket, Key=prefix + 'report.json')['Body'].read()
report = json.loads(report_bytes)
destination.mkdir(parents=True, exist_ok=True, mode=0o700)
count = 0
for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
    for entry in page.get('Contents', []):
        name = entry['Key'][len(prefix):]
        if args.experiment == 'baseline' and args.variant == '3b' and '/' in name and not name.startswith('frames/input/'):
            continue
        if not name or any(part in ('', '.', '..') for part in name.split('/')) or name.startswith('/'):
            raise SystemExit('Unexpected artifact key')
        path = destination / name
        if path.suffix not in ('.json', '.png', '.txt', '.log'):
            raise SystemExit(f'Unreviewed artifact: {name}')
        if path.resolve() != path:
            raise SystemExit('Artifact destination contains a symlink')
        path.parent.mkdir(parents=True, exist_ok=True)
        s3.download_file(bucket, entry['Key'], str(path))
        count += 1
if report.get('status') == 'succeeded':
    expected_hash = '7848d6a64008e95e874c5f9c8e4b242aa81ad3018eedcf6acd00e7f203310f0a' if args.experiment == 'triplicate' else 'e2f9fdbeeadff553da72d1881dfdb01ec10fa682c7268abf3a409e2e614cb201'
    if report['input']['sha256'] != expected_hash:
        raise SystemExit('Run uses another source clip')
    if report['output']['frames'] != (149 if args.experiment == 'triplicate' else 49):
        raise SystemExit('Unexpected experiment frame count')
    for entry in report['output']['files']:
        if Path(entry['file']).name != entry['file']:
            raise SystemExit('Unsafe report filename')
        path = destination / 'frames/input' / entry['file']
        if path.stat().st_size != entry['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise SystemExit(f'Artifact checksum mismatch: {entry["file"]}')
print(json.dumps({'variant': args.variant, 'status': report['status'], 'files': count, 'destination': str(destination),
                  'inferenceSeconds': report.get('inferenceSeconds'), 'outputFrames': report.get('output', {}).get('frames')}))
