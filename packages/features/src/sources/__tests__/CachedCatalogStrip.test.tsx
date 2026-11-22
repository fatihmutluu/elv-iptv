import type { SourceImportHealth } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { buildTheme, I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { CachedCatalogStrip } from '../CachedCatalogStrip';

const FAILED_HEALTH: SourceImportHealth = {
  sourceId: 'src-1',
  status: 'failed',
  errorCategory: 'network',
  errorCode: 'http-503',
  finishedAt: 1_700_000_000_000,
  hasCachedItems: true,
};

describe('CachedCatalogStrip (#141)', () => {
  it('renders nothing when healthy or when no cached items exist', async () => {
    const i18n = createAppI18n('en');
    const view = await render(
      <I18nProvider i18n={i18n}>
        <CachedCatalogStrip health={[]} onRetry={jest.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('cached-catalog-strip')).toBeNull();

    await view.rerender(
      <I18nProvider i18n={i18n}>
        <CachedCatalogStrip
          health={[{ ...FAILED_HEALTH, hasCachedItems: false }]}
          onRetry={jest.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('cached-catalog-strip')).toBeNull();
    await view.unmount();
  });

  it('renders localized warning copy and invokes onRetry when Check again is pressed', async () => {
    const onRetry = jest.fn();
    const i18n = createAppI18n('en');
    const view = await render(
      <I18nProvider i18n={i18n}>
        <CachedCatalogStrip health={[FAILED_HEALTH]} onRetry={onRetry} />
      </I18nProvider>,
    );

    expect(screen.getByTestId('cached-catalog-strip')).toBeTruthy();
    expect(screen.getByText('Showing cached catalog — provider refresh failed')).toBeTruthy();
    const retryBtn = screen.getByTestId('cached-catalog-retry');
    expect(screen.getByText('Check again')).toBeTruthy();

    await fireEvent.press(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Switches cleanly to Turkish & retrying state
    const trI18n = createAppI18n('tr');
    await view.rerender(
      <I18nProvider i18n={trI18n}>
        <CachedCatalogStrip health={[FAILED_HEALTH]} onRetry={onRetry} retrying />
      </I18nProvider>,
    );
    expect(
      screen.getByText('Önbellekteki katalog gösteriliyor — sağlayıcı yenilemesi başarısız oldu'),
    ).toBeTruthy();
    expect(screen.getByText('Kontrol ediliyor…')).toBeTruthy();
    await view.unmount();
  });

  it('uses live Cinema Quietude theme tokens including High Contrast (AAA)', async () => {
    const i18n = createAppI18n('en');
    const hcTheme = buildTheme({ preset: 'highContrast' });
    const view = await render(
      <ThemeProvider preset="highContrast">
        <I18nProvider i18n={i18n}>
          <CachedCatalogStrip health={[FAILED_HEALTH]} onRetry={jest.fn()} />
        </I18nProvider>
      </ThemeProvider>,
    );

    const stripStyle = StyleSheet.flatten(screen.getByTestId('cached-catalog-strip').props.style);
    expect(stripStyle?.backgroundColor).toBe(hcTheme.colors.bgElevated);
    await view.unmount();
  });
});
