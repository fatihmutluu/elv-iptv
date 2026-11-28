import { elvError, err, ok, type Result } from '@elv/domain';
import type {
  StalkerCategory,
  StalkerClient,
  StalkerEpisode,
  StalkerEpisodeFile,
  StalkerPage,
} from '@elv/sources';
import { foldText } from './fold';
import { checkAbort, notify, Stop, unwrap } from './import-run';
import { DEFAULT_BATCH_SIZE, type ImportDeps, type ImportOptions } from './import-types';
import type { BrowseKind } from './queries';
import { sourceExists } from './runs';
import type { SourceRecord } from './sources';
import {
  deleteStalkerCmdMap,
  encodeEpisodeMeta,
  loadStalkerCmdMap,
  mergeStalkerCmdMap,
  openStalkerClient,
  parseVodSeriesMeta,
  type StalkerCmdMap,
  safeStalkerProviderId,
  saveStalkerDiscovery,
  stalkerCmdKey,
  stalkerEpisodeMetaKey,
  stalkerKey,
  stalkerVodSeriesMetaKey,
} from './stalker-secret';

const MAX_STALKER_PAGES = 500;
const POSITIVE_INT_RE = /^[1-9]\d*$/;

const EPISODE_SQL = `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, title_fold, extension, duration_sec, url_template, run_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)
  ON CONFLICT(source_id, key) DO UPDATE SET provider_id = excluded.provider_id, series_key = excluded.series_key,
    season = excluded.season, episode = excluded.episode, title = excluded.title, title_fold = excluded.title_fold,
    extension = NULL, duration_sec = excluded.duration_sec, url_template = NULL, run_id = excluded.run_id`;

/** Filters out synthetic Stalker `"*"` categories and deduplicates category IDs. */
export function filterRealStalkerCategories(
  cats: readonly StalkerCategory[],
): { id: string; name: string }[] {
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

/**
 * Fetches all Stalker `get_ordered_list` pages `1..N` with a seen-ID no-progress guard so buggy
 * portals that repeat page 1 endlessly terminate cleanly.
 */
export async function fetchAllStalkerPages<T extends { id: string }>(
  fetchPage: (page: number) => Promise<Result<StalkerPage<T>>>,
  signal: AbortSignal | undefined,
  onBatch?: (items: readonly T[]) => Promise<void>,
): Promise<T[]> {
  const all: T[] = [];
  const seenIds = new Set<string>();
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= MAX_STALKER_PAGES) {
    checkAbort({ signal });
    const res = unwrap(await fetchPage(page));
    if (res.items.length === 0) break;
    const fresh: T[] = [];
    for (const item of res.items) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      fresh.push(item);
    }
    if (fresh.length === 0) break;
    all.push(...fresh);
    if (onBatch !== undefined) await onBatch(fresh);
    const perPage = Math.max(1, res.maxPageItems > 0 ? res.maxPageItems : res.items.length);
    totalPages = Math.max(1, Math.ceil(res.totalItems / perPage));
    if (res.totalItems <= all.length) break;
    page += 1;
  }
  return all;
}

function resolveMinistraFileCmd(file: {
  id: string;
  cmd?: string;
  protocol?: string;
  isFile?: boolean;
}): string {
  const id = file.id.trim();
  if (
    file.isFile === true &&
    file.protocol?.trim().toLowerCase() === 'custom' &&
    POSITIVE_INT_RE.test(id)
  ) {
    return `/media/file_${id}.mpg`;
  }
  return file.cmd?.trim() ?? '';
}

function selectMinistraVideoFile(
  files: readonly StalkerEpisodeFile[],
): StalkerEpisodeFile | undefined {
  const exact = files.find(
    (f) => f.isFile === true && f.fileType?.trim().toLowerCase() === 'video',
  );
  if (exact !== undefined) return exact;
  const isFileRow = files.find((f) => {
    const ft = f.fileType?.trim().toLowerCase();
    return f.isFile === true && ft !== 'subtitle' && ft !== 'audio';
  });
  if (isFileRow !== undefined) return isFileRow;
  const anyVideoWithCmd = files.find(
    (f) => f.fileType?.trim().toLowerCase() === 'video' && resolveMinistraFileCmd(f) !== '',
  );
  if (anyVideoWithCmd !== undefined) return anyVideoWithCmd;
  return files.find((f) => resolveMinistraFileCmd(f) !== '');
}

