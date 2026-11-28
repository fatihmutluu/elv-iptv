import type { PersistedTrackPreference, SaveProgressInput, WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import type {
  ClockAnchor,
  MediaTracks,
  PlaybackClock,
  PlaybackService,
  PlaybackState,
  PlaybackStatus,
  PlaybackTimers,
} from '@elv/playback';
import { EMPTY_TRACKS } from '@elv/playback';
import { act, renderHook } from '@testing-library/react-native';
import { useRef } from 'react';
import type { PlayTarget } from '../../ports/play-target';
import { useInitialTrackSelection } from '../usePlayerTrackAndDecoderSync';
import { useWatchProgressSync } from '../useWatchProgressSync';

function makeSavedRow(input: SaveProgressInput): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: input.sourceId,
    itemKey: input.itemKey,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle ?? null,
    logo: input.logo ?? null,
    seriesKey: input.seriesKey ?? null,
    season: input.season ?? null,
    episode: input.episode ?? null,
    positionMs: input.positionMs,
    durationMs: input.durationMs,
    watched: input.watched ?? false,
    updatedAt: 1_700_000_000_000,
  };
}

function makeFakeService(initial: { item: string; status: PlaybackStatus; anchor?: ClockAnchor }): {
  service: PlaybackService;
  setState: (next: { status: PlaybackStatus; anchor?: ClockAnchor }) => void;
} {
  let state: PlaybackState = {
    status: initial.status,
    attempt: 1,
    item: initial.item,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
    ...(initial.anchor === undefined ? {} : { anchor: initial.anchor }),
  };
  const service = {
    getState: () => state,
  } as unknown as PlaybackService;
  return {
    service,
    setState(next) {
      const { anchor: _drop, ...rest } = state;
      state = {
        ...rest,
        status: next.status,
        ...(next.anchor === undefined ? {} : { anchor: next.anchor }),
      };
    },
  };
}

describe('Wave Q4: useWatchProgressSync premature VOD EOF handling', () => {
  const movieTarget: PlayTarget = {
    itemKey: 'x:s1:vod:900',
    sourceId: 's1',
    title: 'Long Feature Film',
    kind: 'vod',
    itemKind: 'movie',
  };

  it('persists lastPos with watched: false (never overwriting with durationMs) on premature VOD ended', async () => {
    const now = 50_000;
    const saveProgress = jest.fn(async (input: SaveProgressInput) => ok(makeSavedRow(input)));
    const fake = makeFakeService({
      item: movieTarget.itemKey,
      status: { kind: 'playing' },
      anchor: { positionMs: 1_200_000, atMs: now, rate: 0, durationMs: 5_400_000 },
    });
    const clock: PlaybackClock = { now: () => now };
    const timers: PlaybackTimers = {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };

    const { rerender, unmount } = await renderHook(
      (props: { status: PlaybackStatus }) => {
        const serviceRef = useRef<PlaybackService | null>(fake.service);
        const catalogRef = useRef({
          resolveStream: jest.fn(),
          saveProgress,
        });
        const clockRef = useRef(clock);
        const timersRef = useRef(timers);
        return useWatchProgressSync({
          activeTarget: movieTarget,
          status: props.status,
          serviceRef,
          catalogRef,
          clockRef,
          timersRef,
        });
      },
      { initialProps: { status: { kind: 'playing' } as PlaybackStatus } },
    );

    // Second consecutive premature EOF at 20 min / 90 min -> status becomes ended
    fake.setState({
      status: { kind: 'ended' },
      anchor: { positionMs: 1_200_000, atMs: now, rate: 0, durationMs: 5_400_000 },
    });
    await rerender({ status: { kind: 'ended' } });

    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: movieTarget.itemKey,
        positionMs: 1_200_000,
        durationMs: 5_400_000,
        watched: false,
      }),
    );

    await unmount();
  });

  it('explicitly persists watched: false even when premature EOF happens past 90% (>1% remaining on a 2h movie)', async () => {
    const now = 50_000;
    const saveProgress = jest.fn(async (input: SaveProgressInput) => ok(makeSavedRow(input)));
    // 6,624,000 / 7,200,000 = 92%, remaining = 576,000 ms (9.6 min > 72,000 ms 1% threshold)
    const fake = makeFakeService({
      item: movieTarget.itemKey,
      status: { kind: 'playing' },
      anchor: { positionMs: 6_624_000, atMs: now, rate: 0, durationMs: 7_200_000 },
    });
    const clock: PlaybackClock = { now: () => now };
    const timers: PlaybackTimers = {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };

    const { rerender, unmount } = await renderHook(
      (props: { status: PlaybackStatus }) => {
        const serviceRef = useRef<PlaybackService | null>(fake.service);
        const catalogRef = useRef({
          resolveStream: jest.fn(),
          saveProgress,
        });
        const clockRef = useRef(clock);
        const timersRef = useRef(timers);
        return useWatchProgressSync({
          activeTarget: movieTarget,
          status: props.status,
          serviceRef,
          catalogRef,
          clockRef,
          timersRef,
        });
      },
      { initialProps: { status: { kind: 'playing' } as PlaybackStatus } },
    );

    fake.setState({
      status: { kind: 'ended' },
      anchor: { positionMs: 6_624_000, atMs: now, rate: 0, durationMs: 7_200_000 },
    });
    await rerender({ status: { kind: 'ended' } });

    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        positionMs: 6_624_000,
        durationMs: 7_200_000,
        watched: false,
      }),
    );

    await unmount();
  });

  it('preserves watched: true at durationMs when VOD genuinely reaches EOF', async () => {
    const now = 50_000;
    const saveProgress = jest.fn(async (input: SaveProgressInput) => ok(makeSavedRow(input)));
    const fake = makeFakeService({
      item: movieTarget.itemKey,
      status: { kind: 'playing' },
      anchor: { positionMs: 7_150_000, atMs: now, rate: 0, durationMs: 7_200_000 },
    });
    const clock: PlaybackClock = { now: () => now };
    const timers: PlaybackTimers = {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };

    const { rerender, unmount } = await renderHook(
      (props: { status: PlaybackStatus }) => {
        const serviceRef = useRef<PlaybackService | null>(fake.service);
        const catalogRef = useRef({
          resolveStream: jest.fn(),
          saveProgress,
        });
        const clockRef = useRef(clock);
        const timersRef = useRef(timers);
        return useWatchProgressSync({
          activeTarget: movieTarget,
          status: props.status,
          serviceRef,
          catalogRef,
          clockRef,
          timersRef,
        });
      },
      { initialProps: { status: { kind: 'playing' } as PlaybackStatus } },
    );

    fake.setState({
      status: { kind: 'ended' },
      anchor: { positionMs: 7_150_000, atMs: now, rate: 0, durationMs: 7_200_000 },
    });
    await rerender({ status: { kind: 'ended' } });

    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        positionMs: 7_200_000,
        durationMs: 7_200_000,
        watched: true,
      }),
    );

    await unmount();
  });
});

