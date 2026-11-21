import type {
  CatalogService,
  ItemRow,
  SearchOptions,
  SearchResults,
  WatchProgressRow,
} from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  buildTheme,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { DetailTarget } from '../../shared';
import { SearchScreen, type SearchScreenProps } from '../SearchScreen';
import { MAX_SEARCH_QUERY_CHARS, SEARCH_DEBOUNCE_MS, SEARCH_RESULT_LIMIT } from '../search-model';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function makeItem(kind: ItemRow['kind'], index: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: index + 1,
    key: `${kind}:src-1:${index + 1}`,
    kind,
    sourceId: 'src-1',
    providerId: String(index + 1),
    name:
      kind === 'live'
        ? `Channel ${index + 1}`
        : kind === 'movie'
          ? `Movie ${index + 1}`
          : `Series ${index + 1}`,
    logo: `https://art.example.test/${kind}-${index + 1}.jpg`,
    rating: kind === 'live' ? null : 8.5,
    year: kind === 'live' ? null : 2025,
    num: kind === 'live' ? index + 1 : null,
    ...overrides,
  };
}

function makeProgress(
  itemKey: string,
  overrides: Partial<WatchProgressRow> = {},
): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey,
    kind: 'movie',
    title: 'Sample',
    subtitle: null,
    logo: null,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 1_200_000,
    durationMs: 3_600_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
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

function createMockSearchCatalog(opts: {
  searchImpl: (query: string, options?: SearchOptions) => Promise<SearchResults>;
  progressRows?: readonly WatchProgressRow[];
}) {
  const search = jest.fn(opts.searchImpl);
  const listProgressByKeys = jest.fn(async (keys: readonly string[]) => {
    const allowed = new Set(keys);
    return (opts.progressRows ?? []).filter((r) => allowed.has(r.itemKey));
  });
  const catalog = {
    search,
    listProgressByKeys,
  } as unknown as CatalogService;
  return { catalog, search, listProgressByKeys };
}

