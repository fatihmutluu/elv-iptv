# tools/src/ffmpeg-media3

Lockfile parser, pure-TypeScript ELF32/ELF64 16 KB + `DT_NEEDED` verifier, LGPL-2.1+ licence gate and artifact downloader for `@elv/engine-media3`'s Android FFmpeg bundle (`pnpm ffmpeg-media3`).

## Modules
- `lock.ts`: validates `modules/engine-media3/ffmpeg-media3.lock.json` (`runId`, `sha256`, versions).
- `elf.ts`: parses ELF32/ELF64 headers, enforces `PT_LOAD` `p_align >= 16384`, unversioned `DT_SONAME`, dynamic FFmpeg `DT_NEEDED` edges (`libffmpegJNI.so` -> `libavcodec.so`, `libswresample.so`, `libavutil.so`) and zero `RPATH`/`TEXTREL`.
- `licence.ts`: verifies Java/ProGuard/notice completeness, LGPL-2.1+ configure markers per ABI, and zero GPL/nonfree strings or `.a`/symlink entries.
- `fetch.ts` and `real-deps.ts`: `gh run download` + built-in USTAR `.tar.gz` extraction into gitignored `modules/engine-media3/vendor/ffmpeg-media3/`.
