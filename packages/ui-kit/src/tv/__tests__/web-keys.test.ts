import type { KeyInput } from '@elv/focus-core';
import { isEditableWebTarget } from '../index';
import { subscribeWebKeys, type WebKeyEventLike, type WebKeyWindowLike } from '../web-keys';

function createFakeWindow() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const win: WebKeyWindowLike = {
    document: { activeElement: null },
    addEventListener: jest.fn((type: string, listener: (event: never) => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    }) as WebKeyWindowLike['addEventListener'],
    removeEventListener: jest.fn((type: string, listener: (event: never) => void) => {
      listeners.get(type)?.delete(listener);
    }) as WebKeyWindowLike['removeEventListener'],
  };
  const emit = (type: 'keydown' | 'keyup', event: WebKeyEventLike) => {
    for (const fn of listeners.get(type) ?? []) (fn as (e: WebKeyEventLike) => void)(event);
  };
  return { win, emit };
}

describe('isEditableWebTarget (#136, #139)', () => {
  it('detects native form inputs, contentEditable variants, and ARIA editable roles', () => {
    expect(isEditableWebTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableWebTarget({ tagName: 'input' })).toBe(true);
    expect(isEditableWebTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableWebTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableWebTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableWebTarget({ contentEditable: 'true' })).toBe(true);
    expect(isEditableWebTarget({ contentEditable: 'plaintext-only' })).toBe(true);
    expect(isEditableWebTarget({ role: 'textbox' })).toBe(true);
    expect(isEditableWebTarget({ role: 'searchbox' })).toBe(true);
    expect(isEditableWebTarget({ role: 'combobox' })).toBe(true);
    expect(isEditableWebTarget({ role: 'TEXTBOX' })).toBe(true);
    expect(
      isEditableWebTarget({ getAttribute: (n: string) => (n === 'role' ? 'textbox' : null) }),
    ).toBe(true);
    expect(
      isEditableWebTarget({ getAttribute: (n: string) => (n === 'role' ? 'searchbox' : null) }),
    ).toBe(true);
    expect(
      isEditableWebTarget({ getAttribute: (n: string) => (n === 'role' ? 'combobox' : null) }),
    ).toBe(true);
  });

  it('rejects non-editable targets and invalid values', () => {
    expect(isEditableWebTarget(null)).toBe(false);
    expect(isEditableWebTarget(undefined)).toBe(false);
    expect(isEditableWebTarget('INPUT')).toBe(false);
    expect(isEditableWebTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableWebTarget({ tagName: 'BUTTON', role: 'button' })).toBe(false);
    expect(isEditableWebTarget({ contentEditable: 'false' })).toBe(false);
    expect(isEditableWebTarget({ contentEditable: 'inherit' })).toBe(false);
    expect(isEditableWebTarget({ isContentEditable: false })).toBe(false);
    expect(isEditableWebTarget({ getAttribute: () => 'listbox' })).toBe(false);
  });
});

