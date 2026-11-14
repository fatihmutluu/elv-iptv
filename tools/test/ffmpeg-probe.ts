import { spawnSync } from 'node:child_process';

/** The `Stream #` lines of `ffmpeg -hide_banner -i <file>`, for asserting codecs, sizes and languages. */
export function streamLines(ffmpeg: string, file: string): string[] {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return `${probe.stderr}`.split('\n').filter((line) => /^\s*Stream #/.test(line));
}
