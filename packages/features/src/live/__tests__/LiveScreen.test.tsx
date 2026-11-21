import type {
  CatalogService,
  CategoryRow,
  FavoriteRow,
  ItemRow,
  NowNextEntry,
  ProgrammeRow,
  SourceRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
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
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { LiveScreen } from '../LiveScreen';
import { EMPTY_LIVE_MEMORY, type LiveTabMemory, NUMBER_JUMP_TIMEOUT_MS } from '../live-model';

const KEYCODE_DPAD_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const NOW_MS = Date.UTC(2026, 10, 21, 18, 15, 0);

function makeSource(id = 'src-1', needsImport = false): SourceRow {
  return { id, kind: 'xtream', name: 'Demo Live', createdAt: 1, needsImport };
}

function makeCategory(index: number, itemCount = 6): CategoryRow {
  return {
    id: `src-1|live|cat-${index}`,
    sourceId: 'src-1',
    kind: 'live',
    name: index === 0 ? 'News' : 'Sports',
    position: index,
    itemCount,
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
    start: NOW_MS - 15 * 60_000,
    stop: NOW_MS + 45 * 60_000,
    title: `Prime News ${num}`,
    subTitle: null,
    description: `Live coverage on channel ${num}.`,
    episodeNum: null,
    icon: null,
  };
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

function createMockCatalog(opts?: {
  readonly categories?: readonly CategoryRow[];
  readonly channels?: readonly ItemRow[];
  readonly pendingCategories?: Promise<CategoryRow[]>;
  readonly favoriteIndices?: readonly number[];
}) {
  const categories = opts?.categories ?? [makeCategory(0, 6), makeCategory(1, 6)];
  const channels = opts?.channels ?? Array.from({ length: 6 }, (_, i) => makeChannel(i));
  const favIndices = opts?.favoriteIndices ?? [0, 1];
  const favRows: FavoriteRow[] = favIndices
    .map((idx) => channels[idx])
    .filter((ch): ch is ItemRow => ch !== undefined)
    .map((ch) => ({
      profileId: 'default',
      sourceId: ch.sourceId,
      itemKey: ch.key,
      kind: 'live',
      title: ch.name,
      logo: ch.logo,
      year: null,
      rating: null,
      addedAt: NOW_MS,
    }));

  const catalog = {
    listSources: jest.fn(async () => [makeSource()]),
    categories: jest.fn(async () =>
      opts?.pendingCategories ? opts.pendingCategories : [...categories],
    ),
    items: jest.fn(async (_catId: string, offset: number, limit: number) =>
      channels.slice(offset, offset + limit),
    ),
    itemDetail: jest.fn(async (itemKey: string) => {
      const hit = channels.find((c) => c.key === itemKey);
      return hit ? { ...hit, plot: null } : null;
    }),
    listFavoriteKeys: jest.fn(async () => favRows.map((f) => f.itemKey)),
    listFavorites: jest.fn(async () => [...favRows]),
    toggleFavorite: jest.fn(async () => ok(true)),
    seasons: jest.fn(async () => []),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(async () => ({
      ok: true as const,
      value: { url: 'http://sim.example.test/live.ts', headers: {} },
    })),
    nowNext: jest.fn(async (keys: readonly string[]) =>
      keys.map<NowNextEntry>((k, idx) => ({
        channelKey: k,
        now: makeProgramme(k, 101 + idx),
        next: null,
      })),
    ),
    epgWindow: jest.fn(async (keys: readonly string[]) => {
      const out: Record<string, ProgrammeRow[]> = {};
      keys.forEach((k, idx) => {
        out[k] = [makeProgramme(k, 101 + idx)];
      });
      return out;
    }),
    channelByNumber: jest.fn(async (num: number) => channels.find((c) => c.num === num) ?? null),
    importGuide: jest.fn(async () => ({
      ok: true as const,
      value: { categories: 0, items: 0, programmes: 6 },
    })),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;

  return { catalog, channels, categories };
}

function renderWithProviders(
  ui: React.ReactElement,
  viewport: ViewportOverride = {
    formFactor: 'desktop',
    orientation: 'landscape',
    inputModality: 'pointer',
    width: 1280,
    height: 800,
  },
  androidSource?: AndroidKeySource,
) {
  return render(
    <RemoteKeysProvider android={androidSource ?? null}>
      <ViewportProvider value={viewport}>
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>{ui}</I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    </RemoteKeysProvider>,
  );
}

describe('LiveScreen', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows tonal skeleton while categories load and constructive empty state when no ready sources exist', async () => {
    let resolveCats: ((rows: CategoryRow[]) => void) | undefined;
    const pending = new Promise<CategoryRow[]>((resolve) => {
      resolveCats = resolve;
    });
    const { catalog } = createMockCatalog({ pendingCategories: pending });
    const onOpenSources = jest.fn();

    const loadingView = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource('src-1', false)]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenSources={onOpenSources}
        nowMs={NOW_MS}
      />,
    );

    expect(screen.getByTestId('live-screen')).toBeTruthy();
    expect(screen.getByTestId('live-skeleton')).toBeTruthy();

    await act(async () => {
      resolveCats?.([]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('live-empty')).toBeTruthy();
    });
    await loadingView.unmount();

    const emptyView = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenSources={onOpenSources}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-empty')).toBeTruthy();
      expect(screen.getByText('No live channels yet')).toBeTruthy();
      expect(screen.getByTestId('live-open-sources')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('live-open-sources'));
    expect(onOpenSources).toHaveBeenCalledTimes(1);
    await emptyView.unmount();
  });

  it('switches Channels <-> TV Guide <-> Watch, supports quick Number Pad in Channels, and launches playback with PlayTarget', async () => {
    const { catalog } = createMockCatalog();
    const played: PlayTarget[] = [];
    const memoryUpdates: LiveTabMemory[] = [];

    const view = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        onMemoryChange={(next) => memoryUpdates.push(next)}
        onPlay={(target) => played.push(target)}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-1')).toBeTruthy();
    });

    // Click channel 1 in Channels grid -> tunes & launches PlayTarget immediately
    await fireEvent.press(screen.getByTestId('live-channel-card-1'));
    expect(played).toHaveLength(1);
    expect(played[0]?.itemKey).toBe('x:src-1:live:102');
    expect(played[0]?.title).toBe('102. Channel 102');
    expect(played[0]?.kind).toBe('live');
    expect(played[0]?.playlist?.currentIndex).toBe(1);

    // Quick Number Pad toggle works in Channels mode
    await fireEvent.press(screen.getByTestId('live-channels-numpad-toggle'));
    expect(screen.getByTestId('live-numpad')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-numpad-key-1'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-0'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-3'));
    await fireEvent.press(screen.getByTestId('live-numpad-key-↵'));
    await waitFor(() => {
      expect(screen.queryByTestId('live-numpad')).toBeNull();
    });
    expect(memoryUpdates[memoryUpdates.length - 1]?.activeChannelKey).toBe('x:src-1:live:103');

    // Switch to TV Guide (EPG) mode
    await fireEvent.press(screen.getByTestId('live-mode-epg'));
    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
      expect(screen.getByTestId('epg-preview-header')).toBeTruthy();
      expect(screen.getByTestId('epg-time-ruler')).toBeTruthy();
      expect(screen.getByTestId('live-category-chips')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('epg-watch-now'));
    expect(played.length).toBeGreaterThanOrEqual(2);
    expect(played[played.length - 1]?.kind).toBe('live');

    // Switch to Favorites mode -> category bar hidden, stage + Mini-Guide Zap Drawer visible
    await fireEvent.press(screen.getByTestId('live-mode-favorites'));
    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-zap-drawer')).toBeTruthy();
    });
    expect(screen.queryByTestId('live-category-chips')).toBeNull();
    expect(screen.queryByTestId('live-prev-channel')).toBeNull();
    expect(screen.queryByTestId('live-toggle-numpad')).toBeNull();

    // Watch live CTA launches fullscreen PlayTarget
    const beforeWatch = played.length;
    await fireEvent.press(screen.getByTestId('live-watch-fullscreen'));
    expect(played).toHaveLength(beforeWatch + 1);
    expect(played[played.length - 1]?.kind).toBe('live');

    // Switch back to Channels
    await fireEvent.press(screen.getByTestId('live-mode-channels'));
    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
    });

    await view.unmount();
  });

  it('orchestrates 10-ft TV D-pad handoff between header, LiveChannelsGrid, EpgGridView, and Top Nav with zero double listeners', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const { source: androidSource, sendKey } = createAndroidSource();
    const { catalog } = createMockCatalog();
    const onPlay = jest.fn();
    const onFocusTopNav = jest.fn();

    const view = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={EMPTY_LIVE_MEMORY}
        onPlay={onPlay}
        onOpenSources={jest.fn()}
        onFocusTopNav={onFocusTopNav}
        isActiveScope
        nowMs={NOW_MS}
      />,
      {
        formFactor: 'tv',
        orientation: 'landscape',
        inputModality: 'tv',
        width: 1920,
        height: 1080,
      },
      androidSource,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // Starts in header zone: LiveScreen owns TV focus anchor, child grid does not
    expect(
      screen.getByTestId('live-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('live-channels-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();
    expect(screen.getByTestId('live-mode-channels').props.focusable).toBe(false);
    expect(screen.getByTestId('live-channels-numpad-toggle').props.focusable).toBe(false);

    // Up from header modes hands focus up to Top Nav
    await sendKey(KEYCODE_DPAD_UP);
    expect(onFocusTopNav).toHaveBeenCalledTimes(1);

    // Down -> category chips -> Down -> hands off to LiveChannelsGrid body
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(
      screen.queryByTestId('live-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();
    expect(
      screen.getByTestId('live-channels-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();

    // Right -> Select tunes and launches channel 1 via LiveChannelsGrid
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay.mock.calls[0]?.[0]?.itemKey).toBe('x:src-1:live:102');

    // Up from row 0 triggers onEdgeTop -> returns smoothly to header categories, then Up -> modes, then Up -> Top Nav
    await sendKey(KEYCODE_DPAD_UP);
    expect(
      screen.getByTestId('live-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('live-channels-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();

    await sendKey(KEYCODE_DPAD_UP); // back to modes row
    await sendKey(KEYCODE_DPAD_UP); // to Top Nav
    expect(onFocusTopNav).toHaveBeenCalledTimes(2);

    // Switch to TV Guide mode via D-pad (modes row starts on active mode index 1 -> Right to index 2 -> Select)
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
    });

    // Down -> categories -> Down -> EpgGridView owns TV keys
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(
      screen.queryByTestId('live-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();
    expect(screen.getByTestId('epg-tv-focus-anchor', { includeHiddenElements: true })).toBeTruthy();

    // Up from EPG row 0 enters EPG toolbar, and Up again returns cleanly to LiveScreen header
    await sendKey(KEYCODE_DPAD_UP);
    await sendKey(KEYCODE_DPAD_UP);
    expect(
      screen.getByTestId('live-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.queryByTestId('epg-tv-focus-anchor', { includeHiddenElements: true })).toBeNull();

    await view.unmount();
  });

  it('supports 10-ft TV D-pad navigation in Watch mode and empty state', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const tvViewport: ViewportOverride = {
      formFactor: 'tv',
      orientation: 'landscape',
      inputModality: 'tv',
      width: 1920,
      height: 1080,
    };

    // Empty state TV controls
    const emptyRemote = createAndroidSource();
    const onOpenSources = jest.fn();
    const onFocusTopNav = jest.fn();
    const { catalog } = createMockCatalog();

    const emptyView = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenSources={onOpenSources}
        onFocusTopNav={onFocusTopNav}
        isActiveScope
        nowMs={NOW_MS}
      />,
      tvViewport,
      emptyRemote.source,
    );
    await waitFor(() => {
      expect(screen.getByTestId('live-open-sources')).toBeTruthy();
    });
    expect(screen.getByTestId('live-open-sources').props.focusable).toBe(false);
    await emptyRemote.sendKey(KEYCODE_DPAD_CENTER);
    expect(onOpenSources).toHaveBeenCalledTimes(1);
    await emptyRemote.sendKey(KEYCODE_DPAD_UP);
    expect(onFocusTopNav).toHaveBeenCalledTimes(1);
    await emptyView.unmount();

    // Favorites mode TV controls + Mini-Guide Zap Drawer
    const watchRemote = createAndroidSource();
    const onPlay = jest.fn();
    const watchView = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'favorites' }}
        onPlay={onPlay}
        onOpenSources={jest.fn()}
        onFocusTopNav={onFocusTopNav}
        isActiveScope
        nowMs={NOW_MS}
      />,
      tvViewport,
      watchRemote.source,
    );
    await waitFor(() => {
      expect(screen.getByTestId('live-watch-stage')).toBeTruthy();
      expect(screen.getByTestId('live-zap-row-0')).toBeTruthy();
    });

    // Down into Favorites controls -> Down into Zap Drawer -> Down -> Select tunes favorite channel 1
    await watchRemote.sendKey(KEYCODE_DPAD_DOWN);
    await watchRemote.sendKey(KEYCODE_DPAD_DOWN);
    await watchRemote.sendKey(KEYCODE_DPAD_DOWN);
    await watchRemote.sendKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('102 · Channel 102');
    });

    // Right returns to Favorites controls -> Right x2 reaches Watch live CTA (miniguide -> favorite -> watch) -> Select calls onPlay
    await watchRemote.sendKey(KEYCODE_DPAD_RIGHT);
    await watchRemote.sendKey(KEYCODE_DPAD_RIGHT);
    await watchRemote.sendKey(KEYCODE_DPAD_RIGHT);
    await watchRemote.sendKey(KEYCODE_DPAD_CENTER);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay.mock.calls[0]?.[0]?.itemKey).toBe('x:src-1:live:102');

    await watchView.unmount();
  });

  it('traps 10-ft TV D-pad inside the 4x3 LiveNumberPad grid and tunes via channelByNumber in Channels mode', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const { source: androidSource, sendKey } = createAndroidSource();
    const { catalog } = createMockCatalog();

    const view = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={EMPTY_LIVE_MEMORY}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        isActiveScope
        nowMs={NOW_MS}
      />,
      {
        formFactor: 'tv',
        orientation: 'landscape',
        inputModality: 'tv',
        width: 1920,
        height: 1080,
      },
      androidSource,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // Header modes starts at index 1 (Channels): Right x2 -> numpad toggle (col 3) -> Select
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('live-numpad')).toBeTruthy();
    expect(
      screen.getByTestId('live-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('live-channels-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();

    // 4x3 keypad starts at (0,0)='1': Select '1', move to (3,1)='0' Select, move to (0,2)='3' Select, move to (3,2)='↵' Select
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('live-numpad-display')).toHaveTextContent('1');

    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('live-numpad-display')).toHaveTextContent('10');

    await sendKey(KEYCODE_DPAD_UP);
    await sendKey(KEYCODE_DPAD_UP);
    await sendKey(KEYCODE_DPAD_UP);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('live-numpad-display')).toHaveTextContent('103');

    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(catalog.channelByNumber).toHaveBeenCalledWith(103, 'src-1');
      expect(screen.queryByTestId('live-numpad')).toBeNull();
      expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
      expect(screen.getByTestId('live-channel-card-2').props.accessibilityState.selected).toBe(
        true,
      );
    });

    // Re-open numpad in Channels mode and close cleanly with Back
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('live-numpad')).toBeTruthy();
    await sendKey(KEYCODE_DPAD_LEFT);
    await sendKey(KEYCODE_DPAD_BACK);
    expect(screen.queryByTestId('live-numpad')).toBeNull();

    await view.unmount();
  });

  it('does not fall through to LiveWatchStage when mode is epg and the active category has zero channels', async () => {
    const { catalog } = createMockCatalog({
      categories: [makeCategory(0, 0)],
      channels: [],
    });

    const view = await renderWithProviders(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={{ ...EMPTY_LIVE_MEMORY, mode: 'epg' }}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-empty')).toBeTruthy();
    });
    expect(screen.queryByTestId('live-watch-stage')).toBeNull();
    expect(screen.queryByTestId('live-epg-view')).toBeNull();

    await view.unmount();
  });

  it('closes LiveNumberPad and selects jumped channel automatically after 1.8s auto-tune in Channels mode', async () => {
    jest.useFakeTimers();
    try {
      const { catalog } = createMockCatalog();
      const view = await renderWithProviders(
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
        expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
        expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('live-channels-numpad-toggle'));
      expect(screen.getByTestId('live-numpad')).toBeTruthy();
      await fireEvent.press(screen.getByTestId('live-numpad-key-1'));
      await fireEvent.press(screen.getByTestId('live-numpad-key-0'));
      await fireEvent.press(screen.getByTestId('live-numpad-key-4'));

      await act(async () => {
        jest.advanceTimersByTime(NUMBER_JUMP_TIMEOUT_MS + 50);
      });

      await waitFor(() => {
        expect(catalog.channelByNumber).toHaveBeenCalledWith(104, 'src-1');
        expect(screen.queryByTestId('live-numpad')).toBeNull();
        expect(screen.getByTestId('live-channels-grid')).toBeTruthy();
        expect(screen.getByTestId('live-channel-card-3').props.accessibilityState.selected).toBe(
          true,
        );
      });

      await view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});
