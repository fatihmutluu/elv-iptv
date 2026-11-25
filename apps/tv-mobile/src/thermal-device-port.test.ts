import { describe, expect, it, vi } from 'vitest';
import { createMobileThermalDevicePort } from './thermal-device-port';

const GIB = 1024 * 1024 * 1024;

describe('createMobileThermalDevicePort (#232)', () => {
  it('wires Android thermal state, subscription, and standard RAM capabilities', () => {
    const unsub = vi.fn();
    let capturedListener:
      | ((state: 'nominal' | 'fair' | 'serious' | 'critical') => void)
      | undefined;
    const port = createMobileThermalDevicePort({
      os: 'android',
      isTV: false,
      getAndroidThermalState: () => 'fair',
      subscribeAndroidThermalState: (listener) => {
        capturedListener = listener;
        return unsub;
      },
      getAndroidDeviceMemoryInfo: () => ({
        isLowRamDevice: false,
        totalMemBytes: 4 * GIB,
        lowRam: false,
      }),
    });

    expect(port.getThermalState()).toBe('fair');
    expect(port.getMultiViewCapabilities()).toEqual({
      platform: 'android',
      totalMemoryBytes: 4 * GIB,
      isLowRamDevice: false,
      supported: true,
    });

    const received: string[] = [];
    const off = port.subscribeThermalState((state) => received.push(state));
    capturedListener?.('serious');
    expect(received).toEqual(['serious']);
    off();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('marks Android low-RAM devices (e.g. Fire OS sticks) as Multi-View unsupported', () => {
    const port = createMobileThermalDevicePort({
      os: 'android',
      isTV: true,
      getAndroidThermalState: () => 'nominal',
      subscribeAndroidThermalState: () => () => {},
      getAndroidDeviceMemoryInfo: () => ({
        isLowRamDevice: true,
        totalMemBytes: 1 * GIB,
        lowRam: true,
      }),
    });

    expect(port.getMultiViewCapabilities()).toEqual({
      platform: 'android',
      totalMemoryBytes: 1 * GIB,
      isLowRamDevice: true,
      supported: false,
    });
  });

  it('omits Android totalMemoryBytes when native probe reports 0', () => {
    const port = createMobileThermalDevicePort({
      os: 'android',
      isTV: false,
      getAndroidThermalState: () => 'nominal',
      subscribeAndroidThermalState: () => () => {},
      getAndroidDeviceMemoryInfo: () => ({
        isLowRamDevice: false,
        totalMemBytes: 0,
        lowRam: false,
      }),
    });

    expect(port.getMultiViewCapabilities()).toEqual({
      platform: 'android',
      isLowRamDevice: false,
      supported: true,
    });
  });

  it('wires Apple iOS thermal state, subscription, RAM, and model capabilities', () => {
    const unsub = vi.fn();
    let capturedListener:
      | ((state: 'nominal' | 'fair' | 'serious' | 'critical') => void)
      | undefined;
    const port = createMobileThermalDevicePort({
      os: 'ios',
      isTV: false,
      getAppleThermalState: () => 'serious',
      subscribeAppleThermalState: (listener) => {
        capturedListener = listener;
        return unsub;
      },
      getApplePhysicalMemoryBytes: () => 6 * GIB,
      getAppleDeviceModel: () => 'iPhone16,1',
    });

    expect(port.getThermalState()).toBe('serious');
    expect(port.getMultiViewCapabilities()).toEqual({
      platform: 'ios',
      totalMemoryBytes: 6 * GIB,
      deviceModel: 'iPhone16,1',
      supported: true,
    });

    const received: string[] = [];
    const off = port.subscribeThermalState((state) => received.push(state));
    capturedListener?.('critical');
    expect(received).toEqual(['critical']);
    off();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('reports tvos platform and omits null deviceModel / zero RAM on Apple TV when unavailable', () => {
    const port = createMobileThermalDevicePort({
      os: 'ios',
      isTV: true,
      getAppleThermalState: () => 'nominal',
      subscribeAppleThermalState: () => () => {},
      getApplePhysicalMemoryBytes: () => 3 * GIB,
      getAppleDeviceModel: () => 'AppleTV6,2',
    });

    expect(port.getMultiViewCapabilities()).toEqual({
      platform: 'tvos',
      totalMemoryBytes: 3 * GIB,
      deviceModel: 'AppleTV6,2',
      supported: true,
    });

    const unavailable = createMobileThermalDevicePort({
      os: 'ios',
      isTV: true,
      getAppleThermalState: () => 'nominal',
      subscribeAppleThermalState: () => () => {},
      getApplePhysicalMemoryBytes: () => 0,
      getAppleDeviceModel: () => null,
    });

    expect(unavailable.getMultiViewCapabilities()).toEqual({
      platform: 'tvos',
      supported: true,
    });
  });

  it('falls back to nominal thermal state and unsupported Multi-View on unknown platforms', () => {
    const port = createMobileThermalDevicePort({
      os: 'web',
      isTV: false,
    });

    expect(port.getThermalState()).toBe('nominal');
    const listener = vi.fn();
    const off = port.subscribeThermalState(listener);
    expect(() => off()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(port.getMultiViewCapabilities()).toEqual({
      platform: 'android',
      supported: false,
    });
  });
});
