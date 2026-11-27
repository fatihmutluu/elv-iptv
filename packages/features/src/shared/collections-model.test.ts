import type { VodCollectionRecord } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  type HydratedVodCollection,
  mergeHydratedCollections,
  validateCollectionNameDraft,
} from './collections-model';

function makeCol(id: string, name: string, sortOrder: number, itemCount = 0): VodCollectionRecord {
  return {
    id,
    profileId: 'default',
    name,
    sortOrder,
    itemCount,
    createdAt: 1000 + sortOrder,
    updatedAt: 1000 + sortOrder,
  };
}

describe('collections-model (#403, #508)', () => {
  it('validates and trims collection name drafts rejecting blank, control chars, and overlong names', () => {
    expect(validateCollectionNameDraft('  Sci-Fi Picks  ')).toBe('Sci-Fi Picks');
    expect(validateCollectionNameDraft('   ')).toBeNull();
    expect(validateCollectionNameDraft('Bad\nName')).toBeNull();
    expect(validateCollectionNameDraft('a'.repeat(81))).toBeNull();
  });

  it('keeps previous hydrated collections on failed refresh (null) and replaces on success', () => {
    const prev: HydratedVodCollection[] = [{ collection: makeCol('c1', 'A', 0), items: [] }];
    const next: HydratedVodCollection[] = [{ collection: makeCol('c2', 'B', 0), items: [] }];
    expect(mergeHydratedCollections(null, prev)).toBe(prev);
    expect(mergeHydratedCollections(next, prev)).toBe(next);
  });
});
