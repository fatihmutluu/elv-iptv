import { describe, expect, it } from 'vitest';
import { computeDragTargetIndex, moveFavoriteItem } from './live-favorite-reorder';

describe('moveFavoriteItem', () => {
  it('moves an item earlier in the list without mutating the input', () => {
    const input = ['a', 'b', 'c', 'd'] as const;
    const result = moveFavoriteItem(input, 3, 1);
    expect(result).toEqual(['a', 'd', 'b', 'c']);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves an item later in the list without mutating the input', () => {
    const input = ['a', 'b', 'c', 'd'] as const;
    const result = moveFavoriteItem(input, 0, 2);
    expect(result).toEqual(['b', 'c', 'a', 'd']);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns the same reference for no-op or out-of-bounds indices', () => {
    const input = ['a', 'b', 'c'] as const;
    expect(moveFavoriteItem(input, 1, 1)).toBe(input);
    expect(moveFavoriteItem(input, -1, 1)).toBe(input);
    expect(moveFavoriteItem(input, 0, 3)).toBe(input);
    expect(moveFavoriteItem(input, 0.5, 1)).toBe(input);
    expect(moveFavoriteItem([], 0, 0)).toEqual([]);
    const single = ['only'] as const;
    expect(moveFavoriteItem(single, 0, 0)).toBe(single);
  });
});

describe('computeDragTargetIndex', () => {
  it('computes the target index from pointer deltaY and clamps to bounds', () => {
    expect(computeDragTargetIndex(1, 0, 54, 5)).toBe(1);
    expect(computeDragTargetIndex(1, 54, 54, 5)).toBe(2);
    expect(computeDragTargetIndex(1, 110, 54, 5)).toBe(3);
    expect(computeDragTargetIndex(1, -54, 54, 5)).toBe(0);
    expect(computeDragTargetIndex(1, -500, 54, 5)).toBe(0);
    expect(computeDragTargetIndex(1, 500, 54, 5)).toBe(4);
  });

  it('handles degenerate counts and row heights safely', () => {
    expect(computeDragTargetIndex(0, 100, 54, 0)).toBe(0);
    expect(computeDragTargetIndex(0, 100, 54, 1)).toBe(0);
    expect(computeDragTargetIndex(2, 100, 0, 5)).toBe(2);
  });
});
