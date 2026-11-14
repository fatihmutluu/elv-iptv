import type { SubtitleLang } from './recipes.ts';

/** HLS language tag (RFC 5646) and display name of each subtitle language. */
export const SUBTITLE_LANGS: Readonly<Record<SubtitleLang, { hls: string; name: string }>> = {
  tur: { hls: 'tr', name: 'Turkish' },
  eng: { hls: 'en', name: 'English' },
};

const two = (n: number): string => String(n).padStart(2, '0');

/** `hh:mm:ss<sep>000` for a whole second. */
function clock(second: number, separator: string): string {
  const h = Math.floor(second / 3600);
  const m = Math.floor(second / 60) % 60;
  return `${two(h)}:${two(m)}:${two(second % 60)}${separator}000`;
}

/** Text of the cue shown during loop second `second`, such as `TUR 00:12`. */
export function cueText(lang: SubtitleLang, second: number): string {
  return `${lang.toUpperCase()} ${two(Math.floor(second / 60))}:${two(second % 60)}`;
}

/** SRT file with one cue per second of a loop of `seconds`. */
export function srtText(lang: SubtitleLang, seconds: number): string {
  const cues: string[] = [];
  for (let t = 0; t < seconds; t++) {
    cues.push(`${t + 1}\n${clock(t, ',')} --> ${clock(t + 1, ',')}\n${cueText(lang, t)}\n`);
  }
  return cues.join('\n');
}

/**
 * WebVTT segment `index` (loop time `2 * index` to `2 * index + 2`, cut at the loop end). Its
 * `X-TIMESTAMP-MAP` maps the segment start to `pts`, the first video PTS of the TS segment it accompanies.
 */
export function vttSegment(
  lang: SubtitleLang,
  index: number,
  seconds: number,
  pts: number,
): string {
  const start = 2 * index;
  const cues: string[] = [];
  for (let t = start; t < Math.min(start + 2, seconds); t++) {
    cues.push(`${clock(t, '.')} --> ${clock(t + 1, '.')}\n${cueText(lang, t)}\n`);
  }
  return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${pts},LOCAL:${clock(start, '.')}\n\n${cues.join('\n')}`;
}
