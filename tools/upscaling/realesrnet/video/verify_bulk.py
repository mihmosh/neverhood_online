"""Operator-only technical verification of a completed private 7B corpus.

Only JSON commit records are downloaded. Media integrity relies on native S3
checksums and worker-recorded full SHA256s, not a second full-movie download.
"""
import argparse
import base64
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re

from aws_trials import digest, operator_session
import bulk

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
EXPECTED_VIDEOS = 550
EXPECTED_FRAMES = 55270


def require(condition, message):
    if not condition:
        raise ValueError(message)


def valid_sha(value):
    require(isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value),
            'Invalid SHA256')
    return value


class Store:
    """Small boto3 adapter; all object keys are relative to one exact run prefix."""
    def __init__(self, s3, bucket, prefix):
        self.s3, self.bucket, self.prefix = s3, bucket, prefix

    def head(self, key, sha, size=None, full_only=False):
        valid_sha(sha)
        head = self.s3.head_object(Bucket=self.bucket, Key=self.prefix + key,
                                   ChecksumMode='ENABLED')
        checksum_type = head.get('ChecksumType', 'FULL_OBJECT')
        checksum = head.get('ChecksumSHA256')
        native = (checksum == base64.b64encode(bytes.fromhex(sha)).decode()
                  if checksum_type == 'FULL_OBJECT' else
                  checksum_type == 'COMPOSITE' and isinstance(checksum, str) and bool(checksum))
        require(head.get('Metadata', {}).get('sha256') == sha and native
                and head.get('ServerSideEncryption') == 'AES256'
                and type(head.get('ContentLength')) is int and head['ContentLength'] > 0
                and (size is None or head['ContentLength'] == size)
                and (not full_only or (checksum_type == 'FULL_OBJECT'
                                       and head['ContentLength'] < bulk.SINGLE_PART_LIMIT)),
                'S3 checksum/metadata/encryption/size mismatch: ' + key)
        return head

    def get_json(self, key):
        response = self.s3.get_object(Bucket=self.bucket, Key=self.prefix + key,
                                      ChecksumMode='ENABLED')
        body = response['Body']
        try:
            data = body.read()
        finally:
            body.close()
        sha = hashlib.sha256(data).hexdigest()
        require(response.get('Metadata', {}).get('sha256') == sha
                and response.get('ServerSideEncryption') == 'AES256'
                and response.get('ChecksumType', 'FULL_OBJECT') == 'FULL_OBJECT'
                and response.get('ChecksumSHA256') == base64.b64encode(bytes.fromhex(sha)).decode()
                and response.get('ContentLength') == len(data),
                'Downloaded JSON checksum/metadata mismatch: ' + key)
        self.head(key, sha, len(data), full_only=True)
        return json.loads(data), sha

    def put(self, path, key):
        sha = digest(path)
        self.s3.upload_file(str(path), self.bucket, self.prefix + key, ExtraArgs={
            'ServerSideEncryption': 'AES256', 'ChecksumAlgorithm': 'SHA256',
            'ChecksumSHA256': base64.b64encode(bytes.fromhex(sha)).decode(),
            'Metadata': {'sha256': sha}, 'CacheControl': 'private, no-store',
            'ContentType': 'application/json'})
        self.head(key, sha, path.stat().st_size, full_only=True)


def validate_plan(plan, sha):
    valid_sha(sha)
    require(plan['version'] == 1 and plan['private'] is True and plan['modelVariant'] == '7b'
            and plan['chunkCoreFrames'] == 49 and plan['contextFrames'] == 4
            and plan['scale'] == 4
            and re.fullmatch(r'movie-7b-full-[A-Za-z0-9-]+', plan['runId']),
            'Invalid private full-corpus 7B plan')
    videos = plan['videos']
    require(len(videos) == EXPECTED_VIDEOS and plan['uniqueVideos'] == EXPECTED_VIDEOS
            and plan['totalDecodedFrames'] == EXPECTED_FRAMES
            and sum(v['frames'] for v in videos) == EXPECTED_FRAMES,
            'Expected exactly 550 videos and 55270 frames')
    require(len({v['id'] for v in videos}) == len(videos), 'Duplicate plan identities')
    for video in videos:
        require(video['id'] == valid_sha(video['sourceSHA256']), 'Source identity mismatch')
        require(all(type(video[k]) is int and video[k] > 0
                    for k in ('width', 'height', 'frames', 'sourceBytes')),
                'Invalid source geometry/count')
        require(0 < Fraction(video['fps']) <= 120, 'Invalid source frame rate')
        bulk.plan_chunks(video['frames'])


