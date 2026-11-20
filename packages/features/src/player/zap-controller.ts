import type { PlaybackTimers } from '@elv/playback';
import type { PlayTarget } from '../ports/play-target';

/** Quiet window before a held `CH+`/`CH-` repeat burst tunes the settled channel (`#142`). */
export const ZAP_COALESCE_MS = 450;

/** Live-channel zapping state machine with immediate OSD updates and coalesced repeat tunes. */
export interface ZapController {
  zap(delta: 1 | -1, repeat?: boolean): void;
  sync(index: number): void;
  reset(index: number): void;
  takePendingTune(): boolean;
  dispose(): void;
}

/** Creates a {@link ZapController} bound to the caller's target, timer, OSD, and tune callbacks. */
export function createZapController(params: {
  timers: () => PlaybackTimers;
  current: () => PlayTarget;
  show: (next: PlayTarget, index: number) => void;
  tune: (next: PlayTarget) => void;
}): ZapController {
  let committedIndex = params.current().playlist?.currentIndex ?? 0;
  let pendingIndex: number | undefined;
  let untunedTarget: PlayTarget | undefined;
  let coalesceTimer: unknown;
  let zapSeq = 0;
  let disposed = false;

  const clearCoalesce = (): void => {
    if (coalesceTimer !== undefined) {
      params.timers().clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
    }
  };

  const flushUntuned = (): void => {
    if (coalesceTimer !== undefined || pendingIndex !== undefined || untunedTarget === undefined) {
      return;
    }
    const next = untunedTarget;
    untunedTarget = undefined;
    params.tune(next);
  };

  const armCoalesce = (): void => {
    clearCoalesce();
    coalesceTimer = params.timers().setTimeout(() => {
      coalesceTimer = undefined;
      if (!disposed) flushUntuned();
    }, ZAP_COALESCE_MS);
  };

  return {
    zap(delta, repeat = false) {
      if (disposed) return;
      const current = params.current();
      const playlist = current.playlist;
      if (current.kind !== 'live' || playlist === undefined || playlist.count <= 0) return;

      const base = pendingIndex ?? committedIndex;
      const nextIndex = (((base + delta) % playlist.count) + playlist.count) % playlist.count;
      pendingIndex = nextIndex;
      const seq = ++zapSeq;

      if (repeat || coalesceTimer !== undefined) armCoalesce();

      void playlist.getAt(nextIndex).then(
        (entry) => {
          if (disposed || seq !== zapSeq) return;
          pendingIndex = undefined;
          if (entry === undefined) {
            flushUntuned();
            return;
          }
          committedIndex = nextIndex;
          const nextTarget: PlayTarget = {
            ...entry,
            playlist: { ...playlist, currentIndex: nextIndex },
          };
          params.show(nextTarget, nextIndex);
          playlist.onChangeIndex(nextIndex);
          if (coalesceTimer !== undefined) untunedTarget = nextTarget;
          else {
            untunedTarget = undefined;
            params.tune(nextTarget);
          }
        },
        () => {
          if (disposed || seq !== zapSeq) return;
          pendingIndex = undefined;
          flushUntuned();
        },
      );
    },
    sync(index) {
      committedIndex = index;
    },
    reset(index) {
      zapSeq += 1;
      committedIndex = index;
      pendingIndex = undefined;
      untunedTarget = undefined;
      clearCoalesce();
    },
    takePendingTune() {
      const hadPending = coalesceTimer !== undefined || untunedTarget !== undefined;
      untunedTarget = undefined;
      clearCoalesce();
      return hadPending;
    },
    dispose() {
      disposed = true;
      zapSeq += 1;
      pendingIndex = undefined;
      untunedTarget = undefined;
      clearCoalesce();
    },
  };
}
