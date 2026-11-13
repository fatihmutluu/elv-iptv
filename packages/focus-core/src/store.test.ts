import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { ARROW_KEYS, DIGIT_KEYS, type Key, type KeyEvent } from './keys';
import type { ListState } from './list';
import { createFocusStore } from './store';

const l = (id: string, over: Partial<ListState> = {}): ListState => ({
  id,
  count: 20,
  index: 0,
  orientation: 'vertical',
  pageSize: 5,
  ...over,
});
const ev = (key: Key, kind: KeyEvent['kind'] = 'press'): KeyEvent => ({ key, kind, time: 1 });
const mk = () => createFocusStore({ id: 'root', lists: [l('main'), l('side')], active: 'main' });
const active = (s: ReturnType<typeof mk>) => {
  const top = s.getState().scopes.at(-1);
  return top?.lists[top.active];
};

describe('moves and intents', () => {
  it('moves the active list and notifies once per change', () => {
    const s = mk();
    const fn = vi.fn();
    s.subscribe(fn);
    expect(s.dispatch(ev('down'))).toEqual([]);
    expect(fn).toHaveBeenCalledWith({ listId: 'main', index: 1 });
    expect(s.dispatch(ev('channelDown'))).toEqual([]);
    expect(active(s)?.index).toBe(6);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reports edges as intents without notifying', () => {
    const s = mk();
    const fn = vi.fn();
    s.subscribe(fn);
    expect(s.dispatch(ev('up'))).toEqual([{ kind: 'edge', listId: 'main', side: 'start' }]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('turns select into select and long intents', () => {
    const s = mk();
    s.dispatch(ev('down'));
    expect(s.dispatch(ev('select'))).toEqual([{ kind: 'select', listId: 'main', index: 1 }]);
    expect(s.dispatch(ev('select', 'long'))).toEqual([{ kind: 'long', listId: 'main', index: 1 }]);
  });

  it('does not select in an empty list', () => {
    const s = createFocusStore({ id: 'r', lists: [l('e', { count: 0 })], active: 'e' });
    expect(s.dispatch(ev('select'))).toEqual([]);
  });

  it('passes unconsumed keys through as key intents', () => {
    const s = mk();
    const left = ev('left');
    expect(s.dispatch(left)).toEqual([{ kind: 'key', event: left }]);
    const menu = ev('menu');
    expect(s.dispatch(menu)).toEqual([{ kind: 'key', event: menu }]);
    const rep = ev('select', 'repeat');
    expect(s.dispatch(rep)).toEqual([{ kind: 'key', event: rep }]);
  });

  it('keeps getState small for a 100,000 item list', () => {
    const s = createFocusStore({
      id: 'r',
      lists: [l('big', { count: 100_000, pageSize: 10 })],
      active: 'big',
    });
    for (let i = 0; i < 1000; i++) s.dispatch(ev('channelDown'));
    expect(active(s)?.index).toBe(10_000);
    expect(JSON.stringify(s.getState()).length).toBeLessThan(500);
    expect(Object.keys(s.getState().scopes[0]?.lists ?? {})).toEqual(['big']);
  });
});

describe('back and scopes', () => {
  it('reports back at the root and backLong never pops', () => {
    const s = mk();
    expect(s.dispatch(ev('back'))).toEqual([{ kind: 'back' }]);
    s.pushScope('dlg', [l('d')], 'd');
    expect(s.dispatch(ev('back', 'long'))).toEqual([{ kind: 'backLong' }]);
    expect(s.getState().scopes).toHaveLength(2);
  });

  it('pops a pushed scope and restores the opener list and index', () => {
    const s = mk();
    s.dispatch(ev('down'));
    s.dispatch(ev('down'));
    s.pushScope('dlg', [l('d')], 'd');
    s.dispatch(ev('down'));
    expect(s.dispatch(ev('back'))).toEqual([]);
    expect(s.getState().scopes).toHaveLength(1);
    expect(active(s)).toMatchObject({ id: 'main', index: 2 });
  });

  it('keeps input inside the top scope', () => {
    const s = mk();
    s.pushScope('dlg', [l('d', { count: 3 })], 'd');
    s.dispatch(ev('down'));
    expect(active(s)).toMatchObject({ id: 'd', index: 1 });
    expect(s.getState().scopes[0]?.lists.main?.index).toBe(0);
  });

  it('popScope at the root is a no-op', () => {
    const s = mk();
    s.popScope();
    expect(s.getState().scopes).toHaveLength(1);
  });

  it('restores memory clamped to the new count', () => {
    const s = mk();
    for (let i = 0; i < 10; i++) s.dispatch(ev('down'));
    s.pushScope('dlg', [l('d')], 'd');
    s.setCount('main', 4);
    s.popScope();
    expect(active(s)).toMatchObject({ id: 'main', index: 3, count: 4 });
  });

  it('notifies for ids shared between scopes on push and pop', () => {
    const s = mk();
    s.dispatch(ev('down'));
    const fn = vi.fn();
    s.subscribe(fn);
    s.pushScope('dlg', [l('main', { index: 7 })], 'main');
    expect(fn).toHaveBeenLastCalledWith({ listId: 'main', index: 7 });
    s.popScope();
    expect(fn).toHaveBeenLastCalledWith({ listId: 'main', index: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not notify on push or pop when shared indices match', () => {
    const s = mk();
    const fn = vi.fn();
    s.subscribe(fn);
    s.pushScope('dlg', [l('main')], 'main');
    s.popScope();
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects an unknown active list on push', () => {
    expect(() => mk().pushScope('x', [l('a')], 'b')).toThrow();
  });
});

describe('setCount and focus', () => {
  it('clamps on setCount and notifies only on change', () => {
    const s = mk();
    s.focus('main', 15);
    const fn = vi.fn();
    s.subscribe(fn);
    s.setCount('main', 100);
    expect(fn).not.toHaveBeenCalled();
    s.setCount('main', 5);
    expect(fn).toHaveBeenCalledWith({ listId: 'main', index: 4 });
    s.setCount('main', 0);
    expect(fn).toHaveBeenLastCalledWith({ listId: 'main', index: 0 });
  });

  it('focus clamps, activates the list and ignores unknown ids', () => {
    const s = mk();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.focus('side', 99);
    expect(active(s)).toMatchObject({ id: 'side', index: 19 });
    expect(fn).toHaveBeenCalledWith({ listId: 'side', index: 19 });
    s.focus('side', 19);
    s.focus('nope', 1);
    s.setCount('nope', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.focus('side', 0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid root', () => {
    expect(() => createFocusStore({ id: 'r', lists: [l('a')], active: 'b' })).toThrow();
  });
});

describe('invariants', () => {
  it('keeps every index in range for any key sequence', () => {
    const keys: Key[] = [
      ...ARROW_KEYS,
      ...DIGIT_KEYS,
      'select',
      'back',
      'menu',
      'channelUp',
      'channelDown',
    ];
    const kinds: KeyEvent['kind'][] = ['press', 'long', 'repeat'];
    const action = fc.oneof(
      fc.record({
        t: fc.constant('key' as const),
        key: fc.constantFrom(...keys),
        kind: fc.constantFrom(...kinds),
      }),
      fc.record({ t: fc.constant('push' as const) }),
      fc.record({ t: fc.constant('count' as const), n: fc.integer({ min: 0, max: 50 }) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 80 }), (acts) => {
        const s = mk();
        for (const a of acts) {
          if (a.t === 'key') s.dispatch({ key: a.key, kind: a.kind, time: 0 });
          else if (a.t === 'push') s.pushScope('p', [l('main', { count: 7 }), l('x')], 'x');
          else s.setCount('main', a.n);
          for (const sc of s.getState().scopes) {
            expect(sc.lists[sc.active]).toBeDefined();
            for (const ls of Object.values(sc.lists)) {
              expect(ls.index).toBeGreaterThanOrEqual(0);
              expect(ls.index).toBeLessThanOrEqual(Math.max(0, ls.count - 1));
            }
          }
        }
      }),
    );
  });
});