function renderSearch(
  props: Partial<SearchScreenProps> & { catalog: CatalogService },
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    androidSource?: AndroidKeySource;
  } = {},
) {
  const content = (
    <ViewportProvider
      value={
        opts.viewport ?? {
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }
      }
    >
      <ThemeProvider preset={opts.preset ?? 'obsidianCrimson'}>
        <I18nProvider i18n={createAppI18n('en')}>
          <SearchScreen
            catalog={props.catalog}
            refreshToken={props.refreshToken ?? 1}
            onPlay={props.onPlay ?? jest.fn()}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
            {...(props.userStateVersion !== undefined
              ? { userStateVersion: props.userStateVersion }
              : {})}
            {...(props.initialQuery !== undefined ? { initialQuery: props.initialQuery } : {})}
            {...(props.onQueryChange !== undefined ? { onQueryChange: props.onQueryChange } : {})}
            {...(props.initialScope !== undefined ? { initialScope: props.initialScope } : {})}
            {...(props.onScopeChange !== undefined ? { onScopeChange: props.onScopeChange } : {})}
            {...(props.recentSearches !== undefined
              ? { recentSearches: props.recentSearches }
              : {})}
            {...(props.onRecentSearchesChange !== undefined
              ? { onRecentSearchesChange: props.onRecentSearchesChange }
              : {})}
            {...(props.onFocusTopNav !== undefined ? { onFocusTopNav: props.onFocusTopNav } : {})}
            {...(props.isActiveScope !== undefined ? { isActiveScope: props.isActiveScope } : {})}
          />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  if (opts.androidSource) {
    return render(<RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>);
  }
  return render(content);
}

describe('SearchScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('debounces search by 150ms, forwards Turkish queries, renders skeleton then grouped results with progress and Watched badge', async () => {
    const liveItem = makeItem('live', 0, { name: 'TRT Spor', num: 7 });
    const movieItem = makeItem('movie', 0, { name: 'İstanbul Geceleri' });
    const seriesItem = makeItem('series', 0, { name: 'Şampiyonlar Dizisi' });

    const { catalog, search } = createMockSearchCatalog({
      searchImpl: async () => ({
        live: [liveItem],
        movies: [movieItem],
        series: [seriesItem],
      }),
      progressRows: [
        makeProgress(movieItem.key, {
          positionMs: 1_800_000,
          durationMs: 3_600_000,
          watched: false,
        }),
        makeProgress(seriesItem.key, {
          kind: 'series',
          positionMs: 3_600_000,
          durationMs: 3_600_000,
          watched: true,
        }),
      ],
    });

    const view = await renderSearch({ catalog });
    expect(screen.getByTestId('search-screen')).toBeTruthy();
    expect(screen.getByTestId('search-prompt')).toBeTruthy();
    expect(screen.getByTestId('search-scope-bar')).toBeTruthy();
    const scrollContentStyle = StyleSheet.flatten(
      screen.getByTestId('search-scroll').props.contentContainerStyle,
    );
    expect(scrollContentStyle.paddingTop).toBe(
      buildTheme({ preset: 'obsidianCrimson' }).spacing.sm,
    );

    await fireEvent.changeText(screen.getByTestId('search-input'), 'İstanbul Şampiyonlar');
    expect(screen.getByTestId('search-skeleton')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 10);
    });
    expect(search).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(10);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-live-item-0')).toBeTruthy();
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
      expect(screen.getByTestId('search-series-item-0')).toBeTruthy();
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('İstanbul Şampiyonlar', {
      scope: 'all',
      limit: SEARCH_RESULT_LIMIT,
    });

    expect(screen.getByTestId('search-movie-item-0-progress')).toBeTruthy();
    expect(screen.getByTestId('search-series-item-0-badge')).toBeTruthy();
    const liveCardStyle = StyleSheet.flatten(screen.getByTestId('search-live-item-0').props.style);
    expect(liveCardStyle.width).toBeLessThanOrEqual(296);

    await view.unmount();
  });

  it('cancels stale slow search promises so older responses never overwrite newer results', async () => {
    let resolveFirst!: (res: SearchResults) => void;
    let resolveSecond!: (res: SearchResults) => void;

    const firstMovie = makeItem('movie', 0, { name: 'Alpha Old Result' });
    const secondMovie = makeItem('movie', 1, { name: 'Beta Fresh Result' });

    const { catalog, search } = createMockSearchCatalog({
      searchImpl: (q) =>
        new Promise<SearchResults>((resolve) => {
          if (q === 'alpha') resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    });

    const view = await renderSearch({ catalog });

    await fireEvent.changeText(screen.getByTestId('search-input'), 'alpha');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(search).toHaveBeenCalledTimes(1);

    await fireEvent.changeText(screen.getByTestId('search-input'), 'beta');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(search).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond({ live: [], movies: [secondMovie], series: [] });
    });

    await waitFor(() => {
      expect(screen.getByText('Beta Fresh Result')).toBeTruthy();
    });

    // Now the stale first promise resolves late — MUST NOT overwrite Beta!
    await act(async () => {
      resolveFirst({ live: [], movies: [firstMovie], series: [] });
    });

    expect(screen.getByText('Beta Fresh Result')).toBeTruthy();
    expect(screen.queryByText('Alpha Old Result')).toBeNull();

    await view.unmount();
  });

  it('switches scope chips instantaneously with live counts and zero extra catalog.search queries', async () => {
    const live1 = makeItem('live', 0, { name: 'Spor 1', num: 1 });
    const live2 = makeItem('live', 1, { name: 'Spor 2', num: 2 });
    const movie1 = makeItem('movie', 0, { name: 'Cinema One' });
    const series1 = makeItem('series', 0, { name: 'Drama One' });

    const { catalog, search } = createMockSearchCatalog({
      searchImpl: async () => ({
        live: [live1, live2],
        movies: [movie1],
        series: [series1],
      }),
    });

    const onPlay = jest.fn<void, [PlayTarget]>();
    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderSearch({ catalog, onPlay, onOpenDetail });

    await fireEvent.changeText(screen.getByTestId('search-input'), 'one');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-section-live')).toBeTruthy();
      expect(screen.getByTestId('search-section-movies')).toBeTruthy();
      expect(screen.getByTestId('search-section-series')).toBeTruthy();
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('search-scope-live')).toHaveTextContent('Live (2)');
    expect(screen.getByTestId('search-scope-movie')).toHaveTextContent('Movies (1)');
    expect(screen.getByTestId('search-scope-series')).toHaveTextContent('Series (1)');

    // Switch to Live scope — instant, zero extra search calls
    await fireEvent.press(screen.getByTestId('search-scope-live'));
    expect(screen.getByTestId('search-section-live')).toBeTruthy();
    expect(screen.queryByTestId('search-section-movies')).toBeNull();
    expect(screen.queryByTestId('search-section-series')).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);

    // Click Live card -> onPlay with live PlayTarget
    await fireEvent.press(screen.getByTestId('search-live-item-0'));
    expect(onPlay).toHaveBeenCalledWith({
      itemKey: live1.key,
      sourceId: live1.sourceId,
      title: '1. Spor 1',
      kind: 'live',
      logo: live1.logo,
      itemKind: 'live',
    });

    // Switch to Movies scope -> click Movie card -> onOpenDetail
    await fireEvent.press(screen.getByTestId('search-scope-movie'));
    expect(screen.queryByTestId('search-section-live')).toBeNull();
    expect(screen.getByTestId('search-section-movies')).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('search-movie-item-0'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: movie1.key,
        sourceId: movie1.sourceId,
        kind: 'movie',
        title: movie1.name,
        catalogId: movie1.id,
      }),
    );

    // Switch to Series scope -> click Series card -> onOpenDetail
    await fireEvent.press(screen.getByTestId('search-scope-series'));
    expect(screen.queryByTestId('search-section-movies')).toBeNull();
    expect(screen.getByTestId('search-section-series')).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('search-series-item-0'));
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: series1.key,
        kind: 'series',
        title: series1.name,
      }),
    );

    await view.unmount();
  });

  it('populates recent searches, re-triggers search on chip click, and clears history', async () => {
    const movie = makeItem('movie', 0, { name: 'Matrix' });
    const { catalog, search } = createMockSearchCatalog({
      searchImpl: async () => ({ live: [], movies: [movie], series: [] }),
    });
    const onRecentChange = jest.fn<void, [readonly string[]]>();

    const view = await renderSearch({ catalog, onRecentSearchesChange: onRecentChange });

    await fireEvent.changeText(screen.getByTestId('search-input'), 'Matrix');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    });
    expect(onRecentChange).toHaveBeenCalledWith(['Matrix']);

    // Clear search immediately shows recent chip with minimal radius (no pill capsule)
    await fireEvent.press(screen.getByTestId('search-clear'));
    expect(screen.getByTestId('search-recent-0')).toHaveTextContent('Matrix');
    const recentStyle = StyleSheet.flatten(screen.getByTestId('search-recent-0').props.style);
    expect(recentStyle.borderRadius).toBe(4);

    // Click recent chip re-triggers search
    await fireEvent.press(screen.getByTestId('search-recent-0'));
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(search).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    });

    // Clear search and clear history
    await fireEvent.press(screen.getByTestId('search-clear'));
    await fireEvent.press(screen.getByTestId('search-clear-recent'));
    expect(screen.queryByTestId('search-recent-0')).toBeNull();
    expect(onRecentChange).toHaveBeenLastCalledWith([]);

    await view.unmount();
  });

  it('renders constructive empty state and resets query via search-empty-clear', async () => {
    const { catalog } = createMockSearchCatalog({
      searchImpl: async () => ({ live: [], movies: [], series: [] }),
    });

    const view = await renderSearch({ catalog });

    await fireEvent.changeText(screen.getByTestId('search-input'), 'zzz');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-empty')).toBeTruthy();
    });
    expect(screen.getByText('No matches for "zzz"')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('search-empty-clear'));
    expect(screen.queryByTestId('search-empty')).toBeNull();
    expect(screen.getByTestId('search-prompt')).toBeTruthy();

    await view.unmount();
  });

  it('enforces >= 40x40 touch targets on portrait phone and applies High Contrast (AAA) theme tokens', async () => {
    const { catalog } = createMockSearchCatalog({
      searchImpl: async () => ({ live: [], movies: [], series: [] }),
    });
    const aaaTheme = buildTheme({ preset: 'highContrast' });

    const view = await renderSearch(
      { catalog },
      {
        preset: 'highContrast',
        viewport: {
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 390,
          height: 844,
        },
      },
    );

    const rootStyle = StyleSheet.flatten(screen.getByTestId('search-screen').props.style);
    expect(rootStyle.backgroundColor).toBe(aaaTheme.colors.bgCanvas);

    await fireEvent.changeText(screen.getByTestId('search-input'), 'none');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('search-empty-clear')).toBeTruthy();
    });

    const clearStyle = StyleSheet.flatten(screen.getByTestId('search-clear').props.style);
    expect(clearStyle.minWidth).toBeGreaterThanOrEqual(40);
    expect(clearStyle.minHeight).toBeGreaterThanOrEqual(40);

    const chipStyle = StyleSheet.flatten(screen.getByTestId('search-scope-all').props.style);
    expect(chipStyle.minHeight).toBeGreaterThanOrEqual(40);

    const emptyCtaStyle = StyleSheet.flatten(screen.getByTestId('search-empty-clear').props.style);
    expect(emptyCtaStyle.minHeight).toBeGreaterThanOrEqual(40);

    await view.unmount();
  });

  it('supports 10-ft TV D-pad navigation across input, scopes, and results with focusable={false} and Back clearing query before top nav', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      const liveItem = makeItem('live', 0, { name: 'TRT 1', num: 1 });
      const movieItem = makeItem('movie', 0, { name: 'Dune' });
      const { catalog } = createMockSearchCatalog({
        searchImpl: async () => ({
          live: [liveItem],
          movies: [movieItem],
          series: [],
        }),
      });
      const onPlay = jest.fn<void, [PlayTarget]>();
      const onOpenDetail = jest.fn<void, [DetailTarget]>();
      const onFocusTopNav = jest.fn();
      const { source, sendKey } = createAndroidSource();

      const view = await renderSearch(
        {
          catalog,
          onPlay,
          onOpenDetail,
          onFocusTopNav,
          recentSearches: ['Dune'],
          isActiveScope: true,
        },
        {
          androidSource: source,
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          },
        },
      );

      expect(
        screen.getByTestId('search-tv-focus-anchor', { includeHiddenElements: true }),
      ).toBeTruthy();
      expect(screen.getByTestId('search-scope-all').props.focusable).toBe(false);
      expect(screen.getByTestId('search-recent-0').props.focusable).toBe(false);

      // Up from input row hands focus to top navigation
      await sendKey(KEYCODE_DPAD_UP);
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);

      // Down to scopes -> Down to recent chip 0 -> Select triggers recent search 'Dune'
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_CENTER);

      await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      await waitFor(() => {
        expect(screen.getByTestId('search-live-item-0')).toBeTruthy();
        expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
      });

      expect(screen.getByTestId('search-clear').props.focusable).toBe(false);
      expect(screen.getByTestId('search-live-item-0').props.focusable).toBe(false);
      expect(screen.getByTestId('search-movie-item-0').props.focusable).toBe(false);
      expect(StyleSheet.flatten(screen.getByTestId('search-live-item-0').props.style).width).toBe(
        274,
      );

      // Focus fell back to input (or top valid row); traverse Down to scopes -> Right to Live -> Select
      await sendKey(KEYCODE_DPAD_DOWN); // scopes col 0 (All)
      await sendKey(KEYCODE_DPAD_RIGHT); // scopes col 1 (Live)
      await sendKey(KEYCODE_DPAD_CENTER); // select Live scope
      expect(screen.queryByTestId('search-section-movies')).toBeNull();

      // Down to Live item 0 -> Select plays channel
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_CENTER);
      expect(onPlay).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: liveItem.key, kind: 'live', title: '1. TRT 1' }),
      );

      // Up to scopes -> Left back to All -> Select -> Down to live -> Down to movies -> Select opens detail
      await sendKey(KEYCODE_DPAD_UP);
      await sendKey(KEYCODE_DPAD_LEFT);
      await sendKey(KEYCODE_DPAD_CENTER);
      await sendKey(KEYCODE_DPAD_DOWN); // live
      await sendKey(KEYCODE_DPAD_DOWN); // movies
      await sendKey(KEYCODE_DPAD_CENTER);
      expect(onOpenDetail).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: movieItem.key, kind: 'movie', title: 'Dune' }),
      );

      // First Back clears non-empty query without leaving SearchScreen
      await sendKey(KEYCODE_BACK);
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('search-prompt')).toBeTruthy();

      // Second Back when query is empty returns to top nav
      await sendKey(KEYCODE_BACK);
      expect(onFocusTopNav).toHaveBeenCalledTimes(2);

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    }
  });

  it('sanitizes control characters and enforces 256-char limit before querying catalog.search, and preserves initialQuery/initialScope', async () => {
    const movie = makeItem('movie', 0, { name: 'Foo Bar' });
    const { catalog, search } = createMockSearchCatalog({
      searchImpl: async () => ({ live: [], movies: [movie], series: [] }),
    });
    const onQueryChange = jest.fn();
    const onScopeChange = jest.fn();

    const view = await renderSearch({
      catalog,
      initialQuery: 'foo\t\nbar',
      initialScope: 'movie',
      onQueryChange,
      onScopeChange,
    });

    const input = screen.getByTestId('search-input');
    expect(input.props.maxLength).toBe(MAX_SEARCH_QUERY_CHARS);

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    });
    expect(search).toHaveBeenCalledWith('foo  bar', {
      scope: 'all',
      limit: SEARCH_RESULT_LIMIT,
    });
    expect(screen.getByTestId('search-scope-movie').props.accessibilityState.selected).toBe(true);

    await fireEvent.press(screen.getByTestId('search-scope-all'));
    expect(onScopeChange).toHaveBeenCalledWith('all');

    await fireEvent.changeText(input, 'cinema');
    expect(onQueryChange).toHaveBeenCalledWith('cinema');

    await view.unmount();
  });

  it('scrolls across multi-row wrapped TV result grids with focusable={false} ScrollView, reaches Clear on whitespace input, and exits edit mode on scope loss', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const scrollToSpy = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    try {
      const movies = Array.from({ length: 12 }, (_, i) => makeItem('movie', i));
      const { catalog } = createMockSearchCatalog({
        searchImpl: async () => ({ live: [], movies, series: [] }),
      });
      const { source, sendKey } = createAndroidSource();
      const tvViewport: ViewportOverride = {
        formFactor: 'tv',
        orientation: 'landscape',
        inputModality: 'tv',
        width: 1920,
        height: 1080,
      };

      const view = await renderSearch(
        {
          catalog,
          initialQuery: 'movie',
          isActiveScope: true,
        },
        { androidSource: source, viewport: tvViewport },
      );

      expect(screen.getByTestId('search-scroll').props.focusable).toBe(false);

      await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      await waitFor(() => {
        expect(screen.getByTestId('search-movie-item-11')).toBeTruthy();
      });

      // Measure results container + movies section layout so row stride scrolls cleanly
      await fireEvent(screen.getByTestId('search-results-container'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 220, width: 1728, height: 1200 } },
      });
      await fireEvent(screen.getByTestId('search-section-movies'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 20, width: 1728, height: 1180 } },
      });

      scrollToSpy.mockClear();

      // Down: input -> scopes -> movies visualRow 0 -> movies visualRow 1 -> movies visualRow 2
      await sendKey(KEYCODE_DPAD_DOWN); // scopes
      await sendKey(KEYCODE_DPAD_DOWN); // movies row 0 (idx 0)
      await sendKey(KEYCODE_DPAD_DOWN); // movies row 1 (idx 5)
      await sendKey(KEYCODE_DPAD_DOWN); // movies row 2 (idx 10)

      const ys = scrollToSpy.mock.calls.map((c) => {
        const arg = c[0] as { y?: number } | undefined;
        return arg?.y ?? -1;
      });
      // Expect strictly increasing scroll y offsets for row 0 < row 1 < row 2
      expect(ys.length).toBeGreaterThanOrEqual(3);
      const lastThree = ys.slice(-3);
      expect(lastThree[1]).toBeGreaterThan(lastThree[0] ?? -1);
      expect(lastThree[2]).toBeGreaterThan(lastThree[1] ?? -1);

      // Entering input edit mode then losing scope resets editable to false
      await sendKey(KEYCODE_DPAD_UP); // movies row 1
      await sendKey(KEYCODE_DPAD_UP); // movies row 0
      await sendKey(KEYCODE_DPAD_UP); // scopes
      await sendKey(KEYCODE_DPAD_UP); // input col 0
      await sendKey(KEYCODE_DPAD_CENTER); // start edit mode
      expect(screen.getByTestId('search-input').props.editable).toBe(true);

      await view.rerender(
        <RemoteKeysProvider android={source}>
          <ViewportProvider value={tvViewport}>
            <ThemeProvider preset="obsidianCrimson">
              <I18nProvider i18n={createAppI18n('en')}>
                <SearchScreen
                  catalog={catalog}
                  refreshToken={1}
                  initialQuery="   "
                  onPlay={jest.fn()}
                  onOpenDetail={jest.fn()}
                  isActiveScope={false}
                />
              </I18nProvider>
            </ThemeProvider>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );
      expect(screen.getByTestId('search-input').props.editable).toBe(false);

      // Re-activate scope with whitespace-only query -> Right + Select activates search-clear
      await view.rerender(
        <RemoteKeysProvider android={source}>
          <ViewportProvider value={tvViewport}>
            <ThemeProvider preset="obsidianCrimson">
              <I18nProvider i18n={createAppI18n('en')}>
                <SearchScreen
                  catalog={catalog}
                  refreshToken={1}
                  initialQuery="   "
                  onPlay={jest.fn()}
                  onOpenDetail={jest.fn()}
                  isActiveScope={true}
                />
              </I18nProvider>
            </ThemeProvider>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );
      expect(screen.getByTestId('search-clear')).toBeTruthy();
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_CENTER);
      expect(screen.queryByTestId('search-clear')).toBeNull();

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    }
  });

  it('ignores IME-composing Enter events (isComposing / keyCode 229) and submits normal Enter cleanly', async () => {
    const { catalog } = createMockSearchCatalog({
      searchImpl: async () => ({ live: [], movies: [], series: [] }),
    });
    const onRecentChange = jest.fn<void, [readonly string[]]>();
    const view = await renderSearch({
      catalog,
      initialQuery: '東京',
      onRecentSearchesChange: onRecentChange,
    });
    const input = screen.getByTestId('search-input');

    // Composing submitEditing shapes must all be ignored
    await fireEvent(input, 'submitEditing', { nativeEvent: { isComposing: true, key: 'Enter' } });
    await fireEvent(input, 'submitEditing', { isComposing: true, key: 'Enter' });
    await fireEvent(input, 'submitEditing', { nativeEvent: { keyCode: 229, key: 'Enter' } });
    await fireEvent(input, 'keyPress', { nativeEvent: { key: 'Enter', isComposing: true } });
    await fireEvent(input, 'submitEditing', { nativeEvent: { text: '東京' } });
    expect(onRecentChange).not.toHaveBeenCalled();

    // Non-composing Enter submits cleanly and commits recent search
    await fireEvent(input, 'keyPress', { nativeEvent: { key: 'Enter', isComposing: false } });
    await fireEvent(input, 'submitEditing', { nativeEvent: { isComposing: false, text: '東京' } });
    expect(onRecentChange).toHaveBeenCalledTimes(1);
    expect(onRecentChange).toHaveBeenCalledWith(['東京']);

    await view.unmount();
  });
});
