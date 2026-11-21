import {
  type BrowseKind,
  type CategoryRow,
  DEFAULT_PROFILE_ID,
  type EpisodeRow,
  type FavoriteRow,
  type ItemRow,
  type WatchProgressRow,
} from '@elv/data';
import { type ArtworkSpec, createSyntheticArtwork } from './synthetic-art.ts';

/** Synthetic source id for the dev-only UI Workbench demo catalog. */
export const DEMO_SOURCE_ID = 'workbench-demo';

type Palette = ArtworkSpec['palette'];
type Motif = ArtworkSpec['motif'];

const DEFAULT_PALETTE: Palette = ['#070A12', '#1A2640', '#E11D48', '#38BDF8'];

const P: Record<string, Palette> = {
  horizon: DEFAULT_PALETTE,
  orbital: ['#060B15', '#152544', '#3B82F6', '#93C5FD'],
  lanterns: ['#0D090A', '#2B181C', '#F43F5E', '#FBBF24'],
  nordic: ['#070B12', '#142738', '#0EA5E9', '#67E8F9'],
  cinema: ['#090A10', '#1E1A2E', '#E11D48', '#FB7185'],
  festival: ['#0C0908', '#291D14', '#F59E0B', '#FBBF24'],
  relay: ['#080912', '#191D34', '#A855F7', '#C084FC'],
  arena: ['#070C0B', '#112922', '#10B981', '#6EE7B7'],
  meridian: ['#0A0908', '#221C16', '#F97316', '#FDBA74'],
  harbor: ['#080C10', '#162834', '#14B8A6', '#5EEAD4'],
  slate: ['#070B12', '#1B2432', '#64748B', '#CBD5E1'],
};

const art = (id: string, aspect: ArtworkSpec['aspect'], p: string, motif: Motif): string =>
  createSyntheticArtwork({ id, aspect, palette: P[p] ?? DEFAULT_PALETTE, motif });

const cat = (
  kind: BrowseKind,
  slug: string,
  name: string,
  position: number,
  itemCount: number,
): CategoryRow => ({
  id: `${DEMO_SOURCE_ID}|${kind}|${slug}`,
  sourceId: DEMO_SOURCE_ID,
  kind,
  name,
  position,
  itemCount,
});

const item = (
  id: number,
  kind: BrowseKind,
  name: string,
  palette: string,
  motif: Motif,
  extra: { num?: number; year?: number; rating?: number } = {},
): ItemRow => ({
  id,
  key: `wb:${kind}:${id}`,
  kind,
  sourceId: DEMO_SOURCE_ID,
  providerId: String(id),
  name,
  logo: art(`wb-${kind}-${id}`, kind === 'live' ? '16:9' : '2:3', palette, motif),
  rating: extra.rating ?? null,
  year: extra.year ?? null,
  num: extra.num ?? null,
});

/** Static synthetic categories exposed by the UI Workbench catalog. */
export const WORKBENCH_CATEGORIES: readonly CategoryRow[] = [
  cat('live', 'cinema', 'Cinema Broadcast', 0, 4),
  cat('live', 'sports', 'Sports Arena', 1, 3),
  cat('live', 'news', 'World News', 2, 3),
  cat('movie', 'scifi', 'Sci-Fi & Adventure', 0, 4),
  cat('movie', 'drama', 'Festival Drama', 1, 3),
  cat('series', 'originals', 'Studio Originals', 0, 3),
];

/** Static synthetic items keyed by category id for the UI Workbench catalog. */
export const WORKBENCH_ITEMS_BY_CATEGORY: Readonly<Record<string, readonly ItemRow[]>> = {
  [`${DEMO_SOURCE_ID}|live|cinema`]: [
    item(101, 'live', 'Velvet Cinema 4K', 'cinema', 'cinema', { num: 101 }),
    item(102, 'live', 'Classic Reels HD', 'festival', 'festival', { num: 102 }),
    item(103, 'live', 'Midnight Noir TV', 'relay', 'relay', { num: 103 }),
    item(104, 'live', 'Premiere Stage', 'lanterns', 'lanterns', { num: 104 }),
  ],
  [`${DEMO_SOURCE_ID}|live|sports`]: [
    item(201, 'live', 'Pitch Sports 1 UHD', 'arena', 'arena', { num: 201 }),
    item(202, 'live', 'Track & Motorsport', 'meridian', 'meridian', { num: 202 }),
    item(203, 'live', 'Court Center Live', 'orbital', 'arena', { num: 203 }),
  ],
  [`${DEMO_SOURCE_ID}|live|news`]: [
    item(301, 'live', 'Global Desk 24', 'nordic', 'orbital', { num: 301 }),
    item(302, 'live', 'Meridian Business', 'harbor', 'harbor', { num: 302 }),
    item(303, 'live', 'Weather Pulse', 'horizon', 'nordic', { num: 303 }),
  ],
  [`${DEMO_SOURCE_ID}|movie|scifi`]: [
    item(401, 'movie', 'Silent Horizon', 'horizon', 'horizon', { year: 2026, rating: 8.6 }),
    item(402, 'movie', 'Orbital Nine', 'orbital', 'orbital', { year: 2025, rating: 8.2 }),
    item(403, 'movie', 'Glass Meridian', 'meridian', 'meridian', { year: 2024, rating: 7.9 }),
    item(404, 'movie', 'Echoes of Titan', 'relay', 'relay', { year: 2026, rating: 8.4 }),
  ],
  [`${DEMO_SOURCE_ID}|movie|drama`]: [
    item(501, 'movie', 'Harbor Lights', 'harbor', 'harbor', { year: 2025, rating: 8.1 }),
    item(502, 'movie', 'Winter Telegraph', 'slate', 'nordic', { year: 2023, rating: 7.8 }),
    item(503, 'movie', 'Paper Lanterns', 'lanterns', 'lanterns', { year: 2026, rating: 8.5 }),
  ],
  [`${DEMO_SOURCE_ID}|series|originals`]: [
    item(601, 'series', 'Northern Signal', 'nordic', 'nordic', { year: 2026, rating: 8.8 }),
    item(602, 'series', 'Watchmaker Alley', 'festival', 'festival', { year: 2025, rating: 8.3 }),
    item(603, 'series', 'Blue Station', 'orbital', 'cinema', { year: 2024, rating: 8.0 }),
  ],
};

