#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <output-dir>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_JSON="$SCRIPT_DIR/versions.json"
OUT_DIR="$1"

read_json() {
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const val = process.argv[2].split(".").reduce((acc, k) => acc[k], data);
    if (Array.isArray(val)) console.log(val.join(" "));
    else console.log(String(val));
  ' "$VERSIONS_JSON" "$1"
}

FFMPEG_VERSION="$(read_json ffmpeg.version)"
FFMPEG_URL="$(read_json ffmpeg.url)"
FFMPEG_SHA256="$(read_json ffmpeg.sha256)"
MEDIA3_VERSION="$(read_json media3.version)"
MEDIA3_REPO="$(read_json media3.repository)"
MEDIA3_TAG="$(read_json media3.tag)"
MEDIA3_COMMIT="$(read_json media3.commit)"
NDK_VERSION="$(read_json androidNdk)"
MIN_SDK="$(read_json androidMinSdk)"
read -r -a ABIS <<< "$(read_json abis)"
read -r -a DECODERS <<< "$(read_json decoders)"

if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  if [[ -n "$SDK_ROOT" && -d "$SDK_ROOT/ndk/$NDK_VERSION" ]]; then
    ANDROID_NDK_HOME="$SDK_ROOT/ndk/$NDK_VERSION"
  else
    echo "ANDROID_NDK_HOME is unset and $NDK_VERSION was not found under ANDROID_SDK_ROOT" >&2
    exit 1
  fi
fi

if [[ "${ELV_ALLOW_NDK_OVERRIDE:-0}" != "1" ]]; then
  if ! grep -Eq "Pkg\\.Revision *= *${NDK_VERSION//./\\.}(\$|[^0-9])" "$ANDROID_NDK_HOME/source.properties"; then
    echo "Expected Android NDK $NDK_VERSION in $ANDROID_NDK_HOME/source.properties" >&2
    cat "$ANDROID_NDK_HOME/source.properties" >&2
    exit 1
  fi
fi

case "$(uname -s)" in
  Linux*) HOST_TAG="linux-x86_64" ;;
  Darwin*) HOST_TAG="darwin-x86_64" ;;
  *)
    echo "Unsupported host OS: $(uname -s)" >&2
    exit 1
    ;;
esac

TOOLCHAIN_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG/bin"
if [[ ! -d "$TOOLCHAIN_BIN" ]]; then
  echo "NDK LLVM toolchain not found at $TOOLCHAIN_BIN" >&2
  exit 1
fi

JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Isolate pkg-config so host packages on the runner can never contaminate FFmpeg configure.
mkdir -p "$WORK_DIR/empty-pkgconfig"
export PKG_CONFIG_LIBDIR="$WORK_DIR/empty-pkgconfig"
export PKG_CONFIG_PATH=""

echo "==> Downloading FFmpeg $FFMPEG_VERSION"
curl -fsSL --retry 3 -o "$WORK_DIR/ffmpeg.tar.xz" "$FFMPEG_URL"
echo "${FFMPEG_SHA256}  $WORK_DIR/ffmpeg.tar.xz" | sha256sum --check --quiet
mkdir -p "$WORK_DIR/ffmpeg-src"
tar -xJf "$WORK_DIR/ffmpeg.tar.xz" --strip-components=1 -C "$WORK_DIR/ffmpeg-src"

echo "==> Sparse-checking out androidx/media $MEDIA3_TAG ($MEDIA3_COMMIT)"
git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$MEDIA3_TAG" \
  "$MEDIA3_REPO" "$WORK_DIR/media3-src"
git -C "$WORK_DIR/media3-src" sparse-checkout init --cone
git -C "$WORK_DIR/media3-src" sparse-checkout set libraries/decoder_ffmpeg
git -C "$WORK_DIR/media3-src" checkout --quiet

ACTUAL_COMMIT="$(git -C "$WORK_DIR/media3-src" rev-parse HEAD)"
if [[ "$ACTUAL_COMMIT" != "$MEDIA3_COMMIT" ]]; then
  echo "androidx/media tag $MEDIA3_TAG resolved to $ACTUAL_COMMIT, expected $MEDIA3_COMMIT" >&2
  exit 1
fi

