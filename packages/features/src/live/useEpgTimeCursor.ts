import type { ItemRow, ProgrammeRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PagedListSource } from '../shared';
import { computeDayJumpWindowStart, localDayKey } from './epg-date-tabs';
import {
  EPG_PAN_STEP_MS,
  EPG_SLOT_MS,
  EPG_VISIBLE_SPAN_MS,
  findOverlappingProgramIndex,
  findProgramIndexAtTime,
  LIVE_PAGE_SIZE,
  layoutEpgSlots,
} from './live-model';

const MAX_ACTIVE_SCAN_PAGES = 24;

/** Subset of `EpgWindowData` consumed by {@link useEpgTimeCursor}. */
interface EpgWindowCursorPort {
  readonly windowStartMs: number;
  readonly version: number;
  readonly panEarlier: () => void;
  readonly panLater: () => void;
  readonly jumpToLive: () => void;
  readonly jumpToDay?: (dayStartMs: number) => void;
  readonly getProgrammes: (channelKey: string) => readonly ProgrammeRow[];
}

/** Focus area inside {@link EpgGridView} during 10-ft TV D-pad navigation. */
type EpgFocusArea = 'toolbar' | 'dateTabs' | 'grid';

/** Ordered TV-focusable toolbar actions rendered above the EPG matrix. */
type EpgToolbarAction = 'watch' | 'favorite' | 'refresh' | 'earlier' | 'jump' | 'later';

const BASE_TOOLBAR_ACTIONS: readonly EpgToolbarAction[] = [
  'watch',
  'refresh',
  'earlier',
  'jump',
  'later',
];
const FAV_TOOLBAR_ACTIONS: readonly EpgToolbarAction[] = [
  'watch',
  'favorite',
  'refresh',
  'earlier',
  'jump',
  'later',
];

function matchSlotIndex(
  slots: ReturnType<typeof layoutEpgSlots>,
  anchorMs: number,
  originWindow: { readonly start: number; readonly stop: number } | null = null,
): number {
  const spans = slots.map((s) => ({ start: s.startMs, stop: s.stopMs }));
  const idx =
    originWindow !== null
      ? findOverlappingProgramIndex(spans, originWindow.start, originWindow.stop, anchorMs)
      : findProgramIndexAtTime(spans, anchorMs);
  return Math.max(0, idx);
}

/** Options for {@link useEpgTimeCursor}. */
export interface UseEpgTimeCursorOptions {
  readonly categoryId: string;
  readonly channelSource: PagedListSource<ItemRow>;
  readonly channelCount: number;
  readonly maxMountedRows: number;
  readonly activeNowMs: number;
  /** Currently playing channel key to auto-focus on initial EPG open (`#6`). */
  readonly activeChannelKey?: string | null;
  /** Monotonic channel source version used to re-attempt active channel lookup as pages load. */
  readonly sourceVersion?: number;
  readonly spanMs?: number;
  readonly epgData: EpgWindowCursorPort;
  readonly dateTabCount?: number;
  readonly onSelectDateTab?: (offsetDays: number) => void;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onOpenProgrammeDetail?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow,
  ) => void;
  readonly onOpenContextMenu?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow | null,
  ) => void;
  readonly onJumpPreviousChannel?: () => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onRefreshGuide?: () => void;
  readonly onEdgeTop?: () => void;
  /** Focuses the category sidebar on Hold-Left (`long` `'left'`) or left-edge escape (`#6`, `#25`). */
  readonly onFocusSidebar?: () => void;
}

/** Memoized 2D EPG cursor and TV toolbar navigation state returned by {@link useEpgTimeCursor}. */
export interface EpgTimeCursorState {
  readonly focusedArea: EpgFocusArea;
  readonly focusedToolbarIndex: number;
  readonly focusedToolbarAction: EpgToolbarAction | null;
  readonly focusedDateTabIndex: number;
  readonly focusedRow: number;
  readonly focusedSlotIndex: number;
  /** Row index auto-focused from `activeChannelKey` on initial EPG open, or `null`. */
  readonly autoFocusedRow: number | null;
  readonly focusedChannel: ItemRow | undefined;
  readonly focusedProgramme: ProgrammeRow | null;
  readonly handlePanEarlier: () => void;
  readonly handlePanLater: () => void;
  readonly handleJumpToLive: () => void;
  readonly handleJumpToDay: (dayStartMs: number) => void;
  readonly handleSelectCell: (
    rowIdx: number,
    slotIdx: number,
    channel: ItemRow,
    programme: ProgrammeRow | null,
  ) => void;
  readonly handleTvKey: (event: KeyEvent) => boolean;
}

