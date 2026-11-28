import { describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/window-ipc.ts';
import {
  attachWindowZoomAndReloadGuard,
  type BeforeInputDetailsLike,
  type BeforeInputEventLike,
  type WindowZoomWindowLike,
} from './window-zoom.ts';

function createFakeZoomWindow(opts: { destroyed?: boolean; contentsDestroyed?: boolean } = {}) {
  const wcListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const zoomCalls: number[] = [];
  const sent: Array<{ channel: string; args: unknown[] }> = [];

  const win: WindowZoomWindowLike = {
    isDestroyed: () => opts.destroyed === true,
    webContents: {
      isDestroyed: () => opts.contentsDestroyed === true,
      setZoomLevel(level: number) {
        zoomCalls.push(level);
      },
      send(channel: string, ...args: unknown[]) {
        sent.push({ channel, args });
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        const set = wcListeners.get(event) ?? new Set();
        set.add(listener);
        wcListeners.set(event, set);
        return win.webContents;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        wcListeners.get(event)?.delete(listener);
        return win.webContents;
      },
    },
  };

  return {
    win,
    zoomCalls,
    sent,
    emitBeforeInput(input: Partial<BeforeInputDetailsLike>) {
      const preventDefault = vi.fn();
      const ev: BeforeInputEventLike = { preventDefault };
      const full: BeforeInputDetailsLike = {
        type: 'keyDown',
        key: '',
        code: '',
        control: false,
        meta: false,
        alt: false,
        shift: false,
        ...input,
      };
      for (const fn of [...(wcListeners.get('before-input-event') ?? [])]) {
        fn(ev, full);
      }
      return preventDefault;
    },
    emitLifecycle(event: 'did-finish-load' | 'dom-ready') {
      for (const fn of [...(wcListeners.get(event) ?? [])]) {
        fn();
      }
    },
    listenerCount(event: string) {
      return wcListeners.get(event)?.size ?? 0;
    },
  };
}

describe('attachWindowZoomAndReloadGuard (Wave Q7)', () => {
  it('suppresses Ctrl/Cmd+R, Ctrl/Cmd+Shift+R, and F5 in packaged builds only', () => {
    const winFake = createFakeZoomWindow();
    const disposeWin = attachWindowZoomAndReloadGuard(winFake.win, {
      isPackaged: true,
      platform: 'win32',
      getZoomLevel: () => 0,
      onSetZoomLevel: (next) => next,
    });

    expect(winFake.emitBeforeInput({ key: 'r', control: true })).toHaveBeenCalledTimes(1);
    expect(winFake.emitBeforeInput({ key: 'R', control: true, shift: true })).toHaveBeenCalledTimes(
      1,
    );
    expect(winFake.emitBeforeInput({ key: 'F5', code: 'F5' })).toHaveBeenCalledTimes(1);
    expect(winFake.emitBeforeInput({ key: 'F5', control: true })).toHaveBeenCalledTimes(1);
    // keyUp is never intercepted
    expect(winFake.emitBeforeInput({ type: 'keyUp', key: 'F5' })).not.toHaveBeenCalled();
    // AltGr (Ctrl+Alt+R) is not intercepted
    expect(winFake.emitBeforeInput({ key: 'r', control: true, alt: true })).not.toHaveBeenCalled();
    // macOS Meta+R on Windows is not intercepted
    expect(winFake.emitBeforeInput({ key: 'r', meta: true })).not.toHaveBeenCalled();
    disposeWin();

    // macOS packaged build suppresses Cmd+R, Cmd+Shift+R, and F5
    const macFake = createFakeZoomWindow();
    const disposeMac = attachWindowZoomAndReloadGuard(macFake.win, {
      isPackaged: true,
      platform: 'darwin',
      getZoomLevel: () => 0,
      onSetZoomLevel: (next) => next,
    });
    expect(macFake.emitBeforeInput({ key: 'r', meta: true })).toHaveBeenCalledTimes(1);
    expect(macFake.emitBeforeInput({ key: 'R', meta: true, shift: true })).toHaveBeenCalledTimes(1);
    expect(macFake.emitBeforeInput({ key: 'F5' })).toHaveBeenCalledTimes(1);
    expect(macFake.emitBeforeInput({ key: 'r', control: true })).not.toHaveBeenCalled();
    disposeMac();

    // Unpackaged dev builds leave reload shortcuts completely untouched
    const devFake = createFakeZoomWindow();
    const disposeDev = attachWindowZoomAndReloadGuard(devFake.win, {
      isPackaged: false,
      platform: 'win32',
      getZoomLevel: () => 0,
      onSetZoomLevel: (next) => next,
    });
    expect(devFake.emitBeforeInput({ key: 'r', control: true })).not.toHaveBeenCalled();
    expect(devFake.emitBeforeInput({ key: 'F5' })).not.toHaveBeenCalled();
    disposeDev();
  });

  it('handles Ctrl/Cmd +/-/0 zoom steps, clamps [-3, 4], ignores AltGr combos, and persists zoom', () => {
    let zoom = 0;
    const onSetZoomLevel = vi.fn((next: number) => {
      zoom = next;
      return zoom;
    });
    const fake = createFakeZoomWindow();
    const dispose = attachWindowZoomAndReloadGuard(fake.win, {
      isPackaged: false,
      platform: 'win32',
      getZoomLevel: () => zoom,
      onSetZoomLevel,
    });

    // Zoom in (+, =, NumpadAdd)
    expect(fake.emitBeforeInput({ key: '=', control: true })).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(0.5);
    expect(fake.emitBeforeInput({ key: '+', control: true, shift: true })).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(1);
    expect(
      fake.emitBeforeInput({ key: '+', code: 'NumpadAdd', control: true }),
    ).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(1.5);
    // Turkish Q Shift+0 produces key='=' with code='Digit0' -> zooms in, does NOT reset!
    expect(
      fake.emitBeforeInput({ key: '=', code: 'Digit0', control: true, shift: true }),
    ).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(2);

    // AltGr combos on European/Turkish keyboards MUST NOT trigger zoom!
    expect(fake.emitBeforeInput({ key: '+', control: true, alt: true })).not.toHaveBeenCalled();
    expect(fake.emitBeforeInput({ key: '-', control: true, alt: true })).not.toHaveBeenCalled();
    expect(fake.emitBeforeInput({ key: '0', control: true, alt: true })).not.toHaveBeenCalled();
    expect(zoom).toBe(2);

    // Zoom out (-, _, NumpadSubtract)
    expect(fake.emitBeforeInput({ key: '-', control: true })).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(1.5);
    expect(fake.emitBeforeInput({ key: '_', control: true, shift: true })).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(1);
    expect(
      fake.emitBeforeInput({ key: '-', code: 'NumpadSubtract', control: true }),
    ).toHaveBeenCalledTimes(1);
    expect(zoom).toBe(0.5);

    // Reset (0, Numpad0)
    expect(fake.emitBeforeInput({ key: '0', code: 'Digit0', control: true })).toHaveBeenCalledTimes(
      1,
    );
    expect(zoom).toBe(0);

    // Clamp at bounds
    zoom = 4;
    fake.emitBeforeInput({ key: '+', control: true });
    expect(zoom).toBe(4);
    zoom = -3;
    fake.emitBeforeInput({ key: '-', control: true });
    expect(zoom).toBe(-3);

    expect(fake.zoomCalls.at(-1)).toBe(-3);
    expect(fake.sent.at(-1)).toEqual({
      channel: WINDOW_CHANNELS.zoomLevelChanged,
      args: [-3],
    });

    dispose();
    expect(fake.listenerCount('before-input-event')).toBe(0);
    expect(fake.listenerCount('did-finish-load')).toBe(0);
    expect(fake.listenerCount('dom-ready')).toBe(0);
  });

  it('re-applies persisted zoom on did-finish-load and dom-ready and safely handles destroyed windows', () => {
    const fake = createFakeZoomWindow();
    const dispose = attachWindowZoomAndReloadGuard(fake.win, {
      isPackaged: true,
      platform: 'darwin',
      getZoomLevel: () => 1.5,
      onSetZoomLevel: (next) => next,
    });

    fake.emitLifecycle('dom-ready');
    fake.emitLifecycle('did-finish-load');
    expect(fake.zoomCalls).toEqual([1.5, 1.5]);

    // macOS Cmd+= zooms in cleanly
    expect(fake.emitBeforeInput({ key: '=', meta: true })).toHaveBeenCalledTimes(1);
    expect(fake.zoomCalls.at(-1)).toBe(2);
    dispose();

    const dead = createFakeZoomWindow({ destroyed: true });
    attachWindowZoomAndReloadGuard(dead.win, {
      isPackaged: true,
      platform: 'win32',
      getZoomLevel: () => 1,
      onSetZoomLevel: (next) => next,
    });
    dead.emitLifecycle('dom-ready');
    dead.emitLifecycle('did-finish-load');
    expect(dead.zoomCalls).toEqual([]);
  });
});
