import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import type {
  StalkerCategory,
  StalkerChannel,
  StalkerClient,
  StalkerEpisode,
  StalkerPage,
  StalkerProfile,
  StalkerSeriesItem,
  StalkerVodItem,
} from '@elv/sources';
import { allowlistForKind, reconcileCategorySelection } from './category-selection';
import { hashLiveRow, hashMovieRow, hashSeriesRow } from './content-hash';
import { foldText, sortTitleKey } from './fold';
import { createMonotonicProgressMeter, wrapCleanupProgress } from './import-progress';
import { checkAbort, notify, performRun, type RunCtx, Stop, unwrap } from './import-run';
import {
  DEFAULT_BATCH_SIZE,
  type ImportDeps,
  type ImportOptions,
  type ImportSummary,
} from './import-types';
import { parseLiveVariant } from './live-variants';
import { isPlaceholderLiveChannel } from './placeholder-filter';
import type { BrowseKind } from './queries';
import { sourceExists } from './runs';
import {
  getSource,
  normalizeMaxConnections,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  updateSourceSettings,
} from './sources';
import {
  loadStalkerCmdMap,
  mergeStalkerCmdMap,
  openStalkerClient,
  type StalkerCmdMap,
  safeStalkerProviderId,
  sanitizeStalkerImageUrl,
  saveStalkerCmdMap,
  stalkerCmdKey,
  stalkerKey,
  stalkerPortalHost,
} from './stalker-secret';
import { parseVodVersion } from './vod-versions';
import { writeCategories, writePlacements } from './writers';

const UNCATEGORIZED = 'Uncategorized';
const MAX_STALKER_PAGES = 500;

const LIVE_SQL = `INSERT INTO live_next (source_id, key, provider_id, num, name, name_fold, sort_title, variant_base_fold, quality_rank, logo, guide_id, catchup_days, catchup_mode, url_template, run_id, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, num = excluded.num,
    name = excluded.name, name_fold = excluded.name_fold, sort_title = excluded.sort_title,
    variant_base_fold = excluded.variant_base_fold, quality_rank = excluded.quality_rank, logo = excluded.logo,
    guide_id = excluded.guide_id, catchup_days = excluded.catchup_days, catchup_mode = excluded.catchup_mode,
    url_template = NULL, run_id = excluded.run_id, content_hash = excluded.content_hash`;

const MOVIE_SQL = `INSERT INTO movies_next (source_id, key, provider_id, name, name_fold, sort_title, version_group_key, version_label, logo, rating, year, extension, added, cast_text, director_text, cast_fold, director_fold, url_template, run_id, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
    name_fold = excluded.name_fold, sort_title = excluded.sort_title,
    version_group_key = excluded.version_group_key, version_label = excluded.version_label,
    logo = excluded.logo, rating = excluded.rating, year = excluded.year,
    extension = NULL, added = excluded.added,
    cast_text = excluded.cast_text, director_text = excluded.director_text,
    cast_fold = excluded.cast_fold, director_fold = excluded.director_fold,
    url_template = NULL, run_id = excluded.run_id, content_hash = excluded.content_hash`;

const SERIES_SQL = `INSERT INTO series_next (source_id, key, provider_id, name, name_fold, sort_title, cover, plot, rating, year, last_modified, cast_text, director_text, cast_fold, director_fold, run_id, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, name = excluded.name,
    name_fold = excluded.name_fold, sort_title = excluded.sort_title, cover = excluded.cover, plot = excluded.plot,
    rating = excluded.rating, year = excluded.year, last_modified = excluded.last_modified,
    cast_text = excluded.cast_text, director_text = excluded.director_text,
    cast_fold = excluded.cast_fold, director_fold = excluded.director_fold,
    run_id = excluded.run_id, content_hash = excluded.content_hash`;

