import type { CatalogService, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import type {
  LanPairingPort,
  LanPairingSession,
  LanPairingSourcePayload,
} from '../../ports/lan-pairing-host';
import { formatPairingCountdown, QrPairingOverlay } from '../QrPairingOverlay';
import { SourcesScreen } from '../SourcesScreen';

function wrapProviders(node: ReactElement): ReactElement {
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider preset="obsidianCrimson">{node}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

const ADDED_SOURCE: SourceRow = {
  id: 's_qr_1',
  kind: 'xtream',
  name: 'Living Room TV',
  createdAt: 1000,
  needsImport: true,
};

function createFakeCatalog(): CatalogService {
  return {
    addSource: jest.fn(async () => ok(ADDED_SOURCE)),
    addSourceFromLink: jest.fn(async () => ok({ ...ADDED_SOURCE, kind: 'm3u' as const })),
    removeSource: jest.fn(async () => ok(undefined)),
    importSource: jest.fn(async () =>
      ok({
        categories: 1,
        live: 5,
        movies: 0,
        series: 0,
        episodes: 0,
        guideChannels: 0,
        programmes: 0,
      }),
    ),
    listSources: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;
}

describe('QrPairingOverlay & SourcesScreen QR pairing (#50)', () => {
  it('formats countdown strings cleanly', () => {
    expect(formatPairingCountdown(300_000)).toBe('5:00');
    expect(formatPairingCountdown(65_000)).toBe('1:05');
    expect(formatPairingCountdown(0)).toBe('0:00');
  });

  it('starts session, renders QR code + fallback URL + countdown, handles expiry + regenerate, and stops on close/unmount', async () => {
    const nowMs = 10_000;
    let sessionCount = 0;
    const stopSession = jest.fn(async () => undefined);
    const startSession = jest.fn(async (): Promise<LanPairingSession> => {
      sessionCount += 1;
      return {
        url: `http://192.168.1.50:49152/pair/tok${sessionCount}`,
        token: `tok${sessionCount}`,
        host: '192.168.1.50',
        port: 49152,
        expiresAtMs: sessionCount === 1 ? nowMs : nowMs + 125_000,
      };
    });
    const lanPairing: LanPairingPort = {
      isSupported: () => true,
      startSession,
      stopSession,
      onPayloadReceived: () => () => undefined,
    };

    const onClose = jest.fn();
    const view = await render(
      wrapProviders(
        <QrPairingOverlay
          visible
          catalog={createFakeCatalog()}
          lanPairing={lanPairing}
          onClose={onClose}
          now={() => nowMs}
        />,
      ),
    );

    // Session 1 starts already expired -> displays expired state & Regenerate button
    await waitFor(() => {
      expect(screen.getByTestId('qr-pairing-expired')).toBeTruthy();
      expect(screen.getByTestId('qr-pairing-regenerate-btn')).toBeTruthy();
    });
    expect(startSession).toHaveBeenCalledWith({ locale: 'en' });

    // Regenerate starts session 2 with active QR code, URL, countdown, and LAN-only note
    await fireEvent.press(screen.getByTestId('qr-pairing-regenerate-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('qr-pairing-code')).toBeTruthy();
      expect(screen.getByTestId('qr-pairing-url')).toHaveTextContent(
        'http://192.168.1.50:49152/pair/tok2',
      );
      expect(screen.getByTestId('qr-pairing-countdown')).toHaveTextContent('Expires in 2:05');
      expect(screen.getByTestId('qr-pairing-lan-note')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('qr-pairing-close-btn'));
    expect(stopSession).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('adds Xtream and M3U payloads received from phone, invokes onSourceAdded, and closes cleanly', async () => {
    let payloadListener: ((p: LanPairingSourcePayload) => void) | undefined;
    const stopSession = jest.fn(async () => undefined);
    const lanPairing: LanPairingPort = {
      isSupported: () => true,
      startSession: jest.fn(async () => ({
        url: 'http://192.168.1.50:49152/pair/abc123',
        token: 'abc123',
        host: '192.168.1.50',
        port: 49152,
        expiresAtMs: Date.now() + 300_000,
      })),
      stopSession,
      onPayloadReceived: (listener) => {
        payloadListener = listener;
        return () => {
          payloadListener = undefined;
        };
      },
    };

    const catalog = createFakeCatalog();
    const onSourceAdded = jest.fn();
    const onClose = jest.fn();

    const v1 = await render(
      wrapProviders(
        <QrPairingOverlay
          visible
          catalog={catalog}
          lanPairing={lanPairing}
          onSourceAdded={onSourceAdded}
          onClose={onClose}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('qr-pairing-code')).toBeTruthy());

    await act(async () => {
      payloadListener?.({
        kind: 'xtream',
        name: 'Living Room TV',
        server: 'http://provider.test:8080',
        username: 'demo',
        password: 'secret',
      });
    });

    await waitFor(() => {
      expect(catalog.addSource).toHaveBeenCalledWith({
        kind: 'xtream',
        name: 'Living Room TV',
        server: 'http://provider.test:8080',
        username: 'demo',
        password: 'secret',
      });
      expect(onSourceAdded).toHaveBeenCalledWith(ADDED_SOURCE);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    await v1.unmount();

    const catalog2 = createFakeCatalog();
    const onClose2 = jest.fn();
    const v2 = await render(
      wrapProviders(
        <QrPairingOverlay visible catalog={catalog2} lanPairing={lanPairing} onClose={onClose2} />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('qr-pairing-code')).toBeTruthy());

    await act(async () => {
      payloadListener?.({
        kind: 'm3u',
        name: 'Phone M3U',
        url: 'http://provider.test/list.m3u8',
        guideUrl: 'http://provider.test/epg.xml',
      });
    });

    await waitFor(() => {
      expect(catalog2.addSourceFromLink).toHaveBeenCalledWith({
        name: 'Phone M3U',
        url: 'http://provider.test/list.m3u8',
        guideUrl: 'http://provider.test/epg.xml',
      });
      expect(onClose2).toHaveBeenCalledTimes(1);
    });
    await v2.unmount();
  });

  it('shows Scan QR from phone button on SourcesScreen only when lanPairing.isSupported() is true', async () => {
    const unsupported: LanPairingPort = {
      isSupported: () => false,
      startSession: jest.fn(),
      stopSession: jest.fn(async () => undefined),
      onPayloadReceived: () => () => undefined,
    };
    const v1 = await render(
      wrapProviders(<SourcesScreen catalog={createFakeCatalog()} lanPairing={unsupported} />),
    );
    expect(screen.queryByTestId('sources-qr-button')).toBeNull();
    await v1.unmount();

    const supported: LanPairingPort = {
      isSupported: () => true,
      startSession: jest.fn(async () => ({
        url: 'http://192.168.1.50:49152/pair/xyz',
        token: 'xyz',
        host: '192.168.1.50',
        port: 49152,
        expiresAtMs: Date.now() + 300_000,
      })),
      stopSession: jest.fn(async () => undefined),
      onPayloadReceived: () => () => undefined,
    };
    await render(
      wrapProviders(<SourcesScreen catalog={createFakeCatalog()} lanPairing={supported} />),
    );
    expect(screen.getByTestId('sources-qr-button')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sources-qr-button'));
    await waitFor(() => {
      expect(screen.getByTestId('qr-pairing-overlay')).toBeTruthy();
      expect(screen.getByTestId('qr-pairing-code')).toBeTruthy();
    });
  });

  it('keeps overlay open with inline error and regenerate option when addSource fails (#50)', async () => {
    let payloadListener: ((p: LanPairingSourcePayload) => void) | undefined;
    const startSession = jest.fn(async () => ({
      url: 'http://192.168.1.50:49152/pair/err1',
      token: 'err1',
      host: '192.168.1.50',
      port: 49152,
      expiresAtMs: Date.now() + 300_000,
    }));
    const lanPairing: LanPairingPort = {
      isSupported: () => true,
      startSession,
      stopSession: jest.fn(async () => undefined),
      onPayloadReceived: (listener) => {
        payloadListener = listener;
        return () => {
          payloadListener = undefined;
        };
      },
    };
    const failingCatalog = {
      ...createFakeCatalog(),
      addSource: jest.fn(async () => err(elvError('auth', 'invalid-credentials'))),
    } as unknown as CatalogService;
    const onSourceAdded = jest.fn();
    const onClose = jest.fn();

    await render(
      wrapProviders(
        <QrPairingOverlay
          visible
          catalog={failingCatalog}
          lanPairing={lanPairing}
          onSourceAdded={onSourceAdded}
          onClose={onClose}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('qr-pairing-code')).toBeTruthy());

    await act(async () => {
      payloadListener?.({
        kind: 'xtream',
        name: 'Bad Creds',
        server: 'http://provider.test:8080',
        username: 'wrong',
        password: 'wrong',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('qr-pairing-error')).toBeTruthy();
      expect(screen.getByTestId('qr-pairing-error-hint')).toBeTruthy();
      expect(screen.getByTestId('qr-pairing-regenerate-btn')).toBeTruthy();
    });
    expect(onSourceAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Pressing New code restarts a fresh QR session
    await fireEvent.press(screen.getByTestId('qr-pairing-regenerate-btn'));
    await waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('qr-pairing-code')).toBeTruthy();
    });
  });

  it('hides Add via Phone QR button on phones and constrains long LAN URLs cleanly inside the modal (Wave P7)', async () => {
    const supported: LanPairingPort = {
      isSupported: () => true,
      startSession: jest.fn(async () => ({
        url: 'http://192.168.100.254:49152/pair/very-long-ephemeral-token-0123456789abcdef0123456789',
        token: 'very-long-ephemeral-token-0123456789abcdef0123456789',
        host: '192.168.100.254',
        port: 49152,
        expiresAtMs: Date.now() + 300_000,
      })),
      stopSession: jest.fn(async () => undefined),
      onPayloadReceived: () => () => undefined,
    };

    const phoneView = await render(
      <TvRemoteProvider>
        <ViewportProvider
          value={{
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 393,
            height: 852,
          }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider preset="obsidianCrimson">
              <SourcesScreen catalog={createFakeCatalog()} lanPairing={supported} />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </TvRemoteProvider>,
    );
    expect(screen.queryByTestId('sources-qr-button')).toBeNull();
    await phoneView.unmount();

    const overlayView = await render(
      wrapProviders(
        <QrPairingOverlay
          visible
          catalog={createFakeCatalog()}
          lanPairing={supported}
          onClose={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('qr-pairing-url')).toBeTruthy());
    const urlStyle = StyleSheet.flatten(screen.getByTestId('qr-pairing-url').props.style);
    expect(urlStyle.width).toBe('100%');
    expect(urlStyle.maxWidth).toBe('100%');
    expect(urlStyle.flexShrink).toBe(1);
    await overlayView.unmount();
  });
});
