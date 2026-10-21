#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=/opt/neverhood-upscaling/realesrnet
if [[ $(id -u) -eq 0 ]]; then
  exec runuser -u ubuntu -- bash "$ROOT/bin/run-worker.sh" "$@"
fi
if [[ $# -lt 2 || ! "$1" =~ ^(pilot|full)$ || ! "$2" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'Usage: run-worker.sh pilot|full MAX_WALL_SECONDS --bucket ... --checkpoint ... --expected-job-count ... --expected-keyset-sha256 ... --max-frame-pixels ... --deadline-utc ... [--pilot-count N] [--max-jobs N]' >&2
  exit 2
fi
MODE=$1
WALL=$2
shift 2
(( WALL >= 60 && WALL <= 14400 )) || { printf '%s\n' 'Wall budget must be 60..14400 seconds' >&2; exit 2; }
FLAG=--full
[[ "$MODE" != pilot ]] || FLAG=--pilot-only
# Deterministic CUDA GEMM configuration, not an operator secrets/config file.
export CUBLAS_WORKSPACE_CONFIG=:4096:8
# TERM provides up to 120 seconds for one in-flight frame and bounded uploads.
# The independent deadline grace (default 180s) should precede EC2 auto-stop.
exec timeout --signal=TERM --kill-after=120s "${WALL}s" \
  /opt/neverhood-upscaling/runner/venv/bin/python "$ROOT/bin/worker.py" \
  "$FLAG" --max-wall-seconds "$((WALL - 120 > 0 ? WALL - 120 : 1))" "$@"