const EPISODE_SQL = `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, extension, duration_sec, url_template, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, series_key = excluded.series_key,
    season = excluded.season, episode = excluded.episode, title = excluded.title, title_fold = excluded.title_fold,
    extension = NULL, duration_sec = excluded.duration_sec, url_template = NULL, run_id = excluded.run_id`;

function filterRealCategories(cats: readonly StalkerCategory[]): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const c of cats) {
    const id = c.id.trim();
    if (id === '' || id === '*' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: c.title.trim() || id });
  }
  return out;
}

async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<Result<StalkerPage<T>>>,
  signal: AbortSignal | undefined,
  onBatch?: (items: readonly T[]) => Promise<void>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= MAX_STALKER_PAGES) {
    checkAbort({ signal });
    const res = unwrap(await fetchPage(page));
    if (res.items.length === 0) break;
    all.push(...res.items);
    if (onBatch !== undefined) await onBatch(res.items);
    const perPage = Math.max(1, res.maxPageItems > 0 ? res.maxPageItems : res.items.length);
    totalPages = Math.max(1, Math.ceil(res.totalItems / perPage));
    if (res.totalItems <= all.length) break;
    page += 1;
  }
  return all;
}

async function fetchLiveChannels(
  client: StalkerClient,
  signal: AbortSignal | undefined,
): Promise<StalkerChannel[]> {
  const call = signal === undefined ? undefined : { signal };
  const allRes = await client.allLiveChannels(call);
  if (allRes.ok) return allRes.value;
  if (allRes.error.code === 'aborted' || allRes.error.category === 'auth') {
    throw new Stop(allRes.error);
  }
  return fetchAllPages(
    (page) => client.liveChannels({ page, ...(signal === undefined ? {} : { signal }) }),
    signal,
  );
}

async function flushBatches(
  db: SqlDriver,
  sql: string,
  rows: SqlValue[][],
  batchSize: number,
  c: RunCtx,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    checkAbort(c);
    await db.batch(sql, rows.slice(i, i + batchSize));
    await c.deps.scheduler.yieldNow();
  }
}

/**
 * Atomically imports live channels, VOD movies, and series from a Stalker/Ministra MAC portal into
 * the staged `*_next` catalog tables and swaps them inside `performRun` (`#29`, ADR 0015).
 * Zero portal URLs, MACs, tokens, or raw `cmd` strings enter SQLite.
 */
