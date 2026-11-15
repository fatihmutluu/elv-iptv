# Media3 LGPL FFmpeg audio extension — Design

- Status: approved (owner delegated development decisions)
- Date: 2026-11-15
- Issue: #69. Builds on the foundation spec (`2026-11-13-foundation-design.md`, §3, §5.2, §6), ADR 0003
  (`0003-playback-engines.md`), ADR 0012 (`0012-gpl-3-and-cla.md`) and the player core spec
  (`2026-11-14-player-core-design.md`, §6.3).

## 1. Why
Android TV televisions, retail streaming sticks and the standard Android TV emulator images vary widely in which
broadcast audio codecs their platform `MediaCodec` stack exposes. Many lack platform decoders for AC-3, E-AC-3, DTS,
TrueHD or MPEG-1/2 Layer II (MP2), leaving standard DVB and ATSC MPEG-TS streams either silent or failing at track
selection.

`androidx.media3` provides a first-party FFmpeg audio extension (`libraries/decoder_ffmpeg`, Apache-2.0) that
`DefaultRenderersFactory` discovers automatically when `androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer` is on the
classpath, but Google intentionally ships no prebuilt Maven artifact because each distributor must compile FFmpeg with
its own codec set and licence posture. Today `@elv/engine-media3` already sets `EXTENSION_RENDERER_MODE_ON` by default
and `EXTENSION_RENDERER_MODE_PREFER` when `options.softwareAudio === true`, yet has no FFmpeg renderer or native
libraries in the module, so both modes resolve solely to `MediaCodecAudioRenderer`.

This change builds a reproducible, CI-compiled LGPL-2.1+ FFmpeg shared-library bundle and Media3 JNI bridge for Android
(`arm64-v8a`, `armeabi-v7a`, `x86_64`), gates every artifact on licence posture, dynamic linking and 16 KB ELF page
alignment, fetches the pinned artifact via `pnpm ffmpeg-media3 fetch`, and wires `FfmpegAudioRenderer` and the required
legal notices into `@elv/engine-media3`.

## 2. Goals
- A reproducible GitHub Actions workflow `.github/workflows/ffmpeg-media3.yml` compiling FFmpeg `9.0.2` (LGPL-2.1+,
  dynamic `.so`, zero GPL or nonfree flags) and `androidx/media` `1.11.1`'s `libffmpegJNI.so` across `arm64-v8a`,
  `armeabi-v7a` and `x86_64` with 16 KB ELF `PT_LOAD` alignment.
- A pure-TypeScript licence and ELF32/ELF64 gate (`tools/src/ffmpeg-media3/`) and CLI (`pnpm ffmpeg-media3 fetch` and
  `pnpm ffmpeg-media3 verify`), backed by `modules/engine-media3/ffmpeg-media3.lock.json`, verifying SHA-256, LGPL
  configure flags, absence of GPL/nonfree strings, dynamic `DT_NEEDED` edges, unversioned Android `DT_SONAME`s and
  16 KB page alignment both in CI and on developer machines.
- `@elv/engine-media3` integration: compiles Media3 `1.11.1`'s `androidx.media3.decoder.ffmpeg` Java audio sources,
  packages the verified JNI and FFmpeg `.so` files plus ProGuard rules, configures `FfmpegLibrary` load order before
  renderer creation, preserves `EXTENSION_RENDERER_MODE_ON` by default (`MediaCodec` first, FFmpeg fallback) and
  `EXTENSION_RENDERER_MODE_PREFER` when `options.softwareAudio === true` (FFmpeg first, used by the recovery ladder),
  and bundles LGPL-2.1 and Apache-2.0 notices plus `BUILDINFO.json` in Android assets.
- Automatic fetch wiring in `.github/workflows/native.yml`, `pnpm run:app` (Android targets) and `pnpm gate` APK builds.

## 3. Non-goals
- FFmpeg software video decoding (`ExperimentalFfmpegVideoRenderer` is excluded; video stays on `MediaCodec`).
- Any GPL-only or nonfree third-party code (`--enable-gpl`, `--enable-version3`, `--enable-nonfree`, `x264`, `x265`,
  `fdk-aac`) or static linking of FFmpeg into `libffmpegJNI.so`.
