import type { NowNextEntry } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService, PlaybackState, StreamVideoInfo } from '@elv/playback';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { PlayerStatsHud } from '../PlayerStatsHud';

const FULL_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', label: 'English Surround', codec: 'ac3', channels: 6 },
    { id: 'a:2', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
  ],
  subtitles: [{ id: 's:1', language: 'tur', label: 'Turkish' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
};

const UHD_VIDEO: StreamVideoInfo = {
  width: 3840,
  height: 2160,
  fps: 59.94,
  codec: 'hevc',
  hdr: 'hdr10',
};

const NOW_START_MS = new Date(2026, 10, 28, 20, 0).getTime();
const NOW_STOP_MS = new Date(2026, 10, 28, 21, 0).getTime();

const NOW_NEXT: NowNextEntry = {
  channelKey: 'live:src-1:ch-1',
  now: {
    channelKey: 'live:src-1:ch-1',
    sourceId: 'src-1',
    guideId: 'ch-1',
    title: 'Evening Chronicle',
    subTitle: null,
    description: 'Live studio broadcast and weather digest.',
    episodeNum: null,
    icon: null,
    genre: 'news',
    flags: 0,
    start: NOW_START_MS,
    stop: NOW_STOP_MS,
  },
  next: {
    channelKey: 'live:src-1:ch-1',
    sourceId: 'src-1',
    guideId: 'ch-1',
    title: 'Late Night Cinema',
    subTitle: null,
    description: null,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
    start: new Date(2026, 10, 28, 21, 0).getTime(),
    stop: new Date(2026, 10, 28, 23, 0).getTime(),
  },
};

function createFakePlaybackService(initial?: Partial<PlaybackState>) {
  let state: PlaybackState = {
    status: { kind: 'playing' },
    attempt: 1,
    tracks: FULL_TRACKS,
    videoInfo: UHD_VIDEO,
    droppedFrames: 2,
    tuneAt: 4_000,
    firstFrameAt: 4_250,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
    anchor: { positionMs: 10_000, atMs: 5_000, rate: 1, durationMs: 120_000 },
    ...initial,
  };
  const listeners = new Set<(s: PlaybackState) => void>();
  const subscribeSpy = jest.fn((listener: (s: PlaybackState) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const service = {
    getState: () => state,
    subscribe: subscribeSpy,
  } as unknown as PlaybackService;

  return {
    service,
    subscribeSpy,
    listenerCount: () => listeners.size,
    update(patch: Partial<PlaybackState>) {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state);
    },
  };
}

function wrap(
  node: ReactElement,
  opts?: {
    overscanX?: number;
    overscanY?: number;
    safeTop?: number;
    safeLeft?: number;
    safeRight?: number;
    width?: number;
    height?: number;
    formFactor?: 'tv' | 'phone' | 'tablet' | 'desktop';
  },
) {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n('en')}>
        <ViewportProvider
          overscanX={opts?.overscanX ?? 0}
          overscanY={opts?.overscanY ?? 0}
          value={{
            formFactor: opts?.formFactor ?? 'tv',
            orientation: (opts?.height ?? 1000) > (opts?.width ?? 1000) ? 'portrait' : 'landscape',
            width: opts?.width ?? 1000,
            height: opts?.height ?? 1000,
            safeArea: {
              top: opts?.safeTop ?? 0,
              right: opts?.safeRight ?? 0,
              bottom: 0,
              left: opts?.safeLeft ?? 0,
            },
          }}
        >
          {node}
        </ViewportProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

describe('PlayerStatsHud merged Programme Info + Quality Badges + Telemetry (Wave R4)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('subscribes nothing when hidden and cleanly cleans up listeners when unmounted or toggled off', async () => {
    const rafSpy = jest.spyOn(globalThis, 'requestAnimationFrame');
    const fake = createFakePlaybackService();
    const i18n = createAppI18n('en');

    const view = await render(
      wrap(
        <PlayerStatsHud
          visible={false}
          service={fake.service}
          clock={{ now: () => 5_000 }}
          i18n={i18n}
          isDesktop={false}
        />,
      ),
    );

    expect(screen.queryByTestId('player-stats-hud')).toBeNull();
    expect(fake.subscribeSpy).not.toHaveBeenCalled();
    expect(rafSpy).not.toHaveBeenCalled();

    await view.rerender(
      wrap(
        <PlayerStatsHud
          visible
          service={fake.service}
          clock={{ now: () => 5_000 }}
          i18n={i18n}
          isDesktop={false}
        />,
      ),
    );
    expect(screen.getByTestId('player-stats-hud')).toBeTruthy();
    expect(fake.listenerCount()).toBe(2);

    await view.rerender(
      wrap(
        <PlayerStatsHud
          visible={false}
          service={fake.service}
          clock={{ now: () => 5_000 }}
          i18n={i18n}
          isDesktop={false}
        />,
      ),
    );
    expect(fake.listenerCount()).toBe(0);
    await view.unmount();
  });

  it('displays Live EPG Now/Next window, clamped progress, Up Next, decoded MicroPill quality badges, and 1Hz telemetry', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    let now = 5_000;
    const fake = createFakePlaybackService({
      anchor: { positionMs: 10_000, atMs: now, rate: 1, durationMs: 120_000 },
    });
    const i18n = createAppI18n('en');
    const midEpoch = NOW_START_MS + 15 * 60 * 1000; // 25%

    const view = await render(
      wrap(
        <PlayerStatsHud
          visible
          osdVisible
          service={fake.service}
          clock={{ now: () => now }}
          i18n={i18n}
          isDesktop={false}
          title="1. Channel One"
          isVod={false}
          nowNext={NOW_NEXT}
          nowMs={midEpoch}
        />,
        { overscanX: 0.05, overscanY: 0.04, safeTop: 12, safeLeft: 8 },
      ),
    );

    const hudStyle = StyleSheet.flatten(screen.getByTestId('player-stats-hud').props.style);
    expect(hudStyle.position).toBe('absolute');
    // osdVisible true -> topOffset 96 + safeTop 12 + overscanY 40 = 148
    expect(hudStyle.top).toBe(148);
    expect(hudStyle.left).toBe(16 + 8 + 50);

    // Live programme block
    expect(screen.getByTestId('player-stats-now-window')).toHaveTextContent('20:00–21:00');
    expect(screen.getByTestId('player-stats-now-title')).toHaveTextContent('Evening Chronicle');
    expect(screen.getByTestId('player-stats-now-desc')).toHaveTextContent(
      'Live studio broadcast and weather digest.',
    );
    expect(screen.getByTestId('player-stats-up-next')).toHaveTextContent(
      'Up next: Late Night Cinema',
    );
    expect(
      StyleSheet.flatten(screen.getByTestId('player-stats-progress-fill').props.style)?.width,
    ).toBe('25%');

    // Decoded MicroPill stream quality badges
    expect(screen.getByTestId('player-stats-badge-resolution')).toHaveTextContent('4K · 3840×2160');
    expect(screen.getByTestId('player-stats-badge-fps')).toHaveTextContent('59.94 fps');
    expect(screen.getByTestId('player-stats-badge-vcodec')).toHaveTextContent('HEVC');
    expect(screen.getByTestId('player-stats-badge-hdr')).toHaveTextContent('HDR10');
    expect(screen.getByTestId('player-stats-badge-audio')).toHaveTextContent('AC3 5.1');
    expect(screen.getByTestId('player-stats-badge-subtitle')).toHaveTextContent(
      'Subtitles: Turkish',
    );

    // Monospace telemetry block + 1Hz tick
    expect(screen.getByTestId('player-stats-telemetry')).toHaveTextContent(
      /Playing · 0:10 \/ 2:00/,
    );
    expect(screen.getByTestId('player-stats-telemetry')).toHaveTextContent(/First frame 250 ms/);
    expect(screen.getByTestId('player-stats-telemetry')).toHaveTextContent(/Dropped frames: 2/);

    await act(async () => {
      now += 1_001;
      jest.advanceTimersByTime(1_001);
    });
    expect(screen.getByTestId('player-stats-telemetry')).toHaveTextContent(
      /Playing · 0:11 \/ 2:00/,
    );

    // Clamps EPG progress at 100% past stop time & adjusts top when OSD hides
    await view.rerender(
      wrap(
        <PlayerStatsHud
          visible
          osdVisible={false}
          service={fake.service}
          clock={{ now: () => now }}
          i18n={i18n}
          isDesktop={false}
          title="1. Channel One"
          isVod={false}
          nowNext={NOW_NEXT}
          nowMs={NOW_STOP_MS + 10_000}
        />,
      ),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId('player-stats-progress-fill').props.style)?.width,
    ).toBe('100%');
    expect(StyleSheet.flatten(screen.getByTestId('player-stats-hud').props.style)?.top).toBe(16);

    await view.unmount();
  });

  it('displays VOD title/subtitle, omits quality pills when telemetry missing, and docks cleanly on child-HWND desktop', async () => {
    const fake = createFakePlaybackService({
      videoInfo: undefined,
      tracks: {
        audio: [],
        subtitles: [],
        selectedAudioId: null,
        selectedSubtitleId: null,
      },
    });
    const i18n = createAppI18n('en');

    const view = await render(
      wrap(
        <PlayerStatsHud
          visible
          service={fake.service}
          clock={{ now: () => 5_000 }}
          i18n={i18n}
          isDesktop
          docked
          isVod
          title="Cinema Feature"
          subtitle="S1 E3 · Opening Night"
        />,
      ),
    );

    const hudStyle = StyleSheet.flatten(screen.getByTestId('player-stats-hud').props.style);
    expect(hudStyle.position).toBeUndefined();
    expect(hudStyle.borderRadius).toBe(0);

    expect(screen.getByTestId('player-stats-title')).toHaveTextContent('Cinema Feature');
    expect(screen.getByTestId('player-stats-subtitle')).toHaveTextContent('S1 E3 · Opening Night');
    expect(screen.queryByTestId('player-stats-now-title')).toBeNull();
    expect(screen.queryByTestId('player-stats-quality')).toBeNull();
    expect(screen.queryByTestId('player-stats-no-programme')).toBeNull();

    // Live stream without EPG now/next or title falls back cleanly to player.noProgrammeInfo
    await view.rerender(
      wrap(
        <PlayerStatsHud
          visible
          service={fake.service}
          clock={{ now: () => 5_000 }}
          i18n={i18n}
          isDesktop={false}
          isVod={false}
          nowNext={null}
        />,
      ),
    );
    expect(screen.getByTestId('player-stats-no-programme')).toHaveTextContent(
      'No programme information available',
    );

    // Narrow portrait phone viewport bounds right edge so floating HUD never overflows horizontally
    await view.rerender(
      wrap(
        <PlayerStatsHud
          visible
          service={fake.service}
          clock={{ now: () => 5_000 }}
          i18n={i18n}
          isDesktop={false}
          isVod
          title="Narrow Phone Stream"
        />,
        {
          formFactor: 'phone',
          width: 390,
          height: 844,
          safeLeft: 6,
          safeRight: 10,
          overscanX: 0,
        },
      ),
    );
    const narrowStyle = StyleSheet.flatten(screen.getByTestId('player-stats-hud').props.style);
    expect(narrowStyle.left).toBe(22);
    expect(narrowStyle.right).toBe(26);
    expect(narrowStyle.maxWidth).toBe(500);

    await view.unmount();
  });
});