def binding(record, plan_sha, video):
    bulk.binding(record, plan_sha, video)
    require(record.get('private') is True and record.get('version') == 1,
            'Not a private versioned commit')
    source = record.get('source', {})
    require(all(k in source and source[k] == value for k, value in video.items()),
            'Original source metadata/flags/aliases differ from plan')
    probe = bulk.pilot.probe  # Isolated run.py import configures 7B, without loading a GPU.
    pinned = {'modelVariant': '7b', 'runnerRevision': probe.REVISION,
              'modelPrecision': probe.MODEL_PRECISION, 'ditModel': probe.DIT,
              'blocksToSwap': probe.BLOCKS_TO_SWAP, 'models': probe.MODEL_HASHES}
    require(all(record.get(k) == value for k, value in pinned.items()),
            'Pinned 7B model/configuration mismatch')


def verify(plan, sha, store):
    """Fail closed; return a technical-only summary, never runtime approval.

    Store implements get_json(key) -> (decoded JSON, verified content SHA256)
    and head(key, sha, size=None, full_only=False). No media GET is required.
    """
    validate_plan(plan, sha)
    coverage, coverage_sha = store.get_json('coverage.json')
    require(coverage.get('private') is True and coverage.get('version') == 1
            and coverage.get('planSHA256') == sha and coverage.get('status') == 'complete'
            and coverage.get('failures') == [] and not coverage.get('abortReason'),
            'Coverage is not a complete failure-free plan commit')
    for key, value in (('expectedVideos', EXPECTED_VIDEOS), ('completedVideos', EXPECTED_VIDEOS),
                       ('expectedFrames', EXPECTED_FRAMES), ('completedFrames', EXPECTED_FRAMES)):
        require(type(coverage.get(key)) is int and coverage[key] == value,
                'Coverage total mismatch: ' + key)
    entries = coverage['entries']
    expected = {v['id']: v['frames'] for v in plan['videos']}
    require(len(entries) == len(expected) and len({e['id'] for e in entries}) == len(expected)
            and {e['id']: e['frames'] for e in entries} == expected
            and all(e['status'] == 'complete' and type(e['frames']) is int for e in entries),
            'Coverage entries do not exactly match the plan')
    results = []
    for video in plan['videos']:
        prefix = video['id'] + '/'
        manifest, manifest_sha = store.get_json(prefix + 'manifest.json')
        binding(manifest, sha, video)
        require(manifest['frames'] == video['frames'] and manifest['fps'] == video['fps'],
                'Manifest source frame count/FPS mismatch')
        chunks = bulk.plan_chunks(video['frames'])
        require([r['chunk'] for r in manifest['chunks']] == chunks,
                'Manifest chunk core ordinals do not match plan_chunks')
        require(manifest.get('allAudioPCMEqual') is True, 'Audio PCM equality not verified')
        audio = manifest['audioPCM']
        require(len(audio) == len(video['audio']), 'Audio track count mismatch')
        for actual, original in zip(audio, video['audio']):
            valid_sha(actual['sha256'])
            require(type(actual['channels']) is int and type(actual['sampleRate']) is int
                    and actual['channels'] == int(original['channels'])
                    and actual['sampleRate'] == int(original['sample_rate'])
                    and actual['channels'] > 0 and actual['sampleRate'] > 0,
                    'Audio channels/sample rate mismatch')
        if audio:
            valid_sha(manifest['sidecarSHA256'])
        else:
            require(manifest['sidecarSHA256'] is None, 'Unexpected audio sidecar')
        objects = []
        for name in ('master', 'preview'):
            movie_sha = valid_sha(manifest[name + 'SHA256'])
            head = store.head(prefix + name + '.mp4', movie_sha)
            objects.append({'key': prefix + name + '.mp4', 'sha256': movie_sha,
                            'bytes': head['ContentLength'],
                            'checksumType': head.get('ChecksumType', 'FULL_OBJECT')})
        commits = []
        for chunk, embedded in zip(chunks, manifest['chunks']):
            key = prefix + 'chunks/' + chunk['id'] + '/'
            report, report_sha = store.get_json(key + 'report.json')
            require(report == embedded, 'Manifest/chunk commit content mismatch')
            binding(report, sha, video)
            require(report['chunk'] == chunk, 'Chunk ordinal mismatch')
            mapping = report['sourceFrameMap']
            require(len(mapping) == chunk['coreFrames'], 'Frame coverage count mismatch')
            for index, frame in enumerate(mapping):
                require(type(frame['sourceFrame']) is int and type(frame['outputFrame']) is int
                        and frame['sourceFrame'] == chunk['coreStart'] + index
                        and frame['outputFrame'] == index,
                        'Frame coverage gap/overlap/ordinal mismatch')
                valid_sha(frame['pngSHA256'])
            master_sha = valid_sha(report['masterSHA256'])
            require(type(report['masterBytes']) is int and report['masterBytes'] > 0,
                    'Invalid chunk master size')
            store.head(key + 'master.mp4', master_sha, report['masterBytes'], full_only=True)
            commits.append({'id': chunk['id'], 'reportSHA256': report_sha,
                            'masterSHA256': master_sha, 'frames': chunk['coreFrames']})
        results.append({'id': video['id'], 'frames': video['frames'],
                        'manifestSHA256': manifest_sha, 'chunks': commits, 'objects': objects})
    return {'version': 1, 'private': True, 'status': 'verified', 'planSHA256': sha,
            'runId': plan['runId'], 'coverageSHA256': coverage_sha,
            'verifiedVideos': len(results), 'verifiedFrames': sum(v['frames'] for v in results),
            'results': results, 'approvedForRuntime': False, 'technicalOnly': True,
            'mediaVerification': 'S3 native checksums plus worker full-stream SHA256 commits; no media downloaded',
            'verifiedAt': datetime.now(timezone.utc).isoformat()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    directory = args.directory.resolve(strict=True)
    require(directory.is_relative_to(REPO / 'private-research'), 'Private run directory required')
    plan_path = directory / 'plan.json'
    plan, sha = json.loads(plan_path.read_text()), digest(plan_path)
    validate_plan(plan, sha)
    require(plan['runId'] == directory.name, 'Run directory/plan identity mismatch')
    receipt = json.loads((directory / 'staging-receipt.json').read_text())
    state_root = REPO / 'private-assets/upscaling/aws'
    state = json.loads((state_root / 'stack-state.json').read_text())
    intent = json.loads((state_root / 'create-intent.json').read_text())
    bucket = state['outputs']['BucketName']
    require(state['stack'] == 'neverhood-upscaling-lab', 'Unexpected private stack')
    prefix = 'results/neverhood-upscaling-lab/' + plan['runId'] + '/'
    expected = {v['sourceKey']: (v['sourceSHA256'], v['sourceBytes']) for v in plan['videos']}
    expected[f'sources/probes/{plan["runId"]}/plan-{sha}.json'] = (sha, plan_path.stat().st_size)
    require(receipt['planSHA256'] == sha and receipt['bucket'] == bucket
            and len(receipt['objects']) == len(expected)
            and {o['key']: (o['sha256'], o['bytes']) for o in receipt['objects']} == expected,
            'Staging receipt does not bind the complete private plan')
    session = operator_session(args.profile, state['region'], intent['account'])
    store = Store(session.client('s3'), bucket, prefix)
    summary = verify(plan, sha, store)
    summary.update(bucket=bucket, resultPrefix=prefix)
    path = directory / 'verification.json'
    require(not path.is_symlink(), 'Refusing symlinked verification output')
    with path.open('w') as stream:
        path.chmod(0o600)
        json.dump(summary, stream, indent=2)
        stream.write('\n')
    store.put(path, 'verification.json')
    print(json.dumps({k: summary[k] for k in ('verifiedVideos', 'verifiedFrames', 'resultPrefix',
                                             'approvedForRuntime', 'technicalOnly')}))


if __name__ == '__main__':
    main()
