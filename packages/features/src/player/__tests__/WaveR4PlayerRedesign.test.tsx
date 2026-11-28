import type { LiveVariantOption } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { useDesktopDialogTrap } from '../desktop-dialog-trap';
import { PLAYER_KEY_SHORTCUTS } from '../PlayerOsdButton';
import { PlayerScreen } from '../PlayerScreen';
import { PlayerSettingsSheet } from '../PlayerSettingsSheet';
import { advancedSettingsItems } from '../settings-menu-nav';
import { buildOrderedAdvancedEntries } from '../settings-sheet-items';
import { createManualClock } from './player-test-harness';

jest.mock('../desktop-dialog-trap', () => {
  const actual = jest.requireActual(
    '../desktop-dialog-trap',
  ) as typeof import('../desktop-dialog-trap');
  return {
    ...actual,
    useDesktopDialogTrap: jest.fn(actual.useDesktopDialogTrap),
  };
});

const FULL_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'tur', label: 'Turkish', codec: 'ac3', channels: 6 },
  ],
  subtitles: [
    { id: 's:1', language: 'eng', label: 'English' },
    { id: 's:2', language: 'tur', label: 'Turkish' },
  ],
  videoQualities: [
    { id: 'q:1080', label: '1080p', height: 1080, width: 1920, bitrateBps: 6_000_000 },
    { id: 'q:720', label: '720p', height: 720, width: 1280, bitrateBps: 3_000_000 },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
  selectedVideoQualityId: 'q:1080',
};

const SINGLE_QUALITY_TRACKS: MediaTracks = {
  ...FULL_TRACKS,
  videoQualities: [{ id: 'q:1080', label: '1080p', height: 1080, width: 1920 }],
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:vod:77',
  sourceId: 'src-1',
  title: 'Horizon Station',
  subtitle: 'S1 E1 · Signal',
  kind: 'vod',
};

const PRIMARY_LIVE_CHANNEL: PlayableEntry = {
  itemKey: 'ch:1',
  sourceId: 'src-1',
  title: '1. Studio News',
  kind: 'live',
};

const LIVE_CHANNELS: readonly PlayableEntry[] = [
  PRIMARY_LIVE_CHANNEL,
  { itemKey: 'ch:2', sourceId: 'src-1', title: '2. Cinema One', kind: 'live' },
];

const LIVE_TARGET: PlayTarget = {
  ...PRIMARY_LIVE_CHANNEL,
  previousChannel: LIVE_CHANNELS[1],
  previousChannelIndex: 1,
  playlist: {
    count: LIVE_CHANNELS.length,
    currentIndex: 0,
    getAt: async (i) => LIVE_CHANNELS[i],
    onChangeIndex: jest.fn(),
  },
};

function wrapViewport(node: ReactElement, formFactor: FormFactor, width: number, height: number) {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n('en')}>
        <FormFactorProvider value={formFactor}>
          <ViewportProvider
            value={{
              formFactor,
              orientation: height > width ? 'portrait' : 'landscape',
              inputModality:
                formFactor === 'tv' ? 'tv' : formFactor === 'phone' ? 'touch' : 'pointer',
              width,
              height,
            }}
          >
            {node}
          </ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function flatStyle(testID: string, includeHidden = false) {
  return StyleSheet.flatten(
    screen.getByTestId(testID, { includeHiddenElements: includeHidden }).props.style,
  );
}

