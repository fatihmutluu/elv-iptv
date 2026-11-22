import { describe, expect, it } from 'vitest';
import { createBrowseFocusMemory } from './browse-focus-memory';

describe('createBrowseFocusMemory (#440)', () => {
  it('stores, retrieves, deletes, and clears focus snapshots per screen id', () => {
    const memory = createBrowseFocusMemory();
    expect(memory.get('home')).toBeUndefined();

    memory.set('home', { rowId: 'movies', col: 2 });
    memory.set('detail:x:s1:series:10', { rowId: 'episodes', col: 4 });
    expect(memory.get('home')).toEqual({ rowId: 'movies', col: 2 });
    expect(memory.get('detail:x:s1:series:10')).toEqual({ rowId: 'episodes', col: 4 });

    memory.delete('home');
    expect(memory.get('home')).toBeUndefined();
    expect(memory.get('detail:x:s1:series:10')).toEqual({ rowId: 'episodes', col: 4 });

    memory.clear();
    expect(memory.get('detail:x:s1:series:10')).toBeUndefined();
  });

  it('bounds retained entries with LRU eviction so detail keys never grow unbounded', () => {
    const memory = createBrowseFocusMemory(3);
    memory.set('a', 1);
    memory.set('b', 2);
    memory.set('c', 3);

    // Touch 'a' so 'b' becomes least-recently-used
    expect(memory.get('a')).toBe(1);
    memory.set('d', 4);

    expect(memory.get('b')).toBeUndefined();
    expect(memory.get('a')).toBe(1);
    expect(memory.get('c')).toBe(3);
    expect(memory.get('d')).toBe(4);
  });
});
