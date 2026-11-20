import { type ClockAnchor, type PlaybackState, positionAt } from '@elv/playback';
import type { PlayerFault } from './player-routes';

/**
 * How a fault run ended on the faulted channel; `left`: a zap went away before the faulted channel played (the
 * expected outcome of a slow start).
 */
type FaultOutcome = 'recovered' | 'failed-in-time' | 'limited-backoff' | 'left' | 'missed';

type PlayerFinal = 'playing' | 'failed' | 'limited' | 'other';

interface SoakMetrics {
  /** The run's soak minutes. */
  minutes: number;
  /** First frame to the line; 0 without a frame. */
  playedMs: number;
  /** Position at the line minus the position at the first frame (from the first anchor after it); 0 without one. */
  positionAdvancedMs: number;
  /** Engine stall starts of the current attempt after the first frame. */
  stalls: number;
  /** Longest of those stalls, start to end; one still open counts until the line. */
  longestStallMs: number;
  /** The service reached `ended`. */
  ended: boolean;
  /** Duration of the last anchor; `null` when it had none. */
  durationMs: number | null;
}

/** What the single `ELV_GATE_PLAYER` line carries. Times are milliseconds rounded to 0.01; `null`: nothing measured. */
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
  fault: PlayerFault;
  /** The first dwell on the faulted channel; `null` for a run without a fault. */
  faultOutcome: FaultOutcome | null;
  /** Tune start to the first `limited` status on the faulted channel's first dwell; `null` otherwise. */
  limitedAfterMs: number | null;
  /** Zaps dispatched. */
  zaps: number;
  /** The service status kind when the line is printed. */
  final: PlayerFinal;
  /** Soak measurements; `null` in a normal run. */
  soak: SoakMetrics | null;
}

/** Records the gate's spans and counters from the playback service's states. */
export interface PlayerRecorder {
  /**
   * Notes that the next tune is of `item`; a `zapAt` stamp (service clock) makes it a zap. Call it before
   * `service.tune`, whose synchronous state notification starts the tune's record.
   */
  dispatch(item: string, zapAt?: number): void;
  observe(state: PlaybackState): void;
  /**
   * An engine stall of the current attempt. One that ends while the service still shows `playing` is a recovery the
   * engine made on its own (ladder rung 0, for example its own reconnect after a dropped connection).
   */
  stall(phase: 'start' | 'end'): void;
  surface(change: 'created' | 'destroyed'): void;
  /** The line's metrics; `final` is the service state at the end of the run, the print time is `now()`. */
  finish(final: PlaybackState): PlayerMetrics;
}

interface Tune {
  item: string;
  index: number;
  tuneAt: number;
  zapAt: number | undefined;
  closed: boolean;
  failed: boolean;
  isDwell: boolean;
  sawRecovering: boolean;
  stalled: boolean;
  recovered: boolean;
  sawLimited: boolean;
  played: boolean;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return round(sorted[rank - 1] ?? 0);
}

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

const finalKind = (status: PlaybackState['status']): PlayerFinal =>
  status.kind === 'playing' || status.kind === 'failed' || status.kind === 'limited'
    ? status.kind
    : 'other';

interface SoakTracker {
  observe(state: PlaybackState): void;
  stall(phase: 'start' | 'end'): void;
  finish(final: PlaybackState, minutes: number): SoakMetrics;
}

