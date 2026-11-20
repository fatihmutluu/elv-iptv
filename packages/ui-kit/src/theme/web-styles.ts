import { Platform, type ViewStyle } from 'react-native';
import type { Theme } from './tokens';

/**
 * Returns a web-only CSS transition style using the active Cinema Quietude easing curve,
 * collapsing to `transitionProperty: 'none'` when `theme.reduceMotion` is enabled and returning
 * `undefined` on native platforms.
 */
export function webTransition(
  theme: Theme,
  properties: string,
  durationMs?: number,
): ViewStyle | undefined {
  if (Platform.OS !== 'web') return undefined;
  if (theme.reduceMotion) {
    return { transitionProperty: 'none' } as unknown as ViewStyle;
  }
  return {
    transitionProperty: properties,
    transitionDuration: `${durationMs ?? theme.motion.fastMs}ms`,
    transitionTimingFunction: theme.motion.easing,
  } as unknown as ViewStyle;
}

/** Returns a web-only frosted-glass `backdrop-filter: blur(Npx)` style (`undefined` on native). */
export function webBackdropBlur(px: number): ViewStyle | undefined {
  if (Platform.OS !== 'web') return undefined;
  const filter = `blur(${px}px)`;
  return {
    backdropFilter: filter,
    WebkitBackdropFilter: filter,
  } as unknown as ViewStyle;
}

/** Returns a web-only CSS `box-shadow` style (`undefined` on native). */
export function webShadow(value: string): ViewStyle | undefined {
  if (Platform.OS !== 'web') return undefined;
  return { boxShadow: value } as unknown as ViewStyle;
}

/** Returns a web-only `cursor: 'pointer'` style (`undefined` on native). */
export function webCursorPointer(): ViewStyle | undefined {
  if (Platform.OS !== 'web') return undefined;
  return { cursor: 'pointer' } as unknown as ViewStyle;
}
