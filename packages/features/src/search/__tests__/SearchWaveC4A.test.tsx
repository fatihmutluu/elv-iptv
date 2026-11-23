import type {
  CatalogService,
  SearchEpisodeHit,
  SearchItemHit,
  SearchProgrammeHit,
  SearchResults,
  SearchSuggestion,
} from '@elv/data';
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
import type { DetailTarget } from '../../shared';
import { SearchScreen, type SearchScreenProps } from '../SearchScreen';
import { SEARCH_DEBOUNCE_MS } from '../search-model';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

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

function makeItemHit(
  kind: 'live' | 'movie' | 'series',
  index: number,
  overrides: Partial<SearchItemHit> = {},
): SearchItemHit {
  return {
    id: index + 1,
    key: `${kind}:src-1:${index + 1}`,
    kind,
    sourceId: 'src-1',
    providerId: String(index + 1),
    name: `${kind} ${index + 1}`,
    logo: `https://art.example.test/${kind}-${index + 1}.jpg`,
    rating: kind === 'live' ? null : 8.4,
    year: kind === 'live' ? null : 2025,
    num: kind === 'live' ? index + 1 : null,
    ...overrides,
  };
}

function makeProgrammeHit(
  index: number,
  overrides: Partial<SearchProgrammeHit> = {},
): SearchProgrammeHit {
  return {
    sourceId: 'src-1',
    guideId: `g-${index + 1}`,
    channelKey: `live:src-1:${index + 1}`,
    channelName: `TRT ${index + 1}`,
    channelLogoUrl: `https://art.example.test/ch-${index + 1}.png`,
    title: `Night Match ${index + 1}`,
    description: `Live match coverage ${index + 1}.`,
    start: 1_700_000_000_000,
    stop: 1_700_003_600_000,
    category: 'Sports',
    isLiveNow: true,
    ...overrides,
  };
}

function makeEpisodeHit(
  index: number,
  overrides: Partial<SearchEpisodeHit> = {},
): SearchEpisodeHit {
  return {
    sourceId: 'src-1',
    itemKey: `episode:src-1:${index + 1}`,
    seriesKey: 'series:src-1:1',
    seriesName: 'Bozkır',
    season: 2,
    episode: index + 1,
    title: `Gece Yarısı ${index + 1}`,
    posterUrl: 'https://art.example.test/series-1.jpg',
    ...overrides,
  };
}

function renderWaveC4ASearch(
  props: Partial<SearchScreenProps> & { catalog: CatalogService },
  opts: {
    viewport?: ViewportOverride;
    androidSource?: AndroidKeySource;
  } = {},
) {
  const tree = (
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
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <SearchScreen
            catalog={props.catalog}
            refreshToken={props.refreshToken ?? 1}
            onPlay={props.onPlay ?? jest.fn()}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
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
    return render(<RemoteKeysProvider android={opts.androidSource}>{tree}</RemoteKeysProvider>);
  }
  return render(tree);
}

