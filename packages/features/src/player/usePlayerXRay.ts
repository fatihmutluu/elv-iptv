import type { CatalogService, ElvTitleRecord } from '@elv/data';
import type { PlaybackStatus } from '@elv/playback';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { DetailTarget, PersonLibraryModalPerson } from '../shared';
import {
  isXrayEligibleTarget,
  resolveXrayBaseItemKey,
  shouldShowXrayStrip,
} from './player-xray-model';

/** Catalog slice required by {@link usePlayerXRay}. */
export type PlayerXRayCatalog = Partial<
  Pick<
    CatalogService,
    'getElvEnrichmentForKeys' | 'getElvTitleDetail' | 'listElvPersonLibraryItems'
  >
>;

/** Options for {@link usePlayerXRay}. */
export interface UsePlayerXRayOptions {
  readonly catalog: PlayerXRayCatalog;
  readonly activeTarget: PlayTarget;
  readonly statusKind: PlaybackStatus['kind'];
  readonly elvModeEnabled: boolean;
  readonly elvXrayEnabled: boolean;
  readonly locale: string;
  readonly suppressed: boolean;
  readonly onPausePlayback: () => void;
  readonly onOpenDetail?: (target: DetailTarget) => void;
}

/** State and actions returned by {@link usePlayerXRay}. */
export interface PlayerXRayState {
  readonly eligible: boolean;
  readonly hasCast: boolean;
  readonly hasButton: boolean;
  readonly stripVisible: boolean;
  readonly titleDetail: ElvTitleRecord | null;
  readonly selectedPerson: PersonLibraryModalPerson | null;
  readonly toggleStrip: () => void;
  readonly dismissStrip: () => void;
  readonly selectPerson: (person: PersonLibraryModalPerson) => void;
  readonly closePersonModal: () => void;
  readonly selectLibraryItem: (target: DetailTarget) => void;
}

/**
 * Lazily hydrates In-Player X-Ray cast & director metadata for VOD playback (`#352`),
 * reusing the 30-day local `elv-enrichment.db` cache, auto-showing on pause, and opening
 * the shared {@link PersonLibraryModal} on actor/director selection.
 */
export function usePlayerXRay({
  catalog,
  activeTarget,
  statusKind,
  elvModeEnabled,
  elvXrayEnabled,
  locale,
  suppressed,
  onPausePlayback,
  onOpenDetail,
}: UsePlayerXRayOptions): PlayerXRayState {
  const eligible = elvModeEnabled && elvXrayEnabled && isXrayEligibleTarget(activeTarget);
  const baseItemKey = resolveXrayBaseItemKey(activeTarget);

  const [titleDetail, setTitleDetail] = useState<ElvTitleRecord | null>(null);
  const [userPinnedOpen, setUserPinnedOpen] = useState(false);
  const [dismissedOnPause, setDismissedOnPause] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<PersonLibraryModalPerson | null>(null);

  const cacheRef = useRef<Map<string, ElvTitleRecord | null>>(new Map());
  const statusKindRef = useRef(statusKind);
  statusKindRef.current = statusKind;
  const onPauseRef = useRef(onPausePlayback);
  onPauseRef.current = onPausePlayback;
  const onOpenDetailRef = useRef(onOpenDetail);
  onOpenDetailRef.current = onOpenDetail;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per-item X-Ray UI on episode or movie change while keeping series titleDetail cached by baseItemKey
  useEffect(() => {
    setUserPinnedOpen(false);
    setDismissedOnPause(false);
    setSelectedPerson(null);
  }, [activeTarget.itemKey]);

  useEffect(() => {
    if (statusKind === 'playing') {
      setDismissedOnPause(false);
    }
  }, [statusKind]);

  useEffect(() => {
    if (!eligible) {
      setTitleDetail(null);
      return undefined;
    }
    const cacheKey = `${baseItemKey}:${locale}`;
    if (cacheRef.current.has(cacheKey)) {
      setTitleDetail(cacheRef.current.get(cacheKey) ?? null);
      return undefined;
    }
    const getEnrichment = catalog.getElvEnrichmentForKeys;
    const getDetail = catalog.getElvTitleDetail;
    if (getEnrichment === undefined) {
      setTitleDetail(null);
      return undefined;
    }

    let cancelled = false;
    const ac = new AbortController();

    void (async () => {
      try {
        const map = await getEnrichment([baseItemKey]);
        if (cancelled) return;
        const entry = map.get(baseItemKey);
        if (!entry) {
          cacheRef.current.set(cacheKey, null);
          setTitleDetail(null);
          return;
        }
        if (
          entry.title !== null &&
          (entry.title.cast.length > 0 || entry.title.director !== null)
        ) {
          setTitleDetail(entry.title);
        }
        if (getDetail !== undefined && entry.imdbId) {
          const full = await getDetail(entry.imdbId, { lang: locale, signal: ac.signal });
          if (cancelled) return;
          const resolved = full ?? entry.title ?? null;
          cacheRef.current.set(cacheKey, resolved);
          setTitleDetail(resolved);
          return;
        }
        const fallback = entry.title ?? null;
        cacheRef.current.set(cacheKey, fallback);
        setTitleDetail(fallback);
      } catch {
        if (!cancelled) setTitleDetail(null);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [baseItemKey, catalog.getElvEnrichmentForKeys, catalog.getElvTitleDetail, eligible, locale]);

  const hasCast = titleDetail !== null && titleDetail.cast.length > 0;
  const hasButton = eligible && hasCast;

  const stripVisible = shouldShowXrayStrip({
    eligible,
    suppressed: suppressed || selectedPerson !== null,
    statusKind,
    userPinnedOpen,
    dismissedOnPause,
    hasMetadata: hasCast,
  });

  const stripVisibleRef = useRef(stripVisible);
  stripVisibleRef.current = stripVisible;

  const toggleStrip = useCallback(() => {
    if (!eligible || !hasCast) return;
    if (stripVisibleRef.current) {
      setUserPinnedOpen(false);
      if (statusKindRef.current === 'paused') setDismissedOnPause(true);
    } else {
      setDismissedOnPause(false);
      setUserPinnedOpen(true);
    }
  }, [eligible, hasCast]);

  const dismissStrip = useCallback(() => {
    setUserPinnedOpen(false);
    if (statusKindRef.current === 'paused') setDismissedOnPause(true);
  }, []);

  const selectPerson = useCallback((person: PersonLibraryModalPerson) => {
    if (statusKindRef.current === 'playing') {
      onPauseRef.current();
    }
    setSelectedPerson(person);
  }, []);

  const closePersonModal = useCallback(() => {
    setSelectedPerson(null);
  }, []);

  const selectLibraryItem = useCallback((target: DetailTarget) => {
    setSelectedPerson(null);
    onOpenDetailRef.current?.(target);
  }, []);

  return {
    eligible,
    hasCast,
    hasButton,
    stripVisible,
    titleDetail,
    selectedPerson,
    toggleStrip,
    dismissStrip,
    selectPerson,
    closePersonModal,
    selectLibraryItem,
  };
}
