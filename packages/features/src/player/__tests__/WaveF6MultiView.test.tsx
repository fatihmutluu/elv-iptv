import type { ItemRow, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createConnectionTracker, type ThermalState } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
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
    await fireEvent.press(screen.getByTestId('multiview-add-button'));
    await waitFor(() => expect(screen.getByTestId('multiview-picker-item-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('multiview-picker-item-0')); // Alpha Sports (src-1)
    await waitFor(() =>
      expect(screen.getByTestId('multiview-banner-connection-limit')).toBeTruthy(),
    );
    expect(openCalls).toHaveLength(1);

    // Add channel from Provider B (src-2) -> succeeds, opens secondary & muted immediately!
    await fireEvent.press(screen.getByTestId('multiview-add-button'));
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

    // Exit Multi-View -> tears down remaining tile and passes active tile as resume target
    await fireEvent.press(screen.getByTestId('multiview-exit-button'));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(onExit.mock.calls[0]?.[0]).toMatchObject({
      itemKey: 'live:src-2:1',
      title: 'Beta Cinema',
    });
    expect(openCalls[1]?.releaseSpy).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});
