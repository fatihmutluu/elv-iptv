import type { KeyEvent } from '@elv/focus-core';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowseFocusMemory } from '../shared';
import { EMPTY_LIVE_MEMORY, type LiveMode, type LiveTabMemory } from './live-model';

/** Controlled-or-uncontrolled Live tab memory helper preserving mode, category, and channel history. */
export function useLiveTabMemory(
  memory: LiveTabMemory | undefined,
  onMemoryChange: ((next: LiveTabMemory) => void) | undefined,
  defaultMode?: LiveMode,
): {
  readonly memory: LiveTabMemory;
  readonly memoryRef: MutableRefObject<LiveTabMemory>;
  readonly updateMemory: (patch: Partial<LiveTabMemory>) => void;
} {
  const [localMemory, setLocalMemory] = useState<LiveTabMemory>(
    () =>
      memory ??
      (defaultMode !== undefined ? { ...EMPTY_LIVE_MEMORY, mode: defaultMode } : EMPTY_LIVE_MEMORY),
  );
  const activeMemory = onMemoryChange && memory !== undefined ? memory : localMemory;
  const memoryRef = useRef(activeMemory);
  memoryRef.current = activeMemory;

  const updateMemory = useCallback(
    (patch: Partial<LiveTabMemory>) => {
      const next: LiveTabMemory = { ...memoryRef.current, ...patch };
      memoryRef.current = next;
      setLocalMemory(next);
      onMemoryChange?.(next);
    },
    [onMemoryChange],
  );

  return useMemo(
    () => ({ memory: activeMemory, memoryRef, updateMemory }),
    [activeMemory, updateMemory],
  );
}

/** High-level 10-ft TV focus zone inside `LiveScreen`. */
export type LiveTvZone = 'header' | 'body';
/** Header sub-row when `LiveScreen` owns TV focus. */
export type LiveTvHeaderRow = 'modes' | 'categories';
/** Focusable action controls inside `LiveWatchStage` (`Favorites` stage). */
export type LiveWatchControl = 'miniguide' | 'favorite' | 'watch' | 'browse';

