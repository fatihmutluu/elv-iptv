import type { SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SavedSourcesPanel } from '../SavedSourcesPanel';
import type { SourcesController } from '../useSourcesController';

describe('Wave C2 / Wave P7 SavedSourcesPanel (#68)', () => {
  it('renders last synced timestamps and 3 clean buttons (Refresh, Remove, Advanced) without source-name suffixes', async () => {
    const onOpenAdvanced = jest.fn();
    const readySource: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Main IPTV',
      createdAt: 1_700_000_000_000,
      needsImport: false,
      lastCatalogSyncAt: 1_700_000_000_000,
      lastGuideSyncAt: null,
    };
    const neverSource: SourceRow = {
      id: 's2',
      kind: 'm3u',
      name: 'Fresh M3U',
      createdAt: 1_700_000_000_000,
      needsImport: true,
      lastCatalogSyncAt: null,
      lastGuideSyncAt: null,
    };
    const ctrl = {
      sources: [readySource, neverSource],
      statusById: {},
      canRefreshGuide: true,
      runImport: jest.fn(async () => undefined),
      runGuideRefresh: jest.fn(async () => undefined),
      cancelImport: jest.fn(),
      remove: jest.fn(async () => undefined),
    } as unknown as SourcesController;

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 720,
              }}
            >
              <SavedSourcesPanel
                ctrl={ctrl}
                i18n={createAppI18n('en')}
                twoColumn={false}
                tvFocusId={undefined}
                nowMs={1_700_000_000_000 + 2 * 3_600_000}
                onOpenAdvanced={onOpenAdvanced}
              />
            </ViewportProvider>
          </FormFactorProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('source-last-synced-s1').props.children).toContain('2h');
    expect(screen.getByTestId('source-last-synced-s2').props.children).toBe('Not synced yet');
    expect(screen.getByTestId('source-refresh-s1')).toHaveTextContent('Refresh');
    expect(screen.getByTestId('source-remove-s1')).toHaveTextContent('Remove');
    expect(screen.getByTestId('source-advanced-s1')).toHaveTextContent('Advanced');
    expect(screen.queryByTestId('source-refresh-guide-s1')).toBeNull();
    await fireEvent.press(screen.getByTestId('source-advanced-s1'));
    expect(onOpenAdvanced).toHaveBeenCalledWith(readySource);
  });

  it('renders quiet tabular-nums account health caption for healthy expiry and connection quota without adding extra warning pills (Wave Q6)', async () => {
    const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0);
    const healthySource: SourceRow = {
      id: 's-healthy',
      kind: 'xtream',
      name: 'Healthy IPTV',
      createdAt: nowMs - 86_400_000,
      needsImport: false,
      lastCatalogSyncAt: nowMs - 3_600_000,
      lastGuideSyncAt: null,
      accountMeta: {
        isTrial: false,
        expiresAt: Date.UTC(2027, 2, 20, 0, 0, 0),
        maxConnections: 3,
        activeConnections: 1,
      },
    };
    const ctrl = {
      sources: [healthySource],
      statusById: {},
      canRefreshGuide: true,
      runImport: jest.fn(async () => undefined),
      runGuideRefresh: jest.fn(async () => undefined),
      cancelImport: jest.fn(),
      remove: jest.fn(async () => undefined),
    } as unknown as SourcesController;

    await render(
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <FormFactorProvider value="desktop">
            <ViewportProvider
              value={{
                formFactor: 'desktop',
                orientation: 'landscape',
                inputModality: 'pointer',
                width: 1280,
                height: 720,
              }}
            >
              <SavedSourcesPanel
                ctrl={ctrl}
                i18n={createAppI18n('en')}
                twoColumn={false}
                tvFocusId={undefined}
                nowMs={nowMs}
              />
            </ViewportProvider>
          </FormFactorProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('source-account-warning-s-healthy')).toBeNull();
    const healthCaption = screen.getByTestId('source-account-health-s-healthy');
    expect(healthCaption.props.children).toContain('Expires');
    expect(healthCaption.props.children).toContain('2027');
    expect(healthCaption.props.children).toContain('1/3 connections');
  });
});
