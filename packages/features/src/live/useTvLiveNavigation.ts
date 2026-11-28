import type { KeyEvent, KeymapOverrides } from '@elv/focus-core';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateRemappedEvent, useBrowseFocusMemory, useKeymap } from '../shared';
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
export type LiveWatchControl = 'play-pause' | 'fullscreen' | 'tracks' | 'overflow' | 'browse';

const MODE_ORDER: readonly LiveMode[] = ['favorites', 'channels', 'epg'];
const WATCH_CONTROLS: readonly LiveWatchControl[] = [
  'play-pause',
  'tracks',
  'fullscreen',
  'overflow',
];
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
  /** Number of focusable slots in `LiveFavoriteFolderStrip` (`0` when folders unsupported). */
  readonly folderSlotCount?: number;
  /** True when the profile has at least one favorite channel overall (keeps folder strip reachable even when active folder is empty). */
  readonly hasAnyFavorites?: boolean;
  readonly onActivateFolderSlot?: (index: number) => void;
  readonly onSelectMode: (mode: LiveMode) => void;
  readonly onSelectCategoryIndex: (index: number) => void;
  readonly onToggleSort?: () => void;
  readonly onToggleNumpad: () => void;
  readonly onCloseNumpad: () => void;
  readonly onPressNumpadKey: (key: string) => void;
  readonly onActivateWatchControl: (control: LiveWatchControl) => void;
  readonly onSelectZapIndex: (index: number) => void;
  readonly onOpenZapContextMenu?: (index: number) => void;
  readonly onJumpPreviousChannel?: () => void;
  readonly onToggleGuideMode?: () => void;
  readonly onOpenSearch?: () => void;
  readonly onOpenHome?: () => void;
  readonly onToggleActiveFavorite?: () => void;
  readonly keymapOverrides?: KeymapOverrides;
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
}

/** Focus coordinates and D-pad handlers returned by {@link useTvLiveNavigation}. */
export interface TvLiveNavigationState {
  readonly tvZone: LiveTvZone;
  readonly focusedModeIndex: number | null;
  readonly focusedNumpadToggle: boolean;
  readonly focusedCategoryIndex: number | null;
  readonly focusedSortToggle: boolean;
  readonly focusedEmptyCta: boolean;
  readonly focusedWatchControl: LiveWatchControl | null;
  readonly focusedZapIndex: number | null;
  readonly focusedFolderIndex: number | null;
  readonly focusedNumpadKey: string | null;
  readonly handleTvKey: (event: KeyEvent) => boolean;
  readonly handleChildEdgeTop: () => void;
}

interface NavSnapshot {
  readonly zone: LiveTvZone;
  readonly headerRow: LiveTvHeaderRow;
  readonly modeCol: number;
  readonly catCol: number;
  readonly watchZone: 'controls' | 'zap' | 'folders';
  readonly watchControlIdx: number;
  readonly zapIdx: number;
  readonly folderIdx: number;
  readonly numpadRow: number;
  readonly numpadCol: number;
}

/**
 * 10-ft TV D-pad focus orchestrator for {@link LiveScreen}.
 * Coordinates `Top Nav <-> Mode Switcher <-> Category Bar (+ Sort Toggle) <-> Body` and traps D-pad
 * input inside the 4×3 `LiveNumberPad` overlay in `Channels` mode, with zero duplicate key listeners.
 */
