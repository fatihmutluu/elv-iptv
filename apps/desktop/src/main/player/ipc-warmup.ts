import type { EngineEvent } from '@elv/playback';
import type { PlayerUiEvent } from '../../shared/player-ipc.ts';
import type { MpvEngine } from './engine.ts';
import {
  type EntrySnapshots,
  recordEntryEventSnapshot,
  recordEntryUiSnapshot,
} from './ipc-handoff.ts';
import type { PowerBlockerTimers } from './ipc-power-blocker.ts';

/** Default idle lifetime (ms) for an unclaimed pre-warmed standby engine before auto-release. */
const DEFAULT_WARMUP_IDLE_TTL_MS = 180_000;

const MAX_BUFFERED_WARMUP_EVENTS = 16;

/** A standby pre-warmed engine owned by one window awaiting its first `player:open` claim. */
export interface StandbyClaim<TOwner> {
  readonly engineId: string;
  readonly snapshots: EntrySnapshots;
  readonly initialFullscreen: boolean;
  readonly bufferedEvents: EngineEvent[];
  readonly waitReady: () => Promise<MpvEngine | undefined>;
  readonly attachUiForwarder: (forward: (ui: PlayerUiEvent) => void) => void;
  readonly detachStandbySubscription: () => void;
  readonly owner: TOwner;
}

interface InternalStandby<TOwner> {
  readonly owner: TOwner;
  readonly engineId: string;
  readonly generation: number;
  readonly snapshots: EntrySnapshots;
  readonly bufferedEvents: EngineEvent[];
  initialFullscreen: boolean;
  engine?: MpvEngine;
  pending?: Promise<MpvEngine | undefined>;
  unsubscribe?: () => void;
  uiForwarder?: (ui: PlayerUiEvent) => void;
  idleTimer?: unknown;
  claimed: boolean;
  discarded: boolean;
}

/** Collaborators for {@link createPlayerWarmUpController}. */
export interface PlayerWarmUpDeps<TOwner extends { readonly id: number; isDestroyed(): boolean }> {
  readonly createEngine: (
    owner: TOwner,
    onUi: (event: PlayerUiEvent) => void,
    engineId: string,
    getMultiViewTileCount: () => number,
  ) => Promise<MpvEngine>;
  readonly nextEngineId: () => string;
  readonly getOwnerGeneration: (ownerId: number) => number;
  readonly hasActiveOrPendingEngine: (ownerId: number) => boolean;
  readonly getMultiViewTileCountForEngine: (engineId: string, fallbackOwnerId: number) => number;
  readonly watchOwner: (owner: TOwner) => void;
  readonly isWindowMinimized?: (owner: TOwner) => boolean;
  readonly isDisposed: () => boolean;
  readonly timers: PowerBlockerTimers;
  readonly idleTtlMs?: number;
}

/** Manages post-paint standby `elv-mpv` warm-up engines keyed by owning window id. */
export interface PlayerWarmUpController<
  TOwner extends { readonly id: number; isDestroyed(): boolean },
> {
  warmUp(owner: TOwner): void;
  take(ownerId: number): StandbyClaim<TOwner> | undefined;
  discardOwner(ownerId: number): void;
  dispose(): void;
}

/**
 * Coordinates at most one idle standby `MpvEngine` per window so first playback skips `elv-mpv`
 * cold spawn latency while guaranteeing bounded idle lifetime and zero leaked processes on quit,
 * navigation, crash, or window close.
 */
export function createPlayerWarmUpController<
  TOwner extends { readonly id: number; isDestroyed(): boolean },
