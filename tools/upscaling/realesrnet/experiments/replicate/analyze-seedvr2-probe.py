#!/usr/bin/env python3
"""Offline analysis of the historical 32-source/49-frame SeedVR2 probe.

Only BASE/analysis is written. --self-test uses temporary synthetic data instead.
No API, model execution, or network access.
"""

import argparse
import copy
import hashlib
import html
import json
import os
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


SIZE = (1536, 864)
TICK_MS = 41


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_directory(path):
    path = path.expanduser().resolve()
    repo = Path(__file__).resolve().parents[5]
    require(not path.is_relative_to(repo), 'Use a private directory outside the repository')
    require(not any(p.lower() in ('public', 'www', 'wwwroot', 'htdocs') for p in path.parts),
            'Do not write to or serve a public directory')
    return path


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def pixel_sha(image):
    return hashlib.sha256(image.tobytes()).hexdigest()


def local_path(root, relative):
    p = Path(relative)
    require(not p.is_absolute() and '..' not in p.parts and ':' not in relative,
            f'Unsafe relative media path: {relative}')
    result = (root / p).resolve()
    require(result.is_relative_to(root.resolve()), f'Media escapes root: {relative}')
    return result


def validate_metadata(meta):
    require(type(meta['fps']) is int and meta['fps'] > 0, 'Expected positive metadata fps')
    require(meta['canvas'] == [384, 216], 'Expected fixed 384x216 source canvas')
    require(meta['sourceFrameCount'] == 32 and len(meta['sourceFrames']) == 32,
            'Expected complete 32 source ordinals')
    require(meta['clipFrameCount'] == 49 and len(meta['timeline']) == 49,
            'Expected 49 input timeline frames')
    require((meta['holdsBefore'], meta['holdsAfter'], meta['coreClipRangeInclusive']) ==
            (8, 9, [8, 39]), 'Unexpected core/hold mapping')
    require([f['sourceOrdinal'] for f in meta['sourceFrames']] == list(range(32)),
            'Source ordinals reordered')
    ticks = [f['durationTicks'] for f in meta['sourceFrames']]
    require(all(type(t) is int and t > 0 for t in ticks) and sum(ticks) == 62
            and meta['sourceDurationTicks'] == 62, 'Expected 62 positive source ticks')
    expected = [0] * 8 + list(range(32)) + [31] * 9
    for i, (entry, ordinal) in enumerate(zip(meta['timeline'], expected)):
        role = 'first_hold' if i < 8 else 'core' if i < 40 else 'last_hold'
        require(entry['clipFrame'] == i and entry['sourceOrdinal'] == ordinal
                and entry['role'] == role and entry['useForQuality'] == (role == 'core')
                and entry['durationTicks'] == ticks[ordinal], f'Invalid timeline entry {i}')
    for indices in (range(9), range(39, 49)):
        require(len({meta['timeline'][i]['rgbSHA256'] for i in indices}) == 1,
                'Hold input images are not identical')
    return ticks


def probe(path, expected_fps=None):
    data = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-count_frames',
        '-select_streams', 'v:0', '-show_streams', '-show_format', '-show_frames',
        '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate,avg_frame_rate,duration:'
        'format=duration:frame=best_effort_timestamp_time,pkt_duration_time',
        '-of', 'json', str(path)], text=True))
    require(len(data['streams']) == 1, f'No video stream: {path}')
    s = data['streams'][0]
    if expected_fps is not None:
        require((s['width'], s['height'], int(s['nb_read_frames'])) == (1280, 720, 49),
                f'Expected 49 frames at 1280x720: {path}: {s}')
        require(Fraction(s['r_frame_rate']) == expected_fps and Fraction(s['avg_frame_rate']) == expected_fps,
                f'Expected exactly {expected_fps} fps: {path}: {s}')
        pts = [float(f['best_effort_timestamp_time']) for f in data['frames']]
        require(len(pts) == 49 and all(abs((b - a) - 1 / expected_fps) < 0.00001
                for a, b in zip(pts, pts[1:])), f'Nonuniform {expected_fps}fps timestamps: {path}')
    return data


