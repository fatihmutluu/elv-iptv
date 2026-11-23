import type { AppWindowLike } from './types.ts';

/** Inputs to {@link shouldUseSimpleFullscreen} for macOS multi-monitor fullscreen policy (`#301`). */
export interface MacSimpleFullscreenPolicyInput {
  readonly platform: NodeJS.Platform;
  readonly displayCount: number;
  readonly screensHaveSeparateSpaces: boolean;
}

/**
 * Returns `true` when macOS has multiple displays and "Displays have separate Spaces" is disabled
 * (`screensHaveSeparateSpaces === false`). Using Electron's borderless `simpleFullscreen` in this
 * configuration avoids macOS blanking secondary monitors and prevents cross-Space window glitches.
 */
export function shouldUseSimpleFullscreen(input: MacSimpleFullscreenPolicyInput): boolean {
  return (
    input.platform === 'darwin' &&
    Number.isFinite(input.displayCount) &&
    input.displayCount > 1 &&
    input.screensHaveSeparateSpaces === false
  );
}

/** Returns `true` when `appWindow` is in either native fullscreen or macOS `simpleFullscreen`. */
export function isAppWindowFullscreen(
  appWindow: Pick<AppWindowLike, 'isFullScreen' | 'isSimpleFullScreen'>,
): boolean {
  return appWindow.isFullScreen() || appWindow.isSimpleFullScreen?.() === true;
}

/**
 * Transitions `appWindow` into or out of fullscreen, preferring macOS `simpleFullscreen` when
 * `useSimpleFullscreen` is enabled and `setSimpleFullScreen` is available. Returns `'simple'` when
 * `setSimpleFullScreen` was invoked, or `'native'` when `setFullScreen` was invoked.
 */
export function setAppWindowFullscreen(
  appWindow: Pick<
    AppWindowLike,
    'isFullScreen' | 'setFullScreen' | 'isSimpleFullScreen' | 'setSimpleFullScreen'
  >,
  flag: boolean,
  useSimpleFullscreen: boolean,
): 'simple' | 'native' {
  if (flag) {
    if (useSimpleFullscreen && typeof appWindow.setSimpleFullScreen === 'function') {
      appWindow.setSimpleFullScreen(true);
      return 'simple';
    }
    appWindow.setFullScreen(true);
    return 'native';
  }

  let usedSimple = false;
  if (
    appWindow.isSimpleFullScreen?.() === true &&
    typeof appWindow.setSimpleFullScreen === 'function'
  ) {
    appWindow.setSimpleFullScreen(false);
    usedSimple = true;
  }
  if (appWindow.isFullScreen()) {
    appWindow.setFullScreen(false);
    return 'native';
  }
  if (usedSimple) return 'simple';
  if (useSimpleFullscreen && typeof appWindow.setSimpleFullScreen === 'function') {
    appWindow.setSimpleFullScreen(false);
    return 'simple';
  }
  appWindow.setFullScreen(false);
  return 'native';
}
