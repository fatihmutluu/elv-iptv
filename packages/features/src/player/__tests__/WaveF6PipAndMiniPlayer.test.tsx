import type { WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine, VideoHost, VideoSurfaceProps } from '../../ports/video-host';
import { computeMiniPlayerFrame } from '../FloatingMiniPlayerChrome';
import { PlayerScreen } from '../PlayerScreen';
import { isPinchOutMinimize } from '../PlayerTouchGestures';

const LIVE_TARGET: PlayTarget = {
  itemKey: 'live:src-1:101',
  sourceId: 'src-1',
  accountKey: 'acct-1',
  title: 'Channel One',
  kind: 'live',
  itemKind: 'live',
};

function makeCatalog() {
  return {
    resolveStream: async () =>
      ok({
        url: 'http://sim.example.test/live/101.m3u8',
        kind: 'live' as const,
        headers: {},
        sourceId: 'src-1',
      }),
    getProgress: async () => null,
    saveProgress: async () => ok({} as WatchProgressRow),
  };
}

function renderWithProviders(
  ui: React.ReactElement,
  viewport: ViewportOverride = {
    formFactor: 'tablet',
    orientation: 'landscape',
    inputModality: 'touch',
    width: 1194,
    height: 834,
  },
) {
  return render(
    <FormFactorProvider value={viewport.formFactor}>
      <ViewportProvider value={viewport}>
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider preset="obsidianCrimson">{ui}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </FormFactorProvider>,
  );
}

