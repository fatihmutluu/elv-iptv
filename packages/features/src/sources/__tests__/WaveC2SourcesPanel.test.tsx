import type { SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SavedSourcesPanel } from '../SavedSourcesPanel';
import type { SourcesController } from '../useSourcesController';

describe('Wave C2 SavedSourcesPanel (#68)', () => {
  it('renders last synced timestamps and per-source Refresh guide button', async () => {
    const runGuideRefresh = jest.fn(async () => undefined);
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
      runGuideRefresh,
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
              />
            </ViewportProvider>
          </FormFactorProvider>
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('source-last-synced-s1').props.children).toContain('2h');
    expect(screen.getByTestId('source-last-synced-s2').props.children).toBe('Not synced yet');
    await fireEvent.press(screen.getByTestId('source-refresh-guide-s1'));
    expect(runGuideRefresh).toHaveBeenCalledWith('s1');
  });
});
