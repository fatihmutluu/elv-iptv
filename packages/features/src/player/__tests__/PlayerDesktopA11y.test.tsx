import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks, PlaybackService } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { noopAppLifecycle } from '../../ports/app-lifecycle';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { buildPreviousChannelTarget } from '../player-overlay-model';
import { usePlayerTargetHandoff } from '../usePlayerTargetHandoff';
import { createManualClock } from './player-test-harness';

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'tur', label: 'Turkish', codec: 'ac3', channels: 6 },
  ],
  subtitles: [{ id: 's:1', language: 'eng', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:vod:701',
  sourceId: 'src-1',
  accountKey: 'fp:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  title: 'Desktop A11y Feature',
  kind: 'vod',
};

function installMockWebWindow() {
  const listeners = new Map<string, Set<(e?: unknown) => void>>();
  const win = {
    document: { activeElement: null as unknown },
    addEventListener: (type: string, fn: (e?: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: (e?: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  const globals = globalThis as unknown as { window?: unknown; document?: unknown };
  const prevWindow = globals.window;
  const prevDocument = globals.document;
  globals.window = win;
  globals.document = win.document;

  return {
    win,
    async emitKey(type: 'keydown' | 'keyup', e: Record<string, unknown>) {
      await act(async () => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
          fn({ preventDefault: jest.fn(), ...e });
        }
      });
    },
    restore() {
      globals.window = prevWindow;
      globals.document = prevDocument;
    },
  };
}

async function mountDesktopWebPlayer(opts: {
  target?: PlayTarget;
  withFullscreen?: boolean;
  withMute?: boolean;
  onToggleFullscreen?: () => void;
  onToggleMute?: () => void;
  playbackGuard?: {
    stopIfUsingSource: (id: string) => void;
    registerSession?: (session: {
      getSourceId: () => string | undefined;
      stop: () => void;
    }) => () => void;
  };
}) {
  jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
  });
  const toggleFullscreen = opts.onToggleFullscreen ?? jest.fn();
  const toggleMute = opts.onToggleMute ?? jest.fn();
  let hostKeyListener:
    | ((key: 'channel-up' | 'channel-down' | 'back' | 'fullscreen') => void)
    | undefined;
  const onExit = jest.fn();
  const onTargetChange = jest.fn();
  const catalog = {
    resolveStream: jest.fn(async (k: string) =>
      ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
    ),
  };
  const target = opts.target ?? VOD_TARGET;

  const view = await render(
    <ThemeProvider preset="obsidianCrimson">
      <TvRemoteProvider>
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{
                open: () => ({
                  engine,
                  renderSurface: () => <View testID="fake-surface" />,
                  onHostKey: (listener) => {
                    hostKeyListener = listener;
                    return () => {
                      hostKeyListener = undefined;
                    };
                  },
                  ...(opts.withFullscreen !== false ? { toggleFullscreen } : {}),
                  ...(opts.withMute !== false ? { toggleMute } : {}),
                }),
              }}
              target={target}
              playbackGuard={opts.playbackGuard}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onTargetChange={onTargetChange}
              onExit={onExit}
            />
          </I18nProvider>
        </FormFactorProvider>
      </TvRemoteProvider>
    </ThemeProvider>,
  );

  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  await act(async () => {
    manual.advance(350);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
  await act(async () => {
    if (target.kind === 'vod') {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 60_000, atMs: manual.now(), rate: 0, durationMs: 200_000 },
      });
    }
    engine.emit({ attempt, type: 'tracks', tracks: SAMPLE_TRACKS });
  });

  return {
    view,
    manual,
    engine,
    toggleFullscreen,
    toggleMute,
    onExit,
    onTargetChange,
    catalog,
    emitHostKey: async (key: 'channel-up' | 'channel-down' | 'back' | 'fullscreen') => {
      await act(async () => {
        hostKeyListener?.(key);
      });
    },
  };
}

function HandoffProbe({ target, service }: { target: PlayTarget; service: PlaybackService }) {
  const manual = createManualClock();
  const catalogRef = useRef({
    resolveStream: async (k: string) =>
      ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
  });
  const serviceRef = useRef<PlaybackService | null>(service);
  const clockRef = useRef({ now: manual.now });
  const timersRef = useRef({ setTimeout: manual.schedule, clearTimeout: manual.cancel });
  const flushRef = useRef(() => undefined);
  const cancelScrubRef = useRef(() => undefined);
  const onTargetChangeRef = useRef<((next: PlayTarget) => void) | undefined>(undefined);
  const handoff = usePlayerTargetHandoff({
    target,
    appLifecycle: noopAppLifecycle,
    catalogRef,
    serviceRef,
    clockRef,
    timersRef,
    flushProgressRef: flushRef,
    cancelScrubRef,
    onTargetChangeRef,
  });
  const readyRef = useRef(handoff.onServiceReady);
  readyRef.current = handoff.onServiceReady;
  useEffect(() => {
    readyRef.current(service);
  }, [service]);
  return <View testID="handoff-probe" accessibilityHint={handoff.activeTarget.accountKey} />;
}

