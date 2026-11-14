import type { Catalog, Category, LiveChannel, Movie } from './catalog-types.ts';
import type { RecipeName } from './recipes.ts';

const GROUPS = [
  'Video codecs',
  'Audio codecs',
  'Frame rates',
  'Tracks and subtitles',
  'Edge cases',
] as const;
const CHANNELS: readonly (readonly [string, RecipeName, number, string | null])[] = [
  ['H.264 720p25 AAC', 'h264-aac-720p25', 0, null],
  ['HEVC 1080p25 8-bit', 'hevc-main-1080p25', 0, null],
  ['HEVC 1080p25 10-bit', 'hevc-main10-1080p25', 0, null],
  ['MPEG-2 576i25 AC-3', 'mpeg2-ac3-576i25', 0, null],
  ['H.264 576p25 MP2', 'h264-mp2-576p25', 1, null],
  ['AAC radio', 'aac-radio', 1, null],
  ['H.264 1080i25', 'h264-aac-1080i25', 2, null],
  ['H.264 720p50 E-AC-3 5.1', 'h264-eac3-720p50', 2, null],
  ['H.264 720p29.97 MP3', 'h264-mp3-720p30', 2, null],
  ['Two audio tracks and subtitles', 'h264-2audio-subs-720p25', 3, null],
  ['Resolution switch 720p and 1080p', 'h264-aac-res-switch', 4, null],
  ['Stream labelled as a web page', 'h264-aac-720p25', 4, 'type=text/html'],
  ['Redirect to HLS', 'h264-aac-720p25', 4, 'redirect=hls'],
];
const MKV_MOVIES: readonly RecipeName[] = [
  'hevc-main-1080p25',
  'mpeg2-ac3-576i25',
  'h264-mp2-576p25',
  'h264-aac-1080i25',
  'h264-aac-res-switch',
];
const SUBTITLE_RECIPE: RecipeName = 'h264-2audio-subs-720p25';
const DURATION_SEC = 600;
const ADDED = 1_700_000_000;
const SUBTITLE_GROUP = 3;

const liveCategory = (group: number): string => String(group + 1);
const vodCategory = (group: number): string => String(10001 + group);

/** The `corpus` profile: one live channel and one movie per media recipe, two delivery-quirk channels and a short series. */
export function corpusCatalog(seed: number): Catalog {
  const categories: Category[] = [
    ...GROUPS.map((name, i): Category => ({ id: liveCategory(i), name, kind: 'live' })),
    ...GROUPS.map((name, i): Category => ({ id: vodCategory(i), name, kind: 'vod' })),
    { id: '20001', name: GROUPS[SUBTITLE_GROUP], kind: 'series' },
  ];
  const live = CHANNELS.map(
    ([name, recipe, group, fault], i): LiveChannel => ({
      id: 1001 + i,
      num: i + 1,
      name,
      categoryId: liveCategory(group),
      epgId: `ch${1001 + i}`,
      logo: (1001 + i) % 16,
      recipe,
      fault,
      archiveDays: 0,
      compat: null,
    }),
  );
  const movies: Movie[] = [];
  const addMovie = (name: string, group: number, recipe: RecipeName, ext: 'mp4' | 'mkv'): void => {
    movies.push({
      id: 200001 + movies.length,
      name: `${name} (${ext.toUpperCase()})`,
      categoryId: vodCategory(group),
      ext,
      recipe,
      durationSec: DURATION_SEC,
      added: ADDED,
    });
  };
  for (const [name, recipe, group, fault] of CHANNELS) {
    if (fault !== null) continue;
    if (recipe === SUBTITLE_RECIPE) {
      addMovie(name, group, recipe, 'mp4');
      addMovie(name, group, recipe, 'mkv');
    } else {
      addMovie(name, group, recipe, MKV_MOVIES.includes(recipe) ? 'mkv' : 'mp4');
    }
  }
  const seriesName = 'Subtitle Series';
  return {
    profile: 'corpus',
    seed,
    categories,
    live,
    movies,
    series: [
      {
        id: 300001,
        name: seriesName,
        categoryId: '20001',
        episodes: [1, 2, 3, 4, 5, 6].map((n) => {
          const season = n <= 3 ? 1 : 2;
          const episode = ((n - 1) % 3) + 1;
          return {
            id: 400000 + n,
            season,
            episode,
            title: `${seriesName} S0${season}E0${episode}`,
            ext: 'mkv' as const,
            recipe: SUBTITLE_RECIPE,
            durationSec: DURATION_SEC,
          };
        }),
      },
    ],
    guideChannels: live.length,
    guideWindow: { daysBack: 2, daysForward: 7 },
  };
}
