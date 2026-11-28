import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { DesktopUpdaterPort, DesktopUpdateState } from '../../ports/updater-port';
import { AboutLicensesPanel } from '../AboutLicensesPanel';

interface StatefulUpdaterMock {
  readonly port: DesktopUpdaterPort;
  readonly emit: (next: DesktopUpdateState) => void;
}

function createUpdaterMock(initial: DesktopUpdateState): StatefulUpdaterMock {
  let state = initial;
  const listeners = new Set<(s: DesktopUpdateState) => void>();
  const emit = (next: DesktopUpdateState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const port: DesktopUpdaterPort = {
    getState: jest.fn(async () => state),
    checkForUpdates: jest.fn(async () => state),
    downloadUpdate: jest.fn(async () => state),
    installUpdate: jest.fn(async () => undefined),
    openReleasePage: jest.fn(async () => true),
    subscribe: jest.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };

  return { port, emit };
}

function renderPanel(ui: ReactElement) {
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
        <ThemeProvider>{ui}</ThemeProvider>
      </I18nProvider>
    </ViewportProvider>,
  );
}

describe('AboutLicensesPanel (store-gated desktop updater)', () => {
  it('renders ZERO updater UI when updater prop is omitted (TV/mobile)', async () => {
    await renderPanel(<AboutLicensesPanel />);
    expect(screen.getByTestId('settings-about-card')).toBeTruthy();
    expect(screen.queryByTestId('settings-updater-card')).toBeNull();
  });

  it('renders ZERO updater UI when updater reports unsupported (Store builds)', async () => {
    const { port } = createUpdaterMock({ status: 'unsupported', currentVersion: '1.0.0' });
    await renderPanel(<AboutLicensesPanel updater={port} />);

    await waitFor(() => {
      expect(port.getState).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('settings-updater-card')).toBeNull();
  });

  it('renders direct update flow: idle -> checking -> available -> downloading -> downloaded -> restart & install', async () => {
    const { port, emit } = createUpdaterMock({ status: 'idle', currentVersion: '1.0.0' });
    await renderPanel(<AboutLicensesPanel updater={port} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-updater-card')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-updater-version')).toHaveTextContent('Version 1.0.0');

    // Check for updates
    await fireEvent.press(screen.getByTestId('settings-updater-check-btn'));
    expect(port.checkForUpdates).toHaveBeenCalledTimes(1);

    // Emit checking -> available
    await act(async () => {
      emit({ status: 'checking', currentVersion: '1.0.0' });
    });
    expect(screen.getByTestId('settings-updater-status')).toHaveTextContent(
      'Checking for updates…',
    );

    await act(async () => {
      emit({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '1.2.0',
        releaseNotes: '- Faster guide loading\n- Smoother playback',
      });
    });
    expect(screen.getByTestId('settings-updater-status')).toHaveTextContent(
      'Version 1.2.0 is available',
    );
    expect(screen.getByTestId('settings-updater-release-notes')).toHaveTextContent(
      /Faster guide loading/,
    );

    // Download update
    await fireEvent.press(screen.getByTestId('settings-updater-download-btn'));
    expect(port.downloadUpdate).toHaveBeenCalledTimes(1);

    // Emit downloading progress
    await act(async () => {
      emit({
        status: 'downloading',
        currentVersion: '1.0.0',
        availableVersion: '1.2.0',
        downloadPercent: 55,
      });
    });
    expect(screen.getByTestId('settings-updater-status')).toHaveTextContent(
      'Downloading update (55%)',
    );
    expect(screen.getByTestId('settings-updater-progress')).toBeTruthy();

    // Emit downloaded -> Restart & install
    await act(async () => {
      emit({
        status: 'downloaded',
        currentVersion: '1.0.0',
        availableVersion: '1.2.0',
        downloadPercent: 100,
      });
    });
    expect(screen.getByTestId('settings-updater-status')).toHaveTextContent(
      'Version 1.2.0 is ready to install',
    );
    await fireEvent.press(screen.getByTestId('settings-updater-install-btn'));
    expect(port.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('renders Open release page instead of Download update for manual-linux or manual fallback', async () => {
    const { port } = createUpdaterMock({
      status: 'available',
      currentVersion: '1.0.0',
      availableVersion: '1.2.0',
      releaseNotes: 'Linux manual tarball update',
      manualDownloadUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0',
    });
    await renderPanel(<AboutLicensesPanel updater={port} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-updater-open-release-btn')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-updater-download-btn')).toBeNull();

    await fireEvent.press(screen.getByTestId('settings-updater-open-release-btn'));
    expect(port.openReleasePage).toHaveBeenCalledTimes(1);
  });

  it('shows up-to-date and error captions cleanly', async () => {
    const { port, emit } = createUpdaterMock({ status: 'up-to-date', currentVersion: '1.2.0' });
    await renderPanel(<AboutLicensesPanel updater={port} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-updater-status')).toHaveTextContent('Up to date');
    });

    await act(async () => {
      emit({
        status: 'error',
        currentVersion: '1.2.0',
        errorCode: 'checksum_mismatch',
        manualDownloadUrl: 'https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.3.0',
      });
    });
    expect(screen.getByTestId('settings-updater-status')).toHaveTextContent(/verification failed/i);
    expect(screen.getByTestId('settings-updater-open-release-btn')).toBeTruthy();
  });

  it('resets installing state back to false if installUpdate resolves without exiting or rejects', async () => {
    const { port } = createUpdaterMock({
      status: 'downloaded',
      currentVersion: '1.0.0',
      availableVersion: '1.2.0',
      downloadPercent: 100,
    });
    await renderPanel(<AboutLicensesPanel updater={port} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-updater-install-btn')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('settings-updater-install-btn'));
    expect(port.installUpdate).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByTestId('settings-updater-status')).toHaveTextContent(
        'Version 1.2.0 is ready to install',
      );
      expect(screen.getByTestId('settings-updater-install-btn')).toHaveTextContent(
        'Restart & install',
      );
    });

    await fireEvent.press(screen.getByTestId('settings-updater-install-btn'));
    expect(port.installUpdate).toHaveBeenCalledTimes(2);
  });
});
