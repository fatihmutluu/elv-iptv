import { describe, expect, it } from 'vitest';
import type { Key, KeyEvent } from './keys';
import { clampIndex, type ListState, moveList } from './list';

const list = (over: Partial<ListState> = {}): ListState => ({
  id: 'l',
  count: 100,
  index: 50,
  orientation: 'vertical',
  pageSize: 10,
  ...over,
});
const ev = (key: Key, kind: KeyEvent['kind'] = 'press'): KeyEvent => ({ key, kind, time: 0 });

describe('moveList', () => {
  it('moves one step on press and repeat along the axis', () => {
    expect(moveList(list(), ev('down'))).toEqual({ kind: 'moved', index: 51 });
    expect(moveList(list(), ev('up', 'repeat'))).toEqual({ kind: 'moved', index: 49 });
    expect(moveList(list({ orientation: 'horizontal' }), ev('right'))).toEqual({
      kind: 'moved',
      index: 51,
    });
    expect(moveList(list({ orientation: 'horizontal' }), ev('left'))).toEqual({
      kind: 'moved',
      index: 49,
    });
  });

  it('ignores the other axis and unrelated keys', () => {
    expect(moveList(list(), ev('left'))).toEqual({ kind: 'ignored' });
    expect(moveList(list({ orientation: 'horizontal' }), ev('up'))).toEqual({ kind: 'ignored' });
    expect(moveList(list(), ev('select'))).toEqual({ kind: 'ignored' });
    expect(moveList(list(), ev('digit1'))).toEqual({ kind: 'ignored' });
    expect(moveList(list(), ev('left', 'long'))).toEqual({ kind: 'ignored' });
  });

  it('ignores an empty list', () => {
    expect(moveList(list({ count: 0, index: 0 }), ev('down'))).toEqual({ kind: 'ignored' });
  });

  it('reports edges', () => {
    expect(moveList(list({ index: 0 }), ev('up'))).toEqual({ kind: 'edge', side: 'start' });
    expect(moveList(list({ index: 99 }), ev('down'))).toEqual({ kind: 'edge', side: 'end' });
    expect(moveList(list({ count: 1, index: 0 }), ev('down'))).toEqual({
      kind: 'edge',
      side: 'end',
    });
  });

  it('pages on channel keys and long arrows, towards 0 for channelUp', () => {
    expect(moveList(list(), ev('channelUp'))).toEqual({ kind: 'moved', index: 40 });
    expect(moveList(list(), ev('channelDown', 'repeat'))).toEqual({ kind: 'moved', index: 60 });
    expect(moveList(list(), ev('channelDown', 'long'))).toEqual({ kind: 'moved', index: 60 });
    expect(moveList(list(), ev('down', 'long'))).toEqual({ kind: 'moved', index: 60 });
    expect(moveList(list({ orientation: 'horizontal' }), ev('left', 'long'))).toEqual({
      kind: 'moved',
      index: 40,
    });
  });

  it('moves to the end on a partially fitting page and reports edge only when stuck', () => {
    expect(moveList(list({ index: 95 }), ev('channelDown'))).toEqual({ kind: 'moved', index: 99 });
    expect(moveList(list({ index: 3 }), ev('channelUp'))).toEqual({ kind: 'moved', index: 0 });
    expect(moveList(list({ index: 99 }), ev('channelDown'))).toEqual({
      kind: 'edge',
      side: 'end',
    });
    expect(moveList(list({ index: 0 }), ev('up', 'long'))).toEqual({ kind: 'edge', side: 'start' });
  });

  it('treats a page size below one as one', () => {
    expect(moveList(list({ pageSize: 0 }), ev('channelDown'))).toEqual({
      kind: 'moved',
      index: 51,
    });
  });
});

describe('clampIndex', () => {
  it('clamps into the valid range and handles empty lists', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-4, 3)).toBe(0);
    expect(clampIndex(4, 0)).toBe(0);
    expect(clampIndex(Number.NaN, 3)).toBe(0);
    expect(clampIndex(1.7, 5)).toBe(1);
  });
});
