import type {
  CatalogService,
  EpisodeRow,
  ItemDetailRow,
  ItemRow,
  SeasonRow,
  SeriesUnplayedSummary,
  WatchProgressRow,
} from '@elv/data';
import {
  type DownloadEnqueueInput,
  type DownloadManagerPort,
  type DownloadRecord,
  elvError,
  err,
  ok,
} from '@elv/domain';
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
import { Platform, ScrollView } from 'react-native';
import {
  CatalogUiCacheProvider,
  createCatalogUiCache,
  type DetailTarget,
  DownloadsProvider,
} from '../../shared';
import { DetailScopePicker } from '../DetailScopePicker';
import { DetailScreen } from '../DetailScreen';
import { computeEpisodeRowMetrics } from '../detail-model';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

const TV_VIEWPORT: ViewportOverride = {
  formFactor: 'tv',
  orientation: 'landscape',
  inputModality: 'tv',
  width: 1920,
  height: 1080,
};

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 800,
};

const SERIES_TARGET: DetailTarget = {
  itemKey: 'x:src-1:series:701',
  sourceId: 'src-1',
  kind: 'series',
  title: 'Meridian Station',
  posterUri: 'https://img.invalid/poster.jpg',
  backdropUri: 'https://img.invalid/backdrop.jpg',
  year: 2025,
  rating: 8.8,
  catalogId: 701,
  categoryId: 'src-1|series|20',
};

const MOVIE_TARGET: DetailTarget = {
  itemKey: 'x:src-1:movie:702',
  sourceId: 'src-1',
  kind: 'movie',
  title: 'Glass Orbit',
  posterUri: null,
  backdropUri: null,
  year: 2026,
  rating: 8.4,
  catalogId: 702,
  categoryId: 'src-1|movie|10',
};

const SERIES_DETAIL: ItemDetailRow = {
  id: 701,
  key: SERIES_TARGET.itemKey,
  sourceId: 'src-1',
  providerId: '701',
  kind: 'series',
  name: 'Meridian Station',
  logo: SERIES_TARGET.posterUri,
  rating: 8.8,
  year: 2025,
  num: null,
  plot: 'Deep orbit relay station drama.',
};

const RELATED_ITEMS: readonly ItemRow[] = [
  {
    id: 801,
    sourceId: 'src-1',
    kind: 'series',
    providerId: '801',
    key: 'x:src-1:series:801',
    name: 'Outer Relay',
    num: null,
    logo: null,
    year: 2024,
    rating: 8.1,
  },
];

function makeEpisodes(
  season: number,
  count: number,
  opts: { readonly nullEpisodeNums?: boolean } = {},
): EpisodeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: season * 1000 + i + 1,
    key: `x:src-1:ep:701:${season}:${i + 1}`,
    season,
    episode: opts.nullEpisodeNums ? null : i + 1,
    title: `S${season} Ep ${i + 1}`,
    durationSec: 2400,
  }));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeProgressRow(ep: EpisodeRow, watched: boolean): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: ep.key,
    kind: 'episode',
    title: ep.title ?? '',
    subtitle: null,
    logo: null,
    seriesKey: SERIES_TARGET.itemKey,
    season: ep.season,
    episode: ep.episode,
    positionMs: watched ? 2_400_000 : 0,
    durationMs: 2_400_000,
    watched,
    updatedAt: 1_700_000_000_000,
  };
}

function makeTvKeyHarness() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const androidSource: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  const pressKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
      listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
    });
  };
  const emitRaw = async (events: readonly AndroidKeyEvent[]) => {
    await act(async () => {
      for (const e of events) listener?.(e);
    });
  };
  return { androidSource, pressKey, emitRaw };
}

