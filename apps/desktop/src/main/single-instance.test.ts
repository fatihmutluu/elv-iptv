import { describe, expect, it, vi } from 'vitest';
import { focusWindow, startSingleInstance } from './single-instance.ts';

type SecondInstanceHandler = (
  event: unknown,
  commandLine: string[],
  workingDirectory: string,
) => void;

function fakeApp(granted: boolean) {
  const handlers: SecondInstanceHandler[] = [];
  return {
    handlers,
    app: {
      requestSingleInstanceLock: vi.fn(() => granted),
      quit: vi.fn(),
      on: vi.fn(
        (_event: 'second-instance', listener: SecondInstanceHandler) =>
          void handlers.push(listener),
      ),
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

  it('keeps running and forwards commandLine and workingDirectory on second-instance', () => {
    const { app, handlers } = fakeApp(true);
    const onSecond = vi.fn();
    expect(startSingleInstance(app, { onSecond })).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
    handlers[0]?.({}, ['elv-iptv', 'channels.m3u8'], '/home/user/playlists');
    expect(onSecond).toHaveBeenCalledTimes(1);
    expect(onSecond).toHaveBeenCalledWith(['elv-iptv', 'channels.m3u8'], '/home/user/playlists');
  });

  it('keeps backwards compatibility with zero-arg callbacks and missing event payload fields', () => {
    const { app, handlers } = fakeApp(true);
    let called = 0;
    const onSecond = () => {
      called += 1;
    };
    expect(startSingleInstance(app, { onSecond })).toBe(true);
    (handlers[0] as unknown as (() => void) | undefined)?.();
    expect(called).toBe(1);
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