async function resolveVodEpisodeCommand(
  client: StalkerClient,
  seriesId: string,
  seasonId: string,
  ep: StalkerEpisode,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (ep.isFile === true && ep.protocol?.trim().toLowerCase() === 'custom') {
    const direct = resolveMinistraFileCmd(ep);
    if (direct !== '') return direct;
  }
  const existing = ep.cmd.trim();
  if (existing !== '' && ep.protocol?.trim().toLowerCase() !== 'custom') {
    return existing;
  }
  const call = signal === undefined ? undefined : { signal };
  const filesRes = await client.vodEpisodeFiles(seriesId, seasonId, ep.id, call);
  if (!filesRes.ok) {
    if (filesRes.error.code === 'aborted' || filesRes.error.category === 'auth') {
      throw new Stop(filesRes.error);
    }
    return resolveMinistraFileCmd(ep);
  }
  const chosen = selectMinistraVideoFile(filesRes.value);
  if (chosen === undefined) return resolveMinistraFileCmd(ep);
  return resolveMinistraFileCmd(chosen);
}

/**
 * Lazily loads seasons and episodes for one Stalker/Ministra series into SQLite (cmds stay strictly
 * in `SecretStore`). Supports multi-page seasons, VOD-backed series (`type=vod`), embedded
 * `series[]` episode synthesis (without splitting flat collections on title ranges), and Ministra
 * `is_file=1` / `protocol='custom'` `/media/file_<id>.mpg` resolution.
 */
