# SPDX-License-Identifier: GPL-3.0-or-later
"""Public tests use only synthetic colored disks, never game artwork."""
import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from common import PROJECT, output_directory
from package_cursors import package


class OutputPolicyTest(unittest.TestCase):
    def test_rejects_source_directories_and_output_root(self):
        for path in [PROJECT, PROJECT/'scripts', PROJECT/'outputs', PROJECT/'outputs/../scripts']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                output_directory(path)

    def test_allows_nested_private_output(self):
        self.assertEqual(output_directory(PROJECT/'outputs/unit-pack'), (PROJECT/'outputs/unit-pack').resolve())

    def test_rejects_symlink_escape(self):
        (PROJECT/'outputs').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=PROJECT/'outputs') as temporary:
            link = Path(temporary)/'escape'
            link.symlink_to(PROJECT/'scripts', target_is_directory=True)
            with self.assertRaises(ValueError):
                output_directory(link/'not-private')


class PackagingTest(unittest.TestCase):
    def test_synthetic_pack_and_explicit_archive_allowlist(self):
        (PROJECT/'outputs').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=PROJECT/'outputs') as temporary:
            output = Path(temporary)/'synthetic'
            output.mkdir()
            rows = [dict(row=row, name=f'fixture-{row}', hotspot=[16, 16]) for row in range(7)]
            (output/'build.json').write_text(json.dumps(dict(version=1, rows=rows)))
            # Packaging tests do not pretend that this is a valid Blender file.
            (output/'hd-cursor.blend').write_bytes(b'Synthetic packaging fixture, not a Blender scene')
            (output/'do-not-publish.txt').write_text('Private unrelated note')
            for row in rows:
                folder = output/'sprites'/f"r{row['row']}-{row['name']}"
                folder.mkdir(parents=True)
                for ordinal in range(3):
                    image = Image.new('RGBA', (1024, 1024))
                    draw = ImageDraw.Draw(image)
                    draw.ellipse((256+ordinal*16, 256, 768+ordinal*16, 768), fill=(70, 130, 190, 255))
                    image.save(folder/f'f{ordinal}-clay-1024.png')
            with contextlib.redirect_stdout(io.StringIO()):
                package(output)
            manifest = json.loads((output/'cursor.json').read_text())
            self.assertEqual(len(manifest['frames']), 21)
            self.assertEqual(manifest['mediaRights']['status'], 'not-evaluated')
            with Image.open(output/'sprite-sheet-128.png') as atlas:
                self.assertEqual(atlas.size, (384, 896))
                self.assertEqual(atlas.getpixel((0, 0))[3], 0)
            with zipfile.ZipFile(output.with_suffix('.zip')) as archive:
                self.assertIsNone(archive.testzip())
                self.assertNotIn('hd-cursor/do-not-publish.txt', archive.namelist())
                checksums = archive.read('hd-cursor/SHA256SUMS').decode()
                self.assertNotIn('do-not-publish', checksums)
                self.assertIn('hd-cursor/cursor.json', archive.namelist())


class DocumentationTest(unittest.TestCase):
    def test_local_markdown_links_resolve(self):
        for path in [PROJECT/'README.md', PROJECT/'LICENSE.md', *sorted((PROJECT/'docs').glob('*.md'))]:
            for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
                target = target.split('#', 1)[0]
                if target and not re.match(r'[a-z]+:', target, re.I):
                    self.assertTrue((path.parent/target).exists(), f'{path}: {target}')

    def test_parent_source_archive_excludes_private_cursor_directories(self):
        script = PROJECT.parent.parent/'scripts/package-sources.mjs'
        if not script.is_file():
            self.skipTest('Parent Neverhood source packager is not present')
        source = script.read_text()
        # Evaluate the actual shared path filter without running the release build.
        pattern = source.split('const privateUpscaling = /', 1)[1].split('/i;', 1)[0]
        pattern = re.compile(pattern.replace(r'\/', '/'), re.I)
        for path in ['tools/hd-cursor/outputs/inputs/gestures.json',
                     'tools/hd-cursor/outputs/verification-pack.zip',
                     'tools/hd-cursor/models/input.blend']:
            self.assertIsNotNone(pattern.search(path), path)
        self.assertIsNone(pattern.search('tools/hd-cursor/scripts/build_cursors.py'))
        self.assertIn("'tools/hd-cursor'", source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
