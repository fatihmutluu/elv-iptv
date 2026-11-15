# tools/src/ffmpeg-media3

Lockfile parser, pure-TypeScript ELF32/ELF64 16 KB + `DT_NEEDED` verifier, LGPL-2.1+ licence gate and artifact downloader for `@elv/engine-media3`'s Android FFmpeg bundle (`pnpm ffmpeg-media3`).

## Modules
- `lock.ts`: validates `modules/engine-media3/ffmpeg-media3.lock.json` (`runId`, `sha256`, versions).
- `elf.ts`: parses ELF32/ELF64 headers and bounds (`PT_LOAD`, section headers, `DT_NULL`, `.dynstr`), enforces `PT_LOAD` `p_align >= 16384`, unversioned `DT_SONAME`, dynamic FFmpeg `DT_NEEDED` edges (`libffmpegJNI.so` -> `libavcodec.so` -> `libswresample.so` -> `libavutil.so`) and zero `RPATH`/`TEXTREL`.
- `licence.ts`: enforces the exact 23-file bundle allowlist, LGPL-2.1+ configure markers per ABI, and zero GPL/LGPLv3/nonfree strings or `.a`/symlink entries.
- `fetch.ts` and `real-deps.ts`: `gh run download` + size/PAX-guarded `.tar.gz` extraction into gitignored `modules/engine-media3/vendor/ffmpeg-media3/`.
