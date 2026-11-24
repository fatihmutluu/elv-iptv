import type { EpisodeRow, VodEnrichmentRecord, WatchProgressRow } from '@elv/data';
import { elvError } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import type { DetailTarget } from '../shared';
import { buildOptimisticWatchedRow } from './detail-data-helpers';
import {
  buildDetailNavRows,
  buildEpisodePlayTarget,
  buildMoviePlayTarget,
  buildPrimaryPlayAction,
  buildTechnicalBadges,
  cyclePrePlayOption,
  describeDetailSeasonsError,
  detailProgressRatio,
  formatEpisodeDuration,
  mergeVodEnrichment,
  PREPLAY_AUDIO_OPTIONS,
  PREPLAY_SUBTITLE_OPTIONS,
  resolveSeriesPrimaryEpisode,
} from './detail-model';

const i18n = createAppI18n('en');

const MOVIE_TARGET: DetailTarget = {
  itemKey: 'x:s1:movie:101',
  sourceId: 's1',
  kind: 'movie',
  title: 'Silent Horizon',
  posterUri: 'https://img.invalid/poster.jpg',
  backdropUri: 'https://img.invalid/backdrop.jpg',
  year: 2026,
  rating: 8.6,
  catalogId: 101,
  categoryId: 's1|movie|10',
};

const SERIES_TARGET: DetailTarget = {
  itemKey: 'x:s1:series:301',
  sourceId: 's1',
  kind: 'series',
  title: 'Starlight Harbor',
  posterUri: 'https://img.invalid/series-poster.jpg',
  backdropUri: 'https://img.invalid/series-backdrop.jpg',
  year: 2025,
  rating: 8.9,
  catalogId: 301,
  categoryId: 's1|series|20',
};

const makeEpisode = (overrides: Partial<EpisodeRow> = {}): EpisodeRow => ({
  id: 1,
  key: 'x:s1:ep:1',
  season: 1,
  episode: 1,
  title: 'Arrival',
  durationSec: 2880,
  ...overrides,
});

