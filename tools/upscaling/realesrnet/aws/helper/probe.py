"""One explicitly bounded RGB-only smoke run. No credentials are recorded."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time

ROOT = Path('/opt/neverhood-upscaling/runner')
REVISION = '4490bd1f482e026674543386bb2a4d176da245b9'
DIT = 'seedvr2_ema_3b_fp8_e4m3fn.safetensors'
MODEL_VARIANT = '3b'
MODEL_PRECISION = 'fp8_e4m3fn'
RUN_SUFFIX = ''
RESULT_SUBPREFIX = ''
BLOCKS_TO_SWAP = 16
VAE = 'ema_vae_fp16.safetensors'
MODEL_HASHES = {
    DIT: '3bf1e43ebedd570e7e7a0b1b60d6a02e105978f505c8128a241cde99a8240cff',
    VAE: '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1',
}
INPUT_HASH = 'e2f9fdbeeadff553da72d1881dfdb01ec10fa682c7268abf3a409e2e614cb201'
INPUT_FRAMES = 49
INPUT_FPS = 15
INPUT_S3_KEY = 'sources/probes/seedvr2-probe-v1/input/input.mp4'
FRAME_PROTOCOL = 'baseline single source frame per ordinal'
INFERENCE_TIMEOUT = '15m'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def sanitize(text):
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'https?://[^\s<>"\x27]+', '[URL REDACTED]', text)
    text = re.sub(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b', '[AWS KEY REDACTED]', text)
    text = re.sub(r'\bhf_[A-Za-z0-9]+\b', '[HF TOKEN REDACTED]', text)
    text = re.sub(r'(?i)(authorization|token|secret|password|credential|access_key)([\s"\x27:=]+)[^\s,;]+', r'\1\2[REDACTED]', text)
    return text


def run(command, log=None, timeout=120):
    # Raw logs remain VM-local. Only sanitized copies enter the upload directory.
    if log:
        with log.open('w') as stream:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f'{log.stem} exited {result.returncode}')
        return ''
    return subprocess.check_output(command, stderr=subprocess.STDOUT, text=True, timeout=timeout).strip()


def inference_command(root, run_dir):
    return [
        'timeout', '--signal=TERM', '--kill-after=30s', INFERENCE_TIMEOUT,
        str(root / 'venv/bin/python'), str(root / 'source/inference_cli.py'),
        str(run_dir / 'input/input.mp4'), '--output', str(run_dir / 'artifacts/frames'),
        '--output_format', 'png', '--model_dir', str(root / 'models'),
        '--dit_model', DIT, '--cuda_device', '0', '--resolution', '864',
        '--max_resolution', '1536', '--batch_size', '5', '--seed', '314159',
        '--load_cap', str(INPUT_FRAMES), '--uniform_batch_size', '--attention_mode', 'sdpa',
        '--dit_offload_device', 'cpu', '--vae_offload_device', 'cpu',
        '--tensor_offload_device', 'cpu', '--blocks_to_swap', str(BLOCKS_TO_SWAP), '--swap_io_components',
        '--vae_encode_tiled', '--vae_decode_tiled', '--vae_encode_tile_size', '512',
        '--vae_decode_tile_size', '512', '--vae_encode_tile_overlap', '64',
        '--vae_decode_tile_overlap', '64', '--color_correction', 'none',
        '--input_noise_scale', '0', '--latent_noise_scale', '0', '--debug',
    ]


def measure_inference(command, log, report):
    samples = []
    errors = []
    stop = threading.Event()

    def sample():
        while not stop.is_set():
            try:
                value = subprocess.check_output([
                    'nvidia-smi', '--id=0', '--query-gpu=memory.used',
                    '--format=csv,noheader,nounits',
                ], text=True, stderr=subprocess.STDOUT, timeout=5)
                samples.append(int(value.strip()))
            except Exception as error:
                errors.append(sanitize(str(error)))
                return
            stop.wait(1)

    sampler = threading.Thread(target=sample, daemon=True)
    started = time.monotonic()
    sampler.start()
    try:
        run(command, log, timeout=950)
    finally:
        stop.set()
        sampler.join(timeout=6)
        report['inferenceSeconds'] = time.monotonic() - started
        report['gpuMemory'] = {
            'source': 'nvidia-smi GPU 0 device-wide memory.used during inference',
            'samplingIntervalSeconds': 1, 'samples': len(samples),
            'peakUsedMiB': max(samples) if samples else None,
            'scope': 'device-wide sampled peak, not process-only or torch allocator peak',
            'errors': errors,
        }


def inspect_input(path):
    info = json.loads(run([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_frames',
        '-show_entries', 'stream=width,height,avg_frame_rate,nb_read_frames',
        '-of', 'json', str(path),
    ]))['streams'][0]
    from fractions import Fraction
    if (info['width'], info['height'], int(info['nb_read_frames']), Fraction(info['avg_frame_rate'])) != (384, 216, INPUT_FRAMES, INPUT_FPS):
        raise ValueError(f'Input must be exactly 384x216, {INPUT_FRAMES} frames, {INPUT_FPS} fps')
    if sha256(path) != INPUT_HASH:
        raise ValueError('Input SHA256 does not match the authorized baseline')
    return {**info, 'sha256': INPUT_HASH}


def inspect_frames(directory):
    import struct
    files = sorted(directory.glob('*.png'))
    if [p.name for p in files] != [f'input_{i:06d}.png' for i in range(INPUT_FRAMES)]:
        raise ValueError(f'Expected exactly {INPUT_FRAMES} contiguous output PNG frames')
    records = []
    for path in files:
        with path.open('rb') as stream:
            header = stream.read(33)
        if header[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', header[16:24]) != (1536, 864):
            raise ValueError(f'Invalid output PNG dimensions: {path.name}')
        records.append({'file': path.name, 'bytes': path.stat().st_size, 'sha256': sha256(path)})
    run(['ffmpeg', '-v', 'error', '-xerror', '-framerate', str(INPUT_FPS), '-i',
         str(directory / 'input_%06d.png'), '-f', 'null', '-'])
    return {'width': 1536, 'height': 864, 'frames': INPUT_FRAMES, 'fps': INPUT_FPS,
            'fpsSource': 'validated input; PNG sequences have no intrinsic fps', 'files': records}


def main():
    bucket, run_id = sys.argv[1:]
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket) or '..' in bucket:
        raise ValueError('Invalid bucket')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', run_id):
        raise ValueError('Invalid run ID')
    run_dir = ROOT / 'runs' / (run_id + RUN_SUFFIX)
    run_dir.mkdir(mode=0o700)  # Never overwrite/retry a run implicitly.
    artifacts = run_dir / 'artifacts'
    artifacts.mkdir()
    (run_dir / 'input').mkdir()
    raw = run_dir / 'raw'
    raw.mkdir()
    report = {'runId': run_id, 'runnerRevision': REVISION, 'status': 'failed',
              'modelVariant': MODEL_VARIANT, 'modelStyle': 'normal',
              'modelPrecision': MODEL_PRECISION, 'ditModel': DIT,
               'blocksToSwap': BLOCKS_TO_SWAP,
               'frameProtocol': FRAME_PROTOCOL,
              'maskProcessed': False, 'compile': False, 'inferenceAttempts': 0,
              'startedAtUnix': time.time(), 'stage': 'preflight'}
    result = 1
    print(json.dumps({'modelVariant': MODEL_VARIANT, 'modelStyle': 'normal',
                      'modelPrecision': MODEL_PRECISION, 'ditModel': DIT}), flush=True)
    try:
        if run(['git', '-C', str(ROOT / 'source'), 'rev-parse', 'HEAD']) != REVISION:
            raise ValueError('Runner revision mismatch')
        if run(['git', '-C', str(ROOT / 'source'), 'status', '--porcelain', '--untracked-files=no']):
            raise ValueError('Runner tracked source modified')
        if not run(['aws', '--version']).startswith('aws-cli/2.'):
            raise ValueError('AWS CLI v2 required')
        (artifacts / 'nvidia-smi.txt').write_text(run(['nvidia-smi']) + '\n')
        runtime = run([str(ROOT / 'venv/bin/python'), '-c',
            'import json,sys,torch; assert torch.cuda.is_available(), "CUDA unavailable"; '
            'print(json.dumps({"python":sys.version,"torch":torch.__version__, '
            '"cuda":torch.version.cuda,"cudnn":torch.backends.cudnn.version(), '
            '"gpu":torch.cuda.get_device_name(0),"vramBytes":torch.cuda.get_device_properties(0).total_memory}))'])
        report['runtime'] = json.loads(runtime)
        for name in ['pip-freeze.txt', 'runner-revision.txt', 'python-version.txt', 'aws-version.txt']:
            shutil.copyfile(ROOT / 'install' / name, artifacts / name)
        report['stage'] = 'input'
        run(['aws', 's3', 'cp', f's3://{bucket}/{INPUT_S3_KEY}',
             str(run_dir / 'input/input.mp4'), '--only-show-errors'], raw / 'input-transfer.log')
        report['input'] = inspect_input(run_dir / 'input/input.mp4')
        report['stage'] = 'download-models'
        # Use upstream downloader and pinned registry; no model initialization/inference.
        code = ('import sys; sys.path.insert(0, sys.argv[1]); '
                'from src.utils.downloads import download_weight; '
                'from src.utils.debug import Debug; '
                'assert download_weight(sys.argv[3], sys.argv[4], sys.argv[2], Debug(enabled=True))')
        run(['timeout', '--kill-after=30s', '20m', str(ROOT / 'venv/bin/python'), '-c', code,
             str(ROOT / 'source'), str(ROOT / 'models'), DIT, VAE], raw / 'models.log', timeout=1240)
        report['models'] = []
        for name, expected in MODEL_HASHES.items():
            path = ROOT / 'models' / name
            actual = sha256(path)
            if actual != expected:
                raise ValueError(f'Model hash mismatch: {name}')
            report['models'].append({'file': name, 'sha256': actual, 'bytes': path.stat().st_size})
        command = inference_command(ROOT, run_dir)
        (artifacts / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
        report['stage'] = 'inference'
        report['inferenceAttempts'] = 1
        measure_inference(command, raw / 'inference.log', report)
        report['stage'] = 'validate-output'
        report['output'] = inspect_frames(artifacts / 'frames/input')
        report['status'] = 'succeeded'
        report['stage'] = 'complete'
        result = 0
    except Exception as error:
        report['error'] = sanitize(str(error))
    finally:
        report['finishedAtUnix'] = time.time()
        for path in raw.glob('*.log'):
            (artifacts / path.name).write_text(sanitize(path.read_text(errors='replace')))
        # Do not upload partial images from a failed run as successful results.
        report_path = artifacts / 'report.json'
        report_path.write_text(json.dumps(report, indent=2) + '\n')
        upload_failed = False
        for path in sorted(artifacts.rglob('*')):
            if not path.is_file() or path.is_symlink():
                continue
            if report['status'] != 'succeeded' and 'frames' in path.relative_to(artifacts).parts:
                continue
            try:
                run(['aws', 's3', 'cp', str(path),
                     f's3://{bucket}/results/{run_id}/{RESULT_SUBPREFIX}{path.relative_to(artifacts).as_posix()}',
                     '--only-show-errors'], timeout=120)
            except Exception:
                upload_failed = True
        print(json.dumps({'status': report['status'], 'stage': report['stage'],
                          'localArtifacts': str(artifacts), 'uploadFailed': upload_failed}))
        if upload_failed:
            result = 1
    return result


if __name__ == '__main__':
    sys.exit(main())
