import { elvError } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS, type PlaybackState } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import type { LiveChannelPlaylist, PlayableEntry, PlayTarget } from '../ports/play-target';
import {
  buildNextEpisodeTarget,
  buildPreviousChannelTarget,
  formatStatsHudLines,
  NEXT_EPISODE_MIN_DURATION_MS,
  NEXT_EPISODE_RATIO_THRESHOLD,
  NEXT_EPISODE_REMAINING_MS,
  shouldShowNextEpisodePrompt,
} from './player-overlay-model';

const i18nEn = createAppI18n('en');

const EP2: PlayableEntry = {
  itemKey: 'x:s1:ep:2',
  sourceId: 's1',
  title: 'Starlight Harbor — E2 · Drift',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:s1:series:301',
  season: 1,
  episode: 2,
  subtitle: 'S1 E2 · Drift',
  logo: 'https://img.invalid/backdrop.jpg',
  startPositionMs: 12_000,
};

const EP3: PlayableEntry = {
  itemKey: 'x:s1:ep:3',
  sourceId: 's1',
  title: 'Starlight Harbor — E3 · Signal',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:s1:series:301',
  season: 1,
  episode: 3,
  subtitle: 'S1 E3 · Signal',
  logo: 'https://img.invalid/backdrop.jpg',
  startPositionMs: 0,
};

const BASE_EP_TARGET: PlayTarget = {
  itemKey: 'x:s1:ep:1',
  sourceId: 's1',
  title: 'Starlight Harbor — E1 · Pilot',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:s1:series:301',
  season: 1,
  episode: 1,
  subtitle: 'S1 E1 · Pilot',
  startPositionMs: 30_000,
  nextEpisodes: [EP2, EP3],
};

function makeState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    status: { kind: 'playing' },
    attempt: 3,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 2,
    ...overrides,
  };
}

