import {
  computeResumePositionMs,
  type EpisodeRow,
  MIN_RESUME_POSITION_MS,
  type WatchProgressRow,
} from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { DetailTarget } from '../shared';

export { mergeVodEnrichment } from './detail-data-helpers';
export {
  buildTechnicalBadges,
  cyclePrePlayOption,
  type DescribedDetailError,
  describeDetailSeasonsError,
  PREPLAY_AUDIO_OPTIONS,
  PREPLAY_SUBTITLE_OPTIONS,
  SYNOPSIS_EXPAND_THRESHOLD,
} from './detail-preplay';

/** Resolved primary Play / Resume action displayed in the Detail Hero CTA. */
export type PrimaryPlayAction =
  | {
      readonly kind: 'movie';
      readonly resume: boolean;
      readonly positionMs: number;
      readonly durationMs: number;
      readonly target: PlayTarget;
    }
  | {
      readonly kind: 'episode';
      readonly resume: boolean;
      readonly season: number;
      readonly episodeNumber: number;
      readonly episode: EpisodeRow;
      readonly positionMs: number;
      readonly durationMs: number;
      readonly target: PlayTarget;
    }
  | { readonly kind: 'pending' };

/** Smart primary-episode selection within a season. */
export interface SeriesPrimaryEpisodeSelection {
  readonly episode: EpisodeRow;
  readonly index: number;
  readonly episodeNumber: number;
  readonly resume: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
}

/** Navigable vertical row identifier inside `DetailScreen` for 10-ft TV D-pad focus. */
export type DetailNavRowId =
  | 'back'
  | 'hero-actions'
  | 'hero-play'
  | 'cast'
  | 'seasons'
  | 'episode-chunks'
  | 'episodes'
  | 'retry'
  | 'related';

/** Descriptor of one currently visible focusable row inside `DetailScreen`. */
export interface DetailNavRowDescriptor {
  readonly id: DetailNavRowId;
  readonly count: number;
  readonly orientation: 'horizontal' | 'vertical';
}

/** Input for {@link buildEpisodePlayTarget}. */
export interface BuildEpisodePlayTargetInput {
  readonly target: DetailTarget;
  readonly episode: EpisodeRow;
  readonly index: number;
  readonly progress: WatchProgressRow | undefined;
  readonly seriesTitle: string;
  readonly t: AppI18n['t'];
  readonly nextEpisodes?: readonly EpisodeRow[];
  readonly preferredAudioLang?: string;
  readonly preferredSubtitleLang?: string;
}

/** Input for {@link buildMoviePlayTarget}. */
export interface BuildMoviePlayTargetInput {
  readonly target: DetailTarget;
  readonly resolvedTitle?: string;
  readonly progress: WatchProgressRow | null | undefined;
  readonly preferredAudioLang?: string;
  readonly preferredSubtitleLang?: string;
}

/** Input for {@link buildPrimaryPlayAction}. */
export interface BuildPrimaryPlayActionInput {
  readonly target: DetailTarget;
  readonly resolvedTitle: string;
  readonly movieProgress: WatchProgressRow | null;
  readonly episodes: readonly EpisodeRow[];
  readonly episodeProgressByKey: ReadonlyMap<string, WatchProgressRow>;
  readonly t: AppI18n['t'];
  readonly preferredAudioLang?: string;
  readonly preferredSubtitleLang?: string;
}

/** Input for {@link buildDetailNavRows}. */
export interface BuildDetailNavRowsInput {
  readonly heroActionCount: number;
  readonly heroPlayCount?: number;
  readonly castCount?: number;
  readonly seasonsCount: number;
  readonly episodeChunksCount?: number;
  readonly episodesCount: number;
  readonly hasSeasonsError: boolean;
  readonly relatedCount: number;
}

function episodeDurationMs(episode: EpisodeRow, progress: WatchProgressRow | undefined): number {
  if (progress !== undefined && progress.durationMs > 0) return progress.durationMs;
  if (
    episode.durationSec !== null &&
    Number.isFinite(episode.durationSec) &&
    episode.durationSec > 0
  ) {
    return Math.round(episode.durationSec * 1000);
  }
  return 0;
}

function makePrimarySelection(
  episode: EpisodeRow,
  index: number,
  resume: boolean,
  prog: WatchProgressRow | undefined,
): SeriesPrimaryEpisodeSelection {
  return {
    episode,
    index,
    episodeNumber: episode.episode ?? index + 1,
    resume,
    positionMs: resume && prog !== undefined ? prog.positionMs : 0,
    durationMs: episodeDurationMs(episode, prog),
  };
}

