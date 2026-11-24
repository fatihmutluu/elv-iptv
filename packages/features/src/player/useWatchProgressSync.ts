import {
  type CatalogService,
  computeResumePositionMs,
  isCompletedProgress,
  MIN_RESUME_POSITION_MS,
  type SaveProgressInput,
  type UserItemKind,
} from '@elv/data';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';

/** Quantized interval (ms) between periodic SQLite watch-progress writes during active VOD playback. */
export const PROGRESS_SAVE_INTERVAL_MS = 10_000;

const MIN_SAVE_DELTA_MS = 1_000;

type FlushMode = 'periodic' | 'immediate' | 'ended';

interface LastSavedSnapshot {
  readonly itemKey: string;
  readonly positionMs: number;
  readonly watched: boolean;
}

/** Catalog slice required by `PlayerScreen` and {@link useWatchProgressSync}. */
type WatchProgressCatalog = Pick<CatalogService, 'resolveStream' | 'getProgress' | 'saveProgress'>;

/** Parameters of {@link useWatchProgressSync}. */
export interface WatchProgressSyncParams {
  activeTarget: PlayTarget;
  status: PlaybackStatus;
  serviceRef: MutableRefObject<PlaybackService | null>;
  catalogRef: MutableRefObject<WatchProgressCatalog>;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
}

/** Return handle of {@link useWatchProgressSync}. */
export interface WatchProgressSyncHandle {
  /** Flushes active VOD progress immediately, optionally overriding the saved position (e.g. after seek). */
  readonly flushProgress: (overridePosMs?: number) => void;
  /** Marks the current VOD item as completed (`watched: true`) immediately (e.g. gapless auto-advance, `#205`). */
  readonly flushEndedProgress: () => void;
}

function resolveProgressKind(entry: PlayableEntry): UserItemKind {
  if (entry.itemKind !== undefined) return entry.itemKind;
  if (entry.seriesKey != null || entry.season != null || entry.episode != null) {
    return 'episode';
  }
  return 'movie';
}

/**
 * Resolves the initial VOD start position (ms) using explicit `target.startPositionMs` when present,
 * or smart 5-second rewind resume via `catalog.getProgress`. Returns synchronously whenever
 * `target.kind !== 'vod'`, `startPositionMs` is explicit, or `getProgress` is absent.
 */
export function resolveVodStartPositionMs(
  target: PlayableEntry,
  catalog: Pick<CatalogService, 'getProgress'>,
): number | undefined | Promise<number | undefined> {
  if (target.kind !== 'vod' || target.catchup !== undefined) return undefined;
  if (target.startPositionMs !== undefined) {
    return Number.isFinite(target.startPositionMs)
      ? Math.max(0, Math.round(target.startPositionMs))
      : undefined;
  }
  const getProgress = catalog.getProgress;
  if (getProgress === undefined) return undefined;
  try {
    return getProgress(target.itemKey).then(
      (row) => {
        if (row === null) return undefined;
        const resumeMs = computeResumePositionMs(row);
        return resumeMs > 0 ? resumeMs : undefined;
      },
      () => undefined,
    );
  } catch {
    return undefined;
  }
}

/**
 * Synchronizes VOD watch progress to SQLite on a quantized 10-second cadence while playing,
 * plus immediate flushes on pause, ended, seek, background, target switch, and unmount (`#14`).
 */
