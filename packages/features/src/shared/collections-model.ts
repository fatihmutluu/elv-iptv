import { type ItemRow, MAX_VOD_COLLECTION_NAME_LENGTH, type VodCollectionRecord } from '@elv/data';

/** Hydrated custom VOD collection pairing collection metadata with parental-filtered items (`#403`). */
export interface HydratedVodCollection {
  readonly collection: VodCollectionRecord;
  readonly items: readonly ItemRow[];
}

/** One focusable row inside {@link CollectionPickerOverlay} for 10-ft TV 2D D-pad traversal. */
export type CollectionPickerFocusRow =
  | { readonly kind: 'close'; readonly cols: readonly ['close'] }
  | {
      readonly kind: 'collection';
      readonly collectionId: string;
      readonly cols: readonly ['toggle'];
    }
  | { readonly kind: 'create'; readonly cols: readonly ['input', 'create'] };

/** Action identifier for a collection header row inside {@link CollectionManagerOverlay}. */
export type CollectionManagerRowAction = 'expand' | 'rename' | 'moveUp' | 'moveDown' | 'delete';

/** Action identifier for an expanded item row inside {@link CollectionManagerOverlay}. */
export type CollectionManagerItemAction = 'open' | 'moveUp' | 'moveDown' | 'remove';

/** One focusable row inside {@link CollectionManagerOverlay} for 10-ft TV 2D D-pad traversal. */
export type CollectionManagerFocusRow =
  | { readonly kind: 'close'; readonly cols: readonly ['close'] }
  | { readonly kind: 'create'; readonly cols: readonly ['input', 'create'] }
  | {
      readonly kind: 'collection';
      readonly collectionId: string;
      readonly cols: readonly CollectionManagerRowAction[];
    }
  | {
      readonly kind: 'edit';
      readonly collectionId: string;
      readonly cols: readonly ['input', 'save', 'cancel'];
    }
  | {
      readonly kind: 'item';
      readonly collectionId: string;
      readonly itemKey: string;
      readonly cols: readonly CollectionManagerItemAction[];
    };

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Validates and trims a draft collection name; returns `null` if blank, too long, or invalid. */
export function validateCollectionNameDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_VOD_COLLECTION_NAME_LENGTH ||
    hasControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** Moves a collection one slot up (`-1`) or down (`1`), updating contiguous `sortOrder` values. */
export function moveCollectionOrder(
  collections: readonly VodCollectionRecord[],
  collectionId: string,
  delta: -1 | 1,
): readonly VodCollectionRecord[] | null {
  const index = collections.findIndex((c) => c.id === collectionId);
  if (index < 0) return null;
  const targetIndex = index + delta;
  if (targetIndex < 0 || targetIndex >= collections.length) return null;

  const next = [...collections];
  const current = next[index];
  const swap = next[targetIndex];
  if (current === undefined || swap === undefined) return null;
  next[index] = swap;
  next[targetIndex] = current;
  return next.map((col, sortOrder) => (col.sortOrder === sortOrder ? col : { ...col, sortOrder }));
}

/** Moves a title one slot up (`-1`) or down (`1`) inside a collection's ordered items list. */
export function moveCollectionItemOrder<T extends { readonly key: string }>(
  items: readonly T[],
  itemKey: string,
  delta: -1 | 1,
): readonly T[] | null {
  const index = items.findIndex((item) => item.key === itemKey);
  if (index < 0) return null;
  const targetIndex = index + delta;
  if (targetIndex < 0 || targetIndex >= items.length) return null;

  const next = [...items];
  const current = next[index];
  const swap = next[targetIndex];
  if (current === undefined || swap === undefined) return null;
  next[index] = swap;
  next[targetIndex] = current;
  return next;
}

/** Immutably toggles `collectionId` membership in a Set of collection IDs. */
export function toggleMembershipSet(
  current: ReadonlySet<string>,
  collectionId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(collectionId)) next.delete(collectionId);
  else next.add(collectionId);
  return next;
}

