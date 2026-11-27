import type { CatalogService, ImportProgress, ImportSummary, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';
import {
  computeDueStartupRefreshTasks,
  type StartupRefreshCoordinator,
  type UseStartupRefreshCoordinatorOptions,
  useStartupRefreshCoordinator,
} from '../useStartupRefreshCoordinator';

const HOUR_MS = 3_600_000;
const NOW = 1_800_000_000_000;

const OK_SUMMARY: ImportSummary = {
  runId: 1,
  counts: {
    categories: 2,
    live: 10,
    movies: 5,
    series: 2,
    episodes: 0,
    guideChannels: 10,
    programmes: 40,
  },
  warnings: 0,
  warningCodes: [],
  durationMs: 100,
};

function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'src-1',
    kind: 'xtream',
    name: 'Cinema Provider',
    createdAt: NOW - 48 * HOUR_MS,
    needsImport: false,
    ...overrides,
  };
}

function Probe(
  props: UseStartupRefreshCoordinatorOptions & {
    readonly onRef: (ctrl: StartupRefreshCoordinator) => void;
  },
): ReactElement {
  const { onRef, ...opts } = props;
  const ctrl = useStartupRefreshCoordinator(opts);
  onRef(ctrl);
  return (
    <View>
      <Text testID="visible">{String(ctrl.state.overlayVisible)}</Text>
      <Text testID="running">{String(ctrl.state.running)}</Text>
      <Text testID="active-source">{ctrl.state.activeSourceName ?? 'none'}</Text>
      <Text testID="active-kind">{ctrl.state.activeKind ?? 'none'}</Text>
      <Text testID="phase">{ctrl.state.progress?.phase ?? 'none'}</Text>
      <Text testID="completed">{String(ctrl.state.completedTasks)}</Text>
      <Text testID="total">{String(ctrl.state.totalTasks)}</Text>
    </View>
  );
}