describe('SearchScreen Wave C4A (#397)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('loads idle search suggestions alongside recent searches and populates query when a suggestion is selected', async () => {
    const suggestions: readonly SearchSuggestion[] = [
      {
        kind: 'favorite',
        label: 'TRT Spor',
        query: 'TRT Spor',
        itemKind: 'live',
        sourceId: 'src-1',
        itemKey: 'live:src-1:1',
      },
      {
        kind: 'recent',
        label: 'Ahlat Ağacı',
        query: 'Ahlat Ağacı',
        itemKind: 'movie',
        sourceId: 'src-1',
        itemKey: 'movie:src-1:1',
      },
      {
        kind: 'category',
        label: 'Belgesel',
        query: 'Belgesel',
        itemKind: 'movie',
        sourceId: 'src-1',
        categoryId: 'src-1|movie|doc',
      },
    ];

    const search = jest.fn(
      async (): Promise<SearchResults> => ({
        live: [],
        epg: [],
        movies: [makeItemHit('movie', 0, { name: 'Ahlat Ağacı' })],
        series: [],
        episodes: [],
      }),
    );
    const searchSuggestions = jest.fn(async () => suggestions);
    const catalog = {
      search,
      searchSuggestions,
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;

    const view = await renderWaveC4ASearch({
      catalog,
      recentSearches: ['İstanbul'],
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-suggestions-section')).toBeTruthy();
      expect(screen.getByTestId('search-suggestion-0')).toBeTruthy();
      expect(screen.getByTestId('search-suggestion-1')).toBeTruthy();
      expect(screen.getByTestId('search-suggestion-2')).toBeTruthy();
    });

    expect(searchSuggestions).toHaveBeenCalledWith({ limit: 8 });
    expect(screen.getByTestId('search-suggestion-0-label')).toHaveTextContent('TRT Spor');
    expect(screen.getByTestId('search-suggestion-0-kind')).toHaveTextContent('Favorites');
    expect(screen.getByTestId('search-suggestion-1-kind')).toHaveTextContent('Recently watched');
    expect(screen.getByTestId('search-suggestion-2-kind')).toHaveTextContent('Category');

    // Selecting a suggestion populates the search query and triggers search
    await fireEvent.press(screen.getByTestId('search-suggestion-1'));
    expect(screen.getByTestId('search-input').props.value).toBe('Ahlat Ağacı');

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    await waitFor(() => {
      expect(search).toHaveBeenCalledWith('Ahlat Ağacı', expect.anything());
      expect(screen.getByTestId('search-movie-item-0')).toBeTruthy();
    });

    await view.unmount();
  });

  it('renders EPG, Episode, and Cast-matched VOD results, filters by new scopes, tunes airing EPG, opens modal for upcoming EPG, and plays episodes', async () => {
    const nowMs = Date.now();
    const liveHit = makeItemHit('live', 0, { name: 'TRT 1', num: 1 });
    const airingEpg = makeProgrammeHit(0, {
      channelKey: 'live:src-1:1',
      channelName: 'TRT 1',
      title: 'Champions League Live',
      start: nowMs - 1_800_000,
      stop: nowMs + 1_800_000,
      isLiveNow: true,
    });
    const upcomingEpg = makeProgrammeHit(1, {
      channelKey: 'live:src-1:2',
      channelName: 'TRT Spor',
      title: 'Post-Match Analysis',
      description: 'Full tactical breakdown.',
      start: nowMs + 3_600_000,
      stop: nowMs + 7_200_000,
      isLiveNow: false,
    });
    const pastEpg = makeProgrammeHit(2, {
      channelKey: 'live:src-1:3',
      channelName: 'TRT Belgesel',
      title: 'Archive Documentary',
      description: 'Earlier broadcast.',
      start: nowMs - 7_200_000,
      stop: nowMs - 3_600_000,
      isLiveNow: false,
    });
    const castMovie = makeItemHit('movie', 0, {
      name: 'Kış Uykusu',
      matchedBy: 'cast',
    });
    const directorSeries = makeItemHit('series', 0, {
      name: 'Şahsiyet',
      matchedBy: 'director',
    });
    const episodeHit = makeEpisodeHit(0, {
      itemKey: 'episode:src-1:204',
      seriesKey: 'series:src-1:1',
      seriesName: 'Şahsiyet',
      season: 1,
      episode: 4,
      title: 'Bellek',
    });

    const catalog = {
      search: jest.fn(
        async (): Promise<SearchResults> => ({
          live: [liveHit],
          epg: [airingEpg, upcomingEpg, pastEpg],
          movies: [castMovie],
          series: [directorSeries],
          episodes: [episodeHit],
        }),
      ),
      searchSuggestions: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
    } as unknown as CatalogService;

    const onPlay = jest.fn<void, [PlayTarget]>();
    const onOpenDetail = jest.fn<void, [DetailTarget]>();

    const view = await renderWaveC4ASearch({ catalog, onPlay, onOpenDetail });

    // All 6 scope tabs render
    expect(screen.getByTestId('search-scope-all')).toBeTruthy();
    expect(screen.getByTestId('search-scope-live')).toBeTruthy();
    expect(screen.getByTestId('search-scope-epg')).toHaveTextContent('On Now & Guide');
    expect(screen.getByTestId('search-scope-movie')).toBeTruthy();
    expect(screen.getByTestId('search-scope-series')).toBeTruthy();
    expect(screen.getByTestId('search-scope-episode')).toHaveTextContent('Episodes');

    await fireEvent.changeText(screen.getByTestId('search-input'), 'Haluk');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-section-live')).toBeTruthy();
      expect(screen.getByTestId('search-section-epg')).toBeTruthy();
      expect(screen.getByTestId('search-section-movies')).toBeTruthy();
      expect(screen.getByTestId('search-section-series')).toBeTruthy();
      expect(screen.getByTestId('search-section-episodes')).toBeTruthy();
    });

    // Cast & director match badges on Movie and Series cards without duplicating in meta underneath
    expect(screen.getByTestId('search-movie-item-0-badge')).toHaveTextContent('Cast & crew');
    expect(screen.getByTestId('search-series-item-0-badge')).toHaveTextContent('Cast & crew');
    expect(screen.getByTestId('search-movie-item-0')).not.toHaveTextContent('· Cast & crew');

    // EPG badges: On now vs Upcoming vs omitted for ended past programmes
    expect(screen.getByTestId('search-epg-item-0-badge')).toHaveTextContent('On now');
    expect(screen.getByTestId('search-epg-item-1-badge')).toHaveTextContent('Upcoming');
    expect(screen.queryByTestId('search-epg-item-2-badge')).toBeNull();

    // Ended past EPG detail overlay also omits the Upcoming badge
    await fireEvent.press(screen.getByTestId('search-epg-item-2'));
    expect(screen.getByTestId('search-epg-detail-modal')).toBeTruthy();
    expect(screen.queryByTestId('search-epg-detail-badge')).toBeNull();
    await fireEvent.press(screen.getByTestId('search-epg-detail-close'));
    expect(screen.queryByTestId('search-epg-detail-modal')).toBeNull();

    // Pressing airing EPG hit tunes channel immediately
    await fireEvent.press(screen.getByTestId('search-epg-item-0'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'live:src-1:1',
        kind: 'live',
        title: 'TRT 1',
        subtitle: 'Champions League Live',
      }),
    );

    // Pressing upcoming EPG hit opens programme detail overlay -> Tune to channel tunes cleanly
    onPlay.mockClear();
    await fireEvent.press(screen.getByTestId('search-epg-item-1'));
    expect(screen.getByTestId('search-epg-detail-modal')).toBeTruthy();
    expect(screen.getByTestId('search-epg-detail-title')).toHaveTextContent('Post-Match Analysis');
    expect(screen.getByTestId('search-epg-detail-description')).toHaveTextContent(
      'Full tactical breakdown.',
    );

    await fireEvent.press(screen.getByTestId('search-epg-detail-tune'));
    expect(screen.queryByTestId('search-epg-detail-modal')).toBeNull();
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'live:src-1:2',
        kind: 'live',
        title: 'TRT Spor',
      }),
    );

    // Episode card displays seriesName, S{season} E{episode}, and episode title, and plays episode on press
    expect(screen.getByTestId('search-episode-item-0-series')).toHaveTextContent('Şahsiyet');
    expect(screen.getByTestId('search-episode-item-0-label')).toHaveTextContent('S1 E4');
    expect(screen.getByTestId('search-episode-item-0-title')).toHaveTextContent('Bellek');

    onPlay.mockClear();
    await fireEvent.press(screen.getByTestId('search-episode-item-0'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'episode:src-1:204',
        seriesKey: 'series:src-1:1',
        kind: 'vod',
        itemKind: 'episode',
        season: 1,
        episode: 4,
      }),
    );

    // Scope filtering to 'epg' and 'episode'
    await fireEvent.press(screen.getByTestId('search-scope-epg'));
    expect(screen.getByTestId('search-section-epg')).toBeTruthy();
    expect(screen.queryByTestId('search-section-live')).toBeNull();
    expect(screen.queryByTestId('search-section-episodes')).toBeNull();

    await fireEvent.press(screen.getByTestId('search-scope-episode'));
    expect(screen.getByTestId('search-section-episodes')).toBeTruthy();
    expect(screen.queryByTestId('search-section-epg')).toBeNull();

    await view.unmount();
  });

  it('navigates idle suggestions, EPG hits, and Episode hits via 10-ft TV D-pad', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      const airingEpg = makeProgrammeHit(0, {
        channelKey: 'live:src-1:1',
        channelName: 'TRT 1',
        title: 'Live News',
        isLiveNow: true,
      });
      const episodeHit = makeEpisodeHit(0, {
        itemKey: 'episode:src-1:101',
        seriesKey: 'series:src-1:1',
        seriesName: 'Bozkır',
        season: 1,
        episode: 1,
        title: 'Pilot',
      });

      const catalog = {
        search: jest.fn(
          async (): Promise<SearchResults> => ({
            live: [],
            epg: [airingEpg],
            movies: [],
            series: [],
            episodes: [episodeHit],
          }),
        ),
        searchSuggestions: jest.fn(
          async (): Promise<readonly SearchSuggestion[]> => [
            {
              kind: 'favorite',
              label: 'Bozkır',
              query: 'Bozkır',
              itemKind: 'series',
              sourceId: 'src-1',
              itemKey: 'series:src-1:1',
            },
          ],
        ),
        listProgressByKeys: jest.fn(async () => []),
      } as unknown as CatalogService;

      const onPlay = jest.fn<void, [PlayTarget]>();
      const { source, sendKey } = createAndroidSource();

      const view = await renderWaveC4ASearch(
        {
          catalog,
          onPlay,
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

      await waitFor(() => {
        expect(screen.getByTestId('search-suggestion-0')).toBeTruthy();
      });
      expect(screen.getByTestId('search-suggestion-0').props.focusable).toBe(false);

      // Down from input -> scopes -> Down to suggestions -> Select activates suggestion 'Bozkır'
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_CENTER);

      await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      await waitFor(() => {
        expect(screen.getByTestId('search-epg-item-0')).toBeTruthy();
        expect(screen.getByTestId('search-episode-item-0')).toBeTruthy();
      });

      // Focus fell back to input; Down -> scopes -> Down -> epg item 0 -> Select tunes airing EPG hit
      await sendKey(KEYCODE_DPAD_DOWN);
      await sendKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('search-epg-item-0-focus-ring')).toBeTruthy();
      await sendKey(KEYCODE_DPAD_CENTER);
      expect(onPlay).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: 'live:src-1:1',
          kind: 'live',
        }),
      );

      // Down from epg item 0 -> episodes item 0 -> Select plays episode hit
      onPlay.mockClear();
      await sendKey(KEYCODE_DPAD_DOWN);
      expect(screen.getByTestId('search-episode-item-0-focus-ring')).toBeTruthy();
      await sendKey(KEYCODE_DPAD_CENTER);
      expect(onPlay).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: 'episode:src-1:101',
          kind: 'vod',
          itemKind: 'episode',
        }),
      );

      // Left / Right / Back work cleanly
      await sendKey(KEYCODE_DPAD_UP);
      await sendKey(KEYCODE_DPAD_LEFT);
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_BACK);
      expect(screen.getByTestId('search-suggestions-section')).toBeTruthy();

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
    }
  });
});
