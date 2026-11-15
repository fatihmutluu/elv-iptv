import type { BrowseKind, CatalogService, ItemRow, SourceRow } from '@elv/data';
import type { FocusStore, KeyEvent } from '@elv/focus-core';
import { useFormFactor } from '@elv/ui-kit';
import { type ReactElement, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import {
  BrowseEmptyBox,
  buildLivePlayTarget,
  createTwoPaneFocusStore,
  syncTwoPaneScopeActive,
  useBrowseCategories,
  useTaggedItemsSource,
} from './BrowseHelpers';
import {
  BROWSE_ROW_HEIGHT_POINTER,
  BROWSE_ROW_HEIGHT_TV,
  BrowseCategoriesAndItems,
  BrowseTvKeyBridge,
  browseStyles,
  CATEGORIES_LIST_ID,
  createArrayListSource,
  ITEMS_LIST_ID,
} from './BrowseParts';
import {
  formatItemTitle,
  resolveSelectedCategoryIndex,
  type TabBrowseMemory,
} from './browse-model';
import { SeriesDetailPane } from './SeriesDetailPane';

/** Props of {@link BrowseScreen}. */
export interface BrowseScreenProps {
  kind: BrowseKind;
  catalog: CatalogService;
  sources: readonly SourceRow[];
  refreshToken: number;
  memory: TabBrowseMemory;
  onMemoryChange: (next: TabBrowseMemory) => void;
  onPlay: (target: PlayTarget) => void;
  onOpenSources: () => void;
  onFocusTopNav?: () => void;
  isActiveScope?: boolean;
}

/**
 * Plain monochrome browse screen for `live`, `movie`, and `series` tabs.
 * Uses an LRU-paged `ListSource<ItemRow>` (`pageSize = 200`, `maxPages = 16`) so 25k–100k+ item
 * categories never materialize full arrays in JS memory, and drills into `SeriesDetailPane` on
 * demand for series seasons and episodes.
 */
export function BrowseScreen({
  kind,
  catalog,
  sources,
  refreshToken,
  memory,
  onMemoryChange,
  onPlay,
  onOpenSources,
  onFocusTopNav,
  isActiveScope = true,
}: BrowseScreenProps): ReactElement {
  const formFactor = useFormFactor();
  const isTv = formFactor === 'tv';
  const isPhone = formFactor === 'phone';
  const rowHeight = isTv ? BROWSE_ROW_HEIGHT_TV : BROWSE_ROW_HEIGHT_POINTER;

  const readySources = useMemo(() => sources.filter((s) => !s.needsImport), [sources]);
  const { categories, loading: categoriesLoading } = useBrowseCategories(
    catalog,
    kind,
    sources,
    refreshToken,
  );

  const selectedCatIdx = resolveSelectedCategoryIndex(categories, memory);
  const activeCategory = categories[selectedCatIdx];
  const activeCategoryId = activeCategory?.row.id;
  const activeItemCount = activeCategory?.row.itemCount ?? 0;
  const safeItemIdx =
    activeItemCount > 0
      ? Math.min(Math.max(0, Math.floor(memory.itemIndex)), activeItemCount - 1)
      : 0;
  const activePane = memory.activePane ?? 'categories';

  const taggedItems = useTaggedItemsSource(
    catalog,
    activeCategoryId,
    activeItemCount,
    refreshToken,
  );
  const itemsSource =
    activeCategoryId !== undefined &&
    activeItemCount > 0 &&
    taggedItems?.categoryId === activeCategoryId &&
    taggedItems.refreshToken === refreshToken
      ? taggedItems.source
      : null;

  const storeRef = useRef<FocusStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createTwoPaneFocusStore(
      `browse-${kind}`,
      CATEGORIES_LIST_ID,
      ITEMS_LIST_ID,
      activePane === 'items' ? ITEMS_LIST_ID : CATEGORIES_LIST_ID,
    );
  }
  const store = storeRef.current;

  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  const onMemoryChangeRef = useRef(onMemoryChange);
  onMemoryChangeRef.current = onMemoryChange;
  const onOpenSourcesRef = useRef(onOpenSources);
  onOpenSourcesRef.current = onOpenSources;
  const onFocusTopNavRef = useRef(onFocusTopNav);
  onFocusTopNavRef.current = onFocusTopNav;
  const taggedItemsRef = useRef(taggedItems);
  taggedItemsRef.current = taggedItems;
  const refreshTokenRef = useRef(refreshToken);
  refreshTokenRef.current = refreshToken;
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const readyCountRef = useRef(readySources.length);
  readyCountRef.current = readySources.length;

  const commitMemory = useCallback((next: TabBrowseMemory) => {
    memoryRef.current = next;
    onMemoryChangeRef.current(next);
  }, []);

  useLayoutEffect(() => {
    if (!isTv || memory.seriesDetail !== undefined) return;
    if (itemsSource === null || activeItemCount <= 0) {
      store.setCount(ITEMS_LIST_ID, 0);
    }
    const desired =
      activePane === 'items' && activeItemCount > 0 && itemsSource !== null
        ? ITEMS_LIST_ID
        : CATEGORIES_LIST_ID;
    syncTwoPaneScopeActive(store, isActiveScope, desired);
  }, [activeItemCount, activePane, isActiveScope, isTv, itemsSource, memory.seriesDetail, store]);

  const categoriesSource = useMemo(() => createArrayListSource(categories), [categories]);

  const activateItemAt = useCallback(
    (index: number) => {
      const cat =
        categoriesRef.current[
          resolveSelectedCategoryIndex(categoriesRef.current, memoryRef.current)
        ];
      const tagged = taggedItemsRef.current;
      if (
        cat === undefined ||
        tagged === null ||
        tagged.categoryId !== cat.row.id ||
        tagged.refreshToken !== refreshTokenRef.current
      ) {
        return;
      }
      const catIdx = categoriesRef.current.indexOf(cat);

      const handleItem = (item: ItemRow | undefined) => {
        if (item === undefined) return;
        if (kind === 'series') {
          commitMemory({
            categoryId: cat.row.id,
            categoryIndex: catIdx,
            itemIndex: index,
            activePane: 'items',
            seriesDetail: {
              series: item,
              selectedSeasonIndex: 0,
              selectedEpisodeIndex: 0,
              activePane: 'seasons',
            },
          });
          return;
        }

        commitMemory({
          categoryId: cat.row.id,
          categoryIndex: catIdx,
          itemIndex: index,
          activePane: 'items',
        });

        if (kind === 'live') {
          onPlay(
            buildLivePlayTarget(catalog, cat.row, item, index, (nextIndex) => {
              commitMemory({
                ...memoryRef.current,
                categoryId: cat.row.id,
                categoryIndex: catIdx,
                itemIndex: nextIndex,
                activePane: 'items',
              });
            }),
          );
          return;
        }

        onPlay({
          itemKey: item.key,
          sourceId: item.sourceId,
          title: formatItemTitle(item),
          kind: 'vod',
        });
      };

      const cached = tagged.source.get(index);
      if (cached !== undefined) handleItem(cached);
      else void tagged.source.loadItem(index).then(handleItem);
    },
    [catalog, commitMemory, kind, onPlay],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent) => {
      const cats = categoriesRef.current;
      if (cats.length === 0) {
        if (event.kind === 'press' && event.key === 'select' && readyCountRef.current === 0) {
          onOpenSourcesRef.current();
        } else if (event.kind === 'press' && (event.key === 'back' || event.key === 'up')) {
          onFocusTopNavRef.current?.();
        }
        return;
      }

      for (const intent of store.dispatch(event)) {
        const curCat = cats[resolveSelectedCategoryIndex(cats, memoryRef.current)];
        const curItemCount = curCat?.row.itemCount ?? 0;

        if (
          intent.kind === 'edge' &&
          intent.side === 'start' &&
          (event.key === 'up' || event.key === 'channelUp')
        ) {
          onFocusTopNavRef.current?.();
        } else if (intent.kind === 'select') {
          if (intent.listId === CATEGORIES_LIST_ID && curItemCount > 0) {
            store.activate(ITEMS_LIST_ID);
            commitMemory({ ...memoryRef.current, activePane: 'items' });
          } else if (intent.listId === ITEMS_LIST_ID) {
            activateItemAt(intent.index);
          }
        } else if (intent.kind === 'back') {
          if (store.isActive(ITEMS_LIST_ID) || memoryRef.current.activePane === 'items') {
            store.activate(CATEGORIES_LIST_ID);
            commitMemory({ ...memoryRef.current, activePane: 'categories' });
          } else {
            onFocusTopNavRef.current?.();
          }
        } else if (intent.kind === 'key' && intent.event.kind === 'press') {
          if (
            intent.event.key === 'right' &&
            store.isActive(CATEGORIES_LIST_ID) &&
            curItemCount > 0
          ) {
            store.activate(ITEMS_LIST_ID);
            commitMemory({ ...memoryRef.current, activePane: 'items' });
          } else if (intent.event.key === 'left' && store.isActive(ITEMS_LIST_ID)) {
            store.activate(CATEGORIES_LIST_ID);
            commitMemory({ ...memoryRef.current, activePane: 'categories' });
          }
        }
      }
    },
    [activateItemAt, commitMemory, store],
  );

  const handleSelectCategory = useCallback(
    (idx: number) => {
      const nextCat = categoriesRef.current[idx];
      if (nextCat === undefined) return;
      if (nextCat.row.id !== memoryRef.current.categoryId) {
        store.setCount(ITEMS_LIST_ID, 0);
      }
      commitMemory({
        categoryId: nextCat.row.id,
        categoryIndex: idx,
        itemIndex: 0,
        activePane: 'categories',
      });
    },
    [commitMemory, store],
  );

  const handleActivateCategory = useCallback(
    (idx: number) => {
      const nextCat = categoriesRef.current[idx];
      if (nextCat === undefined) return;
      const curIdx = resolveSelectedCategoryIndex(categoriesRef.current, memoryRef.current);
      const curItemCount = categoriesRef.current[curIdx]?.row.itemCount ?? 0;
      const curSafeItem =
        curItemCount > 0
          ? Math.min(Math.max(0, Math.floor(memoryRef.current.itemIndex)), curItemCount - 1)
          : 0;
      commitMemory({
        categoryId: nextCat.row.id,
        categoryIndex: idx,
        itemIndex: idx === curIdx ? curSafeItem : 0,
        activePane: isPhone ? 'items' : 'categories',
      });
    },
    [commitMemory, isPhone],
  );

  const handleBackToCategories = useCallback(() => {
    commitMemory({ ...memoryRef.current, activePane: 'categories' });
  }, [commitMemory]);

  const handleSelectItem = useCallback(
    (idx: number) => {
      const catIdx = resolveSelectedCategoryIndex(categoriesRef.current, memoryRef.current);
      const curCat = categoriesRef.current[catIdx];
      if (curCat === undefined) return;
      commitMemory({
        ...memoryRef.current,
        categoryId: curCat.row.id,
        categoryIndex: catIdx,
        itemIndex: idx,
        activePane: 'items',
      });
    },
    [commitMemory],
  );

  if (kind === 'series' && memory.seriesDetail !== undefined) {
    return (
      <SeriesDetailPane
        catalog={catalog}
        refreshToken={refreshToken}
        detail={memory.seriesDetail}
        onDetailChange={(nextDetail) =>
          commitMemory({ ...memoryRef.current, seriesDetail: nextDetail, activePane: 'items' })
        }
        onBackToSeries={() => {
          const { seriesDetail: _removed, ...rest } = memoryRef.current;
          commitMemory({ ...rest, activePane: 'items' });
        }}
        onPlay={onPlay}
        {...(onFocusTopNav !== undefined ? { onFocusTopNav } : {})}
        isActiveScope={isActiveScope}
      />
    );
  }

  return (
    <View
      testID={`browse-screen-${kind}`}
      style={[browseStyles.root, isTv ? browseStyles.rootTv : browseStyles.rootPointer]}
    >
      {isTv && isActiveScope ? <BrowseTvKeyBridge onEvent={handleTvKey} /> : null}
      {categoriesLoading || categories.length === 0 ? (
        <BrowseEmptyBox
          isTv={isTv}
          isActiveScope={isActiveScope}
          loading={categoriesLoading}
          noReadySources={readySources.length === 0}
          onOpenSources={onOpenSources}
        />
      ) : (
        <BrowseCategoriesAndItems
          isTv={isTv}
          isPhone={isPhone}
          rowHeight={rowHeight}
          store={store}
          categoriesSource={categoriesSource}
          itemsSource={itemsSource}
          activeCategory={activeCategory}
          activeItemCount={activeItemCount}
          selectedCatIdx={selectedCatIdx}
          safeItemIdx={safeItemIdx}
          activePane={activePane}
          onSelectCategory={handleSelectCategory}
          onActivateCategory={handleActivateCategory}
          onBackToCategories={handleBackToCategories}
          onSelectItem={handleSelectItem}
          onActivateItem={activateItemAt}
        />
      )}
    </View>
  );
}
