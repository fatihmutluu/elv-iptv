import type { EngineEvent, MediaKind } from '@elv/playback';
import { classifyEnd, type MpvLogLine } from './errors.ts';

/** Per-media playback timing fields preserved across property updates until start/end reset. */
export interface MediaTimingState {
  lastPositionMs?: number;
  lastDurationMs?: number;
  hasPlaybackTime: boolean;
}

/**
 * Updates cached position/duration from mpv `property-change` notifications without wiping a
 * previously known `lastDurationMs` when mpv clears `duration` to unavailable right before EOF.
 */
export function updateMediaTimingFromProperty(
  state: MediaTimingState,
  name: string,
  data: unknown,
): void {
  if (name === 'duration') {
    if (typeof data === 'number' && Number.isFinite(data) && data > 0) {
      state.lastDurationMs = Math.round(data * 1000);
    }
    return;
  }
  if (name === 'playback-time' && typeof data === 'number' && Number.isFinite(data)) {
    state.hasPlaybackTime = true;
    state.lastPositionMs = Math.max(0, Math.round(data * 1000));
    return;
  }
  if (
    name === 'time-pos' &&
    !state.hasPlaybackTime &&
    typeof data === 'number' &&
    Number.isFinite(data)
  ) {
    state.lastPositionMs = Math.max(0, Math.round(data * 1000));
  }
}

/** Reclassifies a played VOD `eof` that occurred well before `durationMs` into a terminal error. */
export function reclassifyPrematureVodEof(
  rawEvents: readonly EngineEvent[],
  params: {
    readonly mediaKind: MediaKind;
    readonly reason: unknown;
    readonly logs: readonly MpvLogLine[];
    readonly positionMs?: number;
    readonly durationMs?: number;
  },
): { readonly events: readonly EngineEvent[]; readonly prematureVodEof: boolean } {
  if (
    params.mediaKind !== 'vod' ||
    params.reason !== 'eof' ||
    !rawEvents.some((ev) => ev.type === 'state' && ev.state === 'ended')
  ) {
    return { events: rawEvents, prematureVodEof: false };
  }
  const outcome = classifyEnd({
    reason: 'eof',
    logs: params.logs,
    mediaKind: 'vod',
    played: true,
    ...(params.positionMs === undefined ? {} : { positionMs: params.positionMs }),
    ...(params.durationMs === undefined ? {} : { durationMs: params.durationMs }),
  });
  if (outcome.kind !== 'error') {
    return { events: rawEvents, prematureVodEof: false };
  }
  return {
    prematureVodEof: true,
    events: rawEvents.map((ev) =>
      ev.type === 'state' && ev.state === 'ended'
        ? { attempt: ev.attempt, type: 'error', error: outcome.error }
        : ev,
    ),
  };
}
