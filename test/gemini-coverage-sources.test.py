import importlib.util
import json
import stat
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

SPEC = importlib.util.spec_from_file_location('coverage_sources', Path(__file__).resolve().parents[1] / 'tools/upscaling/gemini/coverage-sources.py')
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


def article(src='image.png', href=None, digest='a' * 64, scene='HallOfRecordsScene', resource='0x00000001'):
    return f'<article><h2>{scene} / {resource}</h2><a href="{href or src}"><img src="{src}"></a><small>SHA-256: {digest}</small></article>'


class ParsingTests(unittest.TestCase):
    def setUp(self):
        self.private = Path('/workspace/private-assets')
        self.page = self.private / 'review.html'

    def parse(self, text, count=1):
        return C.parse_page(text.encode(), self.page, self.private, count)

    def test_exact_image_link_and_sha(self):
        parsed = self.parse(article())
        self.assertEqual(parsed[0]['sha256'], 'a' * 64)
        self.assertEqual(parsed[0]['path'], str(self.private / 'image.png'))

    def test_duplicate_img_and_src_rejected(self):
        for markup in (article().replace('<img src="image.png">', '<img src="image.png"><img src="image.png">'),
                       article().replace('<img src="image.png">', '<img src="image.png" src="other.png">')):
            with self.subTest(markup=markup), self.assertRaises(ValueError):
                self.parse(markup)

    def test_duplicate_anchor_attributes_rejected(self):
        with self.assertRaises(ValueError):
            self.parse(article().replace('href="image.png"', 'href="image.png" href="other.png"'))

    def test_thumbnail_link_must_match_visible_image(self):
        with self.assertRaisesRegex(ValueError, 'Thumbnail'):
            self.parse(article(src='thumb.png', href='original.png'))
        self.assertEqual(self.parse(article(src='sub/../image.png'))[0]['path'], str(self.private / 'image.png'))

    def test_private_traversal_and_network_rejected(self):
        for path in ('../public/image.png', '%2e%2e/public/image.png', 'https://example.org/image.png', '//example.org/image.png'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.parse(article(path))

    def test_exact_39_and_no_duplicate_picture_skipping(self):
        markup = ''.join(article(digest=f'{i:064x}') for i in range(39))
        self.assertEqual(len(C.parse_page(markup.encode(), self.page, self.private)), 39)
        with self.assertRaises(ValueError):
            C.parse_page((markup + article()).encode(), self.page, self.private)
        with self.assertRaises(ValueError):
            self.parse(article() + article(), 2)

    def test_outside_article_image_is_not_silently_ignored(self):
        with self.assertRaises(ValueError):
            self.parse(article() + '<img src="omitted.png">')


class FreezeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / 'private-assets'
        self.private.mkdir()
        self.page = self.private / 'review.html'
        self.registry = self.private / 'registry.json'
        self.output = self.private / 'selection.json'
        self.archive = self.private / 'audit/authorization-page.html'
        evidence_path = self.private / 'evidence.bin'
        evidence_path.write_bytes(b'fixture evidence; binary replay mocked in synthetic tests')
        evidence = {'path': str(evidence_path), 'sha256': C.sha(evidence_path.read_bytes())}
        originals, aliases, markup = [], [], []
        for i in range(39):
            path = self.private / f'{i}.png'
            dims = [640, 500] if i == 0 else [640, 480]
            Image.new('RGB', dims, (i, 42, 100)).save(path)
            digest = C.sha(path.read_bytes())
            _, rgb = C.inspect_png(path, digest)
            scene = 'Scene1402' if i == 0 else 'HallOfRecordsScene'
            resource = f'0x{i:08X}'
            originals.append({'catalogResourceId': f'catalog:{i}', 'indexedPixels': evidence, 'palette': evidence, 'payload': evidence})
            aliases.append({'scene': scene, 'resourceId': resource, 'sourcePath': str(path), 'sourceSha256': digest,
                            'rgbPixelSha256': rgb, 'dimensions': dims, 'catalogResourceId': f'catalog:{i}',
                            'codeBinding': evidence, 'paletteProofs': [], 'operations': [], 'boundPaletteSha256': evidence['sha256']})
            markup.append(article(src=path.name, digest=digest, scene=scene, resource=resource))
        self.page.write_text(''.join(markup))
        self.registry.write_text(json.dumps({'verifiedOriginals': originals, 'dispositions': aliases + [dict(aliases[1], state='another table binding')]}))
        self.node = patch.object(C.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout='{"verifiedBindings":40}', stderr=''))
        self.node.start()

    def tearDown(self):
        self.node.stop()
        self.temp.cleanup()

    def prepare(self):
        return C.prepare(self.root, self.page, self.registry, self.output, self.archive)

    def test_frozen_reuse_and_alias_preservation(self):
        doc = self.prepare()
        self.assertEqual(len(doc['rooms']), 39)
        self.assertEqual(len(doc['rooms'][1]['bindingAliases']), 2)
        self.assertEqual(doc['statistics']['hallOfRecordsUniqueBitmapResources'], 38)
        self.assertEqual(self.archive.read_bytes(), self.page.read_bytes())
        before = self.output.stat().st_mtime_ns
        self.assertEqual(self.prepare(), doc)
        self.assertEqual(self.output.stat().st_mtime_ns, before)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode), 0o444)

    def test_changed_page_cannot_regenerate_frozen_audit(self):
        self.prepare()
        self.page.write_bytes(self.page.read_bytes() + b'<!-- changed -->')
        with self.assertRaisesRegex(ValueError, 'Frozen artifact changed'):
            self.prepare()

    def test_changed_registry_cannot_regenerate_frozen_selection(self):
        self.prepare()
        self.registry.write_bytes(self.registry.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'Frozen artifact changed'):
            self.prepare()

    def test_png_sha_mismatch_stops_without_output(self):
        (self.private / '1.png').write_bytes(b'not original')
        with self.assertRaisesRegex(ValueError, 'PNG SHA mismatch'):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.archive.exists())

    def test_no_confident_binding_stops(self):
        registry = json.loads(self.registry.read_bytes())
        registry['dispositions'] = registry['dispositions'][1:]
        self.registry.write_text(json.dumps(registry))
        with self.assertRaisesRegex(ValueError, 'No exact path/SHA'):
            self.prepare()

    def test_nonopaque_png_rejected(self):
        path = self.private / 'alpha.png'
        Image.new('RGBA', (2, 2), (10, 20, 30, 0)).save(path)
        with self.assertRaisesRegex(ValueError, 'Nonopaque'):
            C.inspect_png(path, C.sha(path.read_bytes()))


if __name__ == '__main__':
    unittest.main()
