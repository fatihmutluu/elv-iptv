import type { KeyEvent } from './keys';

/** One focusable list. A 100,000-item list is only a `count`; items are never materialised here. */
export interface ListState {
  id: string;
  count: number;
  index: number;
  orientation: 'vertical' | 'horizontal';
  /** Items moved by a page move; values below 1 act as 1. */
  pageSize: number;
}

/** Result of feeding a key event to a list. */
export type MoveResult =
  | { kind: 'moved'; index: number }
  | { kind: 'edge'; side: 'start' | 'end' }
  | { kind: 'ignored' };

/** Clamps `index` into `[0, count - 1]`; an empty list or a non-finite index gives 0. */
export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(Math.max(Math.floor(index), 0), count - 1);
}

const TOWARDS_START = new Set(['up', 'left', 'channelUp']);
const TOWARDS_END = new Set(['down', 'right', 'channelDown']);

/**
 * Computes the effect of `event` on `state` without mutating it.
 *
 * Arrows act along the list orientation (the other axis is `ignored`): `press` and `repeat` move one step, `long`
 * moves a page. `channelUp` (towards index 0) and `channelDown` always move a page. Moves clamp at the ends; a move
 * that cannot change the index reports `edge`, a page that only partly fits moves to the end instead.
 */
export function moveList(state: ListState, event: KeyEvent): MoveResult {
  if (state.count <= 0) return { kind: 'ignored' };
  const { key, kind } = event;
  const channel = key === 'channelUp' || key === 'channelDown';
  if (!channel) {
    const horizontal = key === 'left' || key === 'right';
    const vertical = key === 'up' || key === 'down';
    if (state.orientation === 'vertical' ? !vertical : !horizontal) return { kind: 'ignored' };
  }
  const towardsStart = TOWARDS_START.has(key);
  if (!towardsStart && !TOWARDS_END.has(key)) return { kind: 'ignored' };
  const step = channel || kind === 'long' ? Math.max(1, Math.floor(state.pageSize)) : 1;
  const current = clampIndex(state.index, state.count);
  const target = clampIndex(current + (towardsStart ? -step : step), state.count);
  if (target === current) return { kind: 'edge', side: towardsStart ? 'start' : 'end' };
  return { kind: 'moved', index: target };
}
