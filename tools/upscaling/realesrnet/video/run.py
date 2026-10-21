"""Bounded SeedVR2 movie pilot on the existing VM. No cloud control or uploads."""
import argparse
from fractions import Fraction
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import time

SPEC = importlib.util.spec_from_file_location(
    'video_probe', Path(__file__).resolve().parents[1] / 'aws/helper/probe.py')
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
SPEC7B = importlib.util.spec_from_file_location(
    'video_probe7b', Path(__file__).resolve().parents[1] / 'aws/helper/probe7b.py')
probe7b = importlib.util.module_from_spec(SPEC7B)
# The existing 7B configuration imports its companion under the name "probe".
previous_probe = sys.modules.get('probe')
sys.modules['probe'] = probe
try:
    SPEC7B.loader.exec_module(probe7b)
finally:
    if previous_probe is None:
        del sys.modules['probe']
    else:
        sys.modules['probe'] = previous_probe
probe7b.configure()


def validate_manifest(directory, expected_hash):
    manifest = directory / 'manifest.json'
    if probe.sha256(manifest) != expected_hash:
        raise ValueError('Manifest SHA256 mismatch')
    data = json.loads(manifest.read_text())
    if data['version'] != 1 or data['private'] is not True or data['kind'] not in ('cutscene', 'navigation'):
        raise ValueError('Not a private movie pilot')
    source, selection, target = data['source'], data['selection'], data['target']
    integers = [source['width'], source['height'], source['frames'],
                selection['startFrame'], selection['frames'], target['width'], target['height']]
    if any(type(value) is not int for value in integers):
        raise ValueError('Geometry and frame counts must be integers')
    fps = Fraction(source['fps'])
    if not (0 < fps <= 120 and 1 <= selection['frames'] <= 121 and
            0 <= selection['startFrame'] < source['frames'] and
            selection['startFrame'] + selection['frames'] <= source['frames']):
        raise ValueError('Movie range or FPS outside pilot limits')
    width, height = target['width'], target['height']
    if (target['scale'] != 4 or width != source['width'] * 4 or height != source['height'] * 4
            or min(width, height) < 16 or width % 16 or height % 16
            or width * height > 1536 * 1024 or max(width, height) > 2048):
        raise ValueError('Pilot needs exact 4x geometry, multiples of 16, <=1.5 MP and <=2048 per side')
    for record, filename in [(data['input'], 'input.mp4'), (data.get('audio'), 'audio.mka')]:
        if record is None:
            continue
        path = directory / filename
        if record['file'] != filename or path.is_symlink() or probe.sha256(path) != record['sha256']:
            raise ValueError(f'Invalid private input: {filename}')
    info = json.loads(probe.run([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_frames',
        '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames',
        '-of', 'json', str(directory / 'input.mp4')]))['streams'][0]
    if (info['width'], info['height'], int(info['nb_read_frames']), Fraction(info['avg_frame_rate'])) != (
            source['width'], source['height'], selection['frames'], fps):
        raise ValueError('Decoded model input does not match manifest')
    return data


def inference_command(root, directory, output, data):
    command = probe.inference_command(root, output)
    command[command.index(str(output / 'input/input.mp4'))] = str(directory / 'input.mp4')
    for flag, value in {
        '--resolution': min(data['target']['width'], data['target']['height']),
        '--max_resolution': max(data['target']['width'], data['target']['height']),
        '--load_cap': data['selection']['frames'],
    }.items():
        command[command.index(flag) + 1] = str(value)
    return command


def inspect_frames(output, data):
    directory = output / 'artifacts/frames/input'
    count = data['selection']['frames']
    files = sorted(directory.glob('*.png'))
    if [file.name for file in files] != [f'input_{i:06d}.png' for i in range(count)]:
        raise ValueError('Output must contain exactly the original frame ordinals')
    records = []
    for file in files:
        with file.open('rb') as stream:
            header = stream.read(33)
        if (file.is_symlink() or header[:8] != b'\x89PNG\r\n\x1a\n' or
                struct.unpack('>II', header[16:24]) != (data['target']['width'], data['target']['height'])):
            raise ValueError('Invalid output PNG geometry')
        records.append({'file': file.name, 'sha256': probe.sha256(file)})
    probe.run(['ffmpeg', '-v', 'error', '-xerror', '-framerate', data['source']['fps'],
               '-i', str(directory / 'input_%06d.png'), '-f', 'null', '-'])
    return records


