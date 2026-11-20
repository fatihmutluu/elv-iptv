import {
  type AddSourceInput,
  type BrowseKind,
  type CatalogService,
  type CategoryRow,
  DEFAULT_PROFILE_ID,
  type EpisodeRow,
  type FavoriteRow,
  type ItemRow,
  isCompletedProgress,
  type LinkSourceInput,
  MIN_RESUME_POSITION_MS,
  type SaveProgressInput,
  type SourceRow,
  type ToggleFavoriteInput,
  type WatchProgressRow,
} from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { type ArtworkSpec, createSyntheticArtwork } from './synthetic-art.ts';

const DEMO_SOURCE_ID = 'workbench-demo';
const MAX_LIST_LIMIT = 100;
const MAX_PROGRESS_KEYS = 200;

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

const CATEGORIES: readonly CategoryRow[] = [
  cat('live', 'cinema', 'Cinema Broadcast', 0, 4),
  cat('live', 'sports', 'Sports Arena', 1, 3),
  cat('live', 'news', 'World News', 2, 3),
  cat('movie', 'scifi', 'Sci-Fi & Adventure', 0, 4),
  cat('movie', 'drama', 'Festival Drama', 1, 3),
  cat('series', 'originals', 'Studio Originals', 0, 3),
];

const ITEMS_BY_CATEGORY: Readonly<Record<string, readonly ItemRow[]>> = {
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

const makeEpisodes = (seriesId: number, season: number): EpisodeRow[] =>
  ['Opening Signal', 'Night Crossing', 'Static Line'].map((title, idx) => ({
    id: seriesId * 100 + season * 10 + idx + 1,
    key: `wb:ep:${seriesId}:s${season}e${idx + 1}`,
    season,
    episode: idx + 1,
    title,
    durationSec: 2880 + idx * 120,
  }));

const pKey = (profileId: string, itemKey: string): string => `${profileId}\0${itemKey}`;
const normProfile = (profileId?: string): string => {
  const t = profileId?.trim();
  return t && t.length > 0 ? t : DEFAULT_PROFILE_ID;
};
const clampLimit = (limit: number | undefined, fallback: number): number => {
  const n = limit === undefined || !Number.isFinite(limit) ? fallback : Math.floor(limit);
  return Math.min(MAX_LIST_LIMIT, Math.max(0, n));
};

const SEED_PROGRESS: readonly WatchProgressRow[] = [
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

const SEED_FAVORITES: readonly FavoriteRow[] = [
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

/**
 * In-memory synthetic {@link CatalogService} powering the browser UI Workbench (`pnpm dev:ui`)
 * with zero network calls, zero credentials, and zero third-party names.
 */
export function createWorkbenchCatalog(): CatalogService {
  let nextId = 1;
  let tick = 1_700_000_300_000;
  const nextTick = (): number => {
    tick += 100;
    return tick;
  };
  const sources: SourceRow[] = [
    {
      id: DEMO_SOURCE_ID,
      kind: 'xtream',
      name: 'Studio Demo Catalog',
      createdAt: 1_700_000_000_000,
      needsImport: false,
    },
  ];
  const progress = new Map(SEED_PROGRESS.map((r) => [pKey(r.profileId, r.itemKey), { ...r }]));
  const favorites = new Map(SEED_FAVORITES.map((r) => [pKey(r.profileId, r.itemKey), { ...r }]));

  return {
    async addSource(input: AddSourceInput) {
      const row: SourceRow = {
        id: `wb-src-${nextId++}`,
        kind: input.kind,
        name: input.name?.trim() || `Synthetic ${input.kind.toUpperCase()}`,
        createdAt: Date.now(),
        needsImport: true,
      };
      sources.push(row);
      return ok(row);
    },
    async addSourceFromLink(input: LinkSourceInput) {
      const row: SourceRow = {
        id: `wb-src-${nextId++}`,
        kind: 'm3u',
        name: input.name?.trim() || 'Synthetic Playlist',
        createdAt: Date.now(),
        needsImport: true,
      };
      sources.push(row);
      return ok(row);
    },
    async removeSource(id: string) {
      const idx = sources.findIndex((s) => s.id === id);
      if (idx >= 0) sources.splice(idx, 1);
      for (const [k, row] of progress) if (row.sourceId === id) progress.delete(k);
      for (const [k, row] of favorites) if (row.sourceId === id) favorites.delete(k);
      return ok(undefined);
    },
    async importSource(id: string) {
      const src = sources.find((s) => s.id === id);
      if (!src) return err(elvError('storage', 'not-found', `Unknown source ${id}`));
      src.needsImport = false;
      return ok({
        runId: nextId++,
        counts: { categories: CATEGORIES.length, live: 10, movies: 7, series: 3, episodes: 18 },
        warnings: 0,
        warningCodes: [],
        durationMs: 12,
      });
    },
    listSources: async () => sources.map((s) => ({ ...s })),
    async categories(sourceId: string, kind: BrowseKind) {
      if (!sources.some((s) => s.id === sourceId && !s.needsImport)) return [];
      return CATEGORIES.filter((c) => c.kind === kind).map((c) => ({
        ...c,
        sourceId,
        id: c.id.replace(DEMO_SOURCE_ID, sourceId),
      }));
    },
    async items(categoryId: string, offset: number, limit: number) {
      const [sourceId = DEMO_SOURCE_ID, ...rest] = categoryId.split('|');
      const all = ITEMS_BY_CATEGORY[`${DEMO_SOURCE_ID}|${rest.join('|')}`] ?? [];
      const start = Math.max(0, offset);
      return all.slice(start, start + Math.max(0, limit)).map((i) => ({ ...i, sourceId }));
    },
    seasons: async (seriesId: number) =>
      ok(
        seriesId >= 601 && seriesId <= 603
          ? [
              { season: 1, episodeCount: 3 },
              { season: 2, episodeCount: 3 },
            ]
          : [{ season: 1, episodeCount: 3 }],
      ),
    episodes: async (seriesId: number, season: number) => makeEpisodes(seriesId, season),
    resolveStream: async (itemKey: string) =>
      ok({ url: `http://127.0.0.1:7878/workbench/${encodeURIComponent(itemKey)}`, headers: {} }),
    async saveProgress(input: SaveProgressInput) {
      const profileId = normProfile(input.profileId);
      const positionMs = Math.max(0, Math.round(input.positionMs));
      const durationMs = Math.max(0, Math.round(input.durationMs));
      const row: WatchProgressRow = {
        profileId,
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        subtitle: input.subtitle ?? null,
        logo: input.logo ?? null,
        seriesKey: input.seriesKey ?? null,
        season: input.season ?? null,
        episode: input.episode ?? null,
        positionMs,
        durationMs,
        watched: input.watched ?? isCompletedProgress(positionMs, durationMs),
        updatedAt: nextTick(),
      };
      progress.set(pKey(profileId, row.itemKey), row);
      return ok({ ...row });
    },
    async setWatched(itemKey: string, watched: boolean, profileId?: string) {
      const key = pKey(normProfile(profileId), itemKey);
      const existing = progress.get(key);
      if (existing) {
        progress.set(key, {
          ...existing,
          watched,
          positionMs: watched ? existing.positionMs : 0,
          updatedAt: nextTick(),
        });
      }
      return ok(undefined);
    },
    getProgress: async (itemKey: string, profileId?: string) => {
      const row = progress.get(pKey(normProfile(profileId), itemKey));
      return row ? { ...row } : null;
    },
    async listContinueWatching(limit?: number, profileId?: string) {
      const pid = normProfile(profileId);
      const max = clampLimit(limit, 24);
      if (max === 0) return [];
      return [...progress.values()]
        .filter((r) => r.profileId === pid && !r.watched && r.positionMs >= MIN_RESUME_POSITION_MS)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max)
        .map((r) => ({ ...r }));
    },
    async listProgressByKeys(itemKeys: readonly string[], profileId?: string) {
      const pid = normProfile(profileId);
      const keys = [...new Set(itemKeys)].slice(0, MAX_PROGRESS_KEYS);
      return keys.flatMap((k) => {
        const row = progress.get(pKey(pid, k));
        return row ? [{ ...row }] : [];
      });
    },
    clearProgress: async (itemKey: string, profileId?: string) => {
      progress.delete(pKey(normProfile(profileId), itemKey));
      return ok(undefined);
    },
    async toggleFavorite(input: ToggleFavoriteInput) {
      const profileId = normProfile(input.profileId);
      const key = pKey(profileId, input.itemKey);
      if (favorites.has(key)) {
        favorites.delete(key);
        return ok(false);
      }
      favorites.set(key, {
        profileId,
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        logo: input.logo ?? null,
        year: input.year ?? null,
        rating: input.rating ?? null,
        addedAt: nextTick(),
      });
      return ok(true);
    },
    async listFavorites(limit?: number, profileId?: string) {
      const pid = normProfile(profileId);
      const max = clampLimit(limit, 50);
      if (max === 0) return [];
      return [...favorites.values()]
        .filter((f) => f.profileId === pid)
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, max)
        .map((f) => ({ ...f }));
    },
    listFavoriteKeys: async (profileId?: string) =>
      [...favorites.values()]
        .filter((f) => f.profileId === normProfile(profileId))
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((f) => f.itemKey),
    close: async () => undefined,
  };
}