const makeProgress = (overrides: Partial<WatchProgressRow> = {}): WatchProgressRow => ({
  profileId: 'default',
  sourceId: 's1',
  itemKey: 'x:s1:movie:101',
  kind: 'movie',
  title: 'Silent Horizon',
  subtitle: null,
  logo: null,
  seriesKey: null,
  season: null,
  episode: null,
  positionMs: 0,
  durationMs: 7_200_000,
  watched: false,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe('detail-model', () => {
  describe('resolveSeriesPrimaryEpisode', () => {
    const ep1 = makeEpisode({ id: 1, key: 'x:s1:ep:1', episode: 1, title: 'Pilot' });
    const ep2 = makeEpisode({ id: 2, key: 'x:s1:ep:2', episode: 2, title: 'Drift' });
    const ep3 = makeEpisode({ id: 3, key: 'x:s1:ep:3', episode: 3, title: 'Signal' });

    it('returns undefined for an empty episode list', () => {
      expect(resolveSeriesPrimaryEpisode([], new Map())).toBeUndefined();
    });

    it('picks the first in-progress unwatched episode (>= MIN_RESUME_POSITION_MS) as resume', () => {
      const progress = new Map<string, WatchProgressRow>([
        [ep1.key, makeProgress({ itemKey: ep1.key, kind: 'episode', watched: true })],
        [
          ep2.key,
          makeProgress({
            itemKey: ep2.key,
            kind: 'episode',
            positionMs: 420_000,
            durationMs: 2_880_000,
            watched: false,
          }),
        ],
        [
          ep3.key,
          makeProgress({
            itemKey: ep3.key,
            kind: 'episode',
            positionMs: 60_000,
            durationMs: 2_880_000,
            watched: false,
          }),
        ],
      ]);

      const picked = resolveSeriesPrimaryEpisode([ep1, ep2, ep3], progress);
      expect(picked).toMatchObject({
        episode: ep2,
        index: 1,
        episodeNumber: 2,
        resume: true,
        positionMs: 420_000,
        durationMs: 2_880_000,
      });
    });

    it('picks the first unwatched episode after the last watched episode when none are in progress', () => {
      const progress = new Map<string, WatchProgressRow>([
        [ep1.key, makeProgress({ itemKey: ep1.key, kind: 'episode', watched: true })],
        [
          ep2.key,
          makeProgress({ itemKey: ep2.key, kind: 'episode', positionMs: 2_000, watched: false }),
        ],
      ]);

      const picked = resolveSeriesPrimaryEpisode([ep1, ep2, ep3], progress);
      expect(picked).toMatchObject({
        episode: ep2,
        index: 1,
        episodeNumber: 2,
        resume: false,
      });
    });

    it('falls back to earlier unwatched episode when the final episode is watched', () => {
      const progress = new Map<string, WatchProgressRow>([
        [ep3.key, makeProgress({ itemKey: ep3.key, kind: 'episode', watched: true })],
      ]);

      const picked = resolveSeriesPrimaryEpisode([ep1, ep2, ep3], progress);
      expect(picked).toMatchObject({
        episode: ep1,
        index: 0,
        episodeNumber: 1,
        resume: false,
      });
    });

    it('falls back to Episode 1 (resume: false) when all episodes are watched', () => {
      const progress = new Map<string, WatchProgressRow>([
        [ep1.key, makeProgress({ itemKey: ep1.key, kind: 'episode', watched: true })],
        [ep2.key, makeProgress({ itemKey: ep2.key, kind: 'episode', watched: true })],
        [ep3.key, makeProgress({ itemKey: ep3.key, kind: 'episode', watched: true })],
      ]);

      const picked = resolveSeriesPrimaryEpisode([ep1, ep2, ep3], progress);
      expect(picked).toMatchObject({
        episode: ep1,
        index: 0,
        episodeNumber: 1,
        resume: false,
        positionMs: 0,
      });
    });

    it('defaults episodeNumber to index + 1 when episode.episode is null', () => {
      const unnumbered = makeEpisode({ id: 9, key: 'x:s1:ep:9', episode: null, title: null });
      const picked = resolveSeriesPrimaryEpisode([unnumbered], new Map());
      expect(picked?.episodeNumber).toBe(1);
    });
  });

  describe('buildMoviePlayTarget & buildEpisodePlayTarget', () => {
    it('builds a movie PlayTarget with 5s smart rewind when in progress', () => {
      const progress = makeProgress({ positionMs: 125_000, durationMs: 6_000_000, watched: false });
      expect(buildMoviePlayTarget({ target: MOVIE_TARGET, progress })).toEqual({
        itemKey: 'x:s1:movie:101',
        sourceId: 's1',
        title: 'Silent Horizon',
        kind: 'vod',
        itemKind: 'movie',
        logo: 'https://img.invalid/poster.jpg',
        subtitle: null,
        startPositionMs: 120_000,
      });
    });

    it('resets startPositionMs to 0 for watched or unstarted movies', () => {
      const watched = makeProgress({ positionMs: 5_900_000, watched: true });
      expect(
        buildMoviePlayTarget({ target: MOVIE_TARGET, progress: watched }).startPositionMs,
      ).toBe(0);
      expect(buildMoviePlayTarget({ target: MOVIE_TARGET, progress: null }).startPositionMs).toBe(
        0,
      );
    });

    it('builds an episode PlayTarget with seriesKey, season, episode, subtitle, and 5s rewind', () => {
      const episode = makeEpisode({
        id: 2,
        key: 'x:s1:ep:2',
        season: 2,
        episode: 4,
        title: 'Echoes',
      });
      const progress = makeProgress({
        itemKey: episode.key,
        kind: 'episode',
        positionMs: 305_000,
        durationMs: 2_880_000,
        watched: false,
      });

      const playTarget = buildEpisodePlayTarget({
        target: SERIES_TARGET,
        episode,
        index: 3,
        progress,
        seriesTitle: 'Starlight Harbor',
        t: i18n.t,
      });

      expect(playTarget).toEqual({
        itemKey: 'x:s1:ep:2',
        sourceId: 's1',
        title: 'Starlight Harbor — E4 · Echoes',
        kind: 'vod',
        itemKind: 'episode',
        seriesKey: 'x:s1:series:301',
        season: 2,
        episode: 4,
        logo: 'https://img.invalid/series-backdrop.jpg',
        subtitle: 'S2 E4 · Echoes',
        startPositionMs: 300_000,
      });
    });

    it('handles untitled episodes and missing episode numbers cleanly', () => {
      const episode = makeEpisode({
        id: 7,
        key: 'x:s1:ep:7',
        season: 1,
        episode: null,
        title: '   ',
      });
      const playTarget = buildEpisodePlayTarget({
        target: { ...SERIES_TARGET, backdropUri: null },
        episode,
        index: 2,
        progress: undefined,
        seriesTitle: 'Starlight Harbor',
        t: i18n.t,
      });

      expect(playTarget.episode).toBe(3);
      expect(playTarget.title).toBe('Starlight Harbor — Episode 3');
      expect(playTarget.subtitle).toBe('S1 E3');
      expect(playTarget.logo).toBe('https://img.invalid/series-poster.jpg');
      expect(playTarget.startPositionMs).toBe(0);
      expect(playTarget.nextEpisodes).toBeUndefined();
    });

    it('attaches mapped nextEpisodes with startPositionMs 0 and omits when empty', () => {
      const ep1 = makeEpisode({ id: 1, key: 'x:s1:ep:1', season: 1, episode: 1, title: 'Pilot' });
      const ep2 = makeEpisode({ id: 2, key: 'x:s1:ep:2', season: 1, episode: 2, title: 'Drift' });
      const ep3 = makeEpisode({ id: 3, key: 'x:s1:ep:3', season: 1, episode: null, title: null });

      const withNext = buildEpisodePlayTarget({
        target: SERIES_TARGET,
        episode: ep1,
        index: 0,
        progress: undefined,
        seriesTitle: 'Starlight Harbor',
        t: i18n.t,
        nextEpisodes: [ep2, ep3],
      });

      expect(withNext.nextEpisodes).toEqual([
        {
          itemKey: 'x:s1:ep:2',
          sourceId: 's1',
          title: 'Starlight Harbor — E2 · Drift',
          kind: 'vod',
          itemKind: 'episode',
          seriesKey: 'x:s1:series:301',
          season: 1,
          episode: 2,
          logo: 'https://img.invalid/series-backdrop.jpg',
          subtitle: 'S1 E2 · Drift',
          startPositionMs: 0,
        },
        {
          itemKey: 'x:s1:ep:3',
          sourceId: 's1',
          title: 'Starlight Harbor — Episode 3',
          kind: 'vod',
          itemKind: 'episode',
          seriesKey: 'x:s1:series:301',
          season: 1,
          episode: 3,
          logo: 'https://img.invalid/series-backdrop.jpg',
          subtitle: 'S1 E3',
          startPositionMs: 0,
        },
      ]);

      const finale = buildEpisodePlayTarget({
        target: SERIES_TARGET,
        episode: ep3,
        index: 2,
        progress: undefined,
        seriesTitle: 'Starlight Harbor',
        t: i18n.t,
        nextEpisodes: [],
      });
      expect(finale.nextEpisodes).toBeUndefined();
      expect('nextEpisodes' in finale).toBe(false);
    });

    it('caps attached nextEpisodes at 50 entries', () => {
      const ep1 = makeEpisode({ id: 1, key: 'x:s1:ep:1', season: 1, episode: 1, title: 'Ep 1' });
      const remaining = Array.from({ length: 65 }, (_, i) =>
        makeEpisode({
          id: i + 2,
          key: `x:s1:ep:${i + 2}`,
          season: 1,
          episode: i + 2,
          title: `Ep ${i + 2}`,
        }),
      );

      const playTarget = buildEpisodePlayTarget({
        target: SERIES_TARGET,
        episode: ep1,
        index: 0,
        progress: undefined,
        seriesTitle: 'Starlight Harbor',
        t: i18n.t,
        nextEpisodes: remaining,
      });

      expect(playTarget.nextEpisodes).toHaveLength(50);
      expect(playTarget.nextEpisodes?.[0]?.itemKey).toBe('x:s1:ep:2');
      expect(playTarget.nextEpisodes?.[49]?.itemKey).toBe('x:s1:ep:51');
    });
  });

  describe('buildPrimaryPlayAction', () => {
    it('builds movie resume and fresh actions accurately', () => {
      const fresh = buildPrimaryPlayAction({
        target: MOVIE_TARGET,
        resolvedTitle: 'Silent Horizon',
        movieProgress: null,
        episodes: [],
        episodeProgressByKey: new Map(),
        t: i18n.t,
      });
      expect(fresh.kind).toBe('movie');
      if (fresh.kind === 'movie') {
        expect(fresh.resume).toBe(false);
        expect(fresh.target.startPositionMs).toBe(0);
      }

      const inProgress = buildPrimaryPlayAction({
        target: MOVIE_TARGET,
        resolvedTitle: 'Silent Horizon',
        movieProgress: makeProgress({ positionMs: 245_000, durationMs: 6_000_000 }),
        episodes: [],
        episodeProgressByKey: new Map(),
        t: i18n.t,
      });
      expect(inProgress.kind).toBe('movie');
      if (inProgress.kind === 'movie') {
        expect(inProgress.resume).toBe(true);
        expect(inProgress.positionMs).toBe(245_000);
        expect(inProgress.durationMs).toBe(6_000_000);
        expect(inProgress.target.startPositionMs).toBe(240_000);
      }
    });

    it('returns pending for series without episodes and episode action when loaded', () => {
      expect(
        buildPrimaryPlayAction({
          target: SERIES_TARGET,
          resolvedTitle: 'Starlight Harbor',
          movieProgress: null,
          episodes: [],
          episodeProgressByKey: new Map(),
          t: i18n.t,
        }),
      ).toEqual({ kind: 'pending' });

      const ep = makeEpisode({ key: 'x:s1:ep:2', season: 1, episode: 2, title: 'Tide' });
      const prog = makeProgress({
        itemKey: ep.key,
        kind: 'episode',
        positionMs: 185_000,
        durationMs: 2_880_000,
      });
      const action = buildPrimaryPlayAction({
        target: SERIES_TARGET,
        resolvedTitle: 'Starlight Harbor',
        movieProgress: null,
        episodes: [ep],
        episodeProgressByKey: new Map([[ep.key, prog]]),
        t: i18n.t,
      });
      expect(action.kind).toBe('episode');
      if (action.kind === 'episode') {
        expect(action.resume).toBe(true);
        expect(action.season).toBe(1);
        expect(action.episodeNumber).toBe(2);
        expect(action.target.startPositionMs).toBe(180_000);
        expect(action.target.nextEpisodes).toBeUndefined();
      }

      const ep3 = makeEpisode({ key: 'x:s1:ep:3', season: 1, episode: 3, title: 'Harbor' });
      const ep4 = makeEpisode({ key: 'x:s1:ep:4', season: 1, episode: 4, title: 'Beacon' });
      const multi = buildPrimaryPlayAction({
        target: SERIES_TARGET,
        resolvedTitle: 'Starlight Harbor',
        movieProgress: null,
        episodes: [ep, ep3, ep4],
        episodeProgressByKey: new Map([[ep.key, prog]]),
        t: i18n.t,
      });
      expect(multi.kind).toBe('episode');
      if (multi.kind === 'episode') {
        expect(multi.target.nextEpisodes?.map((e) => e.itemKey)).toEqual([ep3.key, ep4.key]);
      }
    });
  });

  describe('formatEpisodeDuration & detailProgressRatio', () => {
    it('formats minutes and hours+minutes and rejects invalid durations', () => {
      expect(formatEpisodeDuration(null, i18n.t)).toBeUndefined();
      expect(formatEpisodeDuration(undefined, i18n.t)).toBeUndefined();
      expect(formatEpisodeDuration(0, i18n.t)).toBeUndefined();
      expect(formatEpisodeDuration(-120, i18n.t)).toBeUndefined();
      expect(formatEpisodeDuration(Number.NaN, i18n.t)).toBeUndefined();
      expect(formatEpisodeDuration(25, i18n.t)).toBe('1m');
      expect(formatEpisodeDuration(48 * 60, i18n.t)).toBe('48m');
      expect(formatEpisodeDuration(92 * 60, i18n.t)).toBe('1h 32m');
    });

    it('clamps progress ratios cleanly into [0, 1]', () => {
      expect(detailProgressRatio(0, 0)).toBe(0);
      expect(detailProgressRatio(-10, 100)).toBe(0);
      expect(detailProgressRatio(Number.NaN, 100)).toBe(0);
      expect(detailProgressRatio(50, 200)).toBe(0.25);
      expect(detailProgressRatio(250, 200)).toBe(1);
    });
  });

  describe('describeDetailSeasonsError', () => {
    it('maps auth, network, not-found, and storage ElvErrors to localized ids', () => {
      expect(describeDetailSeasonsError(elvError('auth', 'invalid-credentials'))).toEqual({
        messageId: 'source.error.invalidCredentials',
        hintId: 'source.hint.invalidCredentials',
      });
      expect(describeDetailSeasonsError(elvError('auth', 'http-403'))).toEqual({
        messageId: 'source.error.invalidCredentials',
        hintId: 'source.hint.invalidCredentials',
      });
      expect(describeDetailSeasonsError(elvError('auth', 'account-expired'))).toEqual({
        messageId: 'source.error.accountExpired',
        hintId: 'source.hint.accountExpired',
      });
      expect(describeDetailSeasonsError(elvError('network', 'http-429'))).toEqual({
        messageId: 'source.error.rateLimited',
        hintId: 'source.hint.rateLimited',
      });
      expect(describeDetailSeasonsError(elvError('network', 'timeout'))).toEqual({
        messageId: 'source.error.timeout',
        hintId: 'source.hint.timeout',
      });
      expect(describeDetailSeasonsError(elvError('network', 'unreachable'))).toEqual({
        messageId: 'source.error.unreachable',
        hintId: 'source.hint.unreachable',
      });
      expect(describeDetailSeasonsError(elvError('storage', 'item-not-found'))).toEqual({
        messageId: 'player.error.itemNotFound',
        hintId: 'player.hint.itemNotFound',
      });
      expect(describeDetailSeasonsError(elvError('storage', 'disk-full'))).toEqual({
        messageId: 'source.error.storage',
        hintId: 'source.hint.storage',
      });
    });
  });

  describe('buildDetailNavRows', () => {
    it('builds ordered TV nav rows for movies, series, and error states', () => {
      expect(
        buildDetailNavRows({
          heroActionCount: 2,
          seasonsCount: 0,
          episodesCount: 0,
          hasSeasonsError: false,
          relatedCount: 6,
        }),
      ).toEqual([
        { id: 'back', count: 1, orientation: 'horizontal' },
        { id: 'hero-actions', count: 2, orientation: 'horizontal' },
        { id: 'hero-play', count: 1, orientation: 'horizontal' },
        { id: 'related', count: 6, orientation: 'horizontal' },
      ]);

      expect(
        buildDetailNavRows({
          heroActionCount: 1,
          seasonsCount: 3,
          episodesCount: 8,
          hasSeasonsError: false,
          relatedCount: 4,
        }),
      ).toEqual([
        { id: 'back', count: 1, orientation: 'horizontal' },
        { id: 'hero-actions', count: 1, orientation: 'horizontal' },
        { id: 'hero-play', count: 1, orientation: 'horizontal' },
        { id: 'seasons', count: 3, orientation: 'horizontal' },
        { id: 'episodes', count: 8, orientation: 'vertical' },
        { id: 'related', count: 4, orientation: 'horizontal' },
      ]);

      expect(
        buildDetailNavRows({
          heroActionCount: 1,
          seasonsCount: 2,
          episodeChunksCount: 4,
          episodesCount: 30,
          hasSeasonsError: false,
          relatedCount: 4,
        }),
      ).toEqual([
        { id: 'back', count: 1, orientation: 'horizontal' },
        { id: 'hero-actions', count: 1, orientation: 'horizontal' },
        { id: 'hero-play', count: 1, orientation: 'horizontal' },
        { id: 'seasons', count: 2, orientation: 'horizontal' },
        { id: 'episode-chunks', count: 4, orientation: 'horizontal' },
        { id: 'episodes', count: 30, orientation: 'vertical' },
        { id: 'related', count: 4, orientation: 'horizontal' },
      ]);

      expect(
        buildDetailNavRows({
          heroActionCount: 1,
          seasonsCount: 0,
          episodeChunksCount: 4,
          episodesCount: 0,
          hasSeasonsError: true,
          relatedCount: 0,
        }),
      ).toEqual([
        { id: 'back', count: 1, orientation: 'horizontal' },
        { id: 'hero-actions', count: 1, orientation: 'horizontal' },
        { id: 'hero-play', count: 1, orientation: 'horizontal' },
        { id: 'retry', count: 1, orientation: 'horizontal' },
      ]);

      expect(
        buildDetailNavRows({
          heroActionCount: 2,
          heroPlayCount: 4,
          castCount: 3,
          seasonsCount: 2,
          episodesCount: 5,
          hasSeasonsError: false,
          relatedCount: 2,
        }),
      ).toEqual([
        { id: 'back', count: 1, orientation: 'horizontal' },
        { id: 'hero-actions', count: 2, orientation: 'horizontal' },
        { id: 'hero-play', count: 4, orientation: 'horizontal' },
        { id: 'cast', count: 3, orientation: 'horizontal' },
        { id: 'seasons', count: 2, orientation: 'horizontal' },
        { id: 'episodes', count: 5, orientation: 'vertical' },
        { id: 'related', count: 2, orientation: 'horizontal' },
      ]);
    });
  });

  describe('technical badges and pre-play track selectors (#398)', () => {
    it('builds typed Cinema Quietude technical badges and skips blank or invalid fields', () => {
      expect(buildTechnicalBadges(undefined)).toEqual([]);
      expect(buildTechnicalBadges({ resolution: '  ', durationMin: 0 })).toEqual([]);
      expect(
        buildTechnicalBadges({
          resolution: '4K',
          hdr: 'HDR10',
          codec: 'HEVC',
          audioChannels: '5.1',
          container: 'mkv',
          durationMin: 124,
        }),
      ).toEqual([
        { key: 'resolution', label: '4K' },
        { key: 'hdr', label: 'HDR10' },
        { key: 'codec', label: 'HEVC' },
        { key: 'audioChannels', label: '5.1' },
        { key: 'container', label: 'MKV' },
        { key: 'durationMin', label: '124m' },
      ]);
    });

    it('cycles pre-play audio and subtitle language options cleanly', () => {
      expect(cyclePrePlayOption(PREPLAY_AUDIO_OPTIONS, '')).toBe('tr');
      expect(cyclePrePlayOption(PREPLAY_AUDIO_OPTIONS, 'es')).toBe('');
      expect(cyclePrePlayOption(PREPLAY_AUDIO_OPTIONS, 'unknown')).toBe('tr');
      expect(cyclePrePlayOption(PREPLAY_SUBTITLE_OPTIONS, '')).toBe('off');
      expect(cyclePrePlayOption(PREPLAY_SUBTITLE_OPTIONS, 'off')).toBe('tr');
      expect(cyclePrePlayOption(PREPLAY_SUBTITLE_OPTIONS, 'es')).toBe('');
    });

    it('forwards preferredAudioLang and preferredSubtitleLang onto movie and episode PlayTargets', () => {
      const moviePlay = buildMoviePlayTarget({
        target: MOVIE_TARGET,
        progress: null,
        preferredAudioLang: 'tr',
        preferredSubtitleLang: 'en',
      });
      expect(moviePlay.preferredAudioLang).toBe('tr');
      expect(moviePlay.preferredSubtitleLang).toBe('en');

      const ep1 = makeEpisode({ id: 1, key: 'x:s1:ep:1', season: 1, episode: 1, title: 'Pilot' });
      const ep2 = makeEpisode({ id: 2, key: 'x:s1:ep:2', season: 1, episode: 2, title: 'Drift' });
      const epPlay = buildEpisodePlayTarget({
        target: SERIES_TARGET,
        episode: ep1,
        index: 0,
        progress: undefined,
        seriesTitle: 'Starlight Harbor',
        t: i18n.t,
        nextEpisodes: [ep2],
        preferredAudioLang: 'de',
        preferredSubtitleLang: 'off',
      });
      expect(epPlay.preferredAudioLang).toBe('de');
      expect(epPlay.preferredSubtitleLang).toBe('off');
      expect(epPlay.nextEpisodes?.[0]?.preferredAudioLang).toBe('de');
      expect(epPlay.nextEpisodes?.[0]?.preferredSubtitleLang).toBe('off');
    });

    it('stamps explicit active profileId onto optimistic watched rows', () => {
      const row = buildOptimisticWatchedRow(null, true, {
        sourceId: 's1',
        itemKey: 'x:s1:movie:101',
        title: 'Silent Horizon',
        logo: null,
        profileId: 'kids-42',
      });
      expect(row.profileId).toBe('kids-42');
    });

    it('merges key-free VOD enrichment non-destructively without overwriting provider fields (#215)', () => {
      const enrichment: VodEnrichmentRecord = {
        itemKey: 'x:s1:movie:101',
        sourceId: 's1',
        cleanTitle: 'Inception',
        releaseYear: 2010,
        rating: 8.8,
        ratingSource: 'local-index',
        genres: ['Sci-Fi', 'Thriller'],
        synopsis: 'A thief steals corporate secrets through dream-sharing technology.',
        certification: 'PG-13',
        fetchedAt: 1000,
        expiresAt: 2000,
      };

      // Returns provider fields unchanged when enrichment is null
      expect(
        mergeVodEnrichment({ year: null, rating: null, genres: [], plot: null }, null),
      ).toEqual({
        year: null,
        rating: null,
        genres: [],
        plot: null,
        enriched: false,
        ratingSource: null,
      });

      // Fills all missing fields from enrichment and sets enriched: true
      expect(
        mergeVodEnrichment({ year: null, rating: null, genres: [], plot: '   ' }, enrichment),
      ).toEqual({
        year: 2010,
        rating: 8.8,
        genres: ['Sci-Fi', 'Thriller'],
        plot: 'A thief steals corporate secrets through dream-sharing technology.',
        enriched: true,
        ratingSource: 'local-index',
      });

      // Never overwrites existing provider fields; enriched stays false when provider had everything
      expect(
        mergeVodEnrichment(
          {
            year: 2026,
            rating: 9.1,
            genres: ['Drama'],
            plot: 'Provider synopsis.',
          },
          enrichment,
        ),
      ).toEqual({
        year: 2026,
        rating: 9.1,
        genres: ['Drama'],
        plot: 'Provider synopsis.',
        enriched: false,
        ratingSource: null,
      });

      // Partial fill: keeps provider year/plot, fills missing rating & genres
      expect(
        mergeVodEnrichment(
          {
            year: 2010,
            rating: null,
            genres: [],
            plot: 'Provider synopsis.',
          },
          enrichment,
        ),
      ).toEqual({
        year: 2010,
        rating: 8.8,
        genres: ['Sci-Fi', 'Thriller'],
        plot: 'Provider synopsis.',
        enriched: true,
        ratingSource: 'local-index',
      });
    });
  });
});
