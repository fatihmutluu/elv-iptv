import type { CatalogService, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { BackHandler, Platform } from 'react-native';
import type { SourceImportHost } from '../../ports/source-import-host';
import { SourcesScreen } from '../SourcesScreen';

const EN_I18N = createAppI18n('en');

const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

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

function wrap(node: ReactElement) {
  return (
    <ThemeProvider>
      <I18nProvider i18n={EN_I18N}>
        <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
          {node}
        </ViewportProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function makeStubCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    addSource: jest.fn(async () =>
      ok({ id: 's1', kind: 'xtream' as const, name: 'X', createdAt: 1, needsImport: true }),
    ),
    addSourceFromLink: jest.fn(async () =>
      ok({ id: 's1', kind: 'm3u' as const, name: 'M', createdAt: 1, needsImport: true }),
    ),
    addLocalM3uSource: jest.fn(async (input) =>
      ok({
        id: 's-local',
        kind: 'm3u' as const,
        name: input.name,
        createdAt: 1,
        needsImport: true,
        isLocalPlaylist: true,
      }),
    ),
    discoverSourceCategories: jest.fn(async () =>
      ok([
        { id: 'c1', name: 'News', kind: 'live' as const, itemCount: 12 },
        { id: 'c2', name: 'Sports', kind: 'live' as const, itemCount: 8 },
      ]),
    ),
    updateSourceSettings: jest.fn(async () => undefined),
    removeSource: jest.fn(async () => ok(undefined)),
    importSource: jest.fn(async () =>
      ok({
        runId: 1,
        counts: { live: 12, movies: 0, series: 0 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ),
    listSources: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(async () => ok({ url: 'http://127.0.0.1/1.ts', headers: {} })),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('Wave C3 UI flows (#51, #39, #182)', () => {
  it('supports M3U clipboard paste (empty & filled) and local M3U file import (#51)', async () => {
    const sources: SourceRow[] = [];
    const catalog = makeStubCatalog({
      listSources: jest.fn(async () => [...sources]),
      addLocalM3uSource: jest.fn(async (input) => {
        const row: SourceRow = {
          id: 's-local',
          kind: 'm3u',
          name: input.name,
          createdAt: 1,
          needsImport: false,
          isLocalPlaylist: true,
        };
        sources.push(row);
        return ok(row);
      }),
    });

    let clipText: string | null = '   ';
    const host: SourceImportHost = {
      readClipboardText: jest.fn(async () => clipText),
      pickPlaylistFile: jest.fn(async () => ({
        name: 'Home.m3u8',
        bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Ch\nhttp://127.0.0.1/1.ts\n'),
      })),
    };

    const screen = await render(wrap(<SourcesScreen catalog={catalog} sourceImportHost={host} />));
    await fireEvent.press(screen.getByTestId('sources-mode-m3u'));

    await fireEvent.press(screen.getByTestId('sources-paste-clipboard'));
    await waitFor(() => expect(screen.getByTestId('sources-clipboard-empty')).toBeTruthy());

    clipText = 'http://demo.test/get.php?username=u&password=p';
    await fireEvent.press(screen.getByTestId('sources-paste-clipboard'));
    await waitFor(() => expect(screen.getByTestId('sources-xtream-detected-notice')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('sources-choose-local-file'));
    await waitFor(() => expect(screen.getByTestId('sources-local-file-selected')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('sources-submit'));
    await waitFor(() => expect(catalog.addLocalM3uSource).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('source-local-badge-s-local')).toBeTruthy());
  });

  it('opens pre-import category picker and handles pending categories banner (#39)', async () => {
    const saved: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Provider',
      createdAt: 1,
      needsImport: false,
      categorySelection: {
        live: ['c1'],
        knownLive: ['c1', 'c2'],
        pendingLive: ['c3'],
      },
    };
    const catalog = makeStubCatalog({
      listSources: jest.fn(async () => [saved]),
    });

    const screen = await render(wrap(<SourcesScreen catalog={catalog} />));
    await waitFor(() => expect(screen.getByTestId('source-pending-categories-s1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('source-include-pending-s1'));
    await waitFor(() =>
      expect(catalog.updateSourceSettings).toHaveBeenCalledWith('s1', {
        categorySelection: expect.objectContaining({ live: ['c1', 'c3'] }),
      }),
    );

    await fireEvent.press(screen.getByTestId('source-categories-s1'));
    await waitFor(() => expect(screen.getByTestId('category-picker-s1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('category-picker-item-live-c2'));
    await fireEvent.press(screen.getByTestId('category-picker-confirm'));
    await waitFor(() => expect(catalog.importSource).toHaveBeenCalled());
  });

  it('reaches Wave C3 form controls, pending actions, and full-width CategoryPickerPanel via TV D-pad with Back-to-close (#39, #51, #182)', async () => {
    const originalOs = Platform.OS;
    Platform.OS = 'android';
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => ({ remove: () => {} }));
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    const remote = createFakeAndroidKeys();
    const onBack = jest.fn();
    const saved: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Provider',
      createdAt: 1,
      needsImport: false,
      categorySelection: {
        live: ['c1'],
        knownLive: ['c1', 'c2'],
        pendingLive: ['c3'],
      },
    };
    const catalog = makeStubCatalog({
      listSources: jest.fn(async () => [saved]),
    });
    const host: SourceImportHost = {
      readClipboardText: jest.fn(async () => 'http://demo.test/list.m3u8'),
      pickPlaylistFile: jest.fn(async () => ({
        name: 'TV.m3u8',
        bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Ch\nhttp://127.0.0.1/1.ts\n'),
      })),
    };

    try {
      const screen = await render(
        <RemoteKeysProvider android={remote.source}>
          <ThemeProvider>
            <I18nProvider i18n={EN_I18N}>
              <ViewportProvider value={{ width: 1920, height: 1080, formFactor: 'tv' }}>
                <SourcesScreen catalog={catalog} sourceImportHost={host} onBack={onBack} />
              </ViewportProvider>
            </I18nProvider>
          </ThemeProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => expect(screen.getByTestId('source-pending-categories-s1')).toBeTruthy());

      // Switch to M3U mode via D-pad Right + OK
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });

      // Navigate down through M3U Wave C3 controls:
      // 1: mode-m3u -> 2: mode-stalker -> 3: input-name -> 4: input-playlist-url -> 5: paste-clipboard
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('sources-paste-clipboard-focus-ring')).toBeTruthy();

      // Right -> choose-local-file; OK stages local file and exposes clear-local-file
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('sources-choose-local-file-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      await waitFor(() => expect(screen.getByTestId('sources-clear-local-file')).toBeTruthy());

      // Down -> clear-local-file, Down -> toggle-advanced, OK expands advanced section
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('sources-clear-local-file-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      await waitFor(() => expect(screen.getByTestId('sources-input-xmltv-timezone')).toBeTruthy());

      // Down through guide-url, user-agent, referer -> input-xmltv-timezone -> toggle-legacy-tls
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(
        screen.getByTestId('sources-focus-input-xmltv-timezone').props.accessibilityState?.selected,
      ).toBe(true);
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('sources-toggle-legacy-tls-focus-ring')).toBeTruthy();

      // Down past DNS preference (system/ipv4/ipv6) + host override -> submit -> Right -> submit-choose-categories
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('sources-submit-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('sources-submit-choose-categories-focus-ring')).toBeTruthy();

      // Down -> source-include-pending-s1 -> Right -> source-dismiss-pending-s1
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('source-include-pending-s1-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('source-dismiss-pending-s1-focus-ring')).toBeTruthy();

      // Down -> source-sync-s1 -> Right -> source-categories-s1 -> OK opens full-width picker
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('source-categories-s1-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });

      await waitFor(() => expect(screen.getByTestId('category-picker-s1')).toBeTruthy());
      // Full-width picker replaces columns row (form & saved panel are not squeezed alongside it)
      expect(screen.queryByTestId('sources-submit')).toBeNull();
      // TV focus routes immediately into picker's Select all button
      await waitFor(() =>
        expect(screen.getByTestId('category-picker-select-all-focus-ring')).toBeTruthy(),
      );

      // Navigate to Clear all -> live-c1 -> live-c2 -> toggle live-c2 via OK
      await act(async () => {
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('category-picker-clear-all-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('category-picker-item-live-c2-focus-ring')).toBeTruthy();
      expect(
        screen.getByTestId('category-picker-item-live-c2').props.accessibilityState?.checked,
      ).toBe(false);
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      expect(
        screen.getByTestId('category-picker-item-live-c2').props.accessibilityState?.checked,
      ).toBe(true);

      // Back closes CategoryPickerPanel WITHOUT calling SourcesScreen onBack
      await act(async () => {
        remote.tap(KEYCODE_BACK);
      });
      expect(screen.queryByTestId('category-picker-s1')).toBeNull();
      expect(onBack).not.toHaveBeenCalled();

      // Re-open picker and confirm with OK on Import selected
      await waitFor(() =>
        expect(screen.getByTestId('source-categories-s1-focus-ring')).toBeTruthy(),
      );
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      await waitFor(() =>
        expect(screen.getByTestId('category-picker-select-all-focus-ring')).toBeTruthy(),
      );
      // 0: select-all -> 1: clear-all -> 2: c1 -> 3: c2 -> 4: cancel -> Right -> 5: confirm
      await act(async () => {
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_DOWN);
        remote.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('category-picker-confirm-focus-ring')).toBeTruthy();
      await act(async () => {
        remote.tap(KEYCODE_DPAD_CENTER);
      });
      await waitFor(() =>
        expect(catalog.importSource).toHaveBeenCalledWith('s1', expect.anything()),
      );

      await screen.unmount();
    } finally {
      Platform.OS = originalOs;
      jest.restoreAllMocks();
    }
  });

  it('clears an open category picker when staging an incoming OS-opened local playlist (#259)', async () => {
    const saved: SourceRow = {
      id: 's1',
      kind: 'xtream',
      name: 'Provider',
      createdAt: 1,
      needsImport: false,
    };
    const catalog = makeStubCatalog({
      listSources: jest.fn(async () => [saved]),
    });
    const onConsume = jest.fn();

    const screen = await render(
      wrap(<SourcesScreen catalog={catalog} onConsumeIncomingLocalPlaylist={onConsume} />),
    );
    await waitFor(() => expect(screen.getByTestId('source-categories-s1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('source-categories-s1'));
    await waitFor(() => expect(screen.getByTestId('category-picker-s1')).toBeTruthy());

    await screen.rerender(
      wrap(
        <SourcesScreen
          catalog={catalog}
          incomingLocalPlaylist={{
            name: 'fresh-list.m3u8',
            bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Ch\nhttp://a/1.ts\n'),
          }}
          onConsumeIncomingLocalPlaylist={onConsume}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.queryByTestId('category-picker-s1')).toBeNull();
      expect(screen.getByTestId('sources-local-file-selected')).toHaveTextContent(
        'File: fresh-list.m3u8',
      );
      expect(onConsume).toHaveBeenCalledTimes(1);
    });
    await screen.unmount();
  });
});
