import { describe, expect, it, vi } from 'vitest';
import type { PopoutLaunchPayload } from '../../../src/shared/window-ipc.ts';
import {
  buildPopoutDockPayload,
  createDesktopThermalDevicePort,
  createDesktopWindowPort,
  isPopoutSearch,
} from './popout-controller.ts';

describe('popout-controller & desktop shell ports (#158, #34)', () => {
  it('detects ?popout=1 strictly from location search', () => {
    expect(isPopoutSearch('?popout=1')).toBe(true);
    expect(isPopoutSearch('?foo=bar&popout=1')).toBe(true);
    expect(isPopoutSearch('?popout=0')).toBe(false);
    expect(isPopoutSearch('')).toBe(false);
    expect(isPopoutSearch('?elv-gate=player')).toBe(false);
  });

  it('builds sanitized PopoutDockPayload omitting positionMs for live and rounding for VOD', () => {
    const livePayload: PopoutLaunchPayload = {
      itemKey: 'live:s1:ch1',
      kind: 'live',
      title: 'Live News',
      subtitle: 'HD',
      sourceId: 's1',
      pinned: true,
    };
    expect(buildPopoutDockPayload(livePayload, 45_000)).toEqual({
      itemKey: 'live:s1:ch1',
      kind: 'live',
      title: 'Live News',
      subtitle: 'HD',
      sourceId: 's1',
    });

    const vodPayload: PopoutLaunchPayload = {
      itemKey: 'movie:s1:m9',
      kind: 'movie',
      title: 'Cinema Feature',
      resumePositionMs: 1000,
    };
    expect(buildPopoutDockPayload(vodPayload, 88_432.7)).toEqual({
      itemKey: 'movie:s1:m9',
      kind: 'movie',
      title: 'Cinema Feature',
      positionMs: 88_433,
    });
    expect(buildPopoutDockPayload(vodPayload, -5)).toEqual({
      itemKey: 'movie:s1:m9',
      kind: 'movie',
      title: 'Cinema Feature',
    });
  });

  it('builds DesktopWindowPort from WindowBridge and returns undefined when missing', async () => {
    expect(createDesktopWindowPort(undefined)).toBeUndefined();

    const setMinimizeToTray = vi.fn(async (flag: boolean) => flag);
    const openPopout = vi.fn(async () => true);
    const closePopout = vi.fn(async () => undefined);
    const onPopoutDocked = vi.fn(() => () => undefined);
    const onWindowRestored = vi.fn(() => () => undefined);
    const onHiddenToTray = vi.fn(() => () => undefined);

    const port = createDesktopWindowPort({
      setAlwaysOnTop: async (f) => f,
      getAlwaysOnTop: async () => false,
      onAlwaysOnTopChanged: () => () => undefined,
      setAspectRatioLock: async (f) => f,
      setMinimizeToTray,
      openPopout,
      closePopout,
      getPopoutPayload: async () => null,
      onPopoutPayload: () => () => undefined,
      dockPopout: async () => undefined,
      onPopoutDocked,
      onWindowRestored,
      onHiddenToTray,
    });

    expect(port).toBeDefined();
    await port?.setMinimizeToTray?.(true);
    expect(setMinimizeToTray).toHaveBeenCalledWith(true);

    const ok = await port?.openPopout?.({
      itemKey: 'live:s1:1',
      kind: 'live',
      title: 'Ch 1',
    });
    expect(ok).toBe(true);
    expect(openPopout).toHaveBeenCalledTimes(1);

    await port?.closePopout?.();
    expect(closePopout).toHaveBeenCalledTimes(1);

    port?.onPopoutDocked?.(() => undefined);
    port?.onWindowRestored?.(() => undefined);
    port?.onHiddenToTray?.(() => undefined);
    expect(onPopoutDocked).toHaveBeenCalledTimes(1);
    expect(onWindowRestored).toHaveBeenCalledTimes(1);
    expect(onHiddenToTray).toHaveBeenCalledTimes(1);
  });

  it('provides ThermalDevicePort returning nominal and desktop Multi-View capabilities', () => {
    const thermal = createDesktopThermalDevicePort();
    expect(thermal.getThermalState()).toBe('nominal');
    expect(thermal.getMultiViewCapabilities()).toEqual({
      platform: 'desktop',
      supported: true,
    });
    const unsub = thermal.subscribeThermalState(() => undefined);
    expect(() => unsub()).not.toThrow();
  });
});
