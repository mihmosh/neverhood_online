# SPDX-License-Identifier: GPL-3.0-or-later
"""Optional integration checks against a built pack; see README for environment variables."""
import hashlib
import json
import os
import struct
import sys
import unittest
import zipfile
from pathlib import Path

from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from common import DEFAULT_CHECKPOINT, DEFAULT_OUTPUT

PACK = Path(os.environ.get('HD_CURSOR_PACK_DIR', DEFAULT_OUTPUT)).resolve()
SOURCE = Path(os.environ.get('HD_CURSOR_CHECKPOINT_DIR', DEFAULT_CHECKPOINT)).resolve()


@unittest.skipUnless((PACK/'cursor.json').exists(), 'Private HD cursor pack has not been built')
class CursorPackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((PACK/'cursor.json').read_text())

    def test_complete_gestures_and_hotspots(self):
        self.assertEqual([r['row'] for r in self.manifest['rows']], list(range(7)))
        self.assertEqual([r['hotspot'] for r in self.manifest['rows']],
                         [[15, 5], [17, 25], [17, 30], [14, 1], [3, 7], [30, 18], [1, 18]])
        self.assertEqual({(f['row'], f['ordinal']) for f in self.manifest['frames']},
                         {(r, f) for r in range(7) for f in range(3)})
        self.assertEqual(self.manifest['phaseMapping'], [0, 0, 1, 1, 2, 2])
        self.assertEqual(self.manifest['poseDurationMs'], 82)

    def test_true_solid_geometry(self):
        for row in self.manifest['rows']:
            self.assertEqual(row['nonManifoldEdges'], 0)
            self.assertGreater(row['volume'], 0)
            self.assertGreater(row['vertices'], 1000)

    def test_master_depth_and_transparency(self):
        for frame in self.manifest['frames']:
            data = (PACK/frame['master']).read_bytes()
            self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
            self.assertEqual(struct.unpack('>IIBB', data[16:26]), (1024, 1024, 16, 6))
            with Image.open(PACK/frame['image']) as image:
                self.assertEqual(image.mode, 'RGBA')
                self.assertEqual(image.size, (128, 128))
                self.assertEqual(image.getpixel((0, 0))[3], 0)
                alpha = image.getchannel('A')
                self.assertEqual(alpha.getextrema(), (0, 255))
                self.assertGreater(sum(alpha.histogram()[1:255]), 0)

    def test_atlas_cells(self):
        with Image.open(PACK/self.manifest['image']) as atlas:
            self.assertEqual(atlas.size, (384, 896))
            for frame in self.manifest['frames']:
                x, y, w, h = frame['atlasRect']
                with Image.open(PACK/frame['image']) as sprite:
                    self.assertIsNone(ImageChops.difference(atlas.crop((x, y, x+w, y+h)), sprite).getbbox())

    def test_original_pointer_preserved(self):
        if not (SOURCE/'cursor-fitted.blend').is_file():
            self.skipTest('Set HD_CURSOR_CHECKPOINT_DIR to check input preservation')
        self.assertEqual(self.manifest['sourceSHA256'], hashlib.sha256((SOURCE/'cursor-fitted.blend').read_bytes()).hexdigest())
        for ordinal in range(3):
            self.assertEqual((PACK/f'sprites/r4-pointer/f{ordinal}-clay-1024.png').read_bytes(),
                             (SOURCE/f'f{ordinal}-clay-1024.png').read_bytes())

    def test_animations(self):
        for row in self.manifest['rows']:
            with Image.open(PACK/f"sprites/r{row['row']}-{row['name']}/animation.webp") as image:
                self.assertEqual(image.n_frames, 3)
                previous = None
                for ordinal in range(3):
                    image.seek(ordinal)
                    image.load()
                    self.assertEqual(image.info['duration'], 82)
                    pixels = image.convert('RGBA').tobytes()
                    self.assertNotEqual(previous, pixels)
                    previous = pixels

    def test_checksums_and_archive(self):
        for line in (PACK/'SHA256SUMS').read_text().splitlines():
            digest, relative = line.split('  ', 1)
            self.assertEqual(hashlib.sha256((PACK/relative).read_bytes()).hexdigest(), digest)
        with zipfile.ZipFile(PACK.with_suffix('.zip')) as archive:
            self.assertIsNone(archive.testzip())
            files = [PACK/line.split('  ', 1)[1] for line in (PACK/'SHA256SUMS').read_text().splitlines()]
            files.append(PACK/'SHA256SUMS')
            self.assertEqual(len(archive.namelist()), len(files))
            for path in files:
                self.assertEqual(archive.read(f'hd-cursor/{path.relative_to(PACK)}'), path.read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
