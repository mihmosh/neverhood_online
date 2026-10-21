"""Focused offline mapping, ghost, hold and readable-label tests."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

SPEC = importlib.util.spec_from_file_location('triplicate', Path(__file__).with_name('compare-triplicate-probe.py'))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def mapping_fixture():
    original = {'timeline': [{'sourceOrdinal': min(max(i - 8, 0), 31), 'rgbFile': f'rgb/{i}.png',
                              'rgbSHA256': f'{i:064d}'} for i in range(49)]}
    mapping = {'fps': 45, 'clipFrameCount': 149, 'canvas': [384, 216],
               'selectedMiddleIndices': [1 + 3 * i for i in range(49)],
               'coreMiddleIndices': [25 + 3 * i for i in range(32)], 'timeline': []}
    for i in range(149):
        clip = min(i // 3, 48)
        selected = i < 147 and i % 3 == 1
        source = original['timeline'][clip]
        mapping['timeline'].append({'outputFrame': i, 'originalClipFrame': clip,
            'sourceOrdinal': source['sourceOrdinal'], 'originalRGBFile': source['rgbFile'],
            'originalRGBSHA256': source['rgbSHA256'], 'selected': selected,
            'useForQuality': selected and 8 <= clip <= 39,
            'role': 'endpad' if i >= 147 else 'middle' if selected else 'other'})
    return original, mapping


class TriplicateTests(unittest.TestCase):
    def test_mapping_all_49_centers_core_and_padding(self):
        original, mapping = mapping_fixture()
        indices = module.validate_mapping(mapping, original)
        self.assertEqual(indices, list(range(1, 146, 3)))
        self.assertEqual(indices[8:40], list(range(25, 119, 3)))
        self.assertEqual([mapping['timeline'][i]['originalClipFrame'] for i in indices], list(range(49)))
        self.assertNotIn(147, indices)
        self.assertNotIn(148, indices)
        for change in ('sparse', 'wrong_core', 'wrong_source', 'pad_selected'):
            broken = copy.deepcopy(mapping)
            if change == 'sparse':
                broken['selectedMiddleIndices'].pop(12)
            elif change == 'wrong_core':
                broken['coreMiddleIndices'][0] = 24
            elif change == 'wrong_source':
                broken['timeline'][28]['sourceOrdinal'] = 0
            else:
                broken['timeline'][148]['selected'] = True
            with self.assertRaises(ValueError):
                module.validate_mapping(broken, original)

    def test_actual_mapping_schema_when_explicitly_supplied(self):
        root = os.environ.get('TRIPLICATE_TEST_INPUT')
        original = os.environ.get('ORIGINAL_TEST_INPUT')
        if not root or not original:
            self.skipTest('Optional explicit local input paths not supplied')
        mapping = module.load(Path(root) / 'triplicate-mapping.json')
        source = module.load(Path(original) / 'source-metadata.json')
        self.assertEqual(len(module.validate_mapping(mapping, source)), 49)
        self.assertEqual(module.sha(Path(original) / 'input.mp4'), mapping['originalInputSHA256'])
        self.assertEqual(module.sha(Path(root) / 'input.mp4'), mapping['inputSHA256'])

    def test_ghost_ratio_is_descriptive_and_zero_safe(self):
        source = np.full((2, 2, 3), 128, dtype=np.uint8)
        current = np.array([[255, 0], [0, 0]], dtype=np.uint8)
        following = np.array([[255, 255], [0, 0]], dtype=np.uint8)
        before = module.expand(source)
        before[:4, 4:] = 148
        after = module.expand(source)
        after[:4, 4:] = 133
        result = module.ghost_metric(source, before, after, current, following)
        self.assertEqual(result['regionOutputPixels'], 16)
        self.assertEqual(result['meanAbsoluteRGBDepartureFrom128'], {'nativeInput': 0, 'baseline': 20, 'triplicateCenter': 5})
        self.assertEqual(result['afterOverBeforeRatio'], .25)
        self.assertEqual(result['relativeReduction'], .75)
        self.assertIsNone(module.ghost_metric(source, module.expand(source), after, current, following)['afterOverBeforeRatio'])

    def test_holds_use_selected49_not_adjacent149_or_moving_frames(self):
        called = []
        def reader(index):
            called.append(module.CENTERS[index])
            return np.full((864, 1536, 3), index, dtype=np.uint8)
        masks = [np.full((216, 384), 255, dtype=np.uint8)] * 32
        result = module.hold_metrics(reader, masks)
        self.assertEqual(called, module.CENTERS[:9] + module.CENTERS[39:49])
        self.assertEqual(len(result['first']['adjacentMAE']), 8)
        self.assertEqual(len(result['last']['adjacentMAE']), 9)
        self.assertEqual(result['first']['meanMAE'], 1)

    def test_labels_and_raw_pixels(self):
        image = np.full((864, 1536, 3), [128, 140, 150], dtype=np.uint8)
        for thumbnail, bar, width, height in [(False, 180, 1536, 864), (True, 72, 512, 288)]:
            panel = np.asarray(module.panel([image] * 3, 0, 'raw', '3b', thumbnail))
            self.assertEqual(panel.shape, (bar + height, width * 3, 3))
            self.assertTrue(np.all(panel[bar:] == [128, 140, 150]))
            white = np.all(panel[:42 if thumbnail else 100] > 240, axis=2)
            self.assertGreaterEqual(int(white.any(axis=1).sum()), 23 if thumbnail else 60)

    def test_all149_files_required_not_only_centers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frames = root / 'frames/input'
            frames.mkdir(parents=True)
            first = frames / 'input_000000.png'
            Image.new('RGB', module.SIZE, '#808080').save(first)
            for i in range(1, 149):
                shutil.copyfile(first, frames / f'input_{i:06d}.png')
            digest = module.sha(first)
            report = {'status': 'succeeded', 'input': {'sha256': 'inputhash', 'nb_read_frames': '149', 'avg_frame_rate': '45/1'},
                      'output': {'files': [{'file': f'input_{i:06d}.png', 'sha256': digest} for i in range(149)]}}
            (root / 'report.json').write_text(json.dumps(report))
            self.assertIsNone(module.validate_run(root, 149, 45, 'inputhash', '3b')['gpuMemory'])
            (frames / 'input_000148.png').unlink()
            with self.assertRaisesRegex(ValueError, '149 contiguous'):
                module.validate_run(root, 149, 45, 'inputhash', '3b')

    def test_partial_never_encodes_or_fabricates_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(module, 'encode', side_effect=AssertionError('no media')):
                result = module.main(['--variant', '3b', '--input-dir', str(root / 'input'),
                    '--triplicate-input-dir', str(root / 'triple'), '--baseline-results-dir', str(root / 'baseline'),
                    '--triplicate-results-dir', str(root / 'runs'), '--output', str(root / 'analysis')])
            self.assertEqual(result, 2)
            self.assertEqual(sorted(p.name for p in (root / 'analysis').iterdir()), ['index.html', 'report.json'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'Local ffmpeg/ffprobe required')
    def test_new_video_encoder_streams32_core_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = np.full((864, 1536, 3), 128, dtype=np.uint8)
            module.encode(Path(tmp), 'comparison-raw-15fps.mp4',
                          (module.panel([image] * 3, i, 'raw', '3b') for i in range(32)))
            self.assertGreater((Path(tmp) / 'comparison-raw-15fps.mp4').stat().st_size, 1000)


if __name__ == '__main__':
    unittest.main()
