import { createMemoryPreferencesStore, type TvClockMode } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, useTheme, useViewport, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AmbientTvClock } from '../../shared/AmbientTvClock';
import { AdaptiveNavShell } from '../AdaptiveNavShell';
import { AppProviders, usePreferences } from '../AppProviders';

function ProvidersProbe(): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const prefs = usePreferences();
  return (
    <View>
      <Text testID="probe-ui-font">{theme.uiFontFamily}</Text>
      <Text testID="probe-overscan">{`${viewport.overscan.x},${viewport.overscan.y}`}</Text>
      <Pressable
        testID="btn-atkinson"
        onPress={() => void prefs.updatePreferences({ uiFontFamily: 'atkinson' })}
      />
      <Pressable
        testID="btn-overscan"
        onPress={() => void prefs.updatePreferences({ overscanX: 0.08, overscanY: 0.03 })}
      />
    </View>
  );
}

describe('Shell Wave C4B (#163, #133, #416)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('wires uiFontFamily and overscanX/overscanY live through AppProviders without remounting (#163, #133)', async () => {
    const store = createMemoryPreferencesStore();
    const view = await render(
      <AppProviders
        preferencesStore={store}
        viewport={{ formFactor: 'tv', orientation: 'landscape', width: 1000, height: 1000 }}
      >
        <ProvidersProbe />
      </AppProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('probe-ui-font')).toHaveTextContent('system');
      expect(screen.getByTestId('probe-overscan')).toHaveTextContent('50,50');
    });

    await fireEvent.press(screen.getByTestId('btn-atkinson'));
    await fireEvent.press(screen.getByTestId('btn-overscan'));

    await waitFor(() => {
      expect(screen.getByTestId('probe-ui-font')).toHaveTextContent('atkinson');
      expect(screen.getByTestId('probe-overscan')).toHaveTextContent('80,30');
    });

    await view.unmount();
  });

  it('aligns AmbientTvClock to minute boundaries with zero 1s setInterval churn and mounts cleanly in AdaptiveNavShell (#416)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');

    let fakeNow = new Date(2026, 10, 23, 21, 14, 20, 0).getTime();
    const now = () => fakeNow;
    const i18n = createAppI18n('en');

    const renderClock = (formFactor: 'tv' | 'phone' | 'desktop', mode: TvClockMode) => (
      <ViewportProvider value={{ formFactor, orientation: 'landscape', width: 1920, height: 1080 }}>
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <AmbientTvClock surface="menus" mode={mode} now={now} testID="clock-menus" />
            <AmbientTvClock surface="player" mode={mode} now={now} testID="clock-player" />
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    );

    const view = await render(renderClock('tv', 'always'));
    expect(screen.getByTestId('clock-menus')).toBeTruthy();
    expect(screen.getByTestId('clock-player')).toBeTruthy();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    const initialText = String(screen.getByTestId('clock-menus').props.children);

    await act(async () => {
      fakeNow += 39_000;
      jest.advanceTimersByTime(39_000);
    });
    expect(String(screen.getByTestId('clock-menus').props.children)).toBe(initialText);

    await act(async () => {
      fakeNow += 2_000;
      jest.advanceTimersByTime(2_000);
    });
    expect(String(screen.getByTestId('clock-menus').props.children)).not.toBe(initialText);

    await view.rerender(renderClock('tv', 'menus'));
    expect(screen.getByTestId('clock-menus')).toBeTruthy();
    expect(screen.queryByTestId('clock-player')).toBeNull();

    await view.rerender(renderClock('tv', 'player'));
    expect(screen.queryByTestId('clock-menus')).toBeNull();
    expect(screen.getByTestId('clock-player')).toBeTruthy();

    await view.rerender(renderClock('tv', 'never'));
    expect(screen.queryByTestId('clock-menus')).toBeNull();
    expect(screen.queryByTestId('clock-player')).toBeNull();

    await view.rerender(renderClock('desktop', 'always'));
    expect(screen.queryByTestId('clock-menus')).toBeNull();
    expect(screen.queryByTestId('clock-player')).toBeNull();

    await view.rerender(renderClock('phone', 'always'));
    expect(screen.queryByTestId('clock-menus')).toBeNull();
    expect(screen.queryByTestId('clock-player')).toBeNull();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    await view.unmount();

    const navView = await render(
      <ViewportProvider
        value={{ formFactor: 'tv', orientation: 'landscape', width: 1920, height: 1080 }}
      >
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <AdaptiveNavShell
              brandTitle="ELV IPTV"
              destinations={[{ id: 'home', label: 'Home', icon: 'home' }]}
              activeId="home"
              tvClockMode="menus"
              onSelectDestination={jest.fn()}
            >
              <Text>Body</Text>
            </AdaptiveNavShell>
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>,
    );
    expect(screen.getByTestId('nav-ambient-clock')).toBeTruthy();
    await navView.unmount();
  });
});
