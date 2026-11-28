import type { PowerBlocker } from './power-blocker.ts';

/** Default grace period (ms) before releasing `powerBlocker` during a continuous `'buffering'` stall. */
export const DEFAULT_BUFFERING_RELEASE_MS = 30_000;

/** Default grace period (ms) before releasing `powerBlocker` if a `'playing'` engine's clock stops advancing. */
export const DEFAULT_FROZEN_CLOCK_RELEASE_MS = 60_000;

/** Minimal timer primitives used by {@link createPlayerPowerBlockerController}. */
export interface PowerBlockerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Collaborators for {@link createPlayerPowerBlockerController}. */
export interface PlayerPowerBlockerDeps<TOwner extends { readonly id: number }> {
  readonly powerBlocker?: PowerBlocker;
  readonly bufferingReleaseMs?: number;
  readonly frozenClockReleaseMs?: number;
  readonly timers: PowerBlockerTimers;
  readonly isWindowMinimized?: (owner: TOwner) => boolean;
  readonly onWindowVisibilityChange?: (
    owner: TOwner,
    listener: (minimized: boolean) => void,
  ) => () => void;
}

/** Per-engine `powerSaveBlocker` watchdog managing buffering stalls, 60s frozen clocks, and minimized windows. */
export interface PlayerPowerBlockerController<TOwner extends { readonly id: number }> {
  registerEngine(engineId: string, owner: TOwner): void;
  setParked(engineId: string, parked: boolean): void;
  setOwner(engineId: string, nextOwner: TOwner): void;
  onState(engineId: string, state: string): void;
  onClock(engineId: string, positionMs: number): void;
  release(engineId: string): void;
  unregisterEngine(engineId: string): void;
  unwatchOwner(ownerId: number): void;
  dispose(): void;
}

interface EnginePowerState<TOwner> {
  owner: TOwner;
  parked: boolean;
  playing: boolean;
  frozen: boolean;
  lastPositionMs: number | undefined;
  bufferingTimer: unknown;
  frozenTimer: unknown;
}

/**
 * Manages display-sleep locks (`powerBlocker`) across registered player engines:
 * - Acquires on `'playing'` only when the owning window is visible (not minimized/hidden).
 * - Preserves the 30 s `'buffering'` stall grace release.
 * - Releases after 60 s (`frozenClockReleaseMs`) if a `'playing'` engine's clock does not advance by `>= 1 ms`,
 *   and re-acquires automatically when clock progress resumes.
 * - Releases immediately when the owning window minimizes/hides (without affecting engines attached to a
 *   visible Popout window) and re-acquires on restore when still playing and unfrozen.
 */
