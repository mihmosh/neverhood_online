#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Generated from the distributed build recipes; run from the restored root.
set -euo pipefail
ROOT="$PWD"
SOURCE="$ROOT/scummvm"
SDK_VERSION=4.0.10
export EMSDK_VERSION=4.0.10
SDK="$SOURCE/dists/emscripten/emsdk-$SDK_VERSION"
JOBS="${JOBS:-4}"
(cd "$SOURCE" && bash dists/emscripten/build.sh setup)
# Restore the supplied actual library/runtime sources, not compiler binaries.
cp -a corresponding/emscripten/. "$SDK/upstream/emscripten/"
mkdir -p "$SDK/upstream/emscripten/cache/ports/sdl3"
cp -a corresponding/SDL-release-3.2.4 "$SDK/upstream/emscripten/cache/ports/sdl3/"
printf '%s\n' 'https://github.com/libsdl-org/SDL/archive/release-3.2.4.zip' > "$SDK/upstream/emscripten/cache/ports/sdl3/.emscripten_url"
BUILD="$ROOT/scripts/.build/neverhood-web"
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


cd "$ROOT"
# Optional historical binary; the current full-game prototype uses the stock build above.
if [[ "${REBUILD_LEGACY_DEMO:-0}" == 1 ]]; then
  BUILD="$ROOT/scripts/.build/neverhood-demo-web"
  mkdir -p "$BUILD"
  cp -a "$ROOT/scripts/.build/neverhood-web/." "$BUILD/"
  (
    cd "$BUILD"
    emconfigure "$SOURCE/configure" \
      --host=wasm32-unknown-emscripten --build=wasm32-unknown-emscripten \
      --disable-all-engines --enable-engine=neverhood \
      --disable-detection-full --disable-debug --disable-cloud --disable-tts
  )
  node "$ROOT/scripts/demo-runtime-overlays.mjs"
  make -C "$BUILD" -f "$ROOT/scripts/demo-runtime.mk" -j "$JOBS"
fi
BUILD="$ROOT/scripts/.build/extractor"
mkdir -p "$BUILD/prefix"
set +u
source "$SDK/emsdk_env.sh"
set -u
emcmake cmake -S "$ROOT/tools/extractor-deps" -B "$BUILD/deps" -G Ninja \
  -DSOURCES="$BUILD/src" -DCMAKE_INSTALL_PREFIX="$BUILD/prefix" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG" -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG -Wno-deprecated-declarations -Wno-deprecated-builtins"
cmake --build "$BUILD/deps" --parallel "$JOBS"
cmake --install "$BUILD/deps"

LINK_FLAGS="-O2 -fexceptions -sDISABLE_EXCEPTION_CATCHING=0 -sMODULARIZE=1 -sEXPORT_NAME=createInnoextract -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=1048576 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,callMain -lworkerfs.js -lnodefs.js"
BOOST_ARGS=()
for component in iostreams filesystem date_time system program_options; do
  upper="${component^^}"
  BOOST_ARGS+=("-DBoost_${upper}_LIBRARY_RELEASE=$BUILD/prefix/lib/libboost_${component}.a" "-DBoost_${upper}_LIBRARY_DEBUG=$BUILD/prefix/lib/libboost_${component}.a")
done
emcmake cmake -S "$BUILD/src/innoextract-1.9" -B "$BUILD/inno" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="-O2 -fexceptions" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS" -DCMAKE_EXECUTABLE_SUFFIX=.js \
  -DCMAKE_PREFIX_PATH="$BUILD/prefix" -DBOOST_ROOT="$BUILD/src/boost_1_75_0" \
  -DBOOST_LIBRARYDIR="$BUILD/prefix/lib" -DBoost_NO_BOOST_CMAKE=ON \
  -DBoost_INCLUDE_DIR="$BUILD/src/boost_1_75_0" "${BOOST_ARGS[@]}" \
  -DLZMA_LIBRARY="$BUILD/prefix/lib/liblzma.a" -DLZMA_INCLUDE_DIR="$BUILD/prefix/include" \
  -DZLIB_LIBRARY="$BUILD/prefix/lib/libz.a" -DZLIB_INCLUDE_DIR="$BUILD/prefix/include" \
  -DBZIP2_LIBRARIES="$BUILD/prefix/lib/libbz2.a" -DBZIP2_INCLUDE_DIR="$BUILD/prefix/include" \
  -DBoost_NO_SYSTEM_PATHS=ON -DBoost_USE_STATIC_LIBS=ON \
  -DLZMA_USE_STATIC_LIBS=ON -DZLIB_USE_STATIC_LIBS=ON -DBZip2_USE_STATIC_LIBS=ON \
  -DSTRICT_USE=ON -DWITH_CONV=builtin -DSET_OPTIMIZATION_FLAGS=OFF \
  -DUSE_LTO=OFF -DUSE_LDGOLD=OFF -DSET_WARNING_FLAGS=OFF -DCXX_STD_VERSION=2014
cmake --build "$BUILD/inno" --parallel "$JOBS"


printf '%s\n' 'Built scripts/.build/neverhood-web/scummvm.{js,wasm} and scripts/.build/extractor/inno/innoextract.js (plus .wasm).'
