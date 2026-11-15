# tools/ffmpeg-media3

Reproducible Android cross-compilation recipe for `@elv/engine-media3`'s LGPL-2.1+ FFmpeg `9.0.2` shared libraries and `androidx/media` `1.11.1` `libffmpegJNI.so` bridge (`.github/workflows/ffmpeg-media3.yml`).

## Files
- `versions.json`: pinned FFmpeg tarball URL + SHA-256, `androidx/media` tag/commit + per-file SHA-256s, Android NDK `28.2.13676358`, `androidMinSdk: 28`, ABIs (`arm64-v8a`, `armeabi-v7a`, `x86_64`), and the 14 built-in LGPL audio decoders.
- `CMakeLists.txt`: builds `libffmpegJNI.so` (`ANDROID_STL=none`, `-fno-exceptions -fno-rtti`, `-Wl,-z,max-page-size=16384`, `-Wl,--no-undefined`) dynamically linked (`SHARED IMPORTED`) against `libavcodec.so`, `libswresample.so` and `libavutil.so`.
- `build-android.sh`: isolates `PKG_CONFIG_LIBDIR`, verifies all upstream SHA-256s, builds all three ABIs with `--enable-shared --disable-static` and zero GPL/nonfree flags, stages Java audio sources + ProGuard rules + LGPL/Apache-2.0 notices + `BUILDINFO.json`.
