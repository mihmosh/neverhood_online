#!/usr/bin/env python3
"""Private, resumable full-corpus VM worker. Never manages cloud resources."""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
from fractions import Fraction
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading


def sibling(name):
    spec = importlib.util.spec_from_file_location('bulk_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare, pilot = sibling('prepare'), sibling('run')
sha256 = pilot.probe.sha256
PREFIX = 'results/neverhood-upscaling-lab/movie-7b-full-20261021/'
MIN_FREE = 10 * 1024 ** 3
SINGLE_PART_LIMIT = 5 * 1024 ** 3


def command(args, timeout=300, log=None):
    if log:
        with log.open('x') as output:
            subprocess.run(args, check=True, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        return ''
    return subprocess.check_output(args, stderr=subprocess.PIPE, text=True, timeout=timeout).strip()


def save(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as stream:
        json.dump(data, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def owned_directory(path):
    if path.is_symlink():
        raise ValueError('Refusing symlinked worker directory')
    path.mkdir(exist_ok=True, mode=0o700)


def plan_chunks(frames, core=49, context=4):
    if type(frames) is not int or frames < 1 or core != 49 or context != 4:
        raise ValueError('Expected positive decoded count and 49/4 chunk protocol')
    return [{'id': f'{start:06d}', 'coreStart': start, 'coreFrames': min(core, frames - start),
             'inputStart': max(0, start - context),
             'inputFrames': min(frames, start + core + context) - max(0, start - context),
             'leftContext': min(context, start)} for start in range(0, frames, core)]


def load_plan(path, expected):
    if not re.fullmatch('[0-9a-f]{64}', expected) or sha256(path) != expected:
        raise ValueError('Plan SHA256 mismatch')
    plan = json.loads(path.read_text())
    if (plan['version'] != 1 or plan['private'] is not True or plan['modelVariant'] != '7b'
            or plan['chunkCoreFrames'] != 49 or plan['contextFrames'] != 4
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', plan['runId'])):
        raise ValueError('Invalid private 7B plan')
    seen = set()
    for video in plan['videos']:
        digest = video['sourceSHA256']
        if (not re.fullmatch('[0-9a-f]{64}', digest) or video['id'] != digest or digest in seen
                or not video['sourceKey'].startswith('sources/probes/')
                or not video['sourceKey'].endswith('/originals/' + digest + '.smk')
                or '..' in video['sourceKey'].split('/')
                or any(type(video[key]) is not int or video[key] < 1
                       for key in ('frames', 'width', 'height', 'sourceBytes'))
                or not 0 < Fraction(video['fps']) <= 120):
            raise ValueError('Invalid or duplicate source record')
        for key in ('resourceIds', 'requestedHash', 'ringFrame', 'sourceFlags'):
            video[key]
        seen.add(digest)
        plan_chunks(video['frames'])
    if not seen:
        raise ValueError('Empty source catalog')
    return plan


def validate_movie(path, video, scale=1, frames=None):
    streams = prepare.probe(path)  # Full decoded count, not container nb_frames.
    stream, width, height, count, fps = prepare.video_info(streams)
    if (width, height, count, fps) != (video['width'] * scale, video['height'] * scale,
                                       frames or video['frames'], Fraction(video['fps'])):
        raise ValueError('Decoded geometry, count or FPS differs from plan')
    prepare.verify_timeline(path, stream, width, height, count, fps)
    if scale != 1:
        tick = Fraction(stream['time_base'])
        decoded = json.loads(command(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                      '-show_frames', '-show_entries', 'frame=best_effort_timestamp',
                                      '-of', 'json', str(path)]))['frames']
        if tick != Fraction(1, fps.numerator) or any(
                int(frame['best_effort_timestamp']) * tick != Fraction(index, 1) / fps
                for index, frame in enumerate(decoded)):
            raise ValueError('Output must retain exact rational frame ticks')
    command(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-map', '0:v:0', '-f', 'null', '-'])
    return streams


class Store:
    """Checksummed uploads, including full streamed verification of multipart data."""
    def __init__(self, bucket, prefix):
        self.bucket, self.prefix = bucket, prefix

    def head(self, key, optional=False):
        try:
            return json.loads(command(['aws', 's3api', 'head-object', '--bucket', self.bucket,
                                      '--key', self.prefix + key, '--checksum-mode', 'ENABLED']))
        except subprocess.CalledProcessError as error:
            message = error.stderr or ''
            if optional and ('(404)' in message or '(NoSuchKey)' in message):
                return None
            raise

    def verify(self, key, digest, size=None):
        head = self.head(key)
        checksum = base64.b64encode(bytes.fromhex(digest)).decode()
        checksum_type = head.get('ChecksumType', 'FULL_OBJECT')
        checksum_valid = (bool(head.get('ChecksumSHA256')) if checksum_type == 'COMPOSITE'
                          else checksum_type == 'FULL_OBJECT' and head.get('ChecksumSHA256') == checksum)
        if (head.get('Metadata', {}).get('sha256') != digest
                or not checksum_valid
                or head.get('ServerSideEncryption') != 'AES256'
                or (size is not None and head['ContentLength'] != size)):
            raise ValueError('S3 object checksum/metadata mismatch: ' + key)
        return head

    def streamed_hash(self, key):
        digest = hashlib.sha256()
        args = ['aws', 's3', 'cp', 's3://' + self.bucket + '/' + self.prefix + key,
                '-', '--only-show-errors']
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
            # A blocked stdout read must not keep the VM worker alive indefinitely.
            timer = threading.Timer(900, process.kill)
            timer.daemon = True
            timer.start()
            try:
                for block in iter(lambda: process.stdout.read(4 * 1024 * 1024), b''):
                    digest.update(block)
                if process.wait():
                    raise subprocess.CalledProcessError(process.returncode, args)
            except BaseException:
                process.kill()
                raise
            finally:
                timer.cancel()
        return digest.hexdigest()

    def put(self, path, key):
        digest = sha256(path)
        size = path.stat().st_size
        multipart = size >= SINGLE_PART_LIMIT
        if multipart:
            command(['aws', 's3', 'cp', str(path), 's3://' + self.bucket + '/' + self.prefix + key,
                     '--sse', 'AES256', '--metadata', 'sha256=' + digest,
                     '--checksum-algorithm', 'SHA256', '--only-show-errors'], timeout=900)
        else:
            command(['aws', 's3api', 'put-object', '--bucket', self.bucket, '--key', self.prefix + key,
                     '--body', str(path), '--server-side-encryption', 'AES256',
                     '--metadata', 'sha256=' + digest, '--checksum-algorithm', 'SHA256',
                     '--checksum-sha256', base64.b64encode(bytes.fromhex(digest)).decode()], timeout=900)
        head = self.verify(key, digest, size)
        if not multipart and head.get('ChecksumType', 'FULL_OBJECT') != 'FULL_OBJECT':
            raise ValueError('Single-part native SHA256 must be full-object: ' + key)
        if multipart and (head.get('ChecksumType') != 'COMPOSITE' or self.streamed_hash(key) != digest):
            raise ValueError('Multipart full readback SHA256 mismatch: ' + key)

    def get(self, key, path, digest):
        self.verify(key, digest)
        if not path.exists() or sha256(path) != digest:
            temporary = path.with_suffix(path.suffix + '.download')
            command(['aws', 's3', 'cp', 's3://' + self.bucket + '/' + self.prefix + key,
                     str(temporary), '--only-show-errors'], timeout=900)
            if sha256(temporary) != digest:
                raise ValueError('Downloaded object hash mismatch')
            temporary.replace(path)

    def report(self, key, path):
        head = self.head(key, optional=True)
        if head is None:
            return None
        self.get(key, path, head.get('Metadata', {}).get('sha256', ''))
        return json.loads(path.read_text())

    def source(self, video, path):
        if not path.exists() or sha256(path) != video['sourceSHA256']:
            temporary = path.with_suffix('.download')
            command(['aws', 's3', 'cp', 's3://' + self.bucket + '/' + video['sourceKey'],
                     str(temporary), '--only-show-errors'], timeout=900)
            if sha256(temporary) != video['sourceSHA256']:
                raise ValueError('Original source SHA256 mismatch')
            temporary.replace(path)
        if path.stat().st_size != video['sourceBytes']:
            raise ValueError('Original source byte count mismatch')


def binding(report, plan_sha, video):
    if (report.get('planSHA256') != plan_sha or report.get('sourceSHA256') != video['sourceSHA256']
            or report.get('status') != 'complete'):
        raise ValueError('Checkpoint plan/source/status mismatch')


def disk_guard(path, required=None):
    required = max(MIN_FREE, required or 0)
    if shutil.disk_usage(path).free < required:
        raise RuntimeError(f'Need {required} free bytes including the 10 GiB base reserve')


class DeadlineReached(RuntimeError):
    pass


def deadline_guard(deadline):
    if (deadline - datetime.now(timezone.utc)).total_seconds() <= 1200:
        raise DeadlineReached('Deadline safety window: no fresh chunk')


def infer(root, directory, scratch, data):
    os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1',
                      CUDA_VISIBLE_DEVICES='0', PYTHONUNBUFFERED='1')
    command(pilot.inference_command(root, directory, scratch, data),
            timeout=930, log=scratch / 'inference.log')


def chunk_worker(video, chunk, source, movie_dir, store, plan_sha, root, deadline, inference=infer):
    directory = movie_dir / ('chunk-' + chunk['id'])
    owned_directory(directory)
    key = video['id'] + '/chunks/' + chunk['id'] + '/'
    report_path, master = directory / 'report.json', directory / 'master.mp4'
    report = store.report(key + 'report.json', directory / 'remote.json')
    if report is not None:
        binding(report, plan_sha, video)
        if report['chunk'] != chunk:
            raise ValueError('Chunk ordinal checkpoint mismatch')
        store.verify(key + 'master.mp4', report['masterSHA256'], report['masterBytes'])
        return report
    if report_path.exists():
        report = json.loads(report_path.read_text())
        binding(report, plan_sha, video)
        if report['chunk'] != chunk or sha256(master) != report['masterSHA256']:
            raise ValueError('Local chunk checkpoint mismatch')
        validate_movie(master, video, 4, chunk['coreFrames'])
    else:
        scratch = directory / 'scratch'
        owned_directory(scratch)
        attempt = scratch / 'attempt.json'
        data_path = scratch / 'prepared/manifest.json'
        identity = {'planSHA256': plan_sha, 'sourceSHA256': video['sourceSHA256'], 'chunk': chunk}
        if attempt.exists():
            previous = json.loads(attempt.read_text())
            if any(previous.get(key) != value for key, value in identity.items()):
                raise ValueError('Inference attempt binding mismatch')
            # Older attempt markers predate this state flag and remain possibly paid.
            started = previous.get('inferenceStarted', True)
            if type(started) is not bool:
                raise ValueError('Invalid inference attempt state')
        else:
            started = False
            save(attempt, {**identity, 'inferenceStarted': False})
        if data_path.exists():
            data = json.loads(data_path.read_text())
            if sha256(scratch / 'prepared/input.mp4') != data['input']['sha256']:
                raise ValueError('Prepared input checkpoint hash mismatch')
        else:
            if started:
                raise RuntimeError('Interrupted preparation; explicit operator recovery required')
            deadline_guard(deadline)
            disk_guard(movie_dir)
            if (scratch / 'prepared').exists():
                if (scratch / 'prepared').is_symlink():
                    raise ValueError('Refusing symlinked preparation directory')
                shutil.rmtree(scratch / 'prepared')  # No inference has started for this attempt.
            # The audited 448x240 originals need 1792x960, without cropping.
            bounds = ({'max_target_pixels': 1792 * 960}
                      if video['width'] * video['height'] * 16 > 1536 * 1024 else {})
            data = prepare.prepare(source, scratch / 'prepared', 'cutscene', chunk['inputStart'],
                                   chunk['inputFrames'], private_root=movie_dir, preserve_audio=False, **bounds)
        if not started:
            # Preparation can be slow; check again immediately before paying for inference.
            deadline_guard(deadline)
            disk_guard(movie_dir)
            owned_directory(scratch / 'artifacts')
            save(attempt, {**identity, 'inferenceStarted': True})
            inference(root, scratch / 'prepared', scratch, data)
        # Never repeat a possibly paid inference. Complete PNGs may still be recovered.
        records = pilot.inspect_frames(scratch, data)
        left, count = chunk['leftContext'], chunk['coreFrames']
        if master.exists():
            master.unlink()  # Only this worker's uncommitted packaging output.
        command(['ffmpeg', '-v', 'error', '-xerror', '-n', '-framerate', video['fps'],
                 '-start_number', str(left), '-i', str(scratch / 'artifacts/frames/input/input_%06d.png'),
                 '-frames:v', str(count), '-an', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p',
                 '-video_track_timescale', str(Fraction(video['fps']).numerator), str(master)])
        validate_movie(master, video, 4, count)
        report = {'version': 1, 'private': True, 'status': 'complete', 'planSHA256': plan_sha,
                  'sourceSHA256': video['sourceSHA256'], 'classification': 'corpus-unclassified',
                  'source': video,
                  'chunk': chunk, 'modelVariant': '7b', 'runnerRevision': pilot.probe.REVISION,
                  'modelPrecision': pilot.probe.MODEL_PRECISION, 'ditModel': pilot.probe.DIT,
                  'blocksToSwap': pilot.probe.BLOCKS_TO_SWAP,
                  'models': pilot.probe.MODEL_HASHES, 'masterSHA256': sha256(master),
                  'masterBytes': master.stat().st_size,
                  'sourceFrameMap': [{'sourceFrame': chunk['coreStart'] + i,
                                      'outputFrame': i, 'pngSHA256': records[left + i]['sha256']}
                                     for i in range(count)]}
        save(report_path, report)
    store.put(master, key + 'master.mp4')
    store.put(report_path, key + 'report.json')  # Commit marker, always last.
    if (directory / 'scratch').exists():
        shutil.rmtree(directory / 'scratch')
    return report


def pcm_hashes(path):
    tracks = [s for s in prepare.probe(path) if s.get('codec_type') == 'audio']
    return [{'channels': int(track['channels']), 'sampleRate': int(track['sample_rate']),
             'sha256': command(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path),
                                '-map', f"0:{track['index']}", '-c:a', 'pcm_s32le',
                                '-f', 'hash', '-hash', 'sha256', '-']).split('=')[-1]}
            for track in tracks]


def assemble_movie(video, reports, source, directory, store, plan_sha):
    if [report['chunk'] for report in reports] != plan_chunks(video['frames']):
        raise ValueError('Movie chunks do not cover original source exactly')
    disk_guard(directory, 3 * sum(report['masterBytes'] for report in reports) + MIN_FREE)
    assembly = directory / 'assembly'
    owned_directory(assembly)
    chunks = []
    for report in reports:
        binding(report, plan_sha, video)
        chunk_id = report['chunk']['id']
        local = assembly / (chunk_id + '.mp4')
        cached = directory / ('chunk-' + chunk_id) / 'master.mp4'
        key = video['id'] + '/chunks/' + chunk_id + '/master.mp4'
        if (cached.is_file() and not cached.is_symlink()
                and cached.stat().st_size == report['masterBytes'] and sha256(cached) == report['masterSHA256']):
            store.verify(key, report['masterSHA256'], report['masterBytes'])
            local.unlink(missing_ok=True)
            os.link(cached, local)  # Safe concat names, without duplicating cached video bytes.
        else:
            store.get(key, local, report['masterSHA256'])
        chunks.append(local)
    listing = assembly / 'concat.txt'
    listing.write_text(''.join("file '" + path.name + "'\n" for path in chunks))
    audio = pcm_hashes(source)
    audio_path = assembly / 'audio.mka'
    for name in ('master.mp4', 'preview.mp4', 'audio.mka'):
        (assembly / name).unlink(missing_ok=True)
    sidecar = None
    if audio:
        command(['ffmpeg', '-v', 'error', '-xerror', '-n', '-i', str(source), '-map', '0:a',
                 '-vn', '-c:a', 'flac', str(audio_path)])
        if pcm_hashes(audio_path) != audio:
            raise ValueError('Full-length FLAC sidecar PCM differs from original')
        sidecar = sha256(audio_path)
    master, preview = assembly / 'master.mp4', assembly / 'preview.mp4'
    args = ['ffmpeg', '-v', 'error', '-xerror', '-n', '-f', 'concat', '-safe', '1', '-i', str(listing)]
    if audio:
        args += ['-i', str(audio_path)]
    args += ['-map', '0:v:0']
    if audio:
        args += ['-map', '1:a', '-c:a', 'copy']
    args += ['-c:v', 'copy', '-strict', '-2', '-video_track_timescale',
             str(Fraction(video['fps']).numerator), '-movflags', '+faststart', str(master)]
    command(args, timeout=900)
    validate_movie(master, video, 4)
    if pcm_hashes(master) != audio:
        raise ValueError('Master audio PCM differs from original')
    command(['ffmpeg', '-v', 'error', '-xerror', '-n', '-i', str(master), '-map', '0:v:0',
             '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
             '-c:a', 'aac', '-video_track_timescale', str(Fraction(video['fps']).numerator),
             '-movflags', '+faststart', str(preview)], timeout=900)
    validate_movie(preview, video, 4)
    manifest = {'version': 1, 'private': True, 'status': 'complete', 'planSHA256': plan_sha,
                'sourceSHA256': video['sourceSHA256'], 'source': video,
                'classification': 'corpus-unclassified', 'modelVariant': '7b',
                'modelPrecision': pilot.probe.MODEL_PRECISION, 'ditModel': pilot.probe.DIT,
                'blocksToSwap': pilot.probe.BLOCKS_TO_SWAP,
                'runnerRevision': pilot.probe.REVISION, 'models': pilot.probe.MODEL_HASHES,
                'chunks': reports, 'audioPCM': audio, 'sidecarSHA256': sidecar,
                'allAudioPCMEqual': True, 'masterSHA256': sha256(master),
                'previewSHA256': sha256(preview), 'frames': video['frames'], 'fps': video['fps']}
    save(assembly / 'manifest.json', manifest)
    for name in ('master.mp4', 'preview.mp4', 'manifest.json'):
        store.put(assembly / name, video['id'] + '/' + name)
    shutil.rmtree(assembly)
    return manifest


def worker(plan, plan_sha, store, workdir, root, deadline, inference=infer):
    entries, failures = [], []
    stopped = False
    consecutive_failures, abort_reason, cloud_failed = 0, None, False
    for video in plan['videos']:
        directory = workdir / video['id']
        owned_directory(directory)
        entry = {'id': video['id'], 'frames': video['frames'], 'status': 'pending'}
        entries.append(entry)
        try:
            existing = store.report(video['id'] + '/manifest.json', directory / 'remote-manifest.json')
            if existing is not None:
                binding(existing, plan_sha, video)
                for name in ('master', 'preview'):
                    store.verify(video['id'] + '/' + name + '.mp4', existing[name + 'SHA256'])
            else:
                deadline_guard(deadline)
                disk_guard(workdir)
                source = directory / 'original.smk'
                store.source(video, source)
                validate_movie(source, video)
                reports = []
                for chunk in plan_chunks(video['frames']):
                    reports.append(chunk_worker(video, chunk, source, directory, store,
                                                plan_sha, root, deadline, inference))
                    checkpoint = {'planSHA256': plan_sha, 'sourceSHA256': video['sourceSHA256'],
                                  'status': 'running', 'completedChunks': len(reports),
                                  'entries': entries, 'failures': failures}
                    save(workdir / 'progress.json', checkpoint)
                    store.put(workdir / 'progress.json', 'progress.json')
                assemble_movie(video, reports, source, directory, store, plan_sha)
                # These are exclusively worker-owned downloaded copies/committed chunks.
                source.unlink()
                for chunk in plan_chunks(video['frames']):
                    shutil.rmtree(directory / ('chunk-' + chunk['id']))
            entry['status'] = 'complete'
            consecutive_failures = 0
        except DeadlineReached:
            entry['status'], stopped = 'deadline', True
        except Exception as error:
            entry['status'] = 'failed'
            failures.append({'id': video['id'], 'error': pilot.probe.sanitize(str(error))})
            consecutive_failures += 1
            cmd = getattr(error, 'cmd', None)
            cloud_failed = (isinstance(error, subprocess.SubprocessError)
                            and isinstance(cmd, (list, tuple)) and bool(cmd) and Path(cmd[0]).name == 'aws')
            if cloud_failed:
                abort_reason = 'AWS command failed; refusing more paid inference'
            elif consecutive_failures >= 2:
                abort_reason = 'Two consecutive source failures; operator review required'
        progress = {'planSHA256': plan_sha,
                    'status': 'aborted' if abort_reason else 'stopped' if stopped else 'running',
                    'abortReason': abort_reason,
                    'entries': entries, 'failures': failures}
        save(workdir / 'progress.json', progress)
        if not cloud_failed:
            try:
                store.put(workdir / 'progress.json', 'progress.json')
            except Exception as error:
                cloud_failed = True
                abort_reason = 'Progress upload failed: ' + pilot.probe.sanitize(str(error))
                progress.update(status='aborted', abortReason=abort_reason)
                save(workdir / 'progress.json', progress)
        if stopped or abort_reason:
            break
    present = {entry['id'] for entry in entries}
    entries.extend({'id': v['id'], 'frames': v['frames'], 'status': 'pending'}
                   for v in plan['videos'] if v['id'] not in present)
    complete = all(entry['status'] == 'complete' for entry in entries)
    coverage = {'version': 1, 'private': True, 'planSHA256': plan_sha,
                'status': 'complete' if complete and not cloud_failed else 'incomplete',
                'abortReason': abort_reason, 'expectedVideos': len(plan['videos']),
                'expectedFrames': sum(v['frames'] for v in plan['videos']),
                'completedVideos': sum(e['status'] == 'complete' for e in entries),
                'completedFrames': sum(e['frames'] for e in entries if e['status'] == 'complete'),
                'entries': entries, 'failures': failures}
    save(workdir / 'coverage.json', coverage)
    if not cloud_failed:
        try:
            store.put(workdir / 'coverage.json', 'coverage.json')
        except Exception as error:
            cloud_failed = True
            coverage.update(status='incomplete', abortReason='Coverage upload failed: ' + pilot.probe.sanitize(str(error)))
            save(workdir / 'coverage.json', coverage)
    return 0 if complete and not cloud_failed else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('plan', 'workdir', 'root'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('plan-sha256', 'bucket', 'result-prefix', 'deadline'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    deadline = datetime.fromisoformat(args.deadline.replace('Z', '+00:00'))
    if deadline.tzinfo is None or deadline.utcoffset().total_seconds() != 0:
        raise ValueError('Deadline must be ISO UTC')
    if (not args.workdir.is_absolute() or not args.root.is_absolute() or not args.root.is_dir()
            or args.result_prefix != PREFIX
            or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', args.bucket)
            or '..' in args.bucket):
        raise ValueError('Invalid private worker location/bucket/prefix')
    plan = load_plan(args.plan, args.plan_sha256)
    if (any(v['width'] * v['height'] * 16 > 1536 * 1024 for v in plan['videos'])
            and 'max_target_pixels' not in inspect.signature(prepare.prepare).parameters):
        raise ValueError('Wide catalog sources require prepare max_target_pixels support; refusing partial corpus')
    root, workdir = args.root.resolve(), args.workdir.resolve()
    if (args.workdir.is_symlink() or workdir == root or root.is_relative_to(workdir)
            or workdir.is_relative_to(root / 'source') or workdir.is_relative_to(root / 'models')):
        raise ValueError('Workdir must not own runner source/models')
    (root / 'runs').mkdir(exist_ok=True)
    with (root / 'runs/bulk.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
        binding_path = workdir / 'plan-binding.json'
        if not binding_path.exists() and any(workdir.iterdir()):
            raise ValueError('Existing nonempty workdir has no worker ownership binding')
        expected = {'planSHA256': args.plan_sha256, 'bucket': args.bucket, 'prefix': args.result_prefix}
        if binding_path.exists() and json.loads(binding_path.read_text()) != expected:
            raise ValueError('Workdir bound to a different plan or destination')
        save(binding_path, expected)
        disk_guard(workdir)
        if command(['git', '-C', str(root / 'source'), 'rev-parse', 'HEAD']) != pilot.probe.REVISION:
            raise ValueError('Runner revision mismatch')
        if command(['git', '-C', str(root / 'source'), 'status', '--porcelain', '--untracked-files=no']):
            raise ValueError('Runner tracked source modified')
        for name, expected_hash in pilot.probe.MODEL_HASHES.items():
            if sha256(root / 'models' / name) != expected_hash:
                raise ValueError('Missing or incorrect staged model: ' + name)
        return worker(plan, args.plan_sha256, Store(args.bucket, args.result_prefix),
                      workdir, root, deadline)


if __name__ == '__main__':
    sys.exit(main())