describe('subscribeWebKeys IME and ARIA editable guards (#136, #139)', () => {
  it('drops keydown and keyup events during IME composition (isComposing, Process, keyCode 229)', () => {
    const { win, emit } = createFakeWindow();
    const inputs: KeyInput[] = [];
    const unsubscribe = subscribeWebKeys(
      win,
      { isActive: () => false },
      () => 1000,
      (k) => inputs.push(k),
    );

    const prevent1 = jest.fn();
    emit('keydown', { key: 'Enter', isComposing: true, preventDefault: prevent1 });
    emit('keyup', { key: 'Enter', isComposing: true });

    const prevent2 = jest.fn();
    emit('keydown', { key: 'Process', preventDefault: prevent2 });
    emit('keyup', { key: 'Process' });

    const prevent3 = jest.fn();
    emit('keydown', { key: 'ArrowDown', keyCode: 229, preventDefault: prevent3 });
    emit('keyup', { key: 'ArrowDown', keyCode: 229 });

    expect(inputs).toEqual([]);
    expect(prevent1).not.toHaveBeenCalled();
    expect(prevent2).not.toHaveBeenCalled();
    expect(prevent3).not.toHaveBeenCalled();

    // Non-IME events still work cleanly afterward
    emit('keydown', { key: 'ArrowDown', isComposing: false, keyCode: 40 });
    emit('keyup', { key: 'ArrowDown', isComposing: false, keyCode: 40 });
    expect(inputs.map((k) => `${k.key}:${k.action}`)).toEqual(['down:down', 'down:up']);

    unsubscribe();
  });

  it('ignores navigation keys inside ARIA textbox/searchbox/combobox and contentEditable=plaintext-only, blurring on Escape', () => {
    const { win, emit } = createFakeWindow();
    const inputs: KeyInput[] = [];
    const unsubscribe = subscribeWebKeys(
      win,
      { isActive: () => false },
      () => 1000,
      (k) => inputs.push(k),
    );

    const targets = [
      { tagName: 'DIV', role: 'textbox', blur: jest.fn() },
      { tagName: 'DIV', role: 'searchbox', blur: jest.fn() },
      {
        tagName: 'DIV',
        getAttribute: (name: string) => (name === 'role' ? 'combobox' : null),
        blur: jest.fn(),
      },
      { tagName: 'DIV', contentEditable: 'plaintext-only', blur: jest.fn() },
    ];

    for (const target of targets) {
      const preventBackspace = jest.fn();
      emit('keydown', { key: 'Backspace', target, preventDefault: preventBackspace });
      emit('keydown', { key: 'ArrowLeft', target });
      emit('keydown', { key: ' ', target });
      expect(preventBackspace).not.toHaveBeenCalled();
      expect(inputs).toEqual([]);

      const preventEsc = jest.fn();
      emit('keydown', { key: 'Escape', target, preventDefault: preventEsc });
      emit('keyup', { key: 'Escape', target: null });
      expect(preventEsc).toHaveBeenCalledTimes(1);
      expect(target.blur).toHaveBeenCalledTimes(1);
      expect(inputs).toEqual([]);
    }

    unsubscribe();
  });

  it('releases a key held before IME activation even if keyup reports isComposing', () => {
    const { win, emit } = createFakeWindow();
    const inputs: KeyInput[] = [];
    const unsubscribe = subscribeWebKeys(
      win,
      { isActive: () => false },
      () => 10,
      (k) => inputs.push(k),
    );

    emit('keydown', { key: 'ArrowRight' });
    emit('keyup', { key: 'ArrowRight', isComposing: true });
    expect(inputs).toEqual([
      { key: 'right', action: 'down', time: 10 },
      { key: 'right', action: 'up', time: 10 },
    ]);
    unsubscribe();
  });

  it('ignores Shift+ArrowLeft and Shift+ArrowRight chords while keeping bare ArrowLeft/ArrowRight active (#212)', () => {
    const { win, emit } = createFakeWindow();
    const inputs: KeyInput[] = [];
    const unsubscribe = subscribeWebKeys(
      win,
      { isActive: () => false },
      () => 100,
      (k) => inputs.push(k),
    );

    const preventShiftLeft = jest.fn();
    const preventShiftRight = jest.fn();
    emit('keydown', { key: 'ArrowLeft', shiftKey: true, preventDefault: preventShiftLeft });
    emit('keyup', { key: 'ArrowLeft', shiftKey: false });
    emit('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault: preventShiftRight });
    emit('keyup', { key: 'ArrowRight', shiftKey: false });
    expect(inputs).toEqual([]);
    expect(preventShiftLeft).not.toHaveBeenCalled();
    expect(preventShiftRight).not.toHaveBeenCalled();

    emit('keydown', { key: 'ArrowLeft' });
    emit('keyup', { key: 'ArrowLeft' });
    emit('keydown', { key: 'ArrowRight' });
    emit('keyup', { key: 'ArrowRight' });
    expect(inputs.map((k) => `${k.key}:${k.action}`)).toEqual([
      'left:down',
      'left:up',
      'right:down',
      'right:up',
    ]);

    unsubscribe();
  });
});
