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
import { createPlaybackGuard, ok } from '@elv/domain';
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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine, VideoHost, VideoResizeMode } from '../../ports/video-host';
import { RouteActiveProvider } from '../../shared';
import { LiveScreen } from '../LiveScreen';
import { EMPTY_LIVE_MEMORY } from '../live-model';

const NOW_MS = Date.UTC(2026, 10, 27, 20, 0, 0);

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1440,
  height: 900,
};

const TV_VIEWPORT: ViewportOverride = {
  formFactor: 'tv',
  orientation: 'landscape',
  inputModality: 'tv',
  width: 1920,
  height: 1080,
};

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

function makeSource(id = 'src-1'): SourceRow {
  return {
    id,
    kind: 'xtream',
    name: 'Demo Live',
    createdAt: 1,
    needsImport: false,
    credentialFingerprint: 'fp-wave-p8',
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

function createRichVideoHost(
  events: string[],
  opts: { overlayMode?: 'floating' | 'docked'; initialVolume?: number } = {},
) {
  const engines: ReturnType<typeof createFakePlayerEngine>[] = [];
  const setMuted = jest.fn();
  const setVolume = jest.fn();
  const setResizeMode = jest.fn<void, [VideoResizeMode]>();
  const setAudioDevice = jest.fn<void, [string]>();

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
    engines.push(engine);
    return {
      engine,
      ...(opts.overlayMode !== undefined ? { overlayMode: opts.overlayMode } : {}),
      ...(opts.initialVolume !== undefined ? { initialVolume: opts.initialVolume } : {}),
      setMuted,
      setVolume,
      setResizeMode,
      getAudioDevices: () => [
        { name: 'auto', description: 'System Default' },
        { name: 'hdmi-0', description: 'HDMI Audio' },
      ],
      getActiveAudioDevice: () => 'auto',
      setAudioDevice,
      renderSurface: ({ testID, resizeMode }) => (
        <View testID={testID ?? 'fallback-surface'} accessibilityHint={resizeMode} />
      ),
    };
  });

  const videoHost: VideoHost = { open, supportsMultiView: true };
  return { videoHost, open, engines, setMuted, setVolume, setResizeMode, setAudioDevice };
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
  opts: { viewport?: ViewportOverride; androidSource?: AndroidKeySource } = {},
) {
  return render(
    <RemoteKeysProvider android={opts.androidSource ?? null}>
      <RouteActiveProvider active>
        <ViewportProvider value={opts.viewport ?? DESKTOP_VIEWPORT}>
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>{ui}</I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RouteActiveProvider>
    </RemoteKeysProvider>,
  );
}

