import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { FloatingMiniPlayerChrome } from '../FloatingMiniPlayerChrome';
import { PlayerScreen } from '../PlayerScreen';
import { PlayerSettingsSheet } from '../PlayerSettingsSheet';
import { routeSettingsMenuKey, settingsRowCount } from '../settings-menu-nav';
import { SLEEP_TIMER_PRESETS_MIN } from '../sleep-timer';

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 720,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
};

const LIVE_TARGET: PlayTarget = {
  itemKey: 'live:src-1:101',
  sourceId: 'src-1',
  accountKey: 'acct-1',
  title: 'Channel One',
  kind: 'live',
  itemKind: 'live',
};

function wrap(node: ReactElement, locale: 'en' | 'tr' = 'en', viewport = DESKTOP_VIEWPORT) {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n(locale)}>
        <FormFactorProvider value={viewport.formFactor}>
          <ViewportProvider value={viewport}>{node}</ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function installWebWindow(options: { pointerEvents?: boolean } = {}) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 720,
    document: { activeElement: null as unknown },
    addEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    }),
    removeEventListener: jest.fn((type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    }),
  };
  if (options.pointerEvents !== false) {
    win.PointerEvent = function PointerEvent() {};
  }
  const globals = globalThis as unknown as { window?: unknown };
  const prev = globals.window;
  globals.window = win;
  return {
    win,
    async emit(type: string, event: Record<string, unknown>) {
      await act(async () => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
          fn(event);
        }
      });
    },
    restore() {
      globals.window = prev;
    },
  };
}

