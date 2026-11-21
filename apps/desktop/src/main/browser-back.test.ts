import { describe, expect, it, vi } from 'vitest';
import {
  type AppCommandEventLike,
  attachBrowserBackGuard,
  type BrowserBackGuardWindow,
  type WillNavigateEventLike,
} from './browser-back.ts';

function createFakeWindow(opts: { destroyed?: boolean; contentsDestroyed?: boolean } = {}) {
  const winListeners = new Map<string, Array<(event: AppCommandEventLike, cmd: string) => void>>();
  const wcListeners = new Map<string, Array<(event: WillNavigateEventLike) => void>>();
  const sentInputs: Array<{ type: 'keyDown' | 'keyUp'; keyCode: string }> = [];
  const clearNavHistory = vi.fn();

  const win: BrowserBackGuardWindow = {
    isDestroyed: () => opts.destroyed === true,
    on(event, listener) {
      const list = winListeners.get(event) ?? [];
      list.push(listener);
      winListeners.set(event, list);
      return win;
    },
    webContents: {
      isDestroyed: () => opts.contentsDestroyed === true,
      sendInputEvent(input) {
        sentInputs.push(input);
      },
      navigationHistory: {
        clear: clearNavHistory,
      },
      on(event, listener) {
        const list = wcListeners.get(event) ?? [];
        list.push(listener as (event: WillNavigateEventLike) => void);
        wcListeners.set(event, list);
        return win.webContents;
      },
    },
  };

  return {
    win,
    sentInputs,
    clearNavHistory,
    emitAppCommand(cmd: string) {
      const preventDefault = vi.fn();
      for (const l of winListeners.get('app-command') ?? []) {
        l({ preventDefault }, cmd);
      }
      return preventDefault;
    },
    emitWebContents(
      event: 'will-navigate' | 'did-finish-load' | 'did-navigate-in-page',
      isInPlace = false,
    ) {
      const preventDefault = vi.fn();
      for (const l of wcListeners.get(event) ?? []) {
        l({ preventDefault, isInPlace });
      }
      return preventDefault;
    },
  };
}

describe('attachBrowserBackGuard', () => {
  it('intercepts app-command browser-backward, clears history, and dispatches Escape into renderer', () => {
    const fake = createFakeWindow();
    attachBrowserBackGuard(fake.win);

    const prevented = fake.emitAppCommand('browser-backward');
    expect(prevented).toHaveBeenCalledTimes(1);
    expect(fake.clearNavHistory).toHaveBeenCalledTimes(1);
    expect(fake.sentInputs).toEqual([
      { type: 'keyDown', keyCode: 'Escape' },
      { type: 'keyUp', keyCode: 'Escape' },
    ]);
  });

  it('invokes custom onBack callback instead of sendInputEvent when supplied', () => {
    const fake = createFakeWindow();
    const onBack = vi.fn();
    attachBrowserBackGuard(fake.win, onBack);

    fake.emitAppCommand('browser-backward');
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fake.sentInputs).toEqual([]);
  });

  it('blocks browser-forward without dispatching Escape and ignores unrelated app-commands', () => {
    const fake = createFakeWindow();
    attachBrowserBackGuard(fake.win);

    const forwardPrev = fake.emitAppCommand('browser-forward');
    expect(forwardPrev).toHaveBeenCalledTimes(1);
    expect(fake.sentInputs).toEqual([]);

    const mediaPrev = fake.emitAppCommand('media-play_pause');
    expect(mediaPrev).not.toHaveBeenCalled();
    expect(fake.sentInputs).toEqual([]);
  });

  it('intercepts in-place will-navigate history traversal and clears history on load/in-page nav', () => {
    const fake = createFakeWindow();
    attachBrowserBackGuard(fake.win);

    const normalNav = fake.emitWebContents('will-navigate', false);
    expect(normalNav).not.toHaveBeenCalled();
    expect(fake.sentInputs).toEqual([]);

    const historyBackNav = fake.emitWebContents('will-navigate', true);
    expect(historyBackNav).toHaveBeenCalledTimes(1);
    expect(fake.sentInputs).toEqual([
      { type: 'keyDown', keyCode: 'Escape' },
      { type: 'keyUp', keyCode: 'Escape' },
    ]);

    expect(fake.clearNavHistory).toHaveBeenCalledTimes(1);

    fake.emitWebContents('did-finish-load');
    fake.emitWebContents('did-navigate-in-page');
    expect(fake.clearNavHistory).toHaveBeenCalledTimes(3);
  });

  it('safely no-ops when the window or webContents is already destroyed', () => {
    const deadWin = createFakeWindow({ destroyed: true });
    attachBrowserBackGuard(deadWin.win);
    deadWin.emitAppCommand('browser-backward');
    expect(deadWin.sentInputs).toEqual([]);
    expect(deadWin.clearNavHistory).not.toHaveBeenCalled();

    const deadContents = createFakeWindow({ contentsDestroyed: true });
    attachBrowserBackGuard(deadContents.win);
    deadContents.emitAppCommand('browser-backward');
    expect(deadContents.sentInputs).toEqual([]);
    expect(deadContents.clearNavHistory).not.toHaveBeenCalled();
  });
});
