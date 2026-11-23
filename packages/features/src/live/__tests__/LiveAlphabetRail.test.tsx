import type {
  AlphabetBucket,
  CatalogService,
  CategoryRow,
  ItemRow,
  ListItemsOptions,
  SourceRow,
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
import { Platform, VirtualizedList } from 'react-native';
import { LiveScreen } from '../LiveScreen';
import { EMPTY_LIVE_MEMORY } from '../live-model';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const NOW_MS = Date.UTC(2026, 10, 21, 18, 15, 0);

function makeSource(id = 'src-1'): SourceRow {
  return { id, kind: 'xtream', name: 'Demo Live', createdAt: 1, needsImport: false };
}

function makeLiveChannel(index: number): ItemRow {
  const num = 101 + index;
  return {
    id: index + 1,
    key: `live:src-1:ch-${index}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(num),
    name: `Channel ${num}`,
    logo: null,
    rating: null,
    year: null,
    num,
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

const LIVE_BUCKETS: readonly AlphabetBucket[] = [
  { letter: 'A', offset: 0, count: 120 },
  { letter: 'K', offset: 120, count: 240 },
  { letter: 'T', offset: 360, count: 240 },
];

function createLiveAlphaCatalog(totalChannels: number) {
  const itemsCalls: Array<{ offset: number; limit: number; opts?: ListItemsOptions }> = [];
  const category: CategoryRow = {
    id: 'src-1|live|cat-0',
    sourceId: 'src-1',
    kind: 'live',
    name: 'National',
    position: 0,
    itemCount: totalChannels,
  };
  const alphabetIndex = jest.fn(async () => LIVE_BUCKETS);
  const catalog = {
    listSources: jest.fn(async () => [makeSource()]),
    categories: jest.fn(async () => [category]),
    items: jest.fn(
      async (_catId: string, offset: number, limit: number, opts?: ListItemsOptions) => {
        itemsCalls.push({ offset, limit, ...(opts !== undefined ? { opts } : {}) });
        const end = Math.min(totalChannels, offset + limit);
        const rows: ItemRow[] = [];
        for (let i = offset; i < end; i++) {
          rows.push(makeLiveChannel(i));
        }
        return rows;
      },
    ),
    alphabetIndex,
    listFavoriteKeys: jest.fn(async () => []),
    listFavorites: jest.fn(async () => []),
    nowNext: jest.fn(async () => []),
  } as unknown as CatalogService;

  return { catalog, itemsCalls, alphabetIndex, category };
}

function renderLive(
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

describe('LiveChannelsGrid A-Z Sort & AlphabetJumpRail (#407)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('toggles Channel order | A-Z sort, hides rail below 40 channels, renders rail at >= 40, and jumps directly to target offset without intermediate page loads', async () => {
    const scrollToIndexSpy = jest
      .spyOn(VirtualizedList.prototype, 'scrollToIndex')
      .mockImplementation(() => undefined);

    // 1. Below 40 channels (25 channels): rail stays hidden even when sortBy === 'alpha'
    const small = createLiveAlphaCatalog(25);
    const smallView = await renderLive(
      <LiveScreen
        catalog={small.catalog}
        sources={[makeSource()]}
        refreshToken={0}
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-grid-sort')).toBeTruthy();
    });
    expect(screen.queryByTestId('live-alphabet-rail')).toBeNull();
    await fireEvent.press(screen.getByTestId('live-grid-sort'));
    expect(screen.queryByTestId('live-alphabet-rail')).toBeNull();
    await smallView.unmount();

    // 2. 600 channels (>= 40): toggling to A-Z fetches alphabetIndex and renders live-alphabet-rail
    const large = createLiveAlphaCatalog(600);
    const largeView = await renderLive(
      <LiveScreen
        catalog={large.catalog}
        sources={[makeSource()]}
        refreshToken={0}
        collapseVariants
        onPlay={jest.fn()}
        onOpenSources={jest.fn()}
        nowMs={NOW_MS}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
      expect(screen.getByTestId('live-grid-sort')).toBeTruthy();
    });
    expect(screen.getByTestId('live-grid-sort-default')).toHaveTextContent('Channel order');
    expect(screen.getByTestId('live-grid-sort-alpha')).toHaveTextContent('A–Z');
    expect(screen.queryByTestId('live-alphabet-rail')).toBeNull();

    // Press live-grid-sort -> switches to 'alpha'
    await fireEvent.press(screen.getByTestId('live-grid-sort'));
    await waitFor(() => {
      expect(screen.getByTestId('live-alphabet-rail')).toBeTruthy();
    });

    expect(large.alphabetIndex).toHaveBeenCalledWith({
      sourceId: 'src-1',
      kind: 'live',
      categoryId: 'src-1|live|cat-0',
      collapseVariants: true,
    });
    expect(
      large.itemsCalls.some((c) => c.opts?.sortBy === 'alpha' && c.opts?.collapseVariants === true),
    ).toBe(true);

    // Clear initial page 0 calls, then click letter 'T' (offset = 360, page = 3, row = 360 / 3 = 120)
    large.itemsCalls.length = 0;
    scrollToIndexSpy.mockClear();
    await fireEvent.press(screen.getByTestId('live-alphabet-rail-letter-T'));

    expect(scrollToIndexSpy).toHaveBeenCalledWith({ index: 120, animated: false });
    // Loads page 3 (offset 360) directly and NEVER intermediate pages 1 (120) or 2 (240)
    expect(large.itemsCalls.some((c) => c.offset === 360)).toBe(true);
    expect(large.itemsCalls.some((c) => c.offset === 120 || c.offset === 240)).toBe(false);

    await largeView.unmount();
  });

  it('supports 10-ft TV D-pad toggling live-grid-sort and entering/exiting live-alphabet-rail (#407)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const { catalog, itemsCalls } = createLiveAlphaCatalog(600);
    const { source: androidSource, sendKey } = createAndroidSource();
    const onPlay = jest.fn();

    const view = await renderLive(
      <LiveScreen
        catalog={catalog}
        sources={[makeSource()]}
        refreshToken={0}
        memory={EMPTY_LIVE_MEMORY}
        onPlay={onPlay}
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

    // Header modes -> Down to categories -> Right past category chip to live-grid-sort -> Select toggles A-Z sort
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-grid-sort-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(screen.getByTestId('live-alphabet-rail')).toBeTruthy();
    });

    // Down into LiveChannelsGrid body (row 0, col 0 on 3-col TV grid)
    await sendKey(KEYCODE_DPAD_DOWN);
    // Right x2 reaches rightmost column (col 2), Right once more enters live-alphabet-rail!
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.queryByTestId('live-alphabet-rail-letter-A-focus-ring')).toBeNull();

    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-alphabet-rail-letter-A-focus-ring')).toBeTruthy();

    // Left exits rail back to grid without trapping focus
    await sendKey(KEYCODE_DPAD_LEFT);
    expect(screen.queryByTestId('live-alphabet-rail-letter-A-focus-ring')).toBeNull();

    // Re-enter rail -> Back also exits rail back to grid without leaving body
    await sendKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('live-alphabet-rail-letter-A-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_BACK);
    expect(screen.queryByTestId('live-alphabet-rail-letter-A-focus-ring')).toBeNull();

    // Re-enter rail -> Down (K) -> Up (A) -> Down (K) -> Down (T, offset 360) -> Select jumps directly to offset 360!
    itemsCalls.length = 0;
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('live-alphabet-rail-letter-K-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_DPAD_UP);
    expect(screen.getByTestId('live-alphabet-rail-letter-A-focus-ring')).toBeTruthy();
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('live-alphabet-rail-letter-T-focus-ring')).toBeTruthy();

    await sendKey(KEYCODE_DPAD_CENTER);
    expect(screen.queryByTestId('live-alphabet-rail-letter-T-focus-ring')).toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-360')).toBeTruthy();
    });
    expect(itemsCalls.some((c) => c.offset === 360)).toBe(true);
    expect(itemsCalls.some((c) => c.offset === 120 || c.offset === 240)).toBe(false);

    // Pressing Select on the jumped channel tunes channel 360
    await sendKey(KEYCODE_DPAD_CENTER);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'live:src-1:ch-360' }));

    await view.unmount();
  });
});