/**
 * Manages 2D EPG selection, 10-ft TV D-pad time-cursor alignment (`focusedRow`,
 * `focusedSlotIndex`, `anchorTimeMs`), and TV toolbar traversal (`focusedArea`,
 * `focusedToolbarIndex`) across virtualized channel rows (`#6`).
 */
export function useEpgTimeCursor({
  categoryId,
  channelSource,
  channelCount,
  maxMountedRows,
  activeNowMs,
  activeChannelKey = null,
  sourceVersion = 0,
  spanMs = EPG_VISIBLE_SPAN_MS,
  epgData,
  dateTabCount = 0,
  onSelectDateTab,
  onWatchChannel,
  onOpenProgrammeDetail,
  onOpenContextMenu,
  onJumpPreviousChannel,
  onToggleFavorite,
  onRefreshGuide,
  onEdgeTop,
  onFocusSidebar,
}: UseEpgTimeCursorOptions): EpgTimeCursorState {
  const { windowStartMs, panEarlier, panLater, jumpToLive, jumpToDay, getProgrammes } = epgData;
  const toolbarActions = onToggleFavorite ? FAV_TOOLBAR_ACTIONS : BASE_TOOLBAR_ACTIONS;

  const findActiveRow = useCallback(
    (key: string | null): number => {
      if (!key || channelCount <= 0) return -1;
      for (let i = 0; i < channelCount; i++) {
        if (channelSource.get(i)?.key === key) return i;
      }
      return -1;
    },
    [channelCount, channelSource],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: computed once on mount; late page loads are handled by the effect below
  const initialRow = useMemo(() => {
    const idx = findActiveRow(activeChannelKey);
    return Math.max(0, idx);
  }, []);

  const [focusedArea, setFocusedArea] = useState<EpgFocusArea>('grid');
  const [focusedToolbarIndex, setFocusedToolbarIndex] = useState(0);
  const [focusedDateTabIndex, setFocusedDateTabIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState(initialRow);
  const [focusedSlotIndex, setFocusedSlotIndex] = useState(0);
  const [autoFocusedRow, setAutoFocusedRow] = useState<number | null>(() =>
    activeChannelKey && findActiveRow(activeChannelKey) >= 0 ? initialRow : null,
  );
  const hasUserNavigatedRef = useRef(false);
  const appliedActiveKeyRef = useRef<string | null>(
    activeChannelKey && findActiveRow(activeChannelKey) >= 0 ? activeChannelKey : null,
  );

  const cursorRef = useRef<{
    area: EpgFocusArea;
    toolbarIdx: number;
    dateTabIdx: number;
    row: number;
    slot: number;
    anchorMs: number;
    originWindow: { readonly start: number; readonly stop: number } | null;
  }>({
    area: 'grid',
    toolbarIdx: 0,
    dateTabIdx: 0,
    row: initialRow,
    slot: 0,
    anchorMs: activeNowMs,
    originWindow: null,
  });
  cursorRef.current.area = focusedArea;
  cursorRef.current.toolbarIdx = focusedToolbarIndex;
  cursorRef.current.dateTabIdx = focusedDateTabIndex;
  cursorRef.current.row = focusedRow;
  cursorRef.current.slot = focusedSlotIndex;

  const callbacksRef = useRef({
    onWatchChannel,
    onOpenProgrammeDetail,
    onOpenContextMenu,
    onJumpPreviousChannel,
    onSelectDateTab,
    onToggleFavorite,
    onRefreshGuide,
    onEdgeTop,
    onFocusSidebar,
  });
  callbacksRef.current = {
    onWatchChannel,
    onOpenProgrammeDetail,
    onOpenContextMenu,
    onJumpPreviousChannel,
    onSelectDateTab,
    onToggleFavorite,
    onRefreshGuide,
    onEdgeTop,
    onFocusSidebar,
  };

  const commitSlot = useCallback((slotIdx: number) => {
    cursorRef.current.slot = slotIdx;
    setFocusedSlotIndex(slotIdx);
  }, []);

  const slotsFor = useCallback(
    (ch: ItemRow | undefined) =>
      ch ? layoutEpgSlots(getProgrammes(ch.key), windowStartMs, spanMs, activeNowMs) : [],
    [activeNowMs, getProgrammes, spanMs, windowStartMs],
  );

  const prevCategoryIdRef = useRef(categoryId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset cursor state when category switches
  useEffect(() => {
    if (prevCategoryIdRef.current === categoryId) return;
    prevCategoryIdRef.current = categoryId;
    hasUserNavigatedRef.current = false;
    appliedActiveKeyRef.current = null;
    cursorRef.current = {
      area: 'grid',
      toolbarIdx: 0,
      dateTabIdx: 0,
      row: 0,
      slot: 0,
      anchorMs: activeNowMs,
      originWindow: null,
    };
    setFocusedArea('grid');
    setFocusedToolbarIndex(0);
    setFocusedDateTabIndex(0);
    setFocusedRow(0);
    setFocusedSlotIndex(0);
    setAutoFocusedRow(null);
  }, [categoryId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion re-checks as paged channel chunks land
  useEffect(() => {
    if (!activeChannelKey || hasUserNavigatedRef.current) return;
    if (appliedActiveKeyRef.current === activeChannelKey) return;
    const foundIdx = findActiveRow(activeChannelKey);
    if (foundIdx < 0) return;
    appliedActiveKeyRef.current = activeChannelKey;
    cursorRef.current.row = foundIdx;
    cursorRef.current.originWindow = null;
    setFocusedRow(foundIdx);
    setAutoFocusedRow(foundIdx);
    const matchedSlots = slotsFor(channelSource.get(foundIdx));
    commitSlot(matchSlotIndex(matchedSlots, cursorRef.current.anchorMs, null));
    channelSource.prefetch(Math.max(0, foundIdx - 2), foundIdx + maxMountedRows + 2);
  }, [
    activeChannelKey,
    categoryId,
    channelCount,
    channelSource,
    commitSlot,
    findActiveRow,
    maxMountedRows,
    slotsFor,
    sourceVersion,
  ]);

  // Bounded async page scan when activeChannelKey lives on an unloaded page (>= LIVE_PAGE_SIZE).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally excludes sourceVersion so loading pages does not restart the scan
  useEffect(() => {
    if (!activeChannelKey || channelCount <= 0 || hasUserNavigatedRef.current) return;
    if (appliedActiveKeyRef.current === activeChannelKey) return;
    if (findActiveRow(activeChannelKey) >= 0) return;

    let cancelled = false;
    void (async () => {
      let pagesLoaded = 0;
      for (
        let offset = 0;
        offset < channelCount && pagesLoaded < MAX_ACTIVE_SCAN_PAGES;
        offset += LIVE_PAGE_SIZE
      ) {
        if (
          cancelled ||
          hasUserNavigatedRef.current ||
          appliedActiveKeyRef.current === activeChannelKey
        ) {
          return;
        }
        if (channelSource.get(offset) === undefined) {
          pagesLoaded++;
          await channelSource.loadItem(offset);
          if (
            cancelled ||
            hasUserNavigatedRef.current ||
            appliedActiveKeyRef.current === activeChannelKey
          ) {
            return;
          }
        }
        const end = Math.min(channelCount, offset + LIVE_PAGE_SIZE);
        for (let i = offset; i < end; i++) {
          if (channelSource.get(i)?.key === activeChannelKey) {
            appliedActiveKeyRef.current = activeChannelKey;
            cursorRef.current.row = i;
            cursorRef.current.originWindow = null;
            setFocusedRow(i);
            setAutoFocusedRow(i);
            channelSource.prefetch(Math.max(0, i - 2), i + maxMountedRows + 2);
            return;
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeChannelKey, categoryId, channelCount, channelSource, maxMountedRows]);

  useEffect(() => {
    if (channelCount > 0 && cursorRef.current.row >= channelCount) {
      cursorRef.current.row = channelCount - 1;
      setFocusedRow(channelCount - 1);
    }
  }, [channelCount]);

  const focusedChannel = channelSource.get(focusedRow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: epgData.version invalidates cached programme lookup
  const focusedSlots = useMemo(
    () => slotsFor(focusedChannel),
    [epgData.version, focusedChannel, slotsFor],
  );

  useEffect(() => {
    const nextIdx =
      focusedSlots.length === 0
        ? 0
        : matchSlotIndex(focusedSlots, cursorRef.current.anchorMs, cursorRef.current.originWindow);
    if (nextIdx !== cursorRef.current.slot) commitSlot(nextIdx);
  }, [commitSlot, focusedSlots]);

  const handlePanEarlier = useCallback(() => {
    cursorRef.current.originWindow = null;
    cursorRef.current.anchorMs = Math.max(0, windowStartMs - EPG_PAN_STEP_MS) + EPG_SLOT_MS / 2;
    panEarlier();
  }, [panEarlier, windowStartMs]);

  const handlePanLater = useCallback(() => {
    cursorRef.current.originWindow = null;
    cursorRef.current.anchorMs = windowStartMs + EPG_PAN_STEP_MS + EPG_SLOT_MS / 2;
    panLater();
  }, [panLater, windowStartMs]);

  const handleJumpToLive = useCallback(() => {
    cursorRef.current.originWindow = null;
    cursorRef.current.anchorMs = activeNowMs;
    jumpToLive();
  }, [activeNowMs, jumpToLive]);

  const handleJumpToDay = useCallback(
    (dayStartMs: number) => {
      cursorRef.current.originWindow = null;
      if (localDayKey(dayStartMs) === localDayKey(activeNowMs)) {
        cursorRef.current.anchorMs = activeNowMs;
      } else {
        const nextWindowStart = computeDayJumpWindowStart(dayStartMs, activeNowMs, windowStartMs);
        cursorRef.current.anchorMs = nextWindowStart + EPG_SLOT_MS / 2;
      }
      jumpToDay?.(dayStartMs);
    },
    [activeNowMs, jumpToDay, windowStartMs],
  );

  const handleSelectCell = useCallback(
    (rowIdx: number, slotIdx: number, channel: ItemRow, programme: ProgrammeRow | null) => {
      hasUserNavigatedRef.current = true;
      const isNonLiveProgramme =
        programme !== null && (programme.start > activeNowMs || programme.stop <= activeNowMs);
      if (isNonLiveProgramme && callbacksRef.current.onOpenProgrammeDetail !== undefined) {
        cursorRef.current.area = 'grid';
        cursorRef.current.row = rowIdx;
        cursorRef.current.originWindow = null;
        setFocusedArea('grid');
        setFocusedRow(rowIdx);
        commitSlot(slotIdx);
        cursorRef.current.anchorMs = Math.floor((programme.start + programme.stop) / 2);
        callbacksRef.current.onOpenProgrammeDetail(channel, rowIdx, programme);
        return;
      }
      if (rowIdx === cursorRef.current.row && slotIdx === cursorRef.current.slot) {
        callbacksRef.current.onWatchChannel(channel, rowIdx);
        return;
      }
      cursorRef.current.area = 'grid';
      cursorRef.current.row = rowIdx;
      cursorRef.current.originWindow = null;
      setFocusedArea('grid');
      setFocusedRow(rowIdx);
      commitSlot(slotIdx);
      if (programme !== null) {
        cursorRef.current.anchorMs = Math.floor((programme.start + programme.stop) / 2);
      }
    },
    [activeNowMs, commitSlot],
  );

  const moveRow = useCallback(
    (nextRow: number) => {
      hasUserNavigatedRef.current = true;
      const originSlot =
        slotsFor(channelSource.get(cursorRef.current.row))[cursorRef.current.slot] ?? null;
      const originProg = originSlot && !originSlot.isGap ? originSlot.programme : null;
      const originWindow =
        originProg !== null ? { start: originProg.start, stop: originProg.stop } : null;
      cursorRef.current.row = nextRow;
      cursorRef.current.originWindow = originWindow;
      setFocusedRow(nextRow);
      commitSlot(
        matchSlotIndex(
          slotsFor(channelSource.get(nextRow)),
          cursorRef.current.anchorMs,
          originWindow,
        ),
      );
      channelSource.prefetch(Math.max(0, nextRow - 2), nextRow + maxMountedRows + 2);
    },
    [channelSource, commitSlot, maxMountedRows, slotsFor],
  );

  const stepHorizontal = useCallback(
    (delta: -1 | 1) => {
      hasUserNavigatedRef.current = true;
      cursorRef.current.originWindow = null;
      const target = cursorRef.current.slot + delta;
      if (target >= 0 && target < focusedSlots.length) {
        commitSlot(target);
        const slot = focusedSlots[target];
        if (slot) cursorRef.current.anchorMs = Math.floor((slot.startMs + slot.stopMs) / 2);
        return;
      }
      cursorRef.current.anchorMs =
        delta < 0
          ? Math.max(0, windowStartMs - EPG_SLOT_MS / 2)
          : windowStartMs + spanMs + EPG_SLOT_MS / 2;
      if (delta < 0) panEarlier();
      else panLater();
    },
    [commitSlot, focusedSlots, panEarlier, panLater, spanMs, windowStartMs],
  );

  const activateToolbarAction = useCallback(
    (idx: number) => {
      const action = toolbarActions[idx];
      if (action === 'watch') {
        const ch = channelSource.get(cursorRef.current.row);
        if (ch) callbacksRef.current.onWatchChannel(ch, cursorRef.current.row);
      } else if (action === 'favorite') {
        const ch = channelSource.get(cursorRef.current.row);
        if (ch) callbacksRef.current.onToggleFavorite?.(ch);
      } else if (action === 'refresh') {
        callbacksRef.current.onRefreshGuide?.();
      } else if (action === 'earlier') {
        handlePanEarlier();
      } else if (action === 'jump') {
        handleJumpToLive();
      } else if (action === 'later') {
        handlePanLater();
      }
    },
    [channelSource, handleJumpToLive, handlePanEarlier, handlePanLater, toolbarActions],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'lastChannel') {
        callbacksRef.current.onJumpPreviousChannel?.();
        return true;
      }
      if (event.kind === 'press' && event.key === 'back') {
        callbacksRef.current.onEdgeTop?.();
        return true;
      }
      if (event.kind === 'long' && event.key === 'left') {
        const focusSidebar = callbacksRef.current.onFocusSidebar ?? callbacksRef.current.onEdgeTop;
        if (focusSidebar !== undefined) {
          focusSidebar();
          return true;
        }
        return false;
      }

      if (cursorRef.current.area === 'toolbar') {
        if (event.kind === 'press' && event.key === 'select') {
          activateToolbarAction(cursorRef.current.toolbarIdx);
          return true;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'up') {
          callbacksRef.current.onEdgeTop?.();
        } else if (event.key === 'down') {
          const nextArea: EpgFocusArea = dateTabCount > 0 ? 'dateTabs' : 'grid';
          cursorRef.current.area = nextArea;
          setFocusedArea(nextArea);
        } else if (event.key === 'left') {
          if (cursorRef.current.toolbarIdx === 0 && callbacksRef.current.onFocusSidebar) {
            callbacksRef.current.onFocusSidebar();
          } else {
            const next = Math.max(0, cursorRef.current.toolbarIdx - 1);
            cursorRef.current.toolbarIdx = next;
            setFocusedToolbarIndex(next);
          }
        } else if (event.key === 'right') {
          const next = Math.min(toolbarActions.length - 1, cursorRef.current.toolbarIdx + 1);
          cursorRef.current.toolbarIdx = next;
          setFocusedToolbarIndex(next);
        } else {
          return false;
        }
        return true;
      }

      if (cursorRef.current.area === 'dateTabs') {
        if (event.kind === 'press' && event.key === 'select') {
          callbacksRef.current.onSelectDateTab?.(cursorRef.current.dateTabIdx);
          return true;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return false;
        if (event.key === 'up') {
          cursorRef.current.area = 'toolbar';
          setFocusedArea('toolbar');
        } else if (event.key === 'down') {
          cursorRef.current.area = 'grid';
          setFocusedArea('grid');
        } else if (event.key === 'left') {
          if (cursorRef.current.dateTabIdx === 0 && callbacksRef.current.onFocusSidebar) {
            callbacksRef.current.onFocusSidebar();
          } else {
            const next = Math.max(0, cursorRef.current.dateTabIdx - 1);
            cursorRef.current.dateTabIdx = next;
            setFocusedDateTabIndex(next);
          }
        } else if (event.key === 'right') {
          const next = Math.min(Math.max(0, dateTabCount - 1), cursorRef.current.dateTabIdx + 1);
          cursorRef.current.dateTabIdx = next;
          setFocusedDateTabIndex(next);
        } else {
          return false;
        }
        return true;
      }

      if (
        (event.kind === 'long' && event.key === 'select') ||
        (event.kind === 'press' && event.key === 'menu')
      ) {
        const current = channelSource.get(cursorRef.current.row);
        if (current && callbacksRef.current.onOpenContextMenu !== undefined) {
          const prog = focusedSlots[cursorRef.current.slot]?.programme ?? null;
          callbacksRef.current.onOpenContextMenu(current, cursorRef.current.row, prog);
          return true;
        }
        return false;
      }

      if (event.kind === 'press' && event.key === 'select') {
        const current = channelSource.get(cursorRef.current.row);
        if (current) {
          const prog = focusedSlots[cursorRef.current.slot]?.programme ?? null;
          if (
            prog !== null &&
            (prog.start > activeNowMs || prog.stop <= activeNowMs) &&
            callbacksRef.current.onOpenProgrammeDetail !== undefined
          ) {
            callbacksRef.current.onOpenProgrammeDetail(current, cursorRef.current.row, prog);
          } else {
            callbacksRef.current.onWatchChannel(current, cursorRef.current.row);
          }
        }
        return true;
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      if (event.key === 'up') {
        if (cursorRef.current.row === 0) {
          const nextArea: EpgFocusArea = dateTabCount > 0 ? 'dateTabs' : 'toolbar';
          cursorRef.current.area = nextArea;
          setFocusedArea(nextArea);
        } else {
          moveRow(cursorRef.current.row - 1);
        }
        return true;
      }
      if (event.key === 'down') {
        if (cursorRef.current.row + 1 < channelCount) moveRow(cursorRef.current.row + 1);
        return true;
      }
      if (event.key === 'left') {
        stepHorizontal(-1);
        return true;
      }
      if (event.key === 'right') {
        stepHorizontal(1);
        return true;
      }
      return false;
    },
    [
      activateToolbarAction,
      activeNowMs,
      channelCount,
      channelSource,
      dateTabCount,
      focusedSlots,
      moveRow,
      stepHorizontal,
      toolbarActions,
    ],
  );

  const focusedToolbarAction =
    focusedArea === 'toolbar' ? (toolbarActions[focusedToolbarIndex] ?? null) : null;
  const focusedProgramme = focusedSlots[focusedSlotIndex]?.programme ?? null;

  return useMemo<EpgTimeCursorState>(
    () => ({
      focusedArea,
      focusedToolbarIndex,
      focusedToolbarAction,
      focusedDateTabIndex,
      focusedRow,
      focusedSlotIndex,
      autoFocusedRow,
      focusedChannel,
      focusedProgramme,
      handlePanEarlier,
      handlePanLater,
      handleJumpToLive,
      handleJumpToDay,
      handleSelectCell,
      handleTvKey,
    }),
    [
      autoFocusedRow,
      focusedArea,
      focusedChannel,
      focusedDateTabIndex,
      focusedProgramme,
      focusedRow,
      focusedSlotIndex,
      focusedToolbarAction,
      focusedToolbarIndex,
      handleJumpToDay,
      handleJumpToLive,
      handlePanEarlier,
      handlePanLater,
      handleSelectCell,
      handleTvKey,
    ],
  );
}