describe('useStartupRefreshCoordinator', () => {
  it('computes due catalog and guide refresh tasks accurately and ignores fresh or unpersisted sources', () => {
    const fresh = makeSource({
      id: 'fresh',
      lastCatalogSyncAt: NOW - 2 * HOUR_MS,
      lastGuideSyncAt: NOW - 2 * HOUR_MS,
    });
    const staleBoth = makeSource({
      id: 'stale',
      name: 'Stale IPTV',
      lastCatalogSyncAt: NOW - 25 * HOUR_MS,
      lastGuideSyncAt: NOW - 13 * HOUR_MS,
    });
    const pending = makeSource({
      id: 'pending',
      needsImport: true,
      lastCatalogSyncAt: NOW - 50 * HOUR_MS,
    });
    const noTimestamps = makeSource({ id: 'no-ts' });

    const tasks = computeDueStartupRefreshTasks({
      sources: [fresh, staleBoth, pending, noTimestamps],
      catalogRefreshHours: 24,
      guideRefreshHours: 12,
      hasImportGuide: true,
      nowMs: NOW,
    });

    expect(tasks).toEqual([
      { sourceId: 'stale', sourceName: 'Stale IPTV', kind: 'catalog' },
      { sourceId: 'stale', sourceName: 'Stale IPTV', kind: 'guide' },
    ]);

    // Manual-only (0h) returns empty
    expect(
      computeDueStartupRefreshTasks({
        sources: [staleBoth],
        catalogRefreshHours: 0,
        guideRefreshHours: 0,
        hasImportGuide: true,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it('hides overlay immediately on dismissOverlay WITHOUT aborting the background refresh, then calls onRefreshComplete when done', async () => {
    let signal: AbortSignal | undefined;
    let onProgress: ((p: ImportProgress) => void) | undefined;
    let resolveCatalog!: (res: ReturnType<typeof ok<ImportSummary>>) => void;

    const importSource = jest.fn(
      (_id: string, opts?: { signal?: AbortSignal; onProgress?: (p: ImportProgress) => void }) => {
        signal = opts?.signal;
        onProgress = opts?.onProgress;
        return new Promise<ReturnType<typeof ok<ImportSummary>>>((resolve) => {
          resolveCatalog = resolve;
        });
      },
    );
    const importGuide = jest.fn(async () => ok(OK_SUMMARY));
    const onRefreshComplete = jest.fn(async () => undefined);
    const catalog = { importSource, importGuide } as unknown as CatalogService;
    const stale = makeSource({
      lastCatalogSyncAt: NOW - 30 * HOUR_MS,
      lastGuideSyncAt: NOW - 14 * HOUR_MS,
    });

    let ctrl!: StartupRefreshCoordinator;
    const view = await render(
      <Probe
        catalog={catalog}
        sources={[stale]}
        catalogRefreshHours={24}
        guideRefreshHours={12}
        enabled
        now={() => NOW}
        onRefreshComplete={onRefreshComplete}
        onRef={(c) => (ctrl = c)}
      />,
    );

    expect(screen.getByTestId('visible')).toHaveTextContent('true');
    expect(screen.getByTestId('running')).toHaveTextContent('true');
    expect(screen.getByTestId('active-source')).toHaveTextContent('Cinema Provider');
    expect(screen.getByTestId('total')).toHaveTextContent('2');

    await act(async () => {
      onProgress?.({ phase: 'live', done: 10, total: 20 });
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('live');

    // User clicks "Cancel / Continue with old data" -> overlay hides, request MUST NOT abort!
    await act(async () => {
      ctrl.dismissOverlay();
    });
    expect(screen.getByTestId('visible')).toHaveTextContent('false');
    expect(screen.getByTestId('running')).toHaveTextContent('true');
    expect(signal?.aborted).toBe(false);

    // Background refresh completes catalog + guide and silently invokes onRefreshComplete
    await act(async () => {
      resolveCatalog(ok(OK_SUMMARY));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(importGuide).toHaveBeenCalledTimes(1);
    expect(onRefreshComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('running')).toHaveTextContent('false');
    expect(screen.getByTestId('visible')).toHaveTextContent('false');

    await view.unmount();
  });

  it('runs only once per cold startup and aborts cleanly on unmount', async () => {
    let signal: AbortSignal | undefined;
    const importSource = jest.fn((_id: string, opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise<ReturnType<typeof err>>(() => undefined);
    });
    const catalog = { importSource } as unknown as CatalogService;
    const stale = makeSource({ lastCatalogSyncAt: NOW - 30 * HOUR_MS });

    let ctrl!: StartupRefreshCoordinator;
    const view = await render(
      <Probe
        catalog={catalog}
        sources={[stale]}
        catalogRefreshHours={24}
        guideRefreshHours={0}
        enabled={false}
        now={() => NOW}
        onRef={(c) => (ctrl = c)}
      />,
    );
    expect(importSource).not.toHaveBeenCalled();

    await view.rerender(
      <Probe
        catalog={catalog}
        sources={[stale]}
        catalogRefreshHours={24}
        guideRefreshHours={0}
        enabled
        now={() => NOW}
        onRef={(c) => (ctrl = c)}
      />,
    );
    expect(importSource).toHaveBeenCalledTimes(1);
    expect(ctrl.state.running).toBe(true);
    expect(signal?.aborted).toBe(false);

    await view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('does not call onRefreshComplete if every due refresh fails and records sharedFailureAtRef backoff', async () => {
    const importSource = jest.fn(async () => err(elvError('network', 'offline')));
    const onRefreshComplete = jest.fn();
    const sharedFailureAtRef = { current: new Map<string, number>() };
    const catalog = { importSource } as unknown as CatalogService;
    const stale = makeSource({ lastCatalogSyncAt: NOW - 30 * HOUR_MS });

    let ctrl!: StartupRefreshCoordinator;
    const view = await render(
      <Probe
        catalog={catalog}
        sources={[stale]}
        catalogRefreshHours={24}
        guideRefreshHours={0}
        enabled
        sharedFailureAtRef={sharedFailureAtRef}
        now={() => NOW}
        onRefreshComplete={onRefreshComplete}
        onRef={(c) => (ctrl = c)}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ctrl.state.running).toBe(false);
    expect(ctrl.state.overlayVisible).toBe(false);
    expect(onRefreshComplete).not.toHaveBeenCalled();
    expect(sharedFailureAtRef.current.get('src-1\u0000catalog')).toBe(NOW);

    await view.unmount();
  });
});
