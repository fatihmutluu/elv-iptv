import {
  type AddSourceInput,
  type BrowseKind,
  type CatalogService,
  DEFAULT_PROFILE_ID,
  DEFAULT_SEARCH_LIMIT,
  foldText,
  type ItemDetailRow,
  type ItemRow,
  isCompletedProgress,
  type LinkSourceInput,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TOKENS,
  MIN_RESUME_POSITION_MS,
  type SaveProgressInput,
  type SearchOptions,
  type SearchResults,
  type SourceRow,
  type ToggleFavoriteInput,
  type WatchProgressRow,
} from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import {
  DEMO_SOURCE_ID,
  makeWorkbenchEpisodes,
  WORKBENCH_CATEGORIES,
  WORKBENCH_ITEMS_BY_CATEGORY,
  WORKBENCH_ITEMS_BY_KEY,
  WORKBENCH_PLOTS,
  WORKBENCH_SEED_FAVORITES,
  WORKBENCH_SEED_PROGRESS,
} from './mock-catalog-data.ts';
import {
  buildWorkbenchEpgWindow,
  buildWorkbenchNowNext,
  findWorkbenchChannelByNumber,
} from './mock-catalog-epg.ts';

const MAX_LIST_LIMIT = 100;
const MAX_PROGRESS_KEYS = 200;

const pKey = (profileId: string, itemKey: string): string => `${profileId}\0${itemKey}`;
const normProfile = (profileId?: string): string => {
  const t = profileId?.trim();
  return t && t.length > 0 ? t : DEFAULT_PROFILE_ID;
};
const clampLimit = (limit: number | undefined, fallback: number, max = MAX_LIST_LIMIT): number => {
  const n = limit === undefined || !Number.isFinite(limit) ? fallback : Math.floor(limit);
  return Math.min(max, Math.max(0, n));
};

const WORKBENCH_SEARCH_INDEX: readonly {
  readonly row: ItemRow;
  readonly words: readonly string[];
}[] = [...WORKBENCH_ITEMS_BY_KEY.values()].map((row) => ({
  row,
  words: foldText(row.name).split(/\s+/).filter(Boolean),
}));

