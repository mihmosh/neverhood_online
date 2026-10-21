#!/usr/bin/env python3
"""Offline original/baseline/triplicate-center comparison. No network or inference.

Requires Pillow, numpy, local ffmpeg/ffprobe. Output must be a new directory.
Exit 0 complete; exit 2 partial report only. Never copies selected PNG sequences.
"""
import argparse
import hashlib
import html
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = (1536, 864)
SELECTED = (0, 8, 16, 24, 31)
CENTERS = [1 + 3 * i for i in range(49)]
CORE = CENTERS[8:40]
NOTES = {
    'experiment': 'Same-model before/after experiment: original 49-frame baseline versus centers of '
                  '49 tripled frames plus two trailing pads. Authorized seed 314159, batch 5, noise 0, '
                  'color none and offload settings unchanged; actual reports/commands and comparability fields '
                  'are preserved, with unknown legacy fields explicitly unreported.',
    'timing': 'Baseline 49 frames at 15 fps; triplicate 149 at 45 fps (147 tripled + 2 end pads). '
              'Select 49 centers 1+3*i, including original holds. Videos show only 32 core centers '
              '25+3*i, i=0..31, aligned with baseline 8..39 at 15 fps. Pads 147 and 148 are never selected. '
              'Source 62 ticks and unknown cadence are metadata, not tick-accurate playback.',
    'geometry': 'RAW is default: all model RGB retained, including outside-silhouette ghosts. '
                'All model canvases are exactly 1536x864, without resampling. Original uses nearest 4x. '
                'Only black/white masked modes restore the SAME original nearest-4x binary alpha. '
                'Label bars are outside the complete image. MP4 is a lossy preview; full PNGs preserve RGB.',
    'metrics': 'Foreground reprojection MAE: premultiplied-mask 4x4 box downsampling, normalized by coverage, '
               'versus original source RGB, range 0..255. Flicker: adjacent selected-frame RGB MAE only on '
               'endpoint holds 0..8 and 39..48 inside one-source-pixel-eroded masks. No moving-frame temporal score.',
    'ghost': 'Core 0 compares baseline PNG 8 against triplicate PNG 25, in mask(source1) minus mask(source0), '
             'nearest 4x, outside the current silhouette. Mean absolute RGB departure from gray 128 and '
             'relative reduction are descriptive for this region/clip only. They do not prove a future-pose '
             'root cause, VAE involvement, general improvement, or an automatic quality winner. '
             'No high-resolution ground truth is available; masked modes hide outside-silhouette ghosts.',
}


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def clean(value, key=''):
    if re.search(r'token|secret|password|credential|authorization|access.?key', key, re.I):
        return '[REDACTED]'
    if isinstance(value, dict):
        return {k: clean(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v, key) for v in value]
    if isinstance(value, str):
        value = re.sub(r'(?:https?://|s3://)[^\s\"\'<>]+', '[URL REDACTED]', value)
        value = re.sub(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bhf_[A-Za-z0-9]+\b', '[KEY REDACTED]', value)
        value = re.sub(r'(?i)\b(token|secret|password|authorization|credential|access_key)\s*[:=]\s*\S+', r'\1=[REDACTED]', value)
        value = re.sub(r'(?<!\w)/[^\s\"\'<>]+', '[PATH REDACTED]', value)
    return value


def dump(path, value):
    path.write_text(json.dumps(clean(value), indent=2, allow_nan=False) + '\n')


def load(path):
    return json.loads(path.read_text())


def verified(root, name, expected):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix.lower() == '.env':
        raise ValueError('Unsafe artifact path')
    if sha(path) != expected:
        raise ValueError('SHA256 mismatch: ' + Path(name).name)
    return path


def pixels(path, size=SIZE, mode='RGB'):
    with Image.open(path) as image:
        if image.size != size:
            raise ValueError('Wrong exact canvas: ' + path.name)
        return np.asarray(image.convert(mode)).copy()


def expand(a):
    return np.repeat(np.repeat(a, 4, 0), 4, 1)


def validate_mapping(mapping, original):
    if (mapping.get('fps'), mapping.get('clipFrameCount'), mapping.get('canvas')) != (45, 149, [384, 216]):
        raise ValueError('Expected 149-frame 45fps triplicate mapping')
    if mapping.get('selectedMiddleIndices') != CENTERS or mapping.get('coreMiddleIndices') != CORE:
        raise ValueError('Center indices must be all 49 exact 1+3*i; core 25..118 step3')
    timeline = mapping['timeline']
    if len(timeline) != 149 or len(original['timeline']) != 49:
        raise ValueError('Incomplete timeline')
    for index, entry in enumerate(timeline):
        clip = min(index // 3, 48)
        source = original['timeline'][clip]
        selected = index in CENTERS
        if (entry['outputFrame'] != index or entry['originalClipFrame'] != clip
                or entry['sourceOrdinal'] != source['sourceOrdinal'] or entry['selected'] != selected
                or entry['originalRGBSHA256'] != source['rgbSHA256']
                or entry['originalRGBFile'] != source['rgbFile']
                or entry['useForQuality'] != (selected and 8 <= clip <= 39)):
            raise ValueError('Incorrect or sparse triplicate mapping at index ' + str(index))
        if index >= 147 and entry['role'] != 'endpad':
            raise ValueError('Trailing two frames must be unselected endpad')
        if selected and entry['role'] != 'middle':
            raise ValueError('Selected frame is not a middle')
    return CENTERS.copy()


def validate_run(root, count, fps, input_hash, variant):
    report_path = root / 'report.json'
    report = load(report_path)
    if str(report.get('status')).lower() != 'succeeded':
        raise ValueError('Run has not succeeded')
    if report['input']['sha256'] != input_hash:
        raise ValueError('Run input SHA256 mismatch')
    if (int(report['input']['nb_read_frames']), report['input']['avg_frame_rate']) != (count, f'{fps}/1'):
        raise ValueError('Run input count/fps mismatch')
    if report.get('modelVariant', variant) != variant:
        raise ValueError('Wrong model variant')
    directory = root / 'frames/input'
    names = [f'input_{i:06d}.png' for i in range(count)]
    if sorted(p.name for p in directory.glob('*.png')) != names:
        raise ValueError(f'Expected all {count} contiguous PNGs; cannot substitute missing centers')
    records = report['output']['files']
    if len(records) != count:
        raise ValueError('Incomplete frame SHA records')
    for name, record in zip(names, records):
        if record['file'] != name:
            raise ValueError('Output frame records not contiguous')
        path = verified(directory, name, record['sha256'])
        with Image.open(path) as image:
            if image.size != SIZE:
                raise ValueError('Model output must be exact 1536x864; no resampling')
            image.verify()
    command = root / 'command.json'
    return {'report': report, 'reportSHA256': sha(report_path), 'gpuMemory': report.get('gpuMemory'),
            'wallClockSeconds': report['finishedAtUnix'] - report['startedAtUnix']
            if 'finishedAtUnix' in report and 'startedAtUnix' in report else None,
            'command': load(command) if command.exists() else None,
            'commandSHA256': sha(command) if command.exists() else None}


def reprojection(high, source, alpha):
    h, w = alpha.shape
    mask = expand(alpha.astype(np.float32) / 255)
    weighted = (high.astype(np.float32) * mask[..., None]).reshape(h, 4, w, 4, 3).sum((1, 3))
    coverage = mask.reshape(h, 4, w, 4).sum((1, 3))
    foreground = coverage > 0
    return float(np.abs(weighted / np.maximum(coverage[..., None], 1) - source)[foreground].mean()) if foreground.any() else None


def ghost_metric(native, before, after, current_mask, next_mask):
    region = expand((next_mask > 0) & (current_mask == 0))
    values = [float(np.abs(a.astype(np.float64)[region] - 128).mean()) if region.any() else None
              for a in (expand(native), before, after)]
    control, baseline, triple = values
    ratio = triple / baseline if baseline not in (None, 0) and triple is not None else None
    return {'coreOrdinal': 0, 'baselineClipFrame': 8, 'triplicateFrame': 25,
            'regionOutputPixels': int(region.sum()), 'region': 'next mask minus current mask, NEAREST4x',
            'meanAbsoluteRGBDepartureFrom128': dict(zip(('nativeInput', 'baseline', 'triplicateCenter'), values)),
            'afterOverBeforeRatio': ratio, 'relativeReduction': 1 - ratio if ratio is not None else None,
            'absoluteReduction': baseline - triple if baseline is not None and triple is not None else None,
            'interpretation': 'Descriptive for this ROI only; negative reduction means increased departure; no universal quality winner or root-cause claim.'}


def hold_metrics(reader, masks):
    result = {}
    for name, ordinal, start, end in [('first', 0, 0, 8), ('last', 31, 39, 48)]:
        padded = Image.new('L', (386, 218))
        padded.paste(Image.fromarray(masks[ordinal]), (1, 1))
        inside = expand(np.asarray(padded.filter(ImageFilter.MinFilter(3)).crop((1, 1, 385, 217))) > 0)
        previous, values = reader(start), []
        for index in range(start + 1, end + 1):
            current = reader(index)
            values.append(float(np.abs(current.astype(np.float32) - previous.astype(np.float32))[inside].mean()) if inside.any() else None)
            previous = current
        result[name] = {'selectedClipRangeInclusive': [start, end], 'adjacentMAE': values,
                        'meanMAE': float(np.mean(values)) if inside.any() else None, 'interiorPixels': int(inside.sum())}
    return result


def panel(images, ordinal, mode, variant, thumbnail=False):
    width, height, bar, title_size, small = (512, 288, 72, 32, 24) if thumbnail else (1536, 864, 180, 84, 60)
    canvas = Image.new('RGB', (width * 3, height + bar), '#101010')
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype('DejaVuSans-Bold.ttf', title_size)
    detail = ImageFont.truetype('DejaVuSans-Bold.ttf', small)
    labels = ('ORIGINAL', f'Baseline {variant.upper()}', f'Triple {variant.upper()} center')
    for col, (image, label) in enumerate(zip(images, labels)):
        picture = Image.fromarray(image)
        if thumbnail:
            picture = picture.resize((width, height), Image.Resampling.NEAREST)
        canvas.paste(picture, (col * width, bar))
        x = col * width + (12 if thumbnail else 36)
        draw.text((x, 6 if thumbnail else 16), label, font=font, fill='white', anchor='lt')
        draw.text((x, 42 if thumbnail else 108), f'Core {ordinal:02d} | {mode}', font=detail, fill='white', anchor='lt')
    return canvas


def encode(output, name, frames, size=(4608, 1044)):
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-f', 'rawvideo', '-pixel_format', 'rgb24',
               '-video_size', f'{size[0]}x{size[1]}', '-framerate', '15', '-i', 'pipe:0', '-an', '-c:v', 'libx264',
               '-threads', '2', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
               '-fs', '24000000', str(output / name)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in frames:
            process.stdin.write(np.asarray(frame).tobytes())
        process.stdin.close()
        error = process.stderr.read().decode(errors='replace')
        if process.wait():
            raise ValueError('ffmpeg failed: ' + clean(error))
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdin.close()
        process.stderr.close()
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate', '-of', 'json', str(output / name)], text=True))['streams'][0]
    if (int(info['nb_read_frames']), info['width'], info['height'], info['avg_frame_rate']) != (32, *size, '15/1'):
        raise ValueError('Truncated or invalid comparison video')


def analyze(args):
    original = load(args.input_dir / 'source-metadata.json')
    mapping = load(args.triplicate_input_dir / 'triplicate-mapping.json')
    trip_meta = load(args.triplicate_input_dir / 'source-metadata.json')
    indices = validate_mapping(mapping, original)
    if (original['canvas'], original['fps'], original['clipFrameCount'], original['coreClipRangeInclusive']) != ([384, 216], 15, 49, [8, 39]):
        raise ValueError('Unsupported original source geometry/timing')
    for key, path in [('sourceMetadataSHA256', args.input_dir / 'source-metadata.json'),
                      ('originalInputSHA256', args.input_dir / 'input.mp4'),
                      ('inputSHA256', args.triplicate_input_dir / 'input.mp4')]:
        if mapping[key] != sha(path):
            raise ValueError('Mapping input provenance mismatch: ' + key)
    if trip_meta['sourceFrames'] != original['sourceFrames'] or (trip_meta['fps'], trip_meta['clipFrameCount']) != (45, 149):
        raise ValueError('Triplicate source identity mismatch')
    sources, masks, source_records = [], [], []
    for i, record in enumerate(original['sourceFrames']):
        if record['sourceOrdinal'] != i:
            raise ValueError('Source ordinals must be contiguous')
        source_path = verified(args.input_dir, record['alignedRGBA'], record['alignedSHA256'])
        mask_path = verified(args.input_dir, record['mask'], record['maskSHA256'])
        rgba = pixels(source_path, (384, 216), 'RGBA')
        alpha = pixels(mask_path, (384, 216), 'L')
        if not set(np.unique(alpha)).issubset({0, 255}) or not np.array_equal(rgba[..., 3], alpha):
            raise ValueError('Source mask differs from original binary alpha')
        sources.append(rgba[..., :3])
        masks.append(alpha)
        source_records.append({**record, 'alpha4xSHA256': hashlib.sha256(expand(alpha).tobytes()).hexdigest()})
    if len(sources) != 32:
        raise ValueError('Exactly 32 sources required')
    native_paths = [verified(args.input_dir, e['rgbFile'], e['rgbSHA256']) for e in original['timeline']]
    for i, entry in enumerate(original['timeline']):
        if entry['clipFrame'] != i or entry['sourceOrdinal'] != min(max(i - 8, 0), 31):
            raise ValueError('Unexpected original ordinal mapping')
    for start, end in ((0, 8), (39, 48)):
        if len({e['rgbSHA256'] for e in original['timeline'][start:end + 1]}) != 1:
            raise ValueError('Endpoint hold inputs differ')
    roots = {'baseline': args.baseline_results_dir / args.variant, 'triplicateCenter': args.triplicate_results_dir / args.variant}
    runs = {name: validate_run(root, count, fps, digest, args.variant) for (name, root), count, fps, digest in zip(
        roots.items(), (49, 149), (15, 45), (mapping['originalInputSHA256'], mapping['inputSHA256']))}
    def read(name, clip):
        index = indices[clip] if name == 'triplicateCenter' else clip
        return pixels(roots[name] / 'frames/input' / f'input_{index:06d}.png')
    metrics = {}
    for name in roots:
        errors = [reprojection(read(name, i + 8), sources[i], masks[i]) for i in range(32)]
        metrics[name] = {'coreReprojectionMAE': errors, 'meanCoreReprojectionMAE': float(np.mean(errors)),
                         'holdFlicker': hold_metrics(lambda i: read(name, i), masks)}
    metrics['nextMaskOnlyGhostRegion'] = ghost_metric(pixels(native_paths[8], (384, 216)), read('baseline', 8),
        read('triplicateCenter', 8), masks[0], masks[1])
    control, control_paths, control_api = None, None, None
    notes = dict(NOTES)
    labels = ('ORIGINAL', f'Baseline {args.variant.upper()}', f'Triple {args.variant.upper()} center')
    if args.per_frame_baseline_dir:
        # Reuse the repository-local normalized control contract/layout, never an external project path.
        spec = importlib.util.spec_from_file_location('seedvr2_comparison_control', Path(__file__).with_name('compare-seedvr2-aws.py'))
        control_api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(control_api)
        control, control_paths = control_api.validate_per_frame(args.per_frame_baseline_dir, original,
            mapping['originalInputSHA256'], sha(args.input_dir / 'source-metadata.json'))
        labels = ('ORIGINAL', 'RealESRNet per-frame RGB', f'Baseline {args.variant.upper()}', f'Triple {args.variant.upper()} center')
        metrics['currentPerFrame'] = control_api.per_frame_metrics(
            lambda clip: control_api.per_frame_rgb(control_paths, clip, masks, original['timeline']), sources, masks)
        notes['current'] = ('Current RealESRNet is cached RGB composited using the trusted original binary mask over gray128 before display, '
                            'unlike unmasked Seed RAW context. Cache codec/provenance: ' + json.dumps(clean(control['metadata']['codec'])) + '; ' +
                            json.dumps(clean(control['metadata']['provenance'])) + '. ' +
                            str(control['metadata'].get('runtimePackCaveat', 'Not a byte-identical runtime room pack.')) + '. Cache GPU/runtime measurements null. '
                            'Four-method video/contact previews use nearest2:1 downscale, full PNG tiles remain1536x864. '
                            '2x2 order: top Original / Current; bottom Baseline / Triple center. MAE is not an HD quality score; nearest can have zero MAE.')
    video_size = (1536, 1008) if control else (4608, 1044)
    comparability = {}
    for key in ('runnerRevision', 'ditModel', 'modelStyle', 'modelPrecision', 'blocksToSwap', 'models', 'compile'):
        before, after = (runs[name]['report'].get(key) for name in roots)
        comparability[key] = {'baseline': before, 'triplicate': after,
                              'status': 'unreported' if before is None or after is None else 'same' if before == after else 'different'}
    def images(i, mode):
        arrays = [expand(pixels(native_paths[i + 8], (384, 216))), read('baseline', i + 8), read('triplicateCenter', i + 8)]
        if control:
            arrays.insert(1, control_api.per_frame_rgb(control_paths, i + 8, masks, original['timeline']))
        if mode != 'raw':
            mask = expand(masks[i]) > 0
            arrays = [np.where(mask[..., None], a, 0 if mode == 'black' else 255).astype(np.uint8) for a in arrays]
        return arrays
    for mode in ('raw', 'black', 'white'):
        def render(i, preview=False):
            arrays = images(i, mode)
            return control_api.quad_panel(arrays, labels, i, mode, preview=preview) if control else panel(arrays, i, mode, args.variant, thumbnail=preview)
        encode(args.output, f'comparison-{mode}-15fps.mp4', (render(i, preview=bool(control)) for i in range(32)), size=video_size)
        row_height = 1008 if control else 360
        sheet = Image.new('RGB', (1536, row_height * len(SELECTED)))
        for row, i in enumerate(SELECTED):
            render(i).save(args.output / f'core-{i:02d}-{mode}-full.png', optimize=True)
            sheet.paste(render(i, preview=True), (0, row_height * row))
        sheet.save(args.output / f'contact-{mode}.png', optimize=True)
    dump(args.output / 'timing.json', {'originalMetadata': original, 'triplicateMetadata': trip_meta,
         'mapping': mapping, 'selectedMiddleIndices': indices, 'coreMiddleIndices': CORE,
         'displayFPS': 15, 'triplicateInputFPS': 45, 'unselectedEndPads': [147, 148]})
    report = {'status': 'complete', 'variant': args.variant, 'notes': notes, 'metrics': metrics, 'runs': runs,
              'perFrameBaseline': control, 'layout': '2x2' if control else '1x3', 'previewCanvas': video_size,
              'previewResampling': 'NEAREST 2:1' if control else 'none', 'perFrameRawMaskRestored': bool(control),
              'configurationComparability': comparability, 'sourceFiles': source_records,
              'inputSHA256': {'baseline': mapping['originalInputSHA256'], 'triplicate': mapping['inputSHA256']},
              'sourceMetadataSHA256': sha(args.input_dir / 'source-metadata.json'),
              'triplicateMetadataSHA256': sha(args.triplicate_input_dir / 'source-metadata.json'),
              'mappingSHA256': sha(args.triplicate_input_dir / 'triplicate-mapping.json'),
              'analyzerSHA256': sha(Path(__file__)), 'selectedMiddleIndices': indices, 'coreMiddleIndices': CORE,
              'originalCanvas': SIZE, 'rgbResampling': 'none', 'mask': 'shared original binary NEAREST4x',
              'defaultDisplayMode': 'raw', 'displayFPS': 15, 'baselineInputFPS': 15, 'triplicateInputFPS': 45,
              'selectedFramesForMetrics': 49, 'coreFramesForVideo': 32, 'endPadsSelected': False}
    headings = '<div class="headings' + (' quad' if control else '') + '">' + ''.join(f'<strong>{label}</strong>' for label in labels) + '</div>'
    views = ''
    for mode in ('raw', 'black', 'white'):
        hidden = '' if mode == 'raw' else ' hidden'
        links = ''.join(f'<li><a href="core-{i:02d}-{mode}-full.png">Core {i:02d}: baseline {i+8}, triple {CORE[i]}, full PNG</a></li>' for i in SELECTED)
        autoplay = ' autoplay' if mode == 'raw' else ''
        views += (f'<section data-mode="{mode}"{hidden}><h2>{mode.upper()}</h2>{headings}'
                   f'<video controls{autoplay} loop muted playsinline preload="metadata" src="comparison-{mode}-15fps.mp4"></video>'
                  f'<h2>Selected Frames</h2>{headings}<img alt="{mode} comparison contact sheet" src="contact-{mode}.png"><ul>{links}</ul></section>')
    paragraphs = ''.join(f'<p id="{k}"><strong>{k.title()}.</strong> {html.escape(v)}</p>' for k, v in notes.items())
    page = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            '<title>Triplicate center comparison</title><style>body{max-width:1536px;margin:24px auto;padding:0 8px;'
            'background:#181818;color:#fff;font:16px/1.5 system-ui}video,img{width:100%;height:auto}a{color:#badfff}'
            'select{font:inherit;padding:10px;max-width:100%}.headings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));'
            'font-size:24px;line-height:1.3;text-align:center;background:#000;padding:12px 0}.headings strong{padding:0 4px;overflow-wrap:anywhere}'
            '.headings.quad{grid-template-columns:repeat(2,minmax(0,1fr))}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){.headings{font-size:16px}}</style>'
            f'<h1>{args.variant.upper()}: Baseline versus Triplicate Centers</h1>' + paragraphs +
            '<label for="mode">Display mode</label> <select id="mode"><option value="raw" selected>RAW RGB (reveals ghosts)</option>'
            '<option value="black">Binary masked: black</option><option value="white">Binary masked: white</option></select>' + views +
            '<script>document.getElementById("mode").addEventListener("change",event=>{document.querySelectorAll("section[data-mode]").forEach(section=>{'
            'section.querySelector("video").pause();section.hidden=section.dataset.mode!==event.target.value;});});</script>'
            '<h2>Diagnostics</h2><pre>' + html.escape(json.dumps(clean(metrics), indent=2)) +
            '</pre><h2>Runtime and Configuration</h2><p>Missing legacy memory stays null. GPU memory is a sampled device-wide peak when reported. '
            'InferenceSeconds and full-run wall-clock seconds are distinct; processing 149 versus 49 frames is not an equal-work throughput comparison.</p><pre>' +
            html.escape(json.dumps(clean({'runs': runs, 'comparability': comparability}), indent=2)) +
            '</pre><a href="report.json">Report and hashes</a> | <a href="timing.json">Full mapping and original timings</a></html>')
    controls = Path(__file__).with_name('viewer-controls.js').read_bytes()
    (args.output / 'viewer-controls.js').write_bytes(controls)
    page = page.replace('</html>', '<script src="viewer-controls.js"></script></html>')
    (args.output / 'index.html').write_text(page)
    report['outputFiles'] = [{'file': p.name, 'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(args.output.iterdir()) if p.is_file()]
    report['hashPolicy'] = 'All input frames hashed in original run reports; all delivered artifacts hashed except recursive report self-hash.'
    dump(args.output / 'report.json', report)
    if sum(p.stat().st_size for p in args.output.iterdir()) >= 100_000_000:
        raise ValueError('Output exceeded 100 MB budget')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=['3b', '7b'], required=True)
    parser.add_argument('--input-dir', type=Path, required=True, help='Original 49-frame input directory')
    parser.add_argument('--triplicate-input-dir', type=Path, required=True)
    parser.add_argument('--baseline-results-dir', type=Path, required=True, help='Parent of baseline 3b/ and 7b/')
    parser.add_argument('--triplicate-results-dir', type=Path, required=True, help='Parent of triplicate 3b/ and 7b/')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--per-frame-baseline-dir', type=Path, help='Optional normalized Current RealESRNet metadata.json +49 RGB PNGs')
    args = parser.parse_args(argv)
    if args.output.exists():
        parser.error('Output must be NEW; never overwrite previous comparisons')
    args.output.mkdir(parents=True)
    try:
        analyze(args)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        for path in args.output.iterdir():
            if path.is_file():
                path.unlink()
        dump(args.output / 'report.json', {'status': 'partial', 'comparisonGenerated': False, 'reason': clean(str(error)), 'notes': NOTES})
        (args.output / 'index.html').write_text('<!doctype html><meta charset="utf-8"><h1>Comparison not generated</h1><p>' + html.escape(clean(str(error))) + '</p><a href="report.json">Partial report</a>')
        print('Partial comparison only; both complete successful runs required.', file=sys.stderr)
        return 2
    print('Ready: ' + str(args.output / 'index.html'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
