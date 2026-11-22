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
import { createPlaybackGuard, elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { I18nProvider, ThemeProvider, type ViewportOverride, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { RouteActiveProvider } from '../../shared';
import { LiveScreen } from '../LiveScreen';
import { EMPTY_LIVE_MEMORY } from '../live-model';

const NOW_MS = Date.UTC(2026, 10, 21, 18, 15, 0);

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 800,
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
    credentialFingerprint: 'fp-demo-account',
  };
}

function makeCategories(count = 2): CategoryRow[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `src-1|live|cat-${idx}`,
    sourceId: 'src-1',
    kind: 'live' as const,
    name: idx === 0 ? 'News' : `Category ${idx}`,
    position: idx,
    itemCount: 4,
  }));
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
    start: NOW_MS - 15 * 60_000,
    stop: NOW_MS + 45 * 60_000,
    title: `Live Show ${num}`,
    subTitle: null,
    description: `Broadcast ${num}`,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  };
}

function createStatefulFavoriteCatalog(initialFavIndices: readonly number[] = []) {
  const channels = Array.from({ length: 4 }, (_, i) => makeChannel(i));
  const categories = makeCategories(8);
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

  const resolvedKeys: string[] = [];
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
    resolveStream: jest.fn(async (itemKey: string) => {
      resolvedKeys.push(itemKey);
      return ok({ url: `http://sim.example.test/${encodeURIComponent(itemKey)}.ts`, headers: {} });
    }),
    nowNext: jest.fn(async (keys: readonly string[]) =>
      keys.map<NowNextEntry>((k, i) => ({
        channelKey: k,
        now: makeProgramme(k, 101 + i),
        next: null,
      })),
    ),
    epgWindow: jest.fn(async (keys: readonly string[]) => {
      const out: Record<string, ProgrammeRow[]> = {};
      keys.forEach((k, i) => {
        out[k] = [makeProgramme(k, 101 + i)];
      });
      return out;
    }),
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

  return { catalog, channels, resolvedKeys };
}

function createTrackingVideoHost(events: string[]) {
  const engines: ReturnType<typeof createFakePlayerEngine>[] = [];
  const open = jest.fn(() => {
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
      renderSurface: ({ testID }: { statusText: string; failed: boolean; testID?: string }) => (
        <View testID={testID ?? 'fallback-surface'} />
      ),
    };
  });
  const videoHost: VideoHost = { open };
  return { videoHost, open, engines };
}

function renderLive(
  ui: ReactElement,
  opts: { viewport?: ViewportOverride; routeActive?: boolean } = {},
) {
  return render(
    <RouteActiveProvider active={opts.routeActive ?? true}>
      <ViewportProvider value={opts.viewport ?? DESKTOP_VIEWPORT}>
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>{ui}</I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    </RouteActiveProvider>,
  );
}

