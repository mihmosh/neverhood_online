#!/usr/bin/env bash
# Run on the VM only. Installation never downloads model weights or runs inference.
set -euo pipefail
umask 022
ROOT=/opt/neverhood-upscaling/runner
REVISION=4490bd1f482e026674543386bb2a4d176da245b9
HERE=$(dirname "$(readlink -f "$0")")
if [[ $EUID -eq 0 ]]; then
  id ubuntu >/dev/null
  export DEBIAN_FRONTEND=noninteractive
  # The worker allows HTTPS egress only. Use Ubuntu's sources over TLS without
  # changing DLAMI source configuration or refreshing NVIDIA/CUDA repositories.
  apt_sources=$(mktemp -d)
  trap 'rm -rf "$apt_sources"' EXIT
  sed -E 's@http://([a-z0-9.-]+\.)?ec2\.archive\.ubuntu\.com/ubuntu/?@https://archive.ubuntu.com/ubuntu/@g; s@http://@https://@g' /etc/apt/sources.list.d/ubuntu.sources > "$apt_sources/ubuntu.sources"
  apt_options=(-o Dir::Etc::sourcelist=- -o "Dir::Etc::sourceparts=$apt_sources")
  apt-get "${apt_options[@]}" update
  apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg git python3-venv libgl1 libglib2.0-0
  rm -rf "$apt_sources"
  trap - EXIT
  install -d -o ubuntu -g ubuntu "$ROOT"
  exec runuser -u ubuntu -- env -i HOME=/home/ubuntu USER=ubuntu LOGNAME=ubuntu \
    PATH=/usr/local/bin:/usr/bin:/bin bash "$0"
fi
[[ $(id -un) == ubuntu ]] || { printf '%s\n' 'Run as root (SSM) or ubuntu.' >&2; exit 1; }
command -v aws >/dev/null || { printf '%s\n' 'DLAMI AWS CLI v2 is required in PATH.' >&2; exit 1; }
[[ $(aws --version 2>&1) == aws-cli/2.* ]] || { printf '%s\n' 'AWS CLI v2 required.' >&2; exit 1; }
command -v ffmpeg >/dev/null
command -v git >/dev/null
PYTHON=$(command -v python3.12 || command -v python3)
"$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 required"'
mkdir -p "$ROOT" "$ROOT/bin/helper" "$ROOT/install" "$ROOT/models" "$ROOT/runs"
exec > >(tee -a "$ROOT/install/install.log") 2>&1
if [[ ! -d $ROOT/source ]]; then
  git clone --no-checkout https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git "$ROOT/source"
  git -C "$ROOT/source" checkout --detach "$REVISION"
fi
[[ $(git -C "$ROOT/source" remote get-url origin) == https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git ]]
[[ -z $(git -C "$ROOT/source" status --porcelain) ]] || { printf '%s\n' 'Runner checkout is dirty; refusing overwrite.'; exit 1; }
git -C "$ROOT/source" cat-file -e "$REVISION^{commit}"
git -C "$ROOT/source" checkout --detach "$REVISION"
[[ $(git -C "$ROOT/source" rev-parse HEAD) == "$REVISION" ]]
"$PYTHON" -m venv "$ROOT/venv"
PY="$ROOT/venv/bin/python"
"$PY" -m pip install --disable-pip-version-check pip==25.2
"$PY" -m pip install --index-url https://download.pytorch.org/whl/cu126 torch==2.7.1 torchvision==0.22.1
# Requirements are from the immutable runner revision; constrain its direct deps
# and transformer stack, then record the entire resolved environment below.
"$PY" -m pip install -r "$ROOT/source/requirements.txt" \
  torch==2.7.1 torchvision==0.22.1 safetensors==0.6.2 numpy==2.2.6 tqdm==4.67.1 \
  psutil==7.0.0 einops==0.8.1 omegaconf==2.3.0 diffusers==0.35.1 peft==0.17.1 \
  rotary-embedding-torch==0.8.9 opencv-python==4.12.0.88 gguf==0.17.1 matplotlib==3.10.6 \
  transformers==4.56.2 huggingface-hub==0.34.4
"$PY" -m pip check
"$PY" -m pip freeze > "$ROOT/install/pip-freeze.txt"
"$PY" --version > "$ROOT/install/python-version.txt"
git -C "$ROOT/source" rev-parse HEAD > "$ROOT/install/runner-revision.txt"
aws --version > "$ROOT/install/aws-version.txt" 2>&1
install -m 0755 "$HERE/run-probe.sh" "$ROOT/bin/run-probe.sh"
install -m 0644 "$HERE/helper/probe.py" "$ROOT/bin/helper/probe.py"
# --help checks import/argument compatibility without selecting CUDA or weights.
"$PY" "$ROOT/source/inference_cli.py" --help > "$ROOT/install/cli-help.txt"
printf '%s\n' 'Installed; no weights downloaded and no inference executed.'
