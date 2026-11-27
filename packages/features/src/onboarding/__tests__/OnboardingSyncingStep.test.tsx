import type { CatalogService, ImportSummary, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { SyncAccountPort, SyncAccountState } from '../../ports/wave-f9-ports';
import { OnboardingSyncingStep } from '../OnboardingSyncingStep';

function createSyncMock(overrides: Partial<SyncAccountPort> = {}): SyncAccountPort {
  const state: SyncAccountState = {
    status: 'signed_in',
    email: 'viewer@example.com',
    lastSyncedAtIso: null,
    pendingRecoveryCode: null,
    errorCode: null,
  };
  return {
    getState: jest.fn(() => state),
    subscribe: jest.fn(() => () => undefined),
    signIn: jest.fn(async () => ({ ok: true })),
    register: jest.fn(async () => ({ ok: true })),
    acknowledgeRecoveryCode: jest.fn(),
    syncNow: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => undefined),
    deleteAccount: jest.fn(async () => ({ ok: true })),
    createQrPairing: jest.fn(),
    pollQrPairing: jest.fn(),
    claimQrPairing: jest.fn(),
    ...overrides,
  };
}

function makeImportSummary(runId = 1): ImportSummary {
  return {
    runId,
    counts: { live: 10, movies: 20, series: 5 },
    warnings: 0,
    warningCodes: [],
    durationMs: 120,
  };
}

function createCatalogMock(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    listSources: jest.fn(async () => []),
    importSource: jest.fn(async () => ok(makeImportSummary(1))),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    listContinueWatching: jest.fn(async () => []),
    listFavorites: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    close: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogService;
}

function wrap(ui: ReactElement) {
  return render(
    <ViewportProvider
      value={{
        formFactor: 'desktop',
        orientation: 'landscape',
        inputModality: 'pointer',
        width: 1280,
        height: 800,
      }}
    >
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider reduceMotion>{ui}</ThemeProvider>
      </I18nProvider>
    </ViewportProvider>,
  );
}

