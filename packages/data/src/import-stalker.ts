import { elvError, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import type {
  StalkerChannel,
  StalkerClient,
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
  discoverStalkerCategories,
  fetchAllStalkerPages,
  filterRealStalkerCategories,
  loadStalkerSeriesEpisodes,
} from './import-stalker-series';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { parseLiveVariant } from './live-variants';
import { isPlaceholderLiveChannel } from './placeholder-filter';
import type { BrowseKind } from './queries';
import {
  getSource,
  normalizeMaxConnections,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  updateSourceSettings,
} from './sources';
import {
  deleteStalkerCmdMap,
  encodeVodSeriesMeta,
  loadStalkerCmdMap,
  openStalkerClient,
  type StalkerCmdMap,
  safeStalkerProviderId,
  sanitizeStalkerImageUrl,
  saveStalkerCmdMap,
  saveStalkerDiscovery,
  stalkerCmdKey,
  stalkerKey,
  stalkerPortalHost,
  stalkerStaticFlagKey,
  stalkerVodSeriesMetaKey,
} from './stalker-secret';
import { parseVodVersion } from './vod-versions';
import { writeCategories, writePlacements } from './writers';

export { discoverStalkerCategories, loadStalkerSeriesEpisodes };

const UNCATEGORIZED = 'Uncategorized';

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
  return fetchAllStalkerPages(
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

function buildSeriesRow(
  c: RunCtx,
  s: {
    id: string;
    name: string;
    cover?: string;
    plot?: string;
    rating?: number;
    year?: number;
    addedAt?: number;
    cast?: string;
    director?: string;
  },
  portalHost: string | undefined,
  mac: string,
): { providerId: string; key: string; row: SqlValue[] } {
  const providerId = safeStalkerProviderId(s.id);
  const key = stalkerKey(c.sourceId, 'series', providerId);
  const nameFold = foldText(s.name);
  const sortTitle = sortTitleKey(s.name);
  const cover = sanitizeStalkerImageUrl(s.cover, portalHost, mac);
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
  return {
    providerId,
    key,
    row: [
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
    ],
  };
}

/**
 * Atomically imports live channels, VOD movies, and series (including Ministra VOD-backed
 * `is_series=1` and embedded `series[]` items) from a Stalker/Ministra MAC portal into the staged
 * `*_next` catalog tables and swaps them inside `performRun` (`#29`, ADR 0015).
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
  let previousCmds: StalkerCmdMap | undefined;
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
        live: filterRealStalkerCategories(rawGenres),
        movie: filterRealStalkerCategories(rawVodCats),
        series: filterRealStalkerCategories(rawSeriesCats),
      };
      const vodCatNameById = new Map<string, string>(rawCats.movie.map((x) => [x.id, x.name]));
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
          if (ch.useHttpTmpLink === false && ch.useLoadBalancing === false) {
            stagedCmds[stalkerStaticFlagKey('live', providerId)] = '1';
          }

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

      // 2. VOD movies (collecting Ministra VOD-backed series instead of discarding them!)
      const vodSeriesItems: StalkerVodItem[] = [];
      const shouldFetchVod =
        allowlists.movie === undefined ||
        allowlists.movie.size > 0 ||
        (rawCats.series.length === 0 &&
          (allowlists.series === undefined || allowlists.series.size > 0));
      if (shouldFetchVod) {
        const vodItems: StalkerVodItem[] = await fetchAllStalkerPages(
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
        const ingestMovies = allowlists.movie === undefined || allowlists.movie.size > 0;

        for (const vod of vodItems) {
          const isVodSeries =
            vod.isSeries === true ||
            (vod.seriesEpisodeNumbers !== undefined && vod.seriesEpisodeNumbers.length > 0);
          if (isVodSeries) {
            vodSeriesItems.push(vod);
            continue;
          }
          if (!ingestMovies) continue;
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
          if (vod.useHttpTmpLink === false && vod.useLoadBalancing === false) {
            stagedCmds[stalkerStaticFlagKey('movie', providerId)] = '1';
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

      // 3. Series (combining type=series AND Ministra VOD-backed series)
      if (allowlists.series === undefined || allowlists.series.size > 0) {
        let seriesItems: StalkerSeriesItem[] = [];
        try {
          seriesItems = await fetchAllStalkerPages(
            (page) =>
              client.seriesItems({
                page,
                ...(c.signal === undefined ? {} : { signal: c.signal }),
              }),
            c.signal,
          );
        } catch (e) {
          const isFatal =
            e instanceof Stop && (e.error.code === 'aborted' || e.error.category === 'auth');
          if (isFatal || (vodSeriesItems.length === 0 && rawCats.series.length > 0)) throw e;
          seriesItems = [];
        }

        const seriesRows: SqlValue[][] = [];
        const seriesLinks: [string, string, number][] = [];
        const posByCat = new Map<string, number>();
        const seenKeys = new Set<string>();
        const writtenSeriesCatIds = new Set(filteredCats.series.map((x) => x.id));
        const extraSeriesCats: { id: string; name: string }[] = [];
        let needUncat = false;

        for (const s of seriesItems) {
          const catId = s.categoryId && s.categoryId !== '*' ? s.categoryId : UNCATEGORIZED;
          if (allowlists.series !== undefined && !allowlists.series.has(catId)) continue;
          const built = buildSeriesRow(c, s, portalHost, secret.mac);
          if (seenKeys.has(built.key)) continue;
          seenKeys.add(built.key);
          if (catId === UNCATEGORIZED) needUncat = true;
          if (
            (s.cmd !== undefined && s.cmd.trim() !== '') ||
            (s.seriesEpisodeNumbers !== undefined && s.seriesEpisodeNumbers.length > 0)
          ) {
            stagedCmds[stalkerVodSeriesMetaKey(built.providerId)] = encodeVodSeriesMeta({
              contentType: 'series',
              ...(s.cmd !== undefined && s.cmd.trim() !== '' ? { cmd: s.cmd.trim() } : {}),
              ...(s.seriesEpisodeNumbers !== undefined && s.seriesEpisodeNumbers.length > 0
                ? { seriesEpisodeNumbers: s.seriesEpisodeNumbers }
                : {}),
            });
          }
          seriesRows.push(built.row);
          const pos = posByCat.get(catId) ?? 0;
          posByCat.set(catId, pos + 1);
          seriesLinks.push([built.key, catId, pos]);
        }

        for (const vod of vodSeriesItems) {
          const catId = vod.categoryId && vod.categoryId !== '*' ? vod.categoryId : UNCATEGORIZED;
          if (
            allowlists.series !== undefined &&
            !allowlists.series.has(catId) &&
            !(allowlists.movie?.has(catId) ?? false)
          ) {
            continue;
          }
          const built = buildSeriesRow(c, vod, portalHost, secret.mac);
          if (seenKeys.has(built.key)) continue;
          seenKeys.add(built.key);
          if (catId === UNCATEGORIZED) {
            needUncat = true;
          } else if (!writtenSeriesCatIds.has(catId)) {
            writtenSeriesCatIds.add(catId);
            extraSeriesCats.push({ id: catId, name: vodCatNameById.get(catId) ?? catId });
          }
          stagedCmds[stalkerVodSeriesMetaKey(built.providerId)] = encodeVodSeriesMeta({
            contentType: 'vod',
            ...(vod.cmd.trim() !== '' ? { cmd: vod.cmd.trim() } : {}),
            ...(vod.seriesEpisodeNumbers !== undefined && vod.seriesEpisodeNumbers.length > 0
              ? { seriesEpisodeNumbers: vod.seriesEpisodeNumbers }
              : {}),
          });
          seriesRows.push(built.row);
          const pos = posByCat.get(catId) ?? 0;
          posByCat.set(catId, pos + 1);
          seriesLinks.push([built.key, catId, pos]);
        }

        if (extraSeriesCats.length > 0) {
          await writeCategories(
            c.db,
            c.sourceId,
            'series',
            c.runId,
            extraSeriesCats,
            filteredCats.series.length,
          );
          c.counts.categories = (c.counts.categories ?? 0) + extraSeriesCats.length;
        }
        if (needUncat) {
          await writeCategories(
            c.db,
            c.sourceId,
            'series',
            c.runId,
            [{ id: UNCATEGORIZED, name: UNCATEGORIZED }],
            filteredCats.series.length + extraSeriesCats.length,
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

    beforeCommit: async (c) => {
      const hadPrevious =
        (await deps.secrets.get(secretKey(source.id, 'stalker_cmds')).catch(() => undefined)) !==
        undefined;
      previousCmds = hadPrevious ? await loadStalkerCmdMap(deps.secrets, source.id) : undefined;
      const merged: StalkerCmdMap = {};
      const keepLiveCmds = (c.counts.live ?? 0) === 0 && !c.intentionallyEmptyKinds.has('live');
      const keepMovieCmds = (c.counts.movies ?? 0) === 0 && !c.intentionallyEmptyKinds.has('movie');
      const keepSeriesCmds =
        (c.counts.series ?? 0) === 0 && !c.intentionallyEmptyKinds.has('series');
      if (previousCmds !== undefined) {
        for (const [k, v] of Object.entries(previousCmds)) {
          if (
            k.startsWith('series:') ||
            k.startsWith('epmeta:') ||
            (keepLiveCmds && (k.startsWith('live:') || k.startsWith('static:live:'))) ||
            (keepMovieCmds && (k.startsWith('movie:') || k.startsWith('static:movie:'))) ||
            (keepSeriesCmds && k.startsWith('vodseries:'))
          ) {
            merged[k] = v;
          }
        }
      }
      Object.assign(merged, stagedCmds);
      unwrap(await saveStalkerCmdMap(deps.secrets, source.id, merged));
      wroteCmds = true;
      await saveStalkerDiscovery(deps.secrets, source.id, secret, client.discoveredPortal());
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
      if (previousCmds === undefined) {
        await deleteStalkerCmdMap(deps.secrets, source.id).catch(() => undefined);
      } else {
        await saveStalkerCmdMap(deps.secrets, source.id, previousCmds).catch(() => undefined);
      }
    },
  });
}