export async function loadStalkerSeriesEpisodes(
  source: SourceRecord,
  seriesKey: string,
  deps: ImportDeps,
  opts: ImportOptions = {},
): Promise<Result<number>> {
  const opened = await openStalkerClient(source, deps);
  if (!opened.ok) return opened;
  const { client, secret } = opened.value;

  try {
    const query = 'SELECT provider_id, run_id FROM series WHERE source_id = ? AND key = ?';
    const lookup = (db: ImportDeps['db']) =>
      db.all<{ provider_id: string | null; run_id: number }>(query, [source.id, seriesKey]);
    const row = (await lookup(deps.db))[0];
    if (row?.provider_id == null) return err(elvError('source-format', 'unknown-series'));

    const existingCmds = await loadStalkerCmdMap(deps.secrets, source.id);
    const vodMeta = parseVodSeriesMeta(existingCmds[stalkerVodSeriesMetaKey(row.provider_id)]);
    const contentType: 'vod' | 'series' = vodMeta?.contentType ?? 'series';
    const linkKind: 'movie' | 'series' = contentType === 'vod' ? 'movie' : 'series';

    const call = opts.signal === undefined ? undefined : { signal: opts.signal };
    checkAbort({ signal: opts.signal });
    unwrap(await client.handshake(call));

    const seriesCall = { ...(call ?? {}), contentType };
    const seasonsRes = await client.seriesSeasons(row.provider_id, seriesCall);
    let seasons = seasonsRes.ok ? seasonsRes.value : [];
    if (!seasonsRes.ok) {
      if (
        seasonsRes.error.code === 'aborted' ||
        seasonsRes.error.category === 'auth' ||
        !vodMeta?.seriesEpisodeNumbers?.length
      ) {
        throw new Stop(seasonsRes.error);
      }
      seasons = [];
    }

    const episodeEntries: {
      key: string;
      providerId: string;
      season: number;
      ep: StalkerEpisode;
    }[] = [];
    const epCmds: StalkerCmdMap = {};

    if (
      seasons.length === 0 &&
      vodMeta?.seriesEpisodeNumbers !== undefined &&
      vodMeta.seriesEpisodeNumbers.length > 0
    ) {
      const parentCmd = vodMeta.cmd?.trim() ?? '';
      for (const epNum of vodMeta.seriesEpisodeNumbers) {
        const providerId = safeStalkerProviderId(`${row.provider_id}:s1:e${epNum}`);
        const key = stalkerKey(source.id, 'episode', providerId);
        if (parentCmd !== '') {
          epCmds[stalkerCmdKey('series', providerId)] = parentCmd;
        }
        epCmds[stalkerEpisodeMetaKey(providerId)] = encodeEpisodeMeta({
          linkKind,
          episodeNumber: epNum,
        });
        episodeEntries.push({
          key,
          providerId,
          season: 1,
          ep: {
            id: providerId,
            seriesId: row.provider_id,
            seasonId: `${row.provider_id}:s1`,
            episodeNumber: epNum,
            title: `Episode ${epNum}`,
            cmd: parentCmd,
          },
        });
      }
    } else {
      for (const season of seasons) {
        checkAbort({ signal: opts.signal });
        let episodes: StalkerEpisode[] = [];
        try {
          episodes = await fetchAllStalkerPages(
            (page) => client.seasonEpisodes(row.provider_id as string, season.id, page, seriesCall),
            opts.signal,
          );
        } catch (e) {
          const isFatal =
            e instanceof Stop && (e.error.code === 'aborted' || e.error.category === 'auth');
          if (isFatal || !season.seriesEpisodeNumbers?.length) throw e;
          episodes = [];
        }

        if (
          episodes.length === 0 &&
          season.seriesEpisodeNumbers !== undefined &&
          season.seriesEpisodeNumbers.length > 0
        ) {
          const seasonCmd = season.cmd?.trim() || vodMeta?.cmd?.trim() || '';
          for (const epNum of season.seriesEpisodeNumbers) {
            const providerId = safeStalkerProviderId(`${season.id}:e${epNum}`);
            const key = stalkerKey(source.id, 'episode', providerId);
            if (seasonCmd !== '') {
              epCmds[stalkerCmdKey('series', providerId)] = seasonCmd;
            }
            epCmds[stalkerEpisodeMetaKey(providerId)] = encodeEpisodeMeta({
              linkKind,
              episodeNumber: epNum,
            });
            episodeEntries.push({
              key,
              providerId,
              season: season.seasonNumber,
              ep: {
                id: providerId,
                seriesId: row.provider_id,
                seasonId: season.id,
                episodeNumber: epNum,
                title: `Episode ${epNum}`,
                cmd: seasonCmd,
              },
            });
          }
          await deps.scheduler.yieldNow();
          continue;
        }

        for (const ep of episodes) {
          checkAbort({ signal: opts.signal });
          const providerId = safeStalkerProviderId(ep.id);
          const key = stalkerKey(source.id, 'episode', providerId);
          let cmd: string;
          if (contentType === 'vod') {
            cmd = await resolveVodEpisodeCommand(
              client,
              row.provider_id,
              season.id,
              ep,
              opts.signal,
            );
            epCmds[stalkerEpisodeMetaKey(providerId)] = encodeEpisodeMeta({ linkKind: 'movie' });
          } else {
            cmd = ep.cmd.trim() || season.cmd?.trim() || '';
          }
          if (cmd !== '') epCmds[stalkerCmdKey('series', providerId)] = cmd;
          episodeEntries.push({ key, providerId, season: season.seasonNumber, ep });
        }
        await deps.scheduler.yieldNow();
      }
    }

    if (!(await sourceExists(deps.db, source.id))) {
      return err(elvError('storage', 'source-not-found'));
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

    if (stored === 'no-source') {
      await deleteStalkerCmdMap(deps.secrets, source.id).catch(() => undefined);
      return err(elvError('storage', 'source-not-found'));
    }
    if (stored === 'no-series') return err(elvError('source-format', 'unknown-series'));

    await saveStalkerDiscovery(deps.secrets, source.id, secret, client.discoveredPortal());
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
  const { client, secret } = opened.value;
  const call = signal === undefined ? undefined : { signal };
  try {
    unwrap(await client.handshake(call));
    const [genres, vodCats, seriesCats] = await Promise.all([
      client.genres(call).then(unwrap),
      client.vodCategories(call).then((r) => (r.ok ? r.value : [])),
      client.seriesCategories(call).then((r) => (r.ok ? r.value : [])),
    ]);
    await saveStalkerDiscovery(deps.secrets, source.id, secret, client.discoveredPortal());
    const out: { id: string; name: string; kind: BrowseKind; itemCount: number }[] = [];
    for (const c of filterRealStalkerCategories(genres)) {
      out.push({ id: c.id, name: c.name, kind: 'live', itemCount: 0 });
    }
    for (const c of filterRealStalkerCategories(vodCats)) {
      out.push({ id: c.id, name: c.name, kind: 'movie', itemCount: 0 });
    }
    for (const c of filterRealStalkerCategories(seriesCats)) {
      out.push({ id: c.id, name: c.name, kind: 'series', itemCount: 0 });
    }
    return ok(out);
  } catch (e) {
    if (signal?.aborted) return err(elvError('network', 'aborted'));
    return err(e instanceof Stop ? e.error : elvError('storage', 'import-failed'));
  }
}
