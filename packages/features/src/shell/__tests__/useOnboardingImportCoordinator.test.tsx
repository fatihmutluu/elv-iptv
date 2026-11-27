import type { CatalogService, ImportProgress, ImportSummary } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { act, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';
import {
  type OnboardingImportCoordinator,
  type UseOnboardingImportCoordinatorOptions,
  useOnboardingImportCoordinator,
} from '../useOnboardingImportCoordinator';

function makeSummary(live = 5, movies = 3, series = 2): ImportSummary {
  return {
    runId: 1,
    counts: {
      categories: 3,
      live,
      movies,
      series,
      episodes: 0,
      guideChannels: 0,
      programmes: 0,
    },
    warnings: 0,
    warningCodes: [],
    durationMs: 120,
  };
}

function Probe(
  props: UseOnboardingImportCoordinatorOptions & {
    readonly onRef: (ctrl: OnboardingImportCoordinator) => void;
  },
): ReactElement {
  const { onRef, ...opts } = props;
  const ctrl = useOnboardingImportCoordinator(opts);
  onRef(ctrl);
  return (
    <View>
      <Text testID="status">{ctrl.state.status}</Text>
      <Text testID="source-id">{ctrl.state.sourceId ?? 'none'}</Text>
      <Text testID="phase">{ctrl.state.progress?.phase ?? 'none'}</Text>
      <Text testID="error">{ctrl.state.errorMessageId ?? 'none'}</Text>
    </View>
  );
}

describe('useOnboardingImportCoordinator', () => {
  it('tracks progress, awaits onImportComplete before transitioning to ready, and survives parent rerenders', async () => {
    let capturedOnProgress: ((p: ImportProgress) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    let resolveImport!: (res: ReturnType<typeof ok<ImportSummary>>) => void;

    const importSource = jest.fn(
      (
        _sourceId: string,
        opts?: { signal?: AbortSignal; onProgress?: (p: ImportProgress) => void },
      ) => {
        capturedOnProgress = opts?.onProgress;
        capturedSignal = opts?.signal;
        return new Promise<ReturnType<typeof ok<ImportSummary>>>((resolve) => {
          resolveImport = resolve;
        });
      },
    );
    const catalog = { importSource } as unknown as CatalogService;

    let resolveComplete!: () => void;
    const onImportComplete = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveComplete = resolve;
        }),
    );

    let ctrl!: OnboardingImportCoordinator;
    const view = await render(
      <Probe catalog={catalog} onImportComplete={onImportComplete} onRef={(c) => (ctrl = c)} />,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('idle');

    await act(async () => {
      ctrl.startImport('src-1');
    });

    expect(screen.getByTestId('status')).toHaveTextContent('importing');
    expect(screen.getByTestId('source-id')).toHaveTextContent('src-1');
    expect(capturedSignal?.aborted).toBe(false);

    // Rerender simulating step navigation -> must NOT abort active import
    await view.rerender(
      <Probe catalog={catalog} onImportComplete={onImportComplete} onRef={(c) => (ctrl = c)} />,
    );
    expect(capturedSignal?.aborted).toBe(false);

    await act(async () => {
      capturedOnProgress?.({ phase: 'movies', done: 40, total: 100 });
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('movies');

    await act(async () => {
      resolveImport(ok(makeSummary()));
      await Promise.resolve();
    });

    expect(onImportComplete).toHaveBeenCalledWith('src-1');
    // Stays importing until onImportComplete settles so Home/catalog cache is warm first
    expect(screen.getByTestId('status')).toHaveTextContent('importing');

    await act(async () => {
      resolveComplete();
      await Promise.resolve();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('ready');

    await view.unmount();
  });

  it('surfaces localized error on failed or empty import and supports retryImport and reset', async () => {
    const importSource = jest
      .fn()
      .mockResolvedValueOnce(err(elvError('network', 'timeout')))
      .mockResolvedValueOnce(ok(makeSummary(0, 0, 0)))
      .mockResolvedValueOnce(ok(makeSummary(2, 0, 0)));
    const catalog = { importSource } as unknown as CatalogService;
    const onImportComplete = jest.fn();

    let ctrl!: OnboardingImportCoordinator;
    const view = await render(
      <Probe catalog={catalog} onImportComplete={onImportComplete} onRef={(c) => (ctrl = c)} />,
    );

    // 1. Network timeout -> error state
    await act(async () => {
      ctrl.startImport('src-err');
      await Promise.resolve();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('error');
    expect(screen.getByTestId('error')).toHaveTextContent('source.error.timeout');

    // 2. Retry -> empty playlist error
    await act(async () => {
      ctrl.retryImport();
      await Promise.resolve();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('error');
    expect(screen.getByTestId('error')).toHaveTextContent('source.error.emptyPlaylist');

    // 3. Retry -> succeeds
    await act(async () => {
      ctrl.retryImport();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('ready');
    expect(onImportComplete).toHaveBeenCalledWith('src-err');

    // 4. Reset clears state
    await act(async () => {
      ctrl.reset();
    });
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
    expect(screen.getByTestId('source-id')).toHaveTextContent('none');

    await view.unmount();
  });

  it('aborts in-flight import cleanly only when unmounted', async () => {
    let signal: AbortSignal | undefined;
    const importSource = jest.fn((_id: string, opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise<ReturnType<typeof ok<ImportSummary>>>(() => undefined);
    });
    const catalog = { importSource } as unknown as CatalogService;

    let ctrl!: OnboardingImportCoordinator;
    const view = await render(<Probe catalog={catalog} onRef={(c) => (ctrl = c)} />);

    await act(async () => {
      ctrl.startImport('src-abort');
    });
    expect(signal?.aborted).toBe(false);

    await view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
