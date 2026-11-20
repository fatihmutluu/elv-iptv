import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Pressable, Text } from 'react-native';
import {
  buildTheme,
  clampFontScale,
  contrastRatio,
  hexToRgba,
  isThemePresetId,
  THEME_PRESET_IDS,
  THEME_PRESETS,
  ThemeProvider,
  useTheme,
  useThemeController,
} from '../index';

describe('theme color utilities & WCAG contrast invariants (#325)', () => {
  it('converts #RGB and #RRGGBB hex strings to rgba and clamps opacity', () => {
    expect(hexToRgba('#090A0E', 0.5)).toBe('rgba(9, 10, 14, 0.5)');
    expect(hexToRgba('#fff', 1.5)).toBe('rgba(255, 255, 255, 1)');
    expect(hexToRgba('#000', -0.2)).toBe('rgba(0, 0, 0, 0)');
    expect(() => hexToRgba('not-a-color', 1)).toThrow(/Invalid hex/);
  });

  it('guarantees AA/AAA readability across every built-in preset and AAA >= 7:1 on highContrast', () => {
    for (const id of THEME_PRESET_IDS) {
      expect(isThemePresetId(id)).toBe(true);
      const p = THEME_PRESETS[id];
      expect(contrastRatio(p.textPrimary, p.bgCanvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.ctaFg, p.ctaBg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.textSecondary, p.bgCanvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.focusRingColor, p.bgCanvas)).toBeGreaterThanOrEqual(7);
    }

    const hc = THEME_PRESETS.highContrast;
    expect(contrastRatio(hc.textPrimary, hc.bgCanvas)).toBeGreaterThanOrEqual(20);
    expect(contrastRatio(hc.textSecondary, hc.bgCanvas)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hc.textMuted, hc.bgCanvas)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hc.accent, hc.bgCanvas)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hc.focusRingColor, hc.bgCanvas)).toBeGreaterThanOrEqual(7);
    expect(isThemePresetId('unknown')).toBe(false);
    expect(isThemePresetId('constructor')).toBe(false);
    expect(isThemePresetId('toString')).toBe(false);
  });

  it('derives scrims and glass dynamically from bgCanvas / bgElevated with zero hardcoded dark-blue', () => {
    const amber = buildTheme({ preset: 'theaterAmber' });
    const hc = buildTheme({ preset: 'highContrast' });
    expect(amber.colors.scrimStrong).toBe('rgba(10, 9, 8, 0.94)');
    expect(amber.colors.scrimTransparent).toBe('rgba(10, 9, 8, 0)');
    expect(hc.colors.scrimStrong).toBe('rgba(0, 0, 0, 0.94)');
    expect(hc.highContrast).toBe(true);
    expect(hc.focus.ringWidth).toBeGreaterThan(amber.focus.ringWidth);
  });

  it('clamps fontScale to [0.9, 1.2] and collapses motion & focus scaling under reduceMotion', () => {
    expect(clampFontScale(0.5)).toBe(0.9);
    expect(clampFontScale(2.5)).toBe(1.2);
    expect(clampFontScale(Number.NaN)).toBe(1);

    const reduced = buildTheme({ fontScale: 1.2, reduceMotion: true });
    expect(reduced.fontScale).toBe(1.2);
    expect(reduced.typography.body.fontSize).toBe(Math.round(14 * 1.2));
    expect(reduced.motion.fastMs).toBe(0);
    expect(reduced.motion.normalMs).toBe(0);
    expect(reduced.motion.sheetMs).toBe(0);
    expect(reduced.focus.cardScale).toBe(1);
    expect(reduced.focus.buttonScale).toBe(1);
  });
});

function ThemeControlProbe() {
  const theme = useTheme();
  const ctrl = useThemeController();
  return (
    <>
      <Text testID="preset">{theme.preset}</Text>
      <Text testID="canvas">{theme.colors.bgCanvas}</Text>
      <Text testID="scale">{String(theme.fontScale)}</Text>
      <Text testID="motion">{String(theme.motion.fastMs)}</Text>
      <Pressable testID="to-hc" onPress={() => ctrl.setPreset('highContrast')} />
      <Pressable testID="to-scale" onPress={() => ctrl.setFontScale(1.15)} />
      <Pressable testID="to-reduce" onPress={() => ctrl.setReduceMotion(true)} />
    </>
  );
}

function ReduceMotionProbe() {
  const theme = useTheme();
  return <Text testID="reduced">{String(theme.reduceMotion)}</Text>;
}

describe('ThemeProvider & useThemeController', () => {
  it('switches preset, fontScale, and reduceMotion live and notifies onChange', async () => {
    const onChange = jest.fn();

    await render(
      <ThemeProvider onChange={onChange}>
        <ThemeControlProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('preset').props.children).toBe('obsidianCrimson');
    expect(screen.getByTestId('canvas').props.children).toBe('#090A0E');

    await fireEvent.press(screen.getByTestId('to-hc'));
    expect(screen.getByTestId('preset').props.children).toBe('highContrast');
    expect(screen.getByTestId('canvas').props.children).toBe('#000000');

    await fireEvent.press(screen.getByTestId('to-scale'));
    expect(screen.getByTestId('scale').props.children).toBe('1.15');

    await fireEvent.press(screen.getByTestId('to-reduce'));
    expect(screen.getByTestId('motion').props.children).toBe('0');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('tracks AccessibilityInfo reduceMotionChanged when reduceMotion prop is uncontrolled', async () => {
    let listener: ((enabled: boolean) => void) | undefined;
    const isEnabledSpy = jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(false);
    const addSpy = jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
      _event: string,
      cb: (enabled: boolean) => void,
    ) => {
      listener = cb;
      return { remove: jest.fn() };
    }) as typeof AccessibilityInfo.addEventListener);

    await render(
      <ThemeProvider>
        <ReduceMotionProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('reduced').props.children).toBe('false');

    await act(() => {
      listener?.(true);
    });
    expect(screen.getByTestId('reduced').props.children).toBe('true');

    isEnabledSpy.mockRestore();
    addSpy.mockRestore();
  });
});