describe('Wave P8 [1.31] Live -> Favorites Full Split Player', () => {
  const origOs = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('removes top actionBar and moves star favorite toggle onto right edge of every LiveZapRow without tuning channel', async () => {
    const { catalog, channels } = createCatalog([0, 1]);
    const events: string[] = [];
    const { videoHost, engines } = createRichVideoHost(events, { overlayMode: 'docked' });
    const onPlay = jest.fn();

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
    );

    const ch0 = channels[0];
    const ch1 = channels[1];
    if (!ch0 || !ch1) throw new Error('Expected two test channels');

    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-zap-drawer')).toBeTruthy();
      expect(screen.getByTestId(`live-zap-favorite-${ch0.key}`)).toBeTruthy();
      expect(screen.getByTestId(`live-zap-favorite-${ch1.key}`)).toBeTruthy();
    });

    // Top actionBar and legacy top buttons are completely gone
    expect(screen.queryByTestId('live-stage-actions')).toBeNull();
    expect(screen.queryByTestId('live-toggle-miniguide')).toBeNull();
    expect(screen.queryByTestId('live-stage-favorite')).toBeNull();

    // Row star button uses localized live.zap.favoriteRemove label
    const starBtn1 = screen.getByTestId(`live-zap-favorite-${ch1.key}`);
    expect(starBtn1.props.accessibilityLabel).toBe('Remove from Favorites');

    const loadCountBefore = engines[0]?.commands.filter((c) => c.name === 'load').length ?? 0;
    const stopPropagation = jest.fn();
    await fireEvent.press(starBtn1, { stopPropagation });

    expect(stopPropagation).toHaveBeenCalled();
    expect(catalog.toggleFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: ch1.key }),
    );
    expect(onPlay).not.toHaveBeenCalled();
    // Must NOT have tuned to channel 102 when unstarring row 1
    expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('101 · Channel 101');
    expect(engines[0]?.commands.filter((c) => c.name === 'load').length ?? 0).toBe(loadCountBefore);

    await view.unmount();
  });

  it('wires full embedded player controls (play/pause, mute, volume, aspect, tracks, overflow, multiview, popout)', async () => {
    const { catalog } = createCatalog([0, 1]);
    const events: string[] = [];
    const host = createRichVideoHost(events, { overlayMode: 'docked', initialVolume: 80 });
    const onPlay = jest.fn();
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
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={host.videoHost}
        playbackGuard={createPlaybackGuard()}
        onPlay={onPlay}
        onOpenMultiView={onOpenMultiView}
        onOpenPopout={onOpenPopout}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-preview-surface')).toBeTruthy();
      expect(host.engines[0]?.commands.some((c) => c.name === 'load')).toBe(true);
    });

    const engine = host.engines[0];
    const attempt = engine?.commands.find((c) => c.name === 'load')?.attempt;
    if (!engine || attempt === undefined) throw new Error('Expected active load attempt');

    // Drive engine into playing + emit tracks & videoInfo
    await act(async () => {
      engine.emit({ attempt, type: 'state', state: 'playing' });
      engine.emit({
        attempt,
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'a1', label: 'English Stereo', language: 'en' },
            { id: 'a2', label: 'Turkish 5.1', language: 'tr' },
          ],
          subtitles: [{ id: 's1', label: 'English CC', language: 'en' }],
          selectedAudioId: 'a1',
          selectedSubtitleId: null,
        },
      });
      engine.emit({
        attempt,
        type: 'mediaInfo',
        info: { width: 1920, height: 1080, fps: 50, codec: 'hevc', hdr: 'hdr10' },
      });
    });

    // Controls render in flex-flow below video surface in docked HWND mode (never position: 'absolute')
    const controlsStyle = StyleSheet.flatten(screen.getByTestId('live-split-controls').props.style);
    expect(controlsStyle.position).not.toBe('absolute');

    // Play / Pause
    await fireEvent.press(screen.getByTestId('live-split-play-pause'));
    expect(engine.commands.some((c) => c.name === 'pause')).toBe(true);
    await act(async () => {
      engine.emit({ attempt: attempt + 1, type: 'state', state: 'paused' });
    });
    await fireEvent.press(screen.getByTestId('live-split-play-pause'));
    expect(engine.commands.some((c) => c.name === 'play')).toBe(true);

    // Mute + Volume slider
    await fireEvent.press(screen.getByTestId('live-split-mute'));
    expect(host.setMuted).toHaveBeenCalledWith(true);

    const volumeSlider = screen.getByTestId('live-split-volume');
    await fireEvent(volumeSlider, 'accessibilityAction', {
      nativeEvent: { actionName: 'decrement' },
    });
    expect(host.setVolume).toHaveBeenCalled();

    // Aspect Ratio cycle: contain -> cover (fill) -> stretch -> contain (fit)
    await fireEvent.press(screen.getByTestId('live-split-aspect'));
    expect(host.setResizeMode).toHaveBeenLastCalledWith('fill');
    await fireEvent.press(screen.getByTestId('live-split-aspect'));
    expect(host.setResizeMode).toHaveBeenLastCalledWith('stretch');
    await fireEvent.press(screen.getByTestId('live-split-aspect'));
    expect(host.setResizeMode).toHaveBeenLastCalledWith('fit');

    // Tracks in-tree panel (HWND-safe docked: NOT position: 'absolute')
    await fireEvent.press(screen.getByTestId('live-split-tracks'));
    const tracksPanel = screen.getByTestId('live-split-tracks-panel');
    expect(StyleSheet.flatten(tracksPanel.props.style).position).not.toBe('absolute');

    await fireEvent.press(screen.getByTestId('live-split-audio-track-a2'));
    expect(engine.commands.some((c) => c.name === 'selectAudioTrack' && c.trackId === 'a2')).toBe(
      true,
    );

    await fireEvent.press(screen.getByTestId('live-split-subtitle-track-s1'));
    expect(
      engine.commands.some((c) => c.name === 'selectSubtitleTrack' && c.trackId === 's1'),
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('live-split-subtitle-off'));
    expect(
      engine.commands.some((c) => c.name === 'selectSubtitleTrack' && c.trackId === null),
    ).toBe(true);

    // Overflow in-tree panel shows videoInfo + audio devices (zero RN Modal, docked HWND-safe)
    await fireEvent.press(screen.getByTestId('live-split-overflow'));
    const overflowPanel = screen.getByTestId('live-split-overflow-panel');
    expect(StyleSheet.flatten(overflowPanel.props.style).position).not.toBe('absolute');
    expect(screen.getByText(/1920×1080/)).toBeTruthy();
    expect(screen.getByText(/HEVC/i)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('live-split-audio-device-hdmi-0'));
    expect(host.setAudioDevice).toHaveBeenCalledWith('hdmi-0');

    // Multi-View button releases preview engine BEFORE calling onOpenMultiView (max_connections = 1)
    await fireEvent.press(screen.getByTestId('live-split-multiview'));
    await waitFor(() => {
      expect(onOpenMultiView).toHaveBeenCalledTimes(1);
    });
    expect(events.indexOf('release')).toBeGreaterThan(-1);
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('onOpenMultiView'));

    await view.unmount();
  });

  it('supports double-click on video surface for fullscreen handoff and Popout single-connection release', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const { catalog } = createCatalog([0]);
    const events: string[] = [];
    const host = createRichVideoHost(events, { overlayMode: 'docked' });
    const played: PlayTarget[] = [];

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={host.videoHost}
        onPlay={(target) => {
          events.push('onPlay');
          played.push(target);
        }}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-preview-surface-layer')).toBeTruthy();
      expect(host.engines[0]?.commands.some((c) => c.name === 'load')).toBe(true);
    });

    const surfaceLayer = screen.getByTestId('live-preview-surface-layer');
    await act(async () => {
      (surfaceLayer.props.onDoubleClick as (() => void) | undefined)?.();
    });

    await waitFor(() => {
      expect(played).toHaveLength(1);
    });
    expect(events.indexOf('release')).toBeGreaterThan(-1);
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('onPlay'));

    await view.unmount();

    // Popout handoff also releases preview BEFORE calling onOpenPopout
    const popEvents: string[] = [];
    const popHost = createRichVideoHost(popEvents, { overlayMode: 'docked' });
    const onOpenPopout = jest.fn(() => {
      popEvents.push('onOpenPopout');
    });

    const view2 = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={popHost.videoHost}
        onPlay={jest.fn()}
        onOpenPopout={onOpenPopout}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-split-popout')).toBeTruthy();
      expect(popHost.engines[0]?.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await fireEvent.press(screen.getByTestId('live-split-popout'));
    await waitFor(() => {
      expect(onOpenPopout).toHaveBeenCalledTimes(1);
    });
    expect(popEvents.indexOf('release')).toBeGreaterThan(-1);
    expect(popEvents.indexOf('release')).toBeLessThan(popEvents.indexOf('onOpenPopout'));

    await view2.unmount();
  });

  it('auto-hides floating controls on idle while playing and reveals on pointer move when overlayMode is floating', async () => {
    jest.useFakeTimers();
    const { catalog } = createCatalog([0]);
    const events: string[] = [];
    const host = createRichVideoHost(events, { overlayMode: 'floating' });

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={host.videoHost}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-split-controls')).toBeTruthy();
      expect(host.engines[0]?.commands.some((c) => c.name === 'load')).toBe(true);
    });

    const engine = host.engines[0];
    const attempt = engine?.commands.find((c) => c.name === 'load')?.attempt;
    if (!engine || attempt === undefined) throw new Error('Expected active load attempt');
    await act(async () => {
      engine.emit({ attempt, type: 'state', state: 'playing' });
    });

    const floatingStyleBefore = StyleSheet.flatten(
      screen.getByTestId('live-split-controls-overlay').props.style,
    );
    expect(floatingStyleBefore.position).toBe('absolute');
    expect(floatingStyleBefore.opacity).toBe(1);

    // After idle timeout, floating controls smoothly auto-hide
    await act(async () => {
      jest.advanceTimersByTime(4_000);
    });
    const floatingStyleHidden = StyleSheet.flatten(
      screen.getByTestId('live-split-controls-overlay').props.style,
    );
    expect(floatingStyleHidden.opacity).toBe(0);

    // Pointer move on video stage reveals controls immediately
    const stage = screen.getByTestId('live-video-pane');
    await act(async () => {
      (stage.props.onPointerMove as (() => void) | undefined)?.();
    });
    const floatingStyleRevealed = StyleSheet.flatten(
      screen.getByTestId('live-split-controls-overlay').props.style,
    );
    expect(floatingStyleRevealed.opacity).toBe(1);

    await view.unmount();
  });

  it('handles desktop keyboard shortcuts (k, Space, m, f, Shift+ArrowUp/Down) without hijacking inputs or plain arrows', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
    const origAdd = (globalThis as Record<string, unknown>).addEventListener;
    const origRemove = (globalThis as Record<string, unknown>).removeEventListener;
    (globalThis as Record<string, unknown>).addEventListener = (
      type: string,
      fn: (e: Record<string, unknown>) => void,
    ) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    (globalThis as Record<string, unknown>).removeEventListener = (
      type: string,
      fn: (e: Record<string, unknown>) => void,
    ) => {
      listeners.get(type)?.delete(fn);
    };

    try {
      const { catalog } = createCatalog([0, 1]);
      const events: string[] = [];
      const host = createRichVideoHost(events, { overlayMode: 'docked', initialVolume: 50 });
      const onPlay = jest.fn();

      const view = await renderLive(
        <LiveScreen
          catalog={catalog}
          sources={[makeSource()]}
          refreshToken={0}
          memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
          videoHost={host.videoHost}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
          nowMs={NOW_MS}
        />,
      );

      await waitFor(() => {
        expect(host.engines[0]?.commands.some((c) => c.name === 'load')).toBe(true);
      });
      const engine = host.engines[0];
      const attempt = engine?.commands.find((c) => c.name === 'load')?.attempt;
      if (!engine || attempt === undefined) throw new Error('Expected active load attempt');
      await act(async () => {
        engine.emit({ attempt, type: 'state', state: 'playing' });
      });

      const fireKey = async (evt: Record<string, unknown>) => {
        await act(async () => {
          for (const fn of listeners.get('keydown') ?? []) fn(evt);
        });
      };

      // Input target is ignored
      await fireKey({ key: 'm', target: { tagName: 'INPUT' }, preventDefault: jest.fn() });
      expect(host.setMuted).not.toHaveBeenCalled();

      // Plain ArrowUp / ArrowDown must NOT hijack channel list navigation
      await fireKey({ key: 'ArrowUp', preventDefault: jest.fn() });
      await fireKey({ key: 'ArrowDown', preventDefault: jest.fn() });
      expect(host.setVolume).not.toHaveBeenCalled();

      // Shift+ArrowUp increases volume
      await fireKey({ key: 'ArrowUp', shiftKey: true, preventDefault: jest.fn() });
      expect(host.setVolume).toHaveBeenLastCalledWith(60);

      // 'm' toggles mute
      await fireKey({ key: 'm', preventDefault: jest.fn() });
      expect(host.setMuted).toHaveBeenCalledWith(true);

      // 'k' toggles pause
      await fireKey({ key: 'k', preventDefault: jest.fn() });
      expect(engine.commands.some((c) => c.name === 'pause')).toBe(true);

      // 'f' triggers fullscreen handoff
      await fireKey({ key: 'f', preventDefault: jest.fn() });
      await waitFor(() => {
        expect(onPlay).toHaveBeenCalledTimes(1);
      });

      await view.unmount();
    } finally {
      (globalThis as Record<string, unknown>).addEventListener = origAdd;
      (globalThis as Record<string, unknown>).removeEventListener = origRemove;
    }
  });

  it('wires 10-ft TV D-pad smoothly between LiveZapDrawer rows and split player controls in visual order (play-pause, tracks, fullscreen, overflow)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const { catalog } = createCatalog([0, 1]);
    const events: string[] = [];
    const host = createRichVideoHost(events, { overlayMode: 'floating' });
    const android = createAndroidSource();
    const onPlay = jest.fn();

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={host.videoHost}
        onPlay={onPlay}
        onOpenSources={jest.fn()}
        isActiveScope
        nowMs={NOW_MS}
      />,
      { viewport: TV_VIEWPORT, androidSource: android.source },
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-zap-row-0')).toBeTruthy();
      expect(screen.getByTestId('live-split-play-pause')).toBeTruthy();
    });

    // Down from Modes header enters LiveZapDrawer row 0 -> Down to row 1 -> Select tunes Channel 102
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('102 · Channel 102');
    });

    // Right enters controls at 'play-pause' -> Left returns to drawer -> Right traverses exact visual order:
    // play-pause -> tracks -> fullscreen -> overflow -> Left back to fullscreen -> Select invokes onPlay
    await android.sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-split-play-pause-focus-ring')).toBeTruthy();

    await android.sendKey(KEYCODE_DPAD_LEFT);
    expect(screen.queryByTestId('live-split-play-pause-focus-ring')).toBeNull();

    await android.sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-split-play-pause-focus-ring')).toBeTruthy();

    await android.sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-split-tracks-focus-ring')).toBeTruthy();

    await android.sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-watch-fullscreen-focus-ring')).toBeTruthy();

    await android.sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-split-overflow-focus-ring')).toBeTruthy();

    await android.sendKey(KEYCODE_DPAD_LEFT);
    expect(screen.getByTestId('live-watch-fullscreen-focus-ring')).toBeTruthy();

    await android.sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(onPlay).toHaveBeenCalledTimes(1);
    });
    expect(onPlay.mock.calls[0]?.[0]?.itemKey).toBe('x:src-1:live:102');

    await view.unmount();
  });
});
