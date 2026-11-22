import type { CatalogService, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { act, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { createObservedCatalog } from '../../app-shell-state';
import { createPlaybackGuard } from '../../ports/playback-guard';
import { type UseGuideAutoRefreshOptions, useGuideAutoRefresh } from '../useGuideAutoRefresh';

function makeClock() {
  let current = 1_700_000_000_000;
  let nextId = 1;
  const timers = new Map<number, { runAt: number; fn: () => void }>();

  return {
    now: () => current,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { runAt: current + Math.max(0, ms), fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
    activeTimerCount: () => timers.size,
    async advance(ms: number) {
      const target = current + ms;
      while (true) {
        let earliestId: number | undefined;
        let earliestAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of timers) {
          if (entry.runAt <= target && entry.runAt < earliestAt) {
            earliestAt = entry.runAt;
            earliestId = id;
          }
        }
        if (earliestId === undefined) break;
        const entry = timers.get(earliestId);
        timers.delete(earliestId);
        current = earliestAt;
        await act(async () => {
          entry?.fn();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      current = target;
    },
  };
}

function Probe(props: UseGuideAutoRefreshOptions): ReactElement | null {
  useGuideAutoRefresh(props);
  return null;
}

const READY_SOURCE: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'Main Provider',
  createdAt: 1_699_000_000_000,
  needsImport: false,
};

const PENDING_SOURCE: SourceRow = {
  id: 'src-pending',
  kind: 'm3u',
  name: 'Pending',
  createdAt: 1_699_000_000_000,
  needsImport: true,
};

const OK_SUMMARY = ok({
  sourceId: 'src-1',
  kind: 'xtream' as const,
  counts: {
    categories: 0,
    live: 0,
    movies: 0,
    series: 0,
    episodes: 0,
    guideChannels: 10,
    programmes: 120,
  },
  durationMs: 50,
});

describe('useGuideAutoRefresh (#401)', () => {
  it('refreshes ready sources strictly after guideRefreshHours elapses and skips needsImport sources', async () => {
    const clock = makeClock();
    const importGuide = jest.fn(async () => OK_SUMMARY);
    const onGuideRefreshed = jest.fn();
    const catalog = { importGuide } as unknown as CatalogService;

    await render(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE, PENDING_SOURCE]}
        guideRefreshHours={6}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );

    // 5h 59m elapsed -> not due yet
    await clock.advance(6 * 3_600_000 - 60_000);
    expect(importGuide).not.toHaveBeenCalled();
    expect(onGuideRefreshed).not.toHaveBeenCalled();

    // Cross the 6h threshold -> triggers background guide refresh for ready source only
    await clock.advance(60_000);
    expect(importGuide).toHaveBeenCalledTimes(1);
    expect(importGuide).toHaveBeenCalledWith(
      'src-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onGuideRefreshed).toHaveBeenCalledTimes(1);
  });

  it('reacts when guideRefreshHours is lowered after partial elapsed time', async () => {
    const clock = makeClock();
    const importGuide = jest.fn(async () => OK_SUMMARY);
    const onGuideRefreshed = jest.fn();
    const catalog = { importGuide } as unknown as CatalogService;

    const view = await render(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE]}
        guideRefreshHours={24}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );

    // Advance 7 hours (not due under 24h)
    await clock.advance(7 * 3_600_000);
    expect(importGuide).not.toHaveBeenCalled();

    // Lower setting to 6h -> immediately due!
    await view.rerender(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE]}
        guideRefreshHours={6}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );
    await clock.advance(0);

    expect(importGuide).toHaveBeenCalledTimes(1);
    expect(onGuideRefreshed).toHaveBeenCalledTimes(1);
  });

  it('pauses while disabled (playing/backgrounded), aborts in-flight refresh, and cancels cleanly on unmount', async () => {
    const clock = makeClock();
    const signals: AbortSignal[] = [];
    let resolveInFlight: ((value: typeof OK_SUMMARY) => void) | undefined;
    const importGuide = jest.fn(
      (_sourceId: string, opts?: { signal?: AbortSignal }) =>
        new Promise<typeof OK_SUMMARY>((resolve) => {
          if (opts?.signal) signals.push(opts.signal);
          resolveInFlight = resolve;
        }),
    );
    const onGuideRefreshed = jest.fn();
    const catalog = { importGuide } as unknown as CatalogService;

    const view = await render(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE]}
        guideRefreshHours={6}
        enabled={false}
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );

    // While disabled, advancing 12 hours schedules zero timers and runs zero refreshes
    await clock.advance(12 * 3_600_000);
    expect(clock.activeTimerCount()).toBe(0);
    expect(importGuide).not.toHaveBeenCalled();

    // Re-enabling starts the overdue refresh
    await view.rerender(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE]}
        guideRefreshHours={6}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );
    await clock.advance(0);
    expect(importGuide).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    // Entering playback / background aborts the in-flight request
    await view.rerender(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE]}
        guideRefreshHours={6}
        enabled={false}
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );
    expect(signals[0]?.aborted).toBe(true);

    // Late resolution after abort does not notify onGuideRefreshed
    await act(async () => {
      resolveInFlight?.(OK_SUMMARY);
      await Promise.resolve();
    });
    expect(onGuideRefreshed).not.toHaveBeenCalled();

    // Re-enable to start a fresh refresh, then unmount -> aborts and leaves 0 timers
    await view.rerender(
      <Probe
        catalog={catalog}
        sources={[READY_SOURCE]}
        guideRefreshHours={6}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );
    await clock.advance(0);
    expect(importGuide).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    await view.unmount();
    expect(signals[1]?.aborted).toBe(true);
    expect(clock.activeTimerCount()).toBe(0);
  });

  it('checks persisted lastCatalogSyncAt/lastGuideSyncAt on startup, honors 0 (manual only), and applies 1h failure backoff (#68)', async () => {
    const clock = makeClock();
    const staleSource: SourceRow = {
      ...READY_SOURCE,
      lastCatalogSyncAt: clock.now() - 25 * 3_600_000,
      lastGuideSyncAt: clock.now() - 13 * 3_600_000,
    };
    const importSource = jest.fn(async () => err(elvError('network', 'offline')));
    const importGuide = jest.fn(async () => OK_SUMMARY);
    const onGuideRefreshed = jest.fn();
    const catalog = { importSource, importGuide } as unknown as CatalogService;

    const view = await render(
      <Probe
        catalog={catalog}
        sources={[staleSource]}
        catalogRefreshHours={24}
        guideRefreshHours={12}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );

    // Immediate startup check triggers both stale catalog and guide
    await clock.advance(0);
    expect(importSource).toHaveBeenCalledTimes(1);
    expect(importGuide).toHaveBeenCalledTimes(1);
    expect(onGuideRefreshed).toHaveBeenCalledTimes(1);

    // Failed catalog refresh must NOT tight-loop every 15m (1h failure backoff)
    await clock.advance(45 * 60_000);
    expect(importSource).toHaveBeenCalledTimes(1);

    // After 1h backoff elapses, catalog retries once
    await clock.advance(20 * 60_000);
    expect(importSource).toHaveBeenCalledTimes(2);

    // Setting both intervals to 0 (manual only) schedules zero timers
    await view.rerender(
      <Probe
        catalog={catalog}
        sources={[staleSource]}
        catalogRefreshHours={0}
        guideRefreshHours={0}
        enabled
        onGuideRefreshed={onGuideRefreshed}
        now={clock.now}
        setTimeoutFn={clock.setTimeoutFn}
        clearTimeoutFn={clock.clearTimeoutFn}
      />,
    );
    expect(clock.activeTimerCount()).toBe(0);
  });

  it('clears failure backoff immediately on network online event (#68)', async () => {
    const clock = makeClock();
    const listeners = new Map<string, Set<() => void>>();
    const win = globalThis as unknown as {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    const origAdd = win.addEventListener;
    const origRemove = win.removeEventListener;
    win.addEventListener = (type, fn) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    };
    win.removeEventListener = (type, fn) => {
      listeners.get(type)?.delete(fn);
    };
    try {
      const staleSource: SourceRow = {
        ...READY_SOURCE,
        lastGuideSyncAt: clock.now() - 13 * 3_600_000,
      };
      const importGuide = jest
        .fn()
        .mockResolvedValueOnce(err(elvError('network', 'offline')))
        .mockResolvedValueOnce(OK_SUMMARY);
      const onGuideRefreshed = jest.fn();
      const catalog = { importGuide } as unknown as CatalogService;

      const view = await render(
        <Probe
          catalog={catalog}
          sources={[staleSource]}
          catalogRefreshHours={0}
          guideRefreshHours={12}
          enabled
          onGuideRefreshed={onGuideRefreshed}
          now={clock.now}
          setTimeoutFn={clock.setTimeoutFn}
          clearTimeoutFn={clock.clearTimeoutFn}
        />,
      );

      await clock.advance(0);
      expect(importGuide).toHaveBeenCalledTimes(1);
      expect(onGuideRefreshed).not.toHaveBeenCalled();

      // Network reconnects 2 minutes later (well inside 1h backoff) -> retries immediately!
      await clock.advance(2 * 60_000);
      await act(async () => {
        for (const fn of listeners.get('online') ?? []) fn();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(importGuide).toHaveBeenCalledTimes(2);
      expect(onGuideRefreshed).toHaveBeenCalledTimes(1);
      await view.unmount();
    } finally {
      win.addEventListener = origAdd;
      win.removeEventListener = origRemove;
    }
  });

  it('createObservedCatalog wraps importGuide with syncSourcesAndBump so manual guide refresh invalidates cache (#68)', async () => {
    const syncSourcesAndBump = jest.fn(async () => undefined);
    const importGuide = jest.fn(async () => OK_SUMMARY);
    const rawCatalog = {
      addSource: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(async () => OK_SUMMARY),
      importGuide,
      listSources: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      seasons: jest.fn(async () => []),
      episodes: jest.fn(async () => []),
      resolveStream: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    const observed = createObservedCatalog(
      rawCatalog,
      createPlaybackGuard(() => undefined),
      syncSourcesAndBump,
    );
    await observed.importGuide?.('s1');
    expect(importGuide).toHaveBeenCalledWith('s1', undefined);
    expect(syncSourcesAndBump).toHaveBeenCalledTimes(1);
  });
});
