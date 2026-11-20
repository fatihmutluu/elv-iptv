import type { PlayerLine } from '../src/gates/player-judge.ts';
import type { SimLogEntry } from '../src/gates/sim-log.ts';

const T0 = Date.parse('2026-11-14T10:00:00.000Z');

/** A passing zap-run line; `over` replaces fields. */
export const line = (over: Partial<PlayerLine> = {}): PlayerLine => ({
  ttffColdMs: 900,
  ttffWarmMs: { p50: 400, p95: 700 },
  zapMs: { p50: 500, p95: 900, max: 1200 },
  surfaceCreated: 1,
  staleEventsApplied: 0,
  staleEventsDropped: 2,
  failures: 0,
  recoveries: { '1': 0, '2': 0, '3': 0, '4': 0 },
  fault: '',
  faultOutcome: null,
  zaps: 30,
  soak: null,
  final: 'playing',
  limitedAfterMs: null,
  ...over,
});

/** The logcat form of a line. */
export const logcat = (l: unknown): string =>
  `11-14 10:00:00.000 1 2 I ReactNativeJS: ELV_GATE_PLAYER ${JSON.stringify(l)}`;

/** A TS request of channel 1001 on `demo` that started `start` ms after {@link T0} and lasted `ms`. */
export const entry = (start: number, ms: number, over: Partial<SimLogEntry> = {}): SimLogEntry => ({
  t: new Date(T0 + start + ms).toISOString(),
  path: '/live/demo/demo/1001.ts',
  query: {},
  status: 200,
  bytes: 1000,
  ms,
  account: 'demo',
  streamId: 1001,
  ...over,
});

/** A request of the slow-start fault. */
export const slow = (start: number, ms: number, over: Partial<SimLogEntry> = {}): SimLogEntry =>
  entry(start, ms, { query: { fault: 'slow-start=3' }, bytes: 0, ...over });

/** A request of channel 1002. */
export const next = (start: number, ms: number): SimLogEntry =>
  entry(start, ms, { streamId: 1002, path: '/live/demo/demo/1002.ts' });
