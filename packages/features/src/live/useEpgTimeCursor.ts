import type { ItemRow, ProgrammeRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PagedListSource } from '../shared';
import {
  EPG_PAN_STEP_MS,
  EPG_SLOT_MS,
  EPG_VISIBLE_SPAN_MS,
  findProgramIndexAtTime,
  layoutEpgSlots,
} from './live-model';

/** Subset of `EpgWindowData` consumed by {@link useEpgTimeCursor}. */
interface EpgWindowCursorPort {
  readonly windowStartMs: number;
  readonly version: number;
  readonly panEarlier: () => void;
  readonly panLater: () => void;
  readonly jumpToLive: () => void;
  readonly getProgrammes: (channelKey: string) => readonly ProgrammeRow[];
}

/** Focus area inside {@link EpgGridView} during 10-ft TV D-pad navigation. */
type EpgFocusArea = 'toolbar' | 'grid';

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

function matchSlotIndex(slots: ReturnType<typeof layoutEpgSlots>, anchorMs: number): number {
  return Math.max(
    0,
    findProgramIndexAtTime(
      slots.map((s) => s.programme),
      anchorMs,
    ),
  );
}

/** Options for {@link useEpgTimeCursor}. */
export interface UseEpgTimeCursorOptions {
  readonly categoryId: string;
  readonly channelSource: PagedListSource<ItemRow>;
  readonly channelCount: number;
  readonly maxMountedRows: number;
  readonly activeNowMs: number;
  readonly epgData: EpgWindowCursorPort;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onRefreshGuide?: () => void;
  readonly onEdgeTop?: () => void;
}

