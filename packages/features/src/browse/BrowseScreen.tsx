import type { BrowseKind, CatalogService, CategoryRow, ItemRow, SourceRow } from '@elv/data';
import type { FocusStore, KeyEvent } from '@elv/focus-core';
import { useFormFactor } from '@elv/ui-kit';
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { BrowseEmptyBox, buildLivePlayTarget, createTwoPaneFocusStore } from './BrowseHelpers';
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
  buildDisplayCategories,
  type DisplayCategory,
  formatItemTitle,
  resolveSelectedCategoryIndex,
  type TabBrowseMemory,
} from './browse-model';
import { createPagedListSource, type PagedListSource } from './paged-list-source';
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
  const [categories, setCategories] = useState<readonly DisplayCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(() => sources.length > 0);

  const selectedCatIdx = resolveSelectedCategoryIndex(categories, memory);
  const activeCategory = categories[selectedCatIdx];
  const activeCategoryId = activeCategory?.row.id;
  const activeItemCount = activeCategory?.row.itemCount ?? 0;
  const safeItemIdx =
    activeItemCount > 0
      ? Math.min(Math.max(0, Math.floor(memory.itemIndex)), activeItemCount - 1)
      : 0;
  const activePane = memory.activePane ?? 'categories';

  const [itemsSource, setItemsSource] = useState<PagedListSource<ItemRow> | null>(null);

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
  const itemsSourceRef = useRef(itemsSource);
  itemsSourceRef.current = itemsSource;
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const readyCountRef = useRef(readySources.length);
  readyCountRef.current = readySources.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken intentionally re-reads SQLite categories
  useEffect(() => {
    if (sources.length === 0) {
      setCategories([]);
      setCategoriesLoading(false);
      return undefined;
    }
    let cancelled = false;
    setCategoriesLoading(true);
    Promise.all(
      sources.map(
        async (source) => [source.id, await catalog.categories(source.id, kind)] as const,
      ),
    ).then(
      (entries) => {
        if (cancelled) return;
        setCategories(
          buildDisplayCategories(sources, new Map<string, readonly CategoryRow[]>(entries)),
        );
        setCategoriesLoading(false);
      },
      () => {
        if (!cancelled) {
          setCategories([]);
          setCategoriesLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, kind, refreshToken, sources]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken invalidates cached SQLite item pages
  useEffect(() => {
    if (activeCategoryId === undefined || activeItemCount <= 0) {
      setItemsSource(null);
      return undefined;
    }
    const next = createPagedListSource<ItemRow>({
      count: activeItemCount,
      pageSize: 200,
      maxPages: 16,
      loadPage: (offset, limit) => catalog.items(activeCategoryId, offset, limit),
    });
    setItemsSource(next);
    return () => {
      next.dispose();
    };
  }, [activeCategoryId, activeItemCount, catalog, refreshToken]);

  useLayoutEffect(() => {
    if (!isTv || memory.seriesDetail !== undefined) return;
    const desired =
      activePane === 'items' && activeItemCount > 0 ? ITEMS_LIST_ID : CATEGORIES_LIST_ID;
    if (!store.isActive(desired)) store.activate(desired);
  }, [activeItemCount, activePane, isTv, memory.seriesDetail, store]);

  const categoriesSource = useMemo(() => createArrayListSource(categories), [categories]);

  const activateItemAt = useCallback(
    (index: number) => {
      const cat =
        categoriesRef.current[
          resolveSelectedCategoryIndex(categoriesRef.current, memoryRef.current)
        ];
      const src = itemsSourceRef.current;
      if (cat === undefined || src === null) return;
      const catIdx = categoriesRef.current.indexOf(cat);

      const handleItem = (item: ItemRow | undefined) => {
        if (item === undefined) return;
        if (kind === 'series') {
          onMemoryChangeRef.current({
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

        onMemoryChangeRef.current({
          categoryId: cat.row.id,
          categoryIndex: catIdx,
          itemIndex: index,
          activePane: 'items',
        });

        if (kind === 'live') {
          onPlay(
            buildLivePlayTarget(catalog, cat.row, item, index, (nextIndex) => {
              onMemoryChangeRef.current({
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

      const cached = src.get(index);
      if (cached !== undefined) handleItem(cached);
      else void src.loadItem(index).then(handleItem);
    },
    [catalog, kind, onPlay],
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

      const curCat = cats[resolveSelectedCategoryIndex(cats, memoryRef.current)];
      const curItemCount = curCat?.row.itemCount ?? 0;

      for (const intent of store.dispatch(event)) {
        if (
          intent.kind === 'edge' &&
          intent.side === 'start' &&
          (event.key === 'up' || event.key === 'channelUp')
        ) {
          onFocusTopNavRef.current?.();
        } else if (intent.kind === 'select') {
          if (intent.listId === CATEGORIES_LIST_ID && curItemCount > 0) {
            store.activate(ITEMS_LIST_ID);
            onMemoryChangeRef.current({ ...memoryRef.current, activePane: 'items' });
          } else if (intent.listId === ITEMS_LIST_ID) {
            activateItemAt(intent.index);
          }
        } else if (intent.kind === 'back') {
          if (store.isActive(ITEMS_LIST_ID)) {
            store.activate(CATEGORIES_LIST_ID);
            onMemoryChangeRef.current({ ...memoryRef.current, activePane: 'categories' });
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
            onMemoryChangeRef.current({ ...memoryRef.current, activePane: 'items' });
          } else if (intent.event.key === 'left' && store.isActive(ITEMS_LIST_ID)) {
            store.activate(CATEGORIES_LIST_ID);
            onMemoryChangeRef.current({ ...memoryRef.current, activePane: 'categories' });
          }
        }
      }
    },
    [activateItemAt, store],
  );

  if (kind === 'series' && memory.seriesDetail !== undefined) {
    return (
      <SeriesDetailPane
        catalog={catalog}
        refreshToken={refreshToken}
        detail={memory.seriesDetail}
        onDetailChange={(nextDetail) =>
          onMemoryChange({ ...memory, seriesDetail: nextDetail, activePane: 'items' })
        }
        onBackToSeries={() => {
          const { seriesDetail: _removed, ...rest } = memory;
          onMemoryChange({ ...rest, activePane: 'items' });
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
          onSelectCategory={(idx) => {
            const nextCat = categories[idx];
            if (nextCat !== undefined) {
              onMemoryChange({
                categoryId: nextCat.row.id,
                categoryIndex: idx,
                itemIndex: 0,
                activePane: 'categories',
              });
            }
          }}
          onActivateCategory={(idx) => {
            const nextCat = categories[idx];
            if (nextCat !== undefined) {
              onMemoryChange({
                categoryId: nextCat.row.id,
                categoryIndex: idx,
                itemIndex: idx === selectedCatIdx ? safeItemIdx : 0,
                activePane: isPhone ? 'items' : 'categories',
              });
            }
          }}
          onBackToCategories={() => onMemoryChange({ ...memory, activePane: 'categories' })}
          onSelectItem={(idx) => {
            if (activeCategory !== undefined) {
              onMemoryChange({
                ...memory,
                categoryId: activeCategory.row.id,
                categoryIndex: selectedCatIdx,
                itemIndex: idx,
                activePane: 'items',
              });
            }
          }}
          onActivateItem={activateItemAt}
        />
      )}
    </View>
  );
}
