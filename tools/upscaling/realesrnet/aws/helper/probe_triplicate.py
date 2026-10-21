"""One explicit triple-frame experiment, preserving the baseline model settings."""
import re
import sys
import probe

if len(sys.argv) != 5:
    raise SystemExit('Usage: probe_triplicate.py BUCKET RUNID 3b|7b EXPECTED_INPUT_SHA256')
bucket, run_id, variant, expected_hash = sys.argv[1:]
if variant not in ('3b', '7b') or not re.fullmatch('[a-f0-9]{64}', expected_hash):
    raise SystemExit('Invalid experiment variant/hash')
if variant == '7b':
    import probe7b
    probe7b.configure()

probe.INPUT_HASH = expected_hash
probe.INPUT_FRAMES = 149
probe.INPUT_FPS = 45
probe.INPUT_S3_KEY = 'sources/probes/seedvr2-triplicate-v1/input/input.mp4'
probe.FRAME_PROTOCOL = '49 baseline frames tripled, two trailing pads; select 1+3*i; core 25+3*i for i=0..31'
probe.INFERENCE_TIMEOUT = '10m' if variant == '3b' else '12m'
probe.RUN_SUFFIX = f'-{variant}-triplicate'
probe.RESULT_SUBPREFIX = f'triplicate/{variant}/'
sys.argv = [sys.argv[0], bucket, run_id]
raise SystemExit(probe.main())
