import type { CatalogService, FavoriteRow, WatchProgressRow } from '@elv/data';
import { elvError, err } from '@elv/domain';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { DetailTarget } from '../../shared';
import {
  createAndroidSource,
  createMockCatalog,
  KEYCODE_BACK,
  KEYCODE_DPAD_CENTER,
  KEYCODE_DPAD_DOWN,
  KEYCODE_DPAD_RIGHT,
  makeCategory,
  makeItem,
  makeProgress,
  makeSource,
  renderCatalog,
} from './catalog-test-fixtures';

function makeFavorite(itemKey: string, overrides: Partial<FavoriteRow> = {}): FavoriteRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey,
    kind: 'movie',
    title: `Fav ${itemKey}`,
    logo: 'https://img.test/fav.jpg',
    year: 2024,
    rating: 8.4,
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('CatalogDiscoveryScreen — Quick Filter Tabs & Universal Context Menus', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('switches between All, My List, and Watched tabs and updates reactively on removal', async () => {
    const cat0 = makeCategory(0, { name: 'Sci-Fi', itemCount: 2 });
    const item0 = makeItem(0, 0);
    const item1 = makeItem(0, 1);
    const favMovie = makeFavorite('movie:fav-1', { title: 'Favorite Film', kind: 'movie' });
    const favSeries = makeFavorite('series:fav-2', { title: 'Favorite Show', kind: 'series' });

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, [item0, item1]]]),
      progressByKey: new Map([
        [item1.key, makeProgress(item1.key, { title: item1.name, watched: true })],
      ]),
    });

    const setFavorite = jest.fn(async () => ({ ok: true as const, value: false }));
    const setWatched = jest.fn(async () => ({ ok: true as const, value: undefined }));
    const listFavorites = jest.fn(async () => [favMovie, favSeries]);
    const listFavoriteKeys = jest.fn(async () => [favMovie.itemKey, favSeries.itemKey]);
    const catalog = {
      ...baseCatalog,
      listFavorites,
      listFavoriteKeys,
      setFavorite,
      setWatched,
    } as unknown as CatalogService;

    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog({
      catalog,
      sources: [makeSource()],
      onOpenDetail,
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-cat-chip-all')).toBeTruthy();
      expect(screen.getByTestId('catalog-filter-mylist')).toBeTruthy();
      expect(screen.getByTestId('catalog-filter-watched')).toBeTruthy();
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    // Switch to My List -> shows only movie favorites (excludes series)
    await fireEvent.press(screen.getByTestId('catalog-filter-mylist'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-quick-filter-grid-mylist')).toBeTruthy();
      expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy();
    });
    expect(screen.queryByTestId('catalog-quick-filter-item-1')).toBeNull();
    expect(screen.getByText('Favorite Film')).toBeTruthy();

    // Long-press on My List card -> Remove from My List updates view immediately to empty state
    await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-favorite')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-favorite'));

    await waitFor(() => {
      expect(setFavorite).toHaveBeenCalledWith(
        expect.objectContaining({ itemKey: 'movie:fav-1' }),
        false,
      );
      expect(screen.getByTestId('catalog-empty-mylist')).toBeTruthy();
    });

    // Switch to Watched -> shows item1 (watched=true)
    await fireEvent.press(screen.getByTestId('catalog-filter-watched'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-quick-filter-grid-watched')).toBeTruthy();
      expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy();
    });
    expect(screen.getByText(item1.name)).toBeTruthy();

    // Long-press on Watched card -> Mark as unwatched removes it immediately to empty state
    await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-watched'));

    await waitFor(() => {
      expect(setWatched).toHaveBeenCalledWith(item1.key, false);
      expect(screen.getByTestId('catalog-empty-watched')).toBeTruthy();
    });

    // Return to All -> Discovery rails visible again
    await fireEvent.press(screen.getByTestId('catalog-cat-chip-all'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    await view.unmount();
  });

  it('opens Continue Watching context menu to Resume, Remove from Continue Watching, or Mark Watched', async () => {
    const cat0 = makeCategory(0, { name: 'Action', itemCount: 1 });
    const item0 = makeItem(0, 0);
    const cw0: WatchProgressRow = makeProgress('movie:cw-1', {
      kind: 'movie',
      title: 'Dune Drift',
      positionMs: 600_000,
      durationMs: 3_600_000,
    });
    const cw1: WatchProgressRow = makeProgress('movie:cw-2', {
      kind: 'movie',
      title: 'Solar Echo',
      positionMs: 900_000,
      durationMs: 3_600_000,
    });

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, [item0]]]),
      continueWatching: [cw0, cw1],
    });
    const clearProgress = jest.fn(async () => ({ ok: true as const, value: undefined }));
    const setWatched = jest.fn(async () => ({ ok: true as const, value: undefined }));
    const catalog = {
      ...baseCatalog,
      clearProgress,
      setWatched,
    } as unknown as CatalogService;

    const onPlay = jest.fn<void, [PlayTarget]>();
    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog({
      catalog,
      sources: [makeSource()],
      onPlay,
      onOpenDetail,
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-continue-item-0')).toBeTruthy();
      expect(screen.getByTestId('catalog-continue-item-1')).toBeTruthy();
    });

    // Resume via context menu
    await fireEvent(screen.getByTestId('catalog-continue-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-resume')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-resume'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'movie:cw-1',
        startPositionMs: 600_000,
      }),
    );

    // Remove from Continue Watching via context menu -> calls clearProgress and removes card immediately
    await fireEvent(screen.getByTestId('catalog-continue-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-hide-continue')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-hide-continue'));
    expect(clearProgress).toHaveBeenCalledWith('movie:cw-1');
    await waitFor(() => {
      expect(screen.queryByTestId('catalog-continue-item-1')).toBeNull();
    });

    // Mark remaining Continue Watching item as watched -> calls setWatched and removes rail
    await fireEvent(screen.getByTestId('catalog-continue-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-mark-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-mark-watched'));
    expect(setWatched).toHaveBeenCalledWith('movie:cw-2', true);
    await waitFor(() => {
      expect(screen.queryByTestId('catalog-continue-rail')).toBeNull();
    });

    await view.unmount();
  });

  it('opens PosterCard context menu in Category Rail and invokes Play, Details, Favorite, and Watched', async () => {
    const cat0 = makeCategory(0, { name: 'Drama', itemCount: 1 });
    const item0 = makeItem(0, 0);
    const { catalog: baseCatalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, [item0]]]),
    });
    const setFavorite = jest.fn(async () => ({ ok: true as const, value: true }));
    const setWatched = jest.fn(async () => ({ ok: true as const, value: undefined }));
    const catalog = {
      ...baseCatalog,
      listFavoriteKeys: jest.fn(async () => []),
      setFavorite,
      setWatched,
    } as unknown as CatalogService;

    const onPlay = jest.fn<void, [PlayTarget]>();
    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog({
      catalog,
      sources: [makeSource()],
      onPlay,
      onOpenDetail,
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    // Play via context menu
    await fireEvent(screen.getByTestId('catalog-rail-0-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-play')).toBeTruthy();
      expect(screen.getByTestId('context-menu-details')).toBeTruthy();
      expect(screen.getByTestId('context-menu-favorite')).toBeTruthy();
      expect(screen.getByTestId('context-menu-watched')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-play'));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: item0.key }));

    // Add to My List via context menu
    await fireEvent(screen.getByTestId('catalog-rail-0-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-favorite')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-favorite'));
    expect(setFavorite).toHaveBeenCalledWith(expect.objectContaining({ itemKey: item0.key }), true);

    await view.unmount();
  });

  it('uses catalog.listWatched for Watched tab (P0-3) and supports 2D TV D-pad navigation in quick filter grids (P0-4)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const cat0 = makeCategory(0, { name: 'Sci-Fi', itemCount: 1 });
    const item0 = makeItem(0, 0);
    const deepWatched0 = makeProgress('movie:deep-1', {
      kind: 'movie',
      title: 'Archive Classic 1',
      watched: true,
    });
    const deepWatched1 = makeProgress('movie:deep-2', {
      kind: 'movie',
      title: 'Archive Classic 2',
      watched: true,
    });

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, [item0]]]),
    });
    const listWatched = jest.fn(async () => [deepWatched0, deepWatched1]);
    const catalog = {
      ...baseCatalog,
      listWatched,
    } as unknown as CatalogService;

    const { source: androidSource, sendKey } = createAndroidSource();

    const onOpenDetail = jest.fn<void, [DetailTarget]>();
    const view = await renderCatalog(
      {
        catalog,
        sources: [makeSource()],
        onOpenDetail,
      },
      {
        viewport: { width: 1920, height: 1080, formFactor: 'tv' },
        androidSource,
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('catalog-filter-watched')).toBeTruthy();
      expect(
        screen.getByTestId('catalog-tv-focus-anchor-movie', { includeHiddenElements: true }),
      ).toBeTruthy();
    });

    // Navigate catChips: 0 (All) -> 1 (My List) -> 2 (Watched) -> Select
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);

    await waitFor(() => {
      expect(listWatched).toHaveBeenCalledWith(250, undefined, { kind: 'movie' });
      expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy();
      expect(screen.getByTestId('catalog-quick-filter-item-1')).toBeTruthy();
    });

    // D-pad Down enters 2D grid at item 0, Right moves to item 1, Select opens detail
    await sendKey(KEYCODE_DPAD_DOWN);
    await sendKey(KEYCODE_DPAD_RIGHT);
    await sendKey(KEYCODE_DPAD_CENTER);

    expect(onOpenDetail).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'movie:deep-2', title: 'Archive Classic 2' }),
    );

    // Opening ContextMenu suspends CatalogTvKeyBridge on TV (P0-5)
    await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-watched')).toBeTruthy();
      expect(
        screen.queryByTestId('catalog-tv-focus-anchor-movie', { includeHiddenElements: true }),
      ).toBeNull();
    });
    await fireEvent.press(screen.getByTestId('context-menu-backdrop'));
    await waitFor(() => {
      expect(
        screen.getByTestId('catalog-tv-focus-anchor-movie', { includeHiddenElements: true }),
      ).toBeTruthy();
    });

    // Back exits quick filter grid back to All rails
    await sendKey(KEYCODE_BACK);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-rail-0-item-0')).toBeTruthy();
    });

    await view.unmount();
  });

  it('rolls back Continue Watching and My List removals on catalog errors (P1-5)', async () => {
    const cat0 = makeCategory(0, { name: 'Action', itemCount: 1 });
    const item0 = makeItem(0, 0);
    const cw0: WatchProgressRow = makeProgress(item0.key, {
      kind: 'movie',
      title: item0.name,
      positionMs: 600_000,
      durationMs: 3_600_000,
    });
    const fav0 = makeFavorite('movie:fav-fail', { title: 'Sticky Favorite', kind: 'movie' });

    const { catalog: baseCatalog } = createMockCatalog({
      categories: [cat0],
      itemsByCategory: new Map([[cat0.id, [item0]]]),
      continueWatching: [cw0],
    });
    const clearProgress = jest.fn(async () => err(elvError('storage', 'disk-full')));
    const setFavorite = jest.fn(async () => err(elvError('storage', 'disk-full')));
    const catalog = {
      ...baseCatalog,
      clearProgress,
      setFavorite,
      listFavorites: jest.fn(async () => [fav0]),
      listFavoriteKeys: jest.fn(async () => [fav0.itemKey]),
    } as unknown as CatalogService;

    const view = await renderCatalog({
      catalog,
      sources: [makeSource()],
    });

    await waitFor(() => {
      expect(screen.getByTestId('catalog-continue-item-0')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('catalog-continue-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-hide-continue')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-hide-continue'));

    // Item rolls back into Continue Watching after failed clearProgress
    await waitFor(() => {
      expect(clearProgress).toHaveBeenCalledWith(item0.key);
      expect(screen.getByTestId('catalog-continue-item-0')).toBeTruthy();
    });

    // My List removal rollback on failed setFavorite
    await fireEvent.press(screen.getByTestId('catalog-filter-mylist'));
    await waitFor(() => {
      expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy();
    });

    await fireEvent(screen.getByTestId('catalog-quick-filter-item-0'), 'longPress');
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-favorite')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('context-menu-favorite'));

    await waitFor(() => {
      expect(setFavorite).toHaveBeenCalled();
      expect(screen.getByTestId('catalog-quick-filter-item-0')).toBeTruthy();
    });

    await view.unmount();
  });
});
