import type { CatalogService, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SourcesScreen } from '../SourcesScreen';

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

function makeMockCatalog(initialSources: SourceRow[] = []) {
  const sources = [...initialSources];
  const addSource = jest.fn(async (input: Parameters<CatalogService['addSource']>[0]) => {
    const row: SourceRow = {
      id: `src-${sources.length + 1}`,
      kind: input.kind,
      name: input.name,
      needsImport: true,
      createdAt: 1_700_000_000_000,
    };
    sources.push(row);
    return ok(row);
  });
  const importSource = jest.fn(async () =>
    ok({
      sourceId: 'src-1',
      counts: { live: 2, movies: 1, series: 1 },
      durationMs: 12,
    }),
  );
  const catalog = {
    addSource,
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(async () => ok(undefined)),
    importSource,
    listSources: jest.fn(async () => [...sources]),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    series: jest.fn(async () => undefined),
    seasons: jest.fn(async () => []),
    episodes: jest.fn(async () => []),
    itemDetail: jest.fn(async () => undefined),
    resolveStream: jest.fn(),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;
  return { catalog, addSource, importSource };
}

describe('Wave F5B Stalker / MAC sources UI (#29)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('switches to Stalker mode, submits valid portal + MAC + serial, and calls catalog.addSource', async () => {
    const { catalog, addSource } = makeMockCatalog();
    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <SourcesScreen catalog={catalog} />
          </ThemeProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );

    await fireEvent.press(screen.getByTestId('sources-mode-stalker'));
    await fireEvent.changeText(screen.getByTestId('sources-input-name'), 'Demo Portal');
    await fireEvent.changeText(
      screen.getByTestId('sources-input-portal-url'),
      'http://portal.example.test:8080/c/',
    );
    await fireEvent.changeText(
      screen.getByTestId('sources-input-mac-address'),
      '00-1a-79-00-00-01',
    );
    await fireEvent.changeText(screen.getByTestId('sources-input-serial-number'), 'SN-DEMO-1');
    await fireEvent.press(screen.getByTestId('sources-submit'));

    await waitFor(() => {
      expect(addSource).toHaveBeenCalledWith({
        kind: 'stalker',
        name: 'Demo Portal',
        portalUrl: 'http://portal.example.test:8080/c/',
        mac: '00:1A:79:00:00:01',
        serialNumber: 'SN-DEMO-1',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('source-row-src-1')).toBeTruthy();
      expect(screen.getByText('Stalker')).toBeTruthy();
    });

    await view.unmount();
  });

  it('displays localized invalid MAC error and hint without calling catalog.addSource', async () => {
    const { catalog, addSource } = makeMockCatalog();
    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <SourcesScreen catalog={catalog} />
          </ThemeProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );

    await fireEvent.press(screen.getByTestId('sources-mode-stalker'));
    await fireEvent.changeText(
      screen.getByTestId('sources-input-portal-url'),
      'http://portal.example.test/c/',
    );
    await fireEvent.changeText(screen.getByTestId('sources-input-mac-address'), 'NOT-A-MAC');
    await fireEvent.press(screen.getByTestId('sources-submit'));

    expect(screen.getByTestId('sources-form-error')).toHaveTextContent(
      'Enter a valid MAC address.',
    );
    expect(screen.getByTestId('sources-form-hint')).toHaveTextContent(
      'Use 6 hex pairs separated by colons, e.g. 00:1A:79:00:00:01.',
    );
    expect(addSource).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('renders Stalker kind badge in SavedSourcesPanel for existing stalker sources', async () => {
    const existing: SourceRow = {
      id: 'stalker-1',
      kind: 'stalker',
      name: 'Bedroom Portal',
      needsImport: false,
      createdAt: 1_700_000_000_000,
    };
    const { catalog } = makeMockCatalog([existing]);
    const view = await render(
      <FormFactorProvider value="desktop">
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider>
            <SourcesScreen catalog={catalog} />
          </ThemeProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('source-row-stalker-1')).toBeTruthy();
      expect(screen.getByText('Stalker')).toBeTruthy();
    });

    await view.unmount();
  });

  it('supports 10-foot TV D-pad navigation across mode-stalker and Stalker input fields', async () => {
    const origOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const keys = createFakeAndroidKeys();
    const { catalog } = makeMockCatalog();
    try {
      const view = await render(
        <RemoteKeysProvider android={keys.source}>
          <ViewportProvider value={{ width: 1920, height: 1080, formFactor: 'tv' }}>
            <FormFactorProvider value="tv">
              <I18nProvider i18n={createAppI18n('en')}>
                <ThemeProvider>
                  <SourcesScreen catalog={catalog} />
                </ThemeProvider>
              </I18nProvider>
            </FormFactorProvider>
          </ViewportProvider>
        </RemoteKeysProvider>,
      );

      // Initial focus is mode-xtream; Right -> mode-m3u, Right -> mode-stalker, Select switches mode
      await act(async () => {
        keys.tap(KEYCODE_DPAD_RIGHT);
        keys.tap(KEYCODE_DPAD_RIGHT);
        keys.tap(KEYCODE_DPAD_CENTER);
      });

      expect(screen.getByTestId('sources-input-portal-url')).toBeTruthy();
      expect(screen.getByTestId('sources-input-mac-address')).toBeTruthy();
      expect(screen.getByTestId('sources-input-serial-number')).toBeTruthy();

      // Down x2 reaches input-portal-url (skipping input-name), Down -> input-mac-address, Down -> input-serial-number
      await act(async () => {
        keys.tap(KEYCODE_DPAD_DOWN);
        keys.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('sources-input-portal-url').props.editable).toBe(false);

      await act(async () => {
        keys.tap(KEYCODE_DPAD_CENTER);
      });
      expect(screen.getByTestId('sources-input-portal-url').props.editable).toBe(true);

      await view.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
    }
  });
});
