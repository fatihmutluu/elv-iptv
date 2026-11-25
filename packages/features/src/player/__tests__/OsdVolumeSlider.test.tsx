import { createAppI18n } from '@elv/i18n';
import { buildTheme, ThemeProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import { OsdVolumeSlider } from '../OsdVolumeSlider';

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('OsdVolumeSlider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders fill width, accent color, and adjustable a11y value when unmuted', async () => {
    const i18n = createAppI18n('en');
    const theme = buildTheme({ preset: 'obsidianCrimson' });
    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <OsdVolumeSlider volume={65} muted={false} onChange={jest.fn()} i18n={i18n} />
      </ThemeProvider>,
    );

    const slider = screen.getByTestId('osd-volume-slider');
    expect(slider.props.accessibilityRole).toBe('adjustable');
    expect(slider.props.accessibilityLabel).toBe('Volume');
    expect(slider.props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 65,
      text: '65%',
    });
    expect(flatStyle('osd-volume-slider-fill')?.width).toBe('65%');
    expect(flatStyle('osd-volume-slider-fill')?.backgroundColor).toBe(theme.colors.accent);
    expect(flatStyle('osd-volume-slider-rail')?.height).toBe(3);

    await view.unmount();
  });

  it('displays 0 effective fill and muted color when muted or at 0 volume', async () => {
    const i18n = createAppI18n('en');
    const theme = buildTheme({ preset: 'highContrast' });
    const view = await render(
      <ThemeProvider preset="highContrast">
        <OsdVolumeSlider volume={80} muted onChange={jest.fn()} i18n={i18n} />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('osd-volume-slider').props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 0,
      text: '0%',
    });
    expect(flatStyle('osd-volume-slider-fill')?.width).toBe('0%');
    expect(flatStyle('osd-volume-slider-fill')?.backgroundColor).toBe(theme.colors.textMuted);

    await view.rerender(
      <ThemeProvider preset="highContrast">
        <OsdVolumeSlider volume={0} muted={false} onChange={jest.fn()} i18n={i18n} />
      </ThemeProvider>,
    );
    expect(flatStyle('osd-volume-slider-fill')?.width).toBe('0%');
    expect(flatStyle('osd-volume-slider-fill')?.backgroundColor).toBe(theme.colors.textMuted);

    await view.unmount();
  });

  it('clamps pointer click and web drag coordinates to 0..100', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(e: { clientX?: number }) => void>>();
    const origWindow = (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (type: string, fn: (e: { clientX?: number }) => void) => {
          const set = listeners.get(type) ?? new Set();
          set.add(fn);
          listeners.set(type, set);
        },
        removeEventListener: (type: string, fn: (e: { clientX?: number }) => void) => {
          listeners.get(type)?.delete(fn);
        },
      },
    });

    try {
      const i18n = createAppI18n('en');
      const onChange = jest.fn();
      const onDragStateChange = jest.fn();
      const view = await render(
        <ThemeProvider>
          <OsdVolumeSlider
            volume={50}
            muted={false}
            onChange={onChange}
            onDragStateChange={onDragStateChange}
            i18n={i18n}
          />
        </ThemeProvider>,
      );

      const slider = screen.getByTestId('osd-volume-slider');
      await fireEvent(slider, 'layout', { nativeEvent: { layout: { width: 68 } } });

      // Click at 50%
      await fireEvent(slider, 'press', { nativeEvent: { locationX: 34 } });
      expect(onChange).toHaveBeenLastCalledWith(50);

      // Click below 0 and above width clamp cleanly
      await fireEvent(slider, 'press', { nativeEvent: { locationX: -15 } });
      expect(onChange).toHaveBeenLastCalledWith(0);
      await fireEvent(slider, 'press', { nativeEvent: { locationX: 140 } });
      expect(onChange).toHaveBeenLastCalledWith(100);

      // Hover expands track 3px -> 6px and reveals thumb
      await act(async () => {
        slider.props.onPointerEnter?.();
      });
      expect(flatStyle('osd-volume-slider-rail')?.height).toBe(6);
      expect(flatStyle('osd-volume-slider-thumb')?.opacity).toBe(1);

      // Web pointer drag with bounding rect
      const rect = { left: 100, width: 100 };
      await act(async () => {
        slider.props.onPointerDown?.({
          nativeEvent: { clientX: 120, button: 0 },
          currentTarget: { getBoundingClientRect: () => rect },
        });
      });
      expect(onChange).toHaveBeenLastCalledWith(20);
      expect(onDragStateChange).toHaveBeenLastCalledWith(true);

      await act(async () => {
        for (const fn of listeners.get('pointermove') ?? []) fn({ clientX: 175 });
      });
      expect(onChange).toHaveBeenLastCalledWith(75);

      await act(async () => {
        for (const fn of listeners.get('pointerup') ?? []) fn({ clientX: 250 });
      });
      expect(onChange).toHaveBeenLastCalledWith(100);
      expect(onDragStateChange).toHaveBeenLastCalledWith(false);

      await view.unmount();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: origWindow });
    }
  });

  it('adjusts volume by +-5% on arrow keys and ignores input when disabled', async () => {
    const i18n = createAppI18n('en');
    const onChange = jest.fn();
    const view = await render(
      <ThemeProvider>
        <OsdVolumeSlider volume={50} muted={false} onChange={onChange} i18n={i18n} />
      </ThemeProvider>,
    );

    const slider = screen.getByTestId('osd-volume-slider');
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();

    await act(async () => {
      slider.props.onKeyDown?.({ key: 'ArrowRight', preventDefault, stopPropagation });
    });
    expect(onChange).toHaveBeenLastCalledWith(55);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    await act(async () => {
      slider.props.onKeyDown?.({ key: 'ArrowUp', preventDefault, stopPropagation });
    });
    expect(onChange).toHaveBeenLastCalledWith(55);

    await act(async () => {
      slider.props.onKeyDown?.({ key: 'ArrowLeft', preventDefault, stopPropagation });
    });
    expect(onChange).toHaveBeenLastCalledWith(45);

    await act(async () => {
      slider.props.onKeyDown?.({ key: 'ArrowDown', preventDefault, stopPropagation });
    });
    expect(onChange).toHaveBeenLastCalledWith(45);

    await act(async () => {
      slider.props.onKeyDown?.({ key: 'Home', preventDefault, stopPropagation });
    });
    expect(onChange).toHaveBeenLastCalledWith(0);

    await act(async () => {
      slider.props.onKeyDown?.({ key: 'End', preventDefault, stopPropagation });
    });
    expect(onChange).toHaveBeenLastCalledWith(100);

    // Disabled blocks all changes
    onChange.mockClear();
    await view.rerender(
      <ThemeProvider>
        <OsdVolumeSlider volume={50} muted={false} disabled onChange={onChange} i18n={i18n} />
      </ThemeProvider>,
    );
    await fireEvent(screen.getByTestId('osd-volume-slider'), 'press', {
      nativeEvent: { locationX: 60 },
    });
    await act(async () => {
      screen.getByTestId('osd-volume-slider').props.onKeyDown?.({ key: 'ArrowRight' });
    });
    expect(onChange).not.toHaveBeenCalled();

    await view.unmount();
  });
});
