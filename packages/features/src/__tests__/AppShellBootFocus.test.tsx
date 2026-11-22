import type { CatalogService } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { act, render, screen } from '@testing-library/react-native';
import { AppShell } from '../AppShell';
import type { VideoHost } from '../ports/video-host';

function createPendingCatalog() {
  let resolveListSources: ((rows: []) => void) | undefined;
  const catalog = {
    listSources: () =>
      new Promise<[]>((resolve) => {
        resolveListSources = resolve;
      }),
    close: async () => undefined,
  } as unknown as CatalogService;
  return {
    catalog,
    finishInitialLoad: () => resolveListSources?.([]),
  };
}

const noopVideoHost: VideoHost = { open: () => null };

describe('AppShell TV boot focus anchor (#186)', () => {
  it('mounts app-shell-boot-focus-anchor on TV while initial sources resolve and unmounts once resolved', async () => {
    const tvPending = createPendingCatalog();
    const tvView = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <AppShell catalog={tvPending.catalog} videoHost={noopVideoHost} />
        </I18nProvider>
      </FormFactorProvider>,
    );

    expect(screen.getByTestId('app-shell-boot')).toBeTruthy();
    const anchor = screen.getByTestId('app-shell-boot-focus-anchor', {
      includeHiddenElements: true,
    });
    expect(anchor.props.focusable).toBe(true);
    expect(anchor.props.hasTVPreferredFocus).toBe(true);

    await act(async () => {
      tvPending.finishInitialLoad();
    });
    expect(
      screen.queryByTestId('app-shell-boot-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();
    await tvView.unmount();

    const desktopPending = createPendingCatalog();
    const desktopView = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <AppShell catalog={desktopPending.catalog} videoHost={noopVideoHost} />
        </I18nProvider>
      </FormFactorProvider>,
    );
    expect(screen.getByTestId('app-shell-boot')).toBeTruthy();
    expect(
      screen.queryByTestId('app-shell-boot-focus-anchor', { includeHiddenElements: true }),
    ).toBeNull();
    await act(async () => {
      desktopPending.finishInitialLoad();
    });
    await desktopView.unmount();
  });
});
