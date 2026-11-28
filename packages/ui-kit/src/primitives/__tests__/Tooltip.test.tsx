import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { buildTheme, ThemeProvider } from '../../theme';
import { ViewportProvider } from '../../viewport';
import { IconButton } from '../IconButton';
import { Tooltip } from '../Tooltip';

function TrackedChild({ counters }: { readonly counters: { mounts: number; unmounts: number } }) {
  useEffect(() => {
    counters.mounts += 1;
    return () => {
      counters.unmounts += 1;
    };
  }, [counters]);
  return <View testID="stable-child" />;
}

function TooltipToggleHarness({
  counters,
}: {
  readonly counters: { mounts: number; unmounts: number };
}) {
  const [disabled, setDisabled] = useState(false);
  return (
    <ThemeProvider>
      <ViewportProvider
        value={{ formFactor: 'desktop', inputModality: 'pointer', orientation: 'landscape' }}
      >
        <Tooltip content="Profile" delayMs={0} disabled={disabled} testID="toggle-tip">
          <TrackedChild counters={counters} />
        </Tooltip>
        <Text testID="toggle-disabled" onPress={() => setDisabled((d) => !d)}>
          {disabled ? 'off' : 'on'}
        </Text>
      </ViewportProvider>
    </ThemeProvider>
  );
}

const defaultTheme = buildTheme();
const flat = StyleSheet.flatten;