/**
 * Selects the smart primary episode for a season's Play/Resume CTA:
 * 1. First in-progress unwatched episode (`positionMs >= MIN_RESUME_POSITION_MS`) -> `resume: true`.
 * 2. First unwatched episode after the last watched episode (or first unwatched overall) -> `resume: false`.
 * 3. Episode 1 (`resume: false`) when every episode is already watched.
 */
export function resolveSeriesPrimaryEpisode(
  episodes: readonly EpisodeRow[],
  progressByKey: ReadonlyMap<string, WatchProgressRow>,
): SeriesPrimaryEpisodeSelection | undefined {
  if (episodes.length === 0) return undefined;

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (!ep) continue;
    const prog = progressByKey.get(ep.key);
    if (prog !== undefined && !prog.watched && prog.positionMs >= MIN_RESUME_POSITION_MS) {
      return makePrimarySelection(ep, i, true, prog);
    }
  }

  let lastWatchedIndex = -1;
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (ep && progressByKey.get(ep.key)?.watched) lastWatchedIndex = i;
  }

  if (lastWatchedIndex >= 0) {
    for (let i = lastWatchedIndex + 1; i < episodes.length; i++) {
      const ep = episodes[i];
      if (!ep) continue;
      const prog = progressByKey.get(ep.key);
      if (!prog?.watched) return makePrimarySelection(ep, i, false, prog);
    }
  }

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (!ep) continue;
    const prog = progressByKey.get(ep.key);
    if (!prog?.watched) return makePrimarySelection(ep, i, false, prog);
  }

  const first = episodes[0];
  return first ? makePrimarySelection(first, 0, false, progressByKey.get(first.key)) : undefined;
}

const MAX_NEXT_EPISODES = 50;

function langOverrides(
  preferredAudioLang: string | undefined,
  preferredSubtitleLang: string | undefined,
): Pick<PlayableEntry, 'preferredAudioLang' | 'preferredSubtitleLang'> {
  return {
    ...(preferredAudioLang ? { preferredAudioLang } : {}),
    ...(preferredSubtitleLang ? { preferredSubtitleLang } : {}),
  };
}

function episodeToPlayableEntry(
  target: DetailTarget,
  episode: EpisodeRow,
  index: number,
  seriesTitle: string,
  startPositionMs: number,
  t: AppI18n['t'],
  preferredAudioLang?: string,
  preferredSubtitleLang?: string,
): PlayableEntry {
  const episodeNumber = episode.episode ?? index + 1;
  const trimmedTitle = episode.title?.trim() ?? '';
  const episodeLabel =
    trimmedTitle.length > 0
      ? t('series.episodeTitled', { episode: episodeNumber, title: trimmedTitle })
      : t('series.episodeUntitled', { episode: episodeNumber });
  const subtitle =
    trimmedTitle.length > 0
      ? `S${episode.season} E${episodeNumber} · ${trimmedTitle}`
      : `S${episode.season} E${episodeNumber}`;
  return {
    itemKey: episode.key,
    sourceId: target.sourceId,
    title: `${seriesTitle} — ${episodeLabel}`,
    kind: 'vod',
    itemKind: 'episode',
    seriesKey: target.itemKey,
    season: episode.season,
    episode: episodeNumber,
    logo: target.backdropUri ?? target.posterUri,
    subtitle,
    startPositionMs,
    ...langOverrides(preferredAudioLang, preferredSubtitleLang),
  };
}

/** Builds a full VOD episode {@link PlayTarget} with series metadata and 5-second smart rewind. */
export function buildEpisodePlayTarget({
  target,
  episode,
  index,
  progress,
  seriesTitle,
  t,
  nextEpisodes,
  preferredAudioLang,
  preferredSubtitleLang,
}: BuildEpisodePlayTargetInput): PlayTarget {
  const startPositionMs = progress !== undefined ? computeResumePositionMs(progress) : 0;
  const base = episodeToPlayableEntry(
    target,
    episode,
    index,
    seriesTitle,
    startPositionMs,
    t,
    preferredAudioLang,
    preferredSubtitleLang,
  );
  if (nextEpisodes === undefined || nextEpisodes.length === 0) return base;
  const mappedNext = nextEpisodes
    .slice(0, MAX_NEXT_EPISODES)
    .map((ep, offset) =>
      episodeToPlayableEntry(
        target,
        ep,
        index + 1 + offset,
        seriesTitle,
        0,
        t,
        preferredAudioLang,
        preferredSubtitleLang,
      ),
    );
  return { ...base, nextEpisodes: mappedNext };
}

