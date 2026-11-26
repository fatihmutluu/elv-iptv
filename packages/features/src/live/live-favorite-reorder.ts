/**
 * Pure immutably-reordering helper for Live Favorites drag-and-drop and Move Up / Move Down actions.
 * Returns the original array reference when indices are identical, non-integer, or out of range.
 */
export function moveFavoriteItem<T>(
  list: readonly T[],
  fromIndex: number,
  toIndex: number,
): readonly T[] {
  const len = list.length;
  if (
    len < 2 ||
    fromIndex === toIndex ||
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= len ||
    toIndex < 0 ||
    toIndex >= len
  ) {
    return list;
  }
  const next = list.slice();
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return list;
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Computes the clamped target row index during a vertical pointer drag inside `LiveZapDrawer`.
 */
export function computeDragTargetIndex(
  startIndex: number,
  deltaY: number,
  rowHeight: number,
  itemCount: number,
): number {
  if (itemCount <= 1) return 0;
  const maxIndex = itemCount - 1;
  if (rowHeight <= 0) {
    return Math.max(0, Math.min(maxIndex, startIndex));
  }
  const offset = Math.round(deltaY / rowHeight);
  return Math.max(0, Math.min(maxIndex, startIndex + offset));
}
