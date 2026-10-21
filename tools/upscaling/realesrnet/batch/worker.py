#!/usr/bin/env python3
"""Private embedded-palette batch. All state/queues/reports remain on local EBS.

Only S3 PNG results are written remotely. No runtime-palette closure is claimed.
No credentials/config files, cloud lifecycle APIs, or model downloads are used.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import sys
import time
import warnings
import zipfile

import numpy as np
from PIL import Image

from job_contract import MAX_PACK_BYTES, MODEL_SHA256, PREPROC_SPEC, job_key, keyset_digest
from model import Processor

ROOT = Path('/opt/neverhood-upscaling/realesrnet')
SOURCE_PREFIX = 'sources/full-game/realesrnet-inputs/embedded-v1/packs/'
OUTPUT_PREFIX = 'results/neverhood-upscaling-lab/full-realesrnet-v1/images/'
HEX = re.compile(r'[0-9a-f]{64}\Z')
MEMBER = re.compile(r'([0-9a-f]{64})\.png\Z')
MASK_POLICY = 'index0-binary-nearest4x-hiddenrgb0'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic_bytes(path, data):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def decode_input(data, key, max_pixels):
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'PNG' or image.mode != 'RGBA' or getattr(image, 'n_frames', 1) != 1:
                raise ValueError('Input must be a single original RGBA PNG')
            if image.width * image.height > max_pixels:
                raise ValueError('Input exceeds --max-frame-pixels')
            image.load()
            array = np.asarray(image)
            alpha = array[:, :, 3]
            if np.any((alpha != 0) & (alpha != 255)) or np.any(array[alpha == 0, :3]):
                raise ValueError('Noncanonical input alpha/hidden RGB')
            if job_key(image.width, image.height, image.tobytes()) != key:
                raise ValueError('Input job key mismatch')
            return image.copy()


def validate_pack(data, expected_sha, max_pixels):
    if not HEX.fullmatch(expected_sha or '') or sha(data) != expected_sha:
        raise ValueError('Pack SHA256 metadata mismatch')
    if not 0 < len(data) <= MAX_PACK_BYTES:
        raise ValueError('Pack byte bound exceeded')
    members = []
    seen = set()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if not infos or sum(info.file_size for info in infos) > MAX_PACK_BYTES:
            raise ValueError('Empty or oversized expanded pack')
        for info in infos:
            match = MEMBER.fullmatch(info.filename)
            if (not match or info.is_dir() or info.filename in seen
                    or info.compress_type != zipfile.ZIP_STORED or info.flag_bits & 1
                    or info.file_size != info.compress_size
                    or ((info.external_attr >> 16) & 0o170000) not in (0, 0o100000)):
                raise ValueError('Unsafe/duplicate/non-PNG/non-STORE ZIP member')
            seen.add(info.filename)
            payload = archive.read(info)  # ZipFile verifies the member CRC, too.
            image = decode_input(payload, match[1], max_pixels)
            members.append((match[1], payload, image.width, image.height,
                            not bool(image.getchannel('A').getbbox())))
    return members


def instance_s3():
    """Explicit IMDS-only resolver; never falls back to operator credentials."""
    import boto3
    import botocore.session
    from botocore.config import Config
    from botocore.credentials import CredentialResolver, InstanceMetadataProvider
    from botocore.utils import InstanceMetadataFetcher

    session = botocore.session.Session()
    session.set_config_variable('config_file', '/dev/null')
    session.set_config_variable('credentials_file', '/dev/null')
    session.set_config_variable('profile', None)
    session.set_config_variable('region', 'us-east-2')
    provider = InstanceMetadataProvider(iam_role_fetcher=InstanceMetadataFetcher(
        timeout=3, num_attempts=3, env={'AWS_EC2_METADATA_DISABLED': 'false'},
        config={'ec2_metadata_v1_disabled': True}))
    session.register_component('credential_provider', CredentialResolver([provider]))
    credentials = session.get_credentials()
    if credentials is None or credentials.method != 'iam-role':
        raise RuntimeError('EC2 instance role credentials required')
    return boto3.Session(botocore_session=session, region_name='us-east-2').client(
        's3', region_name='us-east-2', config=Config(
            connect_timeout=10, read_timeout=30, max_pool_connections=4, proxies={},
            retries={'max_attempts': 3, 'mode': 'standard'}))


def open_db(path, binding):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS config (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
            key TEXT PRIMARY KEY, input_sha TEXT NOT NULL, width INTEGER NOT NULL,
            height INTEGER NOT NULL, transparent INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', output_sha TEXT,
            metrics TEXT, error TEXT);
    ''')
    try:
        with db:
            for name, value in binding.items():
                old = db.execute('SELECT value FROM config WHERE name=?', (name,)).fetchone()
                if old is not None and old[0] != str(value):
                    raise ValueError('Local DB corpus/config binding mismatch: ' + name)
                db.execute('INSERT OR IGNORE INTO config VALUES (?,?)', (name, str(value)))
            db.execute("UPDATE jobs SET status='pending' WHERE status='processing'")
    except Exception:
        db.close()
        raise
    return db


def ingest(s3, args, db, should_stop):
    seen = set()
    pack_count = 0
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=args.bucket, Prefix=SOURCE_PREFIX):
        for item in sorted(page.get('Contents', []), key=lambda item: item['Key']):
            if should_stop():
                raise InterruptedError('Budget/signal during input validation')
            key = item['Key']
            if not re.fullmatch(re.escape(SOURCE_PREFIX) + r'[^/]+\.zip', key):
                raise ValueError('Unexpected object in input pack prefix')
            if not 0 < item['Size'] <= MAX_PACK_BYTES:
                raise ValueError('Pack S3 size bound exceeded')
            response = s3.get_object(Bucket=args.bucket, Key=key)
            try:
                if response['ContentLength'] != item['Size']:
                    raise ValueError('Pack changed during listing')
                data = response['Body'].read(MAX_PACK_BYTES + 1)
            finally:
                response['Body'].close()
            if len(data) != item['Size']:
                raise ValueError('Truncated/oversized pack body')
            members = validate_pack(data, response.get('Metadata', {}).get('sha256'),
                                    args.max_frame_pixels)
            for key, payload, width, height, transparent in members:
                if key in seen:
                    raise ValueError('Duplicate job across packs')
                seen.add(key)
                digest = sha(payload)
                old = db.execute('SELECT * FROM jobs WHERE key=?', (key,)).fetchone()
                if old and (old['input_sha'], old['width'], old['height']) != (digest, width, height):
                    raise ValueError('Resumed input PNG changed')
                atomic_bytes(args.state_dir / 'inputs' / (key + '.png'), payload)
                with db:
                    db.execute('INSERT OR IGNORE INTO jobs(key,input_sha,width,height,transparent) '
                               'VALUES (?,?,?,?,?)', (key, digest, width, height, int(transparent)))
            pack_count += 1
    actual = {row[0] for row in db.execute('SELECT key FROM jobs')}
    if (len(seen) != args.expected_job_count or keyset_digest(seen) != args.expected_keyset_sha256
            or actual != seen):
        raise ValueError('Input count/keyset SHA256 mismatch; no inference allowed')
    return pack_count


def select_pilot(rows, count, preferred=()):
    rows = sorted(rows, key=lambda row: row['key'])
    selected = {}
    candidates = rows[:1] + [max(rows, key=lambda r: r['width'] * r['height']),
                             min(rows, key=lambda r: r['width'] * r['height'])]
    candidates += [row for row in rows if row['transparent']][:1]
    by_key = {row['key']: row for row in rows}
    if any(key not in by_key for key in preferred):
        raise ValueError('Requested pilot reference is not in the verified dataset')
    candidates += [by_key[key] for key in preferred]
    for row in candidates + rows:
        if len(selected) == min(count, len(rows)):
            break
        selected[row['key']] = row
    return list(selected.values())


def output_metadata(row, digest):
    return {'sha256': digest, 'input-jobkey': row['key'], 'input-sha256': row['input_sha'],
            'model-sha256': MODEL_SHA256, 'mask-policy': MASK_POLICY,
            'preproc-spec': PREPROC_SPEC, 'width': str(row['width'] * 4),
            'height': str(row['height'] * 4), 'scale': '4'}


def remote_output(s3, bucket, row):
    try:
        head = s3.head_object(Bucket=bucket, Key=OUTPUT_PREFIX + row['key'] + '.png')
    except Exception as error:
        code = getattr(error, 'response', {}).get('Error', {}).get('Code')
        if code in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise
    metadata = head.get('Metadata', {})
    digest = metadata.get('sha256', '')
    if (not HEX.fullmatch(digest) or metadata != output_metadata(row, digest)
            or head.get('ContentType') != 'image/png' or head.get('ContentLength', 0) <= 0
            or head.get('ServerSideEncryption') != 'AES256'
            or (row['output_sha'] and row['output_sha'] != digest)):
        raise ValueError('Existing remote output provenance mismatch: ' + row['key'])
    return digest


def validate_output(image, source):
    if image.mode != 'RGBA' or image.size != (source.width * 4, source.height * 4):
        raise ValueError('Output mode/dimension mismatch')
    array = np.asarray(image)
    expected = np.asarray(source.getchannel('A').resize(image.size, Image.Resampling.NEAREST))
    if not np.array_equal(array[:, :, 3], expected) or np.any(array[expected == 0, :3]):
        raise ValueError('Output binary mask/hidden RGB mismatch')


def upload(s3, bucket, row, path, digest):
    data = path.read_bytes()
    if sha(data) != digest:
        raise ValueError('Local output changed before upload')
    # No ACL is set: bucket-owner-enforced private bucket, never public-read.
    s3.put_object(Bucket=bucket, Key=OUTPUT_PREFIX + row['key'] + '.png', Body=data,
                  ContentType='image/png', ServerSideEncryption='AES256',
                  Metadata=output_metadata(row, digest))
    return digest


def process_rows(s3, args, db, rows, processor, pool, should_stop, budget):
    futures = []

    def finish_one():
        row, future = futures.pop(0)
        try:
            digest = future.result()
            with db:
                db.execute("UPDATE jobs SET status='done',output_sha=?,error=NULL WHERE key=?",
                           (digest, row['key']))
        except Exception as error:
            with db:
                db.execute("UPDATE jobs SET status='ready',error=? WHERE key=?",
                           (type(error).__name__, row['key']))
            raise

    try:
        for original in rows:
            if should_stop():
                break
            row = db.execute('SELECT * FROM jobs WHERE key=?', (original['key'],)).fetchone()
            digest = remote_output(s3, args.bucket, row)
            if digest:
                with db:
                    db.execute("UPDATE jobs SET status='done',output_sha=?,error=NULL WHERE key=?",
                               (digest, row['key']))
                continue
            if row['status'] == 'failed':
                raise RuntimeError('Recorded failed job requires operator review: ' + row['key'])
            if budget['attempted'] >= args.max_jobs:
                break
            source_data = (args.state_dir / 'inputs' / (row['key'] + '.png')).read_bytes()
            if sha(source_data) != row['input_sha']:
                raise ValueError('Local input SHA mismatch')
            source = decode_input(source_data, row['key'], args.max_frame_pixels)
            path = args.state_dir / 'outputs' / (row['key'] + '.png')
            digest = row['output_sha']
            reusable = False
            if path.exists() and digest and sha(path.read_bytes()) == digest:
                with Image.open(path) as image:
                    image.load()
                    validate_output(image, source)
                reusable = True
            if not reusable:
                # Reserve before inference; interrupted 'processing' is requeued on resume.
                with db:
                    db.execute("UPDATE jobs SET status='processing',output_sha=NULL WHERE key=?",
                               (row['key'],))
                budget['attempted'] += 1
                started = time.monotonic()
                try:
                    image, metrics = processor(source)
                    validate_output(image, source)
                    output = io.BytesIO()
                    image.save(output, format='PNG')
                    data = output.getvalue()
                    digest = sha(data)
                    atomic_bytes(path, data)
                    metrics['seconds'] = time.monotonic() - started
                    with db:
                        db.execute("UPDATE jobs SET status='ready',output_sha=?,metrics=?,error=NULL "
                                   'WHERE key=?', (digest, json.dumps(metrics), row['key']))
                except Exception as error:
                    with db:
                        db.execute("UPDATE jobs SET status='failed',error=? WHERE key=?",
                                   (type(error).__name__, row['key']))
                    raise  # In particular, OOM never enables tiling or reduced precision.
            while len(futures) >= 2:
                finish_one()
            futures.append((row, pool.submit(upload, s3, args.bucket, row, path, digest)))
    finally:
        # Worker threads never touch SQLite. Successful in-flight uploads are committed
        # even when a later inference fails; ready outputs remain resumable after SIGKILL.
        first_error = None
        while futures:
            try:
                finish_one()
            except Exception as error:
                first_error = first_error or error
        if first_error is not None:
            raise first_error


def run(args, s3=None, processor=None):
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('inputs', 'outputs'):
        (args.state_dir / name).mkdir(exist_ok=True, mode=0o700)
    lock = (args.state_dir / 'worker.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    started = time.monotonic()
    stop = {'requested': False}
    handlers = {}
    for signum in (signal.SIGTERM, signal.SIGINT):
        handlers[signum] = signal.signal(signum, lambda *_: stop.update(requested=True))

    def should_stop():
        return (stop['requested'] or time.monotonic() - started >= args.max_wall_seconds
                or time.time() >= args.deadline_utc.timestamp() - args.grace_seconds)

    db = None
    processor = processor or Processor(args.checkpoint)
    summary = {'status': 'failed', 'attempted': 0, 'packs': 0,
               'scope': 'embedded-palette physical animation frames only; runtime palette closure unproven'}
    budget = {'attempted': 0}
    try:
        db = open_db(args.state_dir / 'neverhood-full-v1.sqlite', {
            'bucket': args.bucket, 'source_prefix': SOURCE_PREFIX, 'output_prefix': OUTPUT_PREFIX,
            'expected_count': args.expected_job_count, 'expected_keyset': args.expected_keyset_sha256,
            'model_sha256': MODEL_SHA256, 'preproc_spec': PREPROC_SPEC, 'mask_policy': MASK_POLICY})
        if should_stop():
            raise InterruptedError('No remaining safe execution budget')
        # Always verify even if every selected frame is transparent or already uploaded.
        if sha(args.checkpoint.read_bytes()) != MODEL_SHA256:
            raise ValueError('Staged checkpoint SHA256 mismatch')
        s3 = s3 or instance_s3()
        summary['packs'] = ingest(s3, args, db, should_stop)
        rows = list(db.execute('SELECT * FROM jobs ORDER BY key'))
        largest = max(rows, key=lambda row: row['width'] * row['height'])
        summary['largest_source_frame'] = [largest['width'], largest['height']]
        summary['max_source_width'] = max(row['width'] for row in rows)
        summary['max_source_height'] = max(row['height'] for row in rows)
        pilot = select_pilot(rows, args.pilot_count, getattr(args, 'pilot_key', ()))
        summary['pilot_keys'] = [row['key'] for row in pilot]
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix='png-upload') as pool:
            process_rows(s3, args, db, pilot, processor, pool, should_stop, budget)
            pilot_ok = all(db.execute('SELECT status FROM jobs WHERE key=?', (row['key'],)).fetchone()[0]
                           == 'done' for row in pilot)
            summary['pilot_passed'] = pilot_ok
            if pilot_ok and not args.pilot_only and not should_stop():
                selected = {row['key'] for row in pilot}
                process_rows(s3, args, db, [row for row in rows if row['key'] not in selected],
                             processor, pool, should_stop, budget)
        remaining = db.execute("SELECT count(*) FROM jobs WHERE status!='done'").fetchone()[0]
        summary['status'] = ('pilot-complete' if args.pilot_only and pilot_ok else
                             'complete' if not remaining else 'checkpointed')
    except InterruptedError:
        summary['status'] = 'checkpointed'
    except Exception as error:
        # No exception text/URLs/credentials are emitted to stdout or remote services.
        summary['error_type'] = type(error).__name__
    finally:
        processor.close()
        summary.update(attempted=budget['attempted'], elapsed_seconds=time.monotonic() - started)
        if db is not None:
            summary['counts'] = dict(db.execute('SELECT status,count(*) FROM jobs GROUP BY status'))
            metrics = [json.loads(row[0]) for row in db.execute('SELECT metrics FROM jobs WHERE metrics IS NOT NULL')]
            summary['peak_allocated_bytes'] = max((m['peak_allocated_bytes'] for m in metrics), default=0)
            summary['peak_reserved_bytes'] = max((m['peak_reserved_bytes'] for m in metrics), default=0)
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            db.close()
        atomic_bytes(args.state_dir / 'summary.json', (json.dumps(summary, sort_keys=True) + '\n').encode())
        print(json.dumps(summary, sort_keys=True), flush=True)
        for signum, handler in handlers.items():
            signal.signal(signum, handler)
        lock.close()
    return 0 if summary['status'] in ('complete', 'pilot-complete') else 3 if summary['status'] == 'checkpointed' else 1


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--checkpoint', type=Path, required=True, help='Already staged local .pth; no model download')
    parser.add_argument('--expected-job-count', type=int, required=True)
    parser.add_argument('--expected-keyset-sha256', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--pilot-only', action='store_true')
    mode.add_argument('--full', action='store_true')
    parser.add_argument('--pilot-count', type=int, default=12, help='At least 4; first key, largest, smallest, transparent if present, then first N')
    parser.add_argument('--pilot-key', action='append', default=[], help='Explicit verified dataset job to include among representative pilot frames')
    parser.add_argument('--max-jobs', type=int, default=100000, help='Maximum new inference attempts this invocation, including pilot')
    parser.add_argument('--max-frame-pixels', type=int, required=True, help='Operator-approved source frame pixel bound')
    parser.add_argument('--deadline-utc', required=True, help='Known auto-stop deadline, ISO8601 UTC with Z')
    parser.add_argument('--grace-seconds', type=int, default=180)
    parser.add_argument('--max-wall-seconds', type=int, default=13800)
    parser.add_argument('--state-dir', type=Path, default=ROOT / 'state')
    args = parser.parse_args(argv)
    try:
        if not args.deadline_utc.endswith('Z'):
            raise ValueError('UTC Z required')
        args.deadline_utc = datetime.fromisoformat(args.deadline_utc[:-1] + '+00:00')
    except ValueError:
        parser.error('--deadline-utc must be ISO8601 UTC ending Z')
    if (any(not HEX.fullmatch(key) for key in args.pilot_key) or len(args.pilot_key) > args.pilot_count - 3
            or not HEX.fullmatch(args.expected_keyset_sha256) or args.expected_job_count < 1
            or args.pilot_count < 4 or args.max_jobs < 1 or args.max_frame_pixels < 1
            or args.max_wall_seconds < 1 or args.grace_seconds < 30
            or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', args.bucket)):
        parser.error('Invalid bounds, digest, count, or bucket')
    return args


if __name__ == '__main__':
    sys.exit(run(parse_args()))