/** Builds a VOD movie {@link PlayTarget} with 5-second smart rewind via `computeResumePositionMs`. */
export function buildMoviePlayTarget({
  target,
  resolvedTitle,
  progress,
  preferredAudioLang,
  preferredSubtitleLang,
}: BuildMoviePlayTargetInput): PlayTarget {
  const startPositionMs =
    progress !== null && progress !== undefined ? computeResumePositionMs(progress) : 0;
  return {
    itemKey: target.itemKey,
    sourceId: target.sourceId,
    title: resolvedTitle ?? target.title,
    kind: 'vod',
    itemKind: 'movie',
    logo: target.posterUri ?? target.backdropUri,
    subtitle: null,
    startPositionMs,
    ...langOverrides(preferredAudioLang, preferredSubtitleLang),
  };
}

/** Computes the active {@link PrimaryPlayAction} for a movie or series Detail Hero CTA. */
export function buildPrimaryPlayAction({
  target,
  resolvedTitle,
  movieProgress,
  episodes,
  episodeProgressByKey,
  t,
  preferredAudioLang,
  preferredSubtitleLang,
}: BuildPrimaryPlayActionInput): PrimaryPlayAction {
  const langProps = langOverrides(preferredAudioLang, preferredSubtitleLang);
  if (target.kind === 'movie') {
    const resume =
      movieProgress !== null &&
      !movieProgress.watched &&
      movieProgress.positionMs >= MIN_RESUME_POSITION_MS;
    return {
      kind: 'movie',
      resume,
      positionMs: resume ? movieProgress.positionMs : 0,
      durationMs: movieProgress?.durationMs ?? 0,
      target: buildMoviePlayTarget({
        target,
        resolvedTitle,
        progress: movieProgress,
        ...langProps,
      }),
    };
  }

  const picked = resolveSeriesPrimaryEpisode(episodes, episodeProgressByKey);
  if (!picked) return { kind: 'pending' };

  return {
    kind: 'episode',
    resume: picked.resume,
    season: picked.episode.season,
    episodeNumber: picked.episodeNumber,
    episode: picked.episode,
    positionMs: picked.positionMs,
    durationMs: picked.durationMs,
    target: buildEpisodePlayTarget({
      target,
      episode: picked.episode,
      index: picked.index,
      progress: episodeProgressByKey.get(picked.episode.key),
      seriesTitle: resolvedTitle,
      t,
      nextEpisodes: episodes.slice(picked.index + 1),
      ...langProps,
    }),
  };
}

/** Clamps a playback progress ratio into `[0, 1]`, returning `0` for non-positive/invalid values. */
export function detailProgressRatio(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  if (positionMs <= 0) return 0;
  return Math.min(1, Math.max(0, positionMs / durationMs));
}

/** Formats episode duration in seconds (`48m` or `1h 32m`), returning `undefined` when invalid. */
export function formatEpisodeDuration(
  durationSec: number | null | undefined,
  t: AppI18n['t'],
): string | undefined {
  if (durationSec === null || durationSec === undefined) return undefined;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return undefined;
  const totalMinutes = Math.max(1, Math.round(durationSec / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return t('detail.durationHoursMin', { hours, minutes });
  return t('detail.durationMin', { minutes: totalMinutes });
}

/** Builds the ordered list of currently visible focusable rows for 10-ft TV D-pad traversal. */
export function buildDetailNavRows(input: BuildDetailNavRowsInput): DetailNavRowDescriptor[] {
  const rows: DetailNavRowDescriptor[] = [{ id: 'back', count: 1, orientation: 'horizontal' }];
  if (input.heroActionCount > 0) {
    rows.push({ id: 'hero-actions', count: input.heroActionCount, orientation: 'horizontal' });
  }
  rows.push({
    id: 'hero-play',
    count: Math.max(1, input.heroPlayCount ?? 1),
    orientation: 'horizontal',
  });
  if ((input.castCount ?? 0) > 0) {
    rows.push({ id: 'cast', count: input.castCount ?? 0, orientation: 'horizontal' });
  }
  if (input.seasonsCount > 0) {
    rows.push({ id: 'seasons', count: input.seasonsCount, orientation: 'horizontal' });
  }
  const chunksCount = input.episodeChunksCount ?? 0;
  if (chunksCount > 0 && !input.hasSeasonsError) {
    rows.push({ id: 'episode-chunks', count: chunksCount, orientation: 'horizontal' });
  }
  if (input.hasSeasonsError) {
    rows.push({ id: 'retry', count: 1, orientation: 'horizontal' });
  } else if (input.episodesCount > 0) {
    rows.push({ id: 'episodes', count: input.episodesCount, orientation: 'vertical' });
  }
  if (input.relatedCount > 0) {
    rows.push({ id: 'related', count: input.relatedCount, orientation: 'horizontal' });
  }
  return rows;
}
