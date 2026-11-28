import type { CatalogService, ItemRow, SearchOptions, SearchResults } from '@elv/data';
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
import { Platform, ScrollView, StyleSheet, TextInput } from 'react-native';
import { SearchPopupOverlay, type SearchPopupOverlayProps } from '../SearchPopupOverlay';
import { SEARCH_DEBOUNCE_MS } from '../search-model';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function makeItem(kind: ItemRow['kind'], index: number, name: string): ItemRow {
  return {
    id: index,
    key: `${kind}:src-1:${index}`,
    kind,
    sourceId: 'src-1',
    providerId: String(index),
    name,
    logo: `https://art.example.test/${kind}-${index}.jpg`,
    rating: kind === 'live' ? null : 8.4,
    year: kind === 'live' ? null : 2025,
    num: kind === 'live' ? index : null,
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

function createMockCatalog(resultsByQuery?: (q: string) => Partial<SearchResults>) {
  const search = jest.fn(async (query: string, _opts?: SearchOptions): Promise<SearchResults> => {
    const partial = resultsByQuery?.(query) ?? {};
    return {
      live: partial.live ?? [],
      epg: partial.epg ?? [],
      movies: partial.movies ?? [],
      series: partial.series ?? [],
      episodes: partial.episodes ?? [],
    };
  });
  const listProgressByKeys = jest.fn(async () => []);
  const catalog = { search, listProgressByKeys } as unknown as CatalogService;
  return { catalog, search };
}

function renderPopup(
  props: Partial<SearchPopupOverlayProps> & { catalog: CatalogService },
  opts: {
    viewport?: ViewportOverride;
    locale?: 'en' | 'tr';
    androidSource?: AndroidKeySource;
  } = {},
) {
  const merged: SearchPopupOverlayProps = {
    visible: true,
    refreshToken: 1,
    query: '',
    onQueryChange: jest.fn(),
    onPlay: jest.fn(),
    onOpenDetail: jest.fn(),
    onViewAll: jest.fn(),
    onClose: jest.fn(),
    ...props,
  };

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
        <I18nProvider i18n={createAppI18n(opts.locale ?? 'en')}>
          <SearchPopupOverlay {...merged} />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  if (opts.androidSource) {
    return {
      props: merged,
      view: render(<RemoteKeysProvider android={opts.androidSource}>{tree}</RemoteKeysProvider>),
    };
  }
  return {
    props: merged,
    view: render(tree),
  };
}

describe('SearchPopupOverlay', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders nothing when visible is false, hides View all on empty query, and dismisses on desktop Escape', async () => {
    const { catalog } = createMockCatalog();
    const closed = renderPopup({ visible: false, catalog });
    const closedView = await closed.view;
    expect(screen.queryByTestId('search-popup-overlay')).toBeNull();
    await closedView.unmount();

    const osReplacer = jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<
      string,
      Set<(e: { key?: string; preventDefault?: () => void }) => void>
    >();
    const origWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      addEventListener: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => {
        listeners.get(type)?.delete(fn);
      },
    };
    try {
      const rendered = renderPopup({ visible: true, query: '', catalog });
      await rendered.view;
      expect(screen.queryByTestId('search-popup-view-all')).toBeNull();
      expect(screen.queryByTestId('search-popup-clear')).toBeNull();

      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) {
          fn({ key: 'Escape', preventDefault: jest.fn() });
        }
      });
      expect(rendered.props.onClose).toHaveBeenCalledTimes(1);
    } finally {
      osReplacer.restore();
      (globalThis as { window?: unknown }).window = origWindow;
    }
  });

  it('shows up to 3 suggestions, Movies -> Series -> Live rails in order, and bare borderless View all link', async () => {
    const { catalog } = createMockCatalog(() => ({
      movies: [makeItem('movie', 1, 'Star Atlas'), makeItem('movie', 2, 'Stardust')],
      series: [makeItem('series', 3, 'Starlight'), makeItem('series', 4, 'Northern Star')],
      live: [makeItem('live', 5, 'Star Live HD')],
    }));

    const onQueryChange = jest.fn();
    const onOpenDetail = jest.fn();
    const onPlay = jest.fn();
    const onViewAll = jest.fn();
    const onClose = jest.fn();

    await renderPopup({
      catalog,
      query: 'star',
      onQueryChange,
      onOpenDetail,
      onPlay,
      onViewAll,
      onClose,
    }).view;

    expect(screen.getByTestId('search-popup-clear')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-popup-suggestions')).toBeTruthy();
      expect(screen.getByTestId('search-popup-rail-movies')).toBeTruthy();
      expect(screen.getByTestId('search-popup-rail-series')).toBeTruthy();
      expect(screen.getByTestId('search-popup-rail-live')).toBeTruthy();
    });

    // At most 3 prefix-prioritized live suggestions
    expect(screen.getByTestId('search-popup-suggestion-0')).toHaveTextContent('Star Atlas');
    expect(screen.getByTestId('search-popup-suggestion-1')).toHaveTextContent('Stardust');
    expect(screen.getByTestId('search-popup-suggestion-2')).toHaveTextContent('Starlight');
    expect(screen.queryByTestId('search-popup-suggestion-3')).toBeNull();

    // Clicking a suggestion fills the query input
    await fireEvent.press(screen.getByTestId('search-popup-suggestion-1'));
    expect(onQueryChange).toHaveBeenCalledWith('Stardust');

    // Clicking a movie opens detail & closes popup; clicking live plays & closes popup
    await fireEvent.press(screen.getByTestId('search-popup-movie-0'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'movie', itemKey: 'movie:src-1:1' }),
    );

    await fireEvent.press(screen.getByTestId('search-popup-live-0'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'live', itemKey: 'live:src-1:5' }),
    );

    // Bottom View all button is bare text-only (no box, no border, no background)
    const viewAll = screen.getByTestId('search-popup-view-all');
    expect(viewAll).toHaveTextContent('View all');
    const viewAllStyle = StyleSheet.flatten(viewAll.props.style) ?? {};
    expect(viewAllStyle.borderWidth ?? 0).toBe(0);
    expect(
      viewAllStyle.backgroundColor === undefined || viewAllStyle.backgroundColor === 'transparent',
    ).toBe(true);

    await fireEvent.press(viewAll);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onViewAll).toHaveBeenCalledWith('Stardust');

    // Clear button clears the search input
    await fireEvent.press(screen.getByTestId('search-popup-clear'));
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it('omits empty rails cleanly, shows quiet empty state on zero hits, and localizes in Turkish', async () => {
    const { catalog } = createMockCatalog((q) =>
      q === 'none'
        ? {}
        : {
            movies: [],
            series: [makeItem('series', 10, 'Dark Matter')],
            live: [],
          },
    );

    const view = await renderPopup({ catalog, query: 'dark' }, { locale: 'tr' }).view;

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-popup-rail-series')).toBeTruthy();
    });
    expect(screen.queryByTestId('search-popup-rail-movies')).toBeNull();
    expect(screen.queryByTestId('search-popup-rail-live')).toBeNull();
    expect(screen.getByTestId('search-popup-view-all')).toHaveTextContent('Hepsini görüntüle');

    await view.rerender(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('tr')}>
            <SearchPopupOverlay
              visible
              catalog={catalog}
              refreshToken={1}
              query="none"
              onQueryChange={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
              onViewAll={jest.fn()}
              onClose={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-popup-empty')).toBeTruthy();
    });
  });

  it('dismisses on backdrop press and Escape, and traverses rails -> View all on TV D-pad', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const android = createAndroidSource();
    const { catalog } = createMockCatalog(() => ({
      movies: [makeItem('movie', 1, 'Dune')],
      series: [makeItem('series', 2, 'Dune Prophecy')],
      live: [makeItem('live', 3, 'Dune Live')],
    }));

    const rendered = renderPopup(
      { catalog, query: 'dune' },
      {
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
          overscanX: 48,
          overscanY: 27,
        },
        androidSource: android.source,
      },
    );
    await rendered.view;

    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
    });

    await waitFor(() => {
      expect(screen.getByTestId('search-popup-rail-live')).toBeTruthy();
      expect(screen.getByTestId('search-popup-view-all')).toBeTruthy();
    });

    // Navigate Down: input -> suggestions -> movies -> series -> live -> viewAll
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_DOWN);
    await android.sendKey(KEYCODE_DPAD_CENTER);

    expect(rendered.props.onClose).toHaveBeenCalledTimes(1);
    expect(rendered.props.onViewAll).toHaveBeenCalledWith('dune');

    // Right inside suggestions selects second suggestion; Up + Select edits/clears; Back closes
    await android.sendKey(KEYCODE_DPAD_UP);
    await android.sendKey(KEYCODE_DPAD_RIGHT);
    await android.sendKey(KEYCODE_BACK);
    expect(rendered.props.onClose).toHaveBeenCalledTimes(2);

    await fireEvent.press(
      screen.getByTestId('search-popup-backdrop', { includeHiddenElements: true }),
    );
    expect(rendered.props.onClose).toHaveBeenCalledTimes(3);
  });

  it('defers TV TextInput focus until editable/focusable commit, blurs cleanly, keeps rails flexShrink, and scrolls on D-pad navigation', async () => {
    const osReplacer = jest.replaceProperty(Platform, 'OS', 'android');
    const isTvSpy = jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let editableAtFocusTime: boolean | undefined;
    let focusableAtFocusTime: boolean | undefined;
    const focusSpy = jest.spyOn(TextInput.prototype, 'focus').mockImplementation(() => {
      const node = screen.queryByTestId('search-popup-input');
      editableAtFocusTime = node?.props.editable;
      focusableAtFocusTime = node?.props.focusable;
    });
    const scrollToSpy = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {});
    const scrollToEndSpy = jest
      .spyOn(ScrollView.prototype, 'scrollToEnd')
      .mockImplementation(() => {});

    const android = createAndroidSource();
    const { catalog } = createMockCatalog(() => ({
      movies: [
        makeItem('movie', 1, 'Alpha 1'),
        makeItem('movie', 2, 'Alpha 2'),
        makeItem('movie', 3, 'Alpha 3'),
        makeItem('movie', 4, 'Alpha 4'),
      ],
      series: [makeItem('series', 5, 'Alpha Series')],
      live: [makeItem('live', 6, 'Alpha Live')],
    }));

    try {
      const rendered = renderPopup(
        { catalog, query: 'alpha' },
        {
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1280,
            height: 720,
            overscanX: 48,
            overscanY: 27,
          },
          androidSource: android.source,
        },
      );
      await rendered.view;

      await act(async () => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 20);
      });

      await waitFor(() => {
        expect(screen.getByTestId('search-popup-rails-scroll')).toBeTruthy();
        expect(screen.getByTestId('search-popup-view-all')).toBeTruthy();
      });

      // Flex constraints keep search-popup-view-all pinned while rails scroll
      const railsStyle = StyleSheet.flatten(
        screen.getByTestId('search-popup-rails-scroll').props.style,
      );
      expect(railsStyle.flexShrink).toBe(1);

      // Select on TV input sets editable & focusable BEFORE calling focus() in useLayoutEffect
      expect(screen.getByTestId('search-popup-input').props.editable).toBe(false);
      focusSpy.mockClear();
      editableAtFocusTime = undefined;
      focusableAtFocusTime = undefined;
      await android.sendKey(KEYCODE_DPAD_CENTER);
      expect(focusSpy).toHaveBeenCalled();
      expect(editableAtFocusTime).toBe(true);
      expect(focusableAtFocusTime).toBe(true);

      // Blurring input resets editingInput back to false cleanly
      await fireEvent(screen.getByTestId('search-popup-input'), 'blur');
      expect(screen.getByTestId('search-popup-input').props.editable).toBe(false);

      // Navigating down to movies rail + right x2 triggers horizontal rail scroll; down to viewAll triggers scrollToEnd
      await fireEvent(screen.getByTestId('search-popup-rail-movies'), 'layout', {
        nativeEvent: { layout: { y: 40, height: 220 } },
      });
      await android.sendKey(KEYCODE_DPAD_DOWN); // suggestions
      await android.sendKey(KEYCODE_DPAD_DOWN); // movies
      await android.sendKey(KEYCODE_DPAD_RIGHT); // col 1
      await android.sendKey(KEYCODE_DPAD_RIGHT); // col 2
      expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number) }));

      await android.sendKey(KEYCODE_DPAD_DOWN); // series
      await android.sendKey(KEYCODE_DPAD_DOWN); // live
      await android.sendKey(KEYCODE_DPAD_DOWN); // viewAll
      expect(scrollToEndSpy).toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
      scrollToSpy.mockRestore();
      scrollToEndSpy.mockRestore();
      isTvSpy.mockRestore();
      osReplacer.restore();
    }
  });
});
