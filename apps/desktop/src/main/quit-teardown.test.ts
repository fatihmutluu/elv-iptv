import { describe, expect, it, vi } from 'vitest';
import { createQuitTeardown, type QuitDisposable, type QuitTeardownDeps } from './quit-teardown.ts';

function makeDisposable(label: string, order: string[]): QuitDisposable {
  return {
    dispose: vi.fn(() => {
      order.push(label);
    }),
  };
}

describe('createQuitTeardown', () => {
  it('disposes all desktop main resources strictly once, clears collections/refs, and stays idempotent', () => {
    const order: string[] = [];
    const bounds1 = makeDisposable('bounds1', order);
    const bounds2 = makeDisposable('bounds2', order);
    const aspect1 = makeDisposable('aspect1', order);
    const windowBoundsControllers = new Set<QuitDisposable>([bounds1, bounds2]);
    const aspectRatioLockControllers = new Map<unknown, QuitDisposable>([[{ id: 1 }, aspect1]]);

    const deps: QuitTeardownDeps = {
      clearRefs: vi.fn(() => {
        order.push('clearRefs');
      }),
      playerIpc: vi.fn(() => {
        order.push('playerIpc');
      }),
      catalogIpc: vi.fn(() => {
        order.push('catalogIpc');
      }),
      artworkIpc: vi.fn(() => {
        order.push('artworkIpc');
      }),
      windowIpc: vi.fn(() => {
        order.push('windowIpc');
      }),
      sourcesIpc: vi.fn(() => {
        order.push('sourcesIpc');
      }),
      tray: {
        destroy: vi.fn(() => {
          order.push('tray');
        }),
      },
      popout: makeDisposable('popout', order),
      lanPairing: makeDisposable('lanPairing', order),
      diagnosticsIpc: vi.fn(() => {
        order.push('diagnosticsIpc');
      }),
      errorTelemetry: vi.fn(() => {
        order.push('errorTelemetry');
      }),
      syncIpc: vi.fn(() => {
        order.push('syncIpc');
      }),
      downloadsIpc: vi.fn(() => {
        order.push('downloadsIpc');
      }),
      downloadManager: makeDisposable('downloadManager', order),
      mediaBridge: makeDisposable('mediaBridge', order),
      windowBoundsControllers,
      aspectRatioLockControllers,
      artworkCache: makeDisposable('artworkCache', order),
      displayRefresh: {
        restoreAll: vi.fn(() => {
          order.push('displayRefresh');
        }),
      },
      powerBlocker: {
        releaseAll: vi.fn(() => {
          order.push('powerBlocker');
        }),
      },
    };

    const teardown = createQuitTeardown(deps);
    expect(teardown.hasRun()).toBe(false);

    expect(teardown.run()).toBe(true);
    expect(teardown.hasRun()).toBe(true);
    expect(order).toEqual([
      'playerIpc',
      'catalogIpc',
      'artworkIpc',
      'windowIpc',
      'sourcesIpc',
      'tray',
      'popout',
      'lanPairing',
      'diagnosticsIpc',
      'errorTelemetry',
      'syncIpc',
      'downloadsIpc',
      'downloadManager',
      'mediaBridge',
      'bounds1',
      'bounds2',
      'aspect1',
      'artworkCache',
      'displayRefresh',
      'powerBlocker',
      'clearRefs',
    ]);
    expect(windowBoundsControllers.size).toBe(0);
    expect(aspectRatioLockControllers.size).toBe(0);
    expect(deps.playerIpc).toBeUndefined();
    expect(deps.catalogIpc).toBeUndefined();
    expect(deps.artworkIpc).toBeUndefined();
    expect(deps.windowIpc).toBeUndefined();
    expect(deps.sourcesIpc).toBeUndefined();
    expect(deps.tray).toBeUndefined();
    expect(deps.popout).toBeUndefined();
    expect(deps.lanPairing).toBeUndefined();
    expect(deps.diagnosticsIpc).toBeUndefined();
    expect(deps.errorTelemetry).toBeUndefined();
    expect(deps.syncIpc).toBeUndefined();
    expect(deps.downloadsIpc).toBeUndefined();
    expect(deps.downloadManager).toBeUndefined();
    expect(deps.mediaBridge).toBeUndefined();
    expect(deps.artworkCache).toBeUndefined();

    // Second invocation is a strict no-op even if someone re-populates a slot
    order.length = 0;
    deps.playerIpc = vi.fn(() => {
      order.push('late-playerIpc');
    });
    expect(teardown.run()).toBe(false);
    expect(order).toEqual([]);
  });

  it('continues disposing remaining resources when an individual disposer throws or rejects', async () => {
    const logs: string[] = [];
    const restoreAll = vi.fn();
    const releaseAll = vi.fn();
    const syncDispose = vi.fn();

    const teardown = createQuitTeardown({
      playerIpc: () => {
        throw new Error('player boom');
      },
      lanPairing: {
        dispose: () => Promise.reject(new Error('lan boom')),
      },
      syncIpc: syncDispose,
      windowBoundsControllers: new Set(),
      aspectRatioLockControllers: new Map(),
      displayRefresh: { restoreAll },
      powerBlocker: { releaseAll },
      log: (line) => logs.push(line),
    });

    expect(teardown.run()).toBe(true);
    expect(syncDispose).toHaveBeenCalledTimes(1);
    expect(restoreAll).toHaveBeenCalledTimes(1);
    expect(releaseAll).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(logs.some((l) => l.includes('player boom'))).toBe(true);
    expect(logs.some((l) => l.includes('lan boom'))).toBe(true);
  });

  it('awaits async sync, downloadManager, and artworkCache flushes in flushBeforeQuit with bounded timeout', async () => {
    const settled: string[] = [];
    const dmDispose = vi.fn(async () => {
      await Promise.resolve();
      settled.push('downloadManager');
    });
    const artDispose = vi.fn(async () => {
      throw new Error('artwork flush failed');
    });

    const teardown = createQuitTeardown({
      downloadManager: { dispose: dmDispose },
      artworkCache: { dispose: artDispose },
      windowBoundsControllers: new Set(),
      aspectRatioLockControllers: new Map(),
      displayRefresh: { restoreAll: vi.fn() },
      powerBlocker: { releaseAll: vi.fn() },
    });

    await teardown.flushBeforeQuit(
      [
        async () => {
          await Promise.resolve();
          settled.push('sync');
        },
      ],
      2_500,
    );

    expect(settled).toContain('sync');
    expect(settled).toContain('downloadManager');
    expect(dmDispose).toHaveBeenCalledTimes(1);
    expect(artDispose).toHaveBeenCalledTimes(1);
    // Still keeps idempotent fallback intact for will-quit
    expect(teardown.hasRun()).toBe(false);
    expect(teardown.run()).toBe(true);
    expect(dmDispose).toHaveBeenCalledTimes(2);
    expect(artDispose).toHaveBeenCalledTimes(2);
  });

  it('bounds flushBeforeQuit when an async disposer hangs past timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const teardown = createQuitTeardown({
        downloadManager: { dispose: () => new Promise(() => undefined) },
        windowBoundsControllers: new Set(),
        aspectRatioLockControllers: new Map(),
        displayRefresh: { restoreAll: vi.fn() },
        powerBlocker: { releaseAll: vi.fn() },
      });

      let done = false;
      const p = teardown.flushBeforeQuit([], 250).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