describe('Wave P2 — Aspect Fade Badge, Context-Aware Overflow Menu & Interactive Mini-Player', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows localized aspect ratio OSD badge on resize mode cycle and hides after hold + fade (and immediately after hold with reduceMotion)', async () => {
    jest.useFakeTimers();
    const engine = createFakePlayerEngine({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };

    const view = await render(
      wrap(
        <PlayerScreen
          catalog={{
            resolveStream: async () =>
              ok({
                url: 'http://sim.example.test/live/101.m3u8',
                kind: 'live',
                headers: {},
                sourceId: 'src-1',
              }),
            getProgress: async () => null,
            saveProgress: async () => ok({} as never),
          }}
          videoHost={videoHost}
          target={LIVE_TARGET}
          reduceMotion
          onExit={jest.fn()}
        />,
        'tr',
      ),
    );

    await waitFor(() => expect(screen.getByTestId('player-settings-button')).toBeTruthy());
    expect(screen.queryByTestId('player-aspect-toast')).toBeNull();

    // Open settings and cycle aspect ratio (fit -> fill -> "Doldur")
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-resize-mode-toggle'));

    expect(screen.getByTestId('player-aspect-toast')).toHaveTextContent('Doldur');

    // Rapid second click resets timer and cycles to "Uzat"
    await act(async () => {
      jest.advanceTimersByTime(800);
    });
    await fireEvent.press(screen.getByTestId('player-resize-mode-toggle'));
    expect(screen.getByTestId('player-aspect-toast')).toHaveTextContent('Uzat');

    // Still visible 600ms after reset (< 1100ms)
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(screen.getByTestId('player-aspect-toast')).toBeTruthy();

    // Hidden after full 1100ms hold when reduceMotion is on
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId('player-aspect-toast')).toBeNull();

    await view.unmount();
  });

  it('strictly separates Live vs VOD overflow menu rows and hides Sleep Timer Pause action on Live TV', async () => {
    const commonProps = {
      visible: true,
      menuState: { view: 'root' as const, index: 0 },
      tracks: EMPTY_TRACKS,
      qualityVariants: [
        { key: 'q1', title: 'HD', qualityLabel: '1080p', qualityRank: 1080 },
        { key: 'q2', title: 'SD', qualityLabel: '720p', qualityRank: 720 },
      ],
      activeQualityKey: 'q1',
      statsVisible: false,
      isTv: false,
      formFactor: 'desktop' as const,
      i18n: createAppI18n('en'),
      onOpenView: jest.fn(),
      onSelectAudio: jest.fn(),
      onSelectSubtitle: jest.fn(),
      onToggleResizeMode: jest.fn(),
      onTogglePitchLock: jest.fn(),
      onToggleAutoPlayNextEpisode: jest.fn(),
      onEnterMultiView: jest.fn(),
      onSelectSleepTimer: jest.fn(),
      onToggleSleepTimerAction: jest.fn(),
      onToggleStats: jest.fn(),
      onClose: jest.fn(),
    };

    // Live TV root menu (clean essential rows, zero chapters/time display)
    const liveView = await render(wrap(<PlayerSettingsSheet {...commonProps} isVod={false} />));
    expect(screen.queryByTestId('player-pitch-lock-toggle')).toBeNull();
    expect(screen.queryByTestId('player-time-display-toggle')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-speed')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-chapters')).toBeNull();
    expect(screen.queryByTestId('player-auto-subtitles-skip-back-toggle')).toBeNull();
    expect(screen.queryByTestId('player-auto-play-next-toggle')).toBeNull();
    expect(screen.getByTestId('player-settings-row-quality')).toBeTruthy();
    expect(screen.getByTestId('player-settings-multiview')).toBeTruthy();
    await liveView.unmount();

    // Live TV sleep timer sub-view hides Pause action toggle
    const liveSleep = await render(
      wrap(
        <PlayerSettingsSheet
          {...commonProps}
          isVod={false}
          menuState={{ view: 'sleepTimer', index: 0 }}
        />,
      ),
    );
    expect(screen.queryByTestId('player-settings-sleep-action')).toBeNull();
    expect(screen.getByTestId('player-settings-sleep-15')).toBeTruthy();
    await liveSleep.unmount();

    // Keyboard nav for Live sleepTimer maps index 0 directly to preset 0 (Off), not toggleSleepTimerAction
    expect(
      settingsRowCount('sleepTimer', EMPTY_TRACKS, { isVod: false, hasSleepTimer: true }),
    ).toBe(SLEEP_TIMER_PRESETS_MIN.length);
    expect(settingsRowCount('sleepTimer', EMPTY_TRACKS, { isVod: true, hasSleepTimer: true })).toBe(
      SLEEP_TIMER_PRESETS_MIN.length + 1,
    );
    expect(
      routeSettingsMenuKey(
        { kind: 'press', key: 'select', time: 0 },
        { view: 'sleepTimer', index: 0 },
        EMPTY_TRACKS,
        { isVod: false, hasSleepTimer: true },
      ),
    ).toEqual({ kind: 'sleepTimer', minutes: 0 });

    // VOD root menu shows Speed + Multi-View + Advanced settings (pitchLock & autoPlayNext moved to level-2 Advanced)
    const vodView = await render(wrap(<PlayerSettingsSheet {...commonProps} isVod />));
    expect(screen.getByTestId('player-settings-row-speed')).toBeTruthy();
    expect(screen.getByTestId('player-settings-row-advanced')).toBeTruthy();
    expect(screen.queryByTestId('player-time-display-toggle')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-chapters')).toBeNull();
    expect(screen.queryByTestId('player-auto-subtitles-skip-back-toggle')).toBeNull();
    expect(screen.queryByTestId('player-settings-row-quality')).toBeNull();
    // Wave P5: Cross-media Multi-View is available on Movies & Series as well as Live TV
    expect(screen.getByTestId('player-settings-multiview')).toBeTruthy();
    await vodView.unmount();

    // VOD Advanced settings sub-view exposes Pitch Lock & Auto-play Next Episode
    const vodAdvanced = await render(
      wrap(
        <PlayerSettingsSheet {...commonProps} isVod menuState={{ view: 'advanced', index: 0 }} />,
      ),
    );
    expect(screen.getByTestId('player-pitch-lock-toggle')).toBeTruthy();
    expect(screen.getByTestId('player-auto-play-next-toggle')).toBeTruthy();
    await vodAdvanced.unmount();

    // VOD sleep timer sub-view shows Pause action toggle
    const vodSleep = await render(
      wrap(
        <PlayerSettingsSheet {...commonProps} isVod menuState={{ view: 'sleepTimer', index: 0 }} />,
      ),
    );
    expect(screen.getByTestId('player-settings-sleep-action')).toBeTruthy();
    await vodSleep.unmount();
  });

  it('applies pointer hover fill on SettingsRow and SettingsToggleRow', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const view = await render(
      wrap(
        <PlayerSettingsSheet
          visible
          menuState={{ view: 'root', index: 99 }}
          tracks={EMPTY_TRACKS}
          isVod
          statsVisible={false}
          isTv={false}
          formFactor="desktop"
          i18n={createAppI18n('en')}
          onOpenView={jest.fn()}
          onSelectAudio={jest.fn()}
          onSelectSubtitle={jest.fn()}
          onToggleResizeMode={jest.fn()}
          onToggleStats={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );

    const navRow = screen.getByTestId('player-settings-row-subtitles');
    const beforeBg = StyleSheet.flatten(navRow.props.style).backgroundColor;
    expect(beforeBg).toBe('transparent');

    await fireEvent(navRow, 'hoverIn');
    const hoveredStyle = StyleSheet.flatten(
      screen.getByTestId('player-settings-row-subtitles').props.style,
    );
    expect(hoveredStyle.backgroundColor).not.toBe('transparent');
    expect((hoveredStyle as unknown as { transitionDuration?: string }).transitionDuration).toBe(
      '150ms',
    );

    await fireEvent(navRow, 'hoverOut');
    expect(
      StyleSheet.flatten(screen.getByTestId('player-settings-row-subtitles').props.style)
        .backgroundColor,
    ).toBe('transparent');

    await view.unmount();
  });

  it('supports drag-to-move corner snapping, suppresses expand click on drag >= 5px, and resizes 16:9 frame via inward corner grip', async () => {
    const webWin = installWebWindow();
    const engine = createFakePlayerEngine({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const onExpand = jest.fn();
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };

    try {
      const view = await render(
        wrap(
          <PlayerScreen
            catalog={{
              resolveStream: async () =>
                ok({
                  url: 'http://sim.example.test/live/101.m3u8',
                  kind: 'live',
                  headers: {},
                  sourceId: 'src-1',
                }),
              getProgress: async () => null,
              saveProgress: async () => ok({} as never),
            }}
            videoHost={videoHost}
            target={LIVE_TARGET}
            viewMode="mini"
            reduceMotion
            onExpandMiniPlayer={onExpand}
            onExit={jest.fn()}
          />,
        ),
      );

      await waitFor(() => expect(screen.getByTestId('floating-mini-player')).toBeTruthy());
      const initialStyle = StyleSheet.flatten(
        screen.getByTestId('floating-mini-player').props.style,
      );
      expect(initialStyle.width).toBe(320);
      expect(initialStyle.height).toBe(180);

      // West resize edge drags left by 80px (docked bottom-right) -> grows cleanly to 400x225
      const resizeHandle = screen.getByTestId('mini-player-resize-w');
      await fireEvent(resizeHandle, 'pointerDown', {
        clientX: 944,
        clientY: 524,
        stopPropagation: jest.fn(),
        preventDefault: jest.fn(),
      });
      await webWin.emit('pointermove', { clientX: 864, clientY: 524 });
      await webWin.emit('pointerup', { clientX: 864, clientY: 524 });

      const resizedStyle = StyleSheet.flatten(
        screen.getByTestId('floating-mini-player').props.style,
      );
      expect(resizedStyle.width).toBe(400);
      expect(resizedStyle.height).toBe(225);

      // Drag mini-player toward top-left and release -> snaps to top-left & suppresses click-to-expand
      const surfaceTap = screen.getByTestId('mini-player-surface-tap');
      await fireEvent(surfaceTap, 'pointerDown', { clientX: 900, clientY: 550 });
      await webWin.emit('pointermove', { clientX: 60, clientY: 40 });
      await webWin.emit('pointerup', { clientX: 60, clientY: 40 });
      await fireEvent.press(surfaceTap);
      expect(onExpand).not.toHaveBeenCalled();

      // Next plain tap expands
      await fireEvent.press(surfaceTap);
      expect(onExpand).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      webWin.restore();
    }
  });

  it('mounts 8 perimeter OS resize zones while keeping actionsRow and titleBar unobstructed in every docked corner', async () => {
    const i18n = createAppI18n('en');
    const baseProps = {
      title: 'Channel One',
      subtitle: 'Live News',
      isLive: true,
      isTv: false,
      i18n,
      onExpand: jest.fn(),
      onClose: jest.fn(),
      onDragStart: jest.fn(),
      onResizeStart: jest.fn(),
    };

    for (const corner of ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const) {
      const rendered = await render(
        wrap(<FloatingMiniPlayerChrome {...baseProps} corner={corner} />),
      );
      expect(
        StyleSheet.flatten(screen.getByTestId('mini-player-top-row').props.style),
      ).toMatchObject({ justifyContent: 'flex-end' });
      for (const edge of ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'] as const) {
        expect(screen.getByTestId(`mini-player-resize-${edge}`)).toBeTruthy();
      }
      await rendered.unmount();
    }
  });

  it('runs corner-snap Animated.timing without cancelling on frame 0, binds only PointerEvent listeners when supported, and expires expand suppression after 250ms', async () => {
    const webWin = installWebWindow({ pointerEvents: true });
    const stopSpy = jest.fn();
    const startSpy = jest.fn();
    const timingSpy = jest.spyOn(Animated, 'timing').mockReturnValue({
      start: startSpy,
      stop: stopSpy,
      reset: jest.fn(),
    } as unknown as Animated.CompositeAnimation);

    const engine = createFakePlayerEngine({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const onExpand = jest.fn();
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        renderSurface: (props) => <View testID={props.testID ?? 'player-surface'} />,
      }),
    };

    try {
      const view = await render(
        wrap(
          <PlayerScreen
            catalog={{
              resolveStream: async () =>
                ok({
                  url: 'http://sim.example.test/live/101.m3u8',
                  kind: 'live',
                  headers: {},
                  sourceId: 'src-1',
                }),
              getProgress: async () => null,
              saveProgress: async () => ok({} as never),
            }}
            videoHost={videoHost}
            target={LIVE_TARGET}
            viewMode="mini"
            reduceMotion={false}
            onExpandMiniPlayer={onExpand}
            onExit={jest.fn()}
          />,
        ),
      );

      await waitFor(() => expect(screen.getByTestId('floating-mini-player')).toBeTruthy());

      // Drag from bottom-right toward top-left
      const surfaceTap = screen.getByTestId('mini-player-surface-tap');
      await fireEvent(surfaceTap, 'pointerDown', { clientX: 900, clientY: 550 });

      // PointerEvent supported: mousemove/mouseup must NOT be registered simultaneously
      const addCalls = (webWin.win.addEventListener as jest.Mock).mock.calls.map((c) => c[0]);
      expect(addCalls).toContain('pointermove');
      expect(addCalls).not.toContain('mousemove');

      await webWin.emit('pointermove', { clientX: 60, clientY: 40 });
      await webWin.emit('pointerup', { clientX: 60, clientY: 40 });

      expect(timingSpy).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
      // Corner state update re-render must NOT cancel the active snap animation
      expect(stopSpy).not.toHaveBeenCalled();

      // After >250ms, expand suppression expires even if no synthetic click fired on tapArea
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300);
      await fireEvent.press(surfaceTap);
      expect(onExpand).toHaveBeenCalledTimes(1);
      nowSpy.mockRestore();

      await view.unmount();
    } finally {
      webWin.restore();
    }
  });
});