describe('Live Favorites, Editorial Categories & Embedded Live Preview', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders Favorites | Channels | TV Guide, uses EditorialCategoryBar, and handles empty Favorites CTA', async () => {
    const { catalog } = createStatefulFavoriteCatalog([]);

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-mode-favorites')).toBeTruthy();
      expect(screen.getByTestId('live-mode-channels')).toBeTruthy();
      expect(screen.getByTestId('live-mode-epg')).toBeTruthy();
      expect(screen.getByTestId('live-category-chips-rail')).toBeTruthy();
      expect(screen.getByTestId('live-cat-chip-0')).toBeTruthy();
      expect(screen.getByTestId('live-channel-count')).toBeTruthy();
      expect(screen.getByTestId('live-category-chips-picker-trigger')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('live-mode-favorites'));
    await waitFor(() => {
      expect(screen.getByTestId('live-favorites-empty')).toBeTruthy();
      expect(screen.getByTestId('live-browse-channels')).toBeTruthy();
    });
    expect(screen.queryByTestId('live-prev-channel')).toBeNull();
    expect(screen.queryByTestId('live-toggle-numpad')).toBeNull();

    await fireEvent.press(screen.getByTestId('live-browse-channels'));
    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
    });

    await view.unmount();
  });

  it('toggles favorites in Channels, EPG, and Favorites stage without launching fullscreen on star click', async () => {
    const { catalog } = createStatefulFavoriteCatalog([]);
    const onPlay = jest.fn();

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        onPlay={onPlay}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-fav-0')).toBeTruthy();
    });

    // Starring channel 0 in Channels must NOT trigger onPlay
    await fireEvent.press(screen.getByTestId('live-channel-fav-0'));
    expect(onPlay).not.toHaveBeenCalled();
    expect(catalog.toggleFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'x:src-1:live:101', kind: 'live' }),
    );

    // Switching to Favorites now shows channel 0 with no prev/numpad clutter
    await fireEvent.press(screen.getByTestId('live-mode-favorites'));
    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('101 · Channel 101');
      expect(screen.getByTestId('live-stage-favorite')).toBeTruthy();
    });
    expect(screen.queryByTestId('live-prev-channel')).toBeNull();
    expect(screen.queryByTestId('live-toggle-numpad')).toBeNull();

    // Unstarring the only favorite returns to empty state
    await fireEvent.press(screen.getByTestId('live-stage-favorite'));
    await waitFor(() => {
      expect(screen.getByTestId('live-favorites-empty')).toBeTruthy();
    });

    // Starring from TV Guide EpgPreviewHeader populates Favorites again
    await fireEvent.press(screen.getByTestId('live-mode-epg'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-favorite-toggle')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('epg-favorite-toggle'));
    await fireEvent.press(screen.getByTestId('live-mode-favorites'));
    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('101 · Channel 101');
    });

    await view.unmount();
  });

  it('opens real embedded preview on Favorites, zaps on same engine, and releases BEFORE calling onPlay on Watch fullscreen', async () => {
    const events: string[] = [];
    const { catalog } = createStatefulFavoriteCatalog([0, 1]);
    const { videoHost, open, engines } = createTrackingVideoHost(events);
    const guard = createPlaybackGuard();
    const played: PlayTarget[] = [];

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={videoHost}
        playbackGuard={guard}
        onPlay={(target) => {
          events.push('onPlay');
          played.push(target);
        }}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
      { viewport: DESKTOP_VIEWPORT },
    );

    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('live-preview-surface')).toBeTruthy();
      expect(engines[0]?.commands.some((c) => c.name === 'load')).toBe(true);
    });

    // Desktop HWND safety: stage uses flex-row and surface is NOT StyleSheet.absoluteFill
    const stageStyle = StyleSheet.flatten(screen.getByTestId('live-watch-stage').props.style);
    expect(stageStyle.flexDirection).toBe('row');
    const drawerStyle = StyleSheet.flatten(screen.getByTestId('live-zap-drawer').props.style);
    expect(drawerStyle.position).not.toBe('absolute');
    const surfaceLayerStyle = StyleSheet.flatten(
      screen.getByTestId('live-preview-surface-layer').props.style,
    );
    expect(surfaceLayerStyle.position).not.toBe('absolute');

    // Selecting favorite channel 1 in LiveZapDrawer tunes on the SAME open engine (zero respawn)
    await fireEvent.press(screen.getByTestId('live-zap-row-1'));
    await waitFor(() => {
      expect(engines[0]?.commands.filter((c) => c.name === 'load').length).toBeGreaterThanOrEqual(
        2,
      );
    });
    expect(open).toHaveBeenCalledTimes(1);

    // Watch fullscreen releases preview BEFORE invoking onPlay (single-connection safety)
    await fireEvent.press(screen.getByTestId('live-watch-fullscreen'));
    await waitFor(() => {
      expect(played).toHaveLength(1);
    });
    expect(events.indexOf('release')).toBeGreaterThan(-1);
    expect(events.indexOf('release')).toBeLessThan(events.indexOf('onPlay'));
    expect(engines[0]?.openMedias()).toBe(0);

    await view.unmount();
  });

  it('releases embedded preview on mode leave, route freeze, and playbackGuard stop, and renders full-bleed on TV', async () => {
    const events: string[] = [];
    const { catalog } = createStatefulFavoriteCatalog([0]);
    const { videoHost, open, engines } = createTrackingVideoHost(events);
    const guard = createPlaybackGuard();
    const sources = [makeSource()];

    const buildTree = (routeActive: boolean) => (
      <RouteActiveProvider active={routeActive}>
        <ViewportProvider value={TV_VIEWPORT}>
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <LiveScreen
                catalog={catalog}
                sources={sources}
                refreshToken={0}
                memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
                videoHost={videoHost}
                playbackGuard={guard}
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
    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('live-preview-surface')).toBeTruthy();
    });

    // Non-desktop renders full-bleed absoluteFill surface behind scrims
    const surfaceLayerStyle = StyleSheet.flatten(
      screen.getByTestId('live-preview-surface-layer').props.style,
    );
    expect(surfaceLayerStyle.position).toBe('absolute');

    // Freezing route releases preview engine cleanly
    await view.rerender(buildTree(false));
    await waitFor(() => {
      expect(engines[0]?.openMedias()).toBe(0);
      expect(events).toContain('release');
    });

    // Re-activating opens again, and playbackGuard stops it on source removal
    await view.rerender(buildTree(true));
    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await guard.stopIfUsingSource('src-1');
    });
    await waitFor(() => {
      expect(engines[1]?.openMedias()).toBe(0);
    });

    await view.unmount();
  });

  it('guards fullscreen handoff against throwing release, double-clicks, and unmount during async release', async () => {
    // 1) Throwing engine.release() must not block onPlay
    const { catalog } = createStatefulFavoriteCatalog([0]);
    const throwingEngine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    throwingEngine.release = () => {
      throw new Error('release boom');
    };
    const onPlayThrow = jest.fn();
    const view1 = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={{
          open: () => ({
            engine: throwingEngine,
            renderSurface: ({ testID }) => <View testID={testID} />,
          }),
        }}
        onPlay={onPlayThrow}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('live-preview-surface')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('live-watch-fullscreen'));
    await waitFor(() => expect(onPlayThrow).toHaveBeenCalledTimes(1));
    await view1.unmount();

    // 2) Double-click during slow async release invokes onPlay at most once, and unmount suppresses onPlay
    let finishRelease: (() => void) | null = null;
    const asyncEngine = createFakePlayerEngine({
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    asyncEngine.release = (() =>
      new Promise<void>((resolve) => {
        finishRelease = resolve;
      })) as unknown as () => void;
    const onPlayRace = jest.fn();
    const view2 = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        videoHost={{
          open: () => ({
            engine: asyncEngine,
            renderSurface: ({ testID }) => <View testID={testID} />,
          }),
        }}
        onPlay={onPlayRace}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('live-preview-surface')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('live-watch-fullscreen'));
    await fireEvent.press(screen.getByTestId('live-watch-fullscreen'));
    await view2.unmount();
    await act(async () => {
      finishRelease?.();
    });
    expect(onPlayRace).not.toHaveBeenCalled();
  });

  it('recovers embedded preview on surviving source after multi-source playbackGuard teardown and keeps desktop docked in portrait window', async () => {
    const src1 = makeSource('src-1');
    const src2 = makeSource('src-2');
    const ch1 = makeChannel(0);
    const ch2: ItemRow = {
      ...makeChannel(1),
      key: 'x:src-2:live:102',
      sourceId: 'src-2',
    };
    const cat1: CategoryRow = {
      id: 'src-1|live|cat-0',
      sourceId: 'src-1',
      kind: 'live',
      name: 'News',
      position: 0,
      itemCount: 1,
    };
    const cat2: CategoryRow = {
      id: 'src-2|live|cat-0',
      sourceId: 'src-2',
      kind: 'live',
      name: 'Sports',
      position: 0,
      itemCount: 1,
    };
    const multiCatalog = {
      listSources: jest.fn(async () => [src1, src2]),
      categories: jest.fn(async (sid: string) => (sid === 'src-1' ? [cat1] : [cat2])),
      items: jest.fn(async (cid: string) => (cid.startsWith('src-1') ? [ch1] : [ch2])),
      itemDetail: jest.fn(async (key: string) =>
        key === ch1.key ? { ...ch1, plot: null } : key === ch2.key ? { ...ch2, plot: null } : null,
      ),
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${encodeURIComponent(key)}.ts`, headers: {} }),
      ),
      nowNext: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => [ch1.key, ch2.key]),
      listFavorites: jest.fn(
        async (): Promise<FavoriteRow[]> => [
          {
            profileId: 'default',
            sourceId: 'src-1',
            itemKey: ch1.key,
            kind: 'live',
            title: ch1.name,
            logo: ch1.logo,
            year: null,
            rating: null,
            addedAt: NOW_MS,
          },
          {
            profileId: 'default',
            sourceId: 'src-2',
            itemKey: ch2.key,
            kind: 'live',
            title: ch2.name,
            logo: ch2.logo,
            year: null,
            rating: null,
            addedAt: NOW_MS - 1_000,
          },
        ],
      ),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const events: string[] = [];
    const { videoHost, open, engines } = createTrackingVideoHost(events);
    const guard = createPlaybackGuard();
    const tallDesktop: ViewportOverride = {
      formFactor: 'desktop',
      orientation: 'portrait',
      inputModality: 'pointer',
      width: 720,
      height: 960,
    };

    const buildTree = (activeSources: readonly SourceRow[]) => (
      <RouteActiveProvider active>
        <ViewportProvider value={tallDesktop}>
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <LiveScreen
                catalog={multiCatalog}
                sources={activeSources}
                refreshToken={0}
                memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
                videoHost={videoHost}
                playbackGuard={guard}
                onPlay={jest.fn()}
                onOpenSources={jest.fn()}
                nowMs={NOW_MS}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RouteActiveProvider>
    );

    const view = await render(buildTree([src1, src2]));
    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('101 · Channel 101');
    });
    // Tall desktop window keeps drawer docked in row layout (never portrait bottom sheet)
    const drawerStyle = StyleSheet.flatten(screen.getByTestId('live-zap-drawer').props.style);
    expect(drawerStyle.position).not.toBe('absolute');
    expect(drawerStyle.height).toBeUndefined();

    // Guard stops src-1, then src-2 survives -> preview cleanly re-opens for src-2!
    await act(async () => {
      await guard.stopIfUsingSource('src-1');
    });
    expect(engines[0]?.openMedias()).toBe(0);

    await view.rerender(buildTree([src2]));
    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('102 · Channel 102');
      expect(engines[1]?.commands.some((c) => c.name === 'load')).toBe(true);
    });

    await view.unmount();
  });

  it('rolls back optimistic favorite toggle when catalog.toggleFavorite returns err or rejects', async () => {
    const { catalog } = createStatefulFavoriteCatalog([]);
    const toggleMock = catalog.toggleFavorite as jest.Mock;
    toggleMock
      .mockResolvedValueOnce(err(elvError('storage', 'write-failed')))
      .mockRejectedValueOnce(new Error('db busy'));

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('live-channel-fav-0')).toBeTruthy());

    // err(...) rolls back favorite state cleanly
    await fireEvent.press(screen.getByTestId('live-channel-fav-0'));
    await waitFor(() => {
      expect(screen.getByTestId('live-channel-fav-0').props.accessibilityState.selected).toBe(
        false,
      );
    });

    // Rejected promise also rolls back favorite state cleanly
    await fireEvent.press(screen.getByTestId('live-channel-fav-0'));
    await waitFor(() => {
      expect(screen.getByTestId('live-channel-fav-0').props.accessibilityState.selected).toBe(
        false,
      );
    });

    await view.unmount();
  });
});
