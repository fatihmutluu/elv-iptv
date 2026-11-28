import type {
  CatalogService,
  EpisodeRow,
  ItemDetailRow,
  SeasonRow,
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
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import {
  CatalogUiCacheProvider,
  createCatalogUiCache,
  type DetailTarget,
  DownloadsProvider,
} from '../../shared';
import { DetailScreen } from '../DetailScreen';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

const SERIES_TARGET: DetailTarget = {
  itemKey: 'x:src-1:series:401',
  sourceId: 'src-1',
  kind: 'series',
  title: 'Endless Chronicle',
  posterUri: 'https://img.invalid/poster.jpg',
  backdropUri: 'https://img.invalid/backdrop.jpg',
  year: 2025,
  rating: 9.1,
  catalogId: 401,
  categoryId: 'src-1|series|20',
};

const SERIES_DETAIL: ItemDetailRow = {
  id: 401,
  key: SERIES_TARGET.itemKey,
  sourceId: 'src-1',
  providerId: '401',
  kind: 'series',
  name: 'Endless Chronicle',
  logo: SERIES_TARGET.posterUri,
  rating: 9.1,
  year: 2025,
  num: null,
  plot: 'Long running sci-fi anthology across deep horizons.',
};

function makeEpisodes(season: number, count: number, prefix = 'Chapter'): EpisodeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: season * 1000 + i + 1,
    key: `x:src-1:ep:401:${season}:${i + 1}`,
    season,
    episode: i + 1,
    title: `${prefix} ${i + 1}`,
    durationSec: 2700,
  }));
}

interface SeriesCatalogMockOptions {
  readonly seasons?: readonly SeasonRow[];
  readonly episodesBySeason?: Readonly<Record<number, readonly EpisodeRow[]>>;
  readonly initialProgress?: readonly WatchProgressRow[];
  readonly failSaveProgress?: boolean;
  readonly failSetWatched?: boolean;
  readonly failSetSeasonWatched?: boolean;
  readonly failSetSeriesWatched?: boolean;
}

