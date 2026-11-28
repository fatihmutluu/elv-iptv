import { describe, expect, it, vi } from 'vitest';
import {
  attachMouseBackGuard,
  DEFAULT_BACK_DEDUPE_MS,
  MOUSE_BACK_BUTTON,
  MOUSE_FORWARD_BUTTON,
  type MouseBackWindowLike,
} from './browser-back.ts';

interface KeyEmitOptions {
  readonly code?: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly target?: unknown;
}

function createFakeWindow() {
  const captureListeners = new Map<string, Set<(e: unknown) => void>>();
  const bubbleListeners = new Map<string, Set<(e: unknown) => void>>();
  const dispatched: Array<{ type: string; key?: string }> = [];

  const getMap = (capture?: boolean) => (capture ? captureListeners : bubbleListeners);

  const runListeners = (type: string, event: unknown) => {
    let stopped = false;
    const ev = event as { stopImmediatePropagation?: () => void };
    const origStop = ev.stopImmediatePropagation;
    ev.stopImmediatePropagation = () => {
      stopped = true;
      origStop?.();
    };
    for (const fn of [...(captureListeners.get(type) ?? [])]) {
      fn(ev);
      if (stopped) return;
    }
    for (const fn of [...(bubbleListeners.get(type) ?? [])]) {
      fn(ev);
      if (stopped) return;
    }
  };

  const win: MouseBackWindowLike = {
    addEventListener(type, listener, capture) {
      const map = getMap(capture);
      const set = map.get(type) ?? new Set();
      set.add(listener as (e: unknown) => void);
      map.set(type, set);
    },
    removeEventListener(type, listener, capture) {
      getMap(capture)
        .get(type)
        ?.delete(listener as (e: unknown) => void);
    },
    dispatchEvent(event) {
      const e = event as { type?: string; key?: string };
      dispatched.push({ type: e.type ?? '', ...(e.key !== undefined ? { key: e.key } : {}) });
      runListeners(e.type ?? '', event);
      return true;
    },
  };

  return {
    win,
    dispatched,
    emitMouse(type: 'mousedown' | 'mouseup' | 'auxclick', button: number) {
      const preventDefault = vi.fn();
      runListeners(type, { button, preventDefault });
      return preventDefault;
    },
    emitKeyDown(key: string, opts: KeyEmitOptions = {}) {
      const preventDefault = vi.fn();
      const stopImmediatePropagation = vi.fn();
      runListeners('keydown', { key, ...opts, preventDefault, stopImmediatePropagation });
      return { preventDefault, stopImmediatePropagation };
    },
    listenerCount(type: string) {
      return (captureListeners.get(type)?.size ?? 0) + (bubbleListeners.get(type)?.size ?? 0);
    },
  };
}

