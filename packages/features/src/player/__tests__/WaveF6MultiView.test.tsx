import type { ItemRow, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker, type ThermalState } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type {
  OpenVideoEngine,
  ThermalDevicePort,
  VideoHost,
  VideoHostOpenOptions,
} from '../../ports/video-host';
import { MultiViewStage } from '../MultiViewStage';

const SOURCES: readonly SourceRow[] = [
  {
    id: 'src-1',
    kind: 'xtream',
    name: 'Provider A',
    needsImport: false,
    accountMeta: { maxConnections: 1 },
  } as unknown as SourceRow,
  {
    id: 'src-2',
    kind: 'm3u',
    name: 'Provider B',
    needsImport: false,
    accountMeta: { maxConnections: 2 },
  } as unknown as SourceRow,
];

const LIVE_ROWS: readonly ItemRow[] = [
  {
    key: 'live:src-1:1',
    sourceId: 'src-1',
    kind: 'live',
    name: 'Alpha News',
    logo: null,
  } as unknown as ItemRow,
  {
    key: 'live:src-1:2',
    sourceId: 'src-1',
    kind: 'live',
    name: 'Alpha Sports',
    logo: null,
  } as unknown as ItemRow,
  {
    key: 'live:src-2:1',
    sourceId: 'src-2',
    kind: 'live',
    name: 'Beta Cinema',
    logo: null,
  } as unknown as ItemRow,
];

function makeCatalog() {
  return {
    resolveStream: async (key: string) =>
      ok({
        url: `http://sim.example.test/${key}.m3u8`,
        kind: 'live' as const,
        headers: {},
        sourceId: key.startsWith('live:src-2') ? 'src-2' : 'src-1',
      }),
    categories: async () => [],
    items: async () => [],
    allSourcesItems: async () => [...LIVE_ROWS],
  };
}