describe('Wave Q4: useInitialTrackSelection Live TV subtitle default-off', () => {
  const DVB_TRACKS: MediaTracks = {
    audio: [
      { id: 'a-en', language: 'eng', label: 'English', isDefault: true },
      { id: 'a-tr', language: 'tur', label: 'Turkish' },
    ],
    subtitles: [
      { id: 's-tr', language: 'tur', label: 'DVB Turkish', isDefault: true },
      { id: 's-en', language: 'eng', label: 'Teletext English' },
    ],
    selectedAudioId: 'a-en',
    selectedSubtitleId: 's-tr',
  };

  it('forces live subtitles to null even with subtitleMode always/smart and preferred subtitle languages', async () => {
    const selectAudioTrack = jest.fn();
    const selectSubtitleTrack = jest.fn();
    const service = {
      selectAudioTrack,
      selectSubtitleTrack,
      setAudioDelay: jest.fn(),
      setSubtitleDelay: jest.fn(),
      getState: () => ({ item: 'live:ch:1' }),
    } as unknown as PlaybackService;

    const liveTarget: PlayTarget = {
      itemKey: 'live:ch:1',
      sourceId: 's1',
      title: 'Broadcast One',
      kind: 'live',
    };

    const { unmount } = await renderHook(() =>
      useInitialTrackSelection({
        activeService: service,
        activeTarget: liveTarget,
        tracks: DVB_TRACKS,
        preferredAudioLanguages: ['tr'],
        preferredSubtitleLanguages: ['tr', 'en'],
        subtitleMode: 'always',
        fallbackLocale: 'tr-TR',
      }),
    );

    expect(selectAudioTrack).toHaveBeenCalledWith('a-tr');
    expect(selectSubtitleTrack).toHaveBeenCalledWith(null);
    await unmount();
  });

  it('still honors explicit per-channel persisted subtitle preference on live channels', async () => {
    const selectAudioTrack = jest.fn();
    const selectSubtitleTrack = jest.fn();
    const service = {
      selectAudioTrack,
      selectSubtitleTrack,
      setAudioDelay: jest.fn(),
      setSubtitleDelay: jest.fn(),
      getState: () => ({ item: 'live:ch:2' }),
    } as unknown as PlaybackService;

    const liveTarget: PlayTarget = {
      itemKey: 'live:ch:2',
      sourceId: 's1',
      title: 'Broadcast Two',
      kind: 'live',
    };
    const persistedPref: PersistedTrackPreference = {
      profileId: 'default',
      sourceId: 's1',
      scopeKey: 'live:ch:2',
      audioLang: null,
      audioLabel: null,
      subLang: 'en',
      subLabel: 'Teletext English',
      subDisabled: false,
      resizeMode: null,
      audioDelayMs: 0,
      subDelayMs: 0,
      updatedAt: 1_000,
    };

    const catalog = { getTrackPreference: jest.fn(async () => persistedPref) };
    const preferredSubtitleLanguages = ['tr'] as const;

    const { unmount } = await renderHook(() =>
      useInitialTrackSelection({
        activeService: service,
        activeTarget: liveTarget,
        tracks: DVB_TRACKS,
        catalog,
        preferredSubtitleLanguages,
        subtitleMode: 'smart',
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(selectSubtitleTrack).toHaveBeenCalledWith('s-en');
    await unmount();
  });
});
