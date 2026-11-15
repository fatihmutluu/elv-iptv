import { describe, expect, it, vi } from 'vitest';
import { focusWindow, startSingleInstance } from './single-instance.ts';

function fakeApp(granted: boolean) {
  const handlers: Array<() => void> = [];
  return {
    handlers,
    app: {
      requestSingleInstanceLock: vi.fn(() => granted),
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: () => void) => void handlers.push(listener)),
    },
  };
}

describe('startSingleInstance', () => {
  it('quits at once when the lock is not granted', () => {
    const { app, handlers } = fakeApp(false);
    const onSecond = vi.fn();
    expect(startSingleInstance(app, { onSecond })).toBe(false);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(handlers).toHaveLength(0);
  });

  it('keeps running and handles second-instance when granted', () => {
    const { app, handlers } = fakeApp(true);
    const onSecond = vi.fn();
    expect(startSingleInstance(app, { onSecond })).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    handlers[0]?.();
    expect(onSecond).toHaveBeenCalledTimes(1);
  });
});

describe('focusWindow', () => {
  it('restores a minimized window and focuses it', () => {
    const win = { isMinimized: () => true, restore: vi.fn(), focus: vi.fn() };
    focusWindow(win);
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('only focuses a normal window and ignores a missing one', () => {
    const win = { isMinimized: () => false, restore: vi.fn(), focus: vi.fn() };
    focusWindow(win);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(() => focusWindow(undefined)).not.toThrow();
  });
});
