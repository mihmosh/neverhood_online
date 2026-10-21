"""Synthetic, local-only tests. No real results, AWS, inference, or network calls."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

SPEC = importlib.util.spec_from_file_location('comparison', Path(__file__).with_name('compare-seedvr2-aws.py'))
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)


class ComparisonTests(unittest.TestCase):
    def per_frame_fixture(self, root, inputs):
        folder = root / 'control'
        (folder / 'frames').mkdir(parents=True)
        meta = json.loads((inputs / 'source-metadata.json').read_text())
        first = folder / 'frames/input_000000.png'
        Image.new('RGB', comparison.SIZE, (200, 80, 30)).save(first)
        for i in range(1, 49):
            shutil.copyfile(first, folder / f'frames/input_{i:06d}.png')
        manifest = {'model': 'RealESRNet_x4plus', 'inputSHA256': comparison.sha256(inputs / 'input.mp4'),
                    'canvas': [1536, 864], 'codec': 'PNG normalized; upstream WebP Q90 (lossy)',
                    'provenance': {'cache': 'synthetic WebP Q90 provenance must remain visible'},
                    'sourceMapping': {'sourceMetadataSHA256': comparison.sha256(inputs / 'source-metadata.json'),
                                      'clipToSourceOrdinal': [min(max(i - 8, 0), 31) for i in range(49)]},
                    'frames': [{'clipFrame': i, 'file': f'frames/input_{i:06d}.png', 'sha256': comparison.sha256(first)} for i in range(49)]}
        (folder / 'metadata.json').write_text(json.dumps(manifest))
        return folder, meta, manifest

    def test_per_frame_contract_hash_mapping_and_gray_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs, _ = self.fixture(root)
            folder, meta, manifest = self.per_frame_fixture(root, inputs)
            control, paths = comparison.validate_per_frame(folder, meta, manifest['inputSHA256'], comparison.sha256(inputs / 'source-metadata.json'))
            self.assertIsNone(control['gpuMemory'])
            self.assertIn('WebP Q90', control['metadata']['codec'])
            masks = [np.zeros((216, 384), dtype=np.uint8) for _ in range(32)]
            masks[0][40:180, 140:240] = 255
            result = comparison.per_frame_rgb(paths, 8, masks, meta['timeline'])
            self.assertTrue(np.all(result[0, 0] == 128))
            self.assertEqual(tuple(result[200, 600]), (200, 80, 30))
            manifest['sourceMapping']['clipToSourceOrdinal'][9] = 30
            (folder / 'metadata.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'mapping identity'):
                comparison.validate_per_frame(folder, meta, manifest['inputSHA256'], comparison.sha256(inputs / 'source-metadata.json'))

    def test_four_method_quad_pixels_readability_and_preview_size(self):
        images = [np.full((864, 1536, 3), color, dtype=np.uint8) for color in (25, 75, 150, 225)]
        labels = ('ORIGINAL', 'Current RealESRNet', 'SeedVR2 3B', 'SeedVR2 7B')
        for preview, width, height, bar in [(False, 1536, 864, 180), (True, 768, 432, 72)]:
            result = np.asarray(comparison.quad_panel(images, labels, 0, 'raw', preview))
            self.assertEqual(result.shape, ((height + bar) * 2, width * 2, 3))
            for index, color in enumerate((25, 75, 150, 225)):
                x, y = index % 2 * width, index // 2 * (height + bar)
                self.assertTrue(np.all(result[y + bar:y + bar + height, x:x + width] == color))
                ink = np.all(result[y:y + (42 if preview else 100), x:x + width] > 240, axis=2)
                self.assertGreaterEqual(int(ink.any(axis=1).sum()), 23 if preview else 60)

    @unittest.skipUnless(os.environ.get('PER_FRAME_TEST_DIR'), 'Optional actual normalized control directory')
    def test_actual_per_frame_cache_contract(self):
        root = Path(os.environ['PER_FRAME_TEST_DIR'])
        inputs = Path(os.environ['ORIGINAL_TEST_INPUT'])
        meta = json.loads((inputs / 'source-metadata.json').read_text())
        control, paths = comparison.validate_per_frame(root, meta, comparison.sha256(inputs / 'input.mp4'), comparison.sha256(inputs / 'source-metadata.json'))
        self.assertEqual(len(paths), 49)
        self.assertIsNone(control['runtime'])
        self.assertIn('lossless', control['metadata']['codec'])

    @unittest.skipUnless(os.environ.get('FOUR_COMPARISON_DIRS'), 'Optional generated four-method comparisons')
    def test_four_generated_comparisons_metrics_pixels_browser(self):
        paths = [Path(p) for p in os.environ['FOUR_COMPARISON_DIRS'].split(os.pathsep)]
        current_metrics = None
        for output in paths:
            old = output.with_name(output.name.removesuffix('-with-per-frame'))
            if not (old / 'report.json').exists():
                old = old.with_name(old.name + '-complete')
            before = json.loads((old / 'report.json').read_text())
            after = json.loads((output / 'report.json').read_text())
            for key, value in before['metrics'].items():
                self.assertEqual(after['metrics'][key], value)
            self.assertEqual(before['sourceFiles'], after['sourceFiles'])
            if current_metrics is None:
                current_metrics = after['metrics']['currentPerFrame']
            else:
                self.assertEqual(current_metrics, after['metrics']['currentPerFrame'])
            with Image.open(old / 'core-00-raw-full.png') as prior, Image.open(output / 'core-00-raw-full.png') as current:
                original, quad = np.asarray(prior), np.asarray(current)
                for index in (1, 2):
                    self.assertTrue(np.array_equal(original[180:1044, index * 1536:(index + 1) * 1536],
                        quad[1224:2088, (index - 1) * 1536:index * 1536]))
            for record in after['outputFiles']:
                self.assertEqual(comparison.sha256(output / record['file']), record['sha256'])
        script = r"""
