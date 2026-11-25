import type { ThermalDevicePort } from '@elv/features';
import type { MultiViewDeviceCapabilities, ThermalState } from '@elv/playback';

/** Snapshot of Android RAM metadata used for Multi-View admission gating (`#232`). */
interface MobileAndroidMemoryInfo {
  readonly isLowRamDevice: boolean;
  readonly totalMemBytes: number;
  readonly lowRam: boolean;
}

/** Platform probes injected into {@link createMobileThermalDevicePort}. */
export interface MobileThermalDevicePortDeps {
  readonly os: string;
  readonly isTV: boolean;
  readonly getAndroidThermalState?: () => ThermalState;
  readonly subscribeAndroidThermalState?: (listener: (state: ThermalState) => void) => () => void;
  readonly getAndroidDeviceMemoryInfo?: () => MobileAndroidMemoryInfo;
  readonly getAppleThermalState?: () => ThermalState;
  readonly subscribeAppleThermalState?: (listener: (state: ThermalState) => void) => () => void;
  readonly getApplePhysicalMemoryBytes?: () => number;
  readonly getAppleDeviceModel?: () => string | null;
}

const NOOP_UNSUB = (): void => {};

function positiveFiniteBytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Builds the {@link ThermalDevicePort} for `tv-mobile` from Android Media3 and Apple Aether
 * native thermal and memory probes (`#34`, `#232`).
 */
export function createMobileThermalDevicePort(
  deps: MobileThermalDevicePortDeps,
): ThermalDevicePort {
  if (deps.os === 'android') {
    return {
      getThermalState: () => deps.getAndroidThermalState?.() ?? 'nominal',
      subscribeThermalState: (listener) =>
        deps.subscribeAndroidThermalState?.(listener) ?? NOOP_UNSUB,
      getMultiViewCapabilities: (): MultiViewDeviceCapabilities => {
        const mem = deps.getAndroidDeviceMemoryInfo?.();
        if (mem === undefined) {
          return { platform: 'android', supported: false };
        }
        const totalMemoryBytes = positiveFiniteBytes(mem.totalMemBytes);
        return {
          platform: 'android',
          ...(totalMemoryBytes !== undefined ? { totalMemoryBytes } : {}),
          isLowRamDevice: mem.isLowRamDevice,
          supported: !mem.lowRam,
        };
      },
    };
  }

  if (deps.os === 'ios') {
    return {
      getThermalState: () => deps.getAppleThermalState?.() ?? 'nominal',
      subscribeThermalState: (listener) =>
        deps.subscribeAppleThermalState?.(listener) ?? NOOP_UNSUB,
      getMultiViewCapabilities: (): MultiViewDeviceCapabilities => {
        const totalMemoryBytes = positiveFiniteBytes(deps.getApplePhysicalMemoryBytes?.());
        const deviceModel = deps.getAppleDeviceModel?.() ?? null;
        return {
          platform: deps.isTV ? 'tvos' : 'ios',
          ...(totalMemoryBytes !== undefined ? { totalMemoryBytes } : {}),
          ...(deviceModel !== null ? { deviceModel } : {}),
          supported: true,
        };
      },
    };
  }

  return {
    getThermalState: () => 'nominal',
    subscribeThermalState: () => NOOP_UNSUB,
    getMultiViewCapabilities: () => ({ platform: 'android', supported: false }),
  };
}