function createSoakTracker(now: () => number): SoakTracker {
  let firstFrameAt: number | undefined;
  let firstAnchor: ClockAnchor | undefined;
  let lastAnchor: ClockAnchor | undefined;
  let ended = false;
  let stalls = 0;
  let stallStart: number | undefined;
  let longest = 0;
  return {
    observe(state) {
      if (state.status.kind === 'ended') ended = true;
      firstFrameAt ??= state.firstFrameAt;
      const previousAnchor = lastAnchor;
      if (state.anchor !== undefined) lastAnchor = state.anchor;
      if (
        firstFrameAt !== undefined &&
        state.anchor !== undefined &&
        state.anchor !== previousAnchor
      ) {
        firstAnchor ??= state.anchor;
      }
    },
    stall(phase) {
      if (firstFrameAt === undefined) return;
      if (phase === 'start') {
        stalls += 1;
        stallStart ??= now();
      } else if (stallStart !== undefined) {
        longest = Math.max(longest, now() - stallStart);
        stallStart = undefined;
      }
    },
    finish(final, minutes) {
      const at = now();
      const open = stallStart === undefined ? 0 : at - stallStart;
      const anchor = final.anchor ?? lastAnchor;
      const advanced =
        anchor === undefined || firstAnchor === undefined || firstFrameAt === undefined
          ? 0
          : positionAt(anchor, at) - positionAt(firstAnchor, firstFrameAt);
      return {
        minutes,
        playedMs: firstFrameAt === undefined ? 0 : round(at - firstFrameAt),
        positionAdvancedMs: round(advanced),
        stalls,
        longestStallMs: round(Math.max(longest, open)),
        ended,
        durationMs: anchor?.durationMs ?? null,
      };
    },
  };
}

/**
 * Creates a recorder for a run with `fault` injected into `faultItem` (`channels[0]`); `soak` (minutes) adds the soak
 * block to the line, `now` is the service clock.
 */
export function createPlayerRecorder(opts: {
  fault: PlayerFault;
  faultItem: string;
  soak?: number;
  now: () => number;
}): PlayerRecorder {
  const soak = createSoakTracker(opts.now);
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
  const recoveries = { '1': 0, '2': 0, '3': 0, '4': 0 };
  let previous: PlaybackState['status'] | undefined;
  let dwellDone = false;
  let outcome: FaultOutcome | null = null;
  let limitedAfterMs: number | null = null;

  const endDwell = (zapped: boolean): void => {
    if (current === undefined || !current.isDwell) return;
    dwellDone = true;
    if (current.sawLimited) outcome = 'limited-backoff';
    else if (current.failed) outcome = 'failed-in-time';
    else if (current.recovered) outcome = 'recovered';
    else if (zapped && !current.played) outcome = 'left';
    else outcome = 'missed';
  };

  const startTune = (state: PlaybackState): void => {
    endDwell(true);
    tunes += 1;
    const item = state.item ?? '';
    current = {
      item,
      index: tunes,
      tuneAt: state.tuneAt ?? opts.now(),
      zapAt: pendingZap,
      closed: false,
      failed: false,
      isDwell: opts.fault !== '' && !dwellDone && item === opts.faultItem,
      sawRecovering: false,
      stalled: false,
      recovered: false,
      sawLimited: false,
      played: false,
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
    } else if (status.kind === 'playing') {
      tune.played = true;
      if (tune.sawRecovering) tune.recovered = true;
    } else if (status.kind === 'limited') {
      tune.sawLimited = true;
      if (tune.isDwell) limitedAfterMs ??= round(Math.max(0, opts.now() - tune.tuneAt));
    } else if (status.kind === 'failed' && !tune.failed) {
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
      soak.observe(state);
    },
    stall(phase) {
      if (current === undefined) return;
      soak.stall(phase);
      if (phase === 'start') current.stalled = true;
      else if (current.stalled && previous?.kind === 'playing') current.recovered = true;
    },
    surface(change) {
      if (change === 'created') surfaceCreated += 1;
    },
    finish(final) {
      endDwell(false);
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
        recoveries: { ...recoveries },
        fault: opts.fault,
        faultOutcome: opts.fault === '' ? null : (outcome ?? 'missed'),
        limitedAfterMs: opts.fault === '' ? null : limitedAfterMs,
        zaps,
        final: finalKind(final.status),
        soak: opts.soak === undefined ? null : soak.finish(final, opts.soak),
      };
    },
  };
}

/** The console line the gate runner parses. */
export function playerLine(metrics: PlayerMetrics): string {
  return `ELV_GATE_PLAYER ${JSON.stringify(metrics)}`;
}