function createSeriesCatalogMock(opts: SeriesCatalogMockOptions = {}) {
  const seasons = opts.seasons ?? [
    { season: 1, episodeCount: 3 },
    { season: 2, episodeCount: 2 },
  ];
  const episodesBySeason: Record<number, readonly EpisodeRow[]> = opts.episodesBySeason ?? {
    1: makeEpisodes(1, 3, 'Pilot'),
    2: makeEpisodes(2, 2, 'Arc'),
  };
  const progressMap = new Map<string, WatchProgressRow>();
  for (const row of opts.initialProgress ?? []) {
    progressMap.set(row.itemKey, row);
  }

  const episodesMock = jest.fn(async (_seriesId: number, season: number) => [
    ...(episodesBySeason[season] ?? []),
  ]);
  const saveProgress = jest.fn(
    async (input: {
      sourceId: string;
      itemKey: string;
      kind: 'movie' | 'episode';
      title: string;
      logo?: string | null;
      seriesKey?: string | null;
      season?: number | null;
      episode?: number | null;
      positionMs: number;
      durationMs: number;
      watched?: boolean;
    }) => {
      if (opts.failSaveProgress) return err(elvError('storage', 'disk-full'));
      const row: WatchProgressRow = {
        profileId: 'default',
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        subtitle: null,
        logo: input.logo ?? null,
        seriesKey: input.seriesKey ?? null,
        season: input.season ?? null,
        episode: input.episode ?? null,
        positionMs: input.positionMs,
        durationMs: input.durationMs,
        watched: input.watched ?? false,
        updatedAt: Date.now(),
      };
      progressMap.set(row.itemKey, row);
      return ok(row);
    },
  );
  const setWatched = jest.fn(async (itemKey: string, watched: boolean) => {
    if (opts.failSetWatched) return err(elvError('storage', 'disk-full'));
    const cur = progressMap.get(itemKey);
    if (cur)
      progressMap.set(itemKey, { ...cur, watched, positionMs: watched ? cur.durationMs : 0 });
    return ok(undefined);
  });
  const setSeasonWatched = jest.fn(async (_seriesKey: string, season: number, watched: boolean) => {
    if (opts.failSetSeasonWatched) return err(elvError('storage', 'disk-full'));
    const eps = episodesBySeason[season] ?? [];
    for (const ep of eps) {
      progressMap.set(ep.key, {
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: ep.key,
        kind: 'episode',
        title: ep.title ?? '',
        subtitle: null,
        logo: null,
        seriesKey: SERIES_TARGET.itemKey,
        season,
        episode: ep.episode,
        positionMs: watched ? 2_700_000 : 0,
        durationMs: 2_700_000,
        watched,
        updatedAt: Date.now(),
      });
    }
    return ok(eps.length);
  });
  const setSeriesWatched = jest.fn(async (_seriesKey: string, watched: boolean) => {
    if (opts.failSetSeriesWatched) return err(elvError('storage', 'disk-full'));
    let count = 0;
    for (const [sNum, eps] of Object.entries(episodesBySeason)) {
      for (const ep of eps) {
        count += 1;
        progressMap.set(ep.key, {
          profileId: 'default',
          sourceId: 'src-1',
          itemKey: ep.key,
          kind: 'episode',
          title: ep.title ?? '',
          subtitle: null,
          logo: null,
          seriesKey: SERIES_TARGET.itemKey,
          season: Number(sNum),
          episode: ep.episode,
          positionMs: watched ? 2_700_000 : 0,
          durationMs: 2_700_000,
          watched,
          updatedAt: Date.now(),
        });
      }
    }
    return ok(count);
  });

  const catalog = {
    listSources: jest.fn(async () => []),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    itemDetail: jest.fn(async () => SERIES_DETAIL),
    seasons: jest.fn(async () => ok(seasons)),
    episodes: episodesMock,
    resolveStream: jest.fn(async (key: string) =>
      ok({ url: `http://sim.example.test/${encodeURIComponent(key)}.mp4`, headers: {} }),
    ),
    listFavoriteKeys: jest.fn(async () => []),
    listProgressByKeys: jest.fn(async (keys: readonly string[]) =>
      keys.map((k) => progressMap.get(k)).filter((r): r is WatchProgressRow => r !== undefined),
    ),
    getProgress: jest.fn(async (k: string) => progressMap.get(k) ?? null),
    setFavorite: jest.fn(async (_input: unknown, active: boolean) => ok(active)),
    saveProgress,
    setWatched,
    setSeasonWatched,
    setSeriesWatched,
    getRating: jest.fn(async () => null),
    setRating: jest.fn(async (_input: unknown, next: unknown) => ok(next)),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;

  return {
    catalog,
    episodesMock,
    saveProgress,
    setWatched,
    setSeasonWatched,
    setSeriesWatched,
  };
}

function createFakeDownloadManager(
  initial: readonly DownloadRecord[] = [],
  opts: { readonly withBatch?: boolean } = {},
) {
  let records = [...initial];
  const listeners = new Set<(next: readonly DownloadRecord[]) => void>();
  const emit = () => {
    for (const l of listeners) l([...records]);
  };
  const makeRec = (input: DownloadEnqueueInput): DownloadRecord => ({
    id: `dl-${input.itemKey}`,
    profileId: input.profileId ?? 'default',
    sourceId: input.sourceId,
    itemKey: input.itemKey,
    kind: input.kind,
    title: input.title,
    ...(input.seriesKey !== undefined ? { seriesKey: input.seriesKey } : {}),
    ...(input.seriesTitle !== undefined ? { seriesTitle: input.seriesTitle } : {}),
    ...(input.season !== undefined ? { season: input.season } : {}),
    ...(input.episodeNum !== undefined ? { episodeNum: input.episodeNum } : {}),
    ...(input.poster !== undefined ? { poster: input.poster } : {}),
    localFileName: `${input.itemKey.replace(/[^a-z0-9]/gi, '_')}.mp4`,
    localUri: null,
    bytesDownloaded: 0,
    totalBytes: 1000,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const enqueue = jest.fn(async (input: DownloadEnqueueInput) => {
    const rec = makeRec(input);
    records = [...records.filter((r) => r.itemKey !== rec.itemKey), rec];
    emit();
    return ok(rec);
  });
  const enqueueBatch = jest.fn(async (inputs: readonly DownloadEnqueueInput[]) => {
    const added = inputs.map(makeRec);
    const addedKeys = new Set(added.map((r) => r.itemKey));
    records = [...records.filter((r) => !addedKeys.has(r.itemKey)), ...added];
    emit();
    return ok<readonly DownloadRecord[]>(added);
  });

  const manager: DownloadManagerPort = {
    supported: true,
    list: jest.fn(async () => [...records]),
    get: jest.fn(async (k: string) => records.find((r) => r.itemKey === k) ?? null),
    enqueue,
    ...(opts.withBatch ? { enqueueBatch } : {}),
    pause: jest.fn(async () => ok(undefined)),
    resume: jest.fn(async () => ok(undefined)),
    cancel: jest.fn(async () => ok(undefined)),
    remove: jest.fn(async () => ok(undefined)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { manager, enqueue, enqueueBatch, getRecords: () => records };
}

function renderSeriesDetail(
  props: {
    catalog: CatalogService;
    downloadManager?: DownloadManagerPort;
    onPlay?: (target: PlayTarget) => void;
    onBack?: () => void;
  },
  opts: {
    viewport?: ViewportOverride;
    androidSource?: AndroidKeySource;
  } = {},
) {
  const uiCache = createCatalogUiCache({ locale: 'en' });
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
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <CatalogUiCacheProvider cache={uiCache}>
            <DownloadsProvider manager={props.downloadManager} catalog={props.catalog}>
              <DetailScreen
                target={SERIES_TARGET}
                catalog={props.catalog}
                refreshToken={1}
                onBack={props.onBack ?? jest.fn()}
                onPlay={props.onPlay ?? jest.fn()}
                onOpenDetail={jest.fn()}
                isActiveScope={true}
              />
            </DownloadsProvider>
          </CatalogUiCacheProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  return render(
    opts.androidSource ? (
      <RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>
    ) : (
      content
    ),
  );
}

describe('Wave Q3 Series Detail UX Overhaul', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders 100+ episodes in a single virtualized FlatList with zero 30-episode chunk bar and deterministic getItemLayout', async () => {
    const s1 = makeEpisodes(1, 100, 'Chapter');
    const s2 = makeEpisodes(2, 12, 'Arc');
    const mock = createSeriesCatalogMock({
      seasons: [
        { season: 1, episodeCount: 100 },
        { season: 2, episodeCount: 12 },
      ],
      episodesBySeason: { 1: s1, 2: s2 },
    });
    const onPlay = jest.fn();

    const view = await renderSeriesDetail({ catalog: mock.catalog, onPlay });

    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0')).toHaveTextContent(/Chapter 1/);
    });

    // Zero 30-episode grouping chunk bar anywhere
    expect(screen.queryByTestId('detail-episode-chunks-bar')).toBeNull();
    expect(screen.queryByTestId('detail-episode-chunk-0')).toBeNull();

    // Outer container is a single virtualized FlatList holding all 100 episodes with virtualization tuned
    const listNode = screen.getByTestId('detail-scroll');
    expect(listNode.props.data).toHaveLength(100);
    expect(listNode.props.windowSize).toBe(7);
    expect(listNode.props.initialNumToRender).toBe(12);
    expect(listNode.props.maxToRenderPerBatch).toBe(12);
    expect(typeof listNode.props.keyExtractor).toBe('function');
    expect(typeof listNode.props.getItemLayout).toBe('function');
    expect(typeof listNode.props.onScrollToIndexFailed).toBe('function');

    const layout0 = listNode.props.getItemLayout(s1, 0);
    const layout50 = listNode.props.getItemLayout(s1, 50);
    expect(layout0.offset).toBe(0);
    expect(layout0.length).toBeGreaterThan(80);
    expect(layout50.offset).toBe(layout0.length * 50);
    expect(layout50.index).toBe(50);

    // Playing Episode 1 queues subsequent episodes seamlessly (capped at 50)
    await fireEvent.press(screen.getByTestId('detail-episode-0'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    const played = onPlay.mock.calls[0]?.[0] as PlayTarget | undefined;
    expect(played?.episode).toBe(1);
    expect(played?.nextEpisodes).toHaveLength(50);

    await view.unmount();
  });

  it('toggles per-episode watched optimistically via circular IconButton without starting playback and rolls back on failure', async () => {
    const mock = createSeriesCatalogMock();
    const onPlay = jest.fn();

    const view = await renderSeriesDetail({ catalog: mock.catalog, onPlay });

    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched-toggle')).toBeTruthy();
    });

    const stopPropagation = jest.fn();
    await fireEvent.press(screen.getByTestId('detail-episode-0-watched-toggle'), {
      stopPropagation,
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
      expect(
        screen.getByTestId('detail-episode-0-watched-toggle').props.accessibilityState?.selected,
      ).toBe(true);
    });
    expect(mock.setWatched).toHaveBeenCalledWith('x:src-1:ep:401:1:1', true);

    // Toggle back to unwatched calls setWatched(key, false)
    await fireEvent.press(screen.getByTestId('detail-episode-0-watched-toggle'), {
      stopPropagation: jest.fn(),
    });
    await waitFor(() => {
      expect(screen.queryByTestId('detail-episode-0-watched')).toBeNull();
    });
    expect(mock.setWatched).toHaveBeenCalledWith('x:src-1:ep:401:1:1', false);

    await view.unmount();

    // Verify rollback when persistence fails
    const flaky = createSeriesCatalogMock({ failSetWatched: true });
    const flakyView = await renderSeriesDetail({ catalog: flaky.catalog });
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched-toggle')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('detail-episode-0-watched-toggle'), {
      stopPropagation: jest.fn(),
    });
    await waitFor(() => {
      expect(screen.queryByTestId('detail-episode-0-watched')).toBeNull();
    });
    await flakyView.unmount();
  });

  it('supports TV D-pad horizontal sub-slots (play -> watched -> download) on episode rows and resets on vertical move', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const mock = createSeriesCatalogMock();
    const dl = createFakeDownloadManager();
    const onPlay = jest.fn();

    const view = await renderSeriesDetail(
      { catalog: mock.catalog, downloadManager: dl.manager, onPlay },
      {
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        },
        androidSource,
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0-watched-toggle')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0-download')).toBeTruthy();
    });

    // hero-play -> Down -> seasons -> Down -> episodes[0] ('play')
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('detail-episode-0-focus-ring')).toBeTruthy();

    // Right -> 'watched' sub-slot on Episode 0 -> Select toggles watched WITHOUT playing!
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.queryByTestId('detail-episode-0-focus-ring')).toBeNull();
    expect(screen.getByTestId('detail-episode-0-watched-toggle-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
    });
    expect(onPlay).not.toHaveBeenCalled();

    // Right -> 'download' sub-slot on Episode 0 -> Select enqueues episode with seriesKey!
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('detail-episode-0-download-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(dl.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: 'x:src-1:ep:401:1:1',
          seriesKey: SERIES_TARGET.itemKey,
          kind: 'episode',
        }),
      );
    });

    // Left -> back to 'watched'; Down -> Episode 1 resets focus sub-slot back to 'play'!
    await pressKey(KEYCODE_DPAD_LEFT);
    expect(screen.getByTestId('detail-episode-0-watched-toggle-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_DOWN);
    expect(screen.getByTestId('detail-episode-1-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'x:src-1:ep:401:1:2' }));

    await view.unmount();
  });

  it('opens shared TV-safe DetailScopePicker for Series Hero Watched (Entire Series & Season dropdown) and updates episodes immediately', async () => {
    const mock = createSeriesCatalogMock();
    const view = await renderSeriesDetail({ catalog: mock.catalog });

    await waitFor(() => {
      expect(screen.getByTestId('detail-watched')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
    });

    // Open Scope Picker via Series Hero ✓
    await fireEvent.press(screen.getByTestId('detail-watched'));
    expect(screen.getByTestId('detail-scope-picker')).toBeTruthy();
    expect(screen.getByTestId('detail-scope-entire-series')).toBeTruthy();
    expect(screen.getByTestId('detail-scope-season-select')).toBeTruthy();
    expect(screen.getByTestId('detail-scope-season-apply')).toBeTruthy();
    // Strictly zero React Native <Modal>
    expect(JSON.stringify(view.toJSON())).not.toContain('"type":"Modal"');

    // Expand Season dropdown -> choose Season 2 -> apply
    await fireEvent.press(screen.getByTestId('detail-scope-season-select'));
    expect(screen.getByTestId('detail-scope-season-option-1')).toBeTruthy();
    expect(screen.getByTestId('detail-scope-season-option-2')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('detail-scope-season-option-2'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-apply'));

    await waitFor(() => {
      expect(mock.setSeasonWatched).toHaveBeenCalledWith(SERIES_TARGET.itemKey, 2, true);
      expect(screen.queryByTestId('detail-scope-picker')).toBeNull();
    });

    // Open Scope Picker again -> choose Entire Series -> marks all episodes watched immediately
    await fireEvent.press(screen.getByTestId('detail-watched'));
    await fireEvent.press(screen.getByTestId('detail-scope-entire-series'));

    await waitFor(() => {
      expect(mock.setSeriesWatched).toHaveBeenCalledWith(SERIES_TARGET.itemKey, true);
      expect(screen.getByTestId('detail-episode-0-watched')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-1-watched')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-2-watched')).toBeTruthy();
      expect(screen.getByTestId('detail-watched').props.accessibilityState?.selected).toBe(true);
    });

    await view.unmount();
  });

  it('opens DetailScopePicker for Series Hero Download, bulk-enqueues season or entire series with seriesKey skipping already-downloaded episodes', async () => {
    const s1 = makeEpisodes(1, 3, 'Pilot');
    const s2 = makeEpisodes(2, 2, 'Arc');
    const mock = createSeriesCatalogMock({
      seasons: [
        { season: 1, episodeCount: 3 },
        { season: 2, episodeCount: 2 },
      ],
      episodesBySeason: { 1: s1, 2: s2 },
    });
    const firstS1 = s1[0];
    const secondS1 = s1[1];
    const thirdS1 = s1[2];
    const firstS2 = s2[0];
    const secondS2 = s2[1];
    if (!firstS1 || !secondS1 || !thirdS1 || !firstS2 || !secondS2) {
      throw new Error('missing episode fixtures');
    }
    const alreadyDownloaded: DownloadRecord = {
      id: 'dl-existing',
      profileId: 'default',
      sourceId: 'src-1',
      itemKey: firstS1.key,
      kind: 'episode',
      title: 'Pilot 1',
      seriesKey: SERIES_TARGET.itemKey,
      seriesTitle: 'Endless Chronicle',
      season: 1,
      episodeNum: 1,
      poster: SERIES_TARGET.posterUri,
      localFileName: 'pilot1.mp4',
      localUri: 'file:///downloads/pilot1.mp4',
      bytesDownloaded: 1000,
      totalBytes: 1000,
      status: 'completed',
      createdAt: 1000,
      updatedAt: 1000,
      completedAt: 1000,
    };
    const dl = createFakeDownloadManager([alreadyDownloaded], { withBatch: true });

    const view = await renderSeriesDetail({ catalog: mock.catalog, downloadManager: dl.manager });

    await waitFor(() => {
      expect(screen.getByTestId('detail-download')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
    });

    // Already has 1 completed episode -> Hero download button reflects active/completed status
    expect(screen.getByTestId('detail-download').props.accessibilityState?.selected).toBe(true);

    // Open download scope picker -> Season 2 bulk download calls enqueueBatch with Season 2 episodes!
    await fireEvent.press(screen.getByTestId('detail-download'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-select'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-option-2'));
    await fireEvent.press(screen.getByTestId('detail-scope-season-apply'));

    await waitFor(() => {
      expect(dl.enqueueBatch).toHaveBeenCalledTimes(1);
    });
    const season2Batch = dl.enqueueBatch.mock.calls[0]?.[0] ?? [];
    expect(season2Batch.map((i) => i.itemKey)).toEqual([firstS2.key, secondS2.key]);
    for (const item of season2Batch) {
      expect(item).toMatchObject({
        seriesKey: SERIES_TARGET.itemKey,
        seriesTitle: 'Endless Chronicle',
        kind: 'episode',
        poster: SERIES_TARGET.posterUri,
      });
    }

    // Re-open download scope picker -> Entire Series -> skips s1[0] (completed) and s2[0..1] (queued), enqueues ONLY s1[1..2]!
    await fireEvent.press(screen.getByTestId('detail-download'));
    expect(screen.getByTestId('detail-scope-picker')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('detail-scope-entire-series'));

    await waitFor(() => {
      expect(dl.enqueueBatch).toHaveBeenCalledTimes(2);
    });
    const entireRemainder = dl.enqueueBatch.mock.calls[1]?.[0] ?? [];
    expect(entireRemainder.map((i) => i.itemKey)).toEqual([secondS1.key, thirdS1.key]);

    await view.unmount();
  });

  it('navigates DetailScopePicker cleanly via 10-ft TV D-pad and Back closes picker without popping DetailScreen', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const mock = createSeriesCatalogMock();
    const onBack = jest.fn();

    const view = await renderSeriesDetail(
      { catalog: mock.catalog, onBack },
      {
        viewport: {
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        },
        androidSource,
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-watched')).toBeTruthy();
      expect(screen.getByTestId('detail-episode-0')).toBeTruthy();
    });

    // hero-play -> Up (mylist) -> Right (like) -> Right (dislike) -> Right (watched) -> Select opens Scope Picker!
    await pressKey(KEYCODE_DPAD_UP);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('detail-watched-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_CENTER);

    expect(screen.getByTestId('detail-scope-picker')).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).not.toContain('"type":"Modal"');

    // Back closes Scope Picker WITHOUT calling DetailScreen onBack
    await pressKey(KEYCODE_BACK);
    expect(screen.queryByTestId('detail-scope-picker')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    // Re-open -> Down (season-select) -> Select (opens dropdown) -> Down (Season 2) -> Select (picks Season 2) -> Select (applies!)
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('detail-scope-picker')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('detail-scope-season-option-2')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_DOWN);
    await pressKey(KEYCODE_DPAD_CENTER);
    await pressKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(mock.setSeasonWatched).toHaveBeenCalledWith(SERIES_TARGET.itemKey, 2, true);
      expect(screen.queryByTestId('detail-scope-picker')).toBeNull();
    });

    await view.unmount();
  });
});
