import { createAppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackService,
  type PlaybackState,
} from '@elv/playback';
import { buildTheme, I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { PlayableEntry } from '../../ports/play-target';
import { NextEpisodeBanner } from '../NextEpisodeBanner';
import { PlayerSettingsSheet } from '../PlayerSettingsSheet';
import { PlayerStatsHud } from '../PlayerStatsHud';
import { VodProgressBar } from '../VodProgressBar';

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'eng', label: 'English', codec: 'ac3', channels: 6 },
  ],
  subtitles: [
    { id: 's:1', language: 'tur' },
    { id: 's:2', language: 'eng' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:2',
};

const NEXT_EPISODE: PlayableEntry = {
  itemKey: 'x:src-1:episode:102',
  sourceId: 'src-1',
  title: 'Pilot Part 2',
  kind: 'vod',
  season: 1,
  episode: 2,
  subtitle: 'S1 E2 · Awakening',
};

function createFakePlaybackService(initial?: Partial<PlaybackState>) {
  let state: PlaybackState = {
    status: { kind: 'playing' },
    attempt: 1,
    tracks: SAMPLE_TRACKS,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
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
    setAnchor(anchor: ClockAnchor | undefined) {
      const { anchor: _drop, ...rest } = state;
      state = anchor === undefined ? rest : { ...rest, anchor };
      for (const listener of [...listeners]) listener(state);
    },
  };
}

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('VodProgressBar tokenization and dimming', () => {
  it('renders live theme accent fill, thumb, tabular time, and dims cleanly when dimmed', async () => {
    const fake = createFakePlaybackService({
      anchor: { positionMs: 30_000, atMs: 1_000, rate: 0, durationMs: 120_000 },
    });
    const view = await render(
      <ThemeProvider preset="highContrast">
        <VodProgressBar
          service={fake.service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          label="Progress"
          dimmed
          onSeekRatio={jest.fn()}
        />
      </ThemeProvider>,
    );

    const hc = buildTheme({ preset: 'highContrast' }).colors;
    expect(flatStyle('player-progress-fill')?.backgroundColor).toBe(hc.textPrimary);
    expect(flatStyle('player-progress-rail')?.backgroundColor).toBe(hc.actionGlassBorder);
    expect(flatStyle('player-progress-time')?.color).toBe(hc.textSecondary);
    expect(flatStyle('player-progress-time')?.fontVariant).toEqual(['tabular-nums']);
    expect(flatStyle('player-progress-time-current')?.color).toBe(hc.textPrimary);
    expect(flatStyle('player-progress-row')?.opacity).toBe(0.2);

    await view.rerender(
      <ThemeProvider preset="highContrast">
        <VodProgressBar
          service={fake.service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          label="Progress"
          dimmed={false}
          onSeekRatio={jest.fn()}
        />
      </ThemeProvider>,
    );
    expect(flatStyle('player-progress-row')?.opacity).toBe(1);
    await view.unmount();
  });
});

describe('PlayerSettingsSheet 2-level menu', () => {
  function settingsEl(
    overrides: Partial<Parameters<typeof PlayerSettingsSheet>[0]> & {
      preset?: 'obsidianCrimson' | 'highContrast';
    } = {},
  ) {
    const i18n = overrides.i18n ?? createAppI18n('en');
    const preset = overrides.preset ?? 'obsidianCrimson';
    return (
      <ThemeProvider preset={preset}>
        <I18nProvider i18n={i18n}>
          <PlayerSettingsSheet
            visible
            menuState={{ view: 'root', index: 0 }}
            tracks={SAMPLE_TRACKS}
            statsVisible={false}
            isTv={false}
            formFactor="desktop"
            i18n={i18n}
            onOpenView={jest.fn()}
            onSelectAudio={jest.fn()}
            onSelectSubtitle={jest.fn()}
            onToggleStats={jest.fn()}
            onClose={jest.fn()}
            {...overrides}
          />
        </I18nProvider>
      </ThemeProvider>
    );
  }

  it('returns null when hidden', async () => {
    const view = await render(settingsEl({ visible: false }));
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    await view.unmount();
  });

  it('renders flex-docked panel on desktop and AdaptiveSheet on phone/tv, navigating both levels', async () => {
    const onOpenView = jest.fn();
    const onSelectAudio = jest.fn();
    const onSelectSubtitle = jest.fn();
    const onToggleStats = jest.fn();
    const onClose = jest.fn();
    const handlers = { onOpenView, onSelectAudio, onSelectSubtitle, onToggleStats, onClose };
    const hcTheme = buildTheme({ preset: 'highContrast' });

    const view = await render(settingsEl({ ...handlers, preset: 'highContrast' }));

    expect(screen.queryByTestId('player-settings-sheet')).toBeNull();
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    expect(flatStyle('player-settings-row-subtitles')?.borderColor).toBe(
      hcTheme.colors.focusRingColor,
    );
    expect(screen.getByTestId('player-settings-row-subtitles')).toHaveTextContent(/English/);
    expect(screen.getByTestId('player-settings-row-audio')).toHaveTextContent(/Turkish/);
    expect(screen.getByTestId('player-stats-toggle').props.accessibilityRole).toBe('switch');
    expect(screen.getByTestId('player-stats-toggle').props.accessibilityState).toEqual({
      checked: false,
    });
    expect(screen.getByTestId('player-stats-toggle')).toHaveTextContent(/Off/);

    await fireEvent.press(screen.getByTestId('player-settings-row-subtitles'));
    expect(onOpenView).toHaveBeenCalledWith('subtitles');
    await fireEvent.press(screen.getByTestId('player-settings-row-audio'));
    expect(onOpenView).toHaveBeenCalledWith('audio');
    await fireEvent.press(screen.getByTestId('player-stats-toggle'));
    expect(onToggleStats).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('player-settings-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await view.rerender(
      settingsEl({
        ...handlers,
        preset: 'highContrast',
        menuState: { view: 'subtitles', index: 2 },
        statsVisible: true,
        formFactor: 'phone',
      }),
    );

    expect(screen.getByTestId('player-settings-sheet')).toBeTruthy();
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-settings-sub-off'));
    expect(onSelectSubtitle).toHaveBeenCalledWith(null);
    await fireEvent.press(screen.getByTestId('player-settings-sub-s:1'));
    expect(onSelectSubtitle).toHaveBeenCalledWith('s:1');
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    expect(onOpenView).toHaveBeenCalledWith('root');

    await view.rerender(
      settingsEl({
        ...handlers,
        menuState: { view: 'audio', index: 1 },
        statsVisible: true,
        isTv: true,
        formFactor: 'tv',
      }),
    );
    await fireEvent.press(screen.getByTestId('player-settings-audio-a:2'));
    expect(onSelectAudio).toHaveBeenCalledWith('a:2');

    await view.rerender(
      settingsEl({ ...handlers, menuState: { view: 'audio', index: 0 }, tracks: EMPTY_TRACKS }),
    );
    expect(screen.getByTestId('player-settings-panel')).toHaveTextContent(/No audio track/);
    await view.unmount();
  });

  it('renders Deinterlace switch row only when onToggleDeinterlace is provided and syncs checked state (#131)', async () => {
    const onToggleDeinterlace = jest.fn();
    const hcTheme = buildTheme({ preset: 'highContrast' });

    const view = await render(settingsEl({ preset: 'highContrast' }));
    expect(screen.queryByTestId('player-deinterlace-toggle')).toBeNull();

    await view.rerender(
      settingsEl({
        preset: 'highContrast',
        menuState: { view: 'advanced', index: 0 },
        deinterlace: false,
        onToggleDeinterlace,
      }),
    );

    const toggle = screen.getByTestId('player-deinterlace-toggle');
    expect(toggle.props.accessibilityRole).toBe('switch');
    expect(toggle.props.accessibilityState).toEqual({ checked: false });
    expect(toggle).toHaveTextContent(/Deinterlace/);
    expect(toggle).toHaveTextContent(/Off/);
    expect(flatStyle('player-deinterlace-toggle')?.borderColor).toBe(hcTheme.colors.focusRingColor);

    await fireEvent.press(toggle);
    expect(onToggleDeinterlace).toHaveBeenCalledTimes(1);

    await view.rerender(
      settingsEl({
        preset: 'highContrast',
        menuState: { view: 'advanced', index: 0 },
        deinterlace: true,
        onToggleDeinterlace,
        i18n: createAppI18n('tr'),
      }),
    );
    const toggleTr = screen.getByTestId('player-deinterlace-toggle');
    expect(toggleTr.props.accessibilityState).toEqual({ checked: true });
    expect(toggleTr).toHaveTextContent(/Deinterlace/);
    expect(toggleTr).toHaveTextContent(/Açık/);
    expect(flatStyle('player-deinterlace-toggle')?.borderColor).toBe(hcTheme.colors.focusRingColor);

    await view.rerender(
      settingsEl({
        preset: 'highContrast',
        menuState: { view: 'root', index: 2 },
        deinterlace: true,
        onToggleDeinterlace,
        i18n: createAppI18n('tr'),
      }),
    );
    expect(flatStyle('player-stats-toggle')?.borderColor).toBe(hcTheme.colors.focusRingColor);

    await view.unmount();
  });
});

describe('PlayerStatsHud zero-overhead subscription and live telemetry', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('subscribes zero listeners when hidden and renders live monospace telemetry when visible', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    let now = 5_000;
    const clock = { now: () => now };
    const fake = createFakePlaybackService({
      tuneAt: 4_000,
      firstFrameAt: 4_350,
      anchor: { positionMs: 10_000, atMs: now, rate: 1, durationMs: 120_000 },
    });
    const i18n = createAppI18n('en');

    const view = await render(
      <PlayerStatsHud
        visible={false}
        service={fake.service}
        clock={clock}
        i18n={i18n}
        isDesktop={false}
      />,
    );

    expect(screen.queryByTestId('player-stats-hud')).toBeNull();
    expect(fake.subscribeSpy).not.toHaveBeenCalled();

    await view.rerender(
      <PlayerStatsHud visible service={fake.service} clock={clock} i18n={i18n} isDesktop={false} />,
    );

    const hud = screen.getByTestId('player-stats-hud');
    expect(hud.props.pointerEvents).toBe('none');
    expect(hud).toHaveTextContent(/Playing · 0:10 \/ 2:00/);
    expect(hud).toHaveTextContent(/AAC 2\.0 Turkish/);
    expect(hud).toHaveTextContent(/First frame 350 ms/);

    await act(async () => {
      now += 1_001;
      jest.advanceTimersByTime(1_001);
    });
    expect(screen.getByTestId('player-stats-hud')).toHaveTextContent(/Playing · 0:11 \/ 2:00/);

    // Desktop docks in normal flow (no absolute positioning over native HWND)
    await view.rerender(
      <PlayerStatsHud visible service={fake.service} clock={clock} i18n={i18n} isDesktop />,
    );
    expect(flatStyle('player-stats-hud')?.position).toBeUndefined();

    await view.rerender(
      <PlayerStatsHud visible={false} service={fake.service} clock={clock} i18n={i18n} isDesktop />,
    );
    expect(fake.listenerCount()).toBe(0);
    await view.unmount();
  });
});

describe('NextEpisodeBanner gated ticker and actions', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not subscribe when no nextEpisode or dismissed, and reveals on threshold or ended', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const now = 1_000;
    const clock = { now: () => now };
    const fake = createFakePlaybackService({
      anchor: { positionMs: 50_000, atMs: now, rate: 1, durationMs: 100_000 },
    });
    const i18n = createAppI18n('en');
    const onPlayNext = jest.fn();
    const onDismiss = jest.fn();
    const onVisibilityChange = jest.fn();

    const view = await render(
      <NextEpisodeBanner
        nextEpisode={undefined}
        statusKind="playing"
        dismissed={false}
        service={fake.service}
        clock={clock}
        isTv={false}
        i18n={i18n}
        onPlayNext={onPlayNext}
        onDismiss={onDismiss}
        onVisibilityChange={onVisibilityChange}
      />,
    );

    expect(screen.queryByTestId('player-next-episode-banner')).toBeNull();
    expect(fake.subscribeSpy).not.toHaveBeenCalled();

    // Below threshold (50% of 100s)
    await view.rerender(
      <NextEpisodeBanner
        nextEpisode={NEXT_EPISODE}
        statusKind="playing"
        dismissed={false}
        service={fake.service}
        clock={clock}
        isTv={false}
        i18n={i18n}
        onPlayNext={onPlayNext}
        onDismiss={onDismiss}
        onVisibilityChange={onVisibilityChange}
      />,
    );

    expect(screen.queryByTestId('player-next-episode-banner')).toBeNull();
    expect(onVisibilityChange).not.toHaveBeenCalled();

    // Crosses 90% threshold (91s / 100s)
    await act(async () => {
      fake.setAnchor({ positionMs: 91_000, atMs: now, rate: 1, durationMs: 100_000 });
    });

    expect(screen.getByTestId('player-next-episode-banner')).toBeTruthy();
    expect(screen.getByTestId('player-next-episode')).toHaveTextContent('Next: S1 E2 · Awakening');
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    await fireEvent.press(screen.getByTestId('player-next-episode'));
    expect(onPlayNext).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('player-next-episode-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Dismissing unmounts ticker and notifies false
    await view.rerender(
      <NextEpisodeBanner
        nextEpisode={NEXT_EPISODE}
        statusKind="playing"
        dismissed
        service={fake.service}
        clock={clock}
        isTv={false}
        i18n={i18n}
        onPlayNext={onPlayNext}
        onDismiss={onDismiss}
        onVisibilityChange={onVisibilityChange}
      />,
    );
    expect(screen.queryByTestId('player-next-episode-banner')).toBeNull();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
    expect(fake.listenerCount()).toBe(0);

    // Shows on ended status even with fallback S/E label
    await view.rerender(
      <NextEpisodeBanner
        nextEpisode={{ ...NEXT_EPISODE, subtitle: undefined }}
        statusKind="ended"
        dismissed={false}
        service={fake.service}
        clock={clock}
        isTv
        tvFocused
        i18n={i18n}
        onPlayNext={onPlayNext}
        onDismiss={onDismiss}
        onVisibilityChange={onVisibilityChange}
      />,
    );
    expect(screen.getByTestId('player-next-episode')).toHaveTextContent('Next: S1 E2');
    expect(screen.getByTestId('player-next-episode-focus-ring')).toBeTruthy();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    await view.unmount();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });
});