const { chromium } = require('/tmp/kilo/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  for(const url of process.argv.slice(1))for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:1000}});
   await page.goto(url);
   await page.waitForFunction(()=>{const v=document.querySelector('section[data-mode="raw"] video');return !v.paused&&v.currentTime>0.1});
   const button=page.locator('#animation-controls button').first();
   await button.click();
   await page.waitForFunction(()=>document.querySelector('section[data-mode="raw"] video').paused);
   await button.click();
   await page.waitForFunction(()=>!document.querySelector('section[data-mode="raw"] video').paused);
   for(const mode of ['raw','black','white']){
    await page.locator('select').selectOption(mode);
    const errors=await page.locator(`section[data-mode="${mode}"]`).evaluate((section,width)=>{
     const errors=[];
     for(const media of section.querySelectorAll('video,img')){
      const heading=media.previousElementSibling,cells=[...heading.children];
      if(cells.length!==4||!cells[1].textContent.includes('RealESRNet per-frame RGB'))errors.push('missing method');
      if(cells.some(c=>parseFloat(getComputedStyle(c).fontSize)<(width===390?16:24)))errors.push('small heading');
      const rects=cells.map(c=>c.getBoundingClientRect());
      if(Math.abs(rects[0].y-rects[1].y)>1||rects[2].y<=rects[0].y||Math.abs(rects[2].y-rects[3].y)>1)errors.push('not2x2');
      if(heading.getBoundingClientRect().bottom>media.getBoundingClientRect().top+1)errors.push('overlap');
     }
     if(document.documentElement.scrollWidth>width)errors.push('overflow');
     const video=section.querySelector('video');
     if(!video.muted||!video.loop||!video.playsInline)errors.push('playback flags');
     return errors;
    },width);
    if(errors.length)throw Error(`${url}/${width}/${mode}: ${errors.join(',')}`);
    await page.waitForFunction(mode=>!document.querySelector(`section[data-mode="${mode}"] video`).paused,mode);
   }
   await page.close();
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
"""
        subprocess.run(['node', '-e', script, *[(p / 'index.html').as_uri() for p in paths]], check=True, timeout=90)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'local ffmpeg required')
    def test_four_method_pipeline_preserves_existing_seed_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs, runs = self.fixture(root)
            control, _, _ = self.per_frame_fixture(root, inputs)
            output = root / 'analysis-four'
            result = comparison.main(['--input-dir', str(inputs), '--results-dir', str(runs),
                '--per-frame-baseline-dir', str(control), '--output', str(output)])
            self.assertEqual(result, 0)
            report = json.loads((output / 'report.json').read_text())
            self.assertEqual(report['previewCanvas'], [1536, 1008])
            self.assertEqual(report['metrics']['3b']['meanCoreReprojectionMAE'], 0)
            self.assertEqual(report['metrics']['currentPerFrame']['holdFlicker']['first']['meanMAE'], 0)
            page = (output / 'index.html').read_text()
            self.assertIn('WebP Q90', page)
            self.assertIn('Current RealESRNet', page)
            self.assertIn('viewer-controls.js', page)
            self.assertIn('muted', page)
            with Image.open(output / 'core-00-raw-full.png') as image:
                self.assertEqual(image.size, (3072, 2088))
            self.assertIsNone(report['perFrameBaseline']['inferenceSeconds'])

    def test_premultiplied_reprojection_ignores_background(self):
        alpha = np.array([[255, 0], [0, 255]], dtype=np.uint8)
        source = np.full((2, 2, 3), 40, dtype=np.uint8)
        high = np.full((8, 8, 3), 255, dtype=np.uint8)
        high[np.repeat(np.repeat(alpha > 0, 4, 0), 4, 1)] = 40
        self.assertEqual(comparison.reproject_mae(high, source, alpha), 0)
        high[0, 0] = 56
        self.assertEqual(comparison.reproject_mae(high, source, alpha), .5)

    def test_hold_mae_only_inside(self):
        a = np.zeros((3, 3, 3), dtype=np.uint8)
        b = np.full_like(a, 255)
        b[1, 1] = 7
        inside = np.zeros((3, 3), dtype=bool)
        inside[1, 1] = True
        self.assertEqual(comparison.masked_mae(a, b, inside), 7)
        self.assertIsNone(comparison.masked_mae(a, b, ~np.ones_like(inside)))

    def test_raw_preserves_ghost_pixels_and_masked_hides_them(self):
        original = np.full((2, 2, 3), 128, dtype=np.uint8)
        alpha = np.array([[255, 0], [0, 0]], dtype=np.uint8)
        model = np.full((8, 8, 3), 128, dtype=np.uint8)
        model[0:4, 4:8] = [161, 142, 139]
        raw = comparison.display_images(original, [model, model.copy()], alpha, None)
        self.assertTrue(np.array_equal(raw[1], model))
        self.assertTrue(np.array_equal(raw[0], np.full_like(model, 128)))
        for background in (0, 255):
            masked = comparison.display_images(original, [model, model], alpha, background)
            self.assertTrue(np.all(masked[1][0:4, 4:8] == background))

    def test_readable_label_strips_preserve_all_image_pixels(self):
        image = np.full((864, 1536, 3), [70, 100, 150], dtype=np.uint8)
        for thumbnail, bar, width, height in [(False, 180, 1536, 864), (True, 72, 512, 288)]:
            result = np.asarray(comparison.panel([image] * 3, 8, 'raw', thumbnail=thumbnail))
            self.assertEqual(result.shape, (height + bar, width * 3, 3))
            self.assertTrue(np.all(result[bar:] == [70, 100, 150]))
            for col in range(3):
                white = np.all(result[:bar, col * width:(col + 1) * width] > 240, axis=2)
                title_rows = np.flatnonzero(white[:42 if thumbnail else 100].any(axis=1))
                ordinal_rows = np.flatnonzero(white[42 if thumbnail else 108:].any(axis=1))
                self.assertGreaterEqual(len(title_rows), 23 if thumbnail else 60)
                self.assertGreaterEqual(len(ordinal_rows), 20 if thumbnail else 45)

    @unittest.skipUnless(os.environ.get('COMPARISON_VIEWER_DIR'), 'set COMPARISON_VIEWER_DIR for generated-output browser test')
    def test_readable_generated_browser(self):
        output = Path(os.environ['COMPARISON_VIEWER_DIR'])
        previous = output.with_name('analysis')
        report = json.loads((output / 'report.json').read_text())
        old = json.loads((previous / 'report.json').read_text())
        self.assertEqual(report['metrics'], old['metrics'])
        self.assertEqual(report['sourceFiles'], old['sourceFiles'])
        with Image.open(output / 'core-00-raw-full.png') as current, Image.open(previous / 'core-00-raw-full.png') as prior:
            self.assertTrue(np.array_equal(np.asarray(current)[180:], np.asarray(prior)[36:]))
        script = r"""
const { chromium } = require('/tmp/kilo/node_modules/playwright');
(async () => {
 const browser = await chromium.launch({headless:true,channel:'chrome'});
 try {
  for (const width of [390,1440]) {
   const page = await browser.newPage({viewport:{width,height:1000}});
   await page.goto(process.argv[1]);
   for (const mode of ['raw','black','white']) {
    await page.selectOption('#display-mode',mode);
    const errors = await page.locator(`section[data-mode="${mode}"]`).evaluate((section,width)=>{
     const errors=[];
     for(const media of section.querySelectorAll('video,img')) {
      const heading=media.previousElementSibling;
      if(!heading.classList.contains('panel-headings'))errors.push('missing heading directly above media');
      const cells=[...heading.children];
      if(cells.map(c=>c.textContent).join('|')!=='ORIGINAL|SeedVR2 3B|SeedVR2 7B')errors.push('wrong labels');
      const min=width===390?16:24;
      if(cells.some(c=>parseFloat(getComputedStyle(c).fontSize)<min))errors.push('small type');
      const boxes=cells.map(c=>c.getBoundingClientRect());
      if(Math.max(...boxes.map(b=>b.width))-Math.min(...boxes.map(b=>b.width))>1)errors.push('unequal columns');
      if(heading.getBoundingClientRect().bottom>media.getBoundingClientRect().top+1)errors.push('overlapping header');
     }
     if(document.documentElement.scrollWidth>width)errors.push('horizontal overflow');
     return errors;
    },width);
    if(errors.length)throw Error(`${width}/${mode}: ${errors.join(', ')}`);
   }
   await page.close();
  }
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
"""
        subprocess.run(['node', '-e', script, (output / 'index.html').as_uri()], check=True, timeout=60)

    def test_raw_ghost_region_control_and_model_departure(self):
        original = np.full((2, 2, 3), 128, dtype=np.uint8)
        current = np.array([[255, 0], [0, 0]], dtype=np.uint8)
        following = np.array([[255, 255], [0, 0]], dtype=np.uint8)
        model = np.full((8, 8, 3), 128, dtype=np.uint8)
        model[0:4, 4:8] = 140
        model[4:8, 0:4] = 255  # Outside diagnostic region must not affect its mean.
        result = comparison.ghost_region_metrics(original, [model, np.full_like(model, 128)], current, following)
        self.assertEqual(result['regionOutputPixels'], 16)
        self.assertEqual(result['meanAbsoluteRGBDepartureFrom128'], {'nativeInput': 0, '3b': 12, '7b': 0})
        self.assertIn('root cause unknown', result['interpretation'])
        empty = comparison.ghost_region_metrics(original, [model, model], current, current)
        self.assertIsNone(empty['meanAbsoluteRGBDepartureFrom128']['3b'])

    def test_sanitization(self):
        result = comparison.clean({'token': 'private', 'path': '/home/private/a.png',
                                   'url': 'https://example.com/?secret=private',
                                   'log': 'token=private hf_abcdefgh AKIA1234567890123456'})
        text = json.dumps(result)
        self.assertNotIn('private', text)
        self.assertNotIn('https://', text)
        self.assertNotIn('/home/', text)

    def test_rejects_path_escape(self):
        with self.assertRaises(ValueError):
            comparison.local(Path('/tmp/kilo'), '../secret.png')

    def test_partial_does_not_encode_or_fake_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(comparison, 'encode', side_effect=AssertionError('must not encode')):
                result = comparison.main(['--input-dir', str(root / 'missing'), '--results-dir', str(root / 'runs'), '--output', str(root / 'analysis')])
            self.assertEqual(result, 2)
            report = json.loads((root / 'analysis/report.json').read_text())
            self.assertEqual(report['status'], 'partial')
            self.assertEqual(sorted(p.name for p in (root / 'analysis').iterdir()), ['index.html', 'report.json'])

    def fixture(self, root):
        inputs, runs = root / 'input', root / 'runs'
        inputs.mkdir()
        (inputs / 'input.mp4').write_bytes(b'synthetic input hash only; never decoded')
        rgba = np.zeros((216, 384, 4), dtype=np.uint8)
        rgba[40:180, 140:240] = [70, 100, 150, 255]
        Image.fromarray(rgba).save(inputs / 'source.png')
        Image.fromarray(rgba[..., 3]).save(inputs / 'mask.png')
        source_hash, mask_hash = comparison.sha256(inputs / 'source.png'), comparison.sha256(inputs / 'mask.png')
        frames = [{'sourceOrdinal': i, 'alignedRGBA': 'source.png', 'alignedSHA256': source_hash,
                   'mask': 'mask.png', 'maskSHA256': mask_hash, 'sourceSHA256': source_hash,
                   'durationTicks': 1 if i < 2 else 2} for i in range(32)]
        meta = {'canvas': [384, 216], 'sourceFrameCount': 32, 'sourceDurationTicks': 62,
                'sourceTickRateKnown': False, 'fps': 15, 'clipFrameCount': 49,
                'holdsBefore': 8, 'holdsAfter': 9, 'coreClipRangeInclusive': [8, 39],
                'sourceFrames': frames, 'timeline': [
                    {'clipFrame': i, 'sourceOrdinal': min(max(i - 8, 0), 31),
                     'role': 'core' if 8 <= i <= 39 else 'hold', 'rgbFile': 'source.png',
                     'rgbSHA256': source_hash} for i in range(49)]}
        (inputs / 'source-metadata.json').write_text(json.dumps(meta))
        high = np.repeat(np.repeat(rgba[..., :3], 4, 0), 4, 1)
        for variant in ('3b', '7b'):
            folder = runs / variant / 'frames/input'
            folder.mkdir(parents=True)
            first = folder / 'input_000000.png'
            Image.fromarray(high).save(first)
            for i in range(1, 49):
                shutil.copyfile(first, folder / f'input_{i:06d}.png')
            report = {'status': 'succeeded', 'modelVariant': variant, 'runnerRevision': 'synthetic',
                      'input': {'sha256': comparison.sha256(inputs / 'input.mp4')},
                      'output': {'files': [{'file': f'input_{i:06d}.png', 'sha256': comparison.sha256(first)} for i in range(49)]},
                      'startedAtUnix': 100, 'finishedAtUnix': 150, 'inferenceSeconds': 40}
            if variant == '7b':
                report['gpuMemory'] = {'peakUsedMiB': 1234, 'scope': 'synthetic sampled device-wide'}
            (runs / variant / 'report.json').write_text(json.dumps(report))
        return inputs, runs

    def test_success_validation_and_legacy_memory_null(self):
        with tempfile.TemporaryDirectory() as tmp:
            inputs, runs = self.fixture(Path(tmp))
            result = comparison.validate(inputs, runs)
            self.assertIsNone(result[4]['3b']['gpuMemory'])
            self.assertEqual(result[4]['7b']['gpuMemory']['peakUsedMiB'], 1234)
            self.assertEqual(len(result[3]), 32)
            (runs / '7b/frames/input/input_000048.png').unlink()
            with self.assertRaisesRegex(ValueError, '49 contiguous'):
                comparison.validate(inputs, runs)

    def test_rejects_hash_mismatch_and_resampling(self):
        with tempfile.TemporaryDirectory() as tmp:
            inputs, runs = self.fixture(Path(tmp))
            Image.new('RGB', (1280, 720)).save(runs / '3b/frames/input/input_000000.png')
            with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
                comparison.validate(inputs, runs)
            with self.assertRaisesRegex(ValueError, 'without resampling'):
                comparison.rgb(runs / '3b/frames/input/input_000000.png')

    def test_failed_7b_produces_only_partial_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs, runs = self.fixture(root)
            path = runs / '7b/report.json'
            report = json.loads(path.read_text())
            report['status'] = 'failed'
            report['credential'] = 'must-not-appear'
            path.write_text(json.dumps(report))
            with patch.object(comparison, 'encode', side_effect=AssertionError('must not encode')):
                status = comparison.main(['--input-dir', str(inputs), '--results-dir', str(runs), '--output', str(root / 'analysis')])
            self.assertEqual(status, 2)
            text = (root / 'analysis/report.json').read_text()
            partial = json.loads(text)
            self.assertEqual(partial['availableRuns']['7b']['report']['status'], 'failed')
            self.assertNotIn('must-not-appear', text)
            self.assertEqual(len(list((root / 'analysis').iterdir())), 2)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'local ffmpeg required')
    def test_raw_and_masked_synthetic_media_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs, runs = self.fixture(root)
            output = root / 'analysis'
            result = comparison.main(['--input-dir', str(inputs), '--results-dir', str(runs), '--output', str(output)])
            self.assertEqual(result, 0)
            report = json.loads((output / 'report.json').read_text())
            self.assertEqual(report['status'], 'complete')
            self.assertEqual(report['metrics']['3b']['meanCoreReprojectionMAE'], 0)
            self.assertEqual(len(report['metrics']['7b']['holdFlicker']['first']['adjacentMAE']), 8)
            self.assertEqual(len(report['metrics']['7b']['holdFlicker']['last']['adjacentMAE']), 9)
            self.assertIsNone(report['runs']['3b']['gpuMemory'])
            self.assertEqual(len(list(output.glob('core-*-full.png'))), 15)
            self.assertEqual(report['defaultDisplayMode'], 'raw')
            self.assertFalse(report['rawRGBMaskRestored'])
            self.assertTrue((output / 'contact-raw.png').is_file())
            page = (output / 'index.html').read_text()
            self.assertIn('<option value="raw" selected>', page)
            self.assertIn('data-mode="black" aria-labelledby="heading-black" hidden', page)
            self.assertIn('comparison-raw-15fps.mp4', page)
            with Image.open(output / 'core-00-raw-full.png') as image:
                pixels = np.asarray(image)
                self.assertEqual(tuple(pixels[450, 1536 + 600]), (70, 100, 150))
            self.assertLess(sum(p.stat().st_size for p in output.iterdir()), comparison.LIMIT)
            self.assertNotIn(str(root), (output / 'report.json').read_text())
            for record in report['outputFiles']:
                self.assertEqual(comparison.sha256(output / record['file']), record['sha256'])
            with Image.open(output / 'core-00-black-full.png') as image:
                self.assertEqual(image.size, comparison.PANEL_SIZE)


if __name__ == '__main__':
    unittest.main()