describe('Wave F6 OS Picture-in-Picture (#34) & Floating Corner Mini-Player (#233)', () => {
  it('computes 16:9 mini-player frame with safeArea, overscan, and portrait tab clearance, and validates pinch threshold', () => {
    const tvFrame = computeMiniPlayerFrame({
      viewportWidth: 1920,
      viewportHeight: 1080,
      formFactor: 'tv',
      orientation: 'landscape',
      safeArea: { right: 0, bottom: 0 },
      overscan: { x: 40, y: 24 },
    });
    expect(tvFrame.width).toBe(360);
    expect(tvFrame.height).toBe(Math.round((360 * 9) / 16));
    expect(tvFrame.right).toBe(56);
    expect(tvFrame.bottom).toBe(40);

    const phonePortrait = computeMiniPlayerFrame({
      viewportWidth: 393,
      viewportHeight: 852,
      formFactor: 'phone',
      orientation: 'portrait',
      safeArea: { right: 0, bottom: 34 },
      overscan: { x: 0, y: 0 },
    });
    expect(phonePortrait.bottom).toBe(16 + 68 + 34);

    expect(isPinchOutMinimize(200, 140)).toBe(true);
    expect(isPinchOutMinimize(200, 180)).toBe(false);
    expect(isPinchOutMinimize(0, 0)).toBe(false);
  });

  it('syncs autoEnterPip to native engine, clears on unmount, and falls back to mini-player when OS PiP returns false (#34)', async () => {
    const engine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    let pipListener: ((inPip: boolean) => void) | undefined;
    let canStartPip = true;
    let enterResult = true;
    const setAutoEnterPip = jest.fn();
    const enterPictureInPicture = jest.fn(() => enterResult);
    const onMinimize = jest.fn();
    const surfacePropsHistory: VideoSurfaceProps[] = [];

    const opened: OpenVideoEngine = {
      engine,
      renderSurface: (props) => {
        surfacePropsHistory.push(props);
        return <View testID={props.testID ?? 'player-surface'} />;
      },
      canStartPictureInPicture: () => canStartPip,
      enterPictureInPicture,
      setAutoEnterPictureInPicture: setAutoEnterPip,
      onPictureInPictureChange: (l) => {
        pipListener = l;
        return () => {
          pipListener = undefined;
        };
      },
    };
    const videoHost: VideoHost = { open: () => opened };

    const view = await renderWithProviders(
      <PlayerScreen
        catalog={makeCatalog()}
        videoHost={videoHost}
        target={LIVE_TARGET}
        autoEnterPip
        onMinimizeToMiniPlayer={onMinimize}
        onExit={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('player-pip-button')).toBeTruthy());

    await act(async () => {
      engine.emit({ attempt: 1, type: 'mediaInfo', info: { width: 1920, height: 1080 } });
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
    });

    await waitFor(() => {
      expect(setAutoEnterPip).toHaveBeenLastCalledWith(true, 1920, 1080);
    });

    // Manual OS PiP succeeds when supported
    await fireEvent.press(screen.getByTestId('player-pip-button'));
    expect(enterPictureInPicture).toHaveBeenCalledWith(1920, 1080);
    expect(onMinimize).not.toHaveBeenCalled();

    // Entering OS PiP suppresses ALL overlays (OSD, touch gestures, TvFocusAnchor)
    await act(async () => {
      pipListener?.(true);
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();
    expect(screen.queryByTestId('player-touch-gestures')).toBeNull();
    expect(screen.queryByTestId('player-tv-focus-anchor')).toBeNull();

    // Exit OS PiP
    await act(async () => {
      pipListener?.(false);
    });
    await waitFor(() => expect(screen.getByTestId('player-pip-button')).toBeTruthy());

    // Raw-TS Apple route fallback: canStartPictureInPicture() === false -> falls back to mini-player
    canStartPip = false;
    await fireEvent.press(screen.getByTestId('player-pip-button'));
    expect(onMinimize).toHaveBeenCalledTimes(1);

    // enterPictureInPicture() returning false also falls back cleanly
    canStartPip = true;
    enterResult = false;
    await fireEvent.press(screen.getByTestId('player-pip-button'));
    expect(onMinimize).toHaveBeenCalledTimes(2);

    // Unmount clears auto-enter PiP to false
    await view.unmount();
    expect(setAutoEnterPip).toHaveBeenLastCalledWith(false, 1920, 1080);
  });

  it('respects portrait phone 3-icon cap in OSD while keeping Mini-Player & PiP in Settings sheet, and supports tablet pinch-out (#34, #233)', async () => {
    const engine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: ({ testID }) => <View testID={testID ?? 'player-surface'} />,
        enterPictureInPicture: () => true,
      }),
    };
    const onMinimize = jest.fn();

    const phoneView = await renderWithProviders(
      <PlayerScreen
        catalog={makeCatalog()}
        videoHost={videoHost}
        target={LIVE_TARGET}
        multiViewSupported
        onMinimizeToMiniPlayer={onMinimize}
        onEnterMultiView={jest.fn()}
        onPopoutPlayer={jest.fn()}
        onExit={jest.fn()}
      />,
      {
        formFactor: 'phone',
        orientation: 'portrait',
        inputModality: 'touch',
        width: 393,
        height: 852,
      },
    );

    await waitFor(() => expect(screen.getByTestId('player-settings-button')).toBeTruthy());
    // Portrait phone caps top-right cluster: none of the extra Wave F6 icons render in top bar
    expect(screen.queryByTestId('player-minimize-button')).toBeNull();
    expect(screen.queryByTestId('player-pip-button')).toBeNull();
    expect(screen.queryByTestId('player-multiview-button')).toBeNull();
    expect(screen.queryByTestId('player-popout-button')).toBeNull();

    // Open Settings sheet -> Mini-Player & PiP actions are reachable there
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.getByTestId('player-settings-miniplayer')).toBeTruthy();
    expect(screen.getByTestId('player-settings-pip')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-settings-miniplayer'));
    expect(onMinimize).toHaveBeenCalledTimes(1);
    await phoneView.unmount();

    // Tablet pinch-out (< 1.0x) triggers onMinimizeToMiniPlayer
    const onTabletMinimize = jest.fn();
    const tabletView = await renderWithProviders(
      <PlayerScreen
        catalog={makeCatalog()}
        videoHost={videoHost}
        target={LIVE_TARGET}
        onMinimizeToMiniPlayer={onTabletMinimize}
        onExit={jest.fn()}
      />,
      {
        formFactor: 'tablet',
        orientation: 'landscape',
        inputModality: 'touch',
        width: 1194,
        height: 834,
      },
    );
    await waitFor(() => expect(screen.getByTestId('player-touch-gestures')).toBeTruthy());
    const gestures = screen.getByTestId('player-touch-gestures');
    await fireEvent(gestures, 'responderGrant', {
      nativeEvent: {
        locationX: 400,
        locationY: 400,
        touches: [
          { pageX: 300, pageY: 400 },
          { pageX: 600, pageY: 400 },
        ],
      },
    });
    await fireEvent(gestures, 'responderMove', {
      nativeEvent: {
        locationX: 400,
        locationY: 400,
        touches: [
          { pageX: 390, pageY: 400 },
          { pageX: 510, pageY: 400 },
        ],
      },
    });
    expect(onTabletMinimize).toHaveBeenCalledTimes(1);
    await tabletView.unmount();
  });

  it('keeps surface mounted with focusable=false and osdVisible=false when toggling full <-> mini without reopening videoHost (#233)', async () => {
    const engine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const surfaceProps: VideoSurfaceProps[] = [];
    const openSpy = jest.fn(() => ({
      engine,
      renderSurface: (p: VideoSurfaceProps) => {
        surfaceProps.push(p);
        return <View testID={p.testID ?? 'player-surface'} />;
      },
    }));
    const videoHost: VideoHost = { open: openSpy };
    const catalog = makeCatalog();
    const onExpand = jest.fn();
    const onExit = jest.fn();

    const makeTree = (viewMode: 'full' | 'mini') => (
      <FormFactorProvider value="tv">
        <ViewportProvider
          value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider preset="obsidianCrimson">
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={LIVE_TARGET}
                viewMode={viewMode}
                onExpandMiniPlayer={onExpand}
                onExit={onExit}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>
    );

    const view = await render(makeTree('full'));
    await waitFor(() => expect(screen.getByTestId('player-osd')).toBeTruthy());
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Switch to 'mini' without unmounting PlayerScreen
    await view.rerender(makeTree('mini'));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('floating-mini-player')).toBeTruthy();
    expect(screen.queryByTestId('player-osd')).toBeNull();
    expect(screen.queryByTestId('player-tv-focus-anchor')).toBeNull();
    expect(screen.getByTestId('player-surface-host').props.focusable).toBe(false);
    expect(surfaceProps[surfaceProps.length - 1]?.osdVisible).toBe(false);

    // Expand & Close actions work cleanly
    await fireEvent.press(screen.getByTestId('mini-player-expand'));
    expect(onExpand).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('mini-player-close'));
    expect(onExit).toHaveBeenCalledTimes(1);

    // Switch back to 'full' -> still zero stream reconnect
    await view.rerender(makeTree('full'));
    expect(openSpy).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
