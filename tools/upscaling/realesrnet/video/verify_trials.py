"""Fetch private movie trial artifacts and verify their recorded hashes locally."""
import argparse
from fractions import Fraction
import importlib.util
import json
from pathlib import Path
from botocore.exceptions import WaiterError

from aws_trials import digest, operator_session


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--wait', action='store_true', help='Wait for this recorded SSM command before fetching')
    parser.add_argument('--repair-mux', action='store_true', help='Repackage only the known MKV FPS failure, without inference, into a new S3 prefix')
    args = parser.parse_args()
    directory = args.directory.resolve()
    repo = Path(__file__).resolve().parents[4]
    if not directory.is_relative_to(repo / 'private-research'):
        raise ValueError('Results must remain private')
    record = json.loads((directory / 'aws-submission.json').read_text())
    intent = json.loads((repo / 'private-assets/upscaling/aws/create-intent.json').read_text())
    session = operator_session(args.profile, 'us-east-2', intent['account'])
    s3 = session.client('s3')
    ssm = session.client('ssm')
    if args.wait:
        print('Waiting for the recorded movie trial command; no additional inference is submitted.', flush=True)
        try:
            ssm.get_waiter('command_executed').wait(CommandId=record['commandId'], InstanceId=record['instance'],
                                                  WaiterConfig={'Delay': 15, 'MaxAttempts': 50})
        except WaiterError:
            pass  # Persist terminal status and archive available diagnostics below.
    invocation = ssm.get_command_invocation(
        CommandId=record['commandId'], InstanceId=record['instance'])
    # Do not publish raw SSM stdout/stderr; model logs can contain download URLs.
    status = {key: invocation.get(key) for key in (
        'CommandId', 'InstanceId', 'Status', 'ResponseCode', 'ExecutionStartDateTime', 'ExecutionEndDateTime')}
    (directory / 'ssm-status.json').write_text(json.dumps(status, indent=2) + '\n')
    if status['Status'] not in ('Success', 'Failed', 'TimedOut', 'Cancelled'):
        raise ValueError('Command is not terminal; use the AWS waiter before verification')
    results = []
    published_prefix = record['resultPrefix'] + ('packaged-v2/' if args.repair_mux else '')
    for name in ('cutscene-01', 'navigation-01'):
        prefix = record['resultPrefix'] + name + '/'
        local = directory / 'results' / name
        local.mkdir(mode=0o700, parents=True, exist_ok=True)
        keys = []
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=record['bucket'], Prefix=prefix):
            for item in page.get('Contents', []):
                relative = Path(item['Key'][len(prefix):])
                if relative.is_absolute() or '..' in relative.parts:
                    raise ValueError('Unsafe result object path')
                target = local / relative
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                s3.download_file(record['bucket'], item['Key'], str(target))
                target.chmod(0o600)
                head = s3.head_object(Bucket=record['bucket'], Key=item['Key'])
                if target.stat().st_size != item['Size'] or head['ServerSideEncryption'] != 'AES256':
                    raise ValueError('S3 size/encryption mismatch')
                keys.append({'key': item['Key'], 'bytes': item['Size'], 'sha256': digest(target)})
        report = json.loads((local / 'report.json').read_text())
        repairable = (args.repair_mux and report['status'] == 'failed'
                      and report.get('error') == 'Muxed movie frame rate, count or audio tracks changed'
                      and len(report.get('frames', [])) == report['manifest']['selection']['frames']
                      and report.get('inferenceSeconds', 0) > 0)
        if (report['status'] != 'succeeded' and not repairable) or report['modelVariant'] != '7b':
            raise ValueError(f'{name}: model run failed: {report.get("error")}')
        if digest(local / 'manifest.json') != report['manifestSHA256']:
            raise ValueError('Manifest binding changed')
        for frame in report['frames']:
            if digest(local / 'artifacts/frames/input' / frame['file']) != frame['sha256']:
                raise ValueError('Frame SHA256 mismatch')
        if repairable:
            spec = importlib.util.spec_from_file_location('repack_movie', Path(__file__).with_name('run.py'))
            runner = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runner)
            original_report_hash = digest(local / 'report.json')
            original_frames = local / 'artifacts/frames/input'
            data = runner.validate_manifest(directory / name, report['manifestSHA256'])
            runner.inspect_frames(local, data)
            local = directory / 'results-packaged-v2' / name
            local.mkdir(mode=0o700, parents=True)  # Explicit recovery never overwrites artifacts.
            (local / 'artifacts').mkdir(mode=0o700)
            report['previewSHA256'] = runner.package_movie(local, directory / name, data, original_frames)
            report['repackaging'] = {'originalReportSHA256': original_report_hash,
                                     'originalResultPrefix': prefix, 'originalStatus': 'failed',
                                     'originalError': report.pop('error'), 'inferenceRepeated': False,
                                     'fix': 'MP4 exact video timescale with copied FLAC instead of Matroska'}
            report['status'] = 'succeeded'
            report['packagingToolSHA256'] = digest(Path(__file__).with_name('run.py'))
            (local / 'manifest.json').write_bytes((directory / name / 'manifest.json').read_bytes())
            (local / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
            master = local / 'artifacts/restored.mp4'
            runner.probe.run(['ffmpeg', '-v', 'error', '-n', '-i', str(master),
                              '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-crf', '18',
                              '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-video_track_timescale',
                              str(Fraction(data['source']['fps']).numerator), '-movflags', '+faststart',
                              str(local / 'artifacts/restored-preview.mp4')], timeout=300)
            width, height = data['target']['width'], data['target']['height']
            runner.probe.run(['ffmpeg', '-v', 'error', '-n', '-i', str(directory / name / 'input.mp4'),
                              '-i', str(master), '-filter_complex',
                              f'[0:v]scale={width}:{height}:flags=neighbor[a];[a][1:v]hstack=inputs=2[v]',
                              '-map', '[v]', '-map', '1:a:0?', '-c:v', 'libx264', '-crf', '18',
                              '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-video_track_timescale',
                              str(Fraction(data['source']['fps']).numerator), '-movflags', '+faststart',
                              str(local / 'artifacts/comparison-preview.mp4')], timeout=300)
            for path in sorted(local.rglob('*')):
                if not path.is_file():
                    continue
                key = published_prefix + name + '/' + path.relative_to(local).as_posix()
                sha = digest(path)
                s3.upload_file(str(path), record['bucket'], key, ExtraArgs={
                    'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
                    'Metadata': {'sha256': sha}, 'CacheControl': 'private, no-store',
                    'ContentType': 'video/mp4' if path.suffix == '.mp4' else 'application/json'})
                head = s3.head_object(Bucket=record['bucket'], Key=key)
                if head['Metadata'].get('sha256') != sha or head['ContentLength'] != path.stat().st_size or head['ServerSideEncryption'] != 'AES256':
                    raise ValueError('Repackaged upload verification failed')
                keys.append({'key': key, 'bytes': path.stat().st_size, 'sha256': sha})
        if digest(local / 'artifacts/restored.mp4') != report['previewSHA256']:
            raise ValueError('Restored movie SHA256 mismatch')
        for filename in ('restored-preview.mp4', 'comparison-preview.mp4'):
            if not (local / 'artifacts' / filename).is_file():
                raise ValueError('Review preview missing: ' + filename)
        results.append({'name': name, 'modelVariant': report['modelVariant'],
                        'frames': len(report['frames']), 'manifest': report['manifest'],
                        'inferenceSeconds': report['inferenceSeconds'], 'gpuMemory': report['gpuMemory'],
                        'objects': keys, 'verified': True})
    summary = {'command': status, 'bucket': record['bucket'], 'resultPrefix': published_prefix,
               'results': results, 'approvedForRuntime': False}
    for name in ('selection.json', 'cutscene-contact-sheet.png', 'navigation-contact-sheet.png', 'aws-submission.json', 'ssm-status.json'):
        source = directory / name
        if source.is_file():
            s3.upload_file(str(source), record['bucket'], record['resultPrefix'] + name, ExtraArgs={
                'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
                'Metadata': {'sha256': digest(source)}, 'CacheControl': 'private, no-store'})
    file = directory / ('verification-packaged-v2.json' if args.repair_mux else 'verification.json')
    file.write_text(json.dumps(summary, indent=2) + '\n')
    file.chmod(0o600)
    s3.upload_file(str(file), record['bucket'], published_prefix + 'verification.json', ExtraArgs={
        'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
        'Metadata': {'sha256': digest(file)}, 'CacheControl': 'private, no-store'})
    print(json.dumps({**status, 'verifiedClips': len(results),
                      'resultPrefix': f's3://{record["bucket"]}/{published_prefix}',
                      'inferenceSeconds': [item['inferenceSeconds'] for item in results]}, indent=2))


if __name__ == '__main__':
    main()
