import type { ItemRow, VodCollectionRecord } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  applyCollectionMembershipDelta,
  buildCollectionManagerFocusRows,
  buildCollectionPickerFocusRows,
  type HydratedVodCollection,
  mergeHydratedCollections,
  moveCollectionItemOrder,
  moveCollectionOrder,
  stepCollectionManagerFocus,
  toggleMembershipSet,
  validateCollectionNameDraft,
} from './collections-model';

const makeCol = (
  id: string,
  name: string,
  sortOrder: number,
  itemCount = 0,
): VodCollectionRecord => ({
  id,
  profileId: 'default',
  name,
  sortOrder,
  itemCount,
  createdAt: 1000 + sortOrder,
  updatedAt: 1000 + sortOrder,
});

const makeItem = (key: string, name: string, kind: 'movie' | 'series' = 'movie'): ItemRow => ({
  id: 1,
  key,
  kind,
  sourceId: 's1',
  providerId: '1',
  name,
  logo: null,
  rating: 8.2,
  year: 2025,
  num: null,
});

describe('collections-model (#403)', () => {
  describe('validateCollectionNameDraft', () => {
    it('trims valid names and rejects blank, control chars, or > 80 char drafts', () => {
      expect(validateCollectionNameDraft('  Weekend Sci-Fi  ')).toBe('Weekend Sci-Fi');
      expect(validateCollectionNameDraft('   ')).toBeNull();
      expect(validateCollectionNameDraft('')).toBeNull();
      expect(validateCollectionNameDraft('Bad\nName')).toBeNull();
      expect(validateCollectionNameDraft('Bad\x7fName')).toBeNull();
      expect(validateCollectionNameDraft('A'.repeat(80))).toBe('A'.repeat(80));
      expect(validateCollectionNameDraft('A'.repeat(81))).toBeNull();
    });
  });

  describe('moveCollectionOrder', () => {
    it('moves a collection up or down and rewrites contiguous sortOrder', () => {
      const list = [makeCol('c1', 'Alpha', 0), makeCol('c2', 'Beta', 1), makeCol('c3', 'Gamma', 2)];

      const movedUp = moveCollectionOrder(list, 'c2', -1);
      expect(movedUp?.map((c) => [c.id, c.sortOrder])).toEqual([
        ['c2', 0],
        ['c1', 1],
        ['c3', 2],
      ]);

      const movedDown = moveCollectionOrder(list, 'c2', 1);
      expect(movedDown?.map((c) => [c.id, c.sortOrder])).toEqual([
        ['c1', 0],
        ['c3', 1],
        ['c2', 2],
      ]);

      expect(moveCollectionOrder(list, 'c1', -1)).toBeNull();
      expect(moveCollectionOrder(list, 'c3', 1)).toBeNull();
      expect(moveCollectionOrder(list, 'missing', 1)).toBeNull();
    });
  });

  describe('moveCollectionItemOrder', () => {
    it('moves items up/down within a collection and returns null at boundaries or missing key', () => {
      const items = [makeItem('m1', 'One'), makeItem('m2', 'Two'), makeItem('m3', 'Three')];

      expect(moveCollectionItemOrder(items, 'm2', -1)?.map((i) => i.key)).toEqual([
        'm2',
        'm1',
        'm3',
      ]);
      expect(moveCollectionItemOrder(items, 'm2', 1)?.map((i) => i.key)).toEqual([
        'm1',
        'm3',
        'm2',
      ]);
      expect(moveCollectionItemOrder(items, 'm1', -1)).toBeNull();
      expect(moveCollectionItemOrder(items, 'm3', 1)).toBeNull();
      expect(moveCollectionItemOrder(items, 'missing', -1)).toBeNull();
    });
  });

  describe('toggleMembershipSet & applyCollectionMembershipDelta', () => {
    it('toggles collection IDs immutably and adjusts item counts without going negative', () => {
      const initial = new Set<string>(['c1']);
      const added = toggleMembershipSet(initial, 'c2');
      expect(Array.from(added)).toEqual(['c1', 'c2']);
      expect(Array.from(initial)).toEqual(['c1']);

      const removed = toggleMembershipSet(added, 'c1');
      expect(Array.from(removed)).toEqual(['c2']);

      const cols = [makeCol('c1', 'Alpha', 0, 0), makeCol('c2', 'Beta', 1, 2)];
      const inc = applyCollectionMembershipDelta(cols, 'c1', true);
      expect(inc.map((c) => c.itemCount)).toEqual([1, 2]);
      const dec = applyCollectionMembershipDelta(cols, 'c1', false);
      expect(dec.map((c) => c.itemCount)).toEqual([0, 2]);
      const decBeta = applyCollectionMembershipDelta(cols, 'c2', false);
      expect(decBeta.map((c) => c.itemCount)).toEqual([0, 1]);
    });
  });

  describe('mergeHydratedCollections', () => {
    it('keeps previous hydrated collections on refresh error and replaces cleanly on fresh data', () => {
      const prev: HydratedVodCollection[] = [
        { collection: makeCol('c1', 'Alpha', 0, 1), items: [makeItem('m1', 'One')] },
      ];
      const next: HydratedVodCollection[] = [
        { collection: makeCol('c2', 'Beta', 0, 1), items: [makeItem('m2', 'Two')] },
      ];
      expect(mergeHydratedCollections(null, prev)).toBe(prev);
      expect(mergeHydratedCollections(next, prev)).toBe(next);
      expect(mergeHydratedCollections([], prev)).toEqual([]);
    });
  });

  describe('buildCollectionPickerFocusRows', () => {
    it('builds close -> collection toggles -> inline create row for 2D TV D-pad traversal', () => {
      const rows = buildCollectionPickerFocusRows([makeCol('c1', 'A', 0), makeCol('c2', 'B', 1)]);
      expect(rows).toEqual([
        { kind: 'close', cols: ['close'] },
        { kind: 'collection', collectionId: 'c1', cols: ['toggle'] },
        { kind: 'collection', collectionId: 'c2', cols: ['toggle'] },
        { kind: 'create', cols: ['input', 'create'] },
      ]);
    });
  });

  describe('buildCollectionManagerFocusRows', () => {
    it('builds deterministic 2D focus rows for create, rename, reorder, expand, and item actions', () => {
      const cols = [makeCol('c1', 'First', 0, 2), makeCol('c2', 'Second', 1, 0)];
      const itemsByCol: Record<string, readonly ItemRow[]> = {
        c1: [makeItem('m1', 'One'), makeItem('m2', 'Two')],
      };

      const rows = buildCollectionManagerFocusRows({
        collections: cols,
        editingId: 'c2',
        expandedId: 'c1',
        itemsByCollectionId: itemsByCol,
      });

      expect(rows).toEqual([
        { kind: 'close', cols: ['close'] },
        { kind: 'create', cols: ['input', 'create'] },
        {
          kind: 'collection',
          collectionId: 'c1',
          cols: ['expand', 'rename', 'moveDown', 'delete'],
        },
        { kind: 'item', collectionId: 'c1', itemKey: 'm1', cols: ['open', 'moveDown', 'remove'] },
        { kind: 'item', collectionId: 'c1', itemKey: 'm2', cols: ['open', 'moveUp', 'remove'] },
        { kind: 'edit', collectionId: 'c2', cols: ['input', 'save', 'cancel'] },
      ]);
    });

    it('includes moveUp and omits moveDown for last collection and handles single-item collections', () => {
      const cols = [makeCol('c1', 'First', 0, 1), makeCol('c2', 'Second', 1, 1)];
      const rows = buildCollectionManagerFocusRows({
        collections: cols,
        editingId: null,
        expandedId: 'c2',
        itemsByCollectionId: { c2: [makeItem('m9', 'Solo')] },
      });

      expect(rows).toEqual([
        { kind: 'close', cols: ['close'] },
        { kind: 'create', cols: ['input', 'create'] },
        {
          kind: 'collection',
          collectionId: 'c1',
          cols: ['expand', 'rename', 'moveDown', 'delete'],
        },
        { kind: 'collection', collectionId: 'c2', cols: ['expand', 'rename', 'moveUp', 'delete'] },
        { kind: 'item', collectionId: 'c2', itemKey: 'm9', cols: ['open', 'remove'] },
      ]);
    });

    it('steps 2D focus across rows and clamps column indices cleanly', () => {
      const rows = buildCollectionManagerFocusRows({
        collections: [makeCol('c1', 'First', 0, 1)],
        editingId: null,
        expandedId: null,
        itemsByCollectionId: {},
      });
      expect(stepCollectionManagerFocus(rows, 2, 2, 'right')).toEqual({ row: 2, col: 2 });
      expect(stepCollectionManagerFocus(rows, 2, 2, 'up')).toEqual({ row: 1, col: 1 });
      expect(stepCollectionManagerFocus(rows, 1, 1, 'left')).toEqual({ row: 1, col: 0 });
      expect(stepCollectionManagerFocus(rows, 0, 0, 'up')).toEqual({ row: 0, col: 0 });
      expect(stepCollectionManagerFocus([], 0, 0, 'down')).toEqual({ row: 0, col: 0 });
    });
  });
});