export function useTvLiveNavigation(opts: UseTvLiveNavigationOptions): TvLiveNavigationState {
  const { isTv, isActiveScope, isEmpty, hasOpenSourcesCta, mode, categoryCount } = opts;
  const { channelCount, hasBody, zapDrawerOpen, numpadOpen, onToggleSort } = opts;
  const folderSlotCount = opts.folderSlotCount ?? 0;
  const hasAnyFavorites = opts.hasAnyFavorites ?? channelCount > 0;
  const hasCategoryBar = (mode === 'channels' || mode === 'epg') && categoryCount > 0;
  const hasSortSlot = mode === 'channels' && onToggleSort !== undefined;

  const focusMemory = useBrowseFocusMemory();
  const focusMemoryRef = useRef(focusMemory);
  focusMemoryRef.current = focusMemory;
  const savedOnMountRef = useRef<NavSnapshot | null | undefined>(undefined);
  if (savedOnMountRef.current === undefined) {
    savedOnMountRef.current = focusMemory?.get<NavSnapshot>('live') ?? null;
  }
  const pendingBodyRestoreRef = useRef(savedOnMountRef.current?.zone === 'body');

  const [nav, setNav] = useState<NavSnapshot>(() => {
    const saved = savedOnMountRef.current;
    if (saved !== null && saved !== undefined) {
      return { ...saved, folderIdx: saved.folderIdx ?? 0 };
    }
    return {
      zone: 'header',
      headerRow: 'modes',
      modeCol: modeToIndex(mode),
      catCol: 0,
      watchZone: 'controls',
      watchControlIdx: 0,
      zapIdx: 0,
      folderIdx: 0,
      numpadRow: 0,
      numpadCol: 0,
    };
  });

  const navRef = useRef(nav);
  navRef.current = nav;
  const keymap = useKeymap();
  const keymapOverridesRef = useRef<KeymapOverrides>(opts.keymapOverrides ?? keymap.overrides);
  keymapOverridesRef.current = opts.keymapOverrides ?? keymap.overrides;
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
      const maxCatCol = categoryCount > 0 ? categoryCount - 1 + (hasSortSlot ? 1 : 0) : 0;
      const nextModeCol = Math.min(prev.modeCol, maxModeCol);
      const nextCatCol = Math.min(prev.catCol, maxCatCol);
      const nextHeaderRow =
        !hasCategoryBar && prev.headerRow === 'categories' ? 'modes' : prev.headerRow;
      const nextZapIdx = channelCount > 0 ? Math.min(prev.zapIdx, channelCount - 1) : 0;
      const nextFolderIdx = folderSlotCount > 0 ? Math.min(prev.folderIdx, folderSlotCount - 1) : 0;
      const nextWatchControlIdx = Math.min(prev.watchControlIdx, WATCH_CONTROLS.length - 1);
      const hasFolderBar = zapDrawerOpen && folderSlotCount > 0 && hasAnyFavorites;
      let nextWatchZone = prev.watchZone;
      if (!zapDrawerOpen) {
        nextWatchZone = 'controls';
      } else if (prev.watchZone === 'folders' && !hasFolderBar) {
        nextWatchZone = channelCount > 0 ? 'zap' : 'controls';
      } else if (prev.watchZone === 'zap' && channelCount === 0) {
        nextWatchZone = hasFolderBar ? 'folders' : 'controls';
      }
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
        nextFolderIdx === prev.folderIdx &&
        nextWatchControlIdx === prev.watchControlIdx &&
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
        watchControlIdx: nextWatchControlIdx,
        zapIdx: nextZapIdx,
        folderIdx: nextFolderIdx,
      };
    });
  }, [
    categoryCount,
    channelCount,
    folderSlotCount,
    hasAnyFavorites,
    hasBody,
    hasCategoryBar,
    hasSortSlot,
    mode,
    zapDrawerOpen,
  ]);

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
          const folderSlots = o.folderSlotCount ?? 0;
          const hasAnyFavs = o.hasAnyFavorites ?? o.channelCount > 0;
          const hasFolders = o.zapDrawerOpen && folderSlots > 0 && hasAnyFavs;
          updateNav((p) => {
            if (cur.watchZone === 'controls' && o.zapDrawerOpen) {
              if (o.channelCount > 0) return { ...p, watchZone: 'zap' };
              if (hasFolders) return { ...p, watchZone: 'folders' };
            }
            return { ...p, zone: 'header', headerRow: 'modes' };
          });
          return true;
        }
        o.onFocusTopNav?.();
        return true;
      }

      const remapEval = evaluateRemappedEvent(keymapOverridesRef.current, 'live', event);
      if (remapEval.status === 'remapped') {
        switch (remapEval.actionId) {
          case 'live.lastChannel':
            if (o.mode === 'channels' || o.mode === 'epg') {
              o.onJumpPreviousChannel?.();
              return true;
            }
            break;
          case 'live.toggleGuide':
          case 'global.openGuide':
            if (o.onToggleGuideMode !== undefined) {
              o.onToggleGuideMode();
            } else {
              o.onSelectMode(o.mode === 'epg' ? 'channels' : 'epg');
            }
            return true;
          case 'live.openSearch':
          case 'global.openSearch':
            if (o.onOpenSearch !== undefined) {
              o.onOpenSearch();
              return true;
            }
            break;
          case 'live.toggleFavorite':
            if (o.onToggleActiveFavorite !== undefined) {
              o.onToggleActiveFavorite();
              return true;
            }
            break;
          case 'global.openHome':
            if (o.onOpenHome !== undefined) {
              o.onOpenHome();
              return true;
            }
            break;
          default:
            break;
        }
      } else if (remapEval.status === 'suppressed') {
        return true;
      }

      if (
        event.kind === 'press' &&
        event.key === 'lastChannel' &&
        (o.mode === 'channels' || o.mode === 'epg')
      ) {
        o.onJumpPreviousChannel?.();
        return true;
      }
      if (event.kind === 'press' && event.key === 'guide') {
        if (o.onToggleGuideMode !== undefined) {
          o.onToggleGuideMode();
        } else {
          o.onSelectMode(o.mode === 'epg' ? 'channels' : 'epg');
        }
        return true;
      }
      if (event.kind === 'press' && event.key === 'search' && o.onOpenSearch !== undefined) {
        o.onOpenSearch();
        return true;
      }
      if (
        event.kind === 'press' &&
        event.key === 'colorRed' &&
        o.onToggleActiveFavorite !== undefined
      ) {
        o.onToggleActiveFavorite();
        return true;
      }
      if (event.kind === 'press' && event.key === 'colorGreen' && o.onOpenHome !== undefined) {
        o.onOpenHome();
        return true;
      }

      if (event.kind !== 'press' && event.kind !== 'repeat' && event.kind !== 'long') return false;
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
      const sortSlotAvailable = o.mode === 'channels' && o.onToggleSort !== undefined;

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
            else if (o.hasBody) {
              const folderSlots = o.folderSlotCount ?? 0;
              const hasAnyFavs = o.hasAnyFavorites ?? o.channelCount > 0;
              const nextWatchZone =
                o.mode === 'favorites' && o.zapDrawerOpen
                  ? o.channelCount > 0
                    ? 'zap'
                    : folderSlots > 0 && hasAnyFavs
                      ? 'folders'
                      : 'controls'
                  : 'controls';
              updateNav((p) => ({
                ...p,
                zone: 'body',
                watchZone: nextWatchZone,
              }));
            }
          } else if (event.key === 'select' && event.kind === 'press') {
            if (cur.modeCol === 3 && o.mode === 'channels') o.onToggleNumpad();
            else {
              const target = MODE_ORDER[cur.modeCol];
              if (target) o.onSelectMode(target);
            }
          } else return false;
          return true;
        }

        const maxCatCol = Math.max(0, o.categoryCount - 1) + (sortSlotAvailable ? 1 : 0);
        if (event.key === 'up') updateNav((p) => ({ ...p, headerRow: 'modes' }));
        else if (event.key === 'left')
          updateNav((p) => ({ ...p, catCol: Math.max(0, p.catCol - 1) }));
        else if (event.key === 'right')
          updateNav((p) => ({
            ...p,
            catCol: Math.min(maxCatCol, p.catCol + 1),
          }));
        else if (event.key === 'down') {
          if (o.hasBody) updateNav((p) => ({ ...p, zone: 'body' }));
        } else if (event.key === 'select' && event.kind === 'press') {
          if (sortSlotAvailable && cur.catCol === o.categoryCount) {
            o.onToggleSort?.();
          } else {
            o.onSelectCategoryIndex(cur.catCol);
          }
        } else return false;
        return true;
      }

      if (o.mode !== 'favorites') return false;

      const folderSlots = o.folderSlotCount ?? 0;
      const hasAnyFavs = o.hasAnyFavorites ?? o.channelCount > 0;
      const hasFolders = o.zapDrawerOpen && folderSlots > 0 && hasAnyFavs;

      if (!hasAnyFavs) {
        if (event.key === 'up') updateNav((p) => ({ ...p, zone: 'header', headerRow: 'modes' }));
        else if (event.key === 'select' && event.kind === 'press')
          o.onActivateWatchControl('browse');
        else return false;
        return true;
      }

      if (cur.watchZone === 'folders') {
        if (event.key === 'up') {
          updateNav((p) => ({ ...p, zone: 'header', headerRow: 'modes' }));
        } else if (event.key === 'down') {
          if (o.channelCount > 0) updateNav((p) => ({ ...p, watchZone: 'zap', zapIdx: 0 }));
        } else if (event.key === 'left') {
          updateNav((p) => ({ ...p, folderIdx: Math.max(0, p.folderIdx - 1) }));
        } else if (event.key === 'right') {
          if (cur.folderIdx < folderSlots - 1) {
            updateNav((p) => ({ ...p, folderIdx: Math.min(folderSlots - 1, p.folderIdx + 1) }));
          } else {
            updateNav((p) => ({ ...p, watchZone: 'controls', watchControlIdx: 0 }));
          }
        } else if (event.key === 'select' && event.kind === 'press') {
          o.onActivateFolderSlot?.(cur.folderIdx);
        } else return false;
        return true;
      }

      if (cur.watchZone === 'controls') {
        if (event.key === 'up') updateNav((p) => ({ ...p, zone: 'header', headerRow: 'modes' }));
        else if (event.key === 'left') {
          if (cur.watchControlIdx <= 0 && o.zapDrawerOpen) {
            if (o.channelCount > 0) updateNav((p) => ({ ...p, watchZone: 'zap' }));
            else if (hasFolders) updateNav((p) => ({ ...p, watchZone: 'folders' }));
            else updateNav((p) => ({ ...p, watchControlIdx: Math.max(0, p.watchControlIdx - 1) }));
          } else {
            updateNav((p) => ({ ...p, watchControlIdx: Math.max(0, p.watchControlIdx - 1) }));
          }
        } else if (event.key === 'right') {
          updateNav((p) => ({
            ...p,
            watchControlIdx: Math.min(WATCH_CONTROLS.length - 1, p.watchControlIdx + 1),
          }));
        } else if (event.key === 'select' && event.kind === 'press') {
          const ctrl = WATCH_CONTROLS[cur.watchControlIdx];
          if (ctrl) o.onActivateWatchControl(ctrl);
        } else return false;
        return true;
      }

      if (event.key === 'up')
        updateNav((p) =>
          cur.zapIdx <= 0
            ? hasFolders
              ? { ...p, watchZone: 'folders' }
              : { ...p, zone: 'header', headerRow: 'modes' }
            : { ...p, zapIdx: p.zapIdx - 1 },
        );
      else if (event.key === 'down')
        updateNav((p) => ({
          ...p,
          zapIdx: Math.min(Math.max(0, o.channelCount - 1), p.zapIdx + 1),
        }));
      else if (event.key === 'right')
        updateNav((p) => ({ ...p, watchZone: 'controls', watchControlIdx: 0 }));
      else if (
        (event.key === 'select' && event.kind === 'long') ||
        (event.key === 'menu' && event.kind === 'press')
      ) {
        o.onOpenZapContextMenu?.(cur.zapIdx);
      } else if (event.key === 'select' && event.kind === 'press') o.onSelectZapIndex(cur.zapIdx);
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
  const watchCtrl: LiveWatchControl | null = !hasAnyFavorites
    ? 'browse'
    : (WATCH_CONTROLS[nav.watchControlIdx] ?? null);
  const isSortColFocused =
    inHeader &&
    nav.headerRow === 'categories' &&
    hasSortSlot &&
    categoryCount > 0 &&
    nav.catCol === categoryCount;

  return useMemo<TvLiveNavigationState>(
    () => ({
      tvZone: nav.zone,
      focusedModeIndex:
        inHeader && nav.headerRow === 'modes' && nav.modeCol < 3 ? nav.modeCol : null,
      focusedNumpadToggle:
        inHeader && nav.headerRow === 'modes' && mode === 'channels' && nav.modeCol === 3,
      focusedCategoryIndex:
        inHeader && nav.headerRow === 'categories' && !isSortColFocused ? nav.catCol : null,
      focusedSortToggle: isSortColFocused,
      focusedEmptyCta: activeTv && !numpadOpen && isEmpty && hasOpenSourcesCta,
      focusedWatchControl: inFavBody && nav.watchZone === 'controls' ? watchCtrl : null,
      focusedZapIndex: inFavBody && channelCount > 0 && nav.watchZone === 'zap' ? nav.zapIdx : null,
      focusedFolderIndex:
        inFavBody && folderSlotCount > 0 && nav.watchZone === 'folders' ? nav.folderIdx : null,
      focusedNumpadKey: numpadFocused ? (NUMPAD_GRID[nav.numpadRow]?.[nav.numpadCol] ?? '1') : null,
      handleTvKey,
      handleChildEdgeTop,
    }),
    [
      activeTv,
      channelCount,
      folderSlotCount,
      handleChildEdgeTop,
      handleTvKey,
      hasOpenSourcesCta,
      inFavBody,
      inHeader,
      isEmpty,
      isSortColFocused,
      mode,
      nav.catCol,
      nav.folderIdx,
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
