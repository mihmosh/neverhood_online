#!/usr/bin/env python3
"""Synthetic, offline tests for exact artifact release selection."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_selection', ROOT / 'tools/upscaling/gemini/release-selection.py')
SELECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECT)


class ReleaseSelectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp/kilo')
        self.addCleanup(self.tmp.cleanup)
        self.private = Path(self.tmp.name) / 'private-assets'
        self.private.mkdir()
        self.catalog_path = self.private / 'manual-review-data.json'
        self.export_path = Path(self.tmp.name) / 'review.json'
        self.receipt_path = self.private / 'accepted-artifacts.json'
        source = self.image('source', (8, 6), 'red')
        self.old = self.row('old', source, self.image('old', (16, 12), 'red'))
        self.new = self.row('new', source, self.image('new', (16, 12), 'blue'))
        self.new['provenance']['experimentId'] = 'manual-rework-test'
        self.new['startedAt'] = '2026-10-21T12:00:00Z'
        pending_source = self.image('pending-source', (8, 6), 'green')
        pending = self.row('pending', pending_source, self.image('pending', (16, 12), 'green'))
        paired = self.row('paired', source, self.image('paired', (16, 12), 'yellow'))
        paired.update(category='paired-experiment', canApprove=False)
        self.catalog = {'schemaVersion': 2, 'private': True, 'manifestSha256': 'current',
                        'previousCatalogManifestSha256': 'previous', 'rooms': [self.old, self.new, pending, paired]}
        prior = [self.old, pending, paired]
        self.export = {'schemaVersion': 2, 'manifestSha256': 'previous',
                       'candidates': [SELECT.identity(r) for r in prior],
                       'decisions': [{**SELECT.identity(r), 'decision': 'approved' if r is self.old else 'pending',
                                      'notes': ''} for r in prior]}
        self.receipt = {'schemaVersion': 1, 'reviewer': 'user', 'receiptId': 'test-user', 'decisions': []}

    def image(self, name, size, color):
        path = self.private / (name + '.png')
        Image.new('RGB', size, color).save(path)
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'dimensions': list(size)}

    def row(self, name, source, output):
        return {'id': name, 'candidateId': name + '-job', 'roomId': 'background:test',
                'source': copy.deepcopy(source), 'output': copy.deepcopy(output), 'resourceId': '0x12345678',
                'available': True, 'canApprove': True, 'category': 'production',
                'aliases': ['SceneA', 'SceneB-state'], 'startedAt': '2026-10-21T10:00:00Z',
                'provenance': {'experimentId': 'original', 'sourceBinding': {'state': name, 'decodedFrameId': 'frame'}}}

    def flush(self):
        for path, data in ((self.catalog_path, self.catalog), (self.export_path, self.export),
                           (self.receipt_path, self.receipt)):
            path.write_text(json.dumps(data))

    def build(self):
        self.flush()
        return SELECT.build_selection(self.catalog_path, self.export_path, self.receipt_path, self.private)

    def approve_new(self):
        self.receipt['decisions'] = [{**{k: SELECT.identity(self.new)[k] for k in ('sourceSha256', 'outputSha256')},
                                      'decision': 'approved'}]

    def supersede(self):
        self.receipt['supersessions'] = [{'sourceSha256': self.old['source']['sha256'],
                                         'oldOutputSha256': self.old['output']['sha256'],
                                         'newOutputSha256': self.new['output']['sha256'],
                                         'justification': 'User explicitly replaced this exact older approval.'}]

    def test_exact_selection_aliases_pending_and_determinism(self):
        result = self.build()
        self.assertEqual(result, self.build())
        self.assertTrue(result['valid'])
        self.assertEqual(result['summary']['selectedSources'], 1)
        self.assertEqual(result['summary']['unapprovedSources'], 1)
        self.assertEqual(result['summary']['excludedExperimentRows'], 1)
        chosen = result['selected'][0]
        self.assertEqual(chosen['output'], self.old['output'])
        self.assertEqual(chosen['aliases'], ['SceneA', 'SceneB-state'])
        self.assertEqual({i['id'] for i in chosen['identities']}, {'old', 'new'})
        self.assertEqual({i['sourceBinding']['state'] for i in chosen['identities']}, {'old', 'new'})

    def test_receipt_selects_new_only_when_old_is_rework(self):
        self.export['decisions'][0]['decision'] = 'rework'
        self.approve_new()
        result = self.build()
        self.assertEqual(result['selected'][0]['output'], self.new['output'])
        self.assertEqual(result['selected'][0]['approvalEvidence'][0]['receiptId'], 'test-user')

    def test_multiple_approvals_quarantined_not_latest_wins(self):
        self.approve_new()
        result = self.build()
        self.assertFalse(result['valid'])
        self.assertEqual(result['selected'], [])
        self.assertEqual(len(result['conflicts'][0]['approvedChoices']), 2)

    def test_exact_justified_latest_rework_supersession(self):
        self.approve_new()
        self.supersede()
        self.assertEqual(self.build()['selected'][0]['output'], self.new['output'])
        self.receipt['supersessions'][0]['justification'] = ''
        with self.assertRaisesRegex(ValueError, 'supersession'):
            self.build()

    def test_supersession_cannot_target_nonlatest_or_nonrework(self):
        self.approve_new()
        self.supersede()
        for field, value in [('startedAt', '2026-10-21T09:00:00Z'), ('provenance', {'experimentId': 'ordinary'})]:
            with self.subTest(field=field):
                before = self.new[field]
                self.new[field] = value
                with self.assertRaisesRegex(ValueError, 'latest rework'):
                    self.build()
                self.new[field] = before

    def test_stale_export_manifest_and_identity_rejected(self):
        self.export['manifestSha256'] = 'unrelated'
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.build()
        self.export['manifestSha256'] = 'previous'
        self.export['decisions'][0]['outputSha256'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.build()

    def test_duplicate_or_incomplete_envelope_rejected(self):
        self.export['decisions'].append(copy.deepcopy(self.export['decisions'][0]))
        with self.assertRaisesRegex(ValueError, 'Duplicate or incomplete'):
            self.build()

    def test_stale_receipt_and_unapprovable_rejected(self):
        self.approve_new()
        self.receipt['decisions'][0]['outputSha256'] = 'stale'
        with self.assertRaisesRegex(ValueError, 'receipt artifact'):
            self.build()
        self.approve_new()
        self.new['canApprove'] = False
        with self.assertRaisesRegex(ValueError, 'receipt artifact'):
            self.build()

    def test_tampered_bytes_dimensions_and_private_boundary_rejected(self):
        for change in ('hash', 'dimensions', 'path'):
            with self.subTest(change=change):
                before = copy.deepcopy(self.old['output'])
                if change == 'hash':
                    self.old['output']['sha256'] = 'wrong'
                    for records in (self.export['candidates'], self.export['decisions']):
                        records[0]['outputSha256'] = 'wrong'
                elif change == 'dimensions':
                    self.old['output']['dimensions'] = [99, 99]
                else:
                    self.old['output']['path'] = '/etc/passwd'
                with self.assertRaisesRegex(ValueError, 'mismatch|escapes'):
                    self.build()
                self.old['output'] = before
                for records in (self.export['candidates'], self.export['decisions']):
                    records[0]['outputSha256'] = before['sha256']

    def test_conflicted_approval_bytes_also_verified(self):
        self.approve_new()
        Path(self.new['output']['path']).write_bytes(b'not an image')
        with self.assertRaises(OSError):
            self.build()

    def test_relative_url_resolves_offline_and_cannot_escape(self):
        for r in (self.old, self.new):
            r['source']['url'] = Path(r['source'].pop('path')).name
        self.assertTrue(self.build()['valid'])
        self.old['source']['url'] = 'https://invalid.example/source.png'
        with self.assertRaisesRegex(ValueError, 'local path'):
            self.build()

    def test_cli_dry_default_exclusive_output_and_permissions(self):
        self.flush()
        command = [sys.executable, SELECT.__file__, '--catalog', str(self.catalog_path),
                   '--review-export', str(self.export_path), '--accepted-artifacts', str(self.receipt_path),
                   '--private-root', str(self.private)]
        before = sorted(self.private.iterdir())
        run = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertIsNone(json.loads(run.stdout)['output'])
        self.assertEqual(before, sorted(self.private.iterdir()))
        output = self.private / 'selection.json'
        subprocess.run(command + ['--output', str(output)], check=True, capture_output=True)
        original = output.read_bytes()
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        rerun = subprocess.run(command + ['--output', str(output)], capture_output=True)
        self.assertEqual(rerun.returncode, 2)
        self.assertEqual(original, output.read_bytes())
        outside = subprocess.run(command + ['--output', str(Path(self.tmp.name) / 'public.json')], capture_output=True)
        self.assertEqual(outside.returncode, 2)


if __name__ == '__main__':
    unittest.main()
