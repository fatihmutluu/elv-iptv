import type {
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  NowNextEntry,
  ProgrammeRow,
  SourceRow,
  ToggleFavoriteInput,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, View } from 'react-native';
import type { HostKey, OpenVideoEngine, VideoHost, VideoResizeMode } from '../../ports/video-host';
import { RouteActiveProvider } from '../../shared';
import { LiveScreen } from '../LiveScreen';
import { EMPTY_LIVE_MEMORY } from '../live-model';

const NOW_MS = Date.UTC(2026, 10, 27, 20, 0, 0);
const KEYCODE_PROG_RED = 183;

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1440,
  height: 900,
};

const MOBILE_LANDSCAPE_VIEWPORT: ViewportOverride = {
  formFactor: 'phone',
  orientation: 'landscape',
  inputModality: 'touch',
  width: 852,
  height: 393,
};

const TV_VIEWPORT: ViewportOverride = {
  formFactor: 'tv',
  orientation: 'landscape',
  inputModality: 'tv',
  width: 1920,
  height: 1080,
};

function makeSource(id = 'src-1'): SourceRow {
  return {
    id,
    kind: 'xtream',
    name: 'Demo Live',
    createdAt: 1,
    needsImport: false,
    credentialFingerprint: 'fp-wave-p8-reg',
  };
}

function makeChannel(index: number): ItemRow {
  const num = 101 + index;
  return {
    id: index + 1,
    key: `x:src-1:live:${num}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(num),
    name: `Channel ${num}`,
    logo: `https://art.example.test/ch-${num}.png`,
    rating: null,
    year: null,
    num,
  };
}

function makeProgramme(channelKey: string, num: number): ProgrammeRow {
  return {
    channelKey,
    sourceId: 'src-1',
    guideId: `g-${num}`,
    start: NOW_MS - 20 * 60_000,
    stop: NOW_MS + 40 * 60_000,
    title: `Prime Live ${num}`,
    subTitle: null,
    description: `Broadcast ${num}`,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  };
}

