#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
BUILD="$ROOT/scripts/.build/extractor"
SDK="$ROOT/scummvm/dists/emscripten/emsdk-4.0.10"
JOBS="${JOBS:-4}"
mkdir -p "$BUILD/downloads" "$BUILD/src" "$BUILD/prefix"

# Release archives, verified before unpacking. All third-party source stays ignored.
fetch() {
  local name="$1" checksum="$2" url="$3" directory="$4"
  if [[ ! -f "$BUILD/downloads/$name" ]]; then
    curl --fail --location --retry 3 "$url" -o "$BUILD/downloads/$name"
  fi
  printf '%s  %s\n' "$checksum" "$BUILD/downloads/$name" | sha256sum --check --status
  if [[ ! -d "$BUILD/src/$directory" ]]; then
    tar -xf "$BUILD/downloads/$name" -C "$BUILD/src"
  fi
}
fetch innoextract-1.9.tar.gz 6344a69fc1ed847d4ed3e272e0da5998948c6b828cb7af39c6321aba6cf88126 https://constexpr.org/innoextract/files/innoextract-1.9.tar.gz innoextract-1.9
fetch boost_1_75_0.tar.bz2 953db31e016db7bb207f11432bef7df100516eeb746843fa0486a222e3fd49cb https://archives.boost.io/release/1.75.0/source/boost_1_75_0.tar.bz2 boost_1_75_0
fetch xz-5.6.4.tar.gz 269e3f2e512cbd3314849982014dc199a7b2148cf5c91cedc6db629acdf5e09b https://github.com/tukaani-project/xz/releases/download/v5.6.4/xz-5.6.4.tar.gz xz-5.6.4
fetch zlib-1.3.1.tar.gz 9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23 https://zlib.net/fossils/zlib-1.3.1.tar.gz zlib-1.3.1
fetch bzip2-1.0.8.tar.gz ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269 https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz bzip2-1.0.8

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
node "$ROOT/scripts/package-extractor.cjs"
