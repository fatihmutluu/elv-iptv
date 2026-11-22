import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, Pressable, Text } from 'react-native';
import {
  buildFocusVisibleCss,
  buildTheme,
  clampFontScale,
  contrastRatio,
  FONT_FAMILY_SANS,
  hexToRgba,
  isThemePresetId,
  THEME_PRESET_IDS,
  THEME_PRESETS,
  ThemeProvider,
  useTheme,
  useThemeController,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
  webTransition,
} from '../index';

function withPlatformOs<T>(os: typeof Platform.OS, run: () => T): T {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  }
}

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

  it('derives scrims, glass, chips, and hover borders dynamically from the active palette', () => {
    const amber = buildTheme({ preset: 'theaterAmber' });
    const hc = buildTheme({ preset: 'highContrast' });
    expect(amber.colors.scrimStrong).toBe('rgba(10, 9, 8, 0.94)');
    expect(amber.colors.scrimTransparent).toBe('rgba(10, 9, 8, 0)');
    expect(amber.colors.glassBg).toBe(hexToRgba(amber.colors.bgCanvas, 0.82));
    expect(amber.colors.actionGlassBg).toBe(hexToRgba(amber.colors.textPrimary, 0.13));
    expect(amber.colors.actionGlassHoverBg).toBe(hexToRgba(amber.colors.textPrimary, 0.22));
    expect(amber.colors.actionGlassBorder).toBe(hexToRgba(amber.colors.textPrimary, 0.15));
    expect(amber.colors.chipBg).toBe(hexToRgba(amber.colors.textPrimary, 0.06));
    expect(amber.colors.chipHoverBg).toBe(hexToRgba(amber.colors.textPrimary, 0.13));
    expect(amber.colors.chipBorder).toBe(hexToRgba(amber.colors.textPrimary, 0.12));
    expect(amber.colors.topBarScrimStart).toBe(hexToRgba(amber.colors.bgCanvas, 0.9));
    expect(amber.colors.topBarScrimMid).toBe(hexToRgba(amber.colors.bgCanvas, 0.42));
    expect(amber.colors.hoverRingBorder).toBe(hexToRgba(amber.colors.textPrimary, 0.38));

    expect(hc.colors.scrimStrong).toBe('rgba(0, 0, 0, 0.94)');
    expect(hc.colors.glassBg).toBe('rgba(0, 0, 0, 0.96)');
    expect(hc.colors.actionGlassBg).toBe('rgba(255, 255, 255, 0.22)');
    expect(hc.colors.actionGlassHoverBg).toBe('rgba(255, 255, 255, 0.34)');
    expect(hc.colors.actionGlassBorder).toBe('rgba(255, 255, 255, 0.55)');
    expect(hc.colors.chipBg).toBe('rgba(255, 255, 255, 0.14)');
    expect(hc.colors.chipHoverBg).toBe('rgba(255, 255, 255, 0.24)');
    expect(hc.colors.chipBorder).toBe('rgba(255, 255, 255, 0.45)');
    expect(hc.colors.hoverRingBorder).toBe('rgba(255, 255, 255, 0.72)');
    expect(hc.highContrast).toBe(true);
    expect(hc.focus.ringWidth).toBeGreaterThan(amber.focus.ringWidth);
  });

  it('provides Cinema Quietude typography scale with web-only fontFamily and tight display tracking', () => {
    const nativeTheme = buildTheme();
    expect(FONT_FAMILY_SANS).toBeUndefined();
    expect(nativeTheme.typography.display).toEqual({
      fontSize: 34,
      lineHeight: 38,
      fontWeight: '800',
      letterSpacing: -0.9,
    });
    expect(nativeTheme.typography.h1).toEqual({
      fontSize: 24,
      lineHeight: 29,
      fontWeight: '800',
      letterSpacing: -0.5,
    });
    expect(nativeTheme.typography.h2).toEqual({
      fontSize: 17,
      lineHeight: 23,
      fontWeight: '700',
      letterSpacing: -0.25,
    });
    expect(nativeTheme.typography.title).toEqual({
      fontSize: 14,
      lineHeight: 19,
      fontWeight: '600',
      letterSpacing: -0.1,
    });
    expect(nativeTheme.typography.body).toEqual({
      fontSize: 13.5,
      lineHeight: 20,
      fontWeight: '400',
    });
    expect(nativeTheme.typography.caption).toEqual({
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '500',
    });
    expect(nativeTheme.typography.micro).toEqual({
      fontSize: 10.5,
      lineHeight: 14,
      fontWeight: '700',
      letterSpacing: 0.25,
    });
    expect(nativeTheme.typography.display.fontFamily).toBeUndefined();

    const webTheme = withPlatformOs('web', () => buildTheme());
    expect(webTheme.typography.display.fontFamily).toContain('Plus Jakarta Sans');
    expect(webTheme.typography.body.fontFamily).toContain('Plus Jakarta Sans');
  });

  it('clamps fontScale to [0.9, 1.2] and collapses motion & focus scaling under reduceMotion', () => {
    expect(clampFontScale(0.5)).toBe(0.9);
    expect(clampFontScale(2.5)).toBe(1.2);
    expect(clampFontScale(Number.NaN)).toBe(1);

    const reduced = buildTheme({ fontScale: 1.2, reduceMotion: true });
    expect(reduced.fontScale).toBe(1.2);
    expect(reduced.typography.body.fontSize).toBe(16);
    expect(reduced.motion.fastMs).toBe(0);
    expect(reduced.motion.normalMs).toBe(0);
    expect(reduced.motion.sheetMs).toBe(0);
    expect(reduced.focus.cardScale).toBe(1);
    expect(reduced.focus.buttonScale).toBe(1);
  });

  it('returns web-only CSS helpers on web and undefined on native while honoring reduceMotion', () => {
    const theme = buildTheme();
    const reduced = buildTheme({ reduceMotion: true });

    expect(webTransition(theme, 'transform')).toBeUndefined();
    expect(webBackdropBlur(12)).toBeUndefined();
    expect(webShadow('0 8px 22px rgba(0,0,0,0.44)')).toBeUndefined();
    expect(webCursorPointer()).toBeUndefined();

    withPlatformOs('web', () => {
      expect(webTransition(theme, 'transform, opacity')).toEqual({
        transitionProperty: 'transform, opacity',
        transitionDuration: '150ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      expect(webTransition(theme, 'transform', 350)).toEqual({
        transitionProperty: 'transform',
        transitionDuration: '350ms',
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      expect(webTransition(reduced, 'transform')).toEqual({
        transitionProperty: 'none',
      });
      expect(webBackdropBlur(20)).toEqual({
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      });
      expect(webShadow('0 8px 22px rgba(0, 0, 0, 0.44)')).toEqual({
        boxShadow: '0 8px 22px rgba(0, 0, 0, 0.44)',
      });
      expect(webCursorPointer()).toEqual({ cursor: 'pointer' });
    });
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

  it('builds theme-tokenized :focus-visible CSS and suppresses :focus:not(:focus-visible) (#410)', () => {
    const defaultTheme = buildTheme();
    const hcTheme = buildTheme({ preset: 'highContrast' });

    const defaultCss = buildFocusVisibleCss(defaultTheme);
    for (const selector of [
      '[role="button"]:focus-visible',
      '[role="tab"]:focus-visible',
      '[role="switch"]:focus-visible',
      '[role="radio"]:focus-visible',
      '[role="adjustable"]:focus-visible',
      'button:focus-visible',
      'a:focus-visible',
      'input:focus-visible',
      '[tabindex]:focus-visible',
    ]) {
      expect(defaultCss).toContain(selector);
    }
    expect(defaultCss).toContain(
      `outline: ${defaultTheme.focus.ringWidth}px solid ${defaultTheme.colors.focusRingColor}; outline-offset: 2px;`,
    );
    expect(defaultCss).toContain(':focus:not(:focus-visible)');
    expect(defaultCss).toContain('outline: none');

    const hcCss = buildFocusVisibleCss(hcTheme);
    expect(hcCss).toContain(
      `outline: ${hcTheme.focus.ringWidth}px solid #FACC15; outline-offset: 2px;`,
    );
  });

  it('injects an idempotent web base stylesheet, live-updates :focus-visible styles, and cleans up on refcount 0', async () => {
    const appended: Array<{ id: string; textContent: string | null; remove: jest.Mock }> = [];
    const cssVars = new Map<string, string>();
    const fakeDoc = {
      getElementById: jest.fn((id: string) => appended.find((node) => node.id === id) ?? null),
      createElement: jest.fn(() => {
        const node = {
          id: '',
          textContent: null as string | null,
          remove: jest.fn(() => {
            const idx = appended.indexOf(node);
            if (idx >= 0) appended.splice(idx, 1);
          }),
        };
        return node;
      }),
      head: {
        appendChild: jest.fn(
          (node: { id: string; textContent: string | null; remove: jest.Mock }) => {
            appended.push(node);
          },
        ),
      },
      documentElement: {
        style: {
          setProperty: jest.fn((name: string, value: string) => {
            cssVars.set(name, value);
          }),
        },
      },
    };
    const defaultTheme = buildTheme();
    const hcTheme = buildTheme({ preset: 'highContrast' });
    const originalDoc = (globalThis as { document?: unknown }).document;
    const originalOs = Platform.OS;
    Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true });
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    try {
      const first = await render(
        <ThemeProvider>
          <ThemeControlProbe />
        </ThemeProvider>,
      );
      const baseStyle = appended.find((n) => n.id === 'elv-ui-kit-web-base');
      const focusStyle = appended.find((n) => n.id === 'elv-focus-visible-styles');
      expect(baseStyle).toBeDefined();
      expect(focusStyle).toBeDefined();
      expect(appended).toHaveLength(2);
      expect(baseStyle?.textContent).toContain('-webkit-font-smoothing: antialiased');
      expect(baseStyle?.textContent).toContain('Plus Jakarta Sans');
      expect(baseStyle?.textContent).toContain('var(--elv-scroll-thumb');
      expect(baseStyle?.textContent).toContain('var(--elv-scroll-thumb-hover');
      expect(focusStyle?.textContent).toContain(defaultTheme.colors.focusRingColor);
      expect(focusStyle?.textContent).toContain(':focus:not(:focus-visible)');
      expect(cssVars.get('--elv-scroll-thumb')).toBe(defaultTheme.colors.glassBorder);
      expect(cssVars.get('--elv-scroll-thumb-hover')).toBe(defaultTheme.colors.hoverRingBorder);

      await fireEvent.press(screen.getByTestId('to-hc'));
      expect(cssVars.get('--elv-scroll-thumb')).toBe(hcTheme.colors.glassBorder);
      expect(cssVars.get('--elv-scroll-thumb-hover')).toBe(hcTheme.colors.hoverRingBorder);
      expect(focusStyle?.textContent).toContain('#FACC15');
      expect(focusStyle?.textContent).toContain(`${hcTheme.focus.ringWidth}px solid #FACC15`);

      const second = await render(
        <ThemeProvider>
          <ReduceMotionProbe />
        </ThemeProvider>,
      );
      expect(appended).toHaveLength(2);

      await second.unmount();
      // Refcount is still 1 so focus-visible style remains mounted.
      expect(appended.find((n) => n.id === 'elv-focus-visible-styles')).toBeDefined();

      await first.unmount();
      // Refcount reached 0 so focus-visible style is cleaned up.
      expect(appended.find((n) => n.id === 'elv-focus-visible-styles')).toBeUndefined();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: originalDoc, configurable: true });
    }
  });
});
