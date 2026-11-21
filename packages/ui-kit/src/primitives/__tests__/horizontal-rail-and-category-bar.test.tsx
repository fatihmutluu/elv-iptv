import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { type ComponentRef, createRef } from 'react';
import { Platform, type ScrollView, StyleSheet, Text, View } from 'react-native';
import { buildTheme, ThemeProvider } from '../../theme';
import { ViewportProvider } from '../../viewport';
import { EditorialCategoryBar, type EditorialCategoryItem } from '../EditorialCategoryBar';
import { HorizontalRailScroll } from '../HorizontalRailScroll';

const SAMPLE_ITEMS: readonly EditorialCategoryItem[] = [
  { id: 'all', label: 'All', testID: 'cat-all' },
  { id: 'action', label: 'Action', testID: 'cat-action' },
  { id: 'drama', label: 'Drama', testID: 'cat-drama' },
  { id: 'scifi', label: 'Sci-Fi', testID: 'cat-scifi' },
  { id: 'comedy', label: 'Comedy', testID: 'cat-comedy' },
  { id: 'thriller', label: 'Thriller', testID: 'cat-thriller' },
  { id: 'doc', label: 'Documentary', testID: 'cat-doc' },
];

describe('HorizontalRailScroll', () => {
  const originalOs = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('forwards external scrollRef and renders children without arrows on TV', async () => {
    const ref = createRef<ComponentRef<typeof ScrollView>>();
    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'tv', inputModality: 'tv', width: 1920, height: 1080 }}
        >
          <HorizontalRailScroll scrollRef={ref} isTv testID="tv-rail">
            <Text>Card 1</Text>
          </HorizontalRailScroll>
        </ViewportProvider>
      </ThemeProvider>,
    );

    expect(ref.current).not.toBeNull();
    expect(screen.getByText('Card 1')).toBeTruthy();
    expect(screen.getByTestId('tv-rail-scroll').props.focusable).toBe(false);
    expect(screen.queryByTestId('tv-rail-scroll-left')).toBeNull();
    expect(screen.queryByTestId('tv-rail-scroll-right')).toBeNull();
  });

  it('shows edge chevron controls on web pointer modality when scrollable and scrolls on press', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const ref = createRef<ComponentRef<typeof ScrollView>>();
    const onScroll = jest.fn();

    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'desktop', inputModality: 'pointer', width: 1440, height: 900 }}
        >
          <HorizontalRailScroll scrollRef={ref} testID="web-rail" onScroll={onScroll}>
            <View style={{ width: 2000, height: 100 }} />
          </HorizontalRailScroll>
        </ViewportProvider>
      </ThemeProvider>,
    );

    const scrollView = screen.getByTestId('web-rail-scroll');
    await fireEvent(scrollView, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 120 } },
    });
    await fireEvent(scrollView, 'contentSizeChange', 2000, 120);

    // At x = 0: only right chevron is available
    expect(screen.queryByTestId('web-rail-scroll-left')).toBeNull();
    const rightBtn = screen.getByTestId('web-rail-scroll-right');
    expect(rightBtn).toBeTruthy();

    const scrollToSpy = jest.fn();
    if (ref.current) {
      (ref.current as unknown as { scrollTo: jest.Mock }).scrollTo = scrollToSpy;
    }

    await fireEvent.press(rightBtn);
    expect(scrollToSpy).toHaveBeenCalledWith({
      x: Math.round(800 * 0.78),
      animated: true,
    });

    // Simulate scrolling mid-way -> both chevrons appear
    await fireEvent.scroll(scrollView, {
      nativeEvent: {
        contentOffset: { x: 400, y: 0 },
        contentSize: { width: 2000, height: 120 },
        layoutMeasurement: { width: 800, height: 120 },
      },
    });
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('web-rail-scroll-left')).toBeTruthy();
    expect(screen.getByTestId('web-rail-scroll-right')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('web-rail-scroll-left'));
    expect(scrollToSpy).toHaveBeenLastCalledWith({
      x: 0,
      animated: true,
    });
  });
});

