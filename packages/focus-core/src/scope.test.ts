import { describe, expect, it } from 'vitest';
import type { ListState } from './list';
import {
  createScope,
  findList,
  hasNonEmptyList,
  resolveFallbackId,
  setListIndex,
  withCount,
} from './scope';

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

  it('immediately resolves active to a reachable non-empty fallback when initial active list is empty (#112)', () => {
    const direct = createScope(
      's',
      [l('items', { count: 0, fallbackId: 'cats' }), l('cats', { count: 6, index: 2 })],
      'items',
    );
    expect(direct.active).toBe('cats');

    const chained = createScope(
      's',
      [
        l('items', { count: 0, fallbackId: 'sub' }),
        l('sub', { count: 0, fallbackId: 'rail' }),
        l('rail', { count: 3 }),
      ],
      'items',
    );
    expect(chained.active).toBe('rail');

    const allEmpty = createScope(
      's',
      [l('items', { count: 0, fallbackId: 'cats' }), l('cats', { count: 0 })],
      'items',
    );
    expect(allEmpty.active).toBe('items');
  });
});

describe('hasNonEmptyList (#112)', () => {
  it('reports whether any list in the scope has items', () => {
    expect(
      hasNonEmptyList(createScope('s', [l('a', { count: 0 }), l('b', { count: 0 })], 'a')),
    ).toBe(false);
    expect(
      hasNonEmptyList(createScope('s', [l('a', { count: 0 }), l('b', { count: 1 })], 'a')),
    ).toBe(true);
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

describe('resolveFallbackId', () => {
  it('returns the direct fallback sibling when it has items', () => {
    const scope = createScope(
      's',
      [l('main', { count: 0, fallbackId: 'side' }), l('side', { count: 5 })],
      'main',
    );
    expect(resolveFallbackId(scope, 'main')).toBe('side');
  });

  it('follows multi-hop chains to the first reachable non-empty sibling', () => {
    const scope = createScope(
      's',
      [
        l('a', { count: 0, fallbackId: 'b' }),
        l('b', { count: 0, fallbackId: 'c' }),
        l('c', { count: 4 }),
      ],
      'a',
    );
    expect(resolveFallbackId(scope, 'a')).toBe('c');
  });

  it('falls back to the immediate valid non-self sibling when all fallbacks are empty', () => {
    const scope = createScope(
      's',
      [
        l('a', { count: 0, fallbackId: 'b' }),
        l('b', { count: 0, fallbackId: 'c' }),
        l('c', { count: 0 }),
      ],
      'a',
    );
    expect(resolveFallbackId(scope, 'a')).toBe('b');
  });

  it('prevents infinite loops on self-references and cycles', () => {
    const selfRef = createScope('s', [l('a', { count: 0, fallbackId: 'a' })], 'a');
    expect(resolveFallbackId(selfRef, 'a')).toBeUndefined();

    const twoCycleEmpty = createScope(
      's',
      [l('a', { count: 0, fallbackId: 'b' }), l('b', { count: 0, fallbackId: 'a' })],
      'a',
    );
    expect(resolveFallbackId(twoCycleEmpty, 'a')).toBe('b');

    const threeCycleWithItems = createScope(
      's',
      [
        l('a', { count: 0, fallbackId: 'b' }),
        l('b', { count: 0, fallbackId: 'c' }),
        l('c', { count: 2, fallbackId: 'a' }),
      ],
      'a',
    );
    expect(resolveFallbackId(threeCycleWithItems, 'a')).toBe('c');

    const tailCycleEmpty = createScope(
      's',
      [
        l('a', { count: 0, fallbackId: 'b' }),
        l('b', { count: 0, fallbackId: 'c' }),
        l('c', { count: 0, fallbackId: 'b' }),
      ],
      'a',
    );
    expect(resolveFallbackId(tailCycleEmpty, 'a')).toBe('b');
  });

  it('returns undefined for missing, unknown, or non-existent source/fallback ids', () => {
    const scope = createScope(
      's',
      [
        l('noFallback', { count: 0 }),
        l('badFallback', { count: 0, fallbackId: 'ghost' }),
        l('partial', { count: 0, fallbackId: 'emptyLeaf' }),
        l('emptyLeaf', { count: 0, fallbackId: 'ghost' }),
      ],
      'noFallback',
    );
    expect(resolveFallbackId(scope, 'noFallback')).toBeUndefined();
    expect(resolveFallbackId(scope, 'badFallback')).toBeUndefined();
    expect(resolveFallbackId(scope, 'unknownSource')).toBeUndefined();
    expect(resolveFallbackId(scope, 'partial')).toBe('emptyLeaf');
    const protoScope = createScope('p', [l('a', { count: 0, fallbackId: 'toString' })], 'a');
    expect(resolveFallbackId(protoScope, 'a')).toBeUndefined();
    expect(resolveFallbackId(protoScope, 'constructor')).toBeUndefined();
  });
});
