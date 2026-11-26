import { elvError, err } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StrictMode } from 'react';
import { BackHandler, Platform } from 'react-native';
import { SourcesScreen } from '../SourcesScreen';
import { openTestCatalog } from './sources-test-harness';

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

function createFakeAndroidKeys() {
  let listener: ((e: AndroidKeyEvent) => void) | undefined;
  const source: AndroidKeySource = {
    addListener: (l) => {
      listener = l;
      return {
        remove: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    source,
    tap(keyCode: number) {
      listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
      listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
    },
  };
}

describe('Wave F5A Advanced Network Settings & Backup Servers (#172, #317)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('adds an Xtream source with IPv4 preference, host IP override, and backup servers from Advanced section', async () => {
    const env = await openTestCatalog();
    try {
      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await fireEvent.press(screen.getByTestId('sources-mode-xtream'));
      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:7878',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'demo');

      await fireEvent.press(screen.getByTestId('sources-toggle-advanced'));
      await fireEvent.press(screen.getByTestId('sources-dns-family-ipv4'));
      await fireEvent.changeText(screen.getByTestId('sources-input-host-override'), '203.0.113.10');
      await fireEvent.changeText(
        screen.getByTestId('sources-input-backup-servers'),
        'http://backup1.example.test:7878\nhttps://backup2.example.test:8443',
      );

      await fireEvent.press(screen.getByTestId('sources-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('source-row-src-1')).toBeTruthy();
      });

      const sources = await env.catalog.listSources();
      expect(sources[0]?.dnsFamily).toBe('ipv4');
      expect(sources[0]?.hostOverride).toBe('203.0.113.10');

      const secretRaw = await env.secrets.get('source.src-1.xtream');
      expect(secretRaw).toBeDefined();
      const parsedSecret = JSON.parse(secretRaw as string) as { backupServers?: string[] };
      expect(parsedSecret.backupServers).toEqual([
        'http://backup1.example.test:7878',
        'https://backup2.example.test:8443',
      ]);

      expect(screen.getByTestId('source-network-badge-src-1')).toBeTruthy();
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('rejects invalid host IP override in Add-Source Advanced section', async () => {
    const env = await openTestCatalog();
    try {
      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await fireEvent.press(screen.getByTestId('sources-mode-xtream'));
      await fireEvent.changeText(
        screen.getByTestId('sources-input-server'),
        'http://sim.example.test:7878',
      );
      await fireEvent.changeText(screen.getByTestId('sources-input-username'), 'demo');
      await fireEvent.changeText(screen.getByTestId('sources-input-password'), 'demo');

      await fireEvent.press(screen.getByTestId('sources-toggle-advanced'));
      await fireEvent.changeText(
        screen.getByTestId('sources-input-host-override'),
        'not-an-ip:8080',
      );
      await fireEvent.press(screen.getByTestId('sources-submit'));

      expect(screen.getByTestId('sources-form-error')).toHaveTextContent(
        'Enter a valid IPv4 or IPv6 address without ports or schemes.',
      );
      expect(await env.catalog.listSources()).toHaveLength(0);
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('expands inline Network editor on a saved source, validates IP live, and persists via updateSourceSettings', async () => {
    const env = await openTestCatalog();
    try {
      const added = await env.catalog.addSource({
        kind: 'xtream',
        name: 'Demo Provider',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
      });
      expect(added.ok).toBe(true);
      const updateSpy = jest.spyOn(env.catalog, 'updateSourceSettings');

      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('source-advanced-src-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('source-advanced-src-1'));
      await fireEvent.press(screen.getByTestId('source-network-src-1'));
      expect(screen.getByTestId('source-network-editor-src-1')).toBeTruthy();

      // Invalid IP shows live error and blocks save
      await fireEvent.changeText(
        screen.getByTestId('source-network-host-src-1'),
        'bad.hostname.test',
      );
      expect(screen.getByTestId('source-network-error-src-1')).toHaveTextContent(
        'Enter a valid IPv4 or IPv6 address without ports or schemes.',
      );
      await fireEvent.press(screen.getByTestId('source-network-save-src-1'));
      expect(updateSpy).not.toHaveBeenCalled();

      // Valid IPv6 + dnsFamily saves cleanly
      await fireEvent.press(screen.getByTestId('source-network-dns-ipv6-src-1'));
      await fireEvent.changeText(screen.getByTestId('source-network-host-src-1'), '[2001:db8::1]');
      expect(screen.queryByTestId('source-network-error-src-1')).toBeNull();

      await fireEvent.press(screen.getByTestId('source-network-save-src-1'));

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith('src-1', {
          transport: {
            dnsFamily: 'ipv6',
            hostOverride: '2001:db8::1',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('source-network-saved-src-1')).toHaveTextContent(
          'Network settings saved',
        );
      });

      const updated = await env.catalog.listSources();
      expect(updated[0]?.dnsFamily).toBe('ipv6');
      expect(updated[0]?.hostOverride).toBe('2001:db8::1');
      expect(screen.getByTestId('source-network-badge-src-1')).toBeTruthy();
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('supports 2D TV D-pad navigation through saved source Network button and inline DNS controls', async () => {
    const originalOs = Platform.OS;
    Platform.OS = 'android';
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    const remote = createFakeAndroidKeys();
    const env = await openTestCatalog();
    try {
      await env.catalog.addSource({
        kind: 'xtream',
        name: 'TV Provider',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
      });

      const view = await render(
        <RemoteKeysProvider android={remote.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('source-advanced-src-1')).toBeTruthy();
      });

      // Walk down until source-advanced-src-1 receives TV focus
      for (let i = 0; i < 20; i += 1) {
        if (screen.queryByTestId('source-advanced-src-1-focus-ring') !== null) break;
        await act(async () => {
          remote.tap(KEYCODE_DPAD_DOWN);
        });
      }
      expect(screen.getByTestId('source-advanced-src-1-focus-ring')).toBeTruthy();

      // Select opens Advanced modal; walk down to Network item and press Select
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      await waitFor(() => expect(screen.getByTestId('source-network-src-1')).toBeTruthy());
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          remote.tap(KEYCODE_DPAD_DOWN);
        });
      }
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      expect(screen.getByTestId('source-network-editor-src-1')).toBeTruthy();

      // In Network sub-view: focus starts on dns-system -> Right to IPv4 -> Select IPv4
      expect(screen.getByTestId('source-network-dns-system-src-1-focus-ring')).toBeTruthy();

      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('source-network-dns-ipv4-src-1-focus-ring')).toBeTruthy();

      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });

      // Down -> host input -> Down -> Save button -> Select
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('source-network-save-src-1-focus-ring')).toBeTruthy();

      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });

      await waitFor(async () => {
        const list = await env.catalog.listSources();
        expect(list[0]?.dnsFamily).toBe('ipv4');
      });

      await view.unmount();
    } finally {
      Platform.OS = originalOs;
      await env.cleanup();
    }
  });

  it('clearing an existing hostOverride sends hostOverride: "" so JSON serialization preserves the clear signal (#172)', async () => {
    const env = await openTestCatalog();
    try {
      await env.catalog.addSource({
        kind: 'xtream',
        name: 'Override Source',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
        transport: { dnsFamily: 'ipv4', hostOverride: '203.0.113.10' },
      });

      const rawUpdate = env.catalog.updateSourceSettings?.bind(env.catalog);
      const updateSpy = jest
        .spyOn(env.catalog, 'updateSourceSettings')
        .mockImplementation(async (sourceId, patch) => {
          // Simulate JSON IPC boundary (workbench-rpc / remote-catalog) dropping undefined keys
          const serializedPatch = JSON.parse(JSON.stringify(patch)) as typeof patch;
          return rawUpdate?.(sourceId, serializedPatch);
        });

      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('source-advanced-src-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('source-advanced-src-1'));
      await fireEvent.press(screen.getByTestId('source-network-src-1'));
      expect(screen.getByTestId('source-network-host-src-1').props.value).toBe('203.0.113.10');

      await fireEvent.changeText(screen.getByTestId('source-network-host-src-1'), '');
      await fireEvent.press(screen.getByTestId('source-network-save-src-1'));

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalledWith('src-1', {
          transport: {
            dnsFamily: 'ipv4',
            hostOverride: '',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('source-network-saved-src-1')).toBeTruthy();
      });

      const updated = await env.catalog.listSources();
      expect(updated[0]?.hostOverride).toBeUndefined();
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('surfaces error and omits saved notice when catalog.updateSourceSettings returns err(...) (#172)', async () => {
    const env = await openTestCatalog();
    try {
      await env.catalog.addSource({
        kind: 'xtream',
        name: 'Failing Save Source',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
      });

      jest
        .spyOn(env.catalog, 'updateSourceSettings')
        .mockResolvedValue(
          err(elvError('source-format', 'INVALID_HOST_OVERRIDE', 'Host override rejected')),
        );

      const view = await render(
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <SourcesScreen catalog={env.catalog} />
          </I18nProvider>
        </FormFactorProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('source-advanced-src-1')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('source-advanced-src-1'));
      await fireEvent.press(screen.getByTestId('source-network-src-1'));
      await fireEvent.changeText(screen.getByTestId('source-network-host-src-1'), '203.0.113.20');
      await fireEvent.press(screen.getByTestId('source-network-save-src-1'));

      await waitFor(() => {
        expect(screen.getByTestId('source-network-error-src-1')).toHaveTextContent(
          'Enter a valid IPv4 or IPv6 address without ports or schemes.',
        );
      });
      expect(screen.queryByTestId('source-network-saved-src-1')).toBeNull();
      expect(screen.getByTestId('source-network-editor-src-1')).toBeTruthy();
      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('toggles source network editor under React.StrictMode without nested setState warnings (#172)', async () => {
    const env = await openTestCatalog();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await env.catalog.addSource({
        kind: 'xtream',
        name: 'StrictMode Source',
        server: 'http://sim.example.test:7878',
        username: 'demo',
        password: 'demo',
        transport: { dnsFamily: 'ipv6', hostOverride: '2001:db8::9' },
      });

      const view = await render(
        <StrictMode>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <SourcesScreen catalog={env.catalog} />
            </I18nProvider>
          </FormFactorProvider>
        </StrictMode>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('source-advanced-src-1')).toBeTruthy();
      });

      errorSpy.mockClear();
      await fireEvent.press(screen.getByTestId('source-advanced-src-1'));
      await fireEvent.press(screen.getByTestId('source-network-src-1'));
      expect(screen.getByTestId('source-network-editor-src-1')).toBeTruthy();
      expect(screen.getByTestId('source-network-host-src-1').props.value).toBe('2001:db8::9');

      await fireEvent.press(screen.getByTestId('source-advanced-close'));
      expect(screen.queryByTestId('source-network-editor-src-1')).toBeNull();

      const reactStateWarnings = errorSpy.mock.calls.filter((args) =>
        args.some((arg) => typeof arg === 'string' && arg.includes('Cannot update a component')),
      );
      expect(reactStateWarnings).toHaveLength(0);
      await view.unmount();
    } finally {
      errorSpy.mockRestore();
      await env.cleanup();
    }
  });
});
