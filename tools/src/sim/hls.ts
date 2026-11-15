import { RECIPES, type RecipeName, type SubtitleLang } from './recipes.ts';
import { SUBTITLE_LANGS } from './subtitles.ts';

const HLS_EPOCH_MS = Date.UTC(2026, 0, 1);
const HLS_WINDOW = 6;
const HLS_SEGMENT_MS = 2000;

/** URI of segment `seq` of a recipe: the TS segment, or with `lang` the WebVTT segment of that language. */
export function segmentUri(
  recipe: RecipeName,
  lang: SubtitleLang | null = null,
): (seq: number) => string {
  return lang === null
    ? (seq) => `/hls/${recipe}/${seq}.ts`
    : (seq) => `/hls/${recipe}/subs/${lang}/${seq}.vtt`;
}

/**
 * Sliding-window media playlist for `nowMs`. Discontinuity tags precede segments whose index wraps to 0
 * (seq > 0, multiple of `segmentCount`); the discontinuity sequence counts those that left the window.
 * `uri` names each segment; it defaults to the recipe's TS segments.
 */
export function hlsPlaylist(
  recipe: RecipeName,
  segmentCount: number,
  nowMs: number,
  uri: (seq: number) => string = segmentUri(recipe),
): string {
  const first = Math.max(0, Math.floor((nowMs - HLS_EPOCH_MS) / HLS_SEGMENT_MS));
  const wraps = first > 0 ? Math.floor((first - 1) / segmentCount) : 0;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${wraps}`,
  ];
  for (let seq = first; seq < first + HLS_WINDOW; seq++) {
    if (seq > 0 && seq % segmentCount === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:2.000,', uri(seq));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Complete VOD media playlist with one segment per duration. The target duration is the longest
 * duration rounded to the nearest second (RFC 8216 4.3.3.1), 2 for every recipe.
 */
export function vodPlaylist(durations: readonly number[], uri: (index: number) => string): string {
  const target = Math.max(1, ...durations.map((d) => Math.round(d)));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (const [i, d] of durations.entries()) lines.push(`#EXTINF:${d.toFixed(3)},`, uri(i));
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/** Master playlist of a subtitle recipe: one subtitle rendition per language and the muxed variant. */
export function masterPlaylist(recipe: RecipeName, mode: 'live' | 'vod'): string {
  const subtitles = RECIPES[recipe].subtitles;
  if (!subtitles) throw new Error(`recipe ${recipe} has no subtitles`);
  const lines = ['#EXTM3U'];
  for (const lang of subtitles.langs) {
    const { hls, name } = SUBTITLE_LANGS[lang];
    const uri = `/hls/${recipe}/subs/${lang}/${mode}.m3u8`;
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${hls}",NAME="${name}",DEFAULT=NO,AUTOSELECT=YES,URI="${uri}"`,
    );
  }
  lines.push(
    `#EXT-X-STREAM-INF:${subtitles.streamInf},SUBTITLES="subs"`,
    `/hls/${recipe}/${mode}.m3u8`,
  );
  return `${lines.join('\n')}\n`;
}

/** Segment durations listed by an FFmpeg-written media playlist. */
export function parseDurations(indexM3u8: string): number[] {
  return [...indexM3u8.matchAll(/^#EXTINF:([\d.]+),/gm)].map((m) => Number(m[1]));
}
