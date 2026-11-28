import type {
  CatalogService,
  ElvTitleRecord,
  ItemDetailRow,
  ItemRow,
  RatingValue,
} from '@elv/data';
import type { PosterCardHoverRect } from '@elv/ui-kit';
import { useI18n, useViewport } from '@elv/ui-kit';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';
import {
  createHoverMetadataCache,
  HOVER_PREVIEW_CLOSE_DELAY_MS,
  HOVER_PREVIEW_OPEN_DELAY_MS,
  type HoverPreviewHydratedMetadata,
  type HoverPreviewRect,
  mergeHoverPreviewMetadata,
  type PosterHoverPreviewEntry,
} from './poster-hover-preview-model';
import type { CatalogRecommendationDismissalMethods } from './useCardQuickActionsState';

/** Active Desktop hover preview state consumed by {@link PosterHoverPreviewHost}. */
export interface ActivePosterHoverPreview {
  readonly entry: PosterHoverPreviewEntry;
  readonly anchorRect: HoverPreviewRect;
  readonly cardWidth?: number;
  readonly hydration: HoverPreviewHydratedMetadata;
  readonly metadataSettled: boolean;
  readonly isFavorite: boolean;
  readonly isWatched: boolean;
  readonly userRating: RatingValue | null;
}

/** Stable control handle returned by {@link usePosterHoverPreview}. */
export interface PosterHoverPreviewControls {
  readonly scheduleOpen: (
    entry: PosterHoverPreviewEntry,
    anchorRect: HoverPreviewRect,
    cardWidth?: number,
  ) => void;
  readonly scheduleClose: (itemKey: string) => void;
  readonly dismissNow: () => void;
}

interface PosterHoverPreviewInternalActions {
  readonly onPreviewPointerEnter: () => void;
  readonly onPreviewPointerLeave: () => void;
  readonly toggleFavorite: () => void;
  readonly toggleWatched: () => void;
  readonly toggleRating: (next: RatingValue) => void;
  readonly dismissRecommendation: () => void;
}

/** Props of {@link PosterHoverPreviewProvider}. */
export interface PosterHoverPreviewProviderProps {
  readonly catalog: CatalogService;
  readonly catalogRevision: number;
  readonly elvEnrichActive?: boolean;
  readonly disabled?: boolean;
  /** Changing this key immediately dismisses any open hover preview (e.g., tab/detail/overlay change). */
  readonly dismissKey?: string | number;
  readonly onUserStateMutated?: () => void;
  readonly children: ReactNode;
}

interface WebWindowLike {
  addEventListener?: (
    type: string,
    listener: (event?: unknown) => void,
    options?: boolean | { passive?: boolean },
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event?: unknown) => void,
    options?: boolean | { passive?: boolean },
  ) => void;
}

const NOOP_CONTROLS: PosterHoverPreviewControls = {
  scheduleOpen: () => undefined,
  scheduleClose: () => undefined,
  dismissNow: () => undefined,
};

const NOOP_INTERNAL_ACTIONS: PosterHoverPreviewInternalActions = {
  onPreviewPointerEnter: () => undefined,
  onPreviewPointerLeave: () => undefined,
  toggleFavorite: () => undefined,
  toggleWatched: () => undefined,
  toggleRating: () => undefined,
  dismissRecommendation: () => undefined,
};

const PosterHoverPreviewControlContext = createContext<PosterHoverPreviewControls>(NOOP_CONTROLS);
const PosterHoverPreviewStateContext = createContext<ActivePosterHoverPreview | null>(null);
const PosterHoverPreviewInternalContext =
  createContext<PosterHoverPreviewInternalActions>(NOOP_INTERNAL_ACTIONS);

/**
 * Provides Desktop pointer-only expanded card hover preview state, dwell/grace timers, cached
 * metadata hydration, and global scroll/Escape auto-dismissal. Strict no-op on TV & Touch.
 */