function matchesTokens(words: readonly string[], tokens: readonly string[]): boolean {
  return tokens.every((tok) => words.some((w) => w.startsWith(tok)));
}

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
      lastCatalogSyncAt: 1_700_000_100_000,
      lastGuideSyncAt: 1_700_000_200_000,
    },
  ];
  const progress = new Map(
    WORKBENCH_SEED_PROGRESS.map((r) => [pKey(r.profileId, r.itemKey), { ...r }]),
  );
  const favorites = new Map(
    WORKBENCH_SEED_FAVORITES.map((r) => [pKey(r.profileId, r.itemKey), { ...r }]),
  );
  const recentChannels = new Map<
    string,
    { profileId: string; sourceId: string; itemKey: string; watchedAt: number }
  >([
    [
      pKey(DEFAULT_PROFILE_ID, 'wb:live:101'),
      {
        profileId: DEFAULT_PROFILE_ID,
        sourceId: DEMO_SOURCE_ID,
        itemKey: 'wb:live:101',
        watchedAt: 1_700_000_290_000,
      },
    ],
    [
      pKey(DEFAULT_PROFILE_ID, 'wb:live:201'),
      {
        profileId: DEFAULT_PROFILE_ID,
        sourceId: DEMO_SOURCE_ID,
        itemKey: 'wb:live:201',
        watchedAt: 1_700_000_280_000,
      },
    ],
    [
      pKey(DEFAULT_PROFILE_ID, 'wb:live:301'),
      {
        profileId: DEFAULT_PROFILE_ID,
        sourceId: DEMO_SOURCE_ID,
        itemKey: 'wb:live:301',
        watchedAt: 1_700_000_270_000,
      },
    ],
  ]);

  return {
    async addSource(input: AddSourceInput) {
      const row: SourceRow = {
        id: `wb-src-${nextId++}`,
        kind: input.kind,
        name: input.name?.trim() || `Synthetic ${input.kind.toUpperCase()}`,
        createdAt: Date.now(),
        needsImport: true,
        lastCatalogSyncAt: null,
        lastGuideSyncAt: null,
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
        lastCatalogSyncAt: null,
        lastGuideSyncAt: null,
      };
      sources.push(row);
      return ok(row);
    },
    async removeSource(id: string) {
      const idx = sources.findIndex((s) => s.id === id);
      if (idx >= 0) sources.splice(idx, 1);
      for (const [k, row] of progress) if (row.sourceId === id) progress.delete(k);
      for (const [k, row] of favorites) if (row.sourceId === id) favorites.delete(k);
      for (const [k, row] of recentChannels) if (row.sourceId === id) recentChannels.delete(k);
      return ok(undefined);
    },
    async importSource(id: string) {
      const src = sources.find((s) => s.id === id);
      if (!src) return err(elvError('storage', 'not-found', `Unknown source ${id}`));
      src.needsImport = false;
      src.lastCatalogSyncAt = Date.now();
      return ok({
        runId: nextId++,
        counts: {
          categories: WORKBENCH_CATEGORIES.length,
          live: 10,
          movies: 7,
          series: 3,
          episodes: 18,
        },
        warnings: 0,
        warningCodes: [],
        durationMs: 12,
      });
    },
    async importGuide(sourceId: string) {
      const src = sources.find((s) => s.id === sourceId);
      if (!src) return err(elvError('storage', 'source-not-found', `Unknown source ${sourceId}`));
      src.lastGuideSyncAt = Date.now();
      return ok({
        runId: nextId++,
        counts: { guideChannels: 10, programmes: 240 },
        warnings: 0,
        warningCodes: [],
        durationMs: 8,
      });
    },
    listSources: async () => sources.map((s) => ({ ...s })),
    async categories(sourceId: string, kind: BrowseKind) {
      if (!sources.some((s) => s.id === sourceId && !s.needsImport)) return [];
      return WORKBENCH_CATEGORIES.filter((c) => c.kind === kind).map((c) => ({
        ...c,
        sourceId,
        id: c.id.replace(DEMO_SOURCE_ID, sourceId),
      }));
    },
    async items(categoryId: string, offset: number, limit: number) {
      const [sourceId = DEMO_SOURCE_ID, ...rest] = categoryId.split('|');
      const all = WORKBENCH_ITEMS_BY_CATEGORY[`${DEMO_SOURCE_ID}|${rest.join('|')}`] ?? [];
      const start = Math.max(0, offset);
      return all.slice(start, start + Math.max(0, limit)).map((i) => ({ ...i, sourceId }));
    },
    async itemDetail(itemKey: string): Promise<ItemDetailRow | null> {
      const found = WORKBENCH_ITEMS_BY_KEY.get(itemKey);
      return found ? { ...found, plot: WORKBENCH_PLOTS[itemKey] ?? null } : null;
    },
    async search(query: string, opts?: SearchOptions): Promise<SearchResults> {
      const limit = clampLimit(opts?.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const tokens = foldText(query).split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
      if (limit === 0 || tokens.length === 0) return { live: [], movies: [], series: [] };
      const scope = opts?.scope ?? 'all';
      const activeSources = sources.filter(
        (s) => !s.needsImport && (opts?.sourceId === undefined || s.id === opts.sourceId),
      );
      if (activeSources.length === 0) return { live: [], movies: [], series: [] };
      const sourceId = activeSources[0]?.id ?? DEMO_SOURCE_ID;
      const collect = (kind: BrowseKind): ItemRow[] => {
        if (scope !== 'all' && scope !== kind) return [];
        const out: ItemRow[] = [];
        for (const entry of WORKBENCH_SEARCH_INDEX) {
          if (entry.row.kind === kind && matchesTokens(entry.words, tokens)) {
            out.push({ ...entry.row, sourceId });
            if (out.length >= limit) break;
          }
        }
        return out;
      };
      return { live: collect('live'), movies: collect('movie'), series: collect('series') };
    },
    async nowNext(channelKeys: readonly string[], nowMs: number) {
      const activeSource = sources.find((s) => !s.needsImport);
      if (!activeSource) return [];
      return buildWorkbenchNowNext(channelKeys, nowMs, activeSource.id);
    },
    async epgWindow(channelKeys: readonly string[], fromMs: number, toMs: number) {
      const activeSource = sources.find((s) => !s.needsImport);
      if (!activeSource) return {};
      return buildWorkbenchEpgWindow(channelKeys, fromMs, toMs, activeSource.id);
    },
    async channelByNumber(num: number, sourceId?: string) {
      const activeSource = sources.find(
        (s) => !s.needsImport && (sourceId === undefined || s.id === sourceId),
      );
      if (!activeSource) return null;
      return findWorkbenchChannelByNumber(num, activeSource.id);
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
    episodes: async (seriesId: number, season: number) => makeWorkbenchEpisodes(seriesId, season),
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
    async recordRecentChannel(itemKey: string, sourceId: string, profileId?: string) {
      const pid = normProfile(profileId);
      const trimmed = itemKey.trim();
      if (trimmed.length === 0) return;
      recentChannels.set(pKey(pid, trimmed), {
        profileId: pid,
        sourceId,
        itemKey: trimmed,
        watchedAt: nextTick(),
      });
    },
    async listRecentChannels(limit?: number, profileId?: string) {
      const pid = normProfile(profileId);
      const max = clampLimit(limit, 20, 50);
      if (max === 0) return [];
      const activeIds = new Set(sources.filter((s) => !s.needsImport).map((s) => s.id));
      const out: ItemRow[] = [];
      const ordered = [...recentChannels.values()]
        .filter((r) => r.profileId === pid && activeIds.has(r.sourceId))
        .sort((a, b) => b.watchedAt - a.watchedAt || (a.itemKey < b.itemKey ? -1 : 1));
      for (const entry of ordered) {
        const item = WORKBENCH_ITEMS_BY_KEY.get(entry.itemKey);
        if (item && item.kind === 'live') {
          out.push({ ...item, sourceId: entry.sourceId });
          if (out.length >= max) break;
        }
      }
      return out;
    },
    close: async () => undefined,
  };
}
