"""Offline full-corpus verification contracts; never creates an AWS session."""
import base64
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

try:
    import boto3
except ModuleNotFoundError:
    boto3 = None

HERE = Path(__file__).resolve().parent
if boto3 is not None:
    spec = importlib.util.spec_from_file_location('video_verify_bulk', HERE / 'verify_bulk.py')
    verifier = importlib.util.module_from_spec(spec)
    original_path = sys.path[:]
    try:
        sys.path.insert(0, str(HERE))
        spec.loader.exec_module(verifier)
    finally:
        sys.path[:] = original_path


@unittest.skipIf(boto3 is None, 'Optional boto3 SDK is not installed')
class VerifyBulkTests(unittest.TestCase):
    def setUp(self):
        self.sha = 'a' * 64
        self.objects = {}
        self.prefix = 'results/neverhood-upscaling-lab/movie-7b-full-offline/'
        self.s3 = Mock()
        self.s3.head_object.side_effect = self.head
        self.s3.get_object.side_effect = self.get
        self.store = verifier.Store(self.s3, 'offline-private-bucket', self.prefix)
        probe = verifier.bulk.pilot.probe
        config = {'version': 1, 'private': True, 'status': 'complete', 'planSHA256': self.sha,
                  'modelVariant': '7b', 'runnerRevision': probe.REVISION,
                  'modelPrecision': probe.MODEL_PRECISION, 'ditModel': probe.DIT,
                  'blocksToSwap': probe.BLOCKS_TO_SWAP, 'models': probe.MODEL_HASHES}
        videos, entries = [], []
        for index in range(550):
            identity = hashlib.sha256(str(index).encode()).hexdigest()
            frames = 100 if index < 549 else 370
            video = {'id': identity, 'sourceSHA256': identity, 'frames': frames,
                     'width': 320, 'height': 240, 'fps': '15/1', 'sourceBytes': 123,
                     'sourceKey': f'sources/probes/movie-7b-full-offline/originals/{identity}.smk',
                     'resourceIds': ['alias1', 'alias2'], 'requestedHash': 'alias1',
                     'ringFrame': True, 'sourceFlags': 4,
                     'audio': [{'channels': 2, 'sample_rate': '22050'}] if index % 2 == 0 else []}
            videos.append(video)
            entries.append({'id': identity, 'frames': frames, 'status': 'complete'})
            reports = []
            for chunk in verifier.bulk.plan_chunks(frames):
                report = {**config, 'sourceSHA256': identity, 'source': video, 'chunk': chunk,
                          'masterSHA256': 'b' * 64, 'masterBytes': 10,
                          'sourceFrameMap': [{'sourceFrame': chunk['coreStart'] + i,
                                              'outputFrame': i, 'pngSHA256': 'c' * 64}
                                             for i in range(chunk['coreFrames'])]}
                key = identity + '/chunks/' + chunk['id'] + '/'
                self.media(key + 'master.mp4', 'b' * 64)
                self.put_json(key + 'report.json', report)
                reports.append(report)
            manifest = {**config, 'sourceSHA256': identity, 'source': video, 'chunks': reports,
                        'frames': frames, 'fps': video['fps'], 'masterSHA256': 'd' * 64,
                        'previewSHA256': 'e' * 64, 'allAudioPCMEqual': True,
                        'audioPCM': [{'channels': 2, 'sampleRate': 22050, 'sha256': 'f' * 64}]
                        if video['audio'] else [],
                        'sidecarSHA256': 'f' * 64 if video['audio'] else None}
            self.put_json(identity + '/manifest.json', manifest)
            self.media(identity + '/master.mp4', 'd' * 64, composite=True)
            self.media(identity + '/preview.mp4', 'e' * 64)
        self.plan = {'version': 1, 'private': True, 'modelVariant': '7b', 'chunkCoreFrames': 49,
                     'contextFrames': 4, 'scale': 4, 'runId': 'movie-7b-full-offline',
                     'uniqueVideos': 550, 'totalDecodedFrames': 55270, 'videos': videos}
        self.coverage = {'version': 1, 'private': True, 'status': 'complete',
                         'planSHA256': self.sha, 'expectedVideos': 550, 'expectedFrames': 55270,
                         'completedVideos': 550, 'completedFrames': 55270,
                         'entries': entries, 'failures': []}
        self.put_json('coverage.json', self.coverage)
        self.first = videos[0]['id'] + '/'

    def media(self, key, sha, composite=False):
        self.objects[key] = (None, {'Metadata': {'sha256': sha}, 'ContentLength': 10,
                                   'ServerSideEncryption': 'AES256',
                                   'ChecksumType': 'COMPOSITE' if composite else 'FULL_OBJECT',
                                   'ChecksumSHA256': 'native-multipart-2' if composite else
                                   base64.b64encode(bytes.fromhex(sha)).decode()})

    def put_json(self, key, data):
        raw = json.dumps(data).encode()
        self.media(key, hashlib.sha256(raw).hexdigest())
        self.objects[key] = (raw, {**self.objects[key][1], 'ContentLength': len(raw)})

    def head(self, **kwargs):
        self.assertEqual(kwargs['Bucket'], 'offline-private-bucket')
        self.assertEqual(kwargs['ChecksumMode'], 'ENABLED')
        self.assertTrue(kwargs['Key'].startswith(self.prefix))
        return deepcopy(self.objects[kwargs['Key'][len(self.prefix):]][1])

    def get(self, **kwargs):
        self.assertTrue(kwargs['Key'].endswith('.json'), 'Media must never be downloaded')
        head = self.head(**kwargs)
        raw = self.objects[kwargs['Key'][len(self.prefix):]][0]
        return {**head, 'Body': io.BytesIO(raw)}

    def test_complete_full_corpus_and_multipart_movies(self):
        result = verifier.verify(self.plan, self.sha, self.store)
        self.assertEqual((result['verifiedVideos'], result['verifiedFrames']), (550, 55270))
        self.assertFalse(result['approvedForRuntime'])
        self.assertTrue(result['technicalOnly'])
        self.assertEqual(len(result['results'][0]['chunks']), 3)
        self.s3.upload_file.assert_not_called()

    def test_tampered_or_incomplete_coverage(self):
        for change in ({'status': 'incomplete'}, {'completedFrames': 55269},
                       {'failures': [{'id': 'failed'}]},
                       {'entries': self.coverage['entries'][:-1]}):
            with self.subTest(change=list(change)):
                self.put_json('coverage.json', {**self.coverage, **change})
                with self.assertRaises(ValueError):
                    verifier.verify(self.plan, self.sha, self.store)
        self.put_json('coverage.json', self.coverage)
        raw, head = self.objects['coverage.json']
        self.objects['coverage.json'] = (raw.replace(b'complete', b'tampered'), head)
        with self.assertRaisesRegex(ValueError, 'Downloaded JSON'):
            verifier.verify(self.plan, self.sha, self.store)

    def test_missing_chunk_and_frame_mapping(self):
        key = self.first + 'chunks/000049/report.json'
        original = self.objects.pop(key)
        with self.assertRaises(KeyError):
            verifier.verify(self.plan, self.sha, self.store)
        self.objects[key] = original
        manifest_key = self.first + 'manifest.json'
        manifest = json.loads(self.objects[manifest_key][0])
        manifest['chunks'][1]['sourceFrameMap'][0]['sourceFrame'] = 48
        self.put_json(key, manifest['chunks'][1])
        self.put_json(manifest_key, manifest)
        with self.assertRaisesRegex(ValueError, 'gap/overlap'):
            verifier.verify(self.plan, self.sha, self.store)

    def test_hash_encryption_and_model_binding(self):
        key = self.first + 'chunks/000000/master.mp4'
        raw, original = self.objects[key]
        for change in ({'ChecksumSHA256': 'wrong'}, {'Metadata': {'sha256': '0' * 64}},
                       {'ServerSideEncryption': 'aws:kms'},
                       {'ChecksumType': 'COMPOSITE', 'ChecksumSHA256': 'parts-2'}):
            with self.subTest(change=change):
                self.objects[key] = (raw, {**original, **change})
                with self.assertRaises(ValueError):
                    verifier.verify(self.plan, self.sha, self.store)
        self.objects[key] = (raw, original)
        key = self.first + 'manifest.json'
        manifest = json.loads(self.objects[key][0])
        manifest['models'] = {'untrusted': '0' * 64}
        self.put_json(key, manifest)
        with self.assertRaisesRegex(ValueError, 'Pinned 7B'):
            verifier.verify(self.plan, self.sha, self.store)

    def test_pcm_and_original_source_flags(self):
        key = self.first + 'manifest.json'
        original = json.loads(self.objects[key][0])
        for change in ({'allAudioPCMEqual': False}, {'audioPCM': []},
                       {'audioPCM': [{'channels': 1, 'sampleRate': 22050, 'sha256': 'f' * 64}]},
                       {'audioPCM': [{'channels': 2, 'sampleRate': 22050, 'sha256': 'invalid'}]},
                       {'source': {**original['source'], 'ringFrame': False}}):
            with self.subTest(change=list(change)):
                self.put_json(key, {**original, **change})
                with self.assertRaises(ValueError):
                    verifier.verify(self.plan, self.sha, self.store)


if __name__ == '__main__':
    unittest.main()
