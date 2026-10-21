"""CPU-only bulk protocol tests. No AWS, network, model or GPU access."""
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location('video_bulk', Path(__file__).with_name('bulk.py'))
bulk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bulk)


class FakeStore:
    def __init__(self):
        self.objects = {}
        self.puts = []
        self.fail_once = None

    def put(self, path, key):
        if key == self.fail_once:
            self.fail_once = None
            raise OSError('Simulated interrupted upload')
        self.objects[key] = path.read_bytes()
        self.puts.append(key)

    def verify(self, key, digest, size=None):
        content = self.objects[key]
        if bulk.hashlib.sha256(content).hexdigest() != digest or (size is not None and len(content) != size):
            raise ValueError('Remote hash mismatch')

    def get(self, key, path, digest):
        self.verify(key, digest)
        path.write_bytes(self.objects[key])

    def report(self, key, path):
        if key not in self.objects:
            return None
        path.write_bytes(self.objects[key])
        return json.loads(self.objects[key])

    def source(self, video, path):
        path.write_bytes(self.objects[video['sourceKey']])


class ProtocolTests(unittest.TestCase):
    def test_core_context_coverage(self):
        for count in (1, 4, 49, 50, 98, 113, 3599):
            chunks = bulk.plan_chunks(count)
            covered = []
            for chunk in chunks:
                covered.extend(range(chunk['coreStart'], chunk['coreStart'] + chunk['coreFrames']))
                self.assertLessEqual(chunk['inputFrames'], 57)
                self.assertGreaterEqual(chunk['inputStart'], 0)
                self.assertLessEqual(chunk['inputStart'] + chunk['inputFrames'], count)
                self.assertEqual(chunk['inputStart'] + chunk['leftContext'], chunk['coreStart'])
            self.assertEqual(covered, list(range(count)))
        with self.assertRaises(ValueError):
            bulk.plan_chunks(0)

    def test_binding_and_deadline(self):
        video = {'sourceSHA256': 'a' * 64}
        report = {'planSHA256': 'b' * 64, **video, 'status': 'complete'}
        bulk.binding(report, 'b' * 64, video)
        with self.assertRaises(ValueError):
            bulk.binding(report, 'c' * 64, video)
        with self.assertRaises(bulk.DeadlineReached):
            bulk.deadline_guard(datetime.now(timezone.utc) + timedelta(minutes=19))
        bulk.deadline_guard(datetime.now(timezone.utc) + timedelta(minutes=21))

    def test_s3_upload_is_checksummed_encrypted_and_head_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'test'
            path.write_bytes(b'private artifact')
            digest = bulk.sha256(path)
            head = {'Metadata': {'sha256': digest}, 'ChecksumSHA256': bulk.base64.b64encode(
                bytes.fromhex(digest)).decode(), 'ServerSideEncryption': 'AES256',
                    'ContentLength': path.stat().st_size}
            with patch.object(bulk, 'command', side_effect=['{}', json.dumps(head)]) as call:
                bulk.Store('test-bucket', bulk.PREFIX).put(path, 'report.json')
            args = call.call_args_list[0].args[0]
            self.assertIn('AES256', args)
            self.assertIn('--checksum-sha256', args)
            self.assertIn('--metadata', args)
            self.assertIn('head-object', call.call_args_list[1].args[0])

    def test_multipart_upload_requires_streamed_full_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'large-master.mp4'
            content = b'fake multipart payload'
            path.write_bytes(content)
            digest = bulk.sha256(path)
            head = {'Metadata': {'sha256': digest}, 'ChecksumType': 'COMPOSITE',
                    'ChecksumSHA256': 'native-composite-checksum-2',
                    'ServerSideEncryption': 'AES256', 'ContentLength': len(content)}
            for downloaded in (content, b'corrupted uploaded payload'):
                with self.subTest(valid=downloaded == content):
                    process = MagicMock()
                    process.__enter__.return_value = process
                    process.stdout = io.BytesIO(downloaded)
                    process.wait.return_value = 0
                    with patch.object(bulk, 'SINGLE_PART_LIMIT', 1), patch.object(
                            bulk, 'command', side_effect=['', json.dumps(head)]) as shell, patch.object(
                                bulk.subprocess, 'Popen', return_value=process) as popen:
                        store = bulk.Store('test-bucket', bulk.PREFIX)
                        if downloaded == content:
                            store.put(path, 'master.mp4')
                        else:
                            with self.assertRaisesRegex(ValueError, 'readback SHA256'):
                                store.put(path, 'master.mp4')
                    upload = shell.call_args_list[0].args[0]
                    self.assertEqual(upload[:3], ['aws', 's3', 'cp'])
                    self.assertIn('--checksum-algorithm', upload)
                    self.assertIn('AES256', upload)
                    self.assertIn('sha256=' + digest, upload)
                    self.assertEqual(popen.call_args.args[0][-2:], ['-', '--only-show-errors'])
                    self.assertEqual(popen.call_count, 1)

    def test_composite_head_is_not_a_single_part_native_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'report.json'
            path.write_bytes(b'report')
            digest = bulk.sha256(path)
            head = {'Metadata': {'sha256': digest}, 'ChecksumType': 'COMPOSITE',
                    'ChecksumSHA256': 'composite-2', 'ServerSideEncryption': 'AES256',
                    'ContentLength': path.stat().st_size}
            with patch.object(bulk, 'command', side_effect=['', json.dumps(head)]):
                with self.assertRaisesRegex(ValueError, 'Single-part native SHA256'):
                    bulk.Store('test-bucket', bulk.PREFIX).put(path, 'report.json')

    def test_multipart_metadata_size_encryption_and_checksum_are_required(self):
        digest = 'a' * 64
        head = {'Metadata': {'sha256': digest}, 'ChecksumType': 'COMPOSITE',
                'ChecksumSHA256': 'composite-2', 'ServerSideEncryption': 'AES256', 'ContentLength': 50}
        store = bulk.Store('test-bucket', bulk.PREFIX)
        for bad in ({'Metadata': {}}, {'ChecksumSHA256': ''}, {'ServerSideEncryption': 'aws:kms'},
                    {'ContentLength': 49}, {'ChecksumType': 'UNKNOWN'}):
            with self.subTest(bad=bad), patch.object(store, 'head', return_value={**head, **bad}):
                with self.assertRaisesRegex(ValueError, 'metadata mismatch'):
                    store.verify('master.mp4', digest, 50)

    def test_plan_hash_is_authoritative(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'plan.json'
            path.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'Plan SHA256'):
                bulk.load_plan(path, 'a' * 64)

    def test_low_disk_is_rejected(self):
        with patch.object(bulk.shutil, 'disk_usage', return_value=bulk.shutil._ntuple_diskusage(10, 9, 1)):
            with self.assertRaisesRegex(RuntimeError, '10 GiB'):
                bulk.disk_guard(Path('/unused'))

    def test_large_movie_assembly_uses_dynamic_reserve_not_two_gib_cap(self):
        video = {'frames': 3350}
        reports = [{'chunk': chunk, 'masterBytes': 60 * 1024 ** 2}
                   for chunk in bulk.plan_chunks(video['frames'])]
        total = sum(report['masterBytes'] for report in reports)
        self.assertGreater(total, 2 * 1024 ** 3)
        with patch.object(bulk, 'disk_guard', side_effect=RuntimeError('reserve checked')) as guard:
            with self.assertRaisesRegex(RuntimeError, 'reserve checked'):
                bulk.assemble_movie(video, reports, Path('/source'), Path('/movie'), None, 'plan')
        guard.assert_called_once_with(Path('/movie'), 3 * total + bulk.MIN_FREE)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class SyntheticTests(unittest.TestCase):
    def setUp(self):
        disk = patch.object(bulk, 'MIN_FREE', 0)
        disk.start()
        self.addCleanup(disk.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.source = self.directory / 'source.mp4'
        bulk.command(['ffmpeg', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                      'testsrc2=size=32x32:rate=1000/67:duration=7.571',
                      '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=8000:duration=9',
                      '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=16000:duration=8',
                      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264',
                      '-crf', '0', '-pix_fmt', 'yuv444p', '-c:a', 'flac', '-strict', '-2',
                      '-video_track_timescale', '1000', str(self.source)])
        streams = bulk.prepare.probe(self.source)
        count = bulk.prepare.video_info(streams)[3]
        digest = bulk.sha256(self.source)
        self.video = {'id': digest, 'sourceSHA256': digest, 'sourceKey': 'sources/probes/test/originals/' + digest + '.smk',
                      'sourceBytes': self.source.stat().st_size, 'width': 32, 'height': 32,
                      'frames': count, 'fps': '1000/67', 'resourceIds': ['00000001'],
                      'requestedHash': '00000002', 'ringFrame': True, 'sourceFlags': 17}
        self.plan_sha = 'b' * 64
        self.store = FakeStore()
        self.store.objects[self.video['sourceKey']] = self.source.read_bytes()
        self.movie_dir = self.directory / 'movie'
        self.movie_dir.mkdir()
        self.calls = []
        self.deadline = datetime.now(timezone.utc) + timedelta(hours=1)

    def tearDown(self):
        self.temp.cleanup()

    def inference(self, root, prepared, scratch, data):
        self.calls.append(data['selection'])
        output = scratch / 'artifacts/frames/input'
        output.mkdir(parents=True)
        bulk.command(['ffmpeg', '-v', 'error', '-n', '-i', str(prepared / 'input.mp4'),
                      '-vf', f"scale={data['target']['width']}:{data['target']['height']}:flags=neighbor",
                      '-frames:v', str(data['selection']['frames']),
                      '-fps_mode', 'passthrough', '-start_number', '0', str(output / 'input_%06d.png')])

    def chunk(self, chunk):
        return bulk.chunk_worker(self.video, chunk, self.source, self.movie_dir, self.store,
                                 self.plan_sha, self.directory, self.deadline, self.inference)

    def test_context_assembly_full_audio_and_restart(self):
        reports = [self.chunk(chunk) for chunk in bulk.plan_chunks(self.video['frames'])]
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.calls[1]['frames'], 57)
        self.assertEqual([r['sourceFrame'] for report in reports for r in report['sourceFrameMap']],
                         list(range(self.video['frames'])))
        self.assertTrue(all(len(frame['pngSHA256']) == 64 for report in reports for frame in report['sourceFrameMap']))
        # Committed reports survive VM scratch loss without another inference.
        shutil.rmtree(self.movie_dir)
        self.movie_dir.mkdir()
        resumed = [self.chunk(chunk) for chunk in bulk.plan_chunks(self.video['frames'])]
        self.assertEqual(resumed, reports)
        self.assertEqual(len(self.calls), 3)
        manifest = bulk.assemble_movie(self.video, resumed, self.source, self.movie_dir,
                                       self.store, self.plan_sha)
        self.assertEqual(manifest['source'], self.video)
        self.assertEqual(manifest['classification'], 'corpus-unclassified')
        self.assertTrue(manifest['allAudioPCMEqual'])
        self.assertEqual(len(manifest['audioPCM']), 2)
        restored = self.directory / 'restored.mp4'
        restored.write_bytes(self.store.objects[self.video['id'] + '/master.mp4'])
        bulk.validate_movie(restored, self.video, 4)
        actual = bulk.command(['ffmpeg', '-v', 'error', '-i', str(restored), '-map', '0:v:0',
                               '-pix_fmt', 'yuv444p', '-f', 'framemd5', '-'])
        expected = bulk.command(['ffmpeg', '-v', 'error', '-i', str(self.source), '-map', '0:v:0',
                                 '-vf', 'scale=128:128:flags=neighbor,format=rgb24,format=yuv444p',
                                 '-f', 'framemd5', '-'])
        hashes = lambda text: [line.split(',')[-1].strip() for line in text.splitlines()
                               if line and not line.startswith('#')]
        self.assertEqual(hashes(actual), hashes(expected))
        self.assertEqual(bulk.pcm_hashes(restored), bulk.pcm_hashes(self.source))
        self.assertEqual(self.store.puts[-1], self.video['id'] + '/manifest.json')

    def test_interrupted_upload_reuses_local_complete_master(self):
        chunk = bulk.plan_chunks(self.video['frames'])[0]
        self.store.fail_once = self.video['id'] + '/chunks/' + chunk['id'] + '/report.json'
        with self.assertRaises(OSError):
            self.chunk(chunk)
        self.assertEqual(len(self.calls), 1)
        report = self.chunk(chunk)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(report['status'], 'complete')
        report_key = self.video['id'] + '/chunks/' + chunk['id'] + '/report.json'
        wrong = json.loads(self.store.objects[report_key])
        wrong['planSHA256'] = 'c' * 64
        self.store.objects[report_key] = json.dumps(wrong).encode()
        with self.assertRaisesRegex(ValueError, 'Checkpoint'):
            self.chunk(chunk)
        self.assertEqual(len(self.calls), 1)

    def test_prepared_only_deadline_pause_resumes_without_repreparing(self):
        chunk = bulk.plan_chunks(self.video['frames'])[0]
        with patch.object(bulk.prepare, 'prepare', wraps=bulk.prepare.prepare) as prepare:
            with patch.object(bulk, 'deadline_guard', side_effect=[None, bulk.DeadlineReached('pause')]):
                with self.assertRaises(bulk.DeadlineReached):
                    self.chunk(chunk)
            attempt = self.movie_dir / ('chunk-' + chunk['id']) / 'scratch/attempt.json'
            self.assertIs(json.loads(attempt.read_text())['inferenceStarted'], False)
            self.assertEqual(self.calls, [])
            self.assertEqual(self.chunk(chunk)['status'], 'complete')
        self.assertEqual(prepare.call_count, 1)
        self.assertEqual(len(self.calls), 1)

    def test_unstarted_partial_preparation_can_be_rebuilt(self):
        chunk = bulk.plan_chunks(self.video['frames'])[0]
        def interrupted(source, output, *args, **kwargs):
            output.mkdir()
            (output / 'input.mp4').write_bytes(b'partial preparation, not paid inference')
            raise RuntimeError('preparation interrupted')
        with patch.object(bulk.prepare, 'prepare', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, 'preparation interrupted'):
                self.chunk(chunk)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.chunk(chunk)['status'], 'complete')
        self.assertEqual(len(self.calls), 1)

    def test_assembly_reuses_locally_committed_chunks_without_downloads(self):
        reports = [self.chunk(chunk) for chunk in bulk.plan_chunks(self.video['frames'])]
        with patch.object(self.store, 'get', side_effect=AssertionError('Unexpected duplicate download')):
            manifest = bulk.assemble_movie(self.video, reports, self.source, self.movie_dir,
                                           self.store, self.plan_sha)
        self.assertEqual(manifest['status'], 'complete')
        self.assertTrue(all((self.movie_dir / ('chunk-' + r['chunk']['id']) / 'master.mp4').exists()
                            for r in reports))

    def test_partial_inference_is_never_retried(self):
        chunk = bulk.plan_chunks(self.video['frames'])[0]
        def fail(*args):
            (args[2] / 'inference.log').write_text('partial raw log, local only')
            raise RuntimeError('inference failed')
        with self.assertRaisesRegex(RuntimeError, 'inference failed'):
            bulk.chunk_worker(self.video, chunk, self.source, self.movie_dir, self.store,
                              self.plan_sha, self.directory, self.deadline, fail)
        with self.assertRaisesRegex(ValueError, 'exactly the original frame ordinals'):
            self.chunk(chunk)
        self.assertEqual(self.calls, [])
        # A persisted marker from before the state flag must remain conservatively paid.
        attempt = self.movie_dir / ('chunk-' + chunk['id']) / 'scratch/attempt.json'
        state = json.loads(attempt.read_text())
        del state['inferenceStarted']
        bulk.save(attempt, state)
        with self.assertRaisesRegex(ValueError, 'exactly the original frame ordinals'):
            self.chunk(chunk)
        self.assertEqual(self.calls, [])

    def test_wide_source_requests_explicit_non_cropping_bound(self):
        video = {**self.video, 'width': 448, 'height': 240}
        with patch.object(bulk.prepare, 'prepare', side_effect=RuntimeError('preparation sentinel')) as prepare:
            with self.assertRaisesRegex(RuntimeError, 'preparation sentinel'):
                bulk.chunk_worker(video, bulk.plan_chunks(video['frames'])[0], self.source,
                                  self.movie_dir, self.store, self.plan_sha, self.directory,
                                  self.deadline, self.inference)
        self.assertEqual(prepare.call_args.kwargs['max_target_pixels'], 1792 * 960)
        self.assertIs(prepare.call_args.kwargs['preserve_audio'], False)
        self.assertEqual(self.calls, [])

    def test_real_wide_source_is_not_cropped(self):
        source = self.directory / 'wide.mp4'
        bulk.command(['ffmpeg', '-v', 'error', '-n', '-f', 'lavfi', '-i',
                      'color=size=448x240:rate=1000/67:color=green', '-frames:v', '2',
                      '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p',
                      '-video_track_timescale', '1000', str(source)])
        digest = bulk.sha256(source)
        video = {**self.video, 'id': digest, 'sourceSHA256': digest,
                 'width': 448, 'height': 240, 'frames': 2, 'sourceBytes': source.stat().st_size}
        report = bulk.chunk_worker(video, bulk.plan_chunks(2)[0], source, self.movie_dir,
                                   self.store, self.plan_sha, self.directory,
                                   self.deadline, self.inference)
        self.assertEqual(report['status'], 'complete')
        restored = self.directory / 'wide-result.mp4'
        restored.write_bytes(self.store.objects[digest + '/chunks/000000/master.mp4'])
        bulk.validate_movie(restored, video, 4)

    def test_complete_pngs_survive_lost_inference_exit(self):
        chunk = bulk.plan_chunks(self.video['frames'])[0]
        def lost_exit(*args):
            self.inference(*args)
            raise RuntimeError('Lost worker after inference')
        with self.assertRaises(RuntimeError):
            bulk.chunk_worker(self.video, chunk, self.source, self.movie_dir, self.store,
                              self.plan_sha, self.directory, self.deadline, lost_exit)
        self.assertEqual(self.chunk(chunk)['status'], 'complete')
        self.assertEqual(len(self.calls), 1)

    def test_tiny_full_worker_and_global_lock(self):
        tiny = self.directory / 'tiny.mp4'
        bulk.command(['ffmpeg', '-v', 'error', '-n', '-i', str(self.source), '-map', '0:v:0',
                      '-frames:v', '2', '-c:v', 'copy', '-video_track_timescale', '1000', str(tiny)])
        digest = bulk.sha256(tiny)
        video = {**self.video, 'id': digest, 'sourceSHA256': digest, 'frames': 2,
                 'sourceBytes': tiny.stat().st_size,
                 'sourceKey': 'sources/probes/test/originals/' + digest + '.smk'}
        self.store.objects[video['sourceKey']] = tiny.read_bytes()
        plan = {'version': 1, 'private': True, 'runId': 'test', 'modelVariant': '7b',
                'chunkCoreFrames': 49, 'contextFrames': 4, 'videos': [video]}
        workdir = self.directory / 'tiny-work'
        workdir.mkdir()
        self.assertEqual(bulk.worker(plan, self.plan_sha, self.store, workdir, self.directory,
                                      self.deadline, self.inference), 0)
        coverage = json.loads(self.store.objects['coverage.json'])
        self.assertEqual(coverage['status'], 'complete')
        self.assertEqual(coverage['completedFrames'], 2)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(bulk.worker(plan, self.plan_sha, self.store, workdir, self.directory,
                                      self.deadline, self.inference), 0)
        self.assertEqual(len(self.calls), 1)
        # A second VM worker invocation cannot pass the runner-wide flock.
        plan_path = self.directory / 'plan.json'
        bulk.save(plan_path, plan)
        runs = self.directory / 'runs'
        runs.mkdir()
        with (runs / 'bulk.lock').open('a') as lock:
            bulk.fcntl.flock(lock, bulk.fcntl.LOCK_EX | bulk.fcntl.LOCK_NB)
            with patch.object(bulk, 'command') as shell, self.assertRaises(BlockingIOError):
                bulk.main(['--plan', str(plan_path), '--plan-sha256', bulk.sha256(plan_path),
                           '--bucket', 'test-bucket', '--result-prefix', bulk.PREFIX,
                           '--workdir', str(workdir), '--root', str(self.directory),
                           '--deadline', self.deadline.isoformat()])
            shell.assert_not_called()

    def test_failed_video_does_not_block_coverage_of_others(self):
        second = {**self.video, 'id': 'a' * 64, 'sourceSHA256': 'a' * 64}
        plan = {'videos': [self.video, second]}
        workdir = self.directory / 'work'
        workdir.mkdir()
        with patch.object(bulk, 'chunk_worker', side_effect=RuntimeError('failed chunk')) as chunk:
            result = bulk.worker(plan, self.plan_sha, self.store, workdir, self.directory,
                                 self.deadline, self.inference)
        self.assertEqual(result, 1)
        self.assertEqual(chunk.call_count, 2)
        coverage = json.loads(self.store.objects['coverage.json'])
        self.assertEqual(coverage['status'], 'incomplete')
        self.assertEqual(coverage['expectedVideos'], 2)
        self.assertEqual(coverage['expectedFrames'], self.video['frames'] * 2)
        self.assertEqual(len(coverage['failures']), 2)

    def test_two_consecutive_failures_stop_before_third_paid_attempt(self):
        videos = [{**self.video, 'id': char * 64, 'sourceSHA256': char * 64} for char in 'acde']
        workdir = self.directory / 'breaker-work'
        workdir.mkdir()
        with patch.object(bulk, 'chunk_worker', side_effect=RuntimeError('persistent inference failure')) as paid:
            result = bulk.worker({'videos': videos}, self.plan_sha, self.store, workdir,
                                 self.directory, self.deadline, self.inference)
        self.assertEqual(result, 1)
        self.assertEqual(paid.call_count, 2)
        coverage = json.loads(self.store.objects['coverage.json'])
        self.assertEqual([e['status'] for e in coverage['entries']], ['failed', 'failed', 'pending', 'pending'])
        self.assertIn('Two consecutive', coverage['abortReason'])
        self.assertEqual(coverage['expectedFrames'], 4 * self.video['frames'])

    def test_success_resets_consecutive_failure_breaker(self):
        videos = [{**self.video, 'id': char * 64, 'sourceSHA256': char * 64} for char in 'acdef']
        good = videos[1]
        digest = bulk.hashlib.sha256(b'verified movie').hexdigest()
        self.store.objects[good['id'] + '/master.mp4'] = b'verified movie'
        self.store.objects[good['id'] + '/preview.mp4'] = b'verified movie'
        self.store.objects[good['id'] + '/manifest.json'] = json.dumps({
            'planSHA256': self.plan_sha, 'sourceSHA256': good['sourceSHA256'], 'status': 'complete',
            'masterSHA256': digest, 'previewSHA256': digest}).encode()
        workdir = self.directory / 'reset-work'
        workdir.mkdir()
        with patch.object(bulk, 'chunk_worker', side_effect=RuntimeError('source failure')) as paid:
            bulk.worker({'videos': videos}, self.plan_sha, self.store, workdir,
                        self.directory, self.deadline, self.inference)
        self.assertEqual(paid.call_count, 3)
        coverage = json.loads(self.store.objects['coverage.json'])
        self.assertEqual([e['status'] for e in coverage['entries']],
                         ['failed', 'complete', 'failed', 'failed', 'pending'])

    def test_aws_failure_stops_immediately_and_keeps_local_coverage(self):
        videos = [{**self.video, 'id': char * 64, 'sourceSHA256': char * 64} for char in 'acd']
        workdir = self.directory / 'aws-failure-work'
        workdir.mkdir()
        error = subprocess.CalledProcessError(1, ['aws', 's3api', 'put-object'])
        with patch.object(bulk, 'chunk_worker', side_effect=error) as paid:
            result = bulk.worker({'videos': videos}, self.plan_sha, self.store, workdir,
                                 self.directory, self.deadline, self.inference)
        self.assertEqual(result, 1)
        self.assertEqual(paid.call_count, 1)
        coverage = json.loads((workdir / 'coverage.json').read_text())
        self.assertEqual([e['status'] for e in coverage['entries']], ['failed', 'pending', 'pending'])
        self.assertIn('AWS command failed', coverage['abortReason'])
        self.assertNotIn('coverage.json', self.store.objects)


if __name__ == '__main__':
    unittest.main()
