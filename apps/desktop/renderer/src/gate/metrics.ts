import type { EngineErrorCode, PlaybackState } from '@elv/playback';
import type { GateFault } from './params.ts';

/** How a fault run ended on the faulted channel. */
type FaultOutcome = 'recovered' | 'failed-in-time' | 'limited-backoff' | 'missed';

/** The VOD part's outcome: it played, and playing resumed at the seek target. */
export interface VodResult {
  playing: boolean;
  seeked: boolean;
}

/** What the renderer adds to the single `ELV_GATE_PLAYER` line (main adds spawns, load mode and picture checks). Times are milliseconds rounded to 0.01; `null`: nothing measured. */
export interface PlayerMetrics {
  /** First tune to its first frame. */
  ttffColdMs: number | null;
  /** Tune to first frame of every later tune. */
  ttffWarmMs: { p50: number | null; p95: number | null };
  /** Zap dispatch (before the URL resolves) to the new channel's first frame. */
  zapMs: { p50: number | null; p95: number | null; max: number | null };
  /** Surface `created` events seen by the screen. */
  surfaceCreated: number;
  /** State notifications that showed another channel than the last one asked for, or an older attempt. */
  staleEventsApplied: number;
  /** Stale engine events the service discarded. */
  staleEventsDropped: number;
  /** Tunes that ended in `failed`. */
  failures: number;
  /** Entries into each recovery rung. */
  recoveries: { '1': number; '2': number; '3': number; '4': number };
  /** `engine-wedged` errors the engine reported; a zap away from a stalled stream must not cause one. */
  engineWedged: number;
  fault: GateFault;
  /** The first dwell on the faulted channel; `null` for a run without a fault. */
  faultOutcome: FaultOutcome | null;
  /** Zaps dispatched. */
  zaps: number;
  /** The VOD part; `null` when the run has none. */
  vod: VodResult | null;
}

/** Records the gate's spans and counters from the playback service's states. */
export interface PlayerRecorder {
  /**
   * Notes that the next tune is of `item`; a `zapAt` stamp (service clock) makes it a zap. Call it before
   * `service.tune`, whose synchronous state notification starts the tune's record.
   */
  dispatch(item: string, zapAt?: number): void;
  observe(state: PlaybackState): void;
  surface(change: 'created' | 'destroyed'): void;
  /** Notes an error the engine reported, before the service reacts to it. */
  engineError(code: EngineErrorCode): void;
  /** The line's metrics; `final` is the service state at the end of the live part, `vod` the VOD part's outcome. */
  finish(final: PlaybackState, vod?: VodResult): PlayerMetrics;
}

interface Tune {
  item: string;
  index: number;
  zapAt: number | undefined;
  closed: boolean;
  failed: boolean;
  isDwell: boolean;
  sawRecovering: boolean;
  recovered: boolean;
  sawLimited: boolean;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return round(sorted[rank - 1] ?? 0);
}

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** Creates a recorder for a run with `fault` injected into `faultItem` (`channels[0]`). */
export function createPlayerRecorder(opts: {
  fault: GateFault;
  faultItem: string;
}): PlayerRecorder {
  let expected: string | undefined;
  let pendingZap: number | undefined;
  let awaiting = false;
  let zaps = 0;
  let tunes = 0;
  let current: Tune | undefined;
  let cold: number | null = null;
  const warm: number[] = [];
  const zapSpans: number[] = [];
  let surfaceCreated = 0;
  let stale = 0;
  let highestAttempt = 0;
  let failures = 0;
  let wedged = 0;
  const recoveries = { '1': 0, '2': 0, '3': 0, '4': 0 };
  let previous: PlaybackState['status'] | undefined;
  let dwellDone = false;
  let outcome: FaultOutcome | null = null;

  const endDwell = (): void => {
    if (current === undefined || !current.isDwell) return;
    dwellDone = true;
    if (current.sawLimited) outcome = 'limited-backoff';
    else if (current.failed) outcome = 'failed-in-time';
    else if (current.recovered) outcome = 'recovered';
    else outcome = 'missed';
  };

  const startTune = (state: PlaybackState): void => {
    endDwell();
    tunes += 1;
    const item = state.item ?? '';
    current = {
      item,
      index: tunes,
      zapAt: pendingZap,
      closed: false,
      failed: false,
      isDwell: opts.fault !== '' && !dwellDone && item === opts.faultItem,
      sawRecovering: false,
      recovered: false,
      sawLimited: false,
    };
    pendingZap = undefined;
    awaiting = false;
    previous = undefined;
  };

  const trackStatus = (tune: Tune, status: PlaybackState['status']): void => {
    if (status.kind === 'recovering') {
      tune.sawRecovering = true;
      if (previous?.kind !== 'recovering' || previous.rung !== status.rung) {
        recoveries[String(status.rung) as keyof typeof recoveries] += 1;
      }
    } else if (status.kind === 'playing' && tune.sawRecovering) tune.recovered = true;
    else if (status.kind === 'limited') tune.sawLimited = true;
    else if (status.kind === 'failed' && !tune.failed) {
      tune.failed = true;
      failures += 1;
    }
    previous = status;
  };

  const closeSpan = (tune: Tune, state: PlaybackState): void => {
    if (tune.closed || state.firstFrameAt === undefined || state.tuneAt === undefined) return;
    tune.closed = true;
    const ttff = state.firstFrameAt - state.tuneAt;
    if (tune.index === 1) cold = round(ttff);
    else warm.push(ttff);
    if (tune.zapAt !== undefined) zapSpans.push(state.firstFrameAt - tune.zapAt);
  };

  return {
    dispatch(item, zapAt) {
      expected = item;
      awaiting = true;
      pendingZap = zapAt;
      if (zapAt !== undefined) zaps += 1;
    },
    observe(state) {
      if (expected === undefined) return;
      if (state.attempt < highestAttempt || state.item !== expected) stale += 1;
      highestAttempt = Math.max(highestAttempt, state.attempt);
      if (awaiting && state.tuneAt !== undefined) startTune(state);
      if (current === undefined) return;
      trackStatus(current, state.status);
      closeSpan(current, state);
    },
    surface(change) {
      if (change === 'created') surfaceCreated += 1;
    },
    engineError(code) {
      if (code === 'engine-wedged') wedged += 1;
    },
    finish(final, vod) {
      endDwell();
      const warmSorted = ascending(warm);
      const zapSorted = ascending(zapSpans);
      return {
        ttffColdMs: cold,
        ttffWarmMs: { p50: nearestRank(warmSorted, 0.5), p95: nearestRank(warmSorted, 0.95) },
        zapMs: {
          p50: nearestRank(zapSorted, 0.5),
          p95: nearestRank(zapSorted, 0.95),
          max: nearestRank(zapSorted, 1),
        },
        surfaceCreated,
        staleEventsApplied: stale,
        staleEventsDropped: final.staleEventsDropped,
        failures,
        engineWedged: wedged,
        recoveries: { ...recoveries },
        fault: opts.fault,
        faultOutcome: opts.fault === '' ? null : (outcome ?? 'missed'),
        zaps,
        vod: vod ?? null,
      };
    },
  };
}

/** The console line the gate runner parses. */
export function playerLine(metrics: PlayerMetrics): string {
  return `ELV_GATE_PLAYER ${JSON.stringify(metrics)}`;
}
