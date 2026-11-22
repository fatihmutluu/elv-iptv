import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService, PlaybackState } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoSurfaceProps } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { VodProgressBar } from '../VodProgressBar';
import { createManualClock } from './player-test-harness';

const TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 }],
  subtitles: [{ id: 's:1', language: 'eng', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:vod:421',
  sourceId: 'src-1',
  title: 'Cinema Feature',
  kind: 'vod',
};

function installCaptureWebWindow() {
  const capture = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  const bubble = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  const win = {
    document: { activeElement: null as unknown },
    addEventListener: (
      type: string,
      fn: (e: Record<string, unknown>) => void,
      useCapture?: boolean | { capture?: boolean },
    ) => {
      const isCapture = typeof useCapture === 'boolean' ? useCapture : useCapture?.capture === true;
      const map = isCapture ? capture : bubble;
      const set = map.get(type) ?? new Set();
      set.add(fn);
      map.set(type, set);
    },
    removeEventListener: (
      type: string,
      fn: (e: Record<string, unknown>) => void,
      useCapture?: boolean | { capture?: boolean },
    ) => {
      const isCapture = typeof useCapture === 'boolean' ? useCapture : useCapture?.capture === true;
      (isCapture ? capture : bubble).get(type)?.delete(fn);
    },
  };
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = globals.window;
  const prevDocument = globals.document;
  globals.window = win;
  globals.document = win.document;

  return {
    win,
    async emitKey(type: 'keydown' | 'keyup', init: Record<string, unknown>) {
      let stoppedImmediate = false;
      const preventDefault = jest.fn(() => {
        evt.defaultPrevented = true;
      });
      const stopPropagation = jest.fn();
      const stopImmediatePropagation = jest.fn(() => {
        stoppedImmediate = true;
      });
      const evt: Record<string, unknown> = {
        defaultPrevented: false,
        preventDefault,
        stopPropagation,
        stopImmediatePropagation,
        ...init,
      };
      await act(async () => {
        for (const fn of [...(capture.get(type) ?? [])]) {
          fn(evt);
          if (stoppedImmediate) break;
        }
        if (!stoppedImmediate) {
          for (const fn of [...(bubble.get(type) ?? [])]) {
            fn(evt);
            if (stoppedImmediate) break;
          }
        }
      });
      return { evt, preventDefault, stopPropagation, stopImmediatePropagation };
    },
    restore() {
      globals.window = prevWindow;
      globals.document = prevDocument;
    },
  };
}

async function mountPlayer(opts: {
  formFactor: FormFactor;
  os?: 'android' | 'ios' | 'web';
  target?: PlayTarget;
  autoHideOsdMs?: number;
  initialOsdHidden?: boolean;
  withOrientationLock?: boolean;
}) {
  jest.replaceProperty(Platform, 'OS', (opts.os ?? 'android') as typeof Platform.OS);
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
  });
  const surfaceCalls: VideoSurfaceProps[] = [];
  const setOrientationLocked = jest.fn();
  const onExit = jest.fn();
  const target = opts.target ?? VOD_TARGET;

  const buildTree = (t: PlayTarget) => (
    <ThemeProvider preset="obsidianCrimson">
      <TvRemoteProvider>
        <ViewportProvider
          value={{
            width: opts.formFactor === 'phone' ? 393 : 1280,
            height: opts.formFactor === 'phone' ? 852 : 720,
            orientation: opts.formFactor === 'phone' ? 'portrait' : 'landscape',
            formFactor: opts.formFactor,
          }}
        >
          <FormFactorProvider value={opts.formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
                }}
                videoHost={{
                  open: () => ({
                    engine,
                    renderSurface: (p) => {
                      surfaceCalls.push(p);
                      return <View testID={p.testID ?? 'player-surface'} />;
                    },
                    ...(opts.withOrientationLock ? { setOrientationLocked } : {}),
                  }),
                }}
                target={t}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                autoHideOsdMs={opts.autoHideOsdMs}
                initialOsdHidden={opts.initialOsdHidden}
                onExit={onExit}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
      </TvRemoteProvider>
    </ThemeProvider>
  );

  const view = await render(buildTree(target));

  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  await act(async () => {
    manual.advance(350);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
  await act(async () => {
    engine.emit({
      attempt,
      type: 'clock',
      anchor: { positionMs: 30_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
    });
    engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
  });

  return {
    view,
    manual,
    engine,
    attempt,
    surfaceCalls,
    setOrientationLocked,
    onExit,
    rerenderTarget: (next: PlayTarget) => view.rerender(buildTree(next)),
  };
}

describe('Player OSD recovery, input guards, subtitles, aspect, orientation & touch scrub (#421, #136, #440)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('#421: touch tap toggles OSD on phone/tablet, guards >10px drags, wakes from hidden canvas, and ignores OSD button presses', async () => {
    const mobile = await mountPlayer({ formFactor: 'phone', os: 'android' });
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // Drag > 10px does NOT hide OSD
    const tapTarget = screen.getByTestId('player-canvas-tap-target');
    await fireEvent(tapTarget, 'pressIn', { nativeEvent: { pageX: 100, pageY: 200 } });
    await fireEvent.press(tapTarget, { nativeEvent: { pageX: 125, pageY: 200 } });
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // Clean single tap hides OSD while playing
    await fireEvent(tapTarget, 'pressIn', { nativeEvent: { pageX: 100, pageY: 200 } });
    await fireEvent.press(tapTarget, { nativeEvent: { pageX: 102, pageY: 201 } });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // Transparent tap target stays active while hidden so single tap wakes OSD back up
    const hiddenTarget = screen.getByTestId('player-canvas-tap-target');
    await fireEvent(hiddenTarget, 'pressIn', { nativeEvent: { pageX: 100, pageY: 200 } });
    await fireEvent.press(hiddenTarget, { nativeEvent: { pageX: 100, pageY: 200 } });
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // Pressing an OSD button pauses playback without toggle-hiding OSD
    await fireEvent.press(screen.getByTestId('player-play-pause'));
    expect(mobile.engine.commands.some((c) => c.name === 'pause')).toBe(true);
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // While paused, tapping canvas must NOT hide OSD
    const pauseAttempt =
      mobile.engine.commands.filter((c) => c.name === 'pause').at(-1)?.attempt ?? mobile.attempt;
    await act(async () => {
      mobile.engine.emit({ attempt: pauseAttempt, type: 'state', state: 'paused' });
    });
    await fireEvent.press(screen.getByTestId('player-canvas-tap-target'));
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    await mobile.view.unmount();
  });

  it('#421 & #136: desktop web hides cursor when OSD hides, ignores <10px pointer jitter, suppresses context menu, and guards Space/Backspace', async () => {
    const webEnv = installCaptureWebWindow();
    try {
      const desktop = await mountPlayer({
        formFactor: 'desktop',
        os: 'web',
        autoHideOsdMs: 2_000,
      });

      const root = screen.getByTestId('player-screen');
      expect(StyleSheet.flatten(root.props.style)).not.toMatchObject({ cursor: 'none' });

      // Right-click context menu is suppressed on desktop web player canvas
      const preventCtx = jest.fn();
      await fireEvent(root, 'contextMenu', { preventDefault: preventCtx });
      expect(preventCtx).toHaveBeenCalledTimes(1);

      // Establish baseline pointer at (200, 200), then auto-hide OSD
      await fireEvent(root, 'pointerMove', {
        nativeEvent: { pointerType: 'mouse', clientX: 200, clientY: 200 },
      });
      await act(async () => {
        desktop.manual.advance(2_000);
      });
      expect(screen.queryByTestId('player-osd')).toBeNull();
      expect(StyleSheet.flatten(screen.getByTestId('player-screen').props.style)).toMatchObject({
        cursor: 'none',
      });

      // Micro-jitter (< 10px) keeps OSD hidden and cursor hidden
      await fireEvent(screen.getByTestId('player-screen'), 'pointerMove', {
        nativeEvent: { pointerType: 'mouse', clientX: 205, clientY: 204 },
      });
      expect(screen.queryByTestId('player-osd')).toBeNull();

      // Deliberate move (>= 10px) wakes OSD and restores cursor
      await fireEvent(screen.getByTestId('player-screen'), 'pointerMove', {
        nativeEvent: { pointerType: 'mouse', clientX: 215, clientY: 200 },
      });
      expect(screen.getByTestId('player-osd')).toBeTruthy();
      expect(StyleSheet.flatten(screen.getByTestId('player-screen').props.style)).not.toMatchObject(
        { cursor: 'none' },
      );

      // Space toggles play/pause ONCE even when a non-modal OSD button holds Tab focus
      webEnv.win.document.activeElement = {
        tagName: 'DIV',
        getAttribute: (n: string) => (n === 'role' ? 'button' : null),
      };
      const spaceRes = await webEnv.emitKey('keydown', { key: ' ' });
      await webEnv.emitKey('keyup', { key: ' ' });
      expect(spaceRes.preventDefault).toHaveBeenCalledTimes(1);
      expect(desktop.engine.commands.filter((c) => c.name === 'pause')).toHaveLength(1);

      // Space with null activeElement ALSO toggles exactly once (no double-trigger with web-keys)
      webEnv.win.document.activeElement = null;
      const pauseAttempt =
        desktop.engine.commands.filter((c) => c.name === 'pause').at(-1)?.attempt ??
        desktop.attempt;
      await act(async () => {
        desktop.engine.emit({ attempt: pauseAttempt, type: 'state', state: 'paused' });
      });
      await webEnv.emitKey('keydown', { key: 'Spacebar' });
      await webEnv.emitKey('keyup', { key: 'Spacebar' });
      expect(desktop.engine.commands.filter((c) => c.name === 'play')).toHaveLength(1);

      // Modal open -> Space must NOT toggle playback
      const playAttempt =
        desktop.engine.commands.filter((c) => c.name === 'play').at(-1)?.attempt ?? pauseAttempt;
      await act(async () => {
        desktop.engine.emit({ attempt: playAttempt, type: 'state', state: 'playing' });
      });
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
      const pausesBeforeModal = desktop.engine.commands.filter((c) => c.name === 'pause').length;
      await webEnv.emitKey('keydown', { key: ' ' });
      expect(desktop.engine.commands.filter((c) => c.name === 'pause')).toHaveLength(
        pausesBeforeModal,
      );
      await fireEvent.press(screen.getByTestId('player-settings-close'));

      // Editable input focused -> Space & Backspace never hijacked
      webEnv.win.document.activeElement = { tagName: 'INPUT' };
      const editableSpace = await webEnv.emitKey('keydown', { key: ' ' });
      const editableBackspace = await webEnv.emitKey('keydown', { key: 'Backspace' });
      expect(editableSpace.preventDefault).not.toHaveBeenCalled();
      expect(editableBackspace.preventDefault).not.toHaveBeenCalled();
      expect(desktop.engine.commands.filter((c) => c.name === 'pause')).toHaveLength(
        pausesBeforeModal,
      );
      expect(desktop.onExit).not.toHaveBeenCalled();

      await desktop.view.unmount();
    } finally {
      webEnv.restore();
    }
  });

  it('#136 & #440: propagates subtitleBottomInsetPx and resizeMode fit/fill toggle via PlayerSettingsSheet', async () => {
    const mobile = await mountPlayer({ formFactor: 'phone', os: 'android' });
    expect(mobile.surfaceCalls.at(-1)).toMatchObject({
      resizeMode: 'fit',
      subtitleBottomInsetPx: 96,
    });

    // Toggle resizeMode Fit -> Fill inside PlayerSettingsSheet
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    const aspectBtn = screen.getByTestId('player-resize-mode-toggle');
    expect(aspectBtn).toHaveTextContent(/Fit/);
    await fireEvent.press(aspectBtn);
    expect(screen.getByTestId('player-resize-mode-toggle')).toHaveTextContent(/Fill/);
    expect(mobile.surfaceCalls.at(-1)?.resizeMode).toBe('fill');

    // Close settings and hide OSD -> subtitleBottomInsetPx drops to 0
    await fireEvent.press(screen.getByTestId('player-settings-close'));
    await fireEvent.press(screen.getByTestId('player-canvas-tap-target'));
    expect(mobile.surfaceCalls.at(-1)?.subtitleBottomInsetPx).toBe(0);
    await mobile.view.unmount();

    // TV passes 120 when OSD visible, 0 when hidden
    const tv = await mountPlayer({ formFactor: 'tv', os: 'android' });
    expect(tv.surfaceCalls.at(-1)?.subtitleBottomInsetPx).toBe(120);
    await tv.view.unmount();

    // Desktop always passes 0 and omits dead Aspect row in PlayerSettingsSheet
    const desktop = await mountPlayer({ formFactor: 'desktop', os: 'web' });
    expect(desktop.surfaceCalls.at(-1)?.subtitleBottomInsetPx).toBe(0);
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-resize-mode-toggle')).toBeNull();
    expect(screen.getByTestId('player-stats-toggle')).toBeTruthy();
    await desktop.view.unmount();
  });

  it('#440: locks Android orientation on touch lock and guarantees unlock on unlock, target change, and unmount', async () => {
    const mobile = await mountPlayer({
      formFactor: 'phone',
      os: 'android',
      withOrientationLock: true,
    });

    // Lock -> setOrientationLocked(true) & subtitleBottomInsetPx drops to 0
    await fireEvent.press(screen.getByTestId('player-lock-button'));
    expect(mobile.setOrientationLocked).toHaveBeenLastCalledWith(true);
    expect(mobile.surfaceCalls.at(-1)?.subtitleBottomInsetPx).toBe(0);

    // Unlock -> setOrientationLocked(false)
    await fireEvent.press(screen.getByTestId('player-unlock-button'));
    expect(mobile.setOrientationLocked).toHaveBeenLastCalledWith(false);

    // Lock again then change target -> setOrientationLocked(false)
    await fireEvent.press(screen.getByTestId('player-lock-button'));
    expect(mobile.setOrientationLocked).toHaveBeenLastCalledWith(true);
    await mobile.rerenderTarget({ ...VOD_TARGET, itemKey: 'x:src-1:vod:422', title: 'Next Film' });
    expect(mobile.setOrientationLocked).toHaveBeenLastCalledWith(false);

    // Lock again then unmount -> cleanup unlocks orientation so Android never gets stuck locked
    await fireEvent.press(screen.getByTestId('player-lock-button'));
    expect(mobile.setOrientationLocked).toHaveBeenLastCalledWith(true);
    await mobile.view.unmount();
    expect(mobile.setOrientationLocked).toHaveBeenLastCalledWith(false);
  });

  it('#440: VodProgressBar supports native touch drag scrubbing with floating timecode preview and single release commit', async () => {
    jest.replaceProperty(Platform, 'OS', 'android' as typeof Platform.OS);
    const onSeekRatio = jest.fn();
    const onScrubbingChange = jest.fn();
    const state: PlaybackState = {
      status: { kind: 'playing' },
      attempt: 1,
      tracks: TRACKS,
      staleEventsDropped: 0,
      surfaceRecreationToken: 0,
      anchor: { positionMs: 30_000, atMs: 1_000, rate: 0, durationMs: 120_000 },
    };
    const service = {
      getState: () => state,
      subscribe: () => () => undefined,
    } as unknown as PlaybackService;

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <VodProgressBar
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          label="Progress"
          onSeekRatio={onSeekRatio}
          onScrubbingChange={onScrubbingChange}
        />
      </ThemeProvider>,
    );

    const bar = screen.getByTestId('player-progress-bar');
    await fireEvent(bar, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 24 } },
    });

    const scrubber = screen.getByTestId('player-progress-touch-scrubber');
    // Touch grant at 25% (x=50/200) -> enters drag preview, no seek yet
    await fireEvent(scrubber, 'responderGrant', {
      nativeEvent: { locationX: 50, pageX: 50, identifier: 1 },
    });
    expect(onScrubbingChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('0:30');
    expect(onSeekRatio).not.toHaveBeenCalled();

    // Drag to 75% (x=150) -> updates preview timecode pill & fill live without seeking
    await fireEvent(scrubber, 'responderMove', {
      nativeEvent: { locationX: 150, pageX: 150, identifier: 1 },
    });
    expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('1:30');
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('1:30 / 2:00');
    expect(onSeekRatio).not.toHaveBeenCalled();

    // Drag past right edge (x=280) -> clamps cleanly to 1.0 (2:00)
    await fireEvent(scrubber, 'responderMove', {
      nativeEvent: { locationX: 280, pageX: 280, identifier: 1 },
    });
    expect(screen.getByTestId('player-progress-hover-time')).toHaveTextContent('2:00');

    // Release at 75% (x=150) -> commits ONE coalesced seek at 0.75 and hides preview pill
    await fireEvent(scrubber, 'responderRelease', {
      nativeEvent: { locationX: 150, pageX: 150, identifier: 1 },
    });
    expect(onSeekRatio).toHaveBeenCalledTimes(1);
    expect(onSeekRatio).toHaveBeenCalledWith(0.75);
    expect(onScrubbingChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('player-progress-hover-time')).toBeNull();

    // Terminate cancels drag without seeking
    await fireEvent(scrubber, 'responderGrant', {
      nativeEvent: { locationX: 100, pageX: 100, identifier: 1 },
    });
    await fireEvent(scrubber, 'responderTerminate', {
      nativeEvent: { locationX: 100, pageX: 100, identifier: 1 },
    });
    expect(onSeekRatio).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('player-progress-hover-time')).toBeNull();

    await view.unmount();
  });
});
