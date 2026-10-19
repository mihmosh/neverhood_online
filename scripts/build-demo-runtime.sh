#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE="$ROOT/scummvm"
SDK="$SOURCE/dists/emscripten/emsdk-4.0.10"
BUILD="$ROOT/scripts/.build/neverhood-demo-web"
BASE="$ROOT/scripts/.build/neverhood-web"
JOBS="${JOBS:-4}"

# No setup/install tasks run in the upstream checkout. Use the prepared SDK only.
if [[ ! -f "$SDK/emsdk_env.sh" ]]; then
  printf 'Prepared emsdk 4.0.10 is required at %s\n' "$SDK" >&2
  exit 1
fi
if [[ -n "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ]]; then
  printf 'Refusing demo build with modified upstream tracked files\n' >&2
  exit 1
fi
node "$ROOT/scripts/demo-runtime-package.mjs" --check-source
set +u
source "$SDK/emsdk_env.sh"
set -u
if [[ ! -d "$BUILD" ]]; then
  mkdir -p "$BUILD"
  # Copy, never hardlink: the base objects and main runtime must stay unchanged.
  if [[ -f "$BASE/config.mk" ]]; then
    cp -a --reflink=auto "$BASE/." "$BUILD/"
  fi
fi
(
  cd "$BUILD"
  emconfigure "$SOURCE/configure" \
    --host=wasm32-unknown-emscripten --build=wasm32-unknown-emscripten \
    --disable-all-engines --enable-engine=neverhood \
    --disable-detection-full --disable-debug --disable-cloud --disable-tts
)
node "$ROOT/scripts/demo-runtime-overlays.mjs"
make -C "$BUILD" -f "$ROOT/scripts/demo-runtime.mk" -j "$JOBS"
node "$ROOT/scripts/demo-runtime-verify-abi.mjs"
node "$ROOT/scripts/demo-runtime-package.mjs"
