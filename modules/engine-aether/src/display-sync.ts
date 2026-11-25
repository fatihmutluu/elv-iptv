import type { DisplaySyncPolicy, NativeEngineHandle, NativeLoadCommand } from '@elv/playback';

/** Auto frame-rate matching policy mode forwarded to Apple AetherEngine / tvOS (`#188`, `#116`). */
export type AppleAutoFrameRateMode = DisplaySyncPolicy['autoFrameRate'];

/** Display refresh-rate and HDR dynamic-range sync policy forwarded to Apple AetherEngine (`#188`, `#116`). */
export type AppleDisplaySyncPolicy = DisplaySyncPolicy;

/** Native `ElvEngineAether.Engine` handle shape whose `setDisplaySync` takes flattened `(mode, hdr)` args. */
export interface AetherNativeDisplaySyncHandle extends Omit<NativeEngineHandle, 'setDisplaySync'> {
  setDisplaySync?(autoFrameRate: AppleAutoFrameRateMode, autoDynamicRange: boolean): void;
}

function normalizeAutoFrameRateMode(raw: unknown): AppleAutoFrameRateMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'seamless' || normalized === 'always') {
    return normalized;
  }
  return undefined;
}

/** Validates and normalizes a display-sync policy object, returning `undefined` when absent or malformed. */
function normalizeAppleDisplaySyncPolicy(raw: unknown): AppleDisplaySyncPolicy | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as { autoFrameRate?: unknown; autoDynamicRange?: unknown };
  const autoFrameRate = normalizeAutoFrameRateMode(candidate.autoFrameRate);
  const autoDynamicRange =
    typeof candidate.autoDynamicRange === 'boolean' ? candidate.autoDynamicRange : undefined;
  if (autoFrameRate === undefined && autoDynamicRange === undefined) return undefined;
  return {
    autoFrameRate: autoFrameRate ?? 'seamless',
    autoDynamicRange: autoDynamicRange ?? true,
  };
}

/**
 * Adapts a native `ElvEngineAether.Engine` JSI `SharedObject` for `@elv/playback`'s `bridgeNativeEngine`:
 * flattens `load.displaySync` into `(autoFrameRate, autoDynamicRange)` and translates `setDisplaySync(policy)`
 * into `(autoFrameRate, autoDynamicRange)` while preserving JSI prototype method binding.
 */
export function createDisplaySyncBridgeAdapter<T extends AetherNativeDisplaySyncHandle>(
  native: T,
): NativeEngineHandle {
  return new Proxy(native as unknown as NativeEngineHandle, {
    get(_target, prop) {
      if (prop === 'load') {
        return (nativeCmd: NativeLoadCommand) => {
          const { displaySync, ...rest } = nativeCmd;
          const normalized = normalizeAppleDisplaySyncPolicy(displaySync);
          if (normalized === undefined) {
            native.load(rest);
            return;
          }
          native.load({
            ...rest,
            autoFrameRate: normalized.autoFrameRate,
            autoDynamicRange: normalized.autoDynamicRange,
          } as NativeLoadCommand);
        };
      }
      if (prop === 'setDisplaySync') {
        const setDisplaySync = native.setDisplaySync;
        if (typeof setDisplaySync !== 'function') return undefined;
        return (policy: DisplaySyncPolicy) => {
          const normalized = normalizeAppleDisplaySyncPolicy(policy);
          if (normalized === undefined) return;
          setDisplaySync.call(native, normalized.autoFrameRate, normalized.autoDynamicRange);
        };
      }
      const value = Reflect.get(native, prop, native);
      return typeof value === 'function' ? value.bind(native) : value;
    },
  });
}
