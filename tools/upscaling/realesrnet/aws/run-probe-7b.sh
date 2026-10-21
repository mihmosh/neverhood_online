#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=/opt/neverhood-upscaling/runner
[[ $# -eq 2 ]] || { printf '%s\n' 'Usage: run-probe-7b.sh BUCKET RUNID' >&2; exit 2; }
[[ $1 =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ && $1 != *..* ]] || exit 2
[[ $2 =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$ ]] || exit 2
if [[ $EUID -eq 0 ]]; then
  exec runuser -u ubuntu -- env -i HOME=/home/ubuntu USER=ubuntu LOGNAME=ubuntu \
    PATH=/usr/local/bin:/usr/bin:/bin bash "$0" "$@"
fi
[[ $(id -un) == ubuntu ]] || exit 1
export HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 PYTHONUNBUFFERED=1
export CUDA_VISIBLE_DEVICES=0
exec "$ROOT/venv/bin/python" "$(dirname "$(readlink -f "$0")")/helper/probe7b.py" "$1" "$2"
