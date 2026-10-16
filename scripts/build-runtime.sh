#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE="$ROOT/scummvm"
export EMSDK_VERSION="${EMSDK_VERSION:-4.0.10}"
SDK_VERSION="$EMSDK_VERSION"
SDK="$SOURCE/dists/emscripten/emsdk-$SDK_VERSION"
BUILD="$ROOT/scripts/.build/neverhood-web"
JOBS="${JOBS:-4}"

if [[ ! -f "$SOURCE/AI-GUIDELINES.md" ]]; then
  printf 'ScummVM checkout missing at %s\n' "$SOURCE" >&2
  exit 1
fi

# Only upstream's setup task runs in the checkout; compilation stays out of tree.
(
  cd "$SOURCE"
  bash dists/emscripten/build.sh setup
)
set +u
source "$SDK/emsdk_env.sh"
set -u
mkdir -p "$BUILD"
cd "$BUILD"
emconfigure "$SOURCE/configure" \
  --host=wasm32-unknown-emscripten --build=wasm32-unknown-emscripten \
  --disable-all-engines --enable-engine=neverhood \
  --disable-detection-full --disable-debug --disable-cloud --disable-tts
emmake make -f "$ROOT/scripts/runtime.mk" -j "$JOBS"

# Deliberate allowlist: no games, installers, or demo data.
node "$ROOT/scripts/package-runtime.cjs" "$SDK_VERSION"
