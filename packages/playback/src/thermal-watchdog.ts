/** Normalized OS thermal pressure level (`#232`). */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

/** Policy action recommended by {@link evaluateMultiViewThermalPolicy}. */
export type ThermalPolicyAction = 'allow' | 'warn-block-add' | 'shed-secondary';

/** Hardware capabilities used to resolve the maximum concurrent Multi-View tile cap (`#34`, `#232`). */
export interface MultiViewDeviceCapabilities {
  readonly platform: 'android' | 'ios' | 'tvos' | 'desktop';
  readonly totalMemoryBytes?: number;
  readonly isLowRamDevice?: boolean;
  readonly deviceModel?: string;
  readonly supported?: boolean;
}

/** Evaluated Multi-View hardware and thermal cap state (`#232`). */
export interface MultiViewCapEvaluation {
  readonly hardwareMaxTiles: number;
  readonly effectiveMaxTiles: number;
  readonly multiViewSupported: boolean;
  readonly canAddTile: boolean;
  readonly action: ThermalPolicyAction;
  readonly reason?: 'low-ram' | 'unsupported' | 'thermal-serious' | 'thermal-critical';
}

/** Options for {@link createThermalWatchdog}. */
export interface ThermalWatchdogOptions {
  readonly initialState?: ThermalState;
  readonly onTransition?: (next: ThermalState, previous: ThermalState) => void;
}

/** Pure thermal state tracker that deduplicates identical emissions and isolates listener errors. */
export interface ThermalWatchdog {
  getState(): ThermalState;
  report(rawState: unknown): ThermalState;
  subscribe(listener: (next: ThermalState, previous: ThermalState) => void): () => void;
  reset(): void;
}

const ANDROID_LOW_RAM_BYTES = 1536 * 1024 * 1024;
const MID_TIER_RAM_BYTES = 3584 * 1024 * 1024;
const APPLE_TV_TWO_TILE_MODEL_RE = /^AppleTV[56],/;

/** Normalizes any unknown raw thermal string/value safely to a {@link ThermalState}. */
export function normalizeThermalState(raw: unknown): ThermalState {
  if (typeof raw !== 'string') return 'nominal';
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'nominal' ||
    normalized === 'fair' ||
    normalized === 'serious' ||
    normalized === 'critical'
  ) {
    return normalized;
  }
  return 'nominal';
}

/**
 * Resolves the hardware Multi-View tile cap from device platform, RAM, and model (`#232`).
 * - Unsupported or Android low-RAM (`isLowRamDevice` or `< 1.5 GiB`) -> `1` (disabled)
 * - Mid-tier Android (`< 3.5 GiB`) or AppleTV5/6 or Apple `< 3.5 GiB` -> `2`
 * - High-RAM mobile/TV and Desktop -> `4`
 */
export function resolveHardwareMultiViewCap(caps: MultiViewDeviceCapabilities): number {
  if (caps.supported === false) return 1;

  const mem =
    caps.totalMemoryBytes !== undefined && Number.isFinite(caps.totalMemoryBytes)
      ? caps.totalMemoryBytes
      : undefined;

  if (caps.platform === 'android') {
    if (caps.isLowRamDevice === true) return 1;
    if (mem !== undefined && mem < ANDROID_LOW_RAM_BYTES) return 1;
    if (mem !== undefined && mem < MID_TIER_RAM_BYTES) return 2;
    return 4;
  }

  if (caps.platform === 'ios' || caps.platform === 'tvos') {
    if (caps.deviceModel !== undefined && APPLE_TV_TWO_TILE_MODEL_RE.test(caps.deviceModel)) {
      return 2;
    }
    if (mem !== undefined && mem < MID_TIER_RAM_BYTES) return 2;
    return 4;
  }

  return 4;
}

/**
 * Evaluates the effective Multi-View tile cap and policy action for the current hardware
 * capabilities, thermal state, and active tile count (`#232`).
 */
export function evaluateMultiViewThermalPolicy(
  caps: MultiViewDeviceCapabilities,
  thermalState: ThermalState,
  activeTileCount: number,
): MultiViewCapEvaluation {
  const hardwareMaxTiles = resolveHardwareMultiViewCap(caps);
  const multiViewSupported = hardwareMaxTiles > 1;
  const safeActive = Number.isFinite(activeTileCount)
    ? Math.max(0, Math.floor(activeTileCount))
    : 0;

  if (thermalState === 'critical') {
    return {
      hardwareMaxTiles,
      effectiveMaxTiles: 1,
      multiViewSupported,
      canAddTile: false,
      action: 'shed-secondary',
      reason: 'thermal-critical',
    };
  }

  if (thermalState === 'serious') {
    return {
      hardwareMaxTiles,
      effectiveMaxTiles: Math.max(1, safeActive),
      multiViewSupported,
      canAddTile: false,
      action: 'warn-block-add',
      reason: 'thermal-serious',
    };
  }

  if (!multiViewSupported) {
    return {
      hardwareMaxTiles,
      effectiveMaxTiles: hardwareMaxTiles,
      multiViewSupported: false,
      canAddTile: false,
      action: 'allow',
      reason: caps.supported === false ? 'unsupported' : 'low-ram',
    };
  }

  return {
    hardwareMaxTiles,
    effectiveMaxTiles: hardwareMaxTiles,
    multiViewSupported: true,
    canAddTile: safeActive < hardwareMaxTiles,
    action: 'allow',
  };
}

/** Creates a {@link ThermalWatchdog} that tracks state transitions without duplicate emissions. */
export function createThermalWatchdog(options?: ThermalWatchdogOptions): ThermalWatchdog {
  let state: ThermalState = normalizeThermalState(options?.initialState);
  const listeners = new Set<(next: ThermalState, previous: ThermalState) => void>();

  const emit = (next: ThermalState, previous: ThermalState): void => {
    if (options?.onTransition !== undefined) {
      try {
        options.onTransition(next, previous);
      } catch {
        // Isolate callback errors so state updates remain consistent.
      }
    }
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(next, previous);
      } catch {
        // Isolate subscriber errors.
      }
    }
  };

  return {
    getState() {
      return state;
    },

    report(rawState) {
      const next = normalizeThermalState(rawState);
      if (next === state) return state;
      const previous = state;
      state = next;
      emit(next, previous);
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reset() {
      if (state === 'nominal') return;
      const previous = state;
      state = 'nominal';
      emit('nominal', previous);
    },
  };
}