def package_movie(output, directory, data, frames_directory=None):
    frames_directory = frames_directory or output / 'artifacts/frames/input'
    preview = ['ffmpeg', '-v', 'error', '-n', '-framerate', data['source']['fps'],
               '-i', str(frames_directory / 'input_%06d.png')]
    if data.get('audio'):
        preview += ['-i', str(directory / 'audio.mka')]
    preview += ['-map', '0:v:0']
    if data.get('audio'):
        preview += ['-map', '1:a', '-c:a', 'copy']
    # Matroska rounds this game's 50000/3333 FPS; MP4 retains exact frame ticks.
    # FLAC-in-MP4 needs explicit experimental muxing on older FFmpeg.
    master = output / 'artifacts/restored.mp4'
    preview += ['-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv444p', '-strict', '-2',
                '-video_track_timescale', str(Fraction(data['source']['fps']).numerator),
                '-movflags', '+faststart', str(master)]
    probe.run(preview, timeout=300)
    movie = json.loads(probe.run([
        'ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(master)]))
    video = [stream for stream in movie['streams'] if stream['codec_type'] == 'video']
    audio = [stream for stream in movie['streams'] if stream['codec_type'] == 'audio']
    if (len(video) != 1 or int(video[0]['nb_read_frames']) != data['selection']['frames']
            or Fraction(video[0]['avg_frame_rate']) != Fraction(data['source']['fps'])
            or len(audio) != len((data.get('audio') or {}).get('streams', []))):
        raise ValueError('Muxed movie frame rate, count or audio tracks changed')
    return probe.sha256(master)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--root', type=Path, default=probe.ROOT)
    parser.add_argument('--execute', action='store_true', help='Actually use GPU; default is validation and command preview')
    args = parser.parse_args()
    if not probe.re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', args.run_id):
        raise ValueError('Invalid run ID')
    root, directory = args.root.resolve(), args.input.resolve()
    output = root / 'runs' / ('video-' + args.run_id)
    data = validate_manifest(directory, args.manifest_sha256)
    command = inference_command(root, directory, output, data)
    if not args.execute:
        print(json.dumps({'execute': False, 'command': command, 'output': str(output)}, indent=2))
        return 0
    # Match the installed, tested runner and weights; never auto-download weights here.
    if probe.run(['git', '-C', str(root / 'source'), 'rev-parse', 'HEAD']) != probe.REVISION:
        raise ValueError('Runner revision mismatch')
    if probe.run(['git', '-C', str(root / 'source'), 'status', '--porcelain', '--untracked-files=no']):
        raise ValueError('Runner tracked source modified')
    for name, expected in probe.MODEL_HASHES.items():
        if probe.sha256(root / 'models' / name) != expected:
            raise ValueError('Missing or incorrect staged model: ' + name)
    os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1',
                      CUDA_VISIBLE_DEVICES='0', PYTHONUNBUFFERED='1')
    output.mkdir(mode=0o700)  # Fail rather than silently retry/overwrite.
    (output / 'artifacts').mkdir()
    report = {'status': 'failed', 'kind': data['kind'], 'manifestSHA256': args.manifest_sha256,
              'manifest': data, 'runnerRevision': probe.REVISION, 'models': probe.MODEL_HASHES,
              'modelVariant': probe.MODEL_VARIANT, 'modelPrecision': probe.MODEL_PRECISION,
              'ditModel': probe.DIT, 'blocksToSwap': probe.BLOCKS_TO_SWAP,
              'command': command, 'startedAtUnix': time.time(), 'approvedForRuntime': False}
    try:
        probe.measure_inference(command, output / 'inference.log', report)
        report['frames'] = inspect_frames(output, data)
        report['previewSHA256'] = package_movie(output, directory, data)
        report['status'] = 'succeeded'
    except Exception as error:
        report['error'] = probe.sanitize(str(error))
    finally:
        report['finishedAtUnix'] = time.time()
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'report': str(output / 'report.json')}))
    return int(report['status'] != 'succeeded')


if __name__ == '__main__':
    sys.exit(main())