describe('EditorialCategoryBar', () => {
  it('renders borderless underline tabs with accent bar on active item and selects on press', async () => {
    const theme = buildTheme();
    const onSelect = jest.fn();

    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'desktop', inputModality: 'pointer', width: 1440, height: 900 }}
        >
          <EditorialCategoryBar
            items={SAMPLE_ITEMS.slice(0, 4)}
            activeId="action"
            onSelect={onSelect}
            testID="cat-bar"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const bar = screen.getByTestId('cat-bar');
    const barStyle = StyleSheet.flatten(bar.props.style);
    expect(barStyle.borderBottomWidth).toBe(1);
    expect(barStyle.borderBottomColor).toBe(theme.colors.surfaceBorder);

    // Active indicator exists only on active item
    const activeUnderline = screen.getByTestId('cat-bar-active-bar-action');
    const underlineStyle = StyleSheet.flatten(activeUnderline.props.style);
    expect(underlineStyle.backgroundColor).toBe(theme.colors.accent);
    expect(underlineStyle.height).toBe(2);
    expect(screen.queryByTestId('cat-bar-active-bar-all')).toBeNull();

    // No pill border on tabs, and >= 40px touch target height
    const tabStyle = StyleSheet.flatten(screen.getByTestId('cat-action').props.style);
    expect(tabStyle.borderRadius ?? 0).toBeLessThan(theme.radius.pill);
    expect(tabStyle.minHeight).toBeGreaterThanOrEqual(40);
    expect(screen.getByTestId('cat-action').props.focusable).toBe(true);

    await fireEvent.press(screen.getByTestId('cat-drama'));
    expect(onSelect).toHaveBeenCalledWith('drama');
  });

  it('shows TV focus highlight on focusedIndex and hides inline category picker on TV', async () => {
    const theme = buildTheme();
    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'tv', inputModality: 'tv', width: 1920, height: 1080 }}
        >
          <EditorialCategoryBar
            items={SAMPLE_ITEMS}
            activeId="all"
            onSelect={jest.fn()}
            focusedIndex={2}
            isTv
            pickerLabel="All categories"
            testID="tv-cat-bar"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const focusedTab = screen.getByTestId('cat-drama');
    const focusedStyle = StyleSheet.flatten(focusedTab.props.style);
    expect(focusedTab.props.focusable).toBe(false);
    expect(focusedStyle.backgroundColor).toBe(theme.colors.focusFill);
    const focusRing = screen.getByTestId('cat-drama-focus-ring');
    const ringStyle = StyleSheet.flatten(focusRing.props.style);
    expect(ringStyle.borderColor).toBe(theme.colors.focusRingColor);
    expect(ringStyle.borderWidth).toBe(theme.focus.ringWidth);
    expect(screen.queryByTestId('cat-all-focus-ring')).toBeNull();
    expect(screen.queryByTestId('tv-cat-bar-picker-trigger')).toBeNull();
  });

  it('renders inline category picker when non-TV item count exceeds pickerThreshold and selects from dropdown', async () => {
    const onSelect = jest.fn();
    await render(
      <ThemeProvider>
        <ViewportProvider
          value={{ formFactor: 'desktop', inputModality: 'pointer', width: 1440, height: 900 }}
        >
          <EditorialCategoryBar
            items={SAMPLE_ITEMS}
            activeId="all"
            onSelect={onSelect}
            pickerLabel="All categories"
            pickerThreshold={6}
            testID="desk-cat-bar"
          />
        </ViewportProvider>
      </ThemeProvider>,
    );

    const trigger = screen.getByTestId('desk-cat-bar-picker-trigger');
    expect(trigger).toBeTruthy();
    expect(screen.queryByTestId('desk-cat-bar-picker-menu')).toBeNull();

    await fireEvent.press(trigger);
    expect(screen.getByTestId('desk-cat-bar-picker-menu')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('desk-cat-bar-picker-item-doc'));
    expect(onSelect).toHaveBeenCalledWith('doc');
    expect(screen.queryByTestId('desk-cat-bar-picker-menu')).toBeNull();

    // Open again and close via backdrop (localized ui.dismiss label + elevated stacking zIndex)
    await fireEvent.press(trigger);
    expect(screen.getByTestId('desk-cat-bar-picker-menu')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId('desk-cat-bar').props.style).zIndex).toBe(30);
    const backdrop = screen.getByTestId('desk-cat-bar-picker-backdrop');
    expect(backdrop.props.accessibilityLabel).toBe('Dismiss');
    await fireEvent.press(backdrop);
    expect(screen.queryByTestId('desk-cat-bar-picker-menu')).toBeNull();
  });

  it('closes the category picker dropdown on Escape keydown on web', async () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const listeners = new Set<(e: { key?: string }) => void>();
    const prevWindow = (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, 'window', {
      value: {
        addEventListener: (type: string, fn: (e: { key?: string }) => void) => {
          if (type === 'keydown') listeners.add(fn);
        },
        removeEventListener: (type: string, fn: (e: { key?: string }) => void) => {
          if (type === 'keydown') listeners.delete(fn);
        },
      },
      configurable: true,
    });

    try {
      await render(
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', inputModality: 'pointer', width: 1440, height: 900 }}
          >
            <EditorialCategoryBar
              items={SAMPLE_ITEMS}
              activeId="all"
              onSelect={jest.fn()}
              pickerLabel="Categories"
              pickerThreshold={6}
              testID="esc-cat-bar"
            />
          </ViewportProvider>
        </ThemeProvider>,
      );

      await fireEvent.press(screen.getByTestId('esc-cat-bar-picker-trigger'));
      expect(screen.getByTestId('esc-cat-bar-picker-menu')).toBeTruthy();
      expect(listeners.size).toBe(1);

      await act(async () => {
        for (const fn of [...listeners]) fn({ key: 'Escape' });
      });
      expect(screen.queryByTestId('esc-cat-bar-picker-menu')).toBeNull();
      expect(listeners.size).toBe(0);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
      Object.defineProperty(globalThis, 'window', { value: prevWindow, configurable: true });
    }
  });
});