describe('attachMouseBackGuard', () => {
  it('prevents default and triggers Back once across mousedown -> mouseup -> auxclick within 500 ms dedupe window', () => {
    let now = 1_000;
    const fake = createFakeWindow();
    const onBack = vi.fn();
    const dispose = attachMouseBackGuard(fake.win, { onBack, now: () => now });

    expect(MOUSE_BACK_BUTTON).toBe(3);
    expect(MOUSE_FORWARD_BUTTON).toBe(4);
    expect(DEFAULT_BACK_DEDUPE_MS).toBe(500);

    // mousedown prevents native Chromium back without firing early
    expect(fake.emitMouse('mousedown', MOUSE_BACK_BUTTON)).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();

    // mouseup prevents default and triggers Back once
    expect(fake.emitMouse('mouseup', MOUSE_BACK_BUTTON)).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    // Immediate and delayed (< 500 ms) auxclick for the same click prevents default and is deduped
    now += 10;
    expect(fake.emitMouse('auxclick', MOUSE_BACK_BUTTON)).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    now += 400;
    expect(fake.emitMouse('auxclick', MOUSE_BACK_BUTTON)).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    // Standalone auxclick once 500 ms has elapsed triggers Back cleanly
    now += 100;
    expect(fake.emitMouse('auxclick', MOUSE_BACK_BUTTON)).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(2);

    // Mouse forward button (4) prevents default without triggering Back
    expect(fake.emitMouse('mouseup', MOUSE_FORWARD_BUTTON)).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(2);

    // Regular buttons (0, 1, 2) are untouched
    for (const btn of [0, 1, 2]) {
      expect(fake.emitMouse('mouseup', btn)).not.toHaveBeenCalled();
    }
    expect(onBack).toHaveBeenCalledTimes(2);

    dispose();
    expect(fake.listenerCount('mousedown')).toBe(0);
    expect(fake.listenerCount('mouseup')).toBe(0);
    expect(fake.listenerCount('auxclick')).toBe(0);
    expect(fake.listenerCount('keydown')).toBe(0);
  });

  it('dispatches Escape keydown/keyup by default and dedupes against main-process Escape within 500 ms', () => {
    let now = 5_000;
    const fake = createFakeWindow();
    const dispose = attachMouseBackGuard(fake.win, { now: () => now });

    // Default onBack dispatches Escape keydown + keyup
    fake.emitMouse('mouseup', MOUSE_BACK_BUTTON);
    expect(fake.dispatched).toEqual([
      { type: 'keydown', key: 'Escape' },
      { type: 'keyup', key: 'Escape' },
    ]);

    // If Electron main app-command already dispatched Escape right before mouseup(3), dedupe cleanly!
    now += 600;
    fake.dispatched.length = 0;
    fake.emitKeyDown('Escape');
    now += 250;
    expect(fake.emitMouse('mouseup', MOUSE_BACK_BUTTON)).toHaveBeenCalledTimes(1);
    expect(fake.dispatched).toEqual([]);

    dispose();
  });

  it('suppresses trailing main-process Escape in capture phase within 500 ms while leaving genuine rapid keyboard Escape untouched', () => {
    let now = 10_000;
    const fake = createFakeWindow();
    const appEscapeHandler = vi.fn();
    fake.win.addEventListener('keydown', (e) => {
      if ((e as { key?: string }).key === 'Escape') appEscapeHandler();
    });
    const dispose = attachMouseBackGuard(fake.win, { now: () => now });

    // Windows order: mouseup(button=3) fires first -> app sees our single Escape
    fake.emitMouse('mouseup', MOUSE_BACK_BUTTON);
    expect(appEscapeHandler).toHaveBeenCalledTimes(1);

    // 250ms later main-process WM_APPCOMMAND sends a second Escape -> blocked in capture phase!
    now += 250;
    const trailing = fake.emitKeyDown('Escape');
    expect(trailing.preventDefault).toHaveBeenCalledTimes(1);
    expect(trailing.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(appEscapeHandler).toHaveBeenCalledTimes(1);

    // Genuine rapid double keyboard Escape after dedupe window is NEVER suppressed!
    now += 300;
    const firstKey = fake.emitKeyDown('Escape');
    now += 10;
    const secondKey = fake.emitKeyDown('Escape');
    expect(firstKey.preventDefault).not.toHaveBeenCalled();
    expect(secondKey.preventDefault).not.toHaveBeenCalled();
    expect(appEscapeHandler).toHaveBeenCalledTimes(3);

    dispose();
  });

  it('handles Alt+ArrowLeft (non-macOS) and Cmd+[ (macOS), absorbs held repeats, and ignores editable inputs (Wave Q7)', () => {
    let now = 20_000;
    const fakeWin = createFakeWindow();
    const onWinBack = vi.fn();
    const disposeWin = attachMouseBackGuard(fakeWin.win, {
      onBack: onWinBack,
      now: () => now,
      platform: 'Win32',
    });

    // Alt+ArrowLeft fires once
    const altLeft = fakeWin.emitKeyDown('ArrowLeft', { altKey: true });
    expect(altLeft.preventDefault).toHaveBeenCalledTimes(1);
    expect(altLeft.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(onWinBack).toHaveBeenCalledTimes(1);

    // Held chord repeat is absorbed even after dedupe window
    now += 600;
    const repeated = fakeWin.emitKeyDown('ArrowLeft', { altKey: true, repeat: true });
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1);
    expect(onWinBack).toHaveBeenCalledTimes(1);

    // Editable inputs are completely ignored
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      const ev = fakeWin.emitKeyDown('ArrowLeft', { altKey: true, target });
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
    expect(onWinBack).toHaveBeenCalledTimes(1);

    // Cmd+[ on Windows does NOT trigger back
    const winMeta = fakeWin.emitKeyDown('[', { metaKey: true });
    expect(winMeta.preventDefault).not.toHaveBeenCalled();
    expect(onWinBack).toHaveBeenCalledTimes(1);
    disposeWin();

    // macOS uses Meta+[ (Cmd+[) and ignores Alt+ArrowLeft
    now += 1_000;
    const fakeMac = createFakeWindow();
    const onMacBack = vi.fn();
    const disposeMac = attachMouseBackGuard(fakeMac.win, {
      onBack: onMacBack,
      now: () => now,
      platform: 'MacIntel',
    });

    const macAlt = fakeMac.emitKeyDown('ArrowLeft', { altKey: true });
    expect(macAlt.preventDefault).not.toHaveBeenCalled();
    expect(onMacBack).not.toHaveBeenCalled();

    const macCmdBracket = fakeMac.emitKeyDown('[', { metaKey: true });
    expect(macCmdBracket.preventDefault).toHaveBeenCalledTimes(1);
    expect(onMacBack).toHaveBeenCalledTimes(1);

    // Editable target on macOS ignores Cmd+[
    now += 600;
    const macInput = fakeMac.emitKeyDown('[', { metaKey: true, target: { tagName: 'INPUT' } });
    expect(macInput.preventDefault).not.toHaveBeenCalled();
    expect(onMacBack).toHaveBeenCalledTimes(1);
    disposeMac();
  });
});