describe('Tooltip & IconButton integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reveals dark-glass theme-tokenized bubble after delayMs on web pointer hover and dismisses on leave or press', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <Tooltip content="Mute audio" description="Press M" delayMs={320} testID="vol-tip">
            <View testID="trigger">
              <Text>Vol</Text>
            </View>
          </Tooltip>
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('vol-tip-bubble')).toBeNull();

    await fireEvent(screen.getByTestId('vol-tip'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(319);
    });
    expect(screen.queryByTestId('vol-tip-bubble')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(2);
    });
    const bubble = screen.getByTestId('vol-tip-bubble');
    const bubbleStyle = flat(bubble.props.style);
    expect(bubble.props.pointerEvents).toBe('none');
    expect(bubbleStyle.position).toBe('fixed');
    expect(bubbleStyle.backgroundColor).toBe(defaultTheme.colors.bgElevated);
    expect(bubbleStyle.borderColor).toBe(defaultTheme.colors.surfaceBorder);
    expect(bubbleStyle.zIndex).toBe(9999);

    // Rendered at ThemeProvider root overlay layer, outside the anchor subtree
    expect(within(screen.getByTestId('vol-tip')).queryByTestId('vol-tip-bubble')).toBeNull();

    const primaryText = screen.getByText('Mute audio');
    expect(flat(primaryText.props.style).color).toBe(defaultTheme.colors.textPrimary);
    const descText = screen.getByText('Press M');
    expect(flat(descText.props.style).color).toBe(defaultTheme.colors.textSecondary);

    // Dismisses immediately on pointerLeave
    await fireEvent(screen.getByTestId('vol-tip'), 'pointerLeave');
    expect(screen.queryByTestId('vol-tip-bubble')).toBeNull();

    // Re-open and dismiss immediately on pointerDown (press)
    await fireEvent(screen.getByTestId('vol-tip'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(325);
    });
    expect(screen.getByTestId('vol-tip-bubble')).toBeTruthy();
    await fireEvent(screen.getByTestId('vol-tip'), 'pointerDown');
    expect(screen.queryByTestId('vol-tip-bubble')).toBeNull();
  });

  it('renders children directly untouched on TV, non-web platforms, disabled, or empty content', async () => {
    // TV on web -> untouched (no wrapper with testID)
    jest.replaceProperty(Platform, 'OS', 'web');
    const tvView = await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
          <Tooltip content="Play" testID="tv-tip">
            <View testID="tv-child" />
          </Tooltip>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('tv-child')).toBeTruthy();
    expect(screen.queryByTestId('tv-tip')).toBeNull();
    await tvView.unmount();

    // Empty content -> untouched
    const emptyView = await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <Tooltip content="   " testID="empty-tip">
            <View testID="empty-child" />
          </Tooltip>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('empty-child')).toBeTruthy();
    expect(screen.queryByTestId('empty-tip')).toBeNull();
    await emptyView.unmount();

    // Disabled -> untouched
    const disabledView = await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <Tooltip content="Hidden" disabled testID="dis-tip">
            <View testID="dis-child" />
          </Tooltip>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('dis-child')).toBeTruthy();
    expect(screen.queryByTestId('dis-tip')).toBeNull();
    await disabledView.unmount();

    // Touch modality on web -> untouched (prevents sticky hover tooltips on touch tablets/phones)
    const touchView = await render(
      <ThemeProvider>
        <ViewportProvider
          value={{
            formFactor: 'tablet',
            inputModality: 'touch',
            orientation: 'landscape',
            width: 1024,
            height: 768,
          }}
        >
          <Tooltip content="Touch ignored" testID="touch-tip">
            <View testID="touch-child" />
          </Tooltip>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('touch-child')).toBeTruthy();
    expect(screen.queryByTestId('touch-tip')).toBeNull();
    await touchView.unmount();

    // Non-web platform -> untouched
    jest.replaceProperty(Platform, 'OS', 'android');
    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <Tooltip content="Native" testID="native-tip">
            <View testID="native-child" />
          </Tooltip>
        </ViewportProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('native-child')).toBeTruthy();
    expect(screen.queryByTestId('native-tip')).toBeNull();
  });

  it('wires Tooltip into IconButton using accessibilityLabel by default and respects tooltip={false}', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    await render(
      <ThemeProvider>
        <ViewportProvider value={{ formFactor: 'desktop', orientation: 'landscape' }}>
          <IconButton icon="plus" accessibilityLabel="Add to My List" testID="ib-default" />
          <IconButton
            icon="info"
            accessibilityLabel="Details"
            tooltip="More details"
            testID="ib-custom"
          />
          <IconButton icon="search" accessibilityLabel="Search" tooltip={false} testID="ib-off" />
        </ViewportProvider>
      </ThemeProvider>,
    );

    await fireEvent(screen.getByTestId('ib-default-tooltip'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(330);
    });
    expect(screen.getByText('Add to My List')).toBeTruthy();

    await fireEvent(screen.getByTestId('ib-custom-tooltip'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(330);
    });
    expect(screen.getByText('More details')).toBeTruthy();

    expect(screen.queryByTestId('ib-off-tooltip')).toBeNull();
  });

  it('falls back to inline bubble rendering when mounted outside ThemeProvider', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');

    await render(
      <ViewportProvider
        value={{ formFactor: 'desktop', inputModality: 'pointer', orientation: 'landscape' }}
      >
        <Tooltip content="Standalone" delayMs={0} testID="inline-tip">
          <View testID="inline-trigger" />
        </Tooltip>
      </ViewportProvider>,
    );

    await fireEvent(screen.getByTestId('inline-tip'), 'pointerEnter');
    expect(within(screen.getByTestId('inline-tip')).getByTestId('inline-tip-bubble')).toBeTruthy();
    expect(screen.getByText('Standalone')).toBeTruthy();
  });

  it('keeps child instance mounted without unmount/remount when disabled toggles dynamically on desktop web', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const counters = { mounts: 0, unmounts: 0 };

    await render(<TooltipToggleHarness counters={counters} />);
    expect(counters.mounts).toBe(1);
    expect(counters.unmounts).toBe(0);

    await fireEvent(screen.getByTestId('toggle-tip'), 'pointerEnter');
    expect(screen.getByTestId('toggle-tip-bubble')).toBeTruthy();

    // Flipping disabled true -> false must preserve child identity and suppress bubble while disabled
    await fireEvent.press(screen.getByTestId('toggle-disabled'));
    expect(screen.queryByTestId('toggle-tip-bubble')).toBeNull();
    expect(counters.mounts).toBe(1);
    expect(counters.unmounts).toBe(0);

    await fireEvent.press(screen.getByTestId('toggle-disabled'));
    expect(counters.mounts).toBe(1);
    expect(counters.unmounts).toBe(0);
    await fireEvent(screen.getByTestId('toggle-tip'), 'pointerEnter');
    expect(screen.getByTestId('toggle-tip-bubble')).toBeTruthy();
  });
});