export function PosterHoverPreviewProvider({
  catalog,
  catalogRevision,
  elvEnrichActive = false,
  disabled = false,
  dismissKey,
  onUserStateMutated,
  children,
}: PosterHoverPreviewProviderProps): ReactElement {
  const viewport = useViewport();
  const i18n = useI18n();

  const activeEnabled =
    !disabled &&
    Platform.OS === 'web' &&
    viewport.formFactor === 'desktop' &&
    viewport.inputModality !== 'touch';

  const [activeState, setActiveState] = useState<ActivePosterHoverPreview | null>(null);

  const activeRef = useRef<ActivePosterHoverPreview | null>(null);
  activeRef.current = activeState;
  const activeEnabledRef = useRef(activeEnabled);
  activeEnabledRef.current = activeEnabled;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const catalogRevisionRef = useRef(catalogRevision);
  catalogRevisionRef.current = catalogRevision;
  const elvEnrichActiveRef = useRef(elvEnrichActive);
  elvEnrichActiveRef.current = elvEnrichActive;
  const localeRef = useRef(i18n.locale);
  localeRef.current = i18n.locale;
  const onMutatedRef = useRef(onUserStateMutated);
  onMutatedRef.current = onUserStateMutated;

  const metadataCacheRef = useRef(createHoverMetadataCache(80));
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const pointerInPreviewRef = useRef(false);
  const hydrationAbortRef = useRef<AbortController | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    pendingKeyRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const abortHydration = useCallback(() => {
    if (hydrationAbortRef.current !== null) {
      hydrationAbortRef.current.abort();
      hydrationAbortRef.current = null;
    }
  }, []);

  const dismissNow = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    abortHydration();
    pointerInPreviewRef.current = false;
    activeRef.current = null;
    setActiveState(null);
  }, [abortHydration, clearCloseTimer, clearOpenTimer]);

  const hydrateEntryMetadata = useCallback(
    async (entry: PosterHoverPreviewEntry, rev: number, locale: string) => {
      const cat = catalogRef.current;
      const ac = new AbortController();
      hydrationAbortRef.current = ac;

      const [detailRow, enrichmentMap] = await Promise.all([
        cat.itemDetail?.(entry.itemKey).catch(() => null) ??
          Promise.resolve<ItemDetailRow | null>(null),
        cat.getElvEnrichmentForKeys?.([entry.itemKey]).catch(() => null) ?? Promise.resolve(null),
      ]);
      if (ac.signal.aborted || activeRef.current?.entry.itemKey !== entry.itemKey) return;

      const enrichment = enrichmentMap?.get(entry.itemKey);
      let elvTitle: ElvTitleRecord | null = enrichment?.title ?? null;

      const normalizedLocale = locale.trim().toLowerCase();
      const missingLocalizedSynopsis =
        elvTitle !== null &&
        normalizedLocale.length > 0 &&
        elvTitle.synopses[normalizedLocale] === undefined;
      if (
        elvEnrichActiveRef.current &&
        enrichment?.imdbId &&
        cat.getElvTitleDetail &&
        (elvTitle === null || elvTitle.detailFetchedAt === null || missingLocalizedSynopsis)
      ) {
        const fetched = await cat
          .getElvTitleDetail(enrichment.imdbId, { lang: locale, signal: ac.signal })
          .catch(() => null);
        if (ac.signal.aborted || activeRef.current?.entry.itemKey !== entry.itemKey) return;
        if (fetched !== null) elvTitle = fetched;
      }

      const merged = mergeHoverPreviewMetadata(entry, detailRow, elvTitle, locale);
      metadataCacheRef.current.set(rev, locale, entry.itemKey, merged);

      setActiveState((prev) => {
        if (!prev || prev.entry.itemKey !== entry.itemKey) return prev;
        return {
          ...prev,
          hydration: merged,
          metadataSettled: true,
        };
      });
    },
    [],
  );

  const openPreviewNow = useCallback(
    (entry: PosterHoverPreviewEntry, anchorRect: HoverPreviewRect, cardWidth?: number) => {
      clearCloseTimer();
      abortHydration();
      const rev = catalogRevisionRef.current;
      const locale = localeRef.current;
      const cached = metadataCacheRef.current.get(rev, locale, entry.itemKey);
      const baseline = mergeHoverPreviewMetadata(entry, null, null, locale);

      const next: ActivePosterHoverPreview = {
        entry,
        anchorRect,
        ...(cardWidth !== undefined ? { cardWidth } : {}),
        hydration: cached ?? baseline,
        metadataSettled: cached !== undefined,
        isFavorite: Boolean(entry.isFavorite),
        isWatched: Boolean(entry.watched),
        userRating: entry.userRating ?? null,
      };
      activeRef.current = next;
      setActiveState(next);

      if (cached === undefined) {
        void hydrateEntryMetadata(entry, rev, locale);
      }
    },
    [abortHydration, clearCloseTimer, hydrateEntryMetadata],
  );

  const scheduleOpen = useCallback(
    (entry: PosterHoverPreviewEntry, anchorRect: HoverPreviewRect, cardWidth?: number) => {
      if (!activeEnabledRef.current) return;
      clearCloseTimer();
      if (activeRef.current?.entry.itemKey === entry.itemKey) {
        setActiveState((prev) => {
          if (!prev || prev.entry.itemKey !== entry.itemKey) return prev;
          return {
            ...prev,
            entry,
            anchorRect,
            ...(cardWidth !== undefined ? { cardWidth } : {}),
            isFavorite: Boolean(entry.isFavorite),
            isWatched: Boolean(entry.watched),
            userRating: entry.userRating ?? null,
          };
        });
        return;
      }
      clearOpenTimer();
      pendingKeyRef.current = entry.itemKey;
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null;
        pendingKeyRef.current = null;
        if (!activeEnabledRef.current) return;
        openPreviewNow(entry, anchorRect, cardWidth);
      }, HOVER_PREVIEW_OPEN_DELAY_MS);
    },
    [clearCloseTimer, clearOpenTimer, openPreviewNow],
  );

  const scheduleClose = useCallback(
    (itemKey: string) => {
      if (pendingKeyRef.current === itemKey) {
        clearOpenTimer();
      }
      if (activeRef.current?.entry.itemKey !== itemKey) return;
      if (pointerInPreviewRef.current) return;
      clearCloseTimer();
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        if (!pointerInPreviewRef.current) dismissNow();
      }, HOVER_PREVIEW_CLOSE_DELAY_MS);
    },
    [clearCloseTimer, clearOpenTimer, dismissNow],
  );

  const onPreviewPointerEnter = useCallback(() => {
    pointerInPreviewRef.current = true;
    clearCloseTimer();
  }, [clearCloseTimer]);

  const onPreviewPointerLeave = useCallback(() => {
    pointerInPreviewRef.current = false;
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (!pointerInPreviewRef.current) dismissNow();
    }, HOVER_PREVIEW_CLOSE_DELAY_MS);
  }, [clearCloseTimer, dismissNow]);

  const toggleFavorite = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    const itemKey = current.entry.itemKey;
    const prevFav = current.isFavorite;
    const nextFav = !prevFav;
    setActiveState((prev) =>
      prev && prev.entry.itemKey === itemKey ? { ...prev, isFavorite: nextFav } : prev,
    );
    const revert = () =>
      setActiveState((prev) =>
        prev && prev.entry.itemKey === itemKey ? { ...prev, isFavorite: prevFav } : prev,
      );
    if (current.entry.onToggleFavorite) {
      void Promise.resolve(current.entry.onToggleFavorite()).then((res) => {
        if (res === false) {
          revert();
          return;
        }
        onMutatedRef.current?.();
      }, revert);
      return;
    }
    const cat = catalogRef.current;
    const input = {
      sourceId: current.entry.sourceId,
      itemKey,
      kind: current.entry.kind,
      title: current.entry.title,
      logo: current.entry.posterUri,
      year: current.entry.year,
      rating: current.entry.rating,
    };
    const pending = cat.setFavorite ? cat.setFavorite(input, nextFav) : cat.toggleFavorite?.(input);
    void Promise.resolve(pending).then((res) => {
      if (res && !res.ok) {
        revert();
        return;
      }
      onMutatedRef.current?.();
    }, revert);
  }, []);

  const toggleWatched = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    const itemKey = current.entry.itemKey;
    const prevWatched = current.isWatched;
    const nextWatched = !prevWatched;
    setActiveState((prev) =>
      prev && prev.entry.itemKey === itemKey ? { ...prev, isWatched: nextWatched } : prev,
    );
    const revert = () =>
      setActiveState((prev) =>
        prev && prev.entry.itemKey === itemKey ? { ...prev, isWatched: prevWatched } : prev,
      );
    if (current.entry.onToggleWatched) {
      void Promise.resolve(current.entry.onToggleWatched(prevWatched)).then((res) => {
        if (res === false) {
          revert();
          return;
        }
        onMutatedRef.current?.();
      }, revert);
      return;
    }
    const cat = catalogRef.current;
    const pending = cat.setWatched
      ? cat.setWatched(itemKey, nextWatched)
      : nextWatched && cat.saveProgress
        ? cat.saveProgress({
            sourceId: current.entry.sourceId,
            itemKey,
            kind: current.entry.kind,
            title: current.entry.title,
            logo: current.entry.posterUri,
            positionMs: 0,
            durationMs: 0,
            watched: true,
          })
        : undefined;
    void Promise.resolve(pending).then((res) => {
      if (res && !res.ok) {
        revert();
        return;
      }
      onMutatedRef.current?.();
    }, revert);
  }, []);

  const toggleRating = useCallback((next: RatingValue) => {
    const current = activeRef.current;
    if (!current) return;
    const itemKey = current.entry.itemKey;
    const prevRating = current.userRating;
    const nextValue: RatingValue | null = prevRating === next ? null : next;
    setActiveState((prev) =>
      prev && prev.entry.itemKey === itemKey ? { ...prev, userRating: nextValue } : prev,
    );
    const revert = () =>
      setActiveState((prev) =>
        prev && prev.entry.itemKey === itemKey ? { ...prev, userRating: prevRating } : prev,
      );
    if (current.entry.onToggleRating) {
      void Promise.resolve(current.entry.onToggleRating(next)).then((res) => {
        if (res === false) {
          revert();
          return;
        }
        onMutatedRef.current?.();
      }, revert);
      return;
    }
    const cat = catalogRef.current;
    if (!cat.setRating) return;
    void Promise.resolve(
      cat.setRating(
        {
          sourceId: current.entry.sourceId,
          itemKey,
          kind: current.entry.kind,
          title: current.entry.title,
          logo: current.entry.posterUri,
          year: current.entry.year,
          rating: current.entry.rating,
        },
        nextValue,
      ),
    ).then((res) => {
      if (res && !res.ok) {
        revert();
        return;
      }
      onMutatedRef.current?.();
    }, revert);
  }, []);

  const dismissRecommendation = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.entry.allowDismissRecommendation === false) return;
    dismissNow();
    if (current.entry.onDismissRecommendation) {
      void Promise.resolve(current.entry.onDismissRecommendation()).then(
        (res) => {
          if (res === false) return;
          onMutatedRef.current?.();
        },
        () => undefined,
      );
      return;
    }
    const cat = catalogRef.current as CatalogService & CatalogRecommendationDismissalMethods;
    if (!cat.dismissRecommendation) return;
    void Promise.resolve(cat.dismissRecommendation(current.entry.itemKey, current.entry.kind)).then(
      () => onMutatedRef.current?.(),
      () => undefined,
    );
  }, [dismissNow]);

  useEffect(() => {
    if (!activeEnabled) dismissNow();
  }, [activeEnabled, dismissNow]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dismiss active preview on route/detail/catalog-revision change
  useEffect(() => {
    dismissNow();
  }, [catalogRevision, dismissKey, dismissNow]);

  useEffect(() => {
    return () => {
      dismissNow();
    };
  }, [dismissNow]);

  const isPreviewOpen = activeState !== null;
  useEffect(() => {
    if (!isPreviewOpen || !activeEnabled) return undefined;
    const win = (globalThis as { window?: WebWindowLike }).window;
    if (!win?.addEventListener || !win.removeEventListener) return undefined;

    const handleScroll = () => dismissNow();
    const handleWheel = () => dismissNow();
    const handleResize = () => dismissNow();
    const handleKeyDown = (event?: unknown) => {
      const evt = event as { key?: unknown; preventDefault?: () => void } | undefined;
      if (evt?.key !== 'Escape') return;
      evt.preventDefault?.();
      dismissNow();
    };

    win.addEventListener('scroll', handleScroll, true);
    win.addEventListener('wheel', handleWheel, { passive: true });
    win.addEventListener('resize', handleResize);
    win.addEventListener('keydown', handleKeyDown);
    return () => {
      win.removeEventListener?.('scroll', handleScroll, true);
      win.removeEventListener?.('wheel', handleWheel, { passive: true });
      win.removeEventListener?.('resize', handleResize);
      win.removeEventListener?.('keydown', handleKeyDown);
    };
  }, [activeEnabled, dismissNow, isPreviewOpen]);

  const controls = useMemo<PosterHoverPreviewControls>(
    () => ({ scheduleOpen, scheduleClose, dismissNow }),
    [dismissNow, scheduleClose, scheduleOpen],
  );

  const internalActions = useMemo<PosterHoverPreviewInternalActions>(
    () => ({
      onPreviewPointerEnter,
      onPreviewPointerLeave,
      toggleFavorite,
      toggleWatched,
      toggleRating,
      dismissRecommendation,
    }),
    [
      dismissRecommendation,
      onPreviewPointerEnter,
      onPreviewPointerLeave,
      toggleFavorite,
      toggleRating,
      toggleWatched,
    ],
  );

  return (
    <PosterHoverPreviewControlContext.Provider value={controls}>
      <PosterHoverPreviewInternalContext.Provider value={internalActions}>
        <PosterHoverPreviewStateContext.Provider value={activeState}>
          {children}
        </PosterHoverPreviewStateContext.Provider>
      </PosterHoverPreviewInternalContext.Provider>
    </PosterHoverPreviewControlContext.Provider>
  );
}