export function createPlayerPowerBlockerController<TOwner extends { readonly id: number }>(
  deps: PlayerPowerBlockerDeps<TOwner>,
): PlayerPowerBlockerController<TOwner> {
  const { powerBlocker, timers } = deps;
  const bufferingReleaseMs = Math.max(0, deps.bufferingReleaseMs ?? DEFAULT_BUFFERING_RELEASE_MS);
  const frozenClockReleaseMs = Math.max(
    0,
    deps.frozenClockReleaseMs ?? DEFAULT_FROZEN_CLOCK_RELEASE_MS,
  );
  const states = new Map<string, EnginePowerState<TOwner>>();
  const visibilityUnsubs = new Map<number, () => void>();
  const ownerMinimizedOverride = new Map<number, boolean>();

  const isMinimized = (owner: TOwner): boolean => {
    const known = ownerMinimizedOverride.get(owner.id);
    if (known !== undefined) return known;
    return deps.isWindowMinimized?.(owner) === true;
  };

  const clearBufferingTimer = (st: EnginePowerState<TOwner>): void => {
    const handle = st.bufferingTimer;
    if (handle === undefined) return;
    st.bufferingTimer = undefined;
    timers.clearTimeout(handle);
  };

  const clearFrozenTimer = (st: EnginePowerState<TOwner>): void => {
    const handle = st.frozenTimer;
    if (handle === undefined) return;
    st.frozenTimer = undefined;
    timers.clearTimeout(handle);
  };

  const armFrozenTimer = (engineId: string, st: EnginePowerState<TOwner>): void => {
    if (!powerBlocker) return;
    clearFrozenTimer(st);
    st.frozenTimer = timers.setTimeout(() => {
      st.frozenTimer = undefined;
      if (!st.playing) return;
      st.frozen = true;
      powerBlocker.release(engineId);
    }, frozenClockReleaseMs);
  };

  const armBufferingTimer = (engineId: string, st: EnginePowerState<TOwner>): void => {
    if (!powerBlocker) return;
    clearFrozenTimer(st);
    if (st.bufferingTimer !== undefined || isMinimized(st.owner)) return;
    st.bufferingTimer = timers.setTimeout(() => {
      st.bufferingTimer = undefined;
      powerBlocker.release(engineId);
    }, bufferingReleaseMs);
  };

  const handleOwnerVisibility = (ownerId: number, minimized: boolean): void => {
    ownerMinimizedOverride.set(ownerId, minimized);
    if (!powerBlocker) return;
    for (const [engineId, st] of states) {
      if (st.parked || st.owner.id !== ownerId) continue;
      if (minimized) {
        clearBufferingTimer(st);
        clearFrozenTimer(st);
        powerBlocker.release(engineId);
      } else if (st.playing && !st.frozen) {
        powerBlocker.acquire(engineId);
        armFrozenTimer(engineId, st);
      }
    }
  };

  const watchOwner = (owner: TOwner): void => {
    if (!powerBlocker || !deps.onWindowVisibilityChange || visibilityUnsubs.has(owner.id)) return;
    const unsub = deps.onWindowVisibilityChange(owner, (minimized) =>
      handleOwnerVisibility(owner.id, minimized),
    );
    visibilityUnsubs.set(owner.id, unsub);
  };

  const releaseEngine = (engineId: string): void => {
    const st = states.get(engineId);
    if (st) {
      clearBufferingTimer(st);
      clearFrozenTimer(st);
      st.playing = false;
      st.frozen = false;
      st.lastPositionMs = undefined;
    }
    powerBlocker?.release(engineId);
  };

  return {
    registerEngine(engineId, owner) {
      watchOwner(owner);
      states.set(engineId, {
        owner,
        parked: false,
        playing: false,
        frozen: false,
        lastPositionMs: undefined,
        bufferingTimer: undefined,
        frozenTimer: undefined,
      });
    },

    setParked(engineId, parked) {
      const st = states.get(engineId);
      if (st) st.parked = parked;
    },

    setOwner(engineId, nextOwner) {
      const st = states.get(engineId);
      if (!st) return;
      st.owner = nextOwner;
      st.parked = false;
      watchOwner(nextOwner);
      if (!powerBlocker) return;
      if (isMinimized(nextOwner)) {
        clearBufferingTimer(st);
        clearFrozenTimer(st);
        powerBlocker.release(engineId);
      } else if (st.playing && !st.frozen) {
        powerBlocker.acquire(engineId);
        armFrozenTimer(engineId, st);
      }
    },

    onState(engineId, state) {
      const st = states.get(engineId);
      if (!st) return;
      if (state === 'playing') {
        clearBufferingTimer(st);
        const wasPlaying = st.playing;
        st.playing = true;
        if (!wasPlaying) {
          st.frozen = false;
          st.lastPositionMs = undefined;
        }
        if (!st.frozen && !st.parked && !isMinimized(st.owner)) {
          powerBlocker?.acquire(engineId);
          if (!wasPlaying || st.frozenTimer === undefined) {
            armFrozenTimer(engineId, st);
          }
        }
      } else if (state === 'buffering') {
        st.playing = false;
        armBufferingTimer(engineId, st);
      } else {
        releaseEngine(engineId);
      }
    },

    onClock(engineId, positionMs) {
      const st = states.get(engineId);
      if (!st?.playing || !Number.isFinite(positionMs)) return;
      const advanced =
        st.lastPositionMs === undefined || Math.abs(positionMs - st.lastPositionMs) >= 1;
      if (!advanced) return;
      st.lastPositionMs = positionMs;
      const wasFrozen = st.frozen;
      st.frozen = false;
      if (st.parked || isMinimized(st.owner)) return;
      if (wasFrozen) powerBlocker?.acquire(engineId);
      armFrozenTimer(engineId, st);
    },

    release: releaseEngine,

    unregisterEngine(engineId) {
      releaseEngine(engineId);
      states.delete(engineId);
    },

    unwatchOwner(ownerId) {
      const unsub = visibilityUnsubs.get(ownerId);
      if (unsub) {
        visibilityUnsubs.delete(ownerId);
        try {
          unsub();
        } catch {
          // best-effort listener cleanup
        }
      }
      ownerMinimizedOverride.delete(ownerId);
    },

    dispose() {
      for (const unsub of visibilityUnsubs.values()) {
        try {
          unsub();
        } catch {
          // best-effort listener cleanup
        }
      }
      visibilityUnsubs.clear();
      ownerMinimizedOverride.clear();
      for (const st of states.values()) {
        clearBufferingTimer(st);
        clearFrozenTimer(st);
      }
      states.clear();
      powerBlocker?.releaseAll();
    },
  };
}
