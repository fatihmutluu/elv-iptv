import type { CatalogService, ImportOptions, ImportProgress, ImportSummary } from '@elv/data';
import { elvError, err, type Result } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { importProgressPercent } from '../SavedSourcesPanel';
import { SourcesScreen } from '../SourcesScreen';
import { openTestCatalog } from './sources-test-harness';

describe('SourcesScreen localized HTTP errors & moving import progress (#63, #65)', () => {
  it('computes monotonic importProgressPercent preferring percent, then done/total, then smooth curve from done', () => {
    expect(importProgressPercent(undefined)).toBe(0);
    expect(importProgressPercent({ kind: 'importing', progress: null })).toBeGreaterThan(0);
    expect(importProgressPercent({ kind: 'importing', progress: null })).toBeLessThan(15);

    expect(
      importProgressPercent({
        kind: 'importing',
        progress: { phase: 'movies', done: 420, total: 1000, percent: 68 },
      }),
    ).toBe(68);

    expect(
      importProgressPercent({
        kind: 'importing',
        progress: { phase: 'live', done: 25, total: 100 },
      }),
    ).toBe(25);

    const p0 = importProgressPercent({ kind: 'importing', progress: { phase: 'live', done: 0 } });
    const p50 = importProgressPercent({
      kind: 'importing',
      progress: { phase: 'live', done: 50 },
    });
    const p500 = importProgressPercent({
      kind: 'importing',
      progress: { phase: 'live', done: 500 },
    });
    const p5000 = importProgressPercent({
      kind: 'importing',
      progress: { phase: 'live', done: 5000 },
    });
    expect(p0).toBeLessThan(p50);
    expect(p50).toBeLessThan(p500);
    expect(p500).toBeLessThan(p5000);
    expect(p5000).toBeLessThanOrEqual(95);
  });

  it('renders localized HTTP status line for source import errors in EN & TR without leaking raw jargon (#63)', async () => {
    const env = await openTestCatalog();
    const i18n = createAppI18n('en');
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'Http Error Source',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
      });
      if (!added.ok) throw new Error(added.error.code);

      const failingCatalog: CatalogService = {
        ...env.catalog,
        async importSource() {
          return err(elvError('auth', 'http-403', 'TypeError: Forbidden at fetch.ts:1:1'));
        },
      };

      const view = await render(
        <ThemeProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={i18n}>
              <SourcesScreen catalog={failingCatalog} />
            </I18nProvider>
          </FormFactorProvider>
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId(`source-import-${added.value.id}`)).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId(`source-import-${added.value.id}`));

      await waitFor(() => {
        expect(screen.getByTestId(`source-http-status-${added.value.id}`)).toHaveTextContent(
          'Server returned HTTP 403',
        );
      });
      expect(screen.getByTestId(`source-error-${added.value.id}`).props.children).not.toContain(
        'TypeError',
      );

      await act(async () => {
        i18n.setLocale('tr');
      });
      expect(screen.getByTestId(`source-http-status-${added.value.id}`)).toHaveTextContent(
        'Sunucu HTTP 403 döndürdü',
      );

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('updates moving progress bar across phases and preserves committed ready state on Cancel (#65)', async () => {
    const env = await openTestCatalog();
    const i18n = createAppI18n('en');
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'Live Progress Source',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
      });
      if (!added.ok) throw new Error(added.error.code);
      const sourceId = added.value.id;

      // Commit initial ready catalog first so needsImport === false
      const firstImport = await env.catalog.importSource(sourceId);
      expect(firstImport.ok).toBe(true);

      let emitProgress: ((p: ImportProgress) => void) | undefined;
      let finishRefresh!: (res: Result<ImportSummary>) => void;
      let abortedObserved = false;

      const controlledCatalog: CatalogService = {
        ...env.catalog,
        importSource(_id: string, opts?: ImportOptions) {
          emitProgress = opts?.onProgress;
          return new Promise((resolve) => {
            finishRefresh = resolve;
            opts?.signal?.addEventListener('abort', () => {
              abortedObserved = true;
              resolve(err(elvError('network', 'aborted')));
            });
          });
        },
      };

      const view = await render(
        <ThemeProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={i18n}>
              <SourcesScreen catalog={controlledCatalog} />
            </I18nProvider>
          </FormFactorProvider>
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId(`source-refresh-${sourceId}`)).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId(`source-refresh-${sourceId}`));

      await waitFor(() => {
        expect(screen.getByTestId(`source-progress-bar-${sourceId}`)).toBeTruthy();
      });

      // Emit monotonic progress updates across phases
      await act(async () => {
        emitProgress?.({ phase: 'categories', done: 4, total: 10, percent: 18 });
      });
      const bar1 = screen.getByTestId(`source-progress-bar-${sourceId}`);
      expect(bar1.props.accessibilityRole).toBe('progressbar');
      expect(bar1.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 18 });
      expect(screen.getByTestId(`source-status-${sourceId}`)).toHaveTextContent(
        'categories · 4 (18%)',
      );

      await act(async () => {
        emitProgress?.({ phase: 'movies', done: 420, total: 600, percent: 68 });
      });
      const bar2 = screen.getByTestId(`source-progress-bar-${sourceId}`);
      expect(bar2.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 68 });
      expect(screen.getByTestId(`source-status-${sourceId}`)).toHaveTextContent(
        'movies · 420 (68%)',
      );

      // Cancel mid-refresh: AbortController fires and previously committed ready status stays intact
      await fireEvent.press(screen.getByTestId(`source-cancel-${sourceId}`));

      await waitFor(() => {
        expect(abortedObserved).toBe(true);
        expect(screen.queryByTestId(`source-progress-bar-${sourceId}`)).toBeNull();
        expect(screen.getByTestId(`source-refresh-${sourceId}`)).toBeTruthy();
      });
      expect(screen.queryByTestId(`source-error-${sourceId}`)).toBeNull();
      expect(screen.getByTestId(`source-status-${sourceId}`)).toHaveTextContent('Ready');
      expect(finishRefresh).toBeDefined();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
