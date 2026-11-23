import { describe, expect, it } from 'vitest';
import { fakeAppWindow } from '../testing/fake-windows.ts';
import {
  isAppWindowFullscreen,
  setAppWindowFullscreen,
  shouldUseSimpleFullscreen,
} from './macos-spaces.ts';

describe('shouldUseSimpleFullscreen (#301)', () => {
  it('returns true only on multi-monitor darwin when screensHaveSeparateSpaces is false', () => {
    expect(
      shouldUseSimpleFullscreen({
        platform: 'darwin',
        displayCount: 2,
        screensHaveSeparateSpaces: false,
      }),
    ).toBe(true);
    expect(
      shouldUseSimpleFullscreen({
        platform: 'darwin',
        displayCount: 3,
        screensHaveSeparateSpaces: false,
      }),
    ).toBe(true);
    expect(
      shouldUseSimpleFullscreen({
        platform: 'darwin',
        displayCount: 1,
        screensHaveSeparateSpaces: false,
      }),
    ).toBe(false);
    expect(
      shouldUseSimpleFullscreen({
        platform: 'darwin',
        displayCount: 2,
        screensHaveSeparateSpaces: true,
      }),
    ).toBe(false);
    expect(
      shouldUseSimpleFullscreen({
        platform: 'win32',
        displayCount: 2,
        screensHaveSeparateSpaces: false,
      }),
    ).toBe(false);
    expect(
      shouldUseSimpleFullscreen({
        platform: 'linux',
        displayCount: 2,
        screensHaveSeparateSpaces: false,
      }),
    ).toBe(false);
  });
});

describe('isAppWindowFullscreen & setAppWindowFullscreen', () => {
  it('detects both native fullscreen and simpleFullscreen and exits the active mode cleanly', () => {
    const app = fakeAppWindow();
    expect(isAppWindowFullscreen(app.window)).toBe(false);

    expect(setAppWindowFullscreen(app.window, true, true)).toBe('simple');
    expect(app.state.simpleFullscreen).toBe(true);
    expect(app.state.fullscreen).toBe(false);
    expect(isAppWindowFullscreen(app.window)).toBe(true);

    // Even if display count later drops so useSimpleFullscreen becomes false, exiting clears simpleFullscreen
    expect(setAppWindowFullscreen(app.window, false, false)).toBe('simple');
    expect(app.state.simpleFullscreen).toBe(false);
    expect(isAppWindowFullscreen(app.window)).toBe(false);

    expect(setAppWindowFullscreen(app.window, true, false)).toBe('native');
    expect(app.state.fullscreen).toBe(true);
    expect(isAppWindowFullscreen(app.window)).toBe(true);

    expect(setAppWindowFullscreen(app.window, false, true)).toBe('native');
    expect(app.state.fullscreen).toBe(false);
    expect(isAppWindowFullscreen(app.window)).toBe(false);
  });
});