/** Memoized 2D EPG cursor and TV toolbar navigation state returned by {@link useEpgTimeCursor}. */
export interface EpgTimeCursorState {
  readonly focusedArea: EpgFocusArea;
  readonly focusedToolbarIndex: number;
  readonly focusedToolbarAction: EpgToolbarAction | null;
  readonly focusedRow: number;
  readonly focusedSlotIndex: number;
  readonly focusedChannel: ItemRow | undefined;
  readonly focusedProgramme: ProgrammeRow | null;
  readonly handlePanEarlier: () => void;
  readonly handlePanLater: () => void;
  readonly handleJumpToLive: () => void;
  readonly handleSelectCell: (
    rowIdx: number,
    slotIdx: number,
    channel: ItemRow,
    programme: ProgrammeRow | null,
  ) => void;
  readonly handleTvKey: (event: KeyEvent) => void;
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
  epgData,
  onWatchChannel,
  onToggleFavorite,
  onRefreshGuide,
  onEdgeTop,
}: UseEpgTimeCursorOptions): EpgTimeCursorState {
  const { windowStartMs, panEarlier, panLater, jumpToLive, getProgrammes } = epgData;
  const toolbarActions = onToggleFavorite ? FAV_TOOLBAR_ACTIONS : BASE_TOOLBAR_ACTIONS;

  const [focusedArea, setFocusedArea] = useState<EpgFocusArea>('grid');
  const [focusedToolbarIndex, setFocusedToolbarIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState(0);
  const [focusedSlotIndex, setFocusedSlotIndex] = useState(0);

  const cursorRef = useRef({
    area: 'grid' as EpgFocusArea,
    toolbarIdx: 0,
    row: 0,
    slot: 0,
    anchorMs: activeNowMs,
  });
  cursorRef.current.area = focusedArea;
  cursorRef.current.toolbarIdx = focusedToolbarIndex;
  cursorRef.current.row = focusedRow;
  cursorRef.current.slot = focusedSlotIndex;

  const callbacksRef = useRef({ onWatchChannel, onToggleFavorite, onRefreshGuide, onEdgeTop });
  callbacksRef.current = { onWatchChannel, onToggleFavorite, onRefreshGuide, onEdgeTop };

  const commitSlot = useCallback((slotIdx: number) => {
    cursorRef.current.slot = slotIdx;
    setFocusedSlotIndex(slotIdx);
  }, []);

  const slotsFor = useCallback(
    (ch: ItemRow | undefined) =>
      ch
        ? layoutEpgSlots(getProgrammes(ch.key), windowStartMs, EPG_VISIBLE_SPAN_MS, activeNowMs)
        : [],
    [activeNowMs, getProgrammes, windowStartMs],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset cursor state when category switches
  useEffect(() => {
    cursorRef.current = { area: 'grid', toolbarIdx: 0, row: 0, slot: 0, anchorMs: activeNowMs };
    setFocusedArea('grid');
    setFocusedToolbarIndex(0);
    setFocusedRow(0);
    setFocusedSlotIndex(0);
  }, [categoryId]);

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
      focusedSlots.length === 0 ? 0 : matchSlotIndex(focusedSlots, cursorRef.current.anchorMs);
    if (nextIdx !== cursorRef.current.slot) commitSlot(nextIdx);
  }, [commitSlot, focusedSlots]);

  const handlePanEarlier = useCallback(() => {
    cursorRef.current.anchorMs = Math.max(0, windowStartMs - EPG_PAN_STEP_MS) + EPG_SLOT_MS / 2;
    panEarlier();
  }, [panEarlier, windowStartMs]);

  const handlePanLater = useCallback(() => {
    cursorRef.current.anchorMs = windowStartMs + EPG_PAN_STEP_MS + EPG_SLOT_MS / 2;
    panLater();
  }, [panLater, windowStartMs]);

  const handleJumpToLive = useCallback(() => {
    cursorRef.current.anchorMs = activeNowMs;
    jumpToLive();
  }, [activeNowMs, jumpToLive]);

  const handleSelectCell = useCallback(
    (rowIdx: number, slotIdx: number, channel: ItemRow, programme: ProgrammeRow | null) => {
      if (rowIdx === cursorRef.current.row && slotIdx === cursorRef.current.slot) {
        callbacksRef.current.onWatchChannel(channel, rowIdx);
        return;
      }
      cursorRef.current.area = 'grid';
      cursorRef.current.row = rowIdx;
      setFocusedArea('grid');
      setFocusedRow(rowIdx);
      commitSlot(slotIdx);
      if (programme !== null) {
        cursorRef.current.anchorMs = Math.floor((programme.start + programme.stop) / 2);
      }
    },
    [commitSlot],
  );

  const moveRow = useCallback(
    (nextRow: number) => {
      cursorRef.current.row = nextRow;
      setFocusedRow(nextRow);
      commitSlot(matchSlotIndex(slotsFor(channelSource.get(nextRow)), cursorRef.current.anchorMs));
      channelSource.prefetch(Math.max(0, nextRow - 2), nextRow + maxMountedRows + 2);
    },
    [channelSource, commitSlot, maxMountedRows, slotsFor],
  );

  const stepHorizontal = useCallback(
    (delta: -1 | 1) => {
      const target = cursorRef.current.slot + delta;
      if (target >= 0 && target < focusedSlots.length) {
        commitSlot(target);
        const prog = focusedSlots[target]?.programme;
        if (prog) cursorRef.current.anchorMs = Math.floor((prog.start + prog.stop) / 2);
        return;
      }
      cursorRef.current.anchorMs =
        delta < 0
          ? Math.max(0, windowStartMs - EPG_SLOT_MS / 2)
          : windowStartMs + EPG_VISIBLE_SPAN_MS + EPG_SLOT_MS / 2;
      if (delta < 0) panEarlier();
      else panLater();
    },
    [commitSlot, focusedSlots, panEarlier, panLater, windowStartMs],
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
    (event: KeyEvent) => {
      if (event.kind === 'press' && event.key === 'back') return callbacksRef.current.onEdgeTop?.();

      if (cursorRef.current.area === 'toolbar') {
        if (event.kind === 'press' && event.key === 'select') {
          activateToolbarAction(cursorRef.current.toolbarIdx);
          return;
        }
        if (event.kind !== 'press' && event.kind !== 'repeat') return;
        if (event.key === 'up') {
          callbacksRef.current.onEdgeTop?.();
        } else if (event.key === 'down') {
          cursorRef.current.area = 'grid';
          setFocusedArea('grid');
        } else if (event.key === 'left') {
          const next = Math.max(0, cursorRef.current.toolbarIdx - 1);
          cursorRef.current.toolbarIdx = next;
          setFocusedToolbarIndex(next);
        } else if (event.key === 'right') {
          const next = Math.min(toolbarActions.length - 1, cursorRef.current.toolbarIdx + 1);
          cursorRef.current.toolbarIdx = next;
          setFocusedToolbarIndex(next);
        }
        return;
      }

      if (event.kind === 'press' && event.key === 'select') {
        const current = channelSource.get(cursorRef.current.row);
        if (current) callbacksRef.current.onWatchChannel(current, cursorRef.current.row);
        return;
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return;
      if (event.key === 'up') {
        if (cursorRef.current.row === 0) {
          cursorRef.current.area = 'toolbar';
          setFocusedArea('toolbar');
        } else {
          moveRow(cursorRef.current.row - 1);
        }
      } else if (event.key === 'down') {
        if (cursorRef.current.row + 1 < channelCount) moveRow(cursorRef.current.row + 1);
      } else if (event.key === 'left') {
        stepHorizontal(-1);
      } else if (event.key === 'right') {
        stepHorizontal(1);
      }
    },
    [activateToolbarAction, channelCount, channelSource, moveRow, stepHorizontal, toolbarActions],
  );

  const focusedToolbarAction =
    focusedArea === 'toolbar' ? (toolbarActions[focusedToolbarIndex] ?? null) : null;
  const focusedProgramme = focusedSlots[focusedSlotIndex]?.programme ?? null;

  return useMemo<EpgTimeCursorState>(
    () => ({
      focusedArea,
      focusedToolbarIndex,
      focusedToolbarAction,
      focusedRow,
      focusedSlotIndex,
      focusedChannel,
      focusedProgramme,
      handlePanEarlier,
      handlePanLater,
      handleJumpToLive,
      handleSelectCell,
      handleTvKey,
    }),
    [
      focusedArea,
      focusedChannel,
      focusedProgramme,
      focusedRow,
      focusedSlotIndex,
      focusedToolbarAction,
      focusedToolbarIndex,
      handleJumpToLive,
      handlePanEarlier,
      handlePanLater,
      handleSelectCell,
      handleTvKey,
    ],
  );
}