export function useWatchProgressSync({
  activeTarget,
  status,
  serviceRef,
  catalogRef,
  clockRef,
  timersRef,
}: WatchProgressSyncParams): WatchProgressSyncHandle {
  const targetRef = useRef<PlayableEntry>(activeTarget);
  targetRef.current = activeTarget;
  const lastSavedRef = useRef<LastSavedSnapshot | null>(null);

  const persistSnapshot = useCallback(
    (entry: PlayableEntry, positionMs: number, durationMs: number, mode: FlushMode): void => {
      if (entry.kind !== 'vod' || entry.catchup !== undefined) return;
      const saveProgress = catalogRef.current.saveProgress;
      if (saveProgress === undefined) return;

      const sourceId = entry.sourceId;
      const itemKey = entry.itemKey;
      const title = entry.title;
      const subtitle = entry.subtitle ?? null;
      const logo = entry.logo ?? null;
      const seriesKey = entry.seriesKey ?? null;
      const season = entry.season ?? null;
      const episode = entry.episode ?? null;
      const kind = resolveProgressKind(entry);

      const pos = Number.isFinite(positionMs) ? Math.max(0, Math.round(positionMs)) : 0;
      const dur = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
      if (mode !== 'ended' && pos < MIN_RESUME_POSITION_MS) return;

      const effectiveWatched = mode === 'ended' ? true : isCompletedProgress(pos, dur);
      const last = lastSavedRef.current;
      if (last !== null && last.itemKey === itemKey) {
        if (mode === 'periodic') {
          if (
            Math.abs(pos - last.positionMs) < MIN_SAVE_DELTA_MS &&
            last.watched === effectiveWatched
          ) {
            return;
          }
        } else if (pos === last.positionMs && last.watched === effectiveWatched) {
          return;
        }
      }

      lastSavedRef.current = { itemKey, positionMs: pos, watched: effectiveWatched };
      const payload: SaveProgressInput = {
        sourceId,
        itemKey,
        kind,
        title,
        subtitle,
        logo,
        seriesKey,
        season,
        episode,
        positionMs: pos,
        durationMs: dur,
        ...(mode === 'ended' ? { watched: true } : {}),
      };
      try {
        void Promise.resolve(saveProgress(payload)).catch(() => undefined);
      } catch {
        // Isolate synchronous throws from persistence ports so playback never stalls.
      }
    },
    [catalogRef],
  );

  const flush = useCallback(
    (mode: FlushMode, overridePosMs?: number, expectedItemKey?: string): void => {
      const entry = targetRef.current;
      if (entry.kind !== 'vod' || entry.catchup !== undefined) return;
      if (expectedItemKey !== undefined && entry.itemKey !== expectedItemKey) return;
      if (catalogRef.current.saveProgress === undefined) return;
      const svc = serviceRef.current;
      if (svc === null) return;
      const state = svc.getState();
      if (state.item !== undefined && state.item !== entry.itemKey) return;

      const anchor = state.anchor;
      const durationMs =
        anchor?.durationMs !== undefined && Number.isFinite(anchor.durationMs)
          ? Math.max(0, Math.round(anchor.durationMs))
          : 0;

      if (mode === 'ended' || (overridePosMs === undefined && state.status.kind === 'ended')) {
        const lastPos =
          anchor !== undefined
            ? Math.max(0, Math.round(positionAt(anchor, clockRef.current.now())))
            : 0;
        persistSnapshot(entry, durationMs > 0 ? durationMs : lastPos, durationMs, 'ended');
        return;
      }

      if (overridePosMs !== undefined) {
        if (!Number.isFinite(overridePosMs)) return;
        persistSnapshot(entry, overridePosMs, durationMs, 'immediate');
        return;
      }

      if (anchor === undefined) return;
      const pos = positionAt(anchor, clockRef.current.now());
      persistSnapshot(entry, pos, durationMs, mode);
    },
    [catalogRef, clockRef, persistSnapshot, serviceRef],
  );

  const flushProgress = useCallback(
    (overridePosMs?: number): void => {
      flush('immediate', overridePosMs);
    },
    [flush],
  );

  const flushEndedProgress = useCallback((): void => {
    const entry = targetRef.current;
    if (entry.kind !== 'vod' || entry.catchup !== undefined) return;
    if (catalogRef.current.saveProgress === undefined) return;
    const svc = serviceRef.current;
    const anchor = svc?.getState().anchor;
    const durationMs =
      anchor?.durationMs !== undefined && Number.isFinite(anchor.durationMs)
        ? Math.max(0, Math.round(anchor.durationMs))
        : 0;
    const lastPos =
      anchor !== undefined
        ? Math.max(0, Math.round(positionAt(anchor, clockRef.current.now())))
        : 0;
    persistSnapshot(entry, durationMs > 0 ? durationMs : lastPos, durationMs, 'ended');
  }, [catalogRef, clockRef, persistSnapshot, serviceRef]);

  const prevStatusRef = useRef<PlaybackStatus['kind']>(status.kind);
  const prevItemKeyRef = useRef<string>(activeTarget.itemKey);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevKey = prevItemKeyRef.current;
    prevStatusRef.current = status.kind;
    prevItemKeyRef.current = activeTarget.itemKey;

    if (activeTarget.kind !== 'vod' || activeTarget.catchup !== undefined) return;
    if (prevStatus === status.kind && prevKey === activeTarget.itemKey) return;

    if (status.kind === 'paused') {
      flush('immediate', undefined, activeTarget.itemKey);
    } else if (status.kind === 'ended') {
      flush('ended', undefined, activeTarget.itemKey);
    }
  }, [activeTarget.catchup, activeTarget.itemKey, activeTarget.kind, flush, status.kind]);

  useEffect(() => {
    if (
      activeTarget.kind !== 'vod' ||
      activeTarget.catchup !== undefined ||
      status.kind !== 'playing' ||
      catalogRef.current.saveProgress === undefined
    ) {
      return;
    }

    const capturedKey = activeTarget.itemKey;
    let cancelled = false;
    let timerHandle: unknown;

    const scheduleNext = (): void => {
      if (cancelled) return;
      timerHandle = timersRef.current.setTimeout(() => {
        timerHandle = undefined;
        if (cancelled) return;
        flush('periodic', undefined, capturedKey);
        scheduleNext();
      }, PROGRESS_SAVE_INTERVAL_MS);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerHandle !== undefined) {
        timersRef.current.clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    };
  }, [
    activeTarget.catchup,
    activeTarget.itemKey,
    activeTarget.kind,
    catalogRef,
    flush,
    status.kind,
    timersRef,
  ]);

  useEffect(() => {
    return () => {
      flush('immediate');
    };
  }, [flush]);

  return { flushProgress, flushEndedProgress };
}