function createReviewCatalog(
  opts: {
    readonly seasons?: readonly SeasonRow[];
    readonly episodesBySeason?: Readonly<Record<number, readonly EpisodeRow[]>>;
    readonly initialProgress?: readonly WatchProgressRow[];
    readonly unplayedSummary?: SeriesUnplayedSummary | null;
    readonly related?: readonly ItemRow[];
    readonly omitSetWatched?: boolean;
    readonly setSeasonWatchedImpl?: CatalogService['setSeasonWatched'];
    readonly setSeriesWatchedImpl?: CatalogService['setSeriesWatched'];
    readonly listProgressByKeysImpl?: CatalogService['listProgressByKeys'];
  } = {},
) {
  const seasons = opts.seasons ?? [
    { season: 1, episodeCount: 2 },
    { season: 2, episodeCount: 2 },
  ];
  const episodesBySeason = opts.episodesBySeason ?? {
    1: makeEpisodes(1, 2),
    2: makeEpisodes(2, 2),
  };
  const progressMap = new Map<string, WatchProgressRow>();
  for (const row of opts.initialProgress ?? []) progressMap.set(row.itemKey, row);

  const setWatched = jest.fn(async (key: string, watched: boolean) => {
    const prev = progressMap.get(key);
    progressMap.set(key, {
      ...makeProgressRow(
        {
          id: 1,
          key,
          season: prev?.season ?? 1,
          episode: prev?.episode ?? 1,
          title: prev?.title ?? '',
          durationSec: 2400,
        },
        watched,
      ),
      updatedAt: Date.now(),
    });
    return ok(undefined);
  });
  const saveProgress = jest.fn(async (input: { itemKey: string; watched?: boolean }) =>
    ok(
      makeProgressRow(
        { id: 1, key: input.itemKey, season: 1, episode: 1, title: 'Ep', durationSec: 2400 },
        input.watched ?? true,
      ),
    ),
  );
  const setSeasonWatched = opts.setSeasonWatchedImpl ?? jest.fn(async () => ok(2));
  const setSeriesWatched = opts.setSeriesWatchedImpl ?? jest.fn(async () => ok(4));
  const listSeriesUnplayedCounts = jest.fn(async (keys: readonly string[]) =>
    opts.unplayedSummary && keys.includes(opts.unplayedSummary.seriesKey)
      ? [opts.unplayedSummary]
      : [],
  );

  const catalog = {
    listSources: jest.fn(async () => []),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => [...(opts.related ?? [])]),
    itemDetail: jest.fn(async () => SERIES_DETAIL),
    seasons: jest.fn(async () => ok([...seasons])),
    episodes: jest.fn(async (_sid: number, s: number) => [...(episodesBySeason[s] ?? [])]),
    resolveStream: jest.fn(async (k: string) =>
      ok({ url: `http://sim.test/${k}.mp4`, headers: {} }),
    ),
    listFavoriteKeys: jest.fn(async () => []),
    listProgressByKeys:
      opts.listProgressByKeysImpl ??
      jest.fn(async (keys: readonly string[]) =>
        keys.map((k) => progressMap.get(k)).filter((r): r is WatchProgressRow => r !== undefined),
      ),
    listSeriesUnplayedCounts,
    getProgress: jest.fn(async () => null),
    setFavorite: jest.fn(async (_in: unknown, active: boolean) => ok(active)),
    ...(opts.omitSetWatched ? {} : { setWatched }),
    saveProgress,
    setSeasonWatched,
    setSeriesWatched,
    getRating: jest.fn(async () => null),
    setRating: jest.fn(async (_in: unknown, v: unknown) => ok(v)),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;

  return {
    catalog,
    setWatched,
    saveProgress,
    setSeasonWatched,
    setSeriesWatched,
    listSeriesUnplayedCounts,
  };
}