- Encoders, muxers, demuxers, filters, network protocols, DVR, recording or timeshift.
- Apple (`AetherEngine`, #70) or desktop (`mpv`, #67) audio pipelines.

## 4. Licensing and Android ABI constraints
1. **LGPL-2.1+ dynamic linking only (Foundation §3, ADR 0012):** ELV IPTV is licensed under `GPL-3.0-only` with
   `CLA.md`, and third-party native libraries must remain under permissive or dynamically linked LGPL-2.1+ terms — never
   GPL-only or nonfree. FFmpeg is configured with `--enable-shared --disable-static --disable-autodetect` and without
   `--enable-gpl`, `--enable-version3` or `--enable-nonfree`.
2. **Dynamic JNI boundary:** `libffmpegJNI.so` (compiled from `androidx/media` `libraries/decoder_ffmpeg`, Apache-2.0)
   links dynamically (`DT_NEEDED`) against `libavcodec.so`, `libswresample.so` and `libavutil.so`. Static FFmpeg
   archives (`.a`) are neither built nor linked.
3. **Unversioned Android SONAMEs:** Android's dynamic linker (`bionic`) resolves packaged APK libraries by exact file
   name without symlink indirection. FFmpeg is built with `--target-os=android`, which sets `SLIB_INSTALL_NAME` and
   `SONAME` to unversioned `libavutil.so`, `libswresample.so` and `libavcodec.so` with zero symlinks.
4. **16 KB page size (Android 15+ / Google Play & Android TV requirement):** Every `PT_LOAD` segment of every `.so`
   across `arm64-v8a`, `armeabi-v7a` and `x86_64` must have `p_align >= 16384` (`0x4000`) and congruent
   `(p_vaddr - p_offset) % p_align === 0`. Both FFmpeg (`--extra-ldflags="-Wl,-z,max-page-size=16384"`) and CMake for
   `libffmpegJNI.so` pass `-Wl,-z,max-page-size=16384`, and the pure-TypeScript ELF gate verifies every segment.
5. **Bundled notices and reproducibility provenance:** The artifact and resulting APK bundle `COPYING.LGPLv2.1`,
   `LICENSE.md` (FFmpeg), `LICENSE` (Media3 Apache-2.0) and `BUILDINFO.json` (pinned source URLs, commit/tarball
   SHA-256s, NDK version and per-ABI FFmpeg `configure` flags) under `assets/licenses/ffmpeg-media3/`.

## 5. Design

### 5.1 Upstream pins and decoder surface (`tools/ffmpeg-media3/versions.json`)
- **FFmpeg `9.0.2`:** `https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz` (SHA-256
  `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`), matching the pin in `tools/mpv-runtime`.
- **Media3 `1.11.1` (`androidx/media`):** tag `1.11.1` at commit `8c6678b657ede1e7883fc164ef73ed483c7796c3`, matching
  `androidx.media3:*:1.11.1` in `modules/engine-media3/android/build.gradle`. Because the upstream repository carries
  hundreds of megabytes of `libraries/test_data`, the build sparse-checkouts only `/LICENSE` and
  `/libraries/decoder_ffmpeg`, verifies `HEAD` equals the pinned commit SHA, and verifies the SHA-256 of every extracted
  source, ProGuard and licence file before compiling.
- **Android NDK `28.2.13676358`, `androidMinSdk: 28`:** matches the workspace minimum SDK (`API 28`, Fire OS 7 baseline)
  and compiles cleanly with 16 KB alignment across `arm64-v8a` (`aarch64-linux-android28-clang`), `armeabi-v7a`
  (`armv7a-linux-androideabi28-clang`, `-march=armv7-a -mfloat-abi=softfp -mfpu=neon`) and `x86_64`
  (`x86_64-linux-android28-clang`; `--disable-x86asm` avoids NASM relocation hazards while keeping SSE/AVX intrinsics).
- **Enabled FFmpeg components:** `--disable-everything --disable-programs --disable-doc --disable-network
  --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-postproc --disable-autodetect
  --enable-avutil --enable-swresample --enable-avcodec` plus the 14 built-in LGPL-2.1+ audio decoders supported by
  Media3's `FfmpegLibrary`:
  `aac`, `ac3`, `alac`, `dca` (DTS / DTS-HD), `eac3` (E-AC-3 / JOC core), `flac`, `mlp`, `mp2`, `mp3`, `opus`,
  `pcm_alaw`, `pcm_mulaw`, `truehd` and `vorbis`.
  Both `mp2` and `mp3` are enabled: `FfmpegLibrary` maps `audio/mpeg-L2` and `audio/mpeg` to FFmpeg's `"mp3"` decoder,
  and keeping `mp2` alongside `mp3` covers explicit MP2 codec lookup as well at negligible size cost. None of these 14
  decoders require external codec libraries (`opus` uses built-in `swresample`), so zero external static libraries enter
  the build.

### 5.2 Reproducible CI build (`tools/ffmpeg-media3/`, `.github/workflows/ffmpeg-media3.yml`)
- `tools/ffmpeg-media3/build-android.sh <output-dir>`:
  1. Reads `tools/ffmpeg-media3/versions.json`, exports `PKG_CONFIG_LIBDIR` to an empty temporary directory so host
     packages on the runner can never be auto-detected, downloads the FFmpeg tarball, verifies its SHA-256, sparse-clones
     `androidx/media` at `1.11.1`, verifies `HEAD` and every extracted file's SHA-256.
  2. For each ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`), configures FFmpeg with `--prefix=/elv-ffmpeg/<abi>` and
     installs via `make install DESTDIR=<stage>/<abi>` so the configure string baked into `libavcodec.so` contains a
     deterministic prefix rather than runner temp directories.
  3. Invokes CMake (`tools/ffmpeg-media3/CMakeLists.txt`) with the NDK toolchain (`ANDROID_STL=none`,
     `-fno-exceptions -fno-rtti`, `-Wl,-z,max-page-size=16384`, `-Wl,--no-undefined`) to compile `ffmpeg_jni.cc` into
     `libffmpegJNI.so` linked against `SHARED IMPORTED` `libavcodec.so`, `libswresample.so`, `libavutil.so` and Android
     `liblog.so`.
  4. Strips unneeded debug symbols (`llvm-strip --strip-unneeded`) while retaining `.dynsym`/`.dynstr` and licence
     strings, copies the four `.so` files per ABI into `<output-dir>/jniLibs/<abi>/`, copies the five audio Java files
     (`FfmpegAudioDecoder.java`, `FfmpegAudioRenderer.java`, `FfmpegDecoderException.java`, `FfmpegLibrary.java`,
     `package-info.java` — excluding `ExperimentalFfmpegVideoRenderer.java`) into
     `<output-dir>/java/androidx/media3/decoder/ffmpeg/`, copies `proguard-rules.txt`, copies FFmpeg and Media3 licence
     files into `<output-dir>/assets/licenses/ffmpeg-media3/`, writes `BUILDINFO.json` at both `<output-dir>/BUILDINFO.json`
     and `<output-dir>/assets/licenses/ffmpeg-media3/BUILDINFO.json`, and asserts zero symlinks exist.
- `.github/workflows/ffmpeg-media3.yml`:
  - Triggered by `workflow_dispatch` and `push` on `paths: ['tools/ffmpeg-media3/**', '.github/workflows/ffmpeg-media3.yml']`.
  - Runs on `ubuntu-24.04` with `permissions: contents: read` and SHA-pinned actions (`actions/checkout`,
    `actions/setup-node`, `actions/upload-artifact`).
  - Installs `cmake` and `ninja-build` plus Android NDK `28.2.13676358` via `sdkmanager` if not cached on the runner,
    runs `tools/ffmpeg-media3/build-android.sh`, runs `node tools/bin/ffmpeg-media3.ts verify --dir`, packs
    `ffmpeg-media3-android.tar.gz`, prints the `ffmpeg-media3.lock.json` entry (`runId`, `sha256`) to
    `$GITHUB_STEP_SUMMARY`, and uploads artifact `ffmpeg-media3-android` (90-day retention).

### 5.3 Artifact layout, lockfile and pure-TypeScript gate (`tools/src/ffmpeg-media3/`)
Unpacked into `modules/engine-media3/vendor/ffmpeg-media3/` (gitignored; placed under `vendor/` rather than `build/` so
`gradlew clean` does not wipe it and repo checks never touch `**/build/**`):

```text
modules/engine-media3/vendor/ffmpeg-media3/
  BUILDINFO.json
  proguard-rules.txt
  java/androidx/media3/decoder/ffmpeg/
    FfmpegAudioDecoder.java
    FfmpegAudioRenderer.java
    FfmpegDecoderException.java
    FfmpegLibrary.java
    package-info.java
  jniLibs/
    arm64-v8a/{libavutil.so,libswresample.so,libavcodec.so,libffmpegJNI.so}
    armeabi-v7a/{libavutil.so,libswresample.so,libavcodec.so,libffmpegJNI.so}
    x86_64/{libavutil.so,libswresample.so,libavcodec.so,libffmpegJNI.so}
  assets/licenses/ffmpeg-media3/
    BUILDINFO.json
    ffmpeg/COPYING.LGPLv2.1
    ffmpeg/LICENSE.md
    media3/LICENSE
```

- **Lockfile (`modules/engine-media3/ffmpeg-media3.lock.json`):** records `repository`, `workflow`
  (`ffmpeg-media3.yml`), `artifactName` (`ffmpeg-media3-android`), `ffmpegVersion`, `media3Version`, `runId` and
  `sha256` (64 lowercase hex chars, or `null` before pinning).
- **Pure-TypeScript ELF32/ELF64 inspector (`tools/src/ffmpeg-media3/elf.ts`):** parses ELF headers, program headers and
  `.dynamic` / `.dynstr` sections directly from `Uint8Array` so verification runs identically on Linux, Windows and
  macOS without external `readelf` binaries. Enforces:
  - Expected ELF class, little-endian data encoding, `ET_DYN` type and `e_machine` per ABI (`EM_AARCH64 = 183` ELF64,
    `EM_ARM = 40` ELF32, `EM_X86_64 = 62` ELF64).
  - At least one `PT_LOAD` segment, and every `PT_LOAD` segment has `p_align >= 16384` with
    `(p_vaddr - p_offset) % p_align === 0`.
  - Exact unversioned `DT_SONAME` matching the file name (`libavutil.so`, `libswresample.so`, `libavcodec.so`,
    `libffmpegJNI.so`).
  - Required dynamic `DT_NEEDED` edges (`libffmpegJNI.so` -> `libavcodec.so`, `libswresample.so`, `libavutil.so`;
    `libavcodec.so` -> `libswresample.so`, `libavutil.so`; `libswresample.so` -> `libavutil.so`), proving FFmpeg was
    not statically linked into `libffmpegJNI.so`.
  - Every `DT_NEEDED` entry belongs to `{libavutil.so, libswresample.so, libavcodec.so, libc.so, libm.so, libdl.so,
    liblog.so, libandroid.so}` — rejecting `libc++_shared.so` or stray host libraries.
  - Zero `DT_RPATH` / `DT_RUNPATH` entries and zero `DT_TEXTREL` / `DF_TEXTREL` text relocations.
- **Licence and file completeness scanner (`tools/src/ffmpeg-media3/licence.ts`):** verifies all required Java,
  ProGuard, `BUILDINFO.json` and licence files are non-empty, scans every `.so` across all three ABIs to confirm the
  embedded `--prefix=/elv-ffmpeg/<abi>` configure string is present with `--enable-shared` and `--disable-static`, and
  fails on any occurrence of `--enable-gpl`, `--enable-nonfree`, `--enable-version3` or standalone `\bGPL version\b`
  (`LGPL version 2.1 or later` passes; `GPL version 2` or `GPL version 3` fails).
- **CLI (`tools/bin/ffmpeg-media3.ts`, root script `pnpm ffmpeg-media3`):**
  - `pnpm ffmpeg-media3 fetch [--force]`: skips when `vendor/ffmpeg-media3/.ffmpeg-media3-sha256` already matches the
    lockfile and passes full verification; otherwise downloads the GitHub Actions artifact via `gh run download` into
    `.cache/ffmpeg-media3/`, verifies the tarball SHA-256 (deleting corrupt downloads immediately), safely extracts
    while rejecting path traversal and symlinks, runs the full licence + ELF verifier, and writes the `.ffmpeg-media3-sha256`
    marker. When `runId` or `sha256` is `null`, exits cleanly with a note.
  - `pnpm ffmpeg-media3 verify [--dir <folder>]`: runs the full licence + ELF + file-tree check against `<folder>` (CI
    build output) or the installed `modules/engine-media3/vendor/ffmpeg-media3/` directory.

### 5.4 `@elv/engine-media3` integration (`modules/engine-media3/`)
- **`android/build.gradle`:**
  - Adds `implementation "androidx.media3:media3-decoder:$media3"` (`1.11.1`, needed by `FfmpegAudioDecoder` which
    extends `SimpleDecoder`).
  - Wires `vendor/ffmpeg-media3/java`, `vendor/ffmpeg-media3/jniLibs`, `vendor/ffmpeg-media3/assets` into `main`
    sourceSets and `vendor/ffmpeg-media3/proguard-rules.txt` into `consumerProguardFiles`.
  - Registers a `checkFfmpegMedia3` task attached to `preBuild` that fails with a clear message telling the developer to
    run `pnpm ffmpeg-media3 fetch` if `vendor/ffmpeg-media3/BUILDINFO.json` is missing.
- **`FfmpegAudio.kt`:**
  - Defines `LIBRARIES = arrayOf("avutil", "swresample", "avcodec", "ffmpegJNI")` and an idempotent
    `ensureConfigured()` calling `FfmpegLibrary.setLibraries(*LIBRARIES)` so Android loads the dependency chain in
    topological order before `libffmpegJNI.so` even on older dynamic linker implementations, while remaining safe under
    host-JVM Robolectric tests (`LibraryLoader.isAvailable()` catches `UnsatisfiedLinkError` on the JVM while allowing
    `FfmpegAudioRenderer` instantiation).
  - Exposes `isAvailable(): Boolean` and `supportsMimeType(mimeType: String): Boolean` delegating to `FfmpegLibrary`
    after `ensureConfigured()`.
- **`Media3Engine.kt`:**
  - Calls `FfmpegAudio.ensureConfigured()` immediately before creating `DefaultRenderersFactory(context)`.
  - Keeps `extensionRendererModeFor(options?.softwareAudio)`:
    - `EXTENSION_RENDERER_MODE_ON` when `softwareAudio` is `false` or unset -> `DefaultRenderersFactory` builds
      `[MediaCodecAudioRenderer, FfmpegAudioRenderer]`, so hardware/platform decoders handle AAC while FFmpeg handles
      AC-3, E-AC-3, DTS, TrueHD and MP2 whenever `MediaCodec` lacks them.
    - `EXTENSION_RENDERER_MODE_PREFER` when `softwareAudio == true` -> `DefaultRenderersFactory` builds
      `[FfmpegAudioRenderer, MediaCodecAudioRenderer]`, giving `@elv/playback`'s recovery ladder (`softwareDecode`) true
      FFmpeg software audio priority even for codecs `MediaCodec` claims to support.

### 5.5 App launcher, gate and CI wiring
- `tools/bin/run-app.ts`: runs `pnpm ffmpeg-media3 fetch` before `expo prebuild` / Gradle on Android targets (`android`,
  `android-tv`, `fire-tv`).
- `tools/src/gates/adb.ts`: runs `pnpm ffmpeg-media3 fetch` inside `buildApk` before `expo prebuild` so `pnpm gate list`,
  `pnpm gate import` and `pnpm gate player` always have the verified native bundle present.
- `.github/workflows/native.yml`: adds `modules/engine-media3/ffmpeg-media3.lock.json` and `tools/src/ffmpeg-media3/**`
  to Android change filters, grants `actions: read` to `android-mobile`, `android-tv` and `gate-list`, caches
  `.cache/ffmpeg-media3` keyed by `hashFiles('modules/engine-media3/ffmpeg-media3.lock.json')`, and runs
  `pnpm ffmpeg-media3 fetch` with `GH_TOKEN` before Android builds and unit tests.

## 6. Testing
- **TypeScript (`tools/test/ffmpeg-media3-*.test.ts`, Vitest, >= 90% coverage):**
  - `ffmpeg-media3-lock.test.ts`: valid lockfile, `null` unpinned lockfile, malformed JSON, bad `runId` / `sha256` /
    repo / workflow.
  - `ffmpeg-media3-elf.test.ts`: synthetic ELF32 LE ARM (`armeabi-v7a`) and ELF64 LE AArch64 / x86_64 binaries proving
    16 KB `PT_LOAD` alignment passes, 4 KB (`0x1000`) alignment fails, wrong `e_machine` fails, missing `libavcodec.so`
    in `libffmpegJNI.so` `DT_NEEDED` (static link simulation) fails, unexpected `libc++_shared.so` fails, mismatched
    versioned `DT_SONAME` (`libavcodec.so.61`) fails, and `DT_RPATH` / `DT_RUNPATH` / `DT_TEXTREL` / `DF_TEXTREL` fail.
  - `ffmpeg-media3-licence.test.ts`: LGPL-2.1+ configure string passes; `--enable-gpl`, `--enable-nonfree`,
    `--enable-version3`, `--enable-static`, missing `--enable-shared`, missing per-ABI configure marker and standalone
    `GPL version 2` / `GPL version 3` strings all fail; missing Java or licence notice files fail.
  - `ffmpeg-media3-fetch.test.ts`: no-op when unpinned, cache hit when marker + verification succeed, fresh fetch via
    stubbed `gh`, SHA-256 mismatch deletes archive and throws, archive traversal (`../`) and symlink entries fail.
- **Kotlin JVM (`modules/engine-media3/android/src/test/.../Media3EngineTest.kt`, Robolectric):**
  - Asserts `DefaultRenderersFactory` builds `[MediaCodecAudioRenderer, FfmpegAudioRenderer]` when `softwareAudio` is
    `false`/unset and `[FfmpegAudioRenderer, MediaCodecAudioRenderer]` when `softwareAudio` is `true`, and verifies
    `FfmpegAudio.LIBRARIES` order.
- **Android TV emulator (`elv_tv`, API 36 `x86_64`, against `pnpm sim --port 7880`):**
  - Instrumentation suite `FfmpegAudioPlaybackTest.kt` runs inside the emulator and asserts:
    1. `FfmpegAudio.isAvailable() == true` and `FfmpegLibrary.getVersion()` starts with `"Lavc"`.
    2. `FfmpegAudio.supportsMimeType(...) == true` across AC-3, E-AC-3, E-AC-3-JOC, DTS, DTS-HD, TrueHD, MP2, MP3, AAC,
       FLAC, ALAC, Opus, Vorbis, PCM A-law and PCM mu-law.
    3. APK `AssetManager` contains `licenses/ffmpeg-media3/BUILDINFO.json`, `ffmpeg/COPYING.LGPLv2.1`,
       `ffmpeg/LICENSE.md` and `media3/LICENSE` with LGPL-only flags.
    4. Live MPEG-TS playback of simulator recipes `mpeg2-ac3-576i25` (`corpus` channel `1004`, `audio/ac3`) and
       `h264-eac3-720p50` (`corpus` channel `1008`, `audio/eac3`) reaches `playing` with zero playback errors, selects
       FFmpeg audio decoders (`ffmpeg...-ac3`, `ffmpeg...-eac3`), and advances `audioDecoderCounters.renderedOutputBufferCount > 0`.
    5. Live playback of `h264-aac-720p25` (`corpus` channel `1001`, `audio/mp4a-latm`) with `softwareAudio = true`
       selects `ffmpeg...-aac` ahead of platform `MediaCodec` and renders audio output buffers.
  - End-to-end app player gate (`elviptv://gate/player`) zaps across AC-3 (`1004`), E-AC-3 (`1008`) and MP2 (`1005`) on
    `elv_tv` with zero errors.

## 7. Acceptance (from #69)
1. `.github/workflows/ffmpeg-media3.yml` reproducibly builds dynamic LGPL-2.1+ FFmpeg `9.0.2` and Media3 `1.11.1` JNI
   libraries for `arm64-v8a`, `armeabi-v7a` and `x86_64` with 16 KB ELF `PT_LOAD` alignment and passes the automated
   licence and ELF gate.
2. `pnpm ffmpeg-media3 fetch` and `pnpm ffmpeg-media3 verify` install and validate the CI-built artifact locked in
   `modules/engine-media3/ffmpeg-media3.lock.json` on developer machines and in `native.yml`.
3. `@elv/engine-media3` registers `FfmpegAudioRenderer` behind `EXTENSION_RENDERER_MODE_ON` by default and
   `EXTENSION_RENDERER_MODE_PREFER` when `options.softwareAudio === true`, and ships LGPL-2.1 and Apache-2.0 licence
   notices plus `BUILDINFO.json` in APK assets.
4. On the `elv_tv` Android TV emulator, `mpeg2-ac3-576i25` (AC-3) and `h264-eac3-720p50` (E-AC-3) reach `playing` and
   decode real non-zero audio output buffers without error.
5. `pnpm check`, `actionlint`, `zizmor` and `gitleaks` are green, and no generated `apps/tv-mobile/android` folder is
   committed.