/** Direct item lookup by stable content key across all workbench categories. */
export const WORKBENCH_ITEMS_BY_KEY = new Map<string, ItemRow>(
  Object.values(WORKBENCH_ITEMS_BY_CATEGORY)
    .flat()
    .map((row) => [row.key, row]),
);

/** Synthetic English synopses for UI Workbench movies and series (zero third-party brands). */
export const WORKBENCH_PLOTS: Readonly<Record<string, string>> = {
  'wb:movie:401':
    'When a deep-space relay array falls silent beyond the outer rim, a cartographer and her navigation crew trace an unscheduled beacon back to a drifting observatory hidden in frozen dust.',
  'wb:movie:402':
    'Aboard the ninth ring of an equatorial transfer station, a structural engineer uncovers a quiet discrepancy in the orbital manifest hours before a solar storm locks every docking bay.',
  'wb:movie:403':
    'Along a desert mirror highway that bends afternoon light into mirages, a courier carrying an encrypted glass archive must cross three border checkpoints before dusk.',
  'wb:movie:404':
    'During a long methane winter on a distant moon, two acoustic surveyors record rhythmic tremors beneath the ice shelf that challenge everything known about the first landing.',
  'wb:movie:501':
    'Over one fogbound autumn weekend in a coastal shipyard town, a retired ferry captain and his estranged daughter restore a timber pilot boat before the harbor auction.',
  'wb:movie:502':
    'In a snowbound mountain rail depot in 1954, a night telegraph operator pieces together a coded passenger list that quietly alters the fate of an entire valley.',
  'wb:movie:503':
    'A neighborhood bookbinder and a young stage lighting designer collaborate to revive a shuttered lantern courtyard theater ahead of the city solstice festival.',
  'wb:series:601':
    'At an arctic listening outpost above the polar circle, a signal analyst intercepts a repeating shortwave pattern whose timestamps arrive forty minutes ahead of local time.',
  'wb:series:602':
    'Hidden behind a narrow cobblestone arcade, three generations of mechanical clockmakers untangle the provenance of a brass astronomical timepiece left anonymously on their counter.',
  'wb:series:603':
    'Inside an underground transit hub that runs through the small hours, dispatchers, conductors, and night-shift botanists keep a sprawling coastal metropolis moving until dawn.',
};

/** Generates synthetic episodes for one season of a workbench series. */
export const makeWorkbenchEpisodes = (seriesId: number, season: number): EpisodeRow[] =>
  ['Opening Signal', 'Night Crossing', 'Static Line'].map((title, idx) => ({
    id: seriesId * 100 + season * 10 + idx + 1,
    key: `wb:ep:${seriesId}:s${season}e${idx + 1}`,
    season,
    episode: idx + 1,
    title,
    durationSec: 2880 + idx * 120,
  }));

/** Pre-seeded Continue Watching rows for the UI Workbench. */
export const WORKBENCH_SEED_PROGRESS: readonly WatchProgressRow[] = [
  {
    profileId: DEFAULT_PROFILE_ID,
    sourceId: DEMO_SOURCE_ID,
    itemKey: 'wb:movie:401',
    kind: 'movie',
    title: 'Silent Horizon',
    subtitle: '2026 · Sci-Fi',
    logo: art('wb-movie-401-wide', '16:9', 'horizon', 'horizon'),
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 3_376_800,
    durationMs: 8_040_000,
    watched: false,
    updatedAt: 1_700_000_200_000,
  },
  {
    profileId: DEFAULT_PROFILE_ID,
    sourceId: DEMO_SOURCE_ID,
    itemKey: 'wb:ep:601:s1e2',
    kind: 'episode',
    title: 'Northern Signal',
    subtitle: 'S1 E2 · Night Crossing',
    logo: art('wb-series-601-wide', '16:9', 'nordic', 'nordic'),
    seriesKey: 'wb:series:601',
    season: 1,
    episode: 2,
    positionMs: 1_920_000,
    durationMs: 3_000_000,
    watched: false,
    updatedAt: 1_700_000_100_000,
  },
];

/** Pre-seeded My List favorites for the UI Workbench. */
export const WORKBENCH_SEED_FAVORITES: readonly FavoriteRow[] = [
  {
    profileId: DEFAULT_PROFILE_ID,
    sourceId: DEMO_SOURCE_ID,
    itemKey: 'wb:movie:402',
    kind: 'movie',
    title: 'Orbital Nine',
    logo: art('wb-movie-402', '2:3', 'orbital', 'orbital'),
    year: 2025,
    rating: 8.2,
    addedAt: 1_700_000_200_000,
  },
  {
    profileId: DEFAULT_PROFILE_ID,
    sourceId: DEMO_SOURCE_ID,
    itemKey: 'wb:movie:503',
    kind: 'movie',
    title: 'Paper Lanterns',
    logo: art('wb-movie-503', '2:3', 'lanterns', 'lanterns'),
    year: 2026,
    rating: 8.5,
    addedAt: 1_700_000_100_000,
  },
];