describe('Desktop Player A11y, Shortcuts, Fullscreen Guard & Pool Key (#283, #265)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('#283: exposes synchronized aria-keyshortcuts on desktop web OSD buttons and omits them on non-desktop native', async () => {
    const webEnv = installMockWebWindow();
    try {
      const desktop = await mountDesktopWebPlayer({});

      expect(screen.getByTestId('player-play-pause').props['aria-keyshortcuts']).toBe('Space k');
      expect(screen.getByTestId('player-seek-back').props['aria-keyshortcuts']).toBe('ArrowLeft j');
      expect(screen.getByTestId('player-seek-forward').props['aria-keyshortcuts']).toBe(
        'ArrowRight l',
      );
      expect(screen.getByTestId('player-mute-button').props['aria-keyshortcuts']).toBe('m');
      expect(screen.getByTestId('player-mute-button').props.accessibilityLabel).toBe('Mute');
      expect(screen.getByTestId('player-fullscreen-button').props['aria-keyshortcuts']).toBe('f');
      expect(screen.getByTestId('player-subtitles-button').props['aria-keyshortcuts']).toBe('c');
      expect(screen.getByTestId('player-back').props['aria-keyshortcuts']).toBe('Escape');

      await desktop.view.unmount();
    } finally {
      webEnv.restore();
    }

    // Native TV / non-web omits aria-keyshortcuts
    jest.replaceProperty(Platform, 'OS', 'android');
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const nativeView = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={{
                resolveStream: async () =>
                  ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
              }}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={VOD_TARGET}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    expect(screen.getByTestId('player-back').props['aria-keyshortcuts']).toBeUndefined();
    expect(screen.getByTestId('player-play-pause').props['aria-keyshortcuts']).toBeUndefined();
    await nativeView.unmount();
  });

  it('#283: supports c/m/f desktop shortcuts, sets dialog semantics on PlayerSettingsSheet across views, and suppresses editable input hotkeys', async () => {
    const webEnv = installMockWebWindow();
    try {
      const desktop = await mountDesktopWebPlayer({});

      // Editable targets suppress k, j, l, m, f, c
      const editableTargets = [
        { tagName: 'INPUT' },
        { tagName: 'TEXTAREA' },
        { tagName: 'SELECT' },
        { tagName: 'DIV', isContentEditable: true },
      ];
      for (const target of editableTargets) {
        await webEnv.emitKey('keydown', { key: 'k', target });
        await webEnv.emitKey('keydown', { key: 'j', target });
        await webEnv.emitKey('keydown', { key: 'l', target });
        await webEnv.emitKey('keydown', { key: 'm', target });
        await webEnv.emitKey('keydown', { key: 'f', target });
        await webEnv.emitKey('keydown', { key: 'c', target });
      }
      expect(desktop.engine.commands.some((c) => c.name === 'pause')).toBe(false);
      expect(desktop.engine.commands.some((c) => c.name === 'seek')).toBe(false);
      expect(desktop.toggleMute).not.toHaveBeenCalled();
      expect(desktop.toggleFullscreen).not.toHaveBeenCalled();
      expect(screen.queryByTestId('player-settings-desktop-dialog')).toBeNull();

      // 'm' toggles mute, 'c' opens PlayerSettingsSheet directly on Subtitles with dialog ARIA semantics
      await webEnv.emitKey('keydown', { key: 'm' });
      expect(desktop.toggleMute).toHaveBeenCalledTimes(1);

      await webEnv.emitKey('keydown', { key: 'c' });
      const subtitlesDialog = screen.getByTestId('player-settings-desktop-dialog');
      expect(subtitlesDialog.props.role).toBe('dialog');
      expect(subtitlesDialog.props['aria-modal']).toBe(true);
      expect(screen.getByTestId('player-settings-sub-s:1')).toBeTruthy();

      // 'c' again closes Subtitles dialog cleanly
      await webEnv.emitKey('keydown', { key: 'c' });
      expect(screen.queryByTestId('player-settings-desktop-dialog')).toBeNull();

      // Opening settings renders dialog ARIA semantics in desktop flex flow
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      const settingsDialog = screen.getByTestId('player-settings-desktop-dialog');
      expect(settingsDialog.props.role).toBe('dialog');
      expect(settingsDialog.props['aria-modal']).toBe(true);

      await desktop.view.unmount();
    } finally {
      webEnv.restore();
    }
  });

  it('#283: collapses open Subtitles and PlayerSettingsSheet BEFORE invoking toggleFullscreen via keyboard "f" or OSD button', async () => {
    const webEnv = installMockWebWindow();
    const events: string[] = [];
    try {
      const desktop = await mountDesktopWebPlayer({
        onToggleFullscreen: () => {
          events.push('toggleFullscreen');
        },
      });

      // 1. Subtitles settings open -> 'f' closes panel FIRST, then invokes toggleFullscreen
      await fireEvent.press(screen.getByTestId('player-subtitles-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();

      await webEnv.emitKey('keydown', { key: 'f' });
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(events).toEqual(['toggleFullscreen']);

      // 2. PlayerSettingsSheet root open -> 'f' closes settings FIRST, then invokes toggleFullscreen
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();

      await webEnv.emitKey('keydown', { key: 'f' });
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(events).toEqual(['toggleFullscreen', 'toggleFullscreen']);

      // 3. OSD Fullscreen button while Subtitles view is open closes panel FIRST, then invokes toggleFullscreen
      await fireEvent.press(screen.getByTestId('player-subtitles-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
      // aria-modal isolates background OSD from accessibility queries while dialog is open
      expect(screen.queryByTestId('player-fullscreen-button')).toBeNull();

      await fireEvent.press(
        screen.getByTestId('player-fullscreen-button', { includeHiddenElements: true }),
      );
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(events).toEqual(['toggleFullscreen', 'toggleFullscreen', 'toggleFullscreen']);

      // 4. OSD Fullscreen button while PlayerSettingsSheet is open closes settings FIRST, then invokes toggleFullscreen
      await fireEvent.press(screen.getByTestId('player-settings-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
      expect(screen.queryByTestId('player-fullscreen-button')).toBeNull();

      await fireEvent.press(
        screen.getByTestId('player-fullscreen-button', { includeHiddenElements: true }),
      );
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(events).toHaveLength(4);

      // 5. Host out-of-DOM mpv 'fullscreen' key while popovers are open collapses them BEFORE toggling fullscreen
      await fireEvent.press(screen.getByTestId('player-subtitles-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
      await desktop.emitHostKey('fullscreen');
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(events).toHaveLength(5);

      await fireEvent.press(screen.getByTestId('player-settings-button'));
      expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
      await desktop.emitHostKey('fullscreen');
      expect(screen.queryByTestId('player-settings-panel')).toBeNull();
      expect(events).toHaveLength(6);

      await desktop.view.unmount();
    } finally {
      webEnv.restore();
    }
  });

  it('#265: wires PlayableEntry.accountKey into PlaybackService.tune, keeps PlaybackGuard keyed by sourceId, and preserves accountKey across zapping & previous-channel jump', async () => {
    const webEnv = installMockWebWindow();
    const sharedPoolKey = 'fp:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ch0: PlayableEntry = {
      itemKey: 'ch:0',
      sourceId: 'src-xtream',
      accountKey: sharedPoolKey,
      title: '1. Live Xtream',
      kind: 'live',
    };
    const ch1: PlayableEntry = {
      itemKey: 'ch:1',
      sourceId: 'src-m3u',
      accountKey: sharedPoolKey,
      title: '2. Live M3U',
      kind: 'live',
    };
    let registeredSession: { getSourceId: () => string | undefined; stop: () => void } | undefined;

    try {
      const desktop = await mountDesktopWebPlayer({
        target: {
          ...ch0,
          playlist: {
            count: 2,
            currentIndex: 0,
            onChangeIndex: jest.fn(),
            getAt: async (i) => (i === 0 ? ch0 : ch1),
          },
        },
        playbackGuard: {
          stopIfUsingSource: jest.fn(),
          registerSession: (session) => {
            registeredSession = session;
            return () => {
              registeredSession = undefined;
            };
          },
        },
      });

      // PlaybackGuard still resolves the DB sourceId so deleting/refreshing src-xtream stops playback
      expect(registeredSession?.getSourceId()).toBe('src-xtream');

      // Zap to ch1 -> previousChannel carries ch0.accountKey cleanly
      await fireEvent.press(screen.getByTestId('player-next'));
      await waitFor(() => {
        expect(desktop.onTargetChange).toHaveBeenCalled();
      });
      const afterZap = desktop.onTargetChange.mock.calls.at(-1)?.[0] as PlayTarget;
      expect(afterZap.itemKey).toBe('ch:1');
      expect(afterZap.accountKey).toBe(sharedPoolKey);
      expect(afterZap.previousChannel?.accountKey).toBe(sharedPoolKey);
      expect(registeredSession?.getSourceId()).toBe('src-m3u');

      // Jump back to previous channel -> restores ch0.accountKey and preserves ch1.accountKey in previousChannel
      await fireEvent.press(screen.getByTestId('player-prev-channel'));
      const afterJumpBack = desktop.onTargetChange.mock.calls.at(-1)?.[0] as PlayTarget;
      expect(afterJumpBack.itemKey).toBe('ch:0');
      expect(afterJumpBack.accountKey).toBe(sharedPoolKey);
      expect(afterJumpBack.previousChannel?.accountKey).toBe(sharedPoolKey);

      await desktop.view.unmount();
    } finally {
      webEnv.restore();
    }
  });

  it('#265 & #283: passes entry.accountKey ?? entry.sourceId into PlaybackService.tune and preserves desktop HWND flex-flow layout', async () => {
    const webEnv = installMockWebWindow();
    const tunedAccountKeys: string[] = [];
    const fakeService = {
      tune: jest.fn((req: { accountKey: string }) => {
        tunedAccountKeys.push(req.accountKey);
      }),
      stop: jest.fn(),
      getState: () => ({ status: { kind: 'playing' as const }, attempt: 1 }),
    } as unknown as PlaybackService;

    try {
      // 1. Target with explicit credential fingerprint accountKey -> passed verbatim to service.tune
      const probe = await render(<HandoffProbe target={VOD_TARGET} service={fakeService} />);
      expect(tunedAccountKeys).toEqual([VOD_TARGET.accountKey]);
      expect(screen.getByTestId('handoff-probe').props.accessibilityHint).toBe(
        VOD_TARGET.accountKey,
      );

      // Updating accountKey metadata with same itemKey updates activeTarget via hasTargetMetaChanged
      const updatedKey = 'fp:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await probe.rerender(
        <HandoffProbe target={{ ...VOD_TARGET, accountKey: updatedKey }} service={fakeService} />,
      );
      expect(screen.getByTestId('handoff-probe').props.accessibilityHint).toBe(updatedKey);

      // Switching to target without accountKey falls back cleanly to sourceId
      await probe.rerender(
        <HandoffProbe
          target={{
            itemKey: 'x:src-fallback:vod:1',
            sourceId: 'src-fallback',
            title: 'Fallback',
            kind: 'vod',
          }}
          service={fakeService}
        />,
      );
      expect(tunedAccountKeys.at(-1)).toBe('src-fallback');
      await probe.unmount();

      // 2. Desktop HWND flex-flow safety: surface uses flex:1 (not absolute), panels stay in normal flow
      const withKey = await mountDesktopWebPlayer({ target: VOD_TARGET });
      const surfaceStyle = StyleSheet.flatten(
        screen.getByTestId('player-surface-layer').props.style,
      );
      expect(surfaceStyle?.flex).toBe(1);
      expect(surfaceStyle?.position).toBeUndefined();

      await fireEvent.press(screen.getByTestId('player-subtitles-button'));
      const subtitlesDialogStyle = StyleSheet.flatten(
        screen.getByTestId('player-settings-desktop-dialog').props.style,
      );
      expect(subtitlesDialogStyle?.position).toBeUndefined();
      await webEnv.emitKey('keydown', { key: 'c' });

      await fireEvent.press(screen.getByTestId('player-settings-button'));
      const settingsStyle = StyleSheet.flatten(
        screen.getByTestId('player-settings-desktop-dialog').props.style,
      );
      expect(settingsStyle?.position).toBeUndefined();
      await withKey.view.unmount();

      // 3. Pure buildPreviousChannelTarget preserves accountKey in both directions
      const swapped = buildPreviousChannelTarget({
        itemKey: 'ch:1',
        sourceId: 'src-m3u',
        accountKey: 'fp:1111',
        title: 'Two',
        kind: 'live',
        previousChannel: {
          itemKey: 'ch:0',
          sourceId: 'src-xtream',
          accountKey: 'fp:1111',
          title: 'One',
          kind: 'live',
        },
      });
      expect(swapped?.accountKey).toBe('fp:1111');
      expect(swapped?.previousChannel?.accountKey).toBe('fp:1111');
    } finally {
      webEnv.restore();
    }
  });
});