function createCatalog(initialFavIndices: readonly number[] = [0, 1]) {
  const channels = Array.from({ length: 4 }, (_, i) => makeChannel(i));
  const categories: CategoryRow[] = [
    {
      id: 'src-1|live|cat-0',
      sourceId: 'src-1',
      kind: 'live',
      name: 'News',
      position: 0,
      itemCount: 4,
    },
  ];
  const favMap = new Map<string, FavoriteRow>();
  for (const idx of initialFavIndices) {
    const ch = channels[idx];
    if (ch) {
      favMap.set(ch.key, {
        profileId: 'default',
        sourceId: ch.sourceId,
        itemKey: ch.key,
        kind: 'live',
        title: ch.name,
        logo: ch.logo,
        year: null,
        rating: null,
        addedAt: NOW_MS - idx * 1_000,
      });
    }
  }

  const catalog = {
    listSources: jest.fn(async () => [makeSource()]),
    categories: jest.fn(async () => categories),
    items: jest.fn(async (_catId: string, offset: number, limit: number) =>
      channels.slice(offset, offset + limit),
    ),
    itemDetail: jest.fn(async (key: string) => {
      const ch = channels.find((c) => c.key === key);
      return ch ? { ...ch, plot: null } : null;
    }),
    resolveStream: jest.fn(async (itemKey: string) =>
      ok({ url: `http://sim.example.test/${encodeURIComponent(itemKey)}.ts`, headers: {} }),
    ),
    nowNext: jest.fn(async (keys: readonly string[]) =>
      keys.map<NowNextEntry>((k, i) => ({
        channelKey: k,
        now: makeProgramme(k, 101 + i),
        next: null,
      })),
    ),
    epgWindow: jest.fn(async () => ({})),
    listFavoriteKeys: jest.fn(async () => [...favMap.keys()]),
    listFavorites: jest.fn(async () => [...favMap.values()]),
    toggleFavorite: jest.fn(async (input: ToggleFavoriteInput) => {
      if (favMap.has(input.itemKey)) {
        favMap.delete(input.itemKey);
        return ok(false);
      }
      favMap.set(input.itemKey, {
        profileId: 'default',
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        logo: input.logo ?? null,
        year: null,
        rating: null,
        addedAt: NOW_MS,
      });
      return ok(true);
    }),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;

  return { catalog, channels };
}

function createAndroidSource() {
  let listener: ((event: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(cb) {
      listener = cb;
      return {
        remove() {
          listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
    });
  };
  return { source, sendKey };
}

function renderLive(
  ui: ReactElement,
  opts: {
    viewport?: ViewportOverride;
    routeActive?: boolean;
    androidSource?: AndroidKeySource;
  } = {},
) {
  return render(
    <RemoteKeysProvider android={opts.androidSource ?? null}>
      <RouteActiveProvider active={opts.routeActive ?? true}>
        <ViewportProvider value={opts.viewport ?? DESKTOP_VIEWPORT}>
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>{ui}</I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RouteActiveProvider>
    </RemoteKeysProvider>,
  );
}

describe('Wave P8 Live & Split Player review regressions', () => {
  const origOs = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
    jest.restoreAllMocks();
  });

  it('P0 #2: isolates touch double-tap to live-preview-surface-layer so rapid taps on controls/drawer never trigger Fullscreen', async () => {
    const { catalog, channels } = createCatalog([0, 1]);
    const onPlay = jest.fn();
    const engine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'floating',
        renderSurface: ({ testID }) => <View testID={testID ?? 'live-preview-surface'} />,
      }),
    };

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={videoHost}
        onPlay={onPlay}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
      { viewport: MOBILE_LANDSCAPE_VIEWPORT },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-video-pane')).toBeTruthy();
      expect(screen.getByTestId('live-preview-surface-layer')).toBeTruthy();
      expect(screen.getByTestId('live-split-play-pause')).toBeTruthy();
    });

    const videoPane = screen.getByTestId('live-video-pane');
    const surfaceLayer = screen.getByTestId('live-preview-surface-layer');
    expect(videoPane.props.onTouchStart).toBeUndefined();
    expect(typeof videoPane.props.onPointerMove).toBe('function');
    expect(typeof surfaceLayer.props.onTouchStart).toBe('function');

    // Rapid double-taps on controls, channel rows, and row star never trigger Fullscreen
    const ch1 = channels[1];
    if (!ch1) throw new Error('Expected channel 1');
    await fireEvent.press(screen.getByTestId('live-split-play-pause'));
    await fireEvent.press(screen.getByTestId('live-split-play-pause'));
    await fireEvent.press(screen.getByTestId('live-split-mute'));
    await fireEvent.press(screen.getByTestId('live-split-mute'));
    await fireEvent.press(screen.getByTestId('live-split-tracks'));
    await fireEvent.press(screen.getByTestId('live-split-tracks'));
    await fireEvent.press(screen.getByTestId('live-zap-row-1'));
    await fireEvent.press(screen.getByTestId('live-zap-row-1'));
    await fireEvent.press(screen.getByTestId(`live-zap-favorite-${ch1.key}`));
    expect(onPlay).not.toHaveBeenCalled();

    // Direct double-tap on live-preview-surface-layer triggers Fullscreen handoff
    await act(async () => {
      (surfaceLayer.props.onTouchStart as () => void)();
      (surfaceLayer.props.onTouchStart as () => void)();
    });
    await waitFor(() => {
      expect(onPlay).toHaveBeenCalledTimes(1);
    });

    await view.unmount();
  });

  it('P1 #3: awaits pending async engine.release() before opening next preview session (max_connections = 1)', async () => {
    const { catalog } = createCatalog([0]);
    const events: string[] = [];
    const resolvers: Array<() => void> = [];
    const open = jest.fn((): OpenVideoEngine => {
      const idx = resolvers.length + 1;
      events.push(`open-${idx}`);
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const origRelease = engine.release.bind(engine);
      engine.release = (() => {
        events.push(`release-start-${idx}`);
        origRelease();
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            events.push(`release-done-${idx}`);
            resolve();
          });
        });
      }) as unknown as () => void;
      return {
        engine,
        overlayMode: 'docked',
        renderSurface: ({ testID }) => <View testID={testID ?? 'live-preview-surface'} />,
      };
    });
    const videoHost: VideoHost = { open };

    const buildTree = (routeActive: boolean) => (
      <RouteActiveProvider active={routeActive}>
        <ViewportProvider value={DESKTOP_VIEWPORT}>
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <LiveScreen
                catalog={catalog}
                sources={[makeSource()]}
                refreshToken={0}
                memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
                videoHost={videoHost}
                onPlay={jest.fn()}
                onOpenSources={jest.fn()}
                nowMs={NOW_MS}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RouteActiveProvider>
    );

    const view = await render(buildTree(true));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

    // Freeze route -> starts async release-1, then immediately re-activate BEFORE release-1 settles
    await view.rerender(buildTree(false));
    expect(events).toEqual(['open-1', 'release-start-1']);

    await view.rerender(buildTree(true));
    // Must NOT call open-2 while release-1 is still pending!
    expect(open).toHaveBeenCalledTimes(1);

    // Resolve release-1 -> now open-2 proceeds strictly AFTER release-done-1
    await act(async () => {
      resolvers[0]?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(events).toEqual(['open-1', 'release-start-1', 'release-done-1', 'open-2']);

    await view.unmount();
  });

  it('P1 #4: releases active two-step preview before context Multi-View and Popout handoffs', async () => {
    const { catalog } = createCatalog([0, 1]);
    const events: string[] = [];
    const open = jest.fn((): OpenVideoEngine => {
      events.push('open');
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const origRelease = engine.release.bind(engine);
      engine.release = () => {
        events.push('release');
        origRelease();
      };
      return {
        engine,
        overlayMode: 'floating',
        renderSurface: ({ testID }) => <View testID={testID ?? 'live-preview-surface'} />,
      };
    });
    const onOpenMultiView = jest.fn(() => {
      events.push('onOpenMultiView');
    });
    const onOpenPopout = jest.fn(() => {
      events.push('onOpenPopout');
    });

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'channels' }}
        liveOkTwoStepPreview
        videoHost={{ open, supportsMultiView: true }}
        onPlay={jest.fn()}
        onOpenMultiView={onOpenMultiView}
        onOpenPopout={onOpenPopout}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('live-channel-card-0')).toBeTruthy());

    // First press starts two-step preview
    await fireEvent.press(screen.getByTestId('live-channel-card-0'));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

    // Long-press opens LiveContextMenu -> Open in Multi-View releases preview BEFORE dispatching
    await fireEvent(screen.getByTestId('live-channel-card-0'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('live-context-multiview')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('live-context-multiview'));
    await waitFor(() => expect(onOpenMultiView).toHaveBeenCalledTimes(1));
    expect(events.indexOf('release')).toBeGreaterThan(-1);
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('onOpenMultiView'));

    // Re-preview and test Popout context action release order
    events.length = 0;
    await fireEvent.press(screen.getByTestId('live-channel-card-1'));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await fireEvent(screen.getByTestId('live-channel-card-1'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('live-context-popout')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('live-context-popout'));
    await waitFor(() => expect(onOpenPopout).toHaveBeenCalledTimes(1));
    expect(events.indexOf('release')).toBeGreaterThan(-1);
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('onOpenPopout'));

    await view.unmount();
  });

  it('P1 #5: SplitVolumeSlider measures only the track wrapper (label outside), tracks window drag, suppresses synthetic onPress, and cleans up on unmount', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
    const winTarget =
      (globalThis as unknown as { window?: Record<string, unknown> }).window ??
      (globalThis as unknown as Record<string, unknown>);
    const origAdd = winTarget.addEventListener;
    const origRemove = winTarget.removeEventListener;
    winTarget.addEventListener = (type: string, fn: (e: Record<string, unknown>) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    winTarget.removeEventListener = (type: string, fn: (e: Record<string, unknown>) => void) => {
      listeners.get(type)?.delete(fn);
    };

    try {
      const { catalog } = createCatalog([0]);
      const setVolume = jest.fn();
      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });

      const view = await renderLive(
        <LiveScreen
          catalog={catalog}
          sources={[makeSource()]}
          refreshToken={0}
          memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
          videoHost={{
            open: () => ({
              engine,
              overlayMode: 'docked',
              initialVolume: 50,
              setVolume,
              renderSurface: ({ testID }) => <View testID={testID ?? 'live-preview-surface'} />,
            }),
          }}
          onPlay={jest.fn()}
          onOpenSources={jest.fn()}
          nowMs={NOW_MS}
        />,
      );

      await waitFor(() => expect(screen.getByTestId('live-split-volume')).toBeTruthy());

      // Percentage label sits OUTSIDE the measured track hit-box Pressable
      const slider = screen.getByTestId('live-split-volume');
      expect(screen.getByTestId('live-split-volume-label')).toHaveTextContent('50%');
      expect(within(slider).queryByTestId('live-split-volume-label')).toBeNull();

      // Pointer down on 84px track at x=84 -> exact 100%, attaches window pointermove/pointerup
      await act(async () => {
        (slider.props.onPointerDown as (e: Record<string, unknown>) => void)({
          button: 0,
          clientX: 184,
          currentTarget: { getBoundingClientRect: () => ({ left: 100, width: 84 }) },
        });
      });
      expect(setVolume).toHaveBeenLastCalledWith(100);
      expect(listeners.get('pointermove')?.size).toBe(1);
      expect(listeners.get('pointerup')?.size).toBe(1);

      // Dragging horizontally (even after vertical drift off element) updates via window listener
      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) {
          fn({ clientX: 142, buttons: 1 });
        }
      });
      expect(setVolume).toHaveBeenLastCalledWith(50);

      // Pointer up commits final position and detaches window listeners
      await act(async () => {
        for (const fn of listeners.get('pointerup') ?? []) {
          fn({ clientX: 163 });
        }
      });
      expect(setVolume).toHaveBeenLastCalledWith(75);
      expect(listeners.get('pointermove')?.size ?? 0).toBe(0);
      expect(listeners.get('pointerup')?.size ?? 0).toBe(0);

      // Synthetic onPress right after pointerDown/pointerUp must be suppressed (no double-commit)
      const callsAfterUp = setVolume.mock.calls.length;
      await fireEvent.press(slider, { nativeEvent: { locationX: 10 } });
      expect(setVolume.mock.calls.length).toBe(callsAfterUp);

      // Starting another drag and unmounting mid-drag removes all window listeners
      await act(async () => {
        (slider.props.onPointerDown as (e: Record<string, unknown>) => void)({
          button: 0,
          clientX: 121,
          currentTarget: { getBoundingClientRect: () => ({ left: 100, width: 84 }) },
        });
      });
      expect(listeners.get('pointermove')?.size).toBe(1);
      await view.unmount();
      expect(listeners.get('pointermove')?.size ?? 0).toBe(0);
      expect(listeners.get('pointerup')?.size ?? 0).toBe(0);
    } finally {
      winTarget.addEventListener = origAdd;
      winTarget.removeEventListener = origRemove;
    }
  });

  it('P1 #7: gates openedPreview.onHostKey with keyboardShortcutsEnabled when overlays open or route is inactive', async () => {
    const { catalog } = createCatalog([0, 1]);
    const hostKeyListeners = new Set<(key: HostKey) => void>();
    const setMuted = jest.fn();
    const onPlay = jest.fn();
    const engine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        overlayMode: 'docked',
        setMuted,
        onHostKey: (listener) => {
          hostKeyListeners.add(listener);
          return () => hostKeyListeners.delete(listener);
        },
        renderSurface: ({ testID }) => <View testID={testID ?? 'live-preview-surface'} />,
      }),
    };

    const buildTree = (isActiveScope: boolean) => (
      <RouteActiveProvider active>
        <ViewportProvider value={DESKTOP_VIEWPORT}>
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <LiveScreen
                catalog={catalog}
                sources={[makeSource()]}
                refreshToken={0}
                memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
                videoHost={videoHost}
                isActiveScope={isActiveScope}
                onPlay={onPlay}
                onOpenSources={jest.fn()}
                nowMs={NOW_MS}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RouteActiveProvider>
    );

    const view = await render(buildTree(true));
    await waitFor(() => expect(hostKeyListeners.size).toBe(1));

    // Active scope with no overlay: host keys fire normally
    await act(async () => {
      for (const l of hostKeyListeners) l('mute');
    });
    expect(setMuted).toHaveBeenCalledTimes(1);

    // Opening LiveContextMenu unsubscribes host keys so they never fire behind the overlay
    await fireEvent(screen.getByTestId('live-zap-row-0'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('live-context-menu')).toBeTruthy());
    expect(hostKeyListeners.size).toBe(0);

    // Closing LiveContextMenu re-subscribes host keys
    await fireEvent.press(screen.getByTestId('live-context-menu-backdrop'));
    await waitFor(() => expect(hostKeyListeners.size).toBe(1));

    // Deactivating Live scope (isActiveScope=false) also unsubscribes host keys
    await view.rerender(buildTree(false));
    expect(hostKeyListeners.size).toBe(0);

    await view.unmount();
  });

  it('P1 #8: re-sends setResizeMode on playing/paused after zapping so desktop mpv keeps chosen aspect mode', async () => {
    const { catalog } = createCatalog([0, 1]);
    const setResizeMode = jest.fn<void, [VideoResizeMode]>();
    const engine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={{
          open: () => ({
            engine,
            overlayMode: 'docked',
            setResizeMode,
            renderSurface: ({ testID }) => <View testID={testID ?? 'live-preview-surface'} />,
          }),
        }}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    const attempt1 = engine.commands.find((c) => c.name === 'load')?.attempt;
    if (attempt1 === undefined) throw new Error('Expected first load attempt');
    await act(async () => {
      engine.emit({ attempt: attempt1, type: 'state', state: 'playing' });
    });

    // User switches aspect mode to 'cover' ('fill')
    await fireEvent.press(screen.getByTestId('live-split-aspect'));
    expect(setResizeMode).toHaveBeenLastCalledWith('fill');
    setResizeMode.mockClear();

    // Zap to favorite channel 1 -> once new stream enters playing, setResizeMode('fill') is re-sent
    await fireEvent.press(screen.getByTestId('live-zap-row-1'));
    await waitFor(() => expect(engine.commands.filter((c) => c.name === 'load').length).toBe(2));
    const attempt2 = engine.commands.filter((c) => c.name === 'load')[1]?.attempt;
    if (attempt2 === undefined) throw new Error('Expected second load attempt');
    await act(async () => {
      engine.emit({ attempt: attempt2, type: 'state', state: 'playing' });
    });

    await waitFor(() => {
      expect(setResizeMode).toHaveBeenCalledWith('fill');
    });

    await view.unmount();
  });

  it('P1 #13: TV Red button in Favorites mode prefers activeFavoriteChannel over a non-favorite live.activeChannel', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    // Channel 101 (index 0) is a favorite; Channel 103 (index 2) is NOT a favorite but is live.activeChannel
    const { catalog, channels } = createCatalog([0]);
    const favCh = channels[0];
    const nonFavCh = channels[2];
    if (!favCh || !nonFavCh) throw new Error('Expected channels');

    const android = createAndroidSource();
    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites', activeChannelKey: nonFavCh.key }}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        isActiveScope
        nowMs={NOW_MS}
      />,
      { viewport: TV_VIEWPORT, androidSource: android.source },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('101 · Channel 101');
    });

    // Pressing TV Red toggles activeFavoriteChannel (101), NOT the non-favorite live.activeChannel (103)
    await android.sendKey(KEYCODE_PROG_RED);
    expect(catalog.toggleFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: favCh.key }),
    );
    expect(catalog.toggleFavorite).not.toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: nonFavCh.key }),
    );

    await view.unmount();
  });
});
