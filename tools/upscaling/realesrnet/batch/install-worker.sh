#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=/opt/neverhood-upscaling/realesrnet
PYTHON=/opt/neverhood-upscaling/runner/venv/bin/python
SOURCE=$(dirname -- "$(readlink -f -- "$0")")
if [[ $(id -u) -eq 0 ]]; then
  install -d -m 700 -o ubuntu -g ubuntu "$ROOT" "$ROOT/bin" "$ROOT/state" "$ROOT/models" "$ROOT/bin/licenses"
  for file in worker.py model.py job_contract.py run-worker.sh install-worker.sh; do
    install -m 600 -o ubuntu -g ubuntu "$SOURCE/$file" "$ROOT/bin/$file"
  done
  install -m 600 -o ubuntu -g ubuntu "$SOURCE/licenses/BasicSR-LICENSE.txt" "$ROOT/bin/licenses/BasicSR-LICENSE.txt"
  exec runuser -u ubuntu -- bash "$ROOT/bin/install-worker.sh" --dependencies-only
fi
[[ $(id -un) == ubuntu && ${1:-} == --dependencies-only ]] || { printf '%s\n' 'Run installer as root via SSM' >&2; exit 1; }
[[ -x "$PYTHON" ]] || { printf '%s\n' 'Existing runner venv is required' >&2; exit 1; }
"$PYTHON" -c 'import torch, PIL, numpy; assert torch.__version__ == "2.7.1+cu126", torch.__version__'
if ! "$PYTHON" -c 'import scipy' 2>/dev/null; then
  "$PYTHON" -m pip install --disable-pip-version-check 'scipy==1.16.2'
fi
if ! "$PYTHON" -c 'import boto3' 2>/dev/null; then
  "$PYTHON" -m pip install --disable-pip-version-check 'boto3==1.40.61'
fi
printf '%s\n' 'Worker installed; no GPU execution, weights download, driver change, or cloud action performed.'