export async function importStalker(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions = {},
): Promise<Result<ImportSummary>> {
  const opened = await openStalkerClient(source, deps);
  if (!opened.ok) return opened;
  const { client, secret } = opened.value;
  const portalHost = stalkerPortalHost(secret.portalUrl);
  const meter = createMonotonicProgressMeter();
  const stagedCmds: StalkerCmdMap = {};
  let profile: StalkerProfile | undefined;
  let discoveredIds: Record<BrowseKind, string[]> = { live: [], movie: [], series: [] };
  let previousCmdsRaw: string | undefined;
  let wroteCmds = false;

  const includePlaceholders = source.settings.includePlaceholderChannels === true;
  const selection = source.settings.categorySelection;

  return performRun(source, deps, wrapCleanupProgress(opts, meter, notify), {
    execute: async (c) => {
      const call = c.signal === undefined ? undefined : { signal: c.signal };
      unwrap(await client.handshake(call));
      const profileRes = await client.profile(call);
      if (profileRes.ok) {
        profile = profileRes.value;
        const normalizedStatus = profile.status.trim().toLowerCase();
        if (
          (profile.expiresAt !== undefined && profile.expiresAt <= c.deps.clock()) ||
          normalizedStatus === 'expired'
        ) {
          throw new Stop(elvError('auth', 'account-expired'));
        }
        if (
          profile.blocked ||
          normalizedStatus === 'blocked' ||
          normalizedStatus === 'banned' ||
          normalizedStatus === 'disabled'
        ) {
          throw new Stop(elvError('auth', 'account-disabled'));
        }
      } else if (profileRes.error.code === 'aborted' || profileRes.error.category === 'auth') {
        throw new Stop(profileRes.error);
      }

      const [rawGenres, rawVodCats, rawSeriesCats] = await Promise.all([
        client.genres(call).then(unwrap),
        client.vodCategories(call).then((r) => (r.ok ? r.value : [])),
        client.seriesCategories(call).then((r) => (r.ok ? r.value : [])),
      ]);
      const rawCats: Record<BrowseKind, { id: string; name: string }[]> = {
        live: filterRealCategories(rawGenres),
        movie: filterRealCategories(rawVodCats),
        series: filterRealCategories(rawSeriesCats),
      };
      discoveredIds = {
        live: rawCats.live.map((x) => x.id),
        movie: rawCats.movie.map((x) => x.id),
        series: rawCats.series.map((x) => x.id),
      };
      const allowlists: Record<BrowseKind, ReadonlySet<string> | undefined> = {
        live: allowlistForKind(selection, 'live'),
        movie: allowlistForKind(selection, 'movie'),
        series: allowlistForKind(selection, 'series'),
      };
      const filteredCats: Record<BrowseKind, { id: string; name: string }[]> = {
        live:
          allowlists.live === undefined
            ? rawCats.live
            : rawCats.live.filter((x) => allowlists.live?.has(x.id)),
        movie:
          allowlists.movie === undefined
            ? rawCats.movie
            : rawCats.movie.filter((x) => allowlists.movie?.has(x.id)),
        series:
          allowlists.series === undefined
            ? rawCats.series
            : rawCats.series.filter((x) => allowlists.series?.has(x.id)),
      };
      for (const kind of ['live', 'movie', 'series'] as const) {
        if (allowlists[kind] !== undefined && allowlists[kind].size === 0) {
          c.intentionallyEmptyKinds.add(kind);
        }
      }

      const totalCats =
        filteredCats.live.length + filteredCats.movie.length + filteredCats.series.length;
      let doneCats = 0;
      for (const kind of ['live', 'movie', 'series'] as const) {
        const list = filteredCats[kind];
        for (let i = 0; i < list.length; i += c.batchSize) {
          checkAbort(c);
          const slice = list.slice(i, i + c.batchSize);
          await writeCategories(c.db, c.sourceId, kind, c.runId, slice, i);
          doneCats += slice.length;
          c.progress(meter.report('categories', doneCats, totalCats));
          await c.deps.scheduler.yieldNow();
        }
      }
      meter.markComplete('categories');
      c.counts.categories = totalCats;

      // 1. Live channels
      if (allowlists.live === undefined || allowlists.live.size > 0) {
        const channels = await fetchLiveChannels(client, c.signal);
        const liveRows: SqlValue[][] = [];
        const liveLinks: [string, string, number][] = [];
        const posByCat = new Map<string, number>();
        const seenKeys = new Set<string>();
        let needUncat = false;
        let skipped = 0;

        for (const ch of channels) {
          if (!includePlaceholders && isPlaceholderLiveChannel({ name: ch.name })) {
            skipped += 1;
            continue;
          }
          const catId = ch.genreId && ch.genreId !== '*' ? ch.genreId : UNCATEGORIZED;
          if (allowlists.live !== undefined && !allowlists.live.has(catId)) continue;
          const providerId = safeStalkerProviderId(ch.id);
          const key = stalkerKey(c.sourceId, 'live', providerId);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          if (catId === UNCATEGORIZED) needUncat = true;
          if (ch.cmd.trim() !== '') stagedCmds[stalkerCmdKey('live', providerId)] = ch.cmd.trim();

          const nameFold = foldText(ch.name);
          const sortTitle = sortTitleKey(ch.name);
          const variant = parseLiveVariant(ch.name);
          const logo = sanitizeStalkerImageUrl(ch.logo, portalHost, secret.mac);
          const catchupDays = Math.max(0, Math.floor(ch.catchupDays));
          const catchupMode = catchupDays > 0 ? 'stalker' : null;
          const contentHash = hashLiveRow({
            providerId,
            num: ch.number,
            name: ch.name,
            nameFold,
            logo,
            guideId: ch.epgId,
            catchupDays,
            catchupMode,
          });
          liveRows.push([
            c.sourceId,
            key,
            providerId,
            ch.number ?? null,
            ch.name,
            nameFold,
            sortTitle,
            variant.baseFold,
            variant.qualityRank,
            logo ?? null,
            ch.epgId ?? null,
            catchupDays,
            catchupMode,
            c.runId,
            contentHash,
          ]);
          const pos = posByCat.get(catId) ?? 0;
          posByCat.set(catId, pos + 1);
          liveLinks.push([key, catId, pos]);
        }

        if (needUncat) {
          await writeCategories(
            c.db,
            c.sourceId,
            'live',
            c.runId,
            [{ id: UNCATEGORIZED, name: UNCATEGORIZED }],
            filteredCats.live.length,
          );
          c.counts.categories = (c.counts.categories ?? 0) + 1;
        }
        await flushBatches(c.db, LIVE_SQL, liveRows, c.batchSize, c);
        for (let i = 0; i < liveLinks.length; i += c.batchSize) {
          await writePlacements(
            c.db,
            c.sourceId,
            'live',
            c.runId,
            liveLinks.slice(i, i + c.batchSize),
          );
          await c.deps.scheduler.yieldNow();
        }
        c.counts.live = liveRows.length;
        c.counts.placements = (c.counts.placements ?? 0) + liveLinks.length;
        if (skipped > 0) c.counts.skippedPlaceholders = skipped;
        if (liveRows.length > 0) c.progress(meter.complete('live', liveRows.length));
        else meter.markComplete('live');
      } else {
        c.counts.live = 0;
        meter.markComplete('live');
      }

      // 2. VOD movies
      if (allowlists.movie === undefined || allowlists.movie.size > 0) {
        const vodItems: StalkerVodItem[] = await fetchAllPages(
          (page) =>
            client.vodItems({
              page,
              ...(c.signal === undefined ? {} : { signal: c.signal }),
            }),
          c.signal,
        );
        const movieRows: SqlValue[][] = [];
        const movieLinks: [string, string, number][] = [];
        const posByCat = new Map<string, number>();
        const seenKeys = new Set<string>();
        let needUncat = false;

        for (const vod of vodItems) {
          if (vod.isSeries === true) continue;
          const catId = vod.categoryId && vod.categoryId !== '*' ? vod.categoryId : UNCATEGORIZED;
          if (allowlists.movie !== undefined && !allowlists.movie.has(catId)) continue;
          const providerId = safeStalkerProviderId(vod.id);
          const key = stalkerKey(c.sourceId, 'movie', providerId);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          if (catId === UNCATEGORIZED) needUncat = true;
          if (vod.cmd.trim() !== '') {
            stagedCmds[stalkerCmdKey('movie', providerId)] = vod.cmd.trim();
          }

          const nameFold = foldText(vod.name);
          const sortTitle = sortTitleKey(vod.name);
          const version = parseVodVersion(vod.name, vod.year);
          const versionLabel = version.versionLabel.length > 0 ? version.versionLabel : null;
          const logo = sanitizeStalkerImageUrl(vod.cover, portalHost, secret.mac);
          const castFold = vod.cast !== undefined ? foldText(vod.cast) : null;
          const directorFold = vod.director !== undefined ? foldText(vod.director) : null;
          const contentHash = hashMovieRow({
            providerId,
            name: vod.name,
            nameFold,
            logo,
            rating: vod.rating,
            year: vod.year,
            added: vod.addedAt,
            castText: vod.cast,
            directorText: vod.director,
          });
          movieRows.push([
            c.sourceId,
            key,
            providerId,
            vod.name,
            nameFold,
            sortTitle,
            version.groupKey,
            versionLabel,
            logo ?? null,
            vod.rating ?? null,
            vod.year ?? null,
            vod.addedAt ?? null,
            vod.cast ?? null,
            vod.director ?? null,
            castFold,
            directorFold,
            c.runId,
            contentHash,
          ]);
          const pos = posByCat.get(catId) ?? 0;
          posByCat.set(catId, pos + 1);
          movieLinks.push([key, catId, pos]);
        }

        if (needUncat) {
          await writeCategories(
            c.db,
            c.sourceId,
            'movie',
            c.runId,
            [{ id: UNCATEGORIZED, name: UNCATEGORIZED }],
            filteredCats.movie.length,
          );
          c.counts.categories = (c.counts.categories ?? 0) + 1;
        }
        await flushBatches(c.db, MOVIE_SQL, movieRows, c.batchSize, c);
        for (let i = 0; i < movieLinks.length; i += c.batchSize) {
          await writePlacements(
            c.db,
            c.sourceId,
            'movie',
            c.runId,
            movieLinks.slice(i, i + c.batchSize),
          );
          await c.deps.scheduler.yieldNow();
        }
        c.counts.movies = movieRows.length;
        c.counts.placements = (c.counts.placements ?? 0) + movieLinks.length;
        if (movieRows.length > 0) c.progress(meter.complete('movies', movieRows.length));
        else meter.markComplete('movies');
      } else {
        c.counts.movies = 0;
        meter.markComplete('movies');
      }

      // 3. Series
      if (allowlists.series === undefined || allowlists.series.size > 0) {
        const seriesItems: StalkerSeriesItem[] = await fetchAllPages(
          (page) =>
            client.seriesItems({
              page,
              ...(c.signal === undefined ? {} : { signal: c.signal }),
            }),
          c.signal,
        );
        const seriesRows: SqlValue[][] = [];
        const seriesLinks: [string, string, number][] = [];
        const posByCat = new Map<string, number>();
        const seenKeys = new Set<string>();
        let needUncat = false;

        for (const s of seriesItems) {
          const catId = s.categoryId && s.categoryId !== '*' ? s.categoryId : UNCATEGORIZED;
          if (allowlists.series !== undefined && !allowlists.series.has(catId)) continue;
          const providerId = safeStalkerProviderId(s.id);
          const key = stalkerKey(c.sourceId, 'series', providerId);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          if (catId === UNCATEGORIZED) needUncat = true;

          const nameFold = foldText(s.name);
          const sortTitle = sortTitleKey(s.name);
          const cover = sanitizeStalkerImageUrl(s.cover, portalHost, secret.mac);
          const castFold = s.cast !== undefined ? foldText(s.cast) : null;
          const directorFold = s.director !== undefined ? foldText(s.director) : null;
          const contentHash = hashSeriesRow({
            providerId,
            name: s.name,
            nameFold,
            cover,
            plot: s.plot,
            rating: s.rating,
            year: s.year,
            lastModified: s.addedAt,
            castText: s.cast,
            directorText: s.director,
          });
          seriesRows.push([
            c.sourceId,
            key,
            providerId,
            s.name,
            nameFold,
            sortTitle,
            cover ?? null,
            s.plot ?? null,
            s.rating ?? null,
            s.year ?? null,
            s.addedAt ?? null,
            s.cast ?? null,
            s.director ?? null,
            castFold,
            directorFold,
            c.runId,
            contentHash,
          ]);
          const pos = posByCat.get(catId) ?? 0;
          posByCat.set(catId, pos + 1);
          seriesLinks.push([key, catId, pos]);
        }

        if (needUncat) {
          await writeCategories(
            c.db,
            c.sourceId,
            'series',
            c.runId,
            [{ id: UNCATEGORIZED, name: UNCATEGORIZED }],
            filteredCats.series.length,
          );
          c.counts.categories = (c.counts.categories ?? 0) + 1;
        }
        await flushBatches(c.db, SERIES_SQL, seriesRows, c.batchSize, c);
        for (let i = 0; i < seriesLinks.length; i += c.batchSize) {
          await writePlacements(
            c.db,
            c.sourceId,
            'series',
            c.runId,
            seriesLinks.slice(i, i + c.batchSize),
          );
          await c.deps.scheduler.yieldNow();
        }
        c.counts.series = seriesRows.length;
        c.counts.placements = (c.counts.placements ?? 0) + seriesLinks.length;
        if (seriesRows.length > 0) c.progress(meter.complete('series', seriesRows.length));
        else meter.markComplete('series');
      } else {
        c.counts.series = 0;
        meter.markComplete('series');
      }
    },

    beforeCommit: async () => {
      previousCmdsRaw = await deps.secrets
        .get(secretKey(source.id, 'stalker_cmds'))
        .catch(() => undefined);
      const existing = await loadStalkerCmdMap(deps.secrets, source.id);
      const merged: StalkerCmdMap = {};
      for (const [k, v] of Object.entries(existing)) {
        if (k.startsWith('series:')) merged[k] = v;
      }
      Object.assign(merged, stagedCmds);
      unwrap(await saveStalkerCmdMap(deps.secrets, source.id, merged));
      wroteCmds = true;
    },

    beforeCleanup: async (tx) => {
      const current = (await getSource(tx, source.id))?.settings ?? source.settings;
      const settings: SourceSettings = { ...current };
      if (profile !== undefined) {
        settings.accountMeta = {
          ...(profile.expiresAt !== undefined ? { expiresAt: profile.expiresAt } : {}),
          maxConnections: normalizeMaxConnections(profile.maxConnections),
        };
        if (typeof profile.timezone === 'string' && profile.timezone.trim() !== '') {
          settings.serverTimezone = profile.timezone.trim();
        }
      }
      const reconciled = reconcileCategorySelection(current.categorySelection, discoveredIds);
      if (reconciled !== undefined) settings.categorySelection = reconciled;
      await updateSourceSettings(tx, source.id, settings);
    },

    onAbortOrFail: async () => {
      if (!wroteCmds) return;
      if (previousCmdsRaw === undefined) {
        await deps.secrets.delete(secretKey(source.id, 'stalker_cmds')).catch(() => undefined);
      } else {
        await deps.secrets
          .set(secretKey(source.id, 'stalker_cmds'), previousCmdsRaw)
          .catch(() => undefined);
      }
    },
  });
}