def decoded_rgb(path):
    # Stream one frame at a time, never dump all 49 full-resolution RGB images.
    command = ['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', str(path),
               '-map', '0:v:0', '-an', '-sn', '-dn', '-vsync', '0', '-f', 'rawvideo',
               '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1']
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    try:
        for i in range(49):
            raw = bytearray()
            while len(raw) < 1280 * 720 * 3:
                chunk = process.stdout.read(1280 * 720 * 3 - len(raw))
                require(bool(chunk), f'Decoded fewer than 49 RGB frames at {i}: {path}')
                raw.extend(chunk)
            yield i, Image.frombytes('RGB', (1280, 720), bytes(raw))
        require(not process.stdout.read(1), f'Decoded more than 49 frames: {path}')
        require(process.wait() == 0, f'RGB decode failed: {path}')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
        process.wait()


def restore(rgb, mask):
    result = rgb.resize(SIZE, Image.Resampling.LANCZOS).convert('RGBA')
    alpha = mask.resize(SIZE, Image.Resampling.NEAREST)
    result.putalpha(alpha)
    require(pixel_sha(result.getchannel('A')) == pixel_sha(alpha), 'Alpha restoration failed')
    return result


def background(size, value=None):
    if value is not None:
        return Image.new('RGB', size, (value,) * 3)
    yy, xx = np.indices((size[1], size[0]))
    a = np.where((xx // 32 + yy // 32) % 2, 176, 112).astype(np.uint8)
    return Image.fromarray(np.repeat(a[:, :, None], 3, axis=2))


def composite(image, value=None):
    out = background(image.size, value)
    out.paste(image.convert('RGB'), mask=image.getchannel('A'))
    return out


def labeled(image, text):
    out = Image.new('RGB', (image.width, image.height + 28), (24, 24, 24))
    out.paste(image, (0, 28))
    ImageDraw.Draw(out).text((8, 8), text, fill='white')
    return out


def display(image, value=None):
    if image is not None:
        return composite(image, value)
    tile = Image.new('RGB', SIZE, (36, 29, 29))
    draw = ImageDraw.Draw(tile)
    draw.text((80, 80), 'FAILED RUN: no output frames or quality metrics', fill='white')
    draw.text((80, 110), 'See recorded failure details; no replacement model output', fill='white')
    return tile


def quad(images, labels, half=False):
    tiles = []
    for image, label in zip(images, labels):
        tile = display(image)
        if half:
            tile = tile.resize((768, 432), Image.Resampling.LANCZOS)
        tiles.append(labeled(tile, label))
    w, h = tiles[0].size
    out = Image.new('RGB', (w * 2, h * 2))
    for i, tile in enumerate(tiles):
        out.paste(tile, (i % 2 * w, i // 2 * h))
    return out


def encode_raw(path, images, size, fps):
    command = ['ffmpeg', '-v', 'error', '-n', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
               '-s', f'{size[0]}x{size[1]}', '-r', str(fps), '-i', 'pipe:0', '-an',
               '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
               '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(path)]
    p = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for image in images:
            require(image.size == size and image.mode == 'RGB', 'Wrong raw video frame geometry')
            p.stdin.write(image.tobytes())
        p.stdin.close()
        require(p.wait() == 0, f'Encoding failed: {path}')
    finally:
        if not p.stdin.closed:
            p.stdin.close()
        if p.poll() is None:
            p.kill()
        p.wait()


def cadence_video(directory, ticks):
    # 1kHz PNG demuxer timebase avoids default 25fps rounding of 41ms durations.
    lines = ['ffconcat version 1.0']
    for i, tick in enumerate(ticks):
        lines += [f"file 'preview/{i:04d}.png'", 'option framerate 1000',
                  f'duration {tick * TICK_MS / 1000:.3f}']
    lines += ["file 'preview/0031.png'", 'option framerate 1000']
    concat = directory / 'cadence.ffconcat'
    concat.write_text('\n'.join(lines) + '\n')
    seconds = sum(ticks) * TICK_MS / 1000
    path = directory / 'original-cadence.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe',
                    '-f', 'concat', '-safe', '0', '-i', str(concat), '-an',
                    '-fps_mode', 'vfr', '-enc_time_base', '1:1000',
                    '-c:v', 'libx264', '-threads', '2', '-bf', '0', '-preset', 'fast',
                    '-crf', '18', '-pix_fmt', 'yuv420p', '-video_track_timescale', '1000',
                    '-movflags', '+faststart', str(path)], check=True)
    data = probe(path)
    actual = float(data['format']['duration'])
    pts = [float(f['best_effort_timestamp_time']) for f in data['frames']]
    expected = np.cumsum([0] + ticks) * TICK_MS / 1000
    require(len(pts) == 33 and np.max(np.abs(np.array(pts) - expected)) <= .0011,
            f'Cadence ordinal timestamps changed: {path}')
    # The terminal sentinel adds one 1ms tick, not a new source ordinal.
    require(abs(actual - seconds) <= .002, f'Cadence duration mismatch: {actual} vs {seconds}')
    return {'targetSeconds': seconds, 'actualSeconds': actual, 'toleranceSeconds': .002,
            'maxTimestampErrorSeconds': float(np.max(np.abs(np.array(pts) - expected))),
            'encodedFrames': len(pts), 'coreOrdinals': 32, 'terminalDuplicateSentinels': 1,
            'tickMillisecondsAssumed': TICK_MS}


def load_sources(base, meta):
    sources, masks, records = [], [], []
    original_root = Path(meta['sourceManifest']).parent
    require(sha(Path(meta['sourceManifest'])) == meta['sourceManifestSHA256'],
            'Original source manifest SHA changed')
    for f in meta['sourceFrames']:
        src = local_path(original_root, f['sourceFile'])
        aligned = local_path(base / 'input', f['alignedRGBA'])
        mask_path = local_path(base / 'input', f['mask'])
        for path, expected in ((src, f['sourceSHA256']), (aligned, f['alignedSHA256']),
                               (mask_path, f['maskSHA256'])):
            require(sha(path) == expected, f'Source SHA mismatch: {path}')
        with Image.open(aligned) as image:
            require(image.mode == 'RGBA' and image.size == (384, 216), 'Invalid aligned source')
            image = image.copy()
        with Image.open(mask_path) as mask:
            require(mask.mode == 'L' and mask.size == image.size, 'Invalid source mask')
            mask = mask.copy()
        require(set(np.unique(np.asarray(mask)).tolist()) == {0, 255}, 'Nonbinary source mask')
        require(image.getchannel('A').tobytes() == mask.tobytes(), 'Source alpha/mask differ')
        sources.append(image)
        masks.append(mask)
        records.append({'sourceOrdinal': f['sourceOrdinal'], 'sourceSHA256': sha(src),
                        'sourceFrameId': f.get('sourceFrameId'), 'metadata': f.get('metadata'),
                        'durationTicks': f['durationTicks'], 'canvasXY': f.get('canvasXY'),
                        'alignedSHA256': sha(aligned), 'maskFileSHA256': sha(mask_path),
                        'maskPixelSHA256': pixel_sha(mask), 'alphaValues': [0, 255],
                        'alpha4xPixelSHA256': pixel_sha(mask.resize(SIZE, Image.Resampling.NEAREST))})
    for f in meta['timeline']:
        require(sha(local_path(base / 'input', f['rgbFile'])) == f['rgbSHA256'],
                f'Input timeline SHA changed: {f["clipFrame"]}')
    return sources, masks, records


def save_frame(directory, ordinal, image):
    image.save(directory / 'rgba' / f'{ordinal:04d}.png')
    composite(image).save(directory / 'preview' / f'{ordinal:04d}.png')


def write_html(out, labels, failures, fps):
    cards = ''
    for key, label in labels.items():
        safe_key = html.escape(key, quote=True)
        cards += f'<figure><figcaption>{html.escape(label)}</figcaption>'
        if key in failures:
            cards += '<p class="failure">FAILED: no output, no frames, no quality metrics.</p>'
            cards += f'<details><summary>Failure details</summary><pre>{html.escape(failures[key]["error"])}</pre></details>'
        else:
            cards += (f'<video muted playsinline preload="metadata" data-key="{safe_key}" '
                      f'src="{safe_key}/ordinal-core.mp4"></video>'
                      f'<a href="{safe_key}/rgba/0000.png">RGBA frame 0</a>')
        cards += '</figure>'
    (out / 'index.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'">
<title>SeedVR2 offline comparison</title><style>
body{background:#181a1b;color:#eee;font:16px system-ui;margin:24px}button,input{margin:8px}a{color:#9dd8f3}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}figure{margin:0}video{width:100%}figcaption{padding:8px;background:#303538}
img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}.failure{padding:30px;background:#402a2a}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style>
<h1>SeedVR2 local comparison</h1><p>No reference ground truth and no automatic winner. Original cadence uses 41ms per source tick (assumption; metadata tick rate unknown). Hosted 1280x720 RGB is enlarged another 1.2x with Lanczos to true 4x canvas; all alpha is original nearest 4x. Model RGB is not original-palette-preserving.</p>
<p>Primary playback: 32 source ordinals at ''' + str(fps) + ''' fps. Failed runs have no synthetic replacements.</p>
<select id="mode" aria-label="Playback timing"><option value="ordinal-core.mp4">Ordinal core (metadata fps)</option><option value="original-cadence.mp4">Nominal 41ms/tick (not ground truth)</option></select>
<button id="play">Play / Pause All</button><button id="reset">Reset</button><input id="seek" aria-label="Seek all videos" type="range" min="0" max="''' + str(32 / fps) + '''" step="0.001" value="0">
<div class="grid">''' + cards + '''</div>
<p><a href="comparison-timeline.mp4">49-frame ''' + str(fps) + '''fps input-timeline 2x2 (half resolution per tile)</a> | <a href="report.json">Metrics and provenance</a> | <a href="contact-sheet.png">Contact sheet</a> | <a href="fullres-quad.png">Full-resolution quad</a> | <a href="edge-black-white.png">Black/white edge samples</a></p>
<img src="contact-sheet.png" alt="Selected core ordinal comparison">
<script>
const videos=[...document.querySelectorAll('video')], master=videos[0], seek=document.getElementById('seek');
let running=false;
function pause(){running=false;videos.forEach(v=>v.pause())}
function setTime(t){videos.forEach(v=>{v.currentTime=t});seek.value=t}
master.onloadedmetadata=()=>{seek.max=master.duration};
document.getElementById('mode').onchange=e=>{pause();videos.forEach(v=>{v.src=v.dataset.key+'/'+e.target.value;v.load()});seek.value=0};
document.getElementById('play').onclick=async()=>{if(running){pause();return}setTime(master.currentTime);try{await Promise.all(videos.map(v=>v.play()));running=true}catch(e){pause()}};
document.getElementById('reset').onclick=()=>{pause();setTime(0)};
seek.oninput=()=>{pause();setTime(Number(seek.value))};
master.onended=()=>{pause();setTime(0)};
function sync(){if(running){seek.value=master.currentTime;videos.slice(1).forEach(v=>{if(Math.abs(v.currentTime-master.currentTime)>.025)v.currentTime=master.currentTime})}requestAnimationFrame(sync)}sync();
</script></html>''')


def analyze(base):
    base = private_directory(base)
    out = private_directory(base / 'analysis')
    require(out == base / 'analysis', 'Symlinked analysis directory is not allowed')
    meta_path = base / 'input/source-metadata.json'
    meta = json.loads(meta_path.read_text())
    original_root = Path(meta['sourceManifest']).expanduser().resolve().parent
    require(not out.is_relative_to(original_root), 'Analysis must not be inside the original source directory')
    ticks = validate_metadata(meta)
    fps = meta['fps']
    sources, masks, provenance = load_sources(base, meta)
    summary_path = base / 'runs/summary.json'
    summary = json.loads(summary_path.read_text())
    require(sha(base / 'input/input.mp4') == summary['input']['sha256'], 'Summary input SHA mismatch')
    inputs, cases, failures = {}, {}, {}
    labels = {'source-nearest': 'Original nearest 4x'}
    require(1 <= len(summary['results']) <= 3, 'Expected one to three completed job records')
    for case in summary['results']:
        key, settings = case['name'], case['settings']
        require(key and all(c.isalnum() or c in '-_' for c in key) and key not in labels,
                'Unsafe or duplicate case name')
        require(case['status'] in ('succeeded', 'failed', 'canceled'), 'Job not complete')
        require(settings['fps'] == fps, 'Summary settings fps differs from source metadata')
        label = f'{key.split("-")[0]} SeedVR2 {settings["model_variant"].upper()}'
        label += ' colorfix' if settings['apply_color_fix'] else ' no colorfix'
        labels[key] = label
        cases[key] = {'status': case['status'], 'label': label, 'settings': settings,
                      'model': case.get('model', summary.get('model')),
                      'version': case.get('version', summary.get('version')),
                      'error': case.get('error'), 'apiMetrics': case.get('metrics'),
                      'predictionID': case.get('id'), 'qualityMetrics': None}
        if case['status'] != 'succeeded':
            cases[key]['error'] = str(case.get('error') or case['status'])
            failures[key] = cases[key]
            continue
        path = Path(case['output']['file']).resolve()
        require(path.is_relative_to((base / 'runs').resolve()), 'Output escapes local runs directory')
        require(path.stat().st_size == case['output']['bytes'] and sha(path) == case['output']['sha256'],
                f'Output hash/size differs from summary: {key}')
        inputs[key] = path
    require(inputs, 'No successful local outputs to analyze')
    probes = {key: probe(path, expected_fps=fps) for key, path in inputs.items()}
    require(not out.exists() or not any(out.iterdir()), f'Refusing nonempty output: {out}')
    out.mkdir(exist_ok=True)
    for key in ('source-nearest', *inputs):
        for sub in ('rgba', 'preview'):
            (out / key / sub).mkdir(parents=True, exist_ok=True)
    report = {'version': 2, 'sourceMetadataSHA256': sha(meta_path), 'actualCoreCount': 32,
              'runSummarySHA256': sha(summary_path), 'cases': cases, 'fps': fps,
              'model': summary.get('model'), 'modelVersion': summary.get('version'),
              'sourceBinding': meta.get('sourceBinding'),
              'palettePolicy': 'Original RGBA hashes are verified, but indexed palette provenance '
              'is only what sourceBinding records. Model RGB is not palette-preserving.',
              'alphaPolicy': 'Original binary masks restored with NEAREST 4x; never model-inferred.',
              'sourceFrames': provenance, 'sourceDurationTicks': 62,
              'coreClipRangeInclusive': [8, 39], 'temporalInterpolation': False,
              'postprocess': 'Hosted wrapper scale 10/3, 1280x720; unavoidable extra 1.2x '
              'LANCZOS RGB interpolation to 1536x864. Original masks NEAREST 4x, never inferred.',
              'timing': 'Core order unchanged; cadence ticks*41ms assumed, source tick rate unknown. '
              f'Separate 49-frame fixed{fps}fps comparison follows wrapper input ordinal timeline.',
              'metricCaveats': 'RGB reprojection foreground MAE (0..255) measures source faithfulness, '
              'not better perceptual quality. Hold temporal MAE measures repeated-input instability '
              'only, no optical flow or clay-motion comparison. No reference GT, ranking or best claim.',
              'realESRNetBaseline': {'included': False, 'reason': 'No readily supplied exact-32-source '
                                    'SHA-bound baseline; nearest baseline retained; no model run.'},
              'variants': {}}
    nearest = [s.resize(SIZE, Image.Resampling.NEAREST) for s in sources]
    for i, image in enumerate(nearest):
        save_frame(out / 'source-nearest', i, image)
    for key, path in inputs.items():
        metrics, hold_pairs = [], {'initial': [], 'tail': []}
        previous = None
        for index, rgb in decoded_rgb(path):
            ordinal = meta['timeline'][index]['sourceOrdinal']
            mask = masks[ordinal]
            # Hold metric at native wrapper resolution, with source foreground only.
            array = np.asarray(rgb).astype(np.int16)
            region = np.asarray(mask.resize(rgb.size, Image.Resampling.NEAREST)) == 255
            if previous is not None and (1 <= index <= 8 or 40 <= index <= 48):
                group = 'initial' if index <= 8 else 'tail'
                hold_pairs[group].append(float(np.abs(array - previous)[region].mean()))
            previous = array
            if 8 <= index <= 39:
                image = restore(rgb, mask)
                require(pixel_sha(image.getchannel('A')) == provenance[ordinal]['alpha4xPixelSHA256'],
                        'Cross-variant alpha mismatch')
                save_frame(out / key, ordinal, image)
                small = np.asarray(image.convert('RGB').resize((384, 216), Image.Resampling.BOX)).astype(np.int16)
                original = np.asarray(sources[ordinal].convert('RGB')).astype(np.int16)
                mae = float(np.abs(small - original)[np.asarray(mask) == 255].mean())
                metrics.append({'sourceOrdinal': ordinal, 'clipFrame': index,
                                'foregroundReprojectionMAE': mae,
                                'alpha4xPixelSHA256': pixel_sha(image.getchannel('A'))})
        require(len(metrics) == 32, f'Wrong actual core count: {key}')
        report['variants'][key] = {'outputSHA256': sha(path), 'outputBytes': path.stat().st_size,
                                  'label': labels[key], 'settings': cases[key]['settings'],
                                  'probe': probes[key], 'actualCoreCount': len(metrics),
                                  'frames': metrics, 'alphaIdenticalToSource4x': True,
                                  'foregroundReprojectionMAEMean': float(np.mean([m['foregroundReprojectionMAE'] for m in metrics])),
                                  'holdTemporalMAE': {k: {'clipRangeInclusive': [0, 8] if k == 'initial' else [39, 48],
                                      'adjacentPairCount': len(v), 'pairMAE': v,
                                      'mean': float(np.mean(v))} for k, v in hold_pairs.items()}}
        cases[key]['qualityMetrics'] = {'foregroundReprojectionMAEMean': report['variants'][key]['foregroundReprojectionMAEMean'],
                                       'holdTemporalMAE': report['variants'][key]['holdTemporalMAE']}
    for key in ('source-nearest', *inputs):
        report.setdefault('cadencePreviews', {})[key] = cadence_video(out / key, ticks)
        def core_images():
            for i in range(32):
                with Image.open(out / key / 'preview' / f'{i:04d}.png') as image:
                    yield image.convert('RGB')
        encode_raw(out / key / 'ordinal-core.mp4', core_images(), SIZE, fps)
    def images_at(i):
        images = []
        for key in labels:
            if key in failures:
                images.append(None)
                continue
            with Image.open(out / key / 'rgba' / f'{i:04d}.png') as image:
                images.append(image.copy())
        return images
    selected = [0, 2, 4, 8, 16, 24, 28, 31]
    contact = Image.new('RGB', (384 * 4, 244 * len(selected)), (24, 24, 24))
    for row, ordinal in enumerate(selected):
        for col, (image, label) in enumerate(zip(images_at(ordinal), labels.values())):
            tile = display(image).resize((384, 216), Image.Resampling.LANCZOS)
            contact.paste(labeled(tile, f'{label} | ordinal {ordinal}'), (col * 384, row * 244))
    contact.save(out / 'contact-sheet.png')
    quad(images_at(4), list(labels.values())).save(out / 'fullres-quad.png')
    edges = Image.new('RGB', (768 * 4, 432 * 2 + 56))
    box = masks[4].getbbox()
    center = ((box[0] + box[2]) * 2, (box[1] + box[3]) * 2)
    crop = (center[0] - 384, center[1] - 216, center[0] + 384, center[1] + 216)
    for col, (image, label) in enumerate(zip(images_at(4), labels.values())):
        for row, value in enumerate((0, 255)):
            tile = labeled(display(image, value).crop(crop), f'{label} | ordinal 4 | background {value}')
            edges.paste(tile, (col * 768, row * 460))
    edges.save(out / 'edge-black-white.png')
    def timeline_quads():
        decoders = [decoded_rgb(path) for path in inputs.values()]
        try:
            for index, frames in enumerate(zip(*decoders, strict=True)):
                ordinal = meta['timeline'][index]['sourceOrdinal']
                require(all(i == index for i, _ in frames), 'Comparison decoder order changed')
                restored = {key: restore(rgb, masks[ordinal]) for key, (_, rgb) in zip(inputs, frames)}
                images = [nearest[ordinal]] + [restored.get(key) for key in cases]
                yield quad(images, list(labels.values()), half=True)
        finally:
            for decoder in decoders:
                decoder.close()
    encode_raw(out / 'comparison-timeline.mp4', timeline_quads(), (1536, 920), fps)
    fixed = probe(out / 'comparison-timeline.mp4')
    require(int(fixed['streams'][0]['nb_read_frames']) == 49, 'Comparison lost timeline frames')
    report['comparisonTimeline'] = {'frames': 49, 'fps': fps, 'tileImageSize': [768, 432],
                                 'durationSeconds': float(fixed['format']['duration'])}
    write_html(out, labels, failures, fps)
    report['analysisBytesExcludingReport'] = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
    require(report['analysisBytesExcludingReport'] < 1_000_000_000, 'Analysis exceeds 1GB budget')
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'analysis': str(out), 'coreFrames': 32, 'variants': list(inputs), 'failed': list(failures),
                      'bytes': report['analysisBytesExcludingReport']}))


def self_test():
    ticks = [1, 1] + [2] * 30
    frames = [{'sourceOrdinal': i, 'durationTicks': t} for i, t in enumerate(ticks)]
    ordinals = [0] * 8 + list(range(32)) + [31] * 9
    meta = {'canvas': [384, 216], 'sourceFrameCount': 32, 'sourceFrames': frames, 'fps': 15,
            'clipFrameCount': 49, 'holdsBefore': 8, 'holdsAfter': 9,
            'coreClipRangeInclusive': [8, 39], 'sourceDurationTicks': 62,
            'timeline': [{'clipFrame': i, 'sourceOrdinal': o, 'durationTicks': ticks[o],
                          'role': 'first_hold' if i < 8 else 'core' if i < 40 else 'last_hold',
                          'useForQuality': 8 <= i <= 39, 'rgbSHA256': str(o)} for i, o in enumerate(ordinals)]}
    require(validate_metadata(meta) == ticks, 'Synthetic valid metadata failed')
    for mutate in ('order', 'ticks', 'hold'):
        invalid = copy.deepcopy(meta)
        if mutate == 'order':
            invalid['timeline'][9]['sourceOrdinal'] = 2
        elif mutate == 'ticks':
            invalid['sourceFrames'][0]['durationTicks'] = 2
        else:
            invalid['timeline'][1]['rgbSHA256'] = 'different'
        try:
            validate_metadata(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f'Invalid {mutate} metadata accepted')
    mask = Image.new('L', (384, 216))
    ImageDraw.Draw(mask).rectangle((100, 30, 240, 200), fill=255)
    image = restore(Image.new('RGB', (1280, 720), (80, 140, 200)), mask)
    require(set(np.unique(np.asarray(image.getchannel('A')))) == {0, 255}, 'Synthetic alpha domain failed')
    require(image.getchannel('A').tobytes() == mask.resize(SIZE, Image.Resampling.NEAREST).tobytes(),
            'Synthetic exact alpha failed')
    temp_root = private_directory(Path(tempfile.gettempdir()))
    with tempfile.TemporaryDirectory(prefix='seedvr2-analysis-', dir=temp_root) as temporary:
        root = private_directory(Path(temporary))
        for bad in ('../escape', '/absolute', 'https://example.invalid'):
            try:
                local_path(root, bad)
            except ValueError:
                pass
            else:
                raise AssertionError('Unsafe media path accepted')
        (root / 'preview').mkdir()
        for i in range(32):
            Image.new('RGB', (64, 36), (i * 7, 80, 120)).save(root / 'preview' / f'{i:04d}.png')
        cadence = cadence_video(root, ticks)
        video = root / 'synthetic-wrapper.mp4'
        encode_raw(video, (Image.new('RGB', (1280, 720), (i * 4, 80, 120))
                           for i in range(49)), (1280, 720), fps=15)
        probe(video, expected_fps=meta['fps'])
        require(sum(1 for _ in decoded_rgb(video)) == 49, 'Synthetic RGB decode count')
        bad_video = root / 'wrong-fps.mp4'
        encode_raw(bad_video, (Image.new('RGB', (1280, 720)) for _ in range(49)),
                   (1280, 720), fps=24)
        try:
            probe(bad_video, expected_fps=meta['fps'])
        except ValueError:
            pass
        else:
            raise AssertionError('24fps output incorrectly accepted as metadata15fps')
        write_html(root, {'source-nearest': 'Original', 'B-7b': 'B SeedVR2 7B'},
                   {'B-7b': {'error': 'CUDA OOM <not markup>'}}, 15)
        page = (root / 'index.html').read_text()
        require('B-7b/ordinal-core.mp4' not in page and '&lt;not markup&gt;' in page,
                'Failed run must have escaped placeholder, not fake video')
        require('https://' not in page, 'External HTML link')
    print(json.dumps({'selfTest': 'passed', 'metadataNegativeCases': 3,
                      'binaryMaskExact4x': True, 'strictMetadata15fpsAndRGB49': True,
                      'rejects24fps': True, 'failedCasePlaceholder': True, 'syntheticCadence': cadence}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=os.environ.get('NEVERHOOD_SEEDVR2_PROBE_DIR') or None,
                        help='Private experiment directory; defaults only to NEVERHOOD_SEEDVR2_PROBE_DIR')
    parser.add_argument('--self-test', action='store_true', help='Synthetic offline tests in temporary storage')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.base is None:
        parser.error('supply --base or NEVERHOOD_SEEDVR2_PROBE_DIR')
    else:
        analyze(args.base)
