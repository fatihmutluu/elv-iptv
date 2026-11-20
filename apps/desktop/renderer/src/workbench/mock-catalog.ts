import type {
  AddSourceInput,
  BrowseKind,
  CatalogService,
  CategoryRow,
  EpisodeRow,
  ItemRow,
  LinkSourceInput,
  SeasonRow,
  SourceRow,
  StreamRequest,
} from '@elv/data';
import { elvError, err, ok } from '@elv/domain';

const DEMO_SOURCE_ID = 'workbench-demo';

function cat(
  kind: BrowseKind,
  slug: string,
  name: string,
  position: number,
  itemCount: number,
): CategoryRow {
  return {
    id: `${DEMO_SOURCE_ID}|${kind}|${slug}`,
    sourceId: DEMO_SOURCE_ID,
    kind,
    name,
    position,
    itemCount,
  };
}

function item(
  id: number,
  kind: BrowseKind,
  name: string,
  extra: { num?: number; year?: number; rating?: number } = {},
): ItemRow {
  return {
    id,
    key: `wb:${kind}:${id}`,
    kind,
    sourceId: DEMO_SOURCE_ID,
    providerId: String(id),
    name,
    logo: null,
    rating: extra.rating ?? null,
    year: extra.year ?? null,
    num: extra.num ?? null,
  };
}

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
    item(101, 'live', 'Cinema One 4K', { num: 101 }),
    item(102, 'live', 'Classic Reels HD', { num: 102 }),
    item(103, 'live', 'Midnight Noir TV', { num: 103 }),
    item(104, 'live', 'Premiere Stage', { num: 104 }),
  ],
  [`${DEMO_SOURCE_ID}|live|sports`]: [
    item(201, 'live', 'Arena Sports 1 UHD', { num: 201 }),
    item(202, 'live', 'Track & Motorsport', { num: 202 }),
    item(203, 'live', 'Court Center Live', { num: 203 }),
  ],
  [`${DEMO_SOURCE_ID}|live|news`]: [
    item(301, 'live', 'Global Desk 24', { num: 301 }),
    item(302, 'live', 'Meridian Business', { num: 302 }),
    item(303, 'live', 'Weather Pulse', { num: 303 }),
  ],
  [`${DEMO_SOURCE_ID}|movie|scifi`]: [
    item(401, 'movie', 'Silent Horizon', { year: 2026, rating: 8.6 }),
    item(402, 'movie', 'Orbital Nine', { year: 2025, rating: 8.2 }),
    item(403, 'movie', 'Glass Meridian', { year: 2024, rating: 7.9 }),
    item(404, 'movie', 'Echoes of Titan', { year: 2026, rating: 8.4 }),
  ],
  [`${DEMO_SOURCE_ID}|movie|drama`]: [
    item(501, 'movie', 'Harbor Lights', { year: 2025, rating: 8.1 }),
    item(502, 'movie', 'Winter Telegraph', { year: 2023, rating: 7.8 }),
    item(503, 'movie', 'Paper Lanterns', { year: 2026, rating: 8.5 }),
  ],
  [`${DEMO_SOURCE_ID}|series|originals`]: [
    item(601, 'series', 'Northern Signal', { year: 2026, rating: 8.8 }),
    item(602, 'series', 'Watchmaker Alley', { year: 2025, rating: 8.3 }),
    item(603, 'series', 'Blue Station', { year: 2024, rating: 8.0 }),
  ],
};

function makeEpisodes(seriesId: number, season: number): EpisodeRow[] {
  const titles = ['Opening Signal', 'Night Crossing', 'Static Line'];
  return titles.map((title, idx) => ({
    id: seriesId * 100 + season * 10 + idx + 1,
    key: `wb:ep:${seriesId}:s${season}e${idx + 1}`,
    season,
    episode: idx + 1,
    title,
    durationSec: 2880 + idx * 120,
  }));
}

/**
 * In-memory synthetic {@link CatalogService} powering the browser UI Workbench (`pnpm dev:ui`)
 * with zero network calls, zero credentials, and zero third-party names.
 */
export function createWorkbenchCatalog(): CatalogService {
  let nextId = 1;
  const sources: SourceRow[] = [
    {
      id: DEMO_SOURCE_ID,
      kind: 'xtream',
      name: 'Studio Demo Catalog',
      createdAt: 1_700_000_000_000,
      needsImport: false,
    },
  ];

  const makeStream = (itemKey: string): StreamRequest => ({
    url: `http://127.0.0.1:7878/workbench/${encodeURIComponent(itemKey)}`,
    headers: {},
  });

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
    async listSources() {
      return sources.map((s) => ({ ...s }));
    },
    async categories(sourceId: string, kind: BrowseKind) {
      const src = sources.find((s) => s.id === sourceId && !s.needsImport);
      if (!src) return [];
      return CATEGORIES.filter((c) => c.kind === kind).map((c) => ({
        ...c,
        sourceId,
        id: c.id.replace(DEMO_SOURCE_ID, sourceId),
      }));
    },
    async items(categoryId: string, offset: number, limit: number) {
      const parts = categoryId.split('|');
      const sourceId = parts[0] ?? DEMO_SOURCE_ID;
      const canonicalId = `${DEMO_SOURCE_ID}|${parts.slice(1).join('|')}`;
      const all = ITEMS_BY_CATEGORY[canonicalId] ?? [];
      return all
        .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
        .map((i) => ({ ...i, sourceId }));
    },
    async seasons(seriesId: number) {
      const seasons: SeasonRow[] = [
        { season: 1, episodeCount: 3 },
        { season: 2, episodeCount: 3 },
      ];
      return seriesId >= 601 && seriesId <= 603
        ? ok(seasons)
        : ok([{ season: 1, episodeCount: 3 }]);
    },
    async episodes(seriesId: number, season: number) {
      return makeEpisodes(seriesId, season);
    },
    async resolveStream(itemKey: string) {
      return ok(makeStream(itemKey));
    },
    async close() {
      return undefined;
    },
  };
}