describe('Wave F6 Multi-View Grid, #221 Connection Clamp & #232 Thermal Watchdog', () => {
  it('enforces #221 max_connections, mutes secondary tiles, swaps audio + setPrimary, and sheds muted tiles on #232 critical thermal', async () => {
    const tracker = createConnectionTracker();
    const openCalls: Array<{
      options: VideoHostOpenOptions | undefined;
      setMuted: jest.Mock;
      setPrimary: jest.Mock;
      releaseSpy: jest.Mock;
    }> = [];

    const videoHost: VideoHost = {
      supportsMultiView: true,
      open: (options): OpenVideoEngine => {
        const fake = createFakePlayerEngine({
          now: () => performance.now(),
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        });
        const origRelease = fake.release.bind(fake);
        const releaseSpy = jest.fn(() => origRelease());
        const engine = { ...fake, release: releaseSpy };
        const setMuted = jest.fn();
        const setPrimary = jest.fn();
        openCalls.push({ options, setMuted, setPrimary, releaseSpy });
        return {
          engine,
          renderSurface: ({ testID }) => <View testID={testID ?? 'mv-surface'} />,
          setMuted,
          setPrimary,
        };
      },
    };

    let thermalListener: ((s: ThermalState) => void) | undefined;
    let currentThermal: ThermalState = 'nominal';
    const thermalDevice: ThermalDevicePort = {
      getThermalState: () => currentThermal,
      subscribeThermalState: (l) => {
        thermalListener = l;
        return () => {
          thermalListener = undefined;
        };
      },
      getMultiViewCapabilities: () => ({
        platform: 'desktop',
        totalMemoryBytes: 8 * 1024 * 1024 * 1024,
        supported: true,
      }),
    };

    const onExit = jest.fn();
    const view = await render(
      <FormFactorProvider value="desktop">
        <ViewportProvider
          value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
        >
          <I18nProvider i18n={createAppI18n('en')}>
            <ThemeProvider preset="obsidianCrimson">
              <MultiViewStage
                catalog={makeCatalog()}
                videoHost={videoHost}
                tracker={tracker}
                sources={SOURCES}
                thermalDevice={thermalDevice}
                initialSeed={{
                  itemKey: 'live:src-1:1',
                  sourceId: 'src-1',
                  title: 'Alpha News',
                  kind: 'live',
                }}
                onExit={onExit}
              />
            </ThemeProvider>
          </I18nProvider>
        </ViewportProvider>
      </FormFactorProvider>,
    );

    // Tile 1 opens as primary unmuted with handleAudioFocus: true
    await waitFor(() => expect(screen.getByTestId('multiview-tile-0')).toBeTruthy());
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.options).toMatchObject({
      replaceExisting: false,
      primary: true,
      handleAudioFocus: true,
      multiViewTileCount: 1,
    });
    expect(openCalls[0]?.setMuted).toHaveBeenCalledWith(false);
    expect(openCalls[0]?.setPrimary).toHaveBeenCalledTimes(1);

    // Try adding second channel from SAME maxConnections=1 source -> blocked with #221 banner
    // (Redundant header Add button is hidden while empty '+' slot card is shown)
    expect(screen.queryByTestId('multiview-add-button')).toBeNull();
    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0')); // Alpha Sports (src-1)
    await waitFor(() =>
      expect(screen.getByTestId('multiview-banner-connection-limit')).toBeTruthy(),
    );
    expect(openCalls).toHaveLength(1);

    // Add channel from Provider B (src-2) -> succeeds, opens secondary & muted immediately!
    await fireEvent.press(screen.getByTestId('multiview-empty-slot'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-1')); // Beta Cinema (src-2)

    await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());
    expect(openCalls).toHaveLength(2);
    expect(openCalls[1]?.options).toMatchObject({
      replaceExisting: false,
      primary: false,
      handleAudioFocus: false,
      multiViewTileCount: 2,
    });
    expect(openCalls[1]?.setMuted).toHaveBeenCalledWith(true);

    // Click Tile 2 -> swaps audio to Tile 2 (mutes Tile 1, unmutes & promotes Tile 2)
    await fireEvent.press(screen.getByTestId('multiview-tile-1'));
    expect(openCalls[0]?.setMuted).toHaveBeenLastCalledWith(true);
    expect(openCalls[1]?.setMuted).toHaveBeenLastCalledWith(false);
    expect(openCalls[1]?.setPrimary).toHaveBeenCalledTimes(1);

    // Thermal 'serious' -> inline warning banner + add button disabled
    await act(async () => {
      currentThermal = 'serious';
      thermalListener?.('serious');
    });
    await waitFor(() =>
      expect(screen.getByTestId('multiview-banner-thermal-serious')).toBeTruthy(),
    );
    expect(screen.getByTestId('multiview-add-button').props.accessibilityState?.disabled).toBe(
      true,
    );

    // Thermal 'critical' -> auto-sheds muted tile (Tile 1) and releases its engine!
    await act(async () => {
      currentThermal = 'critical';
      thermalListener?.('critical');
    });
    await waitFor(() => {
      expect(screen.getByTestId('multiview-banner-thermal-critical')).toBeTruthy();
      expect(screen.queryByTestId('multiview-tile-1')).toBeNull();
    });
    expect(openCalls[0]?.releaseSpy).toHaveBeenCalledTimes(1);

    // Exit Multi-View -> hands off remaining active tile without releasing its live engine (Wave P3)
    await fireEvent.press(screen.getByTestId('multiview-exit-button'));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({
      itemKey: 'live:src-2:1',
      title: 'Beta Cinema',
    });
    expect(onExit.mock.calls[0]?.[1]).toBeTruthy();
    expect(openCalls[1]?.releaseSpy).toHaveBeenCalledTimes(0);

    await view.unmount();
  });

  it('replaces and removes Multi-View tiles strictly via TV D-pad remote keys (MEDIUM #5)', async () => {
    const origOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const KEYCODE_DPAD_RIGHT = 22;
    const KEYCODE_DPAD_CENTER = 23;
    const KEYCODE_MENU = 82;
    const KEYCODE_BACK = 4;

    const multiRows: readonly ItemRow[] = [
      ...LIVE_ROWS,
      {
        key: 'live:src-2:2',
        sourceId: 'src-2',
        kind: 'live',
        name: 'Beta Documentary',
        logo: null,
      } as unknown as ItemRow,
    ];

    let listener: ((ev: AndroidKeyEvent) => void) | null = null;
    const androidSource: AndroidKeySource = {
      addListener(fn) {
        listener = fn;
        return {
          remove() {
            if (listener === fn) listener = null;
          },
        };
      },
    };
    const sendKey = async (keyCode: number) => {
      await act(async () => {
        listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        listener?.({ keyCode, action: 'up', canceled: false, ageMs: 0 });
      });
    };

    const tracker = createConnectionTracker();
    const videoHost: VideoHost = {
      supportsMultiView: true,
      open: (): OpenVideoEngine => ({
        engine: createFakePlayerEngine({
          now: () => performance.now(),
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        }),
        renderSurface: ({ testID }) => <View testID={testID ?? 'mv-surface'} />,
        setMuted: jest.fn(),
        setPrimary: jest.fn(),
      }),
    };
    const thermalDevice: ThermalDevicePort = {
      getThermalState: () => 'nominal',
      subscribeThermalState: () => () => undefined,
      getMultiViewCapabilities: () => ({
        platform: 'android',
        totalMemoryBytes: 4 * 1024 * 1024 * 1024,
        supported: true,
      }),
    };
    const catalog = {
      ...makeCatalog(),
      allSourcesItems: async () => [...multiRows],
    };
    const onExit = jest.fn();

    let view: Awaited<ReturnType<typeof render>> | undefined;
    try {
      view = await render(
        <RemoteKeysProvider android={androidSource}>
          <TvRemoteProvider>
            <FormFactorProvider value="tv">
              <ViewportProvider
                value={{
                  formFactor: 'tv',
                  inputModality: 'tv',
                  orientation: 'landscape',
                  width: 1920,
                  height: 1080,
                }}
              >
                <I18nProvider i18n={createAppI18n('en')}>
                  <ThemeProvider preset="obsidianCrimson">
                    <MultiViewStage
                      catalog={catalog}
                      videoHost={videoHost}
                      tracker={tracker}
                      sources={SOURCES}
                      thermalDevice={thermalDevice}
                      initialSeed={{
                        itemKey: 'live:src-1:1',
                        sourceId: 'src-1',
                        title: 'Alpha News',
                        kind: 'live',
                      }}
                      onExit={onExit}
                    />
                  </ThemeProvider>
                </I18nProvider>
              </ViewportProvider>
            </FormFactorProvider>
          </TvRemoteProvider>
        </RemoteKeysProvider>,
      );

      await waitFor(() => expect(screen.getByTestId('multiview-tile-0')).toBeTruthy());

      // Move right to empty slot -> press select to open channel picker -> select Beta Cinema (src-2)
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => expect(screen.getByTestId('multiview-channel-picker')).toBeTruthy());
      // Index 0 is Alpha Sports (src-1, max=1 blocked), move down to Beta Cinema (src-2)
      await act(async () => {
        listener?.({ keyCode: 20, action: 'down', canceled: false, ageMs: 0 });
        listener?.({ keyCode: 20, action: 'up', canceled: false, ageMs: 0 });
      });
      await sendKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => expect(screen.getByTestId('multiview-tile-1')).toBeTruthy());
      expect(screen.getByTestId('multiview-tile-title-1').props.children).toBe('Beta Cinema');

      // Tile 1 (index 1) is currently focused (non-active audio: actions = [audio, replace, remove]).
      // Press MENU -> enters inline tile-action focus bar on Tile 1; BACK closes bar without exiting stage!
      await sendKey(KEYCODE_MENU);
      await waitFor(() => {
        const audioBtn = screen.getByTestId('multiview-tile-audio-btn-1');
        expect(audioBtn.props.accessibilityState?.selected).toBe(true);
      });
      await sendKey(KEYCODE_BACK);
      expect(onExit).not.toHaveBeenCalled();

      // Press MENU again -> RIGHT to Replace -> verify focus ring -> SELECT opens picker -> replace with Beta Documentary!
      await sendKey(KEYCODE_MENU);
      await sendKey(KEYCODE_DPAD_RIGHT);
      const replaceBtn = screen.getByTestId('multiview-tile-replace-btn-1');
      expect(replaceBtn.props.accessibilityState?.selected).toBe(true);
      const replaceStyle = StyleSheet.flatten(replaceBtn.props.style);
      expect(replaceStyle.borderWidth).toBeGreaterThanOrEqual(2);

      await sendKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => expect(screen.getByTestId('multiview-channel-picker')).toBeTruthy());
      // Candidates exclude Alpha News & Beta Cinema -> [Alpha Sports, Beta Documentary]; move down to Beta Documentary
      await act(async () => {
        listener?.({ keyCode: 20, action: 'down', canceled: false, ageMs: 0 });
        listener?.({ keyCode: 20, action: 'up', canceled: false, ageMs: 0 });
      });
      await sendKey(KEYCODE_DPAD_CENTER);
      await waitFor(() =>
        expect(screen.getByTestId('multiview-tile-title-1').props.children).toBe(
          'Beta Documentary',
        ),
      );

      // Press MENU -> RIGHT -> RIGHT to Remove -> SELECT removes Tile 1 and auto-solos remaining tile back to single player!
      await sendKey(KEYCODE_MENU);
      await sendKey(KEYCODE_DPAD_RIGHT);
      await sendKey(KEYCODE_DPAD_RIGHT);
      expect(
        screen.getByTestId('multiview-tile-remove-btn-1').props.accessibilityState?.selected,
      ).toBe(true);
      await sendKey(KEYCODE_DPAD_CENTER);
      await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
      expect(onExit.mock.calls[0]?.[0]).toMatchObject({
        itemKey: 'live:src-1:1',
        title: 'Alpha News',
      });
      expect(onExit.mock.calls[0]?.[1]).toBeTruthy();
    } finally {
      await view?.unmount();
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
    }
  });
});