/** Lazily loads seasons and episodes for one Stalker series into SQLite (cmds stay strictly in `SecretStore`). */
export async function loadStalkerSeriesEpisodes(
  source: SourceRecord,
  seriesKey: string,
  deps: ImportDeps,
  opts: ImportOptions = {},
): Promise<Result<number>> {
  const opened = await openStalkerClient(source, deps);
  if (!opened.ok) return opened;
  const { client } = opened.value;

  try {
    const query = 'SELECT provider_id, run_id FROM series WHERE source_id = ? AND key = ?';
    const lookup = (db: ImportDeps['db']) =>
      db.all<{ provider_id: string | null; run_id: number }>(query, [source.id, seriesKey]);
    const row = (await lookup(deps.db))[0];
    if (row?.provider_id == null) return err(elvError('source-format', 'unknown-series'));

    const call = opts.signal === undefined ? undefined : { signal: opts.signal };
    checkAbort({ signal: opts.signal });
    unwrap(await client.handshake(call));
    const seasons = unwrap(await client.seriesSeasons(row.provider_id, call));

    const episodeEntries: {
      key: string;
      providerId: string;
      season: number;
      ep: StalkerEpisode;
    }[] = [];
    const epCmds: StalkerCmdMap = {};
    for (const season of seasons) {
      checkAbort({ signal: opts.signal });
      const episodes = await fetchAllPages(
        (page) => client.seasonEpisodes(row.provider_id as string, season.id, page, call),
        opts.signal,
      );
      for (const ep of episodes) {
        const providerId = safeStalkerProviderId(ep.id);
        const key = stalkerKey(source.id, 'episode', providerId);
        const cmd = ep.cmd.trim() || season.cmd?.trim() || '';
        if (cmd !== '') epCmds[stalkerCmdKey('series', providerId)] = cmd;
        episodeEntries.push({ key, providerId, season: season.seasonNumber, ep });
      }
      await deps.scheduler.yieldNow();
    }

    unwrap(await mergeStalkerCmdMap(deps.secrets, source.id, epCmds));

    const stored = await deps.db.transaction<'ok' | 'no-source' | 'no-series'>(async (tx) => {
      if (!(await sourceExists(tx, source.id))) return 'no-source';
      const current = (await lookup(tx))[0];
      if (current?.provider_id == null) return 'no-series';
      const previous = await tx.all<{ key: string }>(
        'SELECT key FROM episodes WHERE source_id = ? AND series_key = ?',
        [source.id, seriesKey],
      );
      const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
      for (let i = 0; i < episodeEntries.length; i += batchSize) {
        checkAbort({ signal: opts.signal });
        const slice = episodeEntries.slice(i, i + batchSize);
        await tx.batch(
          EPISODE_SQL,
          slice.map(({ key, providerId, season, ep }) => [
            source.id,
            key,
            providerId,
            seriesKey,
            season,
            ep.episodeNumber,
            ep.title,
            foldText(ep.title),
            ep.durationSec ?? null,
            current.run_id,
          ]),
        );
      }
      const keep = new Set(episodeEntries.map((e) => e.key));
      const stale = previous.filter((p) => !keep.has(p.key)).map((p) => [source.id, p.key]);
      for (let i = 0; i < stale.length; i += batchSize) {
        checkAbort({ signal: opts.signal });
        await tx.batch(
          'DELETE FROM episodes WHERE source_id = ? AND key = ?',
          stale.slice(i, i + batchSize),
        );
      }
      return 'ok';
    });

    if (stored === 'no-source') return err(elvError('storage', 'source-not-found'));
    if (stored === 'no-series') return err(elvError('source-format', 'unknown-series'));
    notify(opts, {
      phase: 'episodes',
      done: episodeEntries.length,
      total: episodeEntries.length,
      fraction: 1,
      percent: 100,
    });
    await deps.scheduler.yieldNow();
    return ok(episodeEntries.length);
  } catch (e) {
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}

/** Discovers live genres, VOD categories, and series categories for a Stalker portal without writing to SQLite (`#39`). */
export async function discoverStalkerCategories(
  source: SourceRecord,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<Result<readonly { id: string; name: string; kind: BrowseKind; itemCount: number }[]>> {
  const opened = await openStalkerClient(source, deps);
  if (!opened.ok) return opened;
  const { client } = opened.value;
  const call = signal === undefined ? undefined : { signal };
  try {
    unwrap(await client.handshake(call));
    const [genres, vodCats, seriesCats] = await Promise.all([
      client.genres(call).then(unwrap),
      client.vodCategories(call).then((r) => (r.ok ? r.value : [])),
      client.seriesCategories(call).then((r) => (r.ok ? r.value : [])),
    ]);
    const out: { id: string; name: string; kind: BrowseKind; itemCount: number }[] = [];
    for (const c of filterRealCategories(genres)) {
      out.push({ id: c.id, name: c.name, kind: 'live', itemCount: 0 });
    }
    for (const c of filterRealCategories(vodCats)) {
      out.push({ id: c.id, name: c.name, kind: 'movie', itemCount: 0 });
    }
    for (const c of filterRealCategories(seriesCats)) {
      out.push({ id: c.id, name: c.name, kind: 'series', itemCount: 0 });
    }
    return ok(out);
  } catch (e) {
    if (signal?.aborted) return err(elvError('network', 'aborted'));
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}