describe('OnboardingSyncingStep — 3-stage post-pair hydration gate (#16B)', () => {
  it('calls onSyncComplete(0) immediately after Stage 1 when zero sources were restored', async () => {
    const syncAccount = createSyncMock();
    const catalog = createCatalogMock({ listSources: jest.fn(async () => []) });
    const onRefreshProfiles = jest.fn(async () => undefined);
    const onSyncComplete = jest.fn();

    await wrap(
      <OnboardingSyncingStep
        catalog={catalog}
        syncAccount={syncAccount}
        onRefreshProfiles={onRefreshProfiles}
        onSyncComplete={onSyncComplete}
      />,
    );

    await waitFor(() => {
      expect(syncAccount.syncNow).toHaveBeenCalledTimes(1);
      expect(onRefreshProfiles).toHaveBeenCalledTimes(1);
      expect(onSyncComplete).toHaveBeenCalledWith(0);
    });
    expect(catalog.importSource).not.toHaveBeenCalled();
  });

  it('imports un-imported restored sources sequentially with live progress before prewarm & onSyncComplete', async () => {
    const sources: SourceRow[] = [
      { id: 'xt-1', kind: 'xtream', name: 'Cinema Plus', createdAt: 1, needsImport: true },
      { id: 'm3u-2', kind: 'm3u', name: 'Backup List', createdAt: 2, needsImport: true },
    ];
    let activeImports = 0;
    let maxConcurrentImports = 0;
    let resolveFirst!: () => void;

    const importSource = jest.fn(
      async (
        id: string,
        opts?: {
          readonly onProgress?: (p: {
            phase: 'live' | 'movies' | 'series';
            done: number;
            total?: number;
          }) => void;
        },
      ) => {
        activeImports += 1;
        maxConcurrentImports = Math.max(maxConcurrentImports, activeImports);
        if (id === 'xt-1') {
          opts?.onProgress?.({ phase: 'movies', done: 25, total: 100 });
          await new Promise<void>((r) => {
            resolveFirst = r;
          });
        } else {
          opts?.onProgress?.({ phase: 'live', done: 40, total: 40 });
        }
        activeImports -= 1;
        return ok(makeImportSummary(1));
      },
    );

    const catalog = createCatalogMock({
      listSources: jest.fn(async () => sources),
      importSource,
    });
    const onPrewarmReady = jest.fn(async () => undefined);
    const onSyncComplete = jest.fn();

    await wrap(
      <OnboardingSyncingStep
        catalog={catalog}
        syncAccount={createSyncMock()}
        onRefreshProfiles={jest.fn(async () => undefined)}
        onPrewarmReady={onPrewarmReady}
        onSyncComplete={onSyncComplete}
      />,
    );

    // Stage 2 starts importing xt-1 and MUST NOT invoke onSyncComplete while import is still active
    await waitFor(() => {
      expect(importSource).toHaveBeenCalledWith(
        'xt-1',
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(screen.getByTestId('onboarding-sync-stage-label')).toHaveTextContent(
        /Loading sources/i,
      );
      expect(screen.getByTestId('onboarding-sync-source-status')).toHaveTextContent(/Cinema Plus/);
      expect(screen.getByTestId('onboarding-sync-source-status')).toHaveTextContent(/25/);
    });
    expect(onSyncComplete).not.toHaveBeenCalled();

    // Finish first import -> triggers second import sequentially -> prewarm -> completes with 2
    await act(async () => {
      resolveFirst();
    });

    await waitFor(() => {
      expect(importSource).toHaveBeenCalledTimes(2);
      expect(importSource).toHaveBeenNthCalledWith(2, 'm3u-2', expect.any(Object));
      expect(onPrewarmReady).toHaveBeenCalledWith(sources);
      expect(onSyncComplete).toHaveBeenCalledWith(2);
    });
    expect(maxConcurrentImports).toBe(1);
  });

  it('skips importSource for already-imported sources and runs Stage 3 prewarm before entering app', async () => {
    const sources: SourceRow[] = [
      { id: 'xt-ready', kind: 'xtream', name: 'Ready Source', createdAt: 1, needsImport: false },
    ];
    const catalog = createCatalogMock({
      listSources: jest.fn(async () => sources),
    });
    const onSyncComplete = jest.fn();

    await wrap(
      <OnboardingSyncingStep
        catalog={catalog}
        syncAccount={createSyncMock()}
        onRefreshProfiles={jest.fn(async () => undefined)}
        onSyncComplete={onSyncComplete}
      />,
    );

    await waitFor(() => {
      expect(onSyncComplete).toHaveBeenCalledWith(1);
    });
    expect(catalog.importSource).not.toHaveBeenCalled();
    expect(catalog.categories).toHaveBeenCalled();
  });

  it('shows non-blocking Retry and Continue to App actions when a restored source fails to import', async () => {
    let sources: SourceRow[] = [
      { id: 'xt-fail', kind: 'xtream', name: 'Slow Provider', createdAt: 1, needsImport: true },
    ];
    let attempt = 0;
    const importSource = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return err(elvError('network', 'timeout'));
      }
      sources = [
        { id: 'xt-fail', kind: 'xtream', name: 'Slow Provider', createdAt: 1, needsImport: false },
      ];
      return ok(makeImportSummary(2));
    });

    const catalog = createCatalogMock({
      listSources: jest.fn(async () => sources),
      importSource,
    });
    const onSyncComplete = jest.fn();

    await wrap(
      <OnboardingSyncingStep
        catalog={catalog}
        syncAccount={createSyncMock()}
        onRefreshProfiles={jest.fn(async () => undefined)}
        onSyncComplete={onSyncComplete}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-sync-retry')).toBeTruthy();
      expect(screen.getByTestId('onboarding-sync-continue')).toBeTruthy();
    });
    expect(onSyncComplete).not.toHaveBeenCalled();

    // Pressing Retry completes Stage 2 & Stage 3 cleanly
    await fireEvent.press(screen.getByTestId('onboarding-sync-retry'));
    await waitFor(() => {
      expect(importSource).toHaveBeenCalledTimes(2);
      expect(onSyncComplete).toHaveBeenCalledWith(1);
    });

    // And pressing Continue to App in an error state exits non-blockingly with source count
    attempt = 0;
    sources = [
      { id: 'xt-fail', kind: 'xtream', name: 'Slow Provider', createdAt: 1, needsImport: true },
    ];
    const onContinueComplete = jest.fn();
    await wrap(
      <OnboardingSyncingStep
        catalog={createCatalogMock({
          listSources: jest.fn(async () => sources),
          importSource: jest.fn(async () => err(elvError('network', 'timeout'))),
        })}
        syncAccount={createSyncMock()}
        onRefreshProfiles={jest.fn(async () => undefined)}
        onSyncComplete={onContinueComplete}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-sync-continue')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('onboarding-sync-continue'));
    expect(onContinueComplete).toHaveBeenCalledWith(1);
  });
});