/** Optimistically adjusts a collection's displayed `itemCount` after an add/remove toggle. */
export function applyCollectionMembershipDelta(
  collections: readonly VodCollectionRecord[],
  collectionId: string,
  added: boolean,
): readonly VodCollectionRecord[] {
  return collections.map((col) =>
    col.id === collectionId
      ? { ...col, itemCount: Math.max(0, col.itemCount + (added ? 1 : -1)) }
      : col,
  );
}

/** Keeps previously rendered collections on failed refresh (`null`) for zero-blink Home updates. */
export function mergeHydratedCollections(
  fetched: readonly HydratedVodCollection[] | null,
  previous: readonly HydratedVodCollection[],
): readonly HydratedVodCollection[] {
  return fetched === null ? previous : fetched;
}

/** Builds ordered 2D TV focus rows for {@link CollectionPickerOverlay}. */
export function buildCollectionPickerFocusRows(
  collections: readonly VodCollectionRecord[],
): readonly CollectionPickerFocusRow[] {
  const rows: CollectionPickerFocusRow[] = [{ kind: 'close', cols: ['close'] }];
  for (const col of collections) {
    rows.push({ kind: 'collection', collectionId: col.id, cols: ['toggle'] });
  }
  rows.push({ kind: 'create', cols: ['input', 'create'] });
  return rows;
}

/** Builds ordered 2D TV focus rows for {@link CollectionManagerOverlay}. */
export function buildCollectionManagerFocusRows(input: {
  readonly collections: readonly VodCollectionRecord[];
  readonly editingId: string | null;
  readonly expandedId: string | null;
  readonly itemsByCollectionId: Readonly<Record<string, readonly ItemRow[]>>;
}): readonly CollectionManagerFocusRow[] {
  const rows: CollectionManagerFocusRow[] = [
    { kind: 'close', cols: ['close'] },
    { kind: 'create', cols: ['input', 'create'] },
  ];

  for (let i = 0; i < input.collections.length; i += 1) {
    const col = input.collections[i];
    if (col === undefined) continue;
    if (input.editingId === col.id) {
      rows.push({ kind: 'edit', collectionId: col.id, cols: ['input', 'save', 'cancel'] });
    } else {
      const cols: CollectionManagerRowAction[] = ['expand', 'rename'];
      if (i > 0) cols.push('moveUp');
      if (i < input.collections.length - 1) cols.push('moveDown');
      cols.push('delete');
      rows.push({ kind: 'collection', collectionId: col.id, cols });
    }

    if (input.expandedId === col.id) {
      const items = input.itemsByCollectionId[col.id] ?? [];
      for (let j = 0; j < items.length; j += 1) {
        const item = items[j];
        if (item === undefined) continue;
        const itemCols: CollectionManagerItemAction[] = ['open'];
        if (j > 0) itemCols.push('moveUp');
        if (j < items.length - 1) itemCols.push('moveDown');
        itemCols.push('remove');
        rows.push({ kind: 'item', collectionId: col.id, itemKey: item.key, cols: itemCols });
      }
    }
  }

  return rows;
}

/** Pure 2D TV directional navigation step over {@link CollectionManagerFocusRow} rows. */
export function stepCollectionManagerFocus(
  rows: readonly CollectionManagerFocusRow[],
  rowIndex: number,
  colIndex: number,
  key: 'up' | 'down' | 'left' | 'right',
): { readonly row: number; readonly col: number } {
  if (rows.length === 0) return { row: 0, col: 0 };
  const clampedRow = Math.min(Math.max(0, rowIndex), rows.length - 1);
  if (key === 'up' || key === 'down') {
    const nextRow =
      key === 'up' ? Math.max(0, clampedRow - 1) : Math.min(rows.length - 1, clampedRow + 1);
    const maxCol = Math.max(0, (rows[nextRow]?.cols.length ?? 1) - 1);
    return { row: nextRow, col: Math.min(Math.max(0, colIndex), maxCol) };
  }
  const maxCol = Math.max(0, (rows[clampedRow]?.cols.length ?? 1) - 1);
  const nextCol =
    key === 'left' ? Math.max(0, colIndex - 1) : Math.min(maxCol, Math.max(0, colIndex) + 1);
  return { row: clampedRow, col: nextCol };
}