describe('player-overlay-model', () => {
  it('exports the expected Next Episode threshold constants', () => {
    expect(NEXT_EPISODE_RATIO_THRESHOLD).toBe(0.9);
    expect(NEXT_EPISODE_REMAINING_MS).toBe(45_000);
    expect(NEXT_EPISODE_MIN_DURATION_MS).toBe(120_000);
  });

  describe('shouldShowNextEpisodePrompt', () => {
    it('returns false when there is no next episode or prompt was dismissed', () => {
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 100_000,
          durationMs: 100_000,
          statusKind: 'ended',
          hasNextEpisode: false,
          dismissed: false,
        }),
      ).toBe(false);
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 100_000,
          durationMs: 100_000,
          statusKind: 'ended',
          hasNextEpisode: true,
          dismissed: true,
        }),
      ).toBe(false);
    });

    it('returns true immediately when playback ended even with zero or unknown duration', () => {
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 0,
          durationMs: 0,
          statusKind: 'ended',
          hasNextEpisode: true,
          dismissed: false,
        }),
      ).toBe(true);
    });

    it('triggers at >= 90% progress regardless of duration', () => {
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 53_999,
          durationMs: 60_000,
          statusKind: 'playing',
          hasNextEpisode: true,
          dismissed: false,
        }),
      ).toBe(false);
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 54_000,
          durationMs: 60_000,
          statusKind: 'playing',
          hasNextEpisode: true,
          dismissed: false,
        }),
      ).toBe(true);
    });

    it('triggers within final 45s only when duration >= 120s', () => {
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 30_000,
          durationMs: 60_000,
          statusKind: 'playing',
          hasNextEpisode: true,
          dismissed: false,
        }),
      ).toBe(false);
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 74_999,
          durationMs: 120_000,
          statusKind: 'playing',
          hasNextEpisode: true,
          dismissed: false,
        }),
      ).toBe(false);
      expect(
        shouldShowNextEpisodePrompt({
          positionMs: 75_000,
          durationMs: 120_000,
          statusKind: 'playing',
          hasNextEpisode: true,
          dismissed: false,
        }),
      ).toBe(true);
    });

    it('guards NaN, Infinity, zero, and negative positions or durations safely', () => {
      for (const bad of [
        { positionMs: Number.NaN, durationMs: 200_000 },
        { positionMs: 190_000, durationMs: Number.NaN },
        { positionMs: Number.POSITIVE_INFINITY, durationMs: 200_000 },
        { positionMs: 190_000, durationMs: Number.POSITIVE_INFINITY },
        { positionMs: -1, durationMs: 200_000 },
        { positionMs: 100_000, durationMs: 0 },
        { positionMs: 100_000, durationMs: -200_000 },
      ]) {
        expect(
          shouldShowNextEpisodePrompt({
            ...bad,
            statusKind: 'playing',
            hasNextEpisode: true,
            dismissed: false,
          }),
        ).toBe(false);
      }
    });
  });

  describe('buildNextEpisodeTarget', () => {
    it('pops nextEpisodes[0] with startPositionMs 0 and preserves remaining episodes', () => {
      const next = buildNextEpisodeTarget(BASE_EP_TARGET);
      expect(next).toEqual({
        ...EP2,
        startPositionMs: 0,
        nextEpisodes: [EP3],
      });

      const finalNext = next !== null ? buildNextEpisodeTarget(next) : null;
      expect(finalNext).toEqual({
        ...EP3,
        startPositionMs: 0,
      });
      expect(finalNext !== null && 'nextEpisodes' in finalNext).toBe(false);
      expect(finalNext !== null ? buildNextEpisodeTarget(finalNext) : null).toBeNull();
    });

    it('returns null when nextEpisodes is absent or empty', () => {
      expect(buildNextEpisodeTarget({ ...BASE_EP_TARGET, nextEpisodes: undefined })).toBeNull();
      expect(buildNextEpisodeTarget({ ...BASE_EP_TARGET, nextEpisodes: [] })).toBeNull();
    });
  });

  describe('buildPreviousChannelTarget', () => {
    const playlist: LiveChannelPlaylist = {
      count: 10,
      currentIndex: 2,
      getAt: async () => undefined,
      onChangeIndex: () => undefined,
    };

    const prevEntry: PlayableEntry = {
      itemKey: 'x:s1:live:2',
      sourceId: 's1',
      title: '2. Sports One',
      kind: 'live',
      itemKind: 'live',
      logo: 'https://img.invalid/ch2.png',
    };

    const chA: PlayTarget = {
      itemKey: 'x:s1:live:1',
      sourceId: 's1',
      title: '1. Studio News',
      kind: 'live',
      itemKind: 'live',
      logo: 'https://img.invalid/ch1.png',
      playlist,
      previousChannel: prevEntry,
    };

    it('swaps previousChannel into active target, preserves playlist, and stores flat current copy', () => {
      const swapped = buildPreviousChannelTarget(chA);
      expect(swapped).not.toBeNull();
      expect(swapped?.itemKey).toBe('x:s1:live:2');
      expect(swapped?.title).toBe('2. Sports One');
      expect(swapped?.playlist).toBe(playlist);
      expect(swapped?.previousChannel).toEqual({
        itemKey: 'x:s1:live:1',
        sourceId: 's1',
        title: '1. Studio News',
        kind: 'live',
        itemKind: 'live',
        logo: 'https://img.invalid/ch1.png',
      });
      expect('playlist' in (swapped?.previousChannel ?? {})).toBe(false);
      expect('previousChannel' in (swapped?.previousChannel ?? {})).toBe(false);
    });

    it('swaps playlist.currentIndex with previousChannelIndex when valid and ignores out-of-range indices', () => {
      const withIdx = buildPreviousChannelTarget({ ...chA, previousChannelIndex: 7 });
      expect(withIdx?.playlist?.currentIndex).toBe(7);
      expect(withIdx?.previousChannelIndex).toBe(2);

      const roundTrip = withIdx ? buildPreviousChannelTarget(withIdx) : null;
      expect(roundTrip?.playlist?.currentIndex).toBe(2);
      expect(roundTrip?.previousChannelIndex).toBe(7);

      const outOfRange = buildPreviousChannelTarget({ ...chA, previousChannelIndex: 99 });
      expect(outOfRange?.playlist).toBe(playlist);
      expect(outOfRange?.previousChannelIndex).toBe(2);
    });

    it('returns null when previousChannel is missing or points to the same item', () => {
      expect(buildPreviousChannelTarget({ ...chA, previousChannel: undefined })).toBeNull();
      expect(
        buildPreviousChannelTarget({
          ...chA,
          previousChannel: { ...prevEntry, itemKey: chA.itemKey },
        }),
      ).toBeNull();
    });
  });

  describe('formatStatsHudLines', () => {
    it('formats 3 real telemetry lines with VOD clock, audio codec/channels/language, subtitle, latency, attempt, and dropped count', () => {
      const state = makeState({
        status: { kind: 'playing' },
        attempt: 5,
        staleEventsDropped: 4,
        tuneAt: 10_000,
        firstFrameAt: 10_420,
        anchor: { positionMs: 65_000, atMs: 20_000, rate: 1, durationMs: 3_665_000 },
        tracks: {
          audio: [{ id: 'a1', language: 'eng', codec: 'aac', channels: 6 }],
          subtitles: [{ id: 's1', language: 'tur' }],
          selectedAudioId: 'a1',
          selectedSubtitleId: 's1',
        },
      });

      const lines = formatStatsHudLines(state, 25_000, i18nEn);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('Playing · 1:10 / 1:01:05');
      expect(lines[1]).toBe('Audio: AAC 5.1 English · Subtitles: Turkish');
      expect(lines[2]).toBe('First frame 420 ms · #5 · stale 4');
    });

    it('handles live streams, missing audio/subtitles, missing latency, and all status variants cleanly', () => {
      const state = makeState({
        status: { kind: 'recovering', rung: 2, nextAtMs: 5_000 },
        attempt: 1,
        staleEventsDropped: 0,
        anchor: { positionMs: 42_000, atMs: 10_000, rate: 1 },
        tracks: EMPTY_TRACKS,
      });

      const lines = formatStatsHudLines(state, 10_000, i18nEn);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('Reconnecting (step 2)… · 0:42');
      expect(lines[1]).toBe('Audio: No audio track · Subtitles: Off');
      expect(lines[2]).toBe('#1 · stale 0');

      const failed = formatStatsHudLines(
        makeState({
          status: { kind: 'failed', error: elvError('network', 'unreachable') },
          anchor: undefined,
        }),
        0,
        i18nEn,
      );
      expect(failed[0]).toContain('--:--');
      expect(failed[0]).toContain('Could not reach the stream server.');

      const statusChecks: readonly [PlaybackState['status'], string][] = [
        [{ kind: 'idle' }, 'Idle'],
        [{ kind: 'tuning' }, 'Tuning…'],
        [{ kind: 'paused' }, 'Paused'],
        [{ kind: 'ended' }, 'Ended'],
        [{ kind: 'limited', nextAtMs: 1_000 }, 'Waiting for active connection slot…'],
      ];
      for (const [status, expectedPrefix] of statusChecks) {
        const res = formatStatsHudLines(makeState({ status }), 0, i18nEn);
        expect(res[0]).toContain(expectedPrefix);
      }

      const layouts = [
        { channels: 1, label: '1.0' },
        { channels: 2, label: '2.0' },
        { channels: 8, label: '7.1' },
        { channels: 4, label: '4ch' },
      ];
      for (const { channels, label } of layouts) {
        const res = formatStatsHudLines(
          makeState({
            tracks: {
              audio: [{ id: 'a', channels, label: 'Director' }],
              subtitles: [{ id: 's', label: 'CC' }],
              selectedAudioId: 'a',
              selectedSubtitleId: 's',
            },
          }),
          0,
          i18nEn,
        );
        expect(res[1]).toContain(`${label} Director`);
        expect(res[1]).toContain('Subtitles: CC');
      }

      const idFallback = formatStatsHudLines(
        makeState({
          tracks: {
            audio: [{ id: 'a-raw' }],
            subtitles: [{ id: 's-raw' }],
            selectedAudioId: 'a-raw',
            selectedSubtitleId: 's-raw',
          },
        }),
        0,
        i18nEn,
      );
      expect(idFallback[1]).toBe('Audio: a-raw · Subtitles: s-raw');
    });
  });
});
