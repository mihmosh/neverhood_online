import hashlib
import importlib.util
import json
import re
from pathlib import Path
import tempfile
import unittest

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / 'tools/upscaling/gemini/all-review.py'
SPEC = importlib.util.spec_from_file_location('all_background_review', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


class AllReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name) / 'private-assets'
        self.experiments = self.private / 'upscaling/gemini-experiments'
        self.output = self.private / 'upscaling/gemini-review-all'
        self.experiments.mkdir(parents=True)
        self.output.mkdir(parents=True)
        self.source = self.image('sources/original.png', (45, 75, 100))

    def image(self, name, color, **extra):
        path = self.private / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (8, 6), color).save(path)
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'mimeType': 'image/png', 'dimensions': [8, 6], **extra}

    def attempt(self, experiment, name, color=(70, 95, 125), source=None, status='succeeded', pair=False):
        source = source or self.source
        attachments = [{**source, 'role': 'source-state-A' if pair else 'source-composition'}]
        if pair:
            second = self.image('sources/second.png', (25, 35, 55))
            attachments.append({**second, 'role': 'source-state-B', 'label': 'Original lighting state B'})
        job = {'id': name, 'roomId': 'Scene2810', 'model': 'gemini-nano-banana-2.1', 'requestHash': name,
               'attachments': attachments, 'promptVariant': 'preservation', 'referenceMode': 'none'}
        run = self.experiments / experiment
        folder = run / 'jobs' / name
        record = {'id': name, 'requestHash': name, 'status': status, 'startedAt': experiment,
                  'modelVersion': job['model'], 'images': []}
        if status == 'succeeded':
            final = self.image(f'upscaling/gemini-experiments/{experiment}/jobs/{name}/final.png', color,
                               thought=False, candidateIndex=0, partIndex=1)
            thought = self.image(f'upscaling/gemini-experiments/{experiment}/jobs/{name}/thought.png', (255, 0, 255),
                                 thought=True, candidateIndex=0, partIndex=0)
            record['images'] = [thought, final]
        save(run / 'experiment.json', {'experimentId': experiment, 'rooms': [{'id': job['roomId'], 'resourceId': '0x12345678'}], 'jobs': [job]})
        save(folder / 'request.json', job)
        save(folder / 'result.json', record)
        return folder, record

    def collect(self):
        return MODULE.collect(self.experiments, self.output, self.private)

    def test_collects_all_versions_and_history_excludes_thought_and_keeps_unknown(self):
        self.attempt('static-pilot-v1-test', 'historic')
        self.attempt('opaque-coverage-v1', 'current', (80, 100, 130))
        self.attempt('opaque-pilot-v1', 'unknown', status='in-flight-outcome-unknown')
        data, index = self.collect()
        self.assertEqual(data['summary']['originalBackgrounds'], 1)
        self.assertEqual(data['summary']['savedFinalImages'], 2)
        self.assertEqual(data['summary']['archivedAttemptsWithoutImage'], 1)
        self.assertEqual(len(data['rooms']), 3)
        self.assertEqual({r['category'] for r in data['rooms']}, {'production', 'historical-experiment'})
        self.assertFalse(index['policy']['thoughtImagesIncluded'])
        self.assertTrue(all(not row['available'] or 'thought.png' not in row['output']['path'] for row in data['rooms']))
        self.assertTrue(all(not row['canApprove'] for row in data['rooms'] if not row['available']))
        self.assertEqual(len(index['attempts']), 3)

    def test_identical_pixels_group_and_identical_final_artifact_deduplicates_with_lineage(self):
        self.attempt('opaque-a', 'one')
        self.attempt('opaque-b', 'two')
        data, index = self.collect()
        self.assertEqual(len(data['rooms']), 1)
        self.assertEqual(len(data['rooms'][0]['attempts']), 2)
        self.assertEqual(len(index['attempts']), 2)
        self.assertEqual(data['summary']['savedFinalImages'], 1)

    def test_relocates_original_absolute_paths_without_reading_old_checkout(self):
        folder, record = self.attempt('opaque-a', 'one')
        request = json.loads((folder / 'request.json').read_text())
        request['attachments'][0]['path'] = '/other/machine/private-assets/sources/original.png'
        save(folder / 'request.json', request)
        for part in record['images']:
            suffix = Path(part['path']).relative_to(self.private)
            part['path'] = '/other/machine/private-assets/' + str(suffix)
        save(folder / 'result.json', record)
        data, _ = self.collect()
        self.assertEqual(data['summary']['savedFinalImages'], 1)
        self.assertTrue(data['rooms'][0]['source']['path'].startswith(str(self.private)))
        self.assertNotIn('/other/machine', json.dumps(data['rooms'][0]['source']))

    def test_unmapped_pair_has_both_originals_but_cannot_be_approved_as_room(self):
        self.attempt('opaque-a', 'one')
        self.attempt('paired-lighting-v1', 'pair', (100, 110, 120), pair=True)
        data, _ = self.collect()
        pair = next(row for row in data['rooms'] if row['category'] == 'paired-experiment')
        self.assertFalse(pair['canApprove'])
        self.assertTrue(pair['available'])
        self.assertEqual(len(pair['additionalSources']), 1)
        self.assertIn('url', pair['additionalSources'][0]['meta'])
        self.assertEqual(data['summary']['originalBackgrounds'], 1)
        self.assertEqual(data['summary']['experimentGroups'], 1)
        self.assertEqual(data['summary']['pairedExperimentImages'], 1)

    def test_tampered_saved_image_and_nonprivate_paths_refuse(self):
        folder, record = self.attempt('opaque-a', 'one')
        record['images'][1]['sha256'] = 'incorrect'
        save(folder / 'result.json', record)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.collect()
        with self.assertRaises(ValueError):
            MODULE.private_path('/etc/passwd', self.private)
        with self.assertRaises(ValueError):
            MODULE.private_path('../../outside.png', self.private)

    def test_catalog_hash_is_stable_and_page_is_english_offline(self):
        self.attempt('opaque-a', 'one')
        first, _ = self.collect()
        second, _ = self.collect()
        self.assertEqual(first['manifestSha256'], second['manifestSha256'])
        page = MODULE.REVIEW.render(first)
        self.assertIn('Background Review', page)
        self.assertIn('Catalog JSON', page)
        self.assertNotIn('https://', page)
        self.assertNotIn('http://', page)
        self.assertNotRegex(page, '[\u0400-\u04ff]')
        self.assertIn('Import matching artifact decisions', page)
        link_loop = re.search(r'if\(D\.technicalReportUrl\).*?\[([^\]]+)\]', page)
        self.assertIsNotNone(link_loop)
        for identifier in re.findall(r"'([^']+)'", link_loop.group(1)):
            self.assertIn('id="' + identifier + '"', page,
                          'Catalog link initialization must not crash on a missing DOM element')

    def test_saved_user_approval_matches_exact_output_not_other_versions(self):
        self.attempt('opaque-old', 'old')
        self.attempt('opaque-new', 'new', (90, 110, 130))
        self.attempt('opaque-unknown', 'missing', status='outcome-unknown')
        data, _ = self.collect()
        approved = next(row for row in data['rooms'] if row['candidateId'] == 'new')
        receipt = {'schemaVersion': 1, 'reviewer': 'user', 'receiptId': 'user-acceptance', 'decisions': [
            {'sourceSha256': approved['source']['sha256'], 'outputSha256': approved['output']['sha256'], 'decision': 'approved'}]}
        MODULE.apply_saved_decisions(data, receipt)
        self.assertEqual(len(data['savedDecisions']), 1)
        self.assertEqual(data['savedDecisions'][0]['id'], approved['id'])
        self.assertNotEqual(data['savedDecisions'][0]['id'], next(row['id'] for row in data['rooms'] if row['candidateId'] == 'old'))
        receipt['decisions'][0]['outputSha256'] = 'unknown'
        with self.assertRaises(ValueError):
            MODULE.apply_saved_decisions(data, receipt)


if __name__ == '__main__':
    unittest.main()
