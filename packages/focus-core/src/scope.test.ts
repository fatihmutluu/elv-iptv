import { describe, expect, it } from 'vitest';
import type { ListState } from './list';
import { createScope, findList, setListIndex, withCount } from './scope';

const l = (id: string, over: Partial<ListState> = {}): ListState => ({
  id,
  count: 10,
  index: 0,
  orientation: 'vertical',
  pageSize: 5,
  ...over,
});

describe('createScope', () => {
  it('builds a scope keyed by list id with clamped indices', () => {
    const s = createScope('s', [l('a', { index: 99 }), l('b')], 'a');
    expect(Object.keys(s.lists)).toEqual(['a', 'b']);
    expect(s.lists.a?.index).toBe(9);
    expect(s.active).toBe('a');
  });

  it('rejects an unknown active list, duplicates and an empty scope', () => {
    expect(() => createScope('s', [l('a')], 'x')).toThrow();
    expect(() => createScope('s', [l('a'), l('a')], 'a')).toThrow();
    expect(() => createScope('s', [], 'a')).toThrow();
  });
});

describe('scope helpers', () => {
  const root = createScope('root', [l('a'), l('b')], 'a');
  const top = createScope('top', [l('b', { index: 3 })], 'b');

  it('finds the topmost scope owning a list', () => {
    expect(findList([root, top], 'b')).toEqual({ scope: 1, list: top.lists.b });
    expect(findList([root, top], 'a')?.scope).toBe(0);
    expect(findList([root, top], 'zzz')).toBeUndefined();
  });

  it('updates an index immutably', () => {
    const next = setListIndex([root, top], 0, 'a', 4);
    expect(next[0]?.lists.a?.index).toBe(4);
    expect(root.lists.a?.index).toBe(0);
    expect(next[1]).toBe(top);
  });

  it('applies a count and clamps the index', () => {
    const scoped = createScope('s', [l('a', { index: 8 })], 'a');
    const next = withCount([scoped], 0, 'a', 3);
    expect(next[0]?.lists.a).toMatchObject({ count: 3, index: 2 });
    expect(withCount([scoped], 0, 'a', -5)[0]?.lists.a).toMatchObject({ count: 0, index: 0 });
  });
});
