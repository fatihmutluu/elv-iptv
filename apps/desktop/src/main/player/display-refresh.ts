import { type DisplaySyncPolicy, snapStandardFrameRate } from '@elv/playback';

/** One candidate display mode reported by the desktop OS display adapter (`#214`, `#116`). */
export interface DesktopDisplayMode {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly refreshRateHz: number;
  readonly isCurrent?: boolean;
}

/** Platform adapter for querying and switching desktop display refresh modes (`#214`). */
export interface DesktopDisplayRefreshAdapter {
  listModes(displayId: string): readonly DesktopDisplayMode[];
  applyMode(displayId: string, mode: DesktopDisplayMode): boolean;
  restoreMode(displayId: string, mode: DesktopDisplayMode): boolean;
  getCurrentModeId?(displayId: string): string | undefined;
}

/** Fullscreen-scoped desktop AFR display refresh controller with guaranteed restore (`#214`, `#116`). */
export interface DesktopDisplayRefreshController {
  setPolicy(engineId: string, policy: DisplaySyncPolicy): void;
  setFullscreen(engineId: string, fullscreen: boolean, displayId?: string): void;
  setPlaybackActive(engineId: string, active: boolean, displayId?: string): void;
  setContentFps(engineId: string, fps: number | undefined, displayId?: string): void;
  restoreForEngine(engineId: string): void;
  restoreAll(): void;
}

const EXACT_MATCH_TOLERANCE_HZ = 0.15;
const MIN_VALID_FPS = 12;
const MAX_VALID_FPS = 240;
const INTEGER_MULTIPLIERS = [2, 3, 4, 5] as const;
const DEFAULT_DISPLAY_ID = 'primary';

const DEFAULT_POLICY: DisplaySyncPolicy = {
  autoFrameRate: 'off',
  autoDynamicRange: true,
};

const NOOP_ADAPTER: DesktopDisplayRefreshAdapter = {
  listModes: () => [],
  applyMode: () => false,
  restoreMode: () => false,
};

interface EngineRefreshState {
  displayId: string;
  fullscreen: boolean;
  playing: boolean;
  contentFps: number | undefined;
  policy: DisplaySyncPolicy;
}

function isValidMode(mode: DesktopDisplayMode): boolean {
  return (
    mode.width > 0 &&
    mode.height > 0 &&
    Number.isFinite(mode.refreshRateHz) &&
    mode.refreshRateHz > 0
  );
}

/**
 * Selects the best same-resolution desktop display mode for `contentFps`:
 * 1. Exact refresh-rate match (`|hz - fps| <= 0.15`), preferring closest Hz.
 * 2. Integer multiple (`2x..5x`, e.g. `23.976 -> 119.88`, `25 -> 50/100`), preferring closest accuracy then lowest multiplier.
 * Returns `null` when `autoFrameRate === 'off'`, inputs are invalid, no candidate matches, or the current mode is already optimal.
 */
export function selectDesktopRefreshMode(
  modes: readonly DesktopDisplayMode[],
  currentModeId: string,
  contentFps: number,
  policy: DisplaySyncPolicy,
): DesktopDisplayMode | null {
  if (policy.autoFrameRate === 'off') return null;
  if (!Number.isFinite(contentFps) || contentFps < MIN_VALID_FPS || contentFps > MAX_VALID_FPS) {
    return null;
  }
  const targetFps = snapStandardFrameRate(contentFps) ?? contentFps;
  const currentMode = modes.find((m) => m.id === currentModeId && isValidMode(m));
  if (!currentMode) return null;

  const sameResolution = modes.filter(
    (m) => isValidMode(m) && m.width === currentMode.width && m.height === currentMode.height,
  );

  // 1. Exact match (|hz - targetFps| <= 0.15)
  let bestExact: { mode: DesktopDisplayMode; delta: number } | undefined;
  for (const mode of sameResolution) {
    const delta = Math.abs(mode.refreshRateHz - targetFps);
    if (delta > EXACT_MATCH_TOLERANCE_HZ) continue;
    if (
      bestExact === undefined ||
      delta < bestExact.delta - 1e-6 ||
      (Math.abs(delta - bestExact.delta) <= 1e-6 && mode.id === currentMode.id)
    ) {
      bestExact = { mode, delta };
    }
  }
  if (bestExact !== undefined) {
    return bestExact.mode.id === currentMode.id ? null : bestExact.mode;
  }

  // 2. Integer multiple (2x..5x)
  let bestMultiple: { mode: DesktopDisplayMode; normalizedDelta: number; mult: number } | undefined;
  for (const mult of INTEGER_MULTIPLIERS) {
    const targetHz = targetFps * mult;
    for (const mode of sameResolution) {
      const absDelta = Math.abs(mode.refreshRateHz - targetHz);
      if (absDelta > EXACT_MATCH_TOLERANCE_HZ) continue;
      const normalizedDelta = absDelta / mult;
      if (
        bestMultiple === undefined ||
        normalizedDelta < bestMultiple.normalizedDelta - 1e-6 ||
        (Math.abs(normalizedDelta - bestMultiple.normalizedDelta) <= 1e-6 &&
          (mode.id === currentMode.id ||
            (bestMultiple.mode.id !== currentMode.id && mult < bestMultiple.mult)))
      ) {
        bestMultiple = { mode, normalizedDelta, mult };
      }
    }
  }
  if (bestMultiple !== undefined) {
    return bestMultiple.mode.id === currentMode.id ? null : bestMultiple.mode;
  }

  return null;
}

