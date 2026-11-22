import { createAppI18n } from '@elv/i18n';
import {
  createTvRemoteDispatcher,
  I18nProvider,
  ThemeProvider,
  TvRemoteProvider,
  useTvKeySource,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { type ReactElement, StrictMode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { OLED_PURE_BLACK, OledScreensaverOverlay } from '../OledScreensaverOverlay';
import { OLED_DRIFT_INTERVAL_MS, OLED_WAKE_SUPPRESS_MS } from '../screensaver-controller';
import { useOledScreensaver } from '../useOledScreensaver';

function UnderlyingTvConsumer({
  onLeak,
  onApi,
}: {
  readonly onLeak: (entry: string) => void;
  readonly onApi: (api: ReturnType<typeof useOledScreensaver>) => void;
}): ReactElement {
  useTvKeySource((k) => {
    onLeak(`${k.key}:${k.action}`);
    return true;
  });
  onApi(useOledScreensaver({ timeoutMin: 5, isBlocked: false }));
  return <View />;
}

interface HarnessProps {
  timeoutMin: number;
  isBlocked: boolean;
  onCardPress: () => void;
}

function ScreensaverHarness({ timeoutMin, isBlocked, onCardPress }: HarnessProps): ReactElement {
  const ss = useOledScreensaver({ timeoutMin, isBlocked });

  return (
    <TvRemoteProvider>
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={createAppI18n('en')}>
          <View testID="screensaver-harness" style={{ flex: 1 }}>
            <Pressable
              testID="underlying-card"
              onPress={() => {
                if (ss.state.wakeSuppressed) return;
                onCardPress();
              }}
            >
              <Text>Underlying Card</Text>
            </Pressable>
            <Pressable testID="activity-trigger" onPress={ss.recordActivity}>
              <Text>Activity</Text>
            </Pressable>
            <OledScreensaverOverlay state={ss.state} onWake={ss.wake} />
          </View>
        </I18nProvider>
      </ThemeProvider>
    </TvRemoteProvider>
  );
}

describe('OLED Screensaver (#160)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-22T20:15:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('activates pure #000000 overlay after idle timeout, drifts every 60s, and shields wake-clicks for 260ms', async () => {
    const onCardPress = jest.fn();

    const view = await render(
      <ScreensaverHarness timeoutMin={5} isBlocked={false} onCardPress={onCardPress} />,
    );

    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();

    // Advance 4 min -> still inactive
    await act(async () => {
      jest.advanceTimersByTime(4 * 60_000);
    });
    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();

    // Advance 1 more min (5 min total) -> activates pure #000000 canvas
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    const overlay = screen.getByTestId('oled-screensaver-overlay');
    expect(StyleSheet.flatten(overlay.props.style)?.backgroundColor).toBe(OLED_PURE_BLACK);
    expect(OLED_PURE_BLACK).toBe('#000000');
    expect(screen.getByTestId('oled-screensaver-clock')).toBeTruthy();
    expect(screen.getByTestId('oled-screensaver-brand')).toBeTruthy();

    const beforeStyle = StyleSheet.flatten(
      screen.getByTestId('oled-screensaver-drift-anchor').props.style,
    );
    // Advance 60s -> anti-burn-in drift shifts coordinates
    await act(async () => {
      jest.advanceTimersByTime(OLED_DRIFT_INTERVAL_MS);
    });
    const afterStyle = StyleSheet.flatten(
      screen.getByTestId('oled-screensaver-drift-anchor').props.style,
    );
    expect({ left: afterStyle?.left, top: afterStyle?.top }).not.toEqual({
      left: beforeStyle?.left,
      top: beforeStyle?.top,
    });

    // Wake press dismisses overlay and enables 260ms wake-click suppression
    await fireEvent.press(overlay);
    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();

    await fireEvent.press(screen.getByTestId('underlying-card'));
    expect(onCardPress).not.toHaveBeenCalled();

    // After >= 260ms suppression window expires, clicks trigger normally
    await act(async () => {
      jest.advanceTimersByTime(OLED_WAKE_SUPPRESS_MS + 10);
    });
    await fireEvent.press(screen.getByTestId('underlying-card'));
    expect(onCardPress).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('never fires during active playback (isBlocked=true) and activates after idle when unblocked', async () => {
    const onCardPress = jest.fn();

    const view = await render(
      <ScreensaverHarness timeoutMin={5} isBlocked={true} onCardPress={onCardPress} />,
    );

    // Even after 30 minutes of active playback, OLED screensaver must NEVER engage
    await act(async () => {
      jest.advanceTimersByTime(30 * 60_000);
    });
    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();

    // Unblock (playback paused/ended/menu) -> activates after full 5-minute idle timeout
    await view.rerender(
      <ScreensaverHarness timeoutMin={5} isBlocked={false} onCardPress={onCardPress} />,
    );
    await act(async () => {
      jest.advanceTimersByTime(4 * 60_000);
    });
    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('oled-screensaver-overlay')).toBeTruthy();

    await view.unmount();
  });

  it('stays disabled when timeoutMin is 0 and resets idle countdown on activity', async () => {
    const onCardPress = jest.fn();
    const view = await render(
      <ScreensaverHarness timeoutMin={0} isBlocked={false} onCardPress={onCardPress} />,
    );
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();

    await view.rerender(
      <ScreensaverHarness timeoutMin={5} isBlocked={false} onCardPress={onCardPress} />,
    );
    await act(async () => {
      jest.advanceTimersByTime(4 * 60_000);
    });
    await fireEvent.press(screen.getByTestId('activity-trigger'));
    await act(async () => {
      jest.advanceTimersByTime(4 * 60_000);
    });
    expect(screen.queryByTestId('oled-screensaver-overlay')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('oled-screensaver-overlay')).toBeTruthy();

    await view.unmount();
  });

  it('exclusively intercepts TV wake keys (down/press/up) without leaking to underlying subscribers and survives StrictMode', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const leaked: string[] = [];
    const onWake = jest.fn();
    const saverBox: { current: ReturnType<typeof useOledScreensaver> | null } = { current: null };

    const view = await render(
      <StrictMode>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <TvRemoteProvider dispatcher={dispatcher}>
              <UnderlyingTvConsumer
                onLeak={(entry) => leaked.push(entry)}
                onApi={(api) => {
                  saverBox.current = api;
                }}
              />
              <OledScreensaverOverlay
                state={{ active: true, wakeSuppressed: false, driftIndex: 0, xPct: 50, yPct: 45 }}
                onWake={onWake}
              />
            </TvRemoteProvider>
          </I18nProvider>
        </ThemeProvider>
      </StrictMode>,
    );

    dispatcher.dispatch({ key: 'select', action: 'press', time: 100 }, false);
    dispatcher.dispatch({ key: 'back', action: 'up', time: 120 }, false);
    dispatcher.dispatch({ key: 'right', action: 'down', time: 140 }, false);

    expect(onWake).toHaveBeenCalledTimes(3);
    expect(leaked).toEqual([]);
    expect(saverBox.current).not.toBeNull();
    expect(saverBox.current?.recordActivity()).toBe(false);
    await view.unmount();
  });
});
