/** Result of scanning runtime binaries for their embedded build configuration. */
export interface LicenceVerdict {
  ok: boolean;
  problems: string[];
  ffmpegConfig: string | null;
  mpvOptions: string | null;
  lua: boolean;
}

const MIN_RUN = 16;

function* asciiRuns(bytes: Uint8Array): Generator<string> {
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const b = i < bytes.length ? (bytes[i] as number) : 0;
    if (b >= 0x20 && b < 0x7f) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= MIN_RUN) yield Buffer.from(bytes.subarray(start, i)).toString('latin1');
      start = -1;
    }
  }
}

function isFfmpegConfig(run: string): boolean {
  return run.includes('--prefix=') && (run.match(/--(?:enable|disable)-/g)?.length ?? 0) >= 3;
}

/**
 * Finds the embedded FFmpeg configure line and mpv build options in printable ASCII runs and
 * applies the 0.1 licence gate: no `--enable-gpl`, no `--enable-nonfree`, mpv `gpl=false`.
 */
export function scanLicence(
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
): LicenceVerdict {
  const problems: string[] = [];
  let ffmpegConfig: string | null = null;
  let mpvOptions: string | null = null;
  for (const file of files) {
    for (const run of asciiRuns(file.bytes)) {
      if (isFfmpegConfig(run)) {
        ffmpegConfig ??= run;
        if (/--enable-gpl(?![\w-])/.test(run))
          problems.push(`${file.name}: FFmpeg built with --enable-gpl`);
        if (/--enable-nonfree(?![\w-])/.test(run))
          problems.push(`${file.name}: FFmpeg built with --enable-nonfree`);
      }
      if (run.includes('-Dgpl=')) {
        mpvOptions ??= run;
        if (!/-Dgpl=false(?![\w-])/.test(run))
          problems.push(`${file.name}: mpv not built with -Dgpl=false`);
      }
    }
  }
  if (ffmpegConfig === null) problems.push('no embedded FFmpeg configuration found');
  if (mpvOptions === null) problems.push('no embedded mpv build options found (-Dgpl=)');
  const lua = mpvOptions !== null && /-Dlua=(?!disabled)\S/.test(mpvOptions);
  return { ok: problems.length === 0, problems, ffmpegConfig, mpvOptions, lua };
}