/** Returns stable hover-preview scheduling controls for Desktop `PosterCard` hosts. */
export function usePosterHoverPreview(): PosterHoverPreviewControls {
  return useContext(PosterHoverPreviewControlContext);
}

/** Subscribes to the currently open hover preview entry (used only by {@link PosterHoverPreviewHost}). */
export function usePosterHoverPreviewState(): ActivePosterHoverPreview | null {
  return useContext(PosterHoverPreviewStateContext);
}

/** Subscribes to internal pointer/mutation actions inside {@link PosterHoverPreviewHost}. */
export function usePosterHoverPreviewActions(): PosterHoverPreviewInternalActions {
  return useContext(PosterHoverPreviewInternalContext);
}

/**
 * Shared Desktop pointer-hover binder for `PosterCard` wrappers. Keeps the returned callbacks
 * identity-stable while reading the latest item state on hover dwell.
 */
export function useCardPosterHoverPreview(params: {
  readonly enabled: boolean;
  readonly entry: PosterHoverPreviewEntry | null;
  readonly cardWidth?: number;
}): {
  readonly onHoverPreviewStart?: (rect: PosterCardHoverRect) => void;
  readonly onHoverPreviewEnd?: () => void;
} {
  const { enabled, entry, cardWidth } = params;
  const { scheduleOpen, scheduleClose } = usePosterHoverPreview();
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const cardWidthRef = useRef(cardWidth);
  cardWidthRef.current = cardWidth;
  const itemKey = entry?.itemKey;

  const onHoverPreviewStart = useCallback(
    (rect: PosterCardHoverRect) => {
      const current = entryRef.current;
      if (current) scheduleOpen(current, rect, cardWidthRef.current);
    },
    [scheduleOpen],
  );

  const onHoverPreviewEnd = useCallback(() => {
    if (itemKey !== undefined) scheduleClose(itemKey);
  }, [itemKey, scheduleClose]);

  return useMemo(
    () => (enabled && itemKey !== undefined ? { onHoverPreviewStart, onHoverPreviewEnd } : {}),
    [enabled, itemKey, onHoverPreviewEnd, onHoverPreviewStart],
  );
}