function wrapProviders(
  node: React.ReactElement,
  opts: {
    viewport?: ViewportOverride;
    androidSource?: AndroidKeySource;
    downloadManager?: DownloadManagerPort;
    catalog?: CatalogService;
    uiCache?: ReturnType<typeof createCatalogUiCache>;
  } = {},
) {
  const uiCache = opts.uiCache ?? createCatalogUiCache({ locale: 'en' });
  const content = (
    <ViewportProvider value={opts.viewport ?? DESKTOP_VIEWPORT}>
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <CatalogUiCacheProvider cache={uiCache}>
            <DownloadsProvider manager={opts.downloadManager} catalog={opts.catalog}>
              {node}
            </DownloadsProvider>
          </CatalogUiCacheProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
  return opts.androidSource ? (
    <RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>
  ) : (
    content
  );
}

function makeDownloadRec(
  overrides: Partial<DownloadRecord> & {
    id: string;
    itemKey: string;
    status: DownloadRecord['status'];
  },
): DownloadRecord {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    kind: 'episode',
    title: 'S1 Ep 1',
    seriesKey: SERIES_TARGET.itemKey,
    seriesTitle: 'Meridian Station',
    season: 1,
    episodeNum: 1,
    poster: null,
    localFileName: 'ep.mp4',
    localUri: null,
    bytesDownloaded: 200,
    totalBytes: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function detailEl(
  catalog: CatalogService,
  extra: Partial<React.ComponentProps<typeof DetailScreen>> = {},
) {
  return (
    <DetailScreen
      target={SERIES_TARGET}
      catalog={catalog}
      refreshToken={1}
      onBack={jest.fn()}
      onPlay={jest.fn()}
      onOpenDetail={jest.fn()}
      {...extra}
    />
  );
}

describe('Wave Q3 Series Detail — Independent Review Regression Fixes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('[Blocker #1] includes measured ListHeaderComponent height in getItemLayout and scrolls accurately to Related rail for both movies and series', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const { androidSource, pressKey } = makeTvKeyHarness();
    const scrollToSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(() => undefined);

    const mock = createReviewCatalog({
      seasons: [{ season: 1, episodeCount: 2 }],
      episodesBySeason: { 1: makeEpisodes(1, 2) },
      related: RELATED_ITEMS,
    });

    const view = await render(
      wrapProviders(detailEl(mock.catalog, { isActiveScope: true }), {
        viewport: TV_VIEWPORT,
        androidSource,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-list-header')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
      expect(screen.getByTestId('detail-related-item-0')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('detail-list-header'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 1920, height: 620 } },
    });

    const listNode = screen.getByTestId('detail-scroll');
    const tvMetrics = computeEpisodeRowMetrics(false, true);
    expect(listNode.props.getItemLayout([], 0)).toEqual({
      length: tvMetrics.itemStride,
      offset: 620,
      index: 0,
    });
    expect(listNode.props.getItemLayout([], 5)).toEqual({
      length: tvMetrics.itemStride,
      offset: 620 + tvMetrics.itemStride * 5,
      index: 5,
    });

    scrollToSpy.mockClear();
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    scrollToSpy.mockClear();
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('detail-related-item-0-focus-ring')).toBeTruthy();
    const seriesVerticalCall = scrollToSpy.mock.calls.find(
      (c) => typeof (c[0] as { y?: number } | undefined)?.y === 'number',
    );
    const seriesRelatedY = (seriesVerticalCall?.[0] as { y?: number } | undefined)?.y ?? 0;
    expect(seriesRelatedY).toBeGreaterThan(620);
    await view.unmount();

    const movieMock = createReviewCatalog({ related: RELATED_ITEMS });
    scrollToSpy.mockClear();
    const movieView = await render(
      wrapProviders(detailEl(movieMock.catalog, { target: MOVIE_TARGET, isActiveScope: true }), {
        viewport: TV_VIEWPORT,
        androidSource,
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('detail-list-header')).toBeTruthy();
      expect(screen.getByTestId('detail-related-item-0')).toBeTruthy();
    });
    await fireEvent(screen.getByTestId('detail-list-header'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 1920, height: 680 } },
    });
    scrollToSpy.mockClear();
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('detail-related-item-0-focus-ring')).toBeTruthy();
    const movieVerticalCall = scrollToSpy.mock.calls.find(
      (c) => typeof (c[0] as { y?: number } | undefined)?.y === 'number',
    );
    const movieRelatedY = (movieVerticalCall?.[0] as { y?: number } | undefined)?.y ?? 0;
    expect(movieRelatedY).toBeGreaterThan(500);
    await movieView.unmount();
  });

  it('[Blocker #3] derives multi-season isSeriesWatched & uncached isSeasonWatched from DB summary and preserves seasonBulkOverrides across userStateVersion bumps', async () => {
    const seasons: SeasonRow[] = Array.from({ length: 10 }, (_, idx) => ({
      season: idx + 1,
      episodeCount: 1,
    }));
    const episodesBySeason: Record<number, EpisodeRow[]> = {};
    const watchedS1to9: WatchProgressRow[] = [];
    for (let s = 1; s <= 10; s += 1) {
      const eps = makeEpisodes(s, 1);
      episodesBySeason[s] = eps;
      const first = eps[0];
      if (s <= 9 && first) watchedS1to9.push(makeProgressRow(first, true));
    }

    const partialMock = createReviewCatalog({
      seasons,
      episodesBySeason,
      initialProgress: watchedS1to9,
      unplayedSummary: {
        seriesKey: SERIES_TARGET.itemKey,
        total: 10,
        unplayed: 1,
        watched: false,
      },
    });
    const uiCacheA = createCatalogUiCache({ locale: 'en' });
    const renderA = (userStateVersion: number) =>
      wrapProviders(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={partialMock.catalog}
          refreshToken={1}
          userStateVersion={userStateVersion}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
        { uiCache: uiCacheA },
      );

    const viewA = await render(renderA(0));
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
      expect(partialMock.listSeriesUnplayedCounts).toHaveBeenCalledWith([SERIES_TARGET.itemKey]);
    });
    expect(screen.getByTestId('detail-watched').props.accessibilityState?.selected).toBe(false);

    await fireEvent.press(screen.getByTestId('detail-watched'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-select'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-option-10'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-apply'));
    await waitFor(() => {
      expect(partialMock.setSeasonWatched).toHaveBeenCalledWith(SERIES_TARGET.itemKey, 10, true);
      expect(screen.queryByTestId('detail-scope-picker')).toBeNull();
    });

    // Bumping userStateVersion MUST NOT wipe uncached Season 10 override
    await viewA.rerender(renderA(1));
    await waitFor(() => {
      expect(partialMock.listSeriesUnplayedCounts.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    await fireEvent.press(screen.getByTestId('detail-watched'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-select'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-option-10'));
    expect(screen.getByTestId('detail-scope-season-apply')).toHaveTextContent(
      'Mark Season 10 unwatched',
    );
    await viewA.unmount();

    const fullMock = createReviewCatalog({
      seasons,
      episodesBySeason,
      initialProgress: watchedS1to9,
      unplayedSummary: {
        seriesKey: SERIES_TARGET.itemKey,
        total: 10,
        unplayed: 0,
        watched: true,
      },
    });
    const viewB = await render(
      wrapProviders(
        <DetailScreen
          target={SERIES_TARGET}
          catalog={fullMock.catalog}
          refreshToken={1}
          userStateVersion={0}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('detail-watched').props.accessibilityState?.selected).toBe(true);
    });
    await viewB.unmount();
  });

  it('[Major #6 + Minor #11] guards DetailScopePicker against TV repeat double-submit, parent seasons rerender reset, in-flight duplicates/errors, and empty seasons download', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const { androidSource, pressKey, emitRaw } = makeTvKeyHarness();
    const gate = deferred<boolean>();
    const onApplyEntire = jest.fn(() => gate.promise);
    const onApplySeason = jest.fn(async () => true);
    const onClose = jest.fn();

    const buildPicker = (seasons: SeasonRow[]) =>
      wrapProviders(
        <DetailScopePicker
          visible
          mode="watched"
          seriesTitle="Meridian Station"
          seasons={seasons}
          defaultSeason={1}
          onApplyEntireSeries={onApplyEntire}
          onApplySeason={onApplySeason}
          onClose={onClose}
        />,
        { viewport: TV_VIEWPORT, androidSource },
      );

    const view = await render(
      buildPicker([
        { season: 1, episodeCount: 4 },
        { season: 2, episodeCount: 4 },
      ]),
    );

    await fireEvent.press(screen.getByTestId('detail-scope-season-select'));
    expect(screen.getByTestId('detail-scope-season-option-2')).toBeTruthy();
    await view.rerender(
      buildPicker([
        { season: 1, episodeCount: 4 },
        { season: 2, episodeCount: 4 },
      ]),
    );
    expect(screen.getByTestId('detail-scope-season-option-2')).toBeTruthy();

    await pressKey(KEYCODE_BACK);
    expect(screen.queryByTestId('detail-scope-season-option-2')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await pressKey(KEYCODE_DPAD_UP);
    await emitRaw([
      { action: 'down', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 0 },
      { action: 'down', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 400 },
      { action: 'up', keyCode: KEYCODE_DPAD_CENTER, canceled: false, ageMs: 500 },
    ]);
    await fireEvent.press(screen.getByTestId('detail-scope-entire-series'));
    expect(onApplyEntire).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve(false);
    });
    await waitFor(() => {
      expect(screen.getByTestId('detail-scope-error')).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    await view.unmount();

    const onDownloadEmpty = jest.fn();
    const emptyView = await render(
      wrapProviders(
        <DetailScopePicker
          visible
          mode="download"
          seriesTitle="Meridian Station"
          seasons={[]}
          defaultSeason={null}
          onApplyEntireSeries={onDownloadEmpty}
          onApplySeason={jest.fn()}
          onClose={jest.fn()}
        />,
      ),
    );
    const entireBtn = screen.getByTestId('detail-scope-entire-series');
    expect(entireBtn.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(entireBtn);
    expect(onDownloadEmpty).not.toHaveBeenCalled();
    await emptyView.unmount();
  });

  it('[Major #8 + Minor #10] bulk download re-queues paused episodes and resets null fallback episodeNum per season', async () => {
    const s1 = makeEpisodes(1, 2, { nullEpisodeNums: true });
    const s2 = makeEpisodes(2, 2, { nullEpisodeNums: true });
    const [s1Ep1, s1Ep2] = s1;
    const [s2Ep1, s2Ep2] = s2;
    if (!s1Ep1 || !s1Ep2 || !s2Ep1 || !s2Ep2) throw new Error('missing fixtures');

    const mock = createReviewCatalog({
      seasons: [
        { season: 1, episodeCount: 2 },
        { season: 2, episodeCount: 2 },
      ],
      episodesBySeason: { 1: s1, 2: s2 },
    });

    const pausedRec = makeDownloadRec({ id: 'dl-paused', itemKey: s1Ep1.key, status: 'paused' });
    const downloadingRec = makeDownloadRec({
      id: 'dl-active',
      itemKey: s1Ep2.key,
      status: 'downloading',
    });

    const enqueueBatch = jest.fn(async (inputs: readonly DownloadEnqueueInput[]) =>
      ok<readonly DownloadRecord[]>(
        inputs.map((inp) =>
          makeDownloadRec({
            id: `dl-${inp.itemKey}`,
            itemKey: inp.itemKey,
            title: inp.title,
            season: inp.season ?? null,
            episodeNum: inp.episodeNum ?? null,
            status: 'queued',
            bytesDownloaded: 0,
          }),
        ),
      ),
    );
    const manager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => [pausedRec, downloadingRec]),
      get: jest.fn(async () => null),
      enqueue: jest.fn(),
      enqueueBatch,
      pause: jest.fn(async () => ok(undefined)),
      resume: jest.fn(async () => ok(undefined)),
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      subscribe: () => () => undefined,
    };

    const view = await render(
      wrapProviders(detailEl(mock.catalog), { downloadManager: manager, catalog: mock.catalog }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-download')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('detail-download'));
    await fireEvent.press(screen.getByTestId('detail-scope-entire-series'));

    await waitFor(() => {
      expect(enqueueBatch).toHaveBeenCalledTimes(1);
    });
    const batch = enqueueBatch.mock.calls[0]?.[0] ?? [];
    expect(batch.map((i) => ({ key: i.itemKey, season: i.season, epNum: i.episodeNum }))).toEqual([
      { key: s1Ep1.key, season: 1, epNum: 1 },
      { key: s2Ep1.key, season: 2, epNum: 1 },
      { key: s2Ep2.key, season: 2, epNum: 2 },
    ]);
    await view.unmount();
  });

  it('[Minor #9 + Minor #13d] toggleEpisodeWatched prefers setWatched directly (fallback to saveProgress) and bulk rollback is surgical', async () => {
    const mockWithSet = createReviewCatalog();
    const view1 = await render(wrapProviders(detailEl(mockWithSet.catalog)));
    await waitFor(() => expect(screen.getByTestId('detail-episode-0-watched-toggle')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('detail-episode-0-watched-toggle'), {
      stopPropagation: jest.fn(),
    });
    await waitFor(() => {
      expect(mockWithSet.setWatched).toHaveBeenCalledWith('x:src-1:ep:701:1:1', true);
    });
    expect(mockWithSet.saveProgress).not.toHaveBeenCalled();
    await view1.unmount();

    const mockFallback = createReviewCatalog({ omitSetWatched: true });
    const view2 = await render(wrapProviders(detailEl(mockFallback.catalog)));
    await waitFor(() => expect(screen.getByTestId('detail-episode-0-watched-toggle')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('detail-episode-0-watched-toggle'), {
      stopPropagation: jest.fn(),
    });
    await waitFor(() => {
      expect(mockFallback.saveProgress).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'x:src-1:ep:701:1:1', watched: true }),
      );
    });
    await view2.unmount();

    const s1 = makeEpisodes(1, 1);
    const s2 = makeEpisodes(2, 1);
    const s2Ep = s2[0];
    if (!s2Ep) throw new Error('missing s2Ep');
    const season1FailGate = deferred<ReturnType<typeof err>>();
    const s2ProgGate = deferred<WatchProgressRow[]>();

    const surgicalMock = createReviewCatalog({
      seasons: [
        { season: 1, episodeCount: 1 },
        { season: 2, episodeCount: 1 },
      ],
      episodesBySeason: { 1: s1, 2: s2 },
      setSeasonWatchedImpl: jest.fn(() => season1FailGate.promise as Promise<never>),
      listProgressByKeysImpl: jest.fn(async (keys: readonly string[]) => {
        if (keys.includes(s2Ep.key)) return s2ProgGate.promise;
        return [];
      }),
    });

    const view3 = await render(wrapProviders(detailEl(surgicalMock.catalog)));
    await waitFor(() => expect(screen.getByTestId('detail-episode-0')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('detail-watched'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-apply'));
    await waitFor(() =>
      expect(
        screen.getByTestId('detail-episode-0-watched', { includeHiddenElements: true }),
      ).toBeTruthy(),
    );

    await act(async () => {
      s2ProgGate.resolve([makeProgressRow(s2Ep, true)]);
    });
    await act(async () => {
      season1FailGate.resolve(err(elvError('storage', 'disk-full')));
    });

    await waitFor(() => expect(screen.getByTestId('detail-scope-error')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('detail-scope-picker-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('detail-scope-picker')).toBeNull());
    // Season 1 rolled back to unwatched, while Season 2 progress fetched concurrently is preserved!
    expect(screen.queryByTestId('detail-episode-0-watched')).toBeNull();
    await fireEvent.press(screen.getByTestId('detail-season-2'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
    });
    await view3.unmount();
  });
});
