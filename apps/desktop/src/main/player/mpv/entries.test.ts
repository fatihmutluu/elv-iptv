import { describe, expect, it } from 'vitest';
import { createEntryTable } from './entries.ts';

describe('entry table', () => {
  it('binds each entry to exactly one token', () => {
    const t = createEntryTable();
    t.bind(1, 10, 'live');
    t.bind(2, 11, 'vod');
    expect(t.tokenOf(1)).toBe(10);
    expect(t.tokenOf(2)).toBe(11);
    expect(t.tokenOf(3)).toBeUndefined();
    t.started(2);
    expect(t.current()).toEqual({ entryId: 2, token: 11, kind: 'vod' });
    t.started(1);
    expect(t.current()).toEqual({ entryId: 1, token: 10, kind: 'live' });
  });

  it('property changes outside start-file/end-file belong to no entry', () => {
    const t = createEntryTable();
    expect(t.current()).toBeUndefined();
    t.bind(1, 10, 'live');
    expect(t.current()).toBeUndefined();
    t.started(1);
    expect(t.current()?.entryId).toBe(1);
    t.ended(1);
    expect(t.current()).toBeUndefined();
    expect(t.tokenOf(1)).toBeUndefined();
  });

  it('ignores start-file of an unbound entry and a stale end-file', () => {
    const t = createEntryTable();
    t.started(9);
    expect(t.current()).toBeUndefined();
    t.bind(1, 10, 'live');
    t.bind(2, 11, 'live');
    t.started(1);
    t.started(2);
    t.ended(1);
    expect(t.current()?.entryId).toBe(2);
  });

  it('adopt changes the token of the current entry only', () => {
    const t = createEntryTable();
    t.bind(1, 10, 'live');
    t.bind(2, 11, 'live');
    t.adopt(99);
    expect(t.tokenOf(1)).toBe(10);
    t.started(1);
    t.adopt(12);
    expect(t.current()?.token).toBe(12);
    expect(t.tokenOf(1)).toBe(12);
    expect(t.tokenOf(2)).toBe(11);
  });
});