const MODE_ORDER: readonly LiveMode[] = ['favorites', 'channels', 'epg'];
const WATCH_CONTROLS: readonly LiveWatchControl[] = ['miniguide', 'favorite', 'watch'];
const NUMPAD_GRID: readonly (readonly string[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', '↵'],
];

function modeToIndex(mode: LiveMode): number {
  const idx = MODE_ORDER.indexOf(mode);
  return idx >= 0 ? idx : 1;
}

/** Options accepted by {@link useTvLiveNavigation}. */
export interface UseTvLiveNavigationOptions {
  readonly isTv: boolean;
  readonly isActiveScope: boolean;
  readonly isEmpty: boolean;
  readonly hasOpenSourcesCta: boolean;
  readonly mode: LiveMode;
  readonly categoryCount: number;
  readonly channelCount: number;
  readonly hasBody: boolean;
  readonly zapDrawerOpen: boolean;
  readonly numpadOpen: boolean;
  readonly onSelectMode: (mode: LiveMode) => void;
  readonly onSelectCategoryIndex: (index: number) => void;
  readonly onToggleNumpad: () => void;
  readonly onCloseNumpad: () => void;
  readonly onPressNumpadKey: (key: string) => void;
  readonly onActivateWatchControl: (control: LiveWatchControl) => void;
  readonly onSelectZapIndex: (index: number) => void;
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
}

/** Focus coordinates and D-pad handlers returned by {@link useTvLiveNavigation}. */
export interface TvLiveNavigationState {
  readonly tvZone: LiveTvZone;
  readonly focusedModeIndex: number | null;
  readonly focusedNumpadToggle: boolean;
  readonly focusedCategoryIndex: number | null;
  readonly focusedEmptyCta: boolean;
  readonly focusedWatchControl: LiveWatchControl | null;
  readonly focusedZapIndex: number | null;
  readonly focusedNumpadKey: string | null;
  readonly handleTvKey: (event: KeyEvent) => boolean;
  readonly handleChildEdgeTop: () => void;
}

interface NavSnapshot {
  readonly zone: LiveTvZone;
  readonly headerRow: LiveTvHeaderRow;
  readonly modeCol: number;
  readonly catCol: number;
  readonly watchZone: 'controls' | 'zap';
  readonly watchControlIdx: number;
  readonly zapIdx: number;
  readonly numpadRow: number;
  readonly numpadCol: number;
}

/**
 * 10-ft TV D-pad focus orchestrator for {@link LiveScreen}.
 * Coordinates `Top Nav <-> Mode Switcher <-> Category Bar <-> Body` and traps D-pad input inside
 * the 4×3 `LiveNumberPad` overlay in `Channels` mode, with zero duplicate key listeners.
 */
export function useTvLiveNavigation(opts: UseTvLiveNavigationOptions): TvLiveNavigationState {
  const { isTv, isActiveScope, isEmpty, hasOpenSourcesCta, mode, categoryCount } = opts;
  const { channelCount, hasBody, zapDrawerOpen, numpadOpen } = opts;
  const hasCategoryBar = (mode === 'channels' || mode === 'epg') && categoryCount > 0;

  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const savedOnMountRef = useRef<NavSnapshot | null | undefined>(undefined);
  if (savedOnMountRef.current === undefined) {
    savedOnMountRef.current = focusMemory?.get<NavSnapshot>('live') ?? null;
  }
  const pendingBodyRestoreRef = useRef(savedOnMountRef.current?.zone === 'body');

  const [nav, setNav] = useState<NavSnapshot>(
    () =>
      savedOnMountRef.current ?? {
        zone: 'header',
        headerRow: 'modes',
        modeCol: modeToIndex(mode),
        catCol: 0,
        watchZone: 'controls',
        watchControlIdx: 0,
        zapIdx: 0,
        numpadRow: 0,
        numpadCol: 0,
      },
  );

  const navRef = useRef(nav);
  navRef.current = nav;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const updateNav = useCallback((updater: (prev: NavSnapshot) => NavSnapshot) => {
    pendingBodyRestoreRef.current = false;
    const next = updater(navRef.current);
    if (next === navRef.current) return;
    navRef.current = next;
    focusMemoryRef.current?.set<NavSnapshot>('live', next);
    setNav(next);
  }, []);

  useEffect(() => {
    if (numpadOpen) {
      setNav((prev) =>
        prev.numpadRow === 0 && prev.numpadCol === 0
          ? prev
          : { ...prev, numpadRow: 0, numpadCol: 0 },
      );
    }
  }, [numpadOpen]);

  useEffect(() => {
    setNav((prev) => {
      const maxModeCol = mode === 'channels' ? 3 : 2;
      const nextModeCol = Math.min(prev.modeCol, maxModeCol);
      const nextCatCol = categoryCount > 0 ? Math.min(prev.catCol, categoryCount - 1) : 0;
      const nextHeaderRow =
        !hasCategoryBar && prev.headerRow === 'categories' ? 'modes' : prev.headerRow;
      const nextZapIdx = channelCount > 0 ? Math.min(prev.zapIdx, channelCount - 1) : 0;
      const nextWatchZone = !zapDrawerOpen || channelCount === 0 ? 'controls' : prev.watchZone;
      let nextZone = !hasBody && prev.zone === 'body' ? 'header' : prev.zone;
      if (hasBody && pendingBodyRestoreRef.current) {
        pendingBodyRestoreRef.current = false;
        nextZone = 'body';
      }
      if (
        nextModeCol === prev.modeCol &&
        nextCatCol === prev.catCol &&
        nextHeaderRow === prev.headerRow &&
        nextZapIdx === prev.zapIdx &&
        nextWatchZone === prev.watchZone &&
        nextZone === prev.zone
      ) {
        return prev;
      }
      return {
        ...prev,
        zone: nextZone,
        headerRow: nextHeaderRow,
        modeCol: nextModeCol,
        catCol: nextCatCol,
        watchZone: nextWatchZone,
        zapIdx: nextZapIdx,
      };
    });
  }, [categoryCount, channelCount, hasBody, hasCategoryBar, mode, zapDrawerOpen]);

  const handleChildEdgeTop = useCallback(() => {
    const showCats =
      (optsRef.current.mode === 'channels' || optsRef.current.mode === 'epg') &&
      optsRef.current.categoryCount > 0;
    updateNav((prev) => ({
      ...prev,
      zone: 'header',
      headerRow: showCats ? 'categories' : 'modes',
    }));
  }, [updateNav]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const o = optsRef.current;
      const cur = navRef.current;

      if (o.numpadOpen) {
        if (event.kind === 'press' && event.key === 'back') {
          o.onCloseNumpad();
          return true;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'up') setNav((p) => ({ ...p, numpadRow: Math.max(0, p.numpadRow - 1) }));
        else if (event.key === 'down')
          setNav((p) => ({ ...p, numpadRow: Math.min(NUMPAD_GRID.length - 1, p.numpadRow + 1) }));
        else if (event.key === 'left')
          setNav((p) => ({ ...p, numpadCol: Math.max(0, p.numpadCol - 1) }));
        else if (event.key === 'right')
          setNav((p) => ({ ...p, numpadCol: Math.min(2, p.numpadCol + 1) }));
        else if (event.key === 'select' && event.kind === 'press') {
          const keyVal = NUMPAD_GRID[cur.numpadRow]?.[cur.numpadCol];
          if (keyVal) o.onPressNumpadKey(keyVal);
        } else return false;
        return true;
      }

      if (event.kind === 'press' && event.key === 'back') {
        if (cur.zone === 'body' && o.mode === 'favorites') {
          updateNav((p) =>
            cur.watchZone === 'zap'
              ? { ...p, watchZone: 'controls' }
              : { ...p, zone: 'header', headerRow: 'modes' },
          );
          return true;
        }
        o.onFocusTopNav?.();
        return true;
      }

      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      if (o.isEmpty) {
        if (event.key === 'up') {
          o.onFocusTopNav?.();
          return true;
        }
        if (event.key === 'select' && event.kind === 'press' && o.hasOpenSourcesCta) {
          o.onOpenSources();
          return true;
        }
        return false;
      }

      const showCats = (o.mode === 'channels' || o.mode === 'epg') && o.categoryCount > 0;

      if (cur.zone === 'header') {
        if (cur.headerRow === 'modes') {
          const maxCol = o.mode === 'channels' ? 3 : 2;
          if (event.key === 'up') o.onFocusTopNav?.();
          else if (event.key === 'left')
            updateNav((p) => ({ ...p, modeCol: Math.max(0, p.modeCol - 1) }));
          else if (event.key === 'right')
            updateNav((p) => ({ ...p, modeCol: Math.min(maxCol, p.modeCol + 1) }));
          else if (event.key === 'down') {
            if (showCats) updateNav((p) => ({ ...p, headerRow: 'categories' }));
            else if (o.hasBody) updateNav((p) => ({ ...p, zone: 'body', watchZone: 'controls' }));
          } else if (event.key === 'select' && event.kind === 'press') {
            if (cur.modeCol === 3 && o.mode === 'channels') o.onToggleNumpad();
            else {
              const target = MODE_ORDER[cur.modeCol];
              if (target) o.onSelectMode(target);
            }
          } else return false;
          return true;
        }

        if (event.key === 'up') updateNav((p) => ({ ...p, headerRow: 'modes' }));
        else if (event.key === 'left')
          updateNav((p) => ({ ...p, catCol: Math.max(0, p.catCol - 1) }));
        else if (event.key === 'right')
          updateNav((p) => ({
            ...p,
            catCol: Math.min(Math.max(0, o.categoryCount - 1), p.catCol + 1),
          }));
        else if (event.key === 'down') {
          if (o.hasBody) updateNav((p) => ({ ...p, zone: 'body' }));
        } else if (event.key === 'select' && event.kind === 'press')
          o.onSelectCategoryIndex(cur.catCol);
        else return false;
        return true;
      }

      if (o.mode !== 'favorites') return false;

      if (o.channelCount === 0) {
        if (event.key === 'up') updateNav((p) => ({ ...p, zone: 'header', headerRow: 'modes' }));
        else if (event.key === 'select' && event.kind === 'press')
          o.onActivateWatchControl('browse');
        else return false;
        return true;
      }

      if (cur.watchZone === 'controls') {
        if (event.key === 'up') updateNav((p) => ({ ...p, zone: 'header', headerRow: 'modes' }));
        else if (event.key === 'left' || event.key === 'right') {
          const delta = event.key === 'left' ? -1 : 1;
          updateNav((p) => ({
            ...p,
            watchControlIdx: Math.max(
              0,
              Math.min(WATCH_CONTROLS.length - 1, p.watchControlIdx + delta),
            ),
          }));
        } else if (event.key === 'down') {
          if (o.zapDrawerOpen && o.channelCount > 0) updateNav((p) => ({ ...p, watchZone: 'zap' }));
        } else if (event.key === 'select' && event.kind === 'press') {
          const ctrl = WATCH_CONTROLS[cur.watchControlIdx];
          if (ctrl) o.onActivateWatchControl(ctrl);
        } else return false;
        return true;
      }

      if (event.key === 'up')
        updateNav((p) =>
          cur.zapIdx <= 0 ? { ...p, watchZone: 'controls' } : { ...p, zapIdx: p.zapIdx - 1 },
        );
      else if (event.key === 'down')
        updateNav((p) => ({
          ...p,
          zapIdx: Math.min(Math.max(0, o.channelCount - 1), p.zapIdx + 1),
        }));
      else if (event.key === 'right') updateNav((p) => ({ ...p, watchZone: 'controls' }));
      else if (event.key === 'select' && event.kind === 'press') o.onSelectZapIndex(cur.zapIdx);
      else return false;
      return true;
    },
    [updateNav],
  );

  const activeTv = isTv && isActiveScope;
  const numpadFocused = activeTv && numpadOpen;
  const inHeader = activeTv && !numpadOpen && !isEmpty && nav.zone === 'header';
  const inFavBody =
    activeTv && !numpadOpen && !isEmpty && nav.zone === 'body' && mode === 'favorites';
  const watchCtrl: LiveWatchControl | null =
    channelCount === 0 ? 'browse' : (WATCH_CONTROLS[nav.watchControlIdx] ?? null);

  return useMemo<TvLiveNavigationState>(
    () => ({
      tvZone: nav.zone,
      focusedModeIndex:
        inHeader && nav.headerRow === 'modes' && nav.modeCol < 3 ? nav.modeCol : null,
      focusedNumpadToggle:
        inHeader && nav.headerRow === 'modes' && mode === 'channels' && nav.modeCol === 3,
      focusedCategoryIndex: inHeader && nav.headerRow === 'categories' ? nav.catCol : null,
      focusedEmptyCta: activeTv && !numpadOpen && isEmpty && hasOpenSourcesCta,
      focusedWatchControl: inFavBody && nav.watchZone === 'controls' ? watchCtrl : null,
      focusedZapIndex: inFavBody && channelCount > 0 && nav.watchZone === 'zap' ? nav.zapIdx : null,
      focusedNumpadKey: numpadFocused ? (NUMPAD_GRID[nav.numpadRow]?.[nav.numpadCol] ?? '1') : null,
      handleTvKey,
      handleChildEdgeTop,
    }),
    [
      activeTv,
      channelCount,
      handleChildEdgeTop,
      handleTvKey,
      hasOpenSourcesCta,
      inFavBody,
      inHeader,
      isEmpty,
      mode,
      nav.catCol,
      nav.headerRow,
      nav.modeCol,
      nav.numpadCol,
      nav.numpadRow,
      nav.watchZone,
      nav.zapIdx,
      nav.zone,
      numpadFocused,
      numpadOpen,
      watchCtrl,
    ],
  );
}