>(deps: PlayerWarmUpDeps<TOwner>): PlayerWarmUpController<TOwner> {
  const idleTtlMs = Math.max(0, deps.idleTtlMs ?? DEFAULT_WARMUP_IDLE_TTL_MS);
  const standbys = new Map<number, InternalStandby<TOwner>>();

  const clearIdleTimer = (st: InternalStandby<TOwner>): void => {
    if (st.idleTimer === undefined) return;
    const handle = st.idleTimer;
    st.idleTimer = undefined;
    deps.timers.clearTimeout(handle);
  };

  const releaseStandby = (st: InternalStandby<TOwner>): void => {
    st.discarded = true;
    clearIdleTimer(st);
    st.unsubscribe?.();
    st.unsubscribe = undefined;
    const eng = st.engine;
    st.engine = undefined;
    eng?.release();
  };

  const discardOwner = (ownerId: number): void => {
    const st = standbys.get(ownerId);
    if (!st) return;
    standbys.delete(ownerId);
    releaseStandby(st);
  };

  return {
    warmUp(owner) {
      if (
        deps.isDisposed() ||
        owner.isDestroyed() ||
        deps.isWindowMinimized?.(owner) === true ||
        deps.hasActiveOrPendingEngine(owner.id) ||
        standbys.has(owner.id)
      ) {
        return;
      }
      deps.watchOwner(owner);
      const engineId = deps.nextEngineId();
      const generation = deps.getOwnerGeneration(owner.id);
      const st: InternalStandby<TOwner> = {
        owner,
        engineId,
        generation,
        snapshots: {},
        bufferedEvents: [],
        initialFullscreen: false,
        claimed: false,
        discarded: false,
      };
      standbys.set(owner.id, st);

      const onUi = (ui: PlayerUiEvent): void => {
        if (st.discarded || deps.isDisposed()) return;
        if (st.uiForwarder) {
          st.uiForwarder(ui);
          return;
        }
        recordEntryUiSnapshot(st.snapshots, ui);
        if (ui.type === 'fullscreen-changed') st.initialFullscreen = ui.fullscreen;
      };

      const getMultiViewTileCount = (): number =>
        deps.getMultiViewTileCountForEngine(engineId, owner.id);

      st.pending = deps
        .createEngine(owner, onUi, engineId, getMultiViewTileCount)
        .then((engine) => {
          const invalidUnclaimed =
            !st.claimed &&
            (standbys.get(owner.id) !== st ||
              deps.getOwnerGeneration(owner.id) !== generation ||
              deps.hasActiveOrPendingEngine(owner.id));
          if (
            st.discarded ||
            deps.isDisposed() ||
            owner.isDestroyed() ||
            invalidUnclaimed ||
            engine.presenterKind !== 'canvas'
          ) {
            if (standbys.get(owner.id) === st) standbys.delete(owner.id);
            engine.release();
            return undefined;
          }
          st.engine = engine;
          if (!st.claimed) {
            st.unsubscribe = engine.subscribe((event) => {
              recordEntryEventSnapshot(st.snapshots, event);
              if (
                event.type === 'surface' &&
                st.bufferedEvents.length < MAX_BUFFERED_WARMUP_EVENTS
              ) {
                st.bufferedEvents.push(event);
              }
            });
            const warmable = engine as MpvEngine & { warmUp?: () => void };
            if (typeof warmable.warmUp === 'function') warmable.warmUp();
            else engine.start();
            st.idleTimer = deps.timers.setTimeout(() => {
              st.idleTimer = undefined;
              if (standbys.get(owner.id) === st && !st.claimed) {
                discardOwner(owner.id);
              }
            }, idleTtlMs);
          }
          return engine;
        })
        .catch(() => {
          if (standbys.get(owner.id) === st) standbys.delete(owner.id);
          return undefined;
        });
    },

    take(ownerId) {
      const st = standbys.get(ownerId);
      if (!st || st.discarded) return undefined;
      standbys.delete(ownerId);
      st.claimed = true;
      clearIdleTimer(st);
      return {
        engineId: st.engineId,
        owner: st.owner,
        get snapshots() {
          return st.snapshots;
        },
        get initialFullscreen() {
          return st.initialFullscreen;
        },
        get bufferedEvents() {
          return st.bufferedEvents;
        },
        waitReady: () =>
          st.engine ? Promise.resolve(st.engine) : (st.pending ?? Promise.resolve(undefined)),
        attachUiForwarder(forward) {
          st.uiForwarder = forward;
        },
        detachStandbySubscription() {
          st.unsubscribe?.();
          st.unsubscribe = undefined;
        },
      };
    },

    discardOwner,

    dispose() {
      for (const ownerId of [...standbys.keys()]) discardOwner(ownerId);
    },
  };
}
