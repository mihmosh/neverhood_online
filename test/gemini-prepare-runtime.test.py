#!/usr/bin/env python3
"""Synthetic offline normalization, provenance and filesystem safety tests."""
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
SPEC = importlib.util.spec_from_file_location('prepare_runtime', ROOT / 'tools/upscaling/gemini/prepare-runtime.py')
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class PrepareRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp/kilo')
        self.addCleanup(self.tmp.cleanup)
        self.private = Path(self.tmp.name) / 'private-assets'
        self.private.mkdir()
        self.selection_path = self.private / 'selection.json'
        self.output = self.private / 'runtime'
        source = self.image('source', (8, 6))
        approved = self.image('approved', (19, 13))
        identity = {'id': 'approved-row', 'candidateId': 'candidate', 'sourceSha256': source['sha256'],
                    'outputSha256': approved['sha256'], 'roomId': 'room', 'resourceId': '0x12345678',
                    'aliases': ['SceneA', 'SceneB'], 'sourceBinding': {'entry': {'hash': 123},
                    'decoding': {'dimensions': [8, 6]}}, 'additionalSources': [{'state': 'other'}]}
        self.item = {'sourceSha256': source['sha256'], 'source': source, 'output': approved,
                     'artifactId': source['sha256'] + ':' + approved['sha256'],
                     'identities': [identity], 'candidateIdentities': [copy.deepcopy(identity)],
                     'aliases': identity['aliases'], 'sourcePaths': [source['path']],
                     'outputPaths': [approved['path']],
                     'approvalEvidence': [{'kind': 'human-receipt', 'receiptId': 'user-approved'}]}
        self.selection = {'schemaVersion': 1, 'private': True, 'valid': True,
                          'purpose': 'offline-human-approved-release-selection',
                          'catalogManifestSha256': 'catalog', 'inputs': [],
                          'summary': {'sourceCount': 1, 'selectedSources': 1,
                                      'unapprovedSources': 0, 'conflictedSources': 0},
                          'selected': [self.item], 'unapproved': [], 'conflicts': []}

    def image(self, name, size, mode='RGB'):
        path = self.private / (name + '.png')
        image = Image.new(mode, size)
        for y in range(size[1]):
            for x in range(size[0]):
                pixel = (x * 17 % 256, y * 29 % 256, (x + y) * 13 % 256)
                image.putpixel((x, y), pixel + (255,) if mode == 'RGBA' else pixel)
        image.save(path)
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'dimensions': list(size)}

    def flush(self):
        self.selection_path.write_text(json.dumps(self.selection))

    def run_prepare(self, execute=False, allow_partial=False, output=None):
        self.flush()
        return PREPARE.prepare(self.selection_path, self.private,
                               output if output is not None else self.output if execute else None,
                               execute, allow_partial)

    def test_dry_report_no_writes_deterministic_full_provenance(self):
        self.flush()
        before = {p: p.read_bytes() for p in self.private.iterdir()}
        result = self.run_prepare()
        self.assertEqual(result, self.run_prepare())
        self.assertEqual(before, {p: p.read_bytes() for p in self.private.iterdir()})
        artifact = result['artifacts'][0]
        self.assertEqual(artifact['runtime']['dimensions'], [32, 24])
        self.assertIsNone(artifact['runtime']['sha256'])
        self.assertEqual(artifact['aliases'], ['SceneA', 'SceneB'])
        self.assertEqual(artifact['identities'], self.item['identities'])
        self.assertEqual(artifact['sourceBindings'][0]['sourceBinding'], self.item['identities'][0]['sourceBinding'])
        self.assertEqual(artifact['sourceBindings'][0]['additionalSources'], [{'state': 'other'}])
        self.assertEqual(artifact['approvalEvidence'], self.item['approvalEvidence'])
        self.assertEqual(result['selection']['sha256'], PREPARE.digest(self.selection_path.read_bytes()))

    def test_lossless_opaque_lanczos_geometry_original_bytes_and_derived_hash(self):
        originals = {Path(self.item[k]['path']): Path(self.item[k]['path']).read_bytes() for k in ('source', 'output')}
        result = self.run_prepare(execute=True)
        artifact = result['artifacts'][0]
        runtime = self.output / artifact['runtime']['path']
        with Image.open(runtime) as actual, Image.open(self.item['output']['path']) as approved:
            expected = approved.convert('RGB').resize((32, 24), Image.Resampling.LANCZOS)
            self.assertEqual(actual.format, 'PNG')
            self.assertEqual(actual.size, (32, 24))
            self.assertEqual(actual.tobytes(), expected.tobytes())
            self.assertEqual(actual.convert('RGBA').getchannel('A').getextrema(), (255, 255))
        self.assertEqual(artifact['runtime']['sha256'], PREPARE.digest(runtime.read_bytes()))
        self.assertEqual(artifact['output']['sha256'], self.item['output']['sha256'])
        self.assertIn('version', artifact['transform']['software'])
        self.assertFalse(artifact['transform']['crop'])
        self.assertFalse(artifact['transform']['padding'])
        self.assertEqual(json.loads((self.output / 'runtime-manifest.json').read_text()), result)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o600)
        self.assertEqual(originals, {p: p.read_bytes() for p in originals})
        second = self.run_prepare(execute=True, output=self.private / 'runtime-second')
        self.assertEqual(second, result)

    def test_nonstandard_native_dimensions_retain_all_500_rows(self):
        source = self.image('Scene1402', (640, 500))
        old_hash = self.item['sourceSha256']
        self.item.update(source=source, sourceSha256=source['sha256'], sourcePaths=[source['path']],
                         artifactId=source['sha256'] + ':' + self.item['output']['sha256'])
        for identity in self.item['identities'] + self.item['candidateIdentities']:
            self.assertEqual(identity['sourceSha256'], old_hash)
            identity['sourceSha256'] = source['sha256']
        result = self.run_prepare(execute=True)
        path = self.output / result['artifacts'][0]['runtime']['path']
        with Image.open(path) as image:
            self.assertEqual(image.size, (2560, 2000))

    def test_hash_dimension_approval_and_alias_mismatches_fail_before_writes(self):
        original = copy.deepcopy(self.item)
        for field in ('source-hash', 'output-hash', 'source-size', 'output-size', 'approval', 'aliases'):
            with self.subTest(field=field):
                self.item.clear()
                self.item.update(copy.deepcopy(original))
                if field.endswith('hash'):
                    self.item[field.split('-')[0]]['sha256'] = 'a' * 64
                elif field.endswith('size'):
                    self.item[field.split('-')[0]]['dimensions'] = [999, 888]
                elif field == 'approval':
                    self.item['approvalEvidence'] = []
                else:
                    self.item['aliases'] = ['missing']
                with self.assertRaises(ValueError):
                    self.run_prepare(execute=True)
                self.assertFalse(self.output.exists())

    def test_transparent_and_non_png_rejected(self):
        path = Path(self.item['output']['path'])
        for fmt in ('transparent', 'JPEG'):
            with self.subTest(fmt=fmt):
                image = Image.new('RGBA' if fmt == 'transparent' else 'RGB', (19, 13))
                image.save(path, format='PNG' if fmt == 'transparent' else fmt)
                new_hash = PREPARE.digest(path.read_bytes())
                self.item['output']['sha256'] = new_hash
                self.item['artifactId'] = self.item['sourceSha256'] + ':' + new_hash
                self.item['candidateIdentities'][0]['outputSha256'] = new_hash
                with self.assertRaisesRegex(ValueError, 'opaque|PNG'):
                    self.run_prepare(execute=True)
                self.assertFalse(self.output.exists())

    def test_changed_bytes_and_duplicate_paths_are_verified(self):
        for kind in ('source', 'output'):
            path = Path(self.item[kind]['path'])
            before = path.read_bytes()
            with self.subTest(kind=kind):
                path.write_bytes(before + b'changed-after-approval')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    self.run_prepare(execute=True)
                self.assertFalse(self.output.exists())
                path.write_bytes(before)
            paths = self.item[kind + 'Paths']
            alternate = self.private / ('alternate-' + kind + '.png')
            alternate.write_bytes(before)
            paths.append(str(alternate))
            self.run_prepare()
            alternate.write_bytes(before + b'changed-alias')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                self.run_prepare(execute=True)
            self.assertFalse(self.output.exists())
            paths.pop()

    def test_opaque_rgba_input_preserves_rgb_pixels(self):
        approved = self.image('opaque-rgba', (17, 11), mode='RGBA')
        self.item['output'] = approved
        self.item['outputPaths'] = [approved['path']]
        self.item['artifactId'] = self.item['sourceSha256'] + ':' + approved['sha256']
        self.item['candidateIdentities'][0]['outputSha256'] = approved['sha256']
        result = self.run_prepare(execute=True)
        with Image.open(self.output / result['artifacts'][0]['runtime']['path']) as actual:
            with Image.open(approved['path']) as original:
                expected = original.convert('RGB').resize((32, 24), Image.Resampling.LANCZOS)
                self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_incomplete_selection_requires_partial_even_if_valid(self):
        self.selection['unapproved'] = [{'sourceSha256': 'a' * 64}]
        self.selection['summary'].update(sourceCount=2, unapprovedSources=1)
        with self.assertRaisesRegex(ValueError, 'allow-partial'):
            self.run_prepare(execute=True)
        self.assertFalse(self.output.exists())
        self.assertTrue(self.run_prepare()['partial'])

    def test_partial_gate_quarantine_and_duplicate_rejection(self):
        self.selection['valid'] = False
        self.selection['unapproved'] = [{'sourceSha256': 'a' * 64}]
        self.selection['conflicts'] = [{'sourceSha256': 'b' * 64}]
        self.selection['summary'].update(sourceCount=3, unapprovedSources=1, conflictedSources=1)
        self.assertTrue(self.run_prepare()['partial'])
        with self.assertRaisesRegex(ValueError, 'allow-partial'):
            self.run_prepare(execute=True)
        self.assertFalse(self.output.exists())
        result = self.run_prepare(execute=True, allow_partial=True)
        self.assertEqual(len(result['artifacts']), 1)
        self.assertEqual({p.name for p in self.output.iterdir()},
                         {self.item['sourceSha256'] + '.png', 'runtime-manifest.json'})
        self.selection['conflicts'][0]['sourceSha256'] = self.item['sourceSha256']
        with self.assertRaisesRegex(ValueError, 'quarantined'):
            self.run_prepare(allow_partial=True)

    def test_exclusive_output_symlinks_and_escape(self):
        self.output.mkdir()
        sentinel = self.output / 'sentinel'
        sentinel.write_bytes(b'untouched')
        with self.assertRaises(FileExistsError):
            self.run_prepare(execute=True)
        self.assertEqual(sentinel.read_bytes(), b'untouched')
        linked = self.private / 'linked'
        linked.symlink_to(self.output, target_is_directory=True)
        for path in (linked, linked / 'new', Path(self.tmp.name) / 'outside', self.private / '..' / 'escape'):
            with self.subTest(path=path), self.assertRaises((OSError, ValueError)):
                self.run_prepare(execute=True, output=path)
        original = self.item['output']['path']
        for path in (linked / Path(original).name, self.private / 'linked-file.png'):
            if path.name == 'linked-file.png':
                path.symlink_to(original)
            self.item['output']['path'] = str(path)
            with self.assertRaises(OSError):
                self.run_prepare()
        self.item['output']['path'] = original
        selection_link = self.private / 'selection-link.json'
        selection_link.symlink_to(self.selection_path)
        with self.assertRaises(OSError):
            PREPARE.prepare(selection_link, self.private)

    def test_cli_requires_explicit_execution_and_reports_default(self):
        self.flush()
        command = [sys.executable, PREPARE.__file__, '--selection', str(self.selection_path),
                   '--private-root', str(self.private)]
        run = subprocess.run(command, text=True, capture_output=True, check=True)
        self.assertFalse(json.loads(run.stdout)['executed'])
        self.assertFalse(self.output.exists())
        for flags in (['--execute'], ['--output', str(self.output)]):
            run = subprocess.run(command + flags, text=True, capture_output=True)
            self.assertEqual(run.returncode, 2)
            self.assertFalse(self.output.exists())
        run = subprocess.run(command + ['--execute', '--output', str(self.output)],
                             text=True, capture_output=True, check=True)
        self.assertTrue(json.loads(run.stdout)['executed'])

    def test_individual_artifacts_are_exclusive_including_symlinks(self):
        fd = PREPARE.directory_fd(self.private)
        try:
            PREPARE.write_exclusive(fd, 'exclusive.png', b'first')
            with self.assertRaises(FileExistsError):
                PREPARE.write_exclusive(fd, 'exclusive.png', b'replacement')
            (self.private / 'exclusive-link.png').symlink_to(self.private / 'exclusive.png')
            with self.assertRaises(FileExistsError):
                PREPARE.write_exclusive(fd, 'exclusive-link.png', b'replacement')
            self.assertEqual((self.private / 'exclusive.png').read_bytes(), b'first')
        finally:
            PREPARE.os.close(fd)


if __name__ == '__main__':
    unittest.main()