describe('Wave R4 Player Redesign & Cleanup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes X-Ray, Chapters, Always-on-Top, TrackPickerModal, PlayerInfoSheet, TimeDisplay menu row, and top-bar Multi-View', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        setDeinterlace: jest.fn(),
        setAudioDevice: jest.fn(),
        getAudioDevices: () => [{ name: 'auto', description: 'Default' }],
        getActiveAudioDevice: () => 'auto',
        renderSurface: () => <View testID="fake-surface" />,
      }),
    };

    const view = await render(
      wrapViewport(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
            ),
          }}
          videoHost={videoHost}
          target={VOD_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          multiViewSupported
          onEnterMultiView={jest.fn()}
          onMinimizeToMiniPlayer={jest.fn()}
          onPopoutPlayer={jest.fn()}
          onToggleAutoPlayNextEpisode={jest.fn()}
          onExit={jest.fn()}
        />,
        'desktop',
        1280,
        720,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt, type: 'tracks', tracks: FULL_TRACKS });
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 15_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
      });
    });

    // Top bar omits legacy Multi-View, X-Ray, TrackPicker, Always-on-Top, and Chapters buttons
    expect(screen.queryByTestId('player-multiview-button')).toBeNull();
    expect(screen.queryByTestId('player-xray-button')).toBeNull();
    expect(screen.queryByTestId('player-xray-strip')).toBeNull();
    expect(screen.queryByTestId('player-tracks-button')).toBeNull();
    expect(screen.queryByTestId('player-always-on-top-button')).toBeNull();
    expect(screen.queryByTestId('player-prev-chapter')).toBeNull();
    expect(screen.queryByTestId('player-next-chapter')).toBeNull();
    expect(screen.queryByTestId('player-chapter-dot-0')).toBeNull();
    expect('alwaysOnTop' in PLAYER_KEY_SHORTCUTS).toBe(false);

    // Scaled desktop OSD icon buttons (~1.7–2x)
    expect(flatStyle('player-back')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-subtitles-button')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-audio-button')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-window-mode-button')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-settings-button')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-seek-back')).toMatchObject({ width: 68, height: 68 });
    expect(flatStyle('player-play-pause')).toMatchObject({ width: 80, height: 80 });
    expect(flatStyle('player-seek-forward')).toMatchObject({ width: 68, height: 68 });
    expect(flatStyle('player-progress-rail')).toMatchObject({ height: 5 });
    expect(flatStyle('player-progress-thumb')).toMatchObject({ width: 16, height: 16 });
    expect(flatStyle('player-progress-time-current')).toMatchObject({ fontSize: 14 });
    expect(flatStyle('player-progress-time')).toMatchObject({ fontSize: 14 });

    // Open root settings and confirm streamlined rows + removed legacy rows
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.getByTestId('player-settings-row-subtitles')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-audio')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-speed')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-video-quality')).toBeTruthy();
    expect(screen.getByTestId('player-resize-mode-toggle')).toBeTruthy();
    expect(screen.getByTestId('player-settings-multiview')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-sleep-timer')).toBeTruthy();
    expect(screen.getByTestId('player-stats-toggle')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-advanced')).toBeTruthy();

    expect(screen.queryByTestId('player-info-button')).toBeNull();
    expect(screen.queryByTestId('player-info-panel')).toBeNull();
    expect(screen.queryByTestId('player-time-display-toggle')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-chapters')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-xray')).toBeNull();
    expect(screen.queryByTestId('player-always-on-top-button')).toBeNull();
    expect(screen.queryByTestId('player-deinterlace-toggle')).toBeNull();
    expect(screen.queryByTestId('player-auto-play-next-toggle')).toBeNull();

    // Pressing 't' (former always-on-top shortcut) is a strict no-op
    const pauseCountBeforeT = engine.commands.filter((c) => c.name === 'pause').length;
    const onKeyDown = screen.getByTestId('player-screen', { includeHiddenElements: true }).props
      .onKeyDown as (e: { key: string; preventDefault?: () => void }) => void;
    await act(async () => {
      onKeyDown?.({ key: 't', preventDefault: jest.fn() });
    });
    expect(engine.commands.filter((c) => c.name === 'pause')).toHaveLength(pauseCountBeforeT);

    await view.unmount();
  });

  it('uses safe smaller OSD scale on narrow portrait phones and hides quality row when <= 1 option exists', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });

    const view = await render(
      wrapViewport(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
            ),
          }}
          videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
          target={VOD_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onMinimizeToMiniPlayer={jest.fn()}
          onExit={jest.fn()}
        />,
        'phone',
        390,
        844,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt, type: 'tracks', tracks: SINGLE_QUALITY_TRACKS });
    });

    expect(flatStyle('player-back')).toMatchObject({ width: 44, height: 44 });
    expect(flatStyle('player-subtitles-button')).toMatchObject({ width: 44, height: 44 });
    expect(flatStyle('player-audio-button')).toMatchObject({ width: 44, height: 44 });
    expect(flatStyle('player-settings-button')).toMatchObject({ width: 44, height: 44 });
    expect(flatStyle('player-seek-back')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-play-pause')).toMatchObject({ width: 60, height: 60 });
    expect(flatStyle('player-seek-forward')).toMatchObject({ width: 52, height: 52 });

    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-settings-row-video-quality')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-quality')).toBeNull();

    await view.unmount();
  });

  it('merges Mini-Player + Popout into PlayerWindowModePopover, dismisses floating/docked overlays via backdrop without pausing, and steps delay/2-level nav', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
      capabilities: {
        audioDelay: true,
        subtitleDelay: true,
        videoQualitySelection: true,
      },
    });
    const onMinimizeToMiniPlayer = jest.fn();
    const onPopoutPlayer = jest.fn();
    const singleVariant: readonly LiveVariantOption[] = [
      { key: 'ch:1', title: 'HD', qualityLabel: '1080p', qualityRank: 1080 },
    ];
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        setDeinterlace: jest.fn(),
        renderSurface: () => <View testID="fake-surface" />,
      }),
    };

    const view = await render(
      wrapViewport(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/live/ch1.ts', headers: {} }),
            ),
            liveVariants: jest.fn(async () => singleVariant),
          }}
          videoHost={videoHost}
          target={LIVE_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          androidDecoderMode="auto"
          onSelectAndroidDecoderMode={jest.fn()}
          onMinimizeToMiniPlayer={onMinimizeToMiniPlayer}
          onPopoutPlayer={onPopoutPlayer}
          onExit={jest.fn()}
        />,
        'desktop',
        1280,
        720,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt, type: 'state', state: 'playing' });
      engine.emit({ attempt, type: 'tracks', tracks: FULL_TRACKS });
    });

    // Live OSD zap buttons scaled up + action pill minHeight >= 46
    expect(flatStyle('player-prev')).toMatchObject({ width: 60, height: 60 });
    expect(flatStyle('player-next')).toMatchObject({ width: 60, height: 60 });
    expect(flatStyle('player-prev-channel')).toMatchObject({ width: 52, height: 52 });
    expect(flatStyle('player-channel-list-button')).toMatchObject({ minHeight: 46 });

    // Single live variant is suppressed from root Settings
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-settings-row-quality')).toBeNull();

    // Backdrop click on floating desktop Settings closes popup without pausing playback
    const pauseBefore = engine.commands.filter((c) => c.name === 'pause').length;
    await fireEvent.press(
      screen.getByTestId('player-settings-backdrop', { includeHiddenElements: true }),
    );
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    expect(engine.commands.filter((c) => c.name === 'pause')).toHaveLength(pauseBefore);

    // Merged Window Mode popover opens 2 options and dismisses on click-outside backdrop
    await fireEvent.press(screen.getByTestId('player-window-mode-button'));
    expect(screen.getByTestId('player-window-mode-popover')).toBeTruthy();
    expect(screen.getByTestId('player-window-mode-mini')).toHaveTextContent('Mini player');
    expect(screen.getByTestId('player-window-mode-popout')).toHaveTextContent('Separate window');

    await fireEvent.press(
      screen.getByTestId('player-window-mode-backdrop', { includeHiddenElements: true }),
    );
    expect(screen.queryByTestId('player-window-mode-popover')).toBeNull();
    expect(onMinimizeToMiniPlayer).not.toHaveBeenCalled();
    expect(onPopoutPlayer).not.toHaveBeenCalled();

    // Selecting each Window Mode option closes popover and triggers its callback
    await fireEvent.press(screen.getByTestId('player-window-mode-button'));
    await fireEvent.press(screen.getByTestId('player-window-mode-mini'));
    expect(screen.queryByTestId('player-window-mode-popover')).toBeNull();
    expect(onMinimizeToMiniPlayer).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('player-window-mode-button'));
    await fireEvent.press(screen.getByTestId('player-window-mode-popout'));
    expect(screen.queryByTestId('player-window-mode-popover')).toBeNull();
    expect(onPopoutPlayer).toHaveBeenCalledTimes(1);

    // Live Channel Drawer backdrop closes without pausing
    await fireEvent.press(screen.getByTestId('player-channel-list-button'));
    expect(screen.getByTestId('player-channel-drawer-desktop')).toBeTruthy();
    await fireEvent.press(
      screen.getByTestId('player-channel-drawer-backdrop', { includeHiddenElements: true }),
    );
    expect(screen.queryByTestId('player-channel-drawer-desktop')).toBeNull();
    expect(engine.commands.filter((c) => c.name === 'pause')).toHaveLength(pauseBefore);

    // 2-level Subtitles -> Subtitle settings delay stepper & back arrow -> Subtitles (not root)
    await fireEvent.press(screen.getByTestId('player-subtitles-button'));
    await fireEvent.press(screen.getByTestId('player-settings-open-subtitle-settings'));
    await fireEvent.press(screen.getByTestId('player-settings-subtitle-delay-plus-100'));
    expect(engine.commands.filter((c) => c.name === 'setSubtitleDelay').at(-1)?.delayMs).toBe(100);
    await fireEvent.press(screen.getByTestId('player-settings-subtitle-delay-reset'));
    expect(engine.commands.filter((c) => c.name === 'setSubtitleDelay').at(-1)?.delayMs).toBe(0);
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    expect(screen.getByTestId('player-settings-open-subtitle-settings')).toBeTruthy();

    // Back -> Root -> Audio -> Audio settings delay stepper -> Back -> Audio
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    await fireEvent.press(screen.getByTestId('player-settings-row-audio'));
    await fireEvent.press(screen.getByTestId('player-settings-open-audio-settings'));
    await fireEvent.press(screen.getByTestId('player-settings-audio-delay-minus-500'));
    expect(engine.commands.filter((c) => c.name === 'setAudioDelay').at(-1)?.delayMs).toBe(-500);
    await fireEvent.press(screen.getByTestId('player-settings-audio-delay-reset'));
    expect(engine.commands.filter((c) => c.name === 'setAudioDelay').at(-1)?.delayMs).toBe(0);
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    expect(screen.getByTestId('player-settings-open-audio-settings')).toBeTruthy();

    // Advanced -> Video decoder -> Back -> Advanced -> Back -> Root
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    await fireEvent.press(screen.getByTestId('player-settings-row-advanced'));
    expect(screen.getByTestId('player-deinterlace-toggle')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-settings-row-video-decoder'));
    expect(screen.getByTestId('player-settings-decoder-auto')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    expect(screen.getByTestId('player-deinterlace-toggle')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    expect(screen.getByTestId('player-settings-row-advanced')).toBeTruthy();

    await view.unmount();
  });

  it('handles single-option window mode callback, dock-popout button, and docked desktop stage backdrop dismissal', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onMinimizeOnly = jest.fn();
    const onDockPopout = jest.fn();

    // Case 1: Only onMinimizeToMiniPlayer -> triggers callback directly without popover, and docked stage backdrop closes settings
    const view = await render(
      wrapViewport(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/vod.mp4', headers: {} }),
            ),
          }}
          videoHost={{
            open: () => ({
              engine,
              overlayMode: 'docked',
              renderSurface: () => <View testID="fake-surface" />,
            }),
          }}
          target={VOD_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onMinimizeToMiniPlayer={onMinimizeOnly}
          onExit={jest.fn()}
        />,
        'desktop',
        1280,
        720,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await fireEvent.press(screen.getByTestId('player-window-mode-button'));
    expect(screen.queryByTestId('player-window-mode-popover')).toBeNull();
    expect(onMinimizeOnly).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-docked-stage-backdrop'));
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    await view.unmount();

    // Case 2: Popout window (`onDockPopout` set) -> renders player-dock-popout-button cleanly
    const popoutView = await render(
      wrapViewport(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/vod.mp4', headers: {} }),
            ),
          }}
          videoHost={{
            open: () => ({
              engine,
              overlayMode: 'floating',
              renderSurface: () => <View testID="fake-surface" />,
            }),
          }}
          target={VOD_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onDockPopout={onDockPopout}
          onExit={jest.fn()}
        />,
        'desktop',
        1280,
        720,
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('player-dock-popout-button')).toBeTruthy();
    });
    expect(screen.queryByTestId('player-window-mode-button')).toBeNull();
    await fireEvent.press(screen.getByTestId('player-dock-popout-button'));
    expect(onDockPopout).toHaveBeenCalledTimes(1);
    await popoutView.unmount();
  });

  it('passes modal: false in docked desktop PlayerSettingsSheet (leaving stage backdrop interactive) and modal: true when floating', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const trapMock = useDesktopDialogTrap as jest.Mock;
    trapMock.mockClear();
    const i18n = createAppI18n('en');

    const baseProps = {
      visible: true,
      menuState: { view: 'root' as const, index: 0 },
      tracks: FULL_TRACKS,
      statsVisible: false,
      isTv: false,
      formFactor: 'desktop' as const,
      i18n,
      onOpenView: jest.fn(),
      onSelectAudio: jest.fn(),
      onSelectSubtitle: jest.fn(),
      onToggleStats: jest.fn(),
      onClose: jest.fn(),
    };

    const view = await render(
      wrapViewport(<PlayerSettingsSheet {...baseProps} docked />, 'desktop', 1280, 720),
    );
    expect(trapMock).toHaveBeenLastCalledWith(expect.any(Object), true, expect.any(Function), {
      modal: false,
    });

    await view.rerender(
      wrapViewport(<PlayerSettingsSheet {...baseProps} docked={false} />, 'desktop', 1280, 720),
    );
    expect(trapMock).toHaveBeenLastCalledWith(expect.any(Object), true, expect.any(Function), {
      modal: true,
    });

    await view.unmount();
  });

  it('keeps 1:1 parity between advancedSettingsItems and buildOrderedAdvancedEntries across VOD and Live', () => {
    const i18n = createAppI18n('en');
    for (const isVod of [true, false]) {
      const navOpts = {
        isVod,
        hasDeinterlace: true,
        hasVideoDecoder: true,
        androidDecoderMode: 'auto' as const,
        hasAudioNormalization: true,
        hasPitchLock: true,
        hasAutoPlayNextEpisode: true,
        hasPip: true,
      };
      const navItems = advancedSettingsItems(navOpts);
      const renderedItems = buildOrderedAdvancedEntries({
        isVod,
        deinterlaceMode: 'auto',
        onCycleDeinterlaceMode: jest.fn(),
        androidDecoderMode: 'auto',
        onSelectAndroidDecoderMode: jest.fn(),
        audioNormalization: false,
        onToggleAudioNormalization: jest.fn(),
        pitchLock: false,
        onTogglePitchLock: jest.fn(),
        autoPlayNextEpisode: true,
        onToggleAutoPlayNextEpisode: jest.fn(),
        onEnterPip: jest.fn(),
        i18n,
        onClose: jest.fn(),
      });
      expect(renderedItems).toHaveLength(navItems.length);
    }
  });

  it('steps down top bar utility icons on compact 480x270 desktop popout windows to avoid overflow', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const view = await render(
      wrapViewport(
        <PlayerScreen
          catalog={{
            resolveStream: jest.fn(async () =>
              ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
            ),
          }}
          videoHost={{
            open: () => ({
              engine,
              overlayMode: 'floating',
              renderSurface: () => <View testID="fake-surface" />,
            }),
          }}
          target={VOD_TARGET}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onDockPopout={jest.fn()}
          onExit={jest.fn()}
        />,
        'desktop',
        480,
        270,
      ),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({ attempt, type: 'tracks', tracks: FULL_TRACKS });
    });

    expect(flatStyle('player-back')).toMatchObject({ width: 40, height: 40 });
    expect(flatStyle('player-subtitles-button')).toMatchObject({ width: 40, height: 40 });
    expect(flatStyle('player-audio-button')).toMatchObject({ width: 40, height: 40 });
    expect(flatStyle('player-dock-popout-button')).toMatchObject({ width: 40, height: 40 });
    expect(flatStyle('player-settings-button')).toMatchObject({ width: 40, height: 40 });

    await view.unmount();
  });
});