node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const versions = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const repoDir = process.argv[2];
  for (const [rel, expected] of Object.entries(versions.media3.files)) {
    const full = path.join(repoDir, rel);
    if (!fs.existsSync(full)) throw new Error(`Missing upstream Media3 file: ${rel}`);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${rel}: expected ${expected}, got ${actual}`);
    }
  }
' "$VERSIONS_JSON" "$WORK_DIR/media3-src"

DECODER_FLAGS=()
for dec in "${DECODERS[@]}"; do
  DECODER_FLAGS+=("--enable-decoder=${dec}")
done

COMMON_FFMPEG_FLAGS=(
  --target-os=android
  --enable-cross-compile
  --enable-pic
  --enable-shared
  --disable-static
  --disable-symver
  --disable-autodetect
  --disable-programs
  --disable-doc
  --disable-network
  --disable-everything
  --disable-avdevice
  --disable-avformat
  --disable-avfilter
  --disable-swscale
  --disable-postproc
  --disable-v4l2-m2m
  --disable-vulkan
  --enable-avutil
  --enable-swresample
  --enable-avcodec
  "${DECODER_FLAGS[@]}"
)

rm -rf "$OUT_DIR"
mkdir -p \
  "$OUT_DIR/java/androidx/media3/decoder/ffmpeg" \
  "$OUT_DIR/assets/licenses/ffmpeg-media3/ffmpeg" \
  "$OUT_DIR/assets/licenses/ffmpeg-media3/media3" \
  "$WORK_DIR/configure-records"

STAGE_ROOT="$WORK_DIR/stage"

for abi in "${ABIS[@]}"; do
  echo "==> Building FFmpeg $FFMPEG_VERSION + Media3 JNI for $abi"
  case "$abi" in
    arm64-v8a)
      ARCH_FLAGS=(--arch=aarch64 --cpu=armv8-a)
      CC_TRIPLE="aarch64-linux-android${MIN_SDK}"
      EXTRA_CFLAGS="-O3 -fPIC"
      EXTRA_LDFLAGS="-Wl,-z,max-page-size=16384"
      ;;
    armeabi-v7a)
      ARCH_FLAGS=(--arch=arm --cpu=armv7-a --enable-neon)
      CC_TRIPLE="armv7a-linux-androideabi${MIN_SDK}"
      EXTRA_CFLAGS="-O3 -fPIC -march=armv7-a -mfloat-abi=softfp -mfpu=neon"
      EXTRA_LDFLAGS="-Wl,--fix-cortex-a8 -Wl,-z,max-page-size=16384"
      ;;
    x86_64)
      ARCH_FLAGS=(--arch=x86_64 --cpu=x86-64 --disable-asm)
      CC_TRIPLE="x86_64-linux-android${MIN_SDK}"
      EXTRA_CFLAGS="-O3 -fPIC"
      EXTRA_LDFLAGS="-Wl,-z,max-page-size=16384"
      ;;
    *)
      echo "Unsupported ABI: $abi" >&2
      exit 1
      ;;
  esac

  FF_BUILD="$WORK_DIR/build-ffmpeg-$abi"
  mkdir -p "$FF_BUILD"
  CONFIG_ARGS=(
    "--prefix=/elv-ffmpeg/${abi}"
    "${ARCH_FLAGS[@]}"
    "--cc=${TOOLCHAIN_BIN}/${CC_TRIPLE}-clang"
    "--cxx=${TOOLCHAIN_BIN}/${CC_TRIPLE}-clang++"
    "--nm=${TOOLCHAIN_BIN}/llvm-nm"
    "--ar=${TOOLCHAIN_BIN}/llvm-ar"
    "--ranlib=${TOOLCHAIN_BIN}/llvm-ranlib"
    "--strip=${TOOLCHAIN_BIN}/llvm-strip"
    "--extra-cflags=${EXTRA_CFLAGS}"
    "--extra-ldflags=${EXTRA_LDFLAGS}"
    "${COMMON_FFMPEG_FLAGS[@]}"
  )

  printf '%s\n' "${CONFIG_ARGS[*]}" > "$WORK_DIR/configure-records/${abi}.txt"

  (
    cd "$FF_BUILD"
    "$WORK_DIR/ffmpeg-src/configure" "${CONFIG_ARGS[@]}"
    make -j"$JOBS"
    make install-libs install-headers DESTDIR="$STAGE_ROOT"
  )

  JNI_BUILD="$WORK_DIR/build-jni-$abi"
  cmake -G Ninja \
    -S "$SCRIPT_DIR" \
    -B "$JNI_BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$abi" \
    -DANDROID_PLATFORM="android-${MIN_SDK}" \
    -DANDROID_STL=none \
    -DCMAKE_BUILD_TYPE=Release \
    -DFFMPEG_STAGE_DIR="$STAGE_ROOT/elv-ffmpeg/${abi}" \
    -DMEDIA3_JNI_SRC="$WORK_DIR/media3-src/libraries/decoder_ffmpeg/src/main/jni/ffmpeg_jni.cc"
  cmake --build "$JNI_BUILD" --parallel "$JOBS"

  ABI_OUT="$OUT_DIR/jniLibs/$abi"
  mkdir -p "$ABI_OUT"
  for lib in libavutil.so libswresample.so libavcodec.so; do
    cp "$STAGE_ROOT/elv-ffmpeg/${abi}/lib/${lib}" "$ABI_OUT/${lib}"
  done
  cp "$JNI_BUILD/libffmpegJNI.so" "$ABI_OUT/libffmpegJNI.so"

  for so in "$ABI_OUT"/*.so; do
    "$TOOLCHAIN_BIN/llvm-strip" --strip-unneeded "$so"
    chmod 0644 "$so"
  done
done

JAVA_SRC_DIR="$WORK_DIR/media3-src/libraries/decoder_ffmpeg/src/main/java/androidx/media3/decoder/ffmpeg"
for java_file in \
  FfmpegAudioDecoder.java \
  FfmpegAudioRenderer.java \
  FfmpegDecoderException.java \
  FfmpegLibrary.java \
  package-info.java; do
  cp "$JAVA_SRC_DIR/$java_file" "$OUT_DIR/java/androidx/media3/decoder/ffmpeg/$java_file"
  chmod 0644 "$OUT_DIR/java/androidx/media3/decoder/ffmpeg/$java_file"
done

cp "$WORK_DIR/media3-src/libraries/decoder_ffmpeg/proguard-rules.txt" "$OUT_DIR/proguard-rules.txt"
chmod 0644 "$OUT_DIR/proguard-rules.txt"

cp "$WORK_DIR/ffmpeg-src/COPYING.LGPLv2.1" "$OUT_DIR/assets/licenses/ffmpeg-media3/ffmpeg/COPYING.LGPLv2.1"
cp "$WORK_DIR/ffmpeg-src/LICENSE.md" "$OUT_DIR/assets/licenses/ffmpeg-media3/ffmpeg/LICENSE.md"
cp "$WORK_DIR/media3-src/LICENSE" "$OUT_DIR/assets/licenses/ffmpeg-media3/media3/LICENSE"
chmod 0644 \
  "$OUT_DIR/assets/licenses/ffmpeg-media3/ffmpeg/COPYING.LGPLv2.1" \
  "$OUT_DIR/assets/licenses/ffmpeg-media3/ffmpeg/LICENSE.md" \
  "$OUT_DIR/assets/licenses/ffmpeg-media3/media3/LICENSE"

node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const versions = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const recordsDir = process.argv[2];
  const outDir = process.argv[3];
  const configureByAbi = {};
  for (const abi of versions.abis) {
    const raw = fs.readFileSync(path.join(recordsDir, `${abi}.txt`), "utf8").trim();
    // Redact host toolchain path up to /bin/ so BUILDINFO.json is runner-path independent.
    configureByAbi[abi] = raw.replace(/--(cc|cxx|nm|ar|ranlib|strip)=\S+\/bin\//g, "--$1=<ndk>/bin/");
  }
  const buildInfo = {
    schemaVersion: 1,
    license: "LGPL-2.1-or-later AND Apache-2.0",
    linking: "dynamic",
    androidPageSizeBytes: 16384,
    ffmpeg: {
      version: versions.ffmpeg.version,
      url: versions.ffmpeg.url,
      sha256: versions.ffmpeg.sha256,
    },
    media3: {
      version: versions.media3.version,
      repository: versions.media3.repository,
      tag: versions.media3.tag,
      commit: versions.media3.commit,
    },
    androidNdk: versions.androidNdk,
    androidMinSdk: versions.androidMinSdk,
    abis: versions.abis,
    decoders: versions.decoders,
    configureByAbi,
  };
  const json = `${JSON.stringify(buildInfo, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, "BUILDINFO.json"), json);
  fs.writeFileSync(path.join(outDir, "assets/licenses/ffmpeg-media3/BUILDINFO.json"), json);
' "$VERSIONS_JSON" "$WORK_DIR/configure-records" "$OUT_DIR"

if [[ -n "$(find "$OUT_DIR" -type l -print -quit)" ]]; then
  echo "Unexpected symlink found inside $OUT_DIR" >&2
  find "$OUT_DIR" -type l >&2
  exit 1
fi

echo "==> Built FFmpeg $FFMPEG_VERSION + Media3 $MEDIA3_VERSION bundle in $OUT_DIR"
