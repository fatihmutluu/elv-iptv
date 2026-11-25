import type { VodVersionOption } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DetailTarget } from '../shared';
import type { DetailHeroFocusSlot } from './DetailHero';
import { SYNOPSIS_EXPAND_THRESHOLD } from './detail-preplay';

/** Options for {@link useDetailExtrasState}. */
export interface UseDetailExtrasStateOptions {
  readonly target: DetailTarget;
  readonly plot: string | null;
  readonly versions?: readonly VodVersionOption[];
  readonly activeVersionKey?: string;
  readonly onSelectVersion?: (key: string) => void;
}

/** Local version dropdown state, synopsis sheet toggle, and derived TV focus slots for `DetailScreen`. */
export interface DetailExtrasState {
  readonly versionMenuOpen: boolean;
  readonly versionMenuIndex: number;
  readonly synopsisExpanded: boolean;
  readonly trimmedPlot: string;
  readonly canExpandSynopsis: boolean;
  readonly heroPlaySlots: readonly DetailHeroFocusSlot[];
  readonly castPeople: readonly string[];
  readonly toggleVersionMenu: () => void;
  readonly closeVersionMenu: () => void;
  readonly toggleSynopsis: () => void;
  readonly dismissSynopsis: () => void;
  readonly interceptTvKey: (event: KeyEvent, fallback: (ev: KeyEvent) => boolean) => boolean;
}

/**
 * Manages VOD version dropdown state, expandable synopsis sheet state, and derived hero/cast
 * focus slots for {@link DetailScreen}, resetting cleanly whenever the active title changes (`#398`, `#404`).
 */
export function useDetailExtrasState({
  target,
  plot,
  versions = [],
  activeVersionKey,
  onSelectVersion,
}: UseDetailExtrasStateOptions): DetailExtrasState {
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const [versionMenuIndex, setVersionMenuIndex] = useState(0);
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const hasVersions = versions.length > 1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset sheet & version menu whenever opening a new title
  useEffect(() => {
    setSynopsisExpanded(false);
    setVersionMenuOpen(false);
    setVersionMenuIndex(0);
  }, [target.itemKey]);

  const toggleVersionMenu = useCallback(() => {
    if (!hasVersions) return;
    setVersionMenuOpen((prev) => {
      if (!prev) {
        const activeIdx = Math.max(
          0,
          versions.findIndex((v) => v.key === activeVersionKey),
        );
        setVersionMenuIndex(activeIdx);
      }
      return !prev;
    });
  }, [activeVersionKey, hasVersions, versions]);

  const closeVersionMenu = useCallback(() => setVersionMenuOpen(false), []);
  const toggleSynopsis = useCallback(() => setSynopsisExpanded((v) => !v), []);
  const dismissSynopsis = useCallback(() => setSynopsisExpanded(false), []);

  const trimmedPlot = plot?.trim() ?? '';
  const canExpandSynopsis = trimmedPlot.length >= SYNOPSIS_EXPAND_THRESHOLD;

  const heroPlaySlots = useMemo<readonly DetailHeroFocusSlot[]>(
    () => [
      'play',
      ...(hasVersions ? (['preplay-version'] as const) : []),
      ...(canExpandSynopsis ? (['synopsis'] as const) : []),
    ],
    [canExpandSynopsis, hasVersions],
  );

  const castPeople = useMemo<readonly string[]>(() => {
    const out: string[] = [];
    const dir = target.director?.trim();
    if (dir) out.push(dir);
    if (target.cast) {
      for (const m of target.cast) out.push(m.name);
    }
    return out;
  }, [target.cast, target.director]);

  const interceptTvKey = useCallback(
    (event: KeyEvent, fallback: (ev: KeyEvent) => boolean): boolean => {
      if (versionMenuOpen) {
        if (event.kind === 'press') {
          if (event.key === 'back') {
            setVersionMenuOpen(false);
          } else if (event.key === 'up' || event.key === 'left') {
            setVersionMenuIndex(
              (idx) => (idx - 1 + versions.length) % Math.max(1, versions.length),
            );
          } else if (event.key === 'down' || event.key === 'right') {
            setVersionMenuIndex((idx) => (idx + 1) % Math.max(1, versions.length));
          } else if (event.key === 'select') {
            const chosen = versions[versionMenuIndex];
            if (chosen) onSelectVersion?.(chosen.key);
            setVersionMenuOpen(false);
          }
        }
        return true;
      }
      if (synopsisExpanded) {
        if (event.kind === 'press' && (event.key === 'back' || event.key === 'select')) {
          setSynopsisExpanded(false);
        }
        return true;
      }
      return fallback(event);
    },
    [onSelectVersion, synopsisExpanded, versionMenuIndex, versionMenuOpen, versions],
  );

  return {
    versionMenuOpen,
    versionMenuIndex,
    synopsisExpanded,
    trimmedPlot,
    canExpandSynopsis,
    heroPlaySlots,
    castPeople,
    toggleVersionMenu,
    closeVersionMenu,
    toggleSynopsis,
    dismissSynopsis,
    interceptTvKey,
  };
}
