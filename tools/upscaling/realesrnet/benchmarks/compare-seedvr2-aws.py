#!/usr/bin/env python3
"""Offline comparison of downloaded AWS SeedVR2 probes; never runs inference/network I/O.

Exit 0: complete; 2: partial/invalid inputs (report only, no comparison media).
The output must be a new directory so stale media cannot masquerade as a result.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = (1536, 864)
SELECTED = (0, 8, 16, 24, 31)
LABELS = ('ORIGINAL', 'SeedVR2 3B', 'SeedVR2 7B')
PANEL_SIZE = (4608, 1044)
LIMIT = 100_000_000
NOTES = {
    'configuration': '3B FP8 versus normal (not Sharp) 7B FP8 mixed block35 FP16; '
                     '16 versus 28 blocks swapped. Runtime differences are not a pure architecture benchmark.',
    'settings': 'Authorized probe settings: seed 314159, batch 5, input/latent noise 0, color correction none. '
                'These settings describe the probe; command.json is included when available for verification.',
    'timing': '49 input ordinals at 15 fps = 3.266667 seconds; analysis videos show only 32 core ordinals '
              '(clip 8..39) at 15 fps. Source duration is 62 ticks; source tick cadence is unknown. '
              'Playback is NOT original-timing playback. Original timing metadata is preserved in timing.json.',
    'geometry': 'Every panel uses the same 1536x864 canvas. RAW RGB is the default and preserves model '
                'pixels outside the source silhouette; the original gray input is nearest-neighbor 4x. '
                'Only masked black/white modes restore the shared nearest-4x binary 0/255 source alpha. '
                'AWS RGB is never resampled. PNG comparisons are authoritative; MP4 is lossy preview.',
    'ghosting': 'Mask restoration can hide ghosting outside the current silhouette. The core-0 / clip-8 '
                'diagnostic measures mean absolute RGB departure from gray 128 in source-mask-1 minus '
                'source-mask-0, expanded with nearest 4x. This is a descriptive next-pose-only region, '
                'not proof that a ghost is the next pose, not a quality score, and not a confirmed VAE '
                'or other root cause. Native input is measured in the same region as a control.',
    'metrics': 'Foreground reprojection MAE is RGB 0..255 error after premultiplied-mask 4x4 box '
               'downsampling and normalization by coverage, compared with original source RGB. '
               'Hold flicker is adjacent RGB MAE only inside a one-source-pixel-eroded endpoint mask '
               '(4 output pixels), for clip 0..8 and 39..48 separately. No moving-frame temporal score. '
               'MAE is a consistency diagnostic, NOT a perceptual quality score or a quality winner.',
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def clean(value, key=''):
    """Keep provenance but never echo credentials, URLs, or original absolute paths."""
    if re.search(r'token|secret|password|credential|authorization|access.?key', key, re.I):
        return '[REDACTED]'
    if isinstance(value, dict):
        return {k: clean(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v, key) for v in value]
    if isinstance(value, str):
        value = re.sub(r'https?://[^\s\"\'<>]+|s3://[^\s\"\'<>]+', '[URL REDACTED]', value)
        value = re.sub(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bhf_[A-Za-z0-9]+\b', '[KEY REDACTED]', value)
        value = re.sub(r'(?i)\b(token|secret|password|authorization|credential|access_key)\s*[:=]\s*\S+',
                       r'\1=[REDACTED]', value)
        value = re.sub(r'(?<!\w)/(?:[^\s\"\'<>]+)', '[PATH REDACTED]', value)
    return value


def dump(path, value):
    path.write_text(json.dumps(clean(value), indent=2, allow_nan=False) + '\n')


def local(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix.lower() == '.env':
        raise ValueError('Unsafe input artifact path')
    return path


def verified(root, name, expected):
    path = local(root, name)
    actual = sha256(path)
    if actual != expected:
        raise ValueError(f'Hash mismatch: {Path(name).name}')
    return path


def rgb(path):
    with Image.open(path) as image:
        if image.size != SIZE:
            raise ValueError(f'Expected exact 1536x864 without resampling: {path.name}')
        image.load()
        return np.asarray(image.convert('RGB'))


def reproject_mae(high, source, alpha):
    h, w = alpha.shape
    mask = np.repeat(np.repeat(alpha.astype(np.float32) / 255, 4, 0), 4, 1)
    weighted = (high.astype(np.float32) * mask[..., None]).reshape(h, 4, w, 4, 3).sum((1, 3))
    coverage = mask.reshape(h, 4, w, 4).sum((1, 3))
    projected = weighted / np.maximum(coverage[..., None], 1)
    foreground = coverage > 0
    if not foreground.any():
        return None
    return float(np.abs(projected - source.astype(np.float32))[foreground].mean())


def masked_mae(a, b, inside):
    return float(np.abs(a.astype(np.float32) - b.astype(np.float32))[inside].mean()) if inside.any() else None


def composite(image, mask, background):
    return np.where(mask[..., None] > 0, image, background).astype(np.uint8)


def validate_per_frame(root, meta, input_hash, metadata_hash):
    manifest = json.loads((root / 'metadata.json').read_text())
    if (manifest.get('model'), manifest.get('inputSHA256'), manifest.get('canvas')) != ('RealESRNet_x4plus', input_hash, [1536, 864]):
        raise ValueError('Per-frame model/input/canvas identity mismatch')
    manifest = {**manifest, 'codec': manifest.get('codec') or manifest.get('storage'),
                'provenance': manifest.get('provenance') or manifest.get('modelProvenance')}
    if not manifest.get('codec') or not manifest.get('provenance'):
        raise ValueError('Per-frame cache requires explicit codec and provenance (including any lossy upstream encoding)')
    expected = [e['sourceOrdinal'] for e in meta['timeline']]
    mapping = manifest.get('sourceMapping')
    if mapping is None:
        records = manifest['sourceFrames']
        if len(records) != 32:
            raise ValueError('Per-frame source identity requires 32 source records')
        for i, record in enumerate(records):
            original = meta['sourceFrames'][i]
            if record['sourceOrdinal'] != i or record['sourceSHA256'] != original['sourceSHA256']:
                raise ValueError('Per-frame original source SHA mismatch')
            if record.get('sourceMaskSHA256', original['maskSHA256']) != original['maskSHA256']:
                raise ValueError('Per-frame original mask SHA mismatch')
            if record.get('sourceFrameId') and record['sourceFrameId'] != original.get('sourceFrameId'):
                raise ValueError('Per-frame source frame identity mismatch')
        if [record['sourceOrdinal'] for record in manifest['frames']] != expected:
            raise ValueError('Per-frame source ordinal mapping mismatch')
        mapping = {'sourceMetadataSHA256': metadata_hash, 'clipToSourceOrdinal': expected}
    if isinstance(mapping, dict):
        if mapping.get('sourceMetadataSHA256') != metadata_hash or mapping.get('clipToSourceOrdinal') != expected:
            raise ValueError('Per-frame source mapping identity mismatch')
    elif isinstance(mapping, list):
        if len(mapping) != 49:
            raise ValueError('Per-frame source mapping requires all 49 clips')
        for i, record in enumerate(mapping):
            if (record['clipFrame'], record['sourceOrdinal'], record['sourceSHA256']) != (i, expected[i], meta['sourceFrames'][expected[i]]['sourceSHA256']):
                raise ValueError('Per-frame source SHA/ordinal mismatch')
    else:
        raise ValueError('Unsupported per-frame sourceMapping')
    if len(manifest['frames']) != 49:
        raise ValueError('Per-frame baseline requires all 49 frames including holds')
    paths = []
    for i, record in enumerate(manifest['frames']):
        if record['clipFrame'] != i:
            raise ValueError('Per-frame clips must be contiguous, ordered 0..48')
        path = verified(root, record['file'], record['sha256'])
        with Image.open(path) as image:
            if image.size != SIZE or image.mode != 'RGB' or image.format != 'PNG':
                raise ValueError('Normalized per-frame frames must be exact RGB PNG 1536x864')
            image.verify()
        paths.append(path)
    return {'metadata': manifest, 'metadataSHA256': sha256(root / 'metadata.json'),
            'runtime': None, 'gpuMemory': None, 'inferenceSeconds': None,
            'runtimeNote': 'Cached output; no comparable current-device timing or GPU measurement.'}, paths


def per_frame_rgb(paths, clip, masks, timeline):
    alpha = masks[timeline[clip]['sourceOrdinal']]
    return composite(rgb(paths[clip]), np.repeat(np.repeat(alpha, 4, 0), 4, 1), 128)


def per_frame_metrics(reader, sources, masks):
    errors = [reproject_mae(reader(i + 8), sources[i], masks[i]) for i in range(32)]
    holds = {}
    for name, ordinal, start, end in [('first', 0, 0, 8), ('last', 31, 39, 48)]:
        padded = Image.new('L', (386, 218))
        padded.paste(Image.fromarray(masks[ordinal]), (1, 1))
        inside = np.repeat(np.repeat(np.asarray(padded.filter(ImageFilter.MinFilter(3)).crop((1, 1, 385, 217))) > 0, 4, 0), 4, 1)
        previous, values = reader(start), []
        for clip in range(start + 1, end + 1):
            current = reader(clip)
            values.append(masked_mae(previous, current, inside))
            previous = current
        holds[name] = {'clipRangeInclusive': [start, end], 'adjacentMAE': values,
                       'meanMAE': float(np.mean(values)) if inside.any() else None}
    return {'coreReprojectionMAE': errors, 'meanCoreReprojectionMAE': float(np.mean(errors)), 'holdFlicker': holds,
            'interpretation': 'Cache/source consistency only, not an HD quality ranking; nearest-neighbor can have zero reprojection error.'}


def quad_panel(images, labels, ordinal, mode, preview=False):
    width, height, bar, title, small = (768, 432, 72, 32, 24) if preview else (1536, 864, 180, 84, 60)
    canvas = Image.new('RGB', (width * 2, (height + bar) * 2), '#101010')
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype('DejaVuSans-Bold.ttf', title)
    detail = ImageFont.truetype('DejaVuSans-Bold.ttf', small)
    for index, (image, label) in enumerate(zip(images, labels)):
        x, y = index % 2 * width, index // 2 * (height + bar)
        picture = Image.fromarray(image)
        if preview:
            picture = picture.resize((width, height), Image.Resampling.NEAREST)
        canvas.paste(picture, (x, y + bar))
        draw.text((x + 12, y + (6 if preview else 16)), label, font=font, fill='white', anchor='lt')
        draw.text((x + 12, y + (42 if preview else 108)), f'Core {ordinal:02d} | {mode}', font=detail, fill='white', anchor='lt')
    return canvas


def display_images(original, models, alpha, background):
    mask = np.repeat(np.repeat(alpha, 4, 0), 4, 1)
    nearest = np.repeat(np.repeat(original, 4, 0), 4, 1)
    if background is None:
        return [nearest, *models]
    return [composite(a, mask, background) for a in [nearest, *models]]


def ghost_region_metrics(native_input, models, current_mask, next_mask):
    region = np.repeat(np.repeat((next_mask > 0) & (current_mask == 0), 4, 0), 4, 1)
    values = [np.repeat(np.repeat(native_input, 4, 0), 4, 1), *models]
    return {'coreOrdinal': 0, 'clipFrame': 8, 'nextSourceOrdinal': 1,
            'region': 'next source mask minus current source mask; nearest 4x; outside current silhouette',
            'regionOutputPixels': int(region.sum()),
            'meanAbsoluteRGBDepartureFrom128': {
                name: float(np.abs(image.astype(np.float32)[region] - 128).mean()) if region.any() else None
                for name, image in zip(('nativeInput', '3b', '7b'), values)},
            'interpretation': 'Descriptive background contamination diagnostic only; root cause unknown; no automatic quality winner.'}


def encode(output, name, frames, size=PANEL_SIZE):
    # Stream raw frames: no on-disk temporary PNG sequence, no output resampling.
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-f', 'rawvideo', '-pixel_format', 'rgb24',
               '-video_size', f'{size[0]}x{size[1]}', '-framerate', '15', '-i', 'pipe:0', '-an',
               '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
               '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-fs', '24000000', str(output / name)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for frame in frames:
            process.stdin.write(frame.tobytes())
        process.stdin.close()
        errors = process.stderr.read().decode(errors='replace')
        if process.wait():
            raise ValueError('ffmpeg failed: ' + clean(errors))
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        process.stdin.close()
        process.stderr.close()


def panel(images, ordinal, background, thumbnail=False):
    width, bar, title_size, ordinal_size = (512, 72, 32, 24) if thumbnail else (1536, 180, 84, 60)
    height = 288 if thumbnail else 864
    canvas = Image.new('RGB', (width * 3, height + bar), '#101010')
    draw = ImageDraw.Draw(canvas)
    title_font = ImageFont.truetype('DejaVuSans-Bold.ttf', title_size)
    ordinal_font = ImageFont.truetype('DejaVuSans-Bold.ttf', ordinal_size)
    for col, (image, label) in enumerate(zip(images, LABELS)):
        picture = Image.fromarray(image)
        if thumbnail:
            method = Image.Resampling.NEAREST if background == 'raw' else Image.Resampling.LANCZOS
            picture = picture.resize((width, height), method)
        canvas.paste(picture, (col * width, bar))
        # Labels are drawn at their final size, never shrunk with the picture.
        x = col * width + (16 if thumbnail else 48)
        draw.text((x, 6 if thumbnail else 16), label, font=title_font, fill='white', anchor='lt')
        draw.text((x, 42 if thumbnail else 108), f'Core {ordinal:02d} / clip {ordinal + 8:02d} | {background}',
                  font=ordinal_font, fill='#ffffff', anchor='lt')
    return canvas


def validate(input_dir, results_dir):
    metadata_path = input_dir / 'source-metadata.json'
    meta = json.loads(metadata_path.read_text())
    expected = {'canvas': [384, 216], 'sourceFrameCount': 32, 'sourceDurationTicks': 62,
                'sourceTickRateKnown': False, 'fps': 15, 'clipFrameCount': 49,
                'holdsBefore': 8, 'holdsAfter': 9, 'coreClipRangeInclusive': [8, 39]}
    for key, value in expected.items():
        if meta.get(key) != value:
            raise ValueError(f'Unsupported metadata: {key}')
    if len(meta['sourceFrames']) != 32 or len(meta['timeline']) != 49:
        raise ValueError('Incomplete source metadata')
    sources, masks, provenance = [], [], []
    for i, record in enumerate(meta['sourceFrames']):
        if record['sourceOrdinal'] != i:
            raise ValueError('Source ordinals not contiguous')
        source = verified(input_dir, record['alignedRGBA'], record['alignedSHA256'])
        mask_path = verified(input_dir, record['mask'], record['maskSHA256'])
        with Image.open(source) as image:
            if image.size != (384, 216) or image.mode != 'RGBA':
                raise ValueError('Source must be aligned native RGBA')
            rgba = np.asarray(image).copy()
        with Image.open(mask_path) as image:
            if image.size != (384, 216) or image.mode != 'L':
                raise ValueError('Source mask must be native L')
            alpha = np.asarray(image).copy()
        if not set(np.unique(alpha)).issubset({0, 255}) or not np.array_equal(alpha, rgba[..., 3]):
            raise ValueError('Source alpha and binary mask differ')
        sources.append(rgba[..., :3])
        masks.append(alpha)
        provenance.append({'ordinal': i, 'sourceSHA256': record['sourceSHA256'],
                           'alignedSHA256': sha256(source), 'maskSHA256': sha256(mask_path),
                           'alpha4xSHA256': hashlib.sha256(np.repeat(np.repeat(alpha, 4, 0), 4, 1).tobytes()).hexdigest()})
    for i, entry in enumerate(meta['timeline']):
        ordinal = min(max(i - 8, 0), 31)
        if entry['clipFrame'] != i or entry['sourceOrdinal'] != ordinal or (entry['role'] == 'core') != (8 <= i <= 39):
            raise ValueError('Unexpected clip/core mapping')
        verified(input_dir, entry['rgbFile'], entry['rgbSHA256'])
    if sum(r['durationTicks'] for r in meta['sourceFrames']) != 62:
        raise ValueError('Source ticks do not sum to 62')
    for start, end in ((0, 8), (39, 48)):
        if len({e['rgbSHA256'] for e in meta['timeline'][start:end + 1]}) != 1:
            raise ValueError('Endpoint inputs are not identical repeats')
    input_hash = sha256(input_dir / 'input.mp4')
    runs = {}
    for variant in ('3b', '7b'):
        root = results_dir / variant
        path = root / 'report.json'
        report = json.loads(path.read_text())
        if str(report.get('status')).lower() != 'succeeded':
            raise ValueError(f'{variant} report has not succeeded')
        if report.get('input', {}).get('sha256') != input_hash:
            raise ValueError(f'{variant} input SHA differs from local input')
        if report.get('modelVariant', variant) != variant:
            raise ValueError('Model variant mismatch')
        expected_model = ('seedvr2_ema_3b_fp8_e4m3fn.safetensors' if variant == '3b'
                          else 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors')
        if report.get('ditModel', expected_model) != expected_model or report.get('modelStyle', 'normal') != 'normal':
            raise ValueError('Unexpected model weights/style for comparison label')
        expected_swaps = 16 if variant == '3b' else 28
        if report.get('blocksToSwap', expected_swaps) != expected_swaps:
            raise ValueError('Unexpected offload configuration for comparison label')
        frames = root / 'frames/input'
        if sorted(p.name for p in frames.glob('*.png')) != [f'input_{i:06d}.png' for i in range(49)]:
            raise ValueError(f'{variant} requires all 49 contiguous frames')
        records = report['output']['files']
        if len(records) != 49:
            raise ValueError('Missing output hash records')
        checked = []
        for i, record in enumerate(records):
            name = f'input_{i:06d}.png'
            if record['file'] != name:
                raise ValueError('Unexpected frame record ordering')
            frame = verified(frames, name, record['sha256'])
            rgb(frame)
            checked.append({'file': f'{variant}/frames/input/{name}', 'sha256': sha256(frame), 'bytes': frame.stat().st_size})
        command = root / 'command.json'
        runs[variant] = {'report': report, 'reportSHA256': sha256(path),
                         'gpuMemory': report.get('gpuMemory'), 'files': checked,
                         'wallClockSeconds': report.get('finishedAtUnix', 0) - report.get('startedAtUnix', 0)
                         if 'finishedAtUnix' in report and 'startedAtUnix' in report else None,
                         'command': json.loads(command.read_text()) if command.exists() else None,
                         'commandSHA256': sha256(command) if command.exists() else None}
    return meta, sources, masks, provenance, runs, input_hash


def make_analysis(args, output):
    meta, sources, masks, provenance, runs, input_hash = validate(args.input_dir, args.results_dir)
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise ValueError('Local ffmpeg and ffprobe are required')
    metrics = {}
    for variant in ('3b', '7b'):
        root = args.results_dir / variant / 'frames/input'
        errors = [reproject_mae(rgb(root / f'input_{i + 8:06d}.png'), sources[i], masks[i]) for i in range(32)]
        holds = {}
        for name, ordinal, start, end in [('first', 0, 0, 8), ('last', 31, 39, 48)]:
            # Erode at source resolution before exact 4x expansion, including canvas border.
            padded = Image.new('L', (386, 218))
            padded.paste(Image.fromarray(masks[ordinal]), (1, 1))
            eroded = np.asarray(padded.filter(ImageFilter.MinFilter(3)).crop((1, 1, 385, 217))) > 0
            inside = np.repeat(np.repeat(eroded, 4, 0), 4, 1)
            previous = rgb(root / f'input_{start:06d}.png')
            values = []
            for i in range(start + 1, end + 1):
                current = rgb(root / f'input_{i:06d}.png')
                values.append(masked_mae(previous, current, inside))
                previous = current
            holds[name] = {'clipRangeInclusive': [start, end], 'adjacentMAE': values,
                           'meanMAE': float(np.mean([v for v in values if v is not None])) if inside.any() else None,
                           'interiorOutputPixels': int(inside.sum())}
        metrics[variant] = {'coreReprojectionMAE': errors, 'meanCoreReprojectionMAE': float(np.mean(errors)), 'holdFlicker': holds}

    def native_input(ordinal):
        with Image.open(local(args.input_dir, meta['timeline'][ordinal + 8]['rgbFile'])) as image:
            if image.size != (384, 216):
                raise ValueError('Native gray RGB input must be 384x216')
            return np.asarray(image.convert('RGB')).copy()

    metrics['nextMaskOnlyGhostRegion'] = ghost_region_metrics(native_input(0), [
        rgb(args.results_dir / v / 'frames/input/input_000008.png') for v in ('3b', '7b')], masks[0], masks[1])
    control, control_paths = None, None
    notes = dict(NOTES)
    labels = LABELS
    if args.per_frame_baseline_dir:
        control, control_paths = validate_per_frame(args.per_frame_baseline_dir, meta, input_hash, sha256(args.input_dir / 'source-metadata.json'))
        labels = ('ORIGINAL', 'RealESRNet per-frame RGB', 'SeedVR2 3B', 'SeedVR2 7B')
        metrics['currentPerFrame'] = per_frame_metrics(lambda clip: per_frame_rgb(control_paths, clip, masks, meta['timeline']), sources, masks)
        notes['current'] = ('Current RealESRNet uses cached per-frame RGB restored with the trusted original binary mask over gray128 BEFORE display. '
                            'Unlike Seed RAW this control cannot show outside-silhouette context. Cache codec/provenance: ' +
                            json.dumps(clean(control['metadata'].get('codec'))) + '; ' + json.dumps(clean(control['metadata'].get('provenance'))) +
                            '. ' + str(control['metadata'].get('runtimePackCaveat', 'Not a byte-identical runtime room pack.')) +
                            ' Cache timings/GPU memory are null, not comparable-device measurements. Four-method video/contact previews use nearest 2:1 downscale; full PNG tiles retain 1536x864. Order: top Original / RealESRNet per-frame RGB; bottom Seed3B / Seed7B.')
    video_size = (1536, 1008) if control else PANEL_SIZE

    def images(ordinal, background):
        original = native_input(ordinal) if background is None else sources[ordinal]
        models = [rgb(args.results_dir / v / 'frames/input' / f'input_{ordinal + 8:06d}.png') for v in ('3b', '7b')]
        if control:
            models.insert(0, per_frame_rgb(control_paths, ordinal + 8, masks, meta['timeline']))
        return display_images(original, models, masks[ordinal], background)

    for background, value in [('raw', None), ('black', 0), ('white', 255)]:
        def stream():
            for i in range(32):
                arrays = images(i, value)
                yield np.asarray(quad_panel(arrays, labels, i, background, preview=True) if control else panel(arrays, i, background))
        encode(output, f'comparison-{background}-15fps.mp4', stream(), size=video_size)
        row_height = 1008 if control else 360
        sheet = Image.new('RGB', (1536, row_height * len(SELECTED)), '#101010')
        for row, i in enumerate(SELECTED):
            frame_images = images(i, value)
            full = quad_panel(frame_images, labels, i, background) if control else panel(frame_images, i, background)
            full.save(output / f'core-{i:02d}-{background}-full.png', optimize=True)
            thumb = quad_panel(frame_images, labels, i, background, preview=True) if control else panel(frame_images, i, background, thumbnail=True)
            sheet.paste(thumb, (0, row * row_height))
        if background == 'raw':
            sheet.save(output / 'contact-raw.png', optimize=True)
        else:
            sheet.save(output / f'contact-{background}.jpg', quality=90)
        video = output / f'comparison-{background}-15fps.mp4'
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames',
            '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate', '-of', 'json', str(video)], text=True))['streams'][0]
        if (int(info['nb_read_frames']), info['width'], info['height'], info['avg_frame_rate']) != (32, *video_size, '15/1'):
            raise ValueError('Preview truncated or wrong dimensions/cadence')

    optional = ''
    if args.replicate_a3b_video:
        path = args.replicate_a3b_video
        if path.suffix.lower() != '.mp4' or not path.is_file() or path.stat().st_size > 20_000_000:
            raise ValueError('Optional Replicate reference must be a local MP4 under 20 MB')
        shutil.copyfile(path, output / 'replicate-a3b-reference.mp4')
        optional = '<h2>Optional Replicate A3b reference</h2><p>Separate reference only; wrapper geometry/timing may differ; excluded from AWS metrics.</p><video controls src="replicate-a3b-reference.mp4"></video>'

    dump(output / 'timing.json', {'sourceMetadata': meta, 'videoCoreOrdinals': list(range(32)), 'fps': 15,
                                  'clipCoreRangeInclusive': [8, 39], 'sourceTickRateKnown': False})
    report = {'status': 'complete', 'notes': notes, 'inputSHA256': input_hash,
              'perFrameBaseline': control, 'layout': '2x2' if control else '1x3', 'previewCanvas': video_size,
              'previewResampling': 'NEAREST 2:1' if control else 'none', 'perFrameRawMaskRestored': bool(control),
              'analyzerSHA256': sha256(Path(__file__)),
              'sourceMetadataSHA256': sha256(args.input_dir / 'source-metadata.json'),
              'sourceAlphaSharedByMaskedPanels': True, 'rawRGBMaskRestored': False,
              'displayModes': ['raw', 'black', 'white'], 'defaultDisplayMode': 'raw',
              'sourceFiles': provenance, 'runs': runs,
              'metrics': metrics, 'selectedCoreOrdinals': SELECTED, 'coreFrames': 32,
              'comparisonCanvas': SIZE, 'rgbResampling': 'none', 'maskUpsampling': 'NEAREST 4x binary',
              'optionalReplicate': {'sha256': sha256(args.replicate_a3b_video)} if args.replicate_a3b_video else None}
    paragraphs = ''.join(f'<p id="{key}"><strong>{key.title()}.</strong> {html.escape(value)}</p>' for key, value in notes.items())
    headings = '<div class="panel-headings' + (' quad' if control else '') + '" aria-label="Panel order">' + ''.join(f'<strong>{label}</strong>' for label in labels) + '</div>'
    views = ''
    for mode, title in [('raw', 'RAW RGB: original gray input / unmasked AWS outputs'),
                        ('black', 'Binary Masked: Black'), ('white', 'Binary Masked: White')]:
        hidden = '' if mode == 'raw' else ' hidden'
        contact = 'contact-raw.png' if mode == 'raw' else f'contact-{mode}.jpg'
        links = ''.join(f'<li><a href="core-{i:02d}-{mode}-full.png">Core {i:02d} / clip {i + 8:02d}, {mode}, full-resolution PNG</a></li>' for i in SELECTED)
        autoplay = ' autoplay' if mode == 'raw' else ''
        views += (f'<section data-mode="{mode}" aria-labelledby="heading-{mode}"{hidden}>'
                  f'<h2 id="heading-{mode}">{title}</h2>{headings}<video controls{autoplay} muted loop playsinline preload="metadata" '
                  f'aria-label="{title}" src="comparison-{mode}-15fps.mp4"></video>'
                  f'<h3>Selected core frames: 0, 8, 16, 24, 31</h3>{headings}<img alt="{title}: selected frames" '
                  f'src="{contact}"><ul>{links}</ul></section>')
    page = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            '<title>Offline AWS SeedVR2 comparison</title><style>body{margin:24px auto;padding:0 16px;max-width:1500px;'
            'background:#181818;color:#eee;font:16px/1.5 system-ui}video,img{width:100%;height:auto}a{color:#b9dcff}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere}select{padding:10px;font:inherit;max-width:100%}'
            '.panel-headings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:#000;color:#fff;'
            'font-size:24px;line-height:1.25;text-align:center;padding:14px 0;gap:0}'
            '.panel-headings strong{padding:0 4px;overflow-wrap:anywhere}'
            '.panel-headings.quad{grid-template-columns:repeat(2,minmax(0,1fr))}'
            '@media(max-width:600px){.panel-headings{font-size:16px;padding:12px 0}body{padding:0 8px}}</style>'
            '<h1>' + ('Original / RealESRNet per-frame RGB / SeedVR2 3B / SeedVR2 7B' if control else 'Original nearest 4x / AWS 3B / AWS normal 7B') + '</h1>' + paragraphs +
            '<p>Panels are synchronized in a single encoded frame, in the title order. All 32 core frames are included. '
            'Full PNG links retain native output pixels. No automated quality winner.</p>'
            '<label for="display-mode">Display mode</label> <select id="display-mode" aria-describedby="mode-help">'
            '<option value="raw" selected>RAW RGB (default: reveals outside-silhouette ghosts)</option>'
            '<option value="black">Binary masked: black</option><option value="white">Binary masked: white</option></select>'
            '<p id="mode-help">RAW preserves all model RGB. Masked modes hide pixels outside the original silhouette.</p>' + views +
            '<script>document.getElementById("display-mode").addEventListener("change",event=>{'
            'const sections=[...document.querySelectorAll("section[data-mode]")];'
            'const previous=sections.find(section=>!section.hidden).querySelector("video");'
            'const time=previous.currentTime;sections.forEach(section=>{const video=section.querySelector("video");'
            'video.pause();section.hidden=section.dataset.mode!==event.target.value;'
            'if(!section.hidden){if(video.readyState>0)video.currentTime=time;'
            'else video.addEventListener("loadedmetadata",()=>{video.currentTime=time},{once:true});}});});</script>' + optional +
            '<h2>Measured Diagnostics</h2><pre>' + html.escape(json.dumps(clean(metrics), indent=2)) +
            '</pre><h2>Run Provenance</h2><p>Missing legacy 3B GPU memory remains null. 7B memory is a sampled device-wide peak, '
            'not a torch allocator/process peak. Wall clock includes setup/weight download; inferenceSeconds is separate.</p><pre>' +
            html.escape(json.dumps(clean({v: {k: value for k, value in r.items() if k != 'files'} for v, r in runs.items()}), indent=2)) +
            '</pre><p><a href="report.json">JSON report, hashes and metrics</a> | <a href="timing.json">Original timing sidecar</a></p></html>')
    controls = Path(__file__).with_name('viewer-controls.js').read_bytes()
    (output / 'viewer-controls.js').write_bytes(controls)
    page = page.replace('</html>', '<script src="viewer-controls.js"></script></html>')
    (output / 'index.html').write_text(page)
    report['outputFiles'] = [{'file': p.name, 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in sorted(output.iterdir()) if p.is_file()]
    report['hashPolicy'] = 'All delivered artifacts hashed except report.json itself (no recursive self-hash). Input PNGs and original reports hashed separately.'
    dump(output / 'report.json', report)
    if sum(p.stat().st_size for p in output.iterdir() if p.is_file()) >= LIMIT:
        raise ValueError('Analysis exceeded 100 MB disk budget')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--results-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--per-frame-baseline-dir', type=Path, help='Optional normalized Current RealESRNet metadata.json + 49 RGB PNGs')
    parser.add_argument('--replicate-a3b-video', type=Path, help='Explicit local MP4 reference only; never fetched, excluded from metrics')
    args = parser.parse_args(argv)
    if args.output.exists():
        parser.error('Output must be a NEW directory; existing files are never overwritten')
    args.output.mkdir(parents=True)
    try:
        make_analysis(args, args.output)
    except (ValueError, KeyError, OSError, TypeError, subprocess.SubprocessError) as error:
        # This directory was created by this invocation; discard incomplete media, not inputs.
        for path in args.output.iterdir():
            if path.is_file():
                path.unlink()
        available = {}
        for variant in ('3b', '7b'):
            path = args.results_dir / variant / 'report.json'
            try:
                available[variant] = {'report': json.loads(path.read_text()), 'reportSHA256': sha256(path)}
            except (OSError, ValueError):
                available[variant] = {'status': 'missing or unreadable report'}
        dump(args.output / 'report.json', {'status': 'partial', 'comparisonGenerated': False,
             'reason': clean(str(error)), 'notes': NOTES,
             'availableRuns': available,
             'required': 'Both succeeded report.json files and all 49 validated frames per model; no fabricated frames.'})
        (args.output / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Partial comparison</title><h1>Comparison not generated</h1><p>Both complete successful runs are required. No substitute frames or quality conclusion.</p><p>' + html.escape(clean(str(error))) + '</p><a href="report.json">Partial report</a>')
        print('Partial report only; comparison not generated.', file=sys.stderr)
        return 2
    print('Complete offline analysis: ' + str(args.output / 'index.html'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