/**
 * Creates a desktop display refresh-rate controller that only modesets during active fullscreen
 * playback, preserves the pre-playback display mode across zaps, and guarantees restoration on
 * playback stop, exiting fullscreen, engine release, window close, and app quit (`#214`, `#116`).
 */
export function createDesktopDisplayRefreshController(
  adapter: DesktopDisplayRefreshAdapter = NOOP_ADAPTER,
): DesktopDisplayRefreshController {
  const engineStates = new Map<string, EngineRefreshState>();
  const originalModes = new Map<string, DesktopDisplayMode>();
  const appliedModes = new Map<string, DesktopDisplayMode>();
  const displayOwners = new Map<string, string>();

  const safeListModes = (displayId: string): readonly DesktopDisplayMode[] => {
    try {
      return adapter.listModes(displayId);
    } catch {
      return [];
    }
  };

  const safeCurrentModeId = (
    displayId: string,
    modes: readonly DesktopDisplayMode[],
  ): string | undefined => {
    try {
      const fromAdapter = adapter.getCurrentModeId?.(displayId);
      if (typeof fromAdapter === 'string' && fromAdapter.length > 0) return fromAdapter;
    } catch {
      // fall through to applied/mode list lookup
    }
    const applied = appliedModes.get(displayId);
    if (applied) return applied.id;
    return modes.find((m) => m.isCurrent)?.id;
  };

  const safeApply = (displayId: string, mode: DesktopDisplayMode): boolean => {
    try {
      return adapter.applyMode(displayId, mode);
    } catch {
      return false;
    }
  };

  const safeRestore = (displayId: string, mode: DesktopDisplayMode): boolean => {
    try {
      return adapter.restoreMode(displayId, mode);
    } catch {
      return false;
    }
  };

  const getOrCreateState = (engineId: string, displayId?: string): EngineRefreshState => {
    let state = engineStates.get(engineId);
    if (!state) {
      state = {
        displayId: displayId ?? DEFAULT_DISPLAY_ID,
        fullscreen: false,
        playing: false,
        contentFps: undefined,
        policy: DEFAULT_POLICY,
      };
      engineStates.set(engineId, state);
      return state;
    }
    if (displayId !== undefined && displayId !== state.displayId) {
      const previousDisplay = state.displayId;
      state.displayId = displayId;
      if (displayOwners.get(previousDisplay) === engineId) {
        restoreDisplay(previousDisplay);
      }
    }
    return state;
  };

  const restoreDisplay = (displayId: string): void => {
    const original = originalModes.get(displayId);
    displayOwners.delete(displayId);
    appliedModes.delete(displayId);
    originalModes.delete(displayId);
    if (original) safeRestore(displayId, original);
  };

  const isEligible = (state: EngineRefreshState): boolean =>
    state.fullscreen &&
    state.playing &&
    state.policy.autoFrameRate !== 'off' &&
    state.contentFps !== undefined;

  const reconcile = (engineId: string): void => {
    const state = engineStates.get(engineId);
    if (!state) return;

    if (!isEligible(state)) {
      if (displayOwners.get(state.displayId) === engineId) {
        restoreDisplay(state.displayId);
      }
      return;
    }

    const { displayId, contentFps, policy } = state;
    if (contentFps === undefined) return;
    const modes = safeListModes(displayId);
    if (modes.length === 0) return;

    const currentModeId = safeCurrentModeId(displayId, modes);
    if (currentModeId === undefined) return;

    const target = selectDesktopRefreshMode(modes, currentModeId, contentFps, policy);
    if (!target) return;

    const existingOriginal = originalModes.get(displayId);
    if (existingOriginal && target.id === existingOriginal.id) {
      restoreDisplay(displayId);
      return;
    }

    if (!existingOriginal) {
      const currentMode = modes.find((m) => m.id === currentModeId);
      if (!currentMode) return;
      originalModes.set(displayId, currentMode);
    }

    if (safeApply(displayId, target)) {
      appliedModes.set(displayId, target);
      displayOwners.set(displayId, engineId);
    } else if (!existingOriginal) {
      originalModes.delete(displayId);
    }
  };

  return {
    setPolicy(engineId, policy) {
      const state = getOrCreateState(engineId);
      state.policy = policy;
      reconcile(engineId);
    },
    setFullscreen(engineId, fullscreen, displayId) {
      const state = getOrCreateState(engineId, displayId);
      state.fullscreen = fullscreen;
      reconcile(engineId);
    },
    setPlaybackActive(engineId, active, displayId) {
      const state = getOrCreateState(engineId, displayId);
      state.playing = active;
      reconcile(engineId);
    },
    setContentFps(engineId, fps, displayId) {
      const state = getOrCreateState(engineId, displayId);
      state.contentFps = fps;
      reconcile(engineId);
    },
    restoreForEngine(engineId) {
      const state = engineStates.get(engineId);
      engineStates.delete(engineId);
      if (state && displayOwners.get(state.displayId) === engineId) {
        restoreDisplay(state.displayId);
      }
    },
    restoreAll() {
      engineStates.clear();
      for (const displayId of [...originalModes.keys()]) {
        restoreDisplay(displayId);
      }
    },
  };
}
