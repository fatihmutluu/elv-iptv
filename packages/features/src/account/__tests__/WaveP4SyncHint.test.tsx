import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import type { SyncAccountPort, SyncAccountState } from '../../ports/wave-f9-ports';
import { AccountSignedInSection } from '../AccountSignedInSection';

describe('Wave P4 AccountSignedInSection initialPrefsHint', () => {
  it('renders sync.initialPrefsHint caption in AccountSignedInSection', async () => {
    const i18n = createAppI18n('en');
    const syncState: SyncAccountState = {
      status: 'signed_in',
      email: 'viewer@example.test',
      lastSyncedAtIso: null,
      pendingRecoveryCode: null,
      errorCode: null,
    };
    const syncAccount = {
      syncNow: jest.fn(async () => ok(undefined)),
      signOut: jest.fn(async () => ok(undefined)),
      claimQrPairing: jest.fn(async () => ok(undefined)),
      deleteAccount: jest.fn(async () => ok(undefined)),
      acknowledgeRecoveryCode: jest.fn(),
    } as unknown as SyncAccountPort;

    await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider reduceMotion>
          <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
            <AccountSignedInSection
              syncAccount={syncAccount}
              state={syncState}
              isTv={false}
              isActiveScope
              onDeleteSuccess={jest.fn()}
            />
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    expect(screen.getByTestId('account-sync-initial-prefs-hint')).toBeTruthy();
    expect(screen.getByText(i18n.t('sync.initialPrefsHint'))).toBeTruthy();
  });
});
