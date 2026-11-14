/** Media recipe a stream is generated from (spec sections 5.4 and 5.6). */
export type RecipeName =
  | 'h264-aac-720p25'
  | 'hevc-main10-1080p25'
  | 'mpeg2-ac3-576i25'
  | 'aac-radio'
  | 'hevc-main-1080p25'
  | 'h264-aac-1080i25'
  | 'h264-eac3-720p50'
  | 'h264-mp2-576p25'
  | 'h264-mp3-720p30'
  | 'h264-aac-res-switch'
  | 'h264-2audio-subs-720p25';

/** ISO 639-2 code of a generated subtitle language. */
export type SubtitleLang = 'tur' | 'eng';

/** How FFmpeg generates one recipe. */
export interface RecipeDef {
  /** Encoder arguments placed before `-t`; with `parts` they follow `-f concat -i parts.txt`. */
  args: readonly string[];
  /** External encoders the recipe needs, checked against `ffmpeg -encoders`. */
  encoders: readonly string[];
  /** Extra output arguments for the MP4 copy. */
  mp4Args: readonly string[];
  /** Video-only part encodes (arguments before `-t`) that alternate to form the loop. */
  parts?: { a: readonly string[]; b: readonly string[] };
  /** Subtitle languages (MP4, MKV and WebVTT) and the variant attributes of the master playlist. */
  subtitles?: { langs: readonly SubtitleLang[]; streamInf: string };
}

const PIC = (size: string, rate: number | string): string[] => [
  '-f',
  'lavfi',
  '-i',
  `testsrc=size=${size}:rate=${rate}`,
];
const TONE = (hz: number): string[] => [
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=${hz}:sample_rate=48000`,
];
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
const CBR = (k: number): string[] => [
  '-b:v',
  `${k}k`,
  '-maxrate',
  `${k}k`,
  '-bufsize',
  `${2 * k}k`,
];
const GOP = (g: number): string[] => ['-g', `${g}`, '-keyint_min', `${g}`, '-sc_threshold', '0'];
const AAC = ['-c:a', 'aac', '-b:a', '64k', '-ac', '2'];
const KEY25 = '25';

/** All recipe definitions. The first four are hash inputs of the cache folder names; do not change them. */
export const RECIPES: Readonly<Record<RecipeName, RecipeDef>> = {
  'h264-aac-720p25': {
    args: [
      ...PIC('1280x720', 25),
      ...TONE(1000),
      ...X264,
      '-b:v',
      '500k',
      '-maxrate',
      '500k',
      '-bufsize',
      '1000k',
      '-g',
      KEY25,
      '-keyint_min',
      KEY25,
      '-sc_threshold',
      '0',
      ...AAC,
    ],
    encoders: ['libx264'],
    mp4Args: [],
  },
  'hevc-main10-1080p25': {
    args: [
      ...PIC('1920x1080', 25),
      ...TONE(1000),
      '-c:v',
      'libx265',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p10le',
      '-profile:v',
      'main10',
      '-b:v',
      '1000k',
      '-x265-params',
      `keyint=${KEY25}:min-keyint=${KEY25}:scenecut=0:open-gop=0:log-level=error`,
      ...AAC,
    ],
    encoders: ['libx265'],
    mp4Args: ['-tag:v', 'hvc1'],
  },
  'mpeg2-ac3-576i25': {
    args: [
      ...PIC('720x576', 50),
      ...TONE(1000),
      '-vf',
      'tinterlace=mode=interleave_top,format=yuv420p',
      '-c:v',
      'mpeg2video',
      '-b:v',
      '1500k',
      '-maxrate',
      '1500k',
      '-bufsize',
      '1200k',
      '-flags',
      '+ildct+ilme',
      '-g',
      KEY25,
      '-c:a',
      'ac3',
      '-b:a',
      '96k',
      '-ac',
      '2',
    ],
    encoders: [],
    mp4Args: [],
  },
  'aac-radio': { args: [...TONE(1000), ...AAC], encoders: [], mp4Args: [] },
  'hevc-main-1080p25': {
    args: [
      ...PIC('1920x1080', 25),
      ...TONE(1000),
      '-c:v',
      'libx265',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'main',
      '-b:v',
      '1000k',
      '-x265-params',
      'keyint=25:min-keyint=25:scenecut=0:open-gop=0:log-level=error',
      ...AAC,
    ],
    encoders: ['libx265'],
    mp4Args: ['-tag:v', 'hvc1'],
  },
  'h264-aac-1080i25': {
    args: [
      ...PIC('1920x1080', 50),
      ...TONE(1000),
      '-vf',
      'tinterlace=mode=interleave_top,format=yuv420p',
      ...X264,
      '-flags',
      '+ildct+ilme',
      '-x264-params',
      'tff=1',
      ...CBR(1500),
      ...GOP(25),
      ...AAC,
    ],
    encoders: ['libx264'],
    mp4Args: [],
  },
  'h264-eac3-720p50': {
    args: [
      ...PIC('1280x720', 50),
      ...TONE(1000),
      ...X264,
      ...CBR(700),
      ...GOP(50),
      '-c:a',
      'eac3',
      '-b:a',
      '192k',
      '-ac',
      '6',
    ],
    encoders: ['libx264'],
    mp4Args: [],
  },
  'h264-mp2-576p25': {
    args: [
      ...PIC('720x576', 25),
      ...TONE(1000),
      '-vf',
      'setsar=64/45',
      ...X264,
      ...CBR(500),
      ...GOP(25),
      '-c:a',
      'mp2',
      '-b:a',
      '192k',
      '-ac',
      '2',
    ],
    encoders: ['libx264'],
    mp4Args: [],
  },
  'h264-mp3-720p30': {
    args: [
      ...PIC('1280x720', '30000/1001'),
      ...TONE(1000),
      ...X264,
      ...CBR(500),
      ...GOP(30),
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ac',
      '2',
    ],
    encoders: ['libx264', 'libmp3lame'],
    mp4Args: [],
  },
  'h264-aac-res-switch': {
    args: [...TONE(1000), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...AAC],
    parts: {
      a: [...PIC('1280x720', 25), ...X264, '-profile:v', 'high', ...CBR(500), ...GOP(25)],
      b: [...PIC('1920x1080', 25), ...X264, '-profile:v', 'high', ...CBR(1000), ...GOP(25)],
    },
    encoders: ['libx264'],
    mp4Args: [],
  },
  'h264-2audio-subs-720p25': {
    args: [
      ...PIC('1280x720', 25),
      ...TONE(1000),
      ...TONE(600),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      ...X264,
      '-profile:v',
      'high',
      '-level:v',
      '3.1',
      ...CBR(500),
      ...GOP(25),
      ...AAC,
      '-metadata:s:a:0',
      'language=tur',
      '-metadata:s:a:1',
      'language=eng',
    ],
    encoders: ['libx264'],
    mp4Args: [],
    subtitles: {
      langs: ['tur', 'eng'],
      streamInf:
        'BANDWIDTH=700000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=25.000',
    },
  },
};

/** Every recipe: the original four first, then the newer ones in spec order. */
export const ALL_RECIPES: readonly RecipeName[] = Object.keys(RECIPES) as RecipeName[];

/** Seconds each part of a resolution-switch loop lasts: 2 s multiples, at most 30 s. */
export function switchSeconds(seconds: number): number {
  return seconds >= 60 ? 30 : Math.max(2, 2 * Math.floor(seconds / 4));
}