/** Shared Desktop hover-preview binder for `ItemRow`-backed `PosterCard` wrappers. */
export function useItemRowPosterHoverPreview(params: {
  readonly item: ItemRow | undefined;
  readonly categoryId?: string;
  readonly cardWidth: number;
  readonly isFavorite: boolean;
  readonly watched: boolean;
  readonly userRating: RatingValue | null;
  readonly allowDismissRecommendation?: boolean;
  readonly onPlay: () => void;
  readonly onOpenDetail: () => void;
  readonly onToggleFavorite?: (item: ItemRow) => unknown;
  readonly onToggleWatched?: (item: ItemRow, currentWatched: boolean) => unknown;
  readonly onToggleRating?: (item: ItemRow, next: RatingValue) => unknown;
  readonly onDismissRecommendation?: (item: ItemRow) => unknown;
}): {
  readonly onHoverPreviewStart?: (rect: PosterCardHoverRect) => void;
  readonly onHoverPreviewEnd?: () => void;
} {
  const {
    item,
    categoryId,
    cardWidth,
    isFavorite,
    watched,
    userRating,
    allowDismissRecommendation,
    onPlay,
    onOpenDetail,
    onToggleFavorite,
    onToggleWatched,
    onToggleRating,
    onDismissRecommendation,
  } = params;
  const enabled = item !== undefined && (item.kind === 'movie' || item.kind === 'series');
  const entry = useMemo<PosterHoverPreviewEntry | null>(() => {
    if (!item || (item.kind !== 'movie' && item.kind !== 'series')) return null;
    const backdropUri = (item as { backdrop?: string | null }).backdrop ?? null;
    return {
      itemKey: item.key,
      sourceId: item.sourceId,
      kind: item.kind,
      title: item.name,
      ...(categoryId !== undefined ? { categoryId } : {}),
      posterUri: item.logo,
      backdropUri,
      year: item.year,
      rating: item.rating,
      watched,
      isFavorite,
      userRating,
      ...(allowDismissRecommendation !== undefined ? { allowDismissRecommendation } : {}),
      onPlay,
      onOpenDetail,
      ...(onToggleFavorite !== undefined ? { onToggleFavorite: () => onToggleFavorite(item) } : {}),
      ...(onToggleWatched !== undefined
        ? { onToggleWatched: (cur: boolean) => onToggleWatched(item, cur) }
        : {}),
      ...(onToggleRating !== undefined
        ? { onToggleRating: (next: RatingValue) => onToggleRating(item, next) }
        : {}),
      ...(allowDismissRecommendation !== false && onDismissRecommendation !== undefined
        ? { onDismissRecommendation: () => onDismissRecommendation(item) }
        : {}),
    };
  }, [
    allowDismissRecommendation,
    categoryId,
    isFavorite,
    item,
    onDismissRecommendation,
    onOpenDetail,
    onPlay,
    onToggleFavorite,
    onToggleRating,
    onToggleWatched,
    userRating,
    watched,
  ]);
  return useCardPosterHoverPreview({ enabled, entry, cardWidth });
}
