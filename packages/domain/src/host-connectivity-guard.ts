import { originOf } from './headers';

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_FAILURE_WINDOW_MS = 120_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 256;

const CONNECTIVITY_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const NON_CONNECTIVITY_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ABORT_ERR']);

/** Configuration options for {@link createHostConnectivityGuard}. */
export interface HostConnectivityGuardOptions {
  /** Number of non-sibling pre-connect failures within `failureWindowMs` before opening (default `2`). */
  readonly failureThreshold?: number;
  /** Sliding failure window in milliseconds (default `120_000`). */
  readonly failureWindowMs?: number;
  /** Open-circuit fast-fail cooldown in milliseconds (default `30_000`). */
  readonly cooldownMs?: number;
  /** Clock returning epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
  /** Maximum tracked origins retained in memory (default `256`). */
  readonly maxEntries?: number;
}

/** Opaque ticket returned when {@link HostConnectivityGuard.acquire} admits a request. */
export interface HostGuardTicket {
  readonly origin: string;
  readonly isHalfOpenProbe: boolean;
}

/** Result of {@link HostConnectivityGuard.acquire}. */
export type HostGuardAdmission =
  | { readonly allowed: true; readonly ticket: HostGuardTicket | undefined }
  | { readonly allowed: false; readonly origin: string; readonly retryAfterMs: number };

/** Context flags passed to {@link HostConnectivityGuard.reportFailure}. */
export interface HostFailureReportOptions {
  /** True when the request timed out before connecting or receiving response headers. */
  readonly timedOut?: boolean;
  /** True when the failure happened after following a redirect off the guarded origin. */
  readonly failedAfterRedirect?: boolean;
}

/** Per-origin (`scheme://host[:port]`) pre-connect fast-fail circuit breaker. */
export interface HostConnectivityGuard {
  /** Admits a request or fast-fails when the origin's circuit is open or a half-open probe is active. */
  acquire(url: string): HostGuardAdmission;
  /** Marks the ticket's TCP socket as connected so post-connect slowness never trips the breaker. */
  reportConnected(ticket: HostGuardTicket | undefined): void;
  /** Marks all active admissions for `url`'s origin as TCP-connected (used by Node socket hooks). */
  reportOriginConnected(url: string): void;
  /** Records a completed HTTP response (any status code) and closes open/half-open state. */
  reportSuccess(ticket: HostGuardTicket | undefined): void;
  /** Records a failed hop-0 request; counts only pre-connect connectivity failures on non-sibling tickets. */
  reportFailure(
    ticket: HostGuardTicket | undefined,
    error: unknown,
    opts?: HostFailureReportOptions,
  ): void;
  /** Releases an unsettled ticket (e.g. caller abort) without counting a failure or stranding half-open state. */
  release(ticket: HostGuardTicket | undefined): void;
  /** Clears breaker state for `url`'s origin and invalidates any stale in-flight tickets for it. */
  resetOrigin(url: string): void;
  /** Clears breaker state for all tracked origins and invalidates all stale in-flight tickets. */
  resetAll(): void;
}

interface OriginState {
  readonly origin: string;
  invalidated: boolean;
  state: 'closed' | 'open' | 'half-open';
  failureEpoch: number;
  failureTimestamps: number[];
  openedUntil: number;
  probeInFlight: boolean;
  readonly activeTickets: Set<InternalTicket>;
}

interface InternalTicket extends HostGuardTicket {
  readonly stateRef: OriginState;
  readonly admittedAtFailureEpoch: number;
  connected: boolean;
  settled: boolean;
}

function inspectError(
  error: unknown,
  depth: number,
): { connectivity: boolean; ignored: boolean; reset: boolean } {
  if (depth > 4 || error === null || error === undefined || typeof error !== 'object') {
    return { connectivity: false, ignored: false, reset: false };
  }
  const rec = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (rec.name === 'AbortError' || rec.code === 'aborted' || rec.code === 'ABORT_ERR') {
    return { connectivity: false, ignored: true, reset: false };
  }
  if (typeof rec.code === 'string') {
    if (CONNECTIVITY_FAILURE_CODES.has(rec.code)) {
      return { connectivity: true, ignored: false, reset: false };
    }
    if (NON_CONNECTIVITY_CODES.has(rec.code)) {
      return { connectivity: false, ignored: true, reset: true };
    }
  }
  if (typeof rec.message === 'string' && /other side closed/i.test(rec.message)) {
    return { connectivity: false, ignored: true, reset: true };
  }
  let sawIgnored = false;
  let sawReset = false;
  if (rec.cause !== undefined) {
    const sub = inspectError(rec.cause, depth + 1);
    if (sub.connectivity) return sub;
    if (sub.ignored) sawIgnored = true;
    if (sub.reset) sawReset = true;
  }
  if (Array.isArray(rec.errors)) {
    for (const inner of rec.errors) {
      const sub = inspectError(inner, depth + 1);
      if (sub.connectivity) return sub;
      if (sub.ignored) sawIgnored = true;
      if (sub.reset) sawReset = true;
    }
  }
  return { connectivity: false, ignored: sawIgnored, reset: sawReset };
}

function isConnectivityFailure(error: unknown, timedOut: boolean | undefined): boolean {
  const verdict = inspectError(error, 0);
  if (verdict.connectivity) return true;
  if (timedOut === true) return !verdict.reset;
  if (verdict.ignored) return false;
  return false;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function asInternal(ticket: HostGuardTicket | undefined): InternalTicket | undefined {
  if (ticket === undefined) return undefined;
  return ticket as InternalTicket;
}

/**
 * Creates a pure, dependency-free per-origin fast-fail circuit breaker (`scheme://host[:port]`).
 * Opens after `failureThreshold` (default 2) non-sibling pre-connect network failures within
 * `failureWindowMs` (default 120 s) for `cooldownMs` (default 30 s), then allows 1 half-open probe.
 */
export function createHostConnectivityGuard(
  opts?: HostConnectivityGuardOptions,
): HostConnectivityGuard {
  const failureThreshold = positiveInt(opts?.failureThreshold, DEFAULT_FAILURE_THRESHOLD);
  const failureWindowMs = positiveInt(opts?.failureWindowMs, DEFAULT_FAILURE_WINDOW_MS);
  const cooldownMs = positiveInt(opts?.cooldownMs, DEFAULT_COOLDOWN_MS);
  const maxEntries = positiveInt(opts?.maxEntries, DEFAULT_MAX_ENTRIES);
  const now = opts?.now ?? Date.now;
  const entries = new Map<string, OriginState>();

  const evictIfFull = (): void => {
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = entries.get(oldestKey);
      if (oldest !== undefined) {
        oldest.invalidated = true;
        oldest.activeTickets.clear();
      }
      entries.delete(oldestKey);
    }
  };

  const getOrCreate = (origin: string): OriginState => {
    const existing = entries.get(origin);
    if (existing !== undefined) {
      entries.delete(origin);
      entries.set(origin, existing);
      return existing;
    }
    evictIfFull();
    const created: OriginState = {
      origin,
      invalidated: false,
      state: 'closed',
      failureEpoch: 0,
      failureTimestamps: [],
      openedUntil: 0,
      probeInFlight: false,
      activeTickets: new Set(),
    };
    entries.set(origin, created);
    return created;
  };

  const closeCircuit = (entry: OriginState): void => {
    entry.state = 'closed';
    entry.probeInFlight = false;
    entry.openedUntil = 0;
    entry.failureTimestamps.length = 0;
  };

  const makeTicket = (entry: OriginState, isHalfOpenProbe: boolean): InternalTicket => {
    const ticket: InternalTicket = {
      origin: entry.origin,
      isHalfOpenProbe,
      stateRef: entry,
      admittedAtFailureEpoch: entry.failureEpoch,
      connected: false,
      settled: false,
    };
    entry.activeTickets.add(ticket);
    return ticket;
  };

  return {
    acquire(url) {
      const origin = originOf(url);
      if (origin === undefined) return { allowed: true, ticket: undefined };
      const nowMs = now();
      const existing = entries.get(origin);
      if (existing !== undefined) {
        if (existing.state === 'open') {
          if (nowMs < existing.openedUntil) {
            return { allowed: false, origin, retryAfterMs: existing.openedUntil - nowMs };
          }
          existing.state = 'half-open';
          existing.probeInFlight = true;
          return { allowed: true, ticket: makeTicket(existing, true) };
        }
        if (existing.state === 'half-open') {
          if (existing.probeInFlight) {
            return { allowed: false, origin, retryAfterMs: 0 };
          }
          existing.probeInFlight = true;
          return { allowed: true, ticket: makeTicket(existing, true) };
        }
      }
      const entry = getOrCreate(origin);
      return { allowed: true, ticket: makeTicket(entry, false) };
    },

    reportConnected(ticket) {
      const t = asInternal(ticket);
      if (t === undefined || t.settled || t.stateRef.invalidated || t.connected) return;
      t.connected = true;
      closeCircuit(t.stateRef);
    },

    reportOriginConnected(url) {
      const origin = originOf(url);
      if (origin === undefined) return;
      const entry = entries.get(origin);
      if (entry === undefined || entry.invalidated) return;
      for (const active of entry.activeTickets) {
        active.connected = true;
      }
      closeCircuit(entry);
    },

    reportSuccess(ticket) {
      const t = asInternal(ticket);
      if (t === undefined || t.settled) return;
      t.settled = true;
      t.connected = true;
      t.stateRef.activeTickets.delete(t);
      if (t.stateRef.invalidated) return;
      closeCircuit(t.stateRef);
    },

    reportFailure(ticket, error, opts) {
      const t = asInternal(ticket);
      if (t === undefined || t.settled) return;
      t.settled = true;
      t.stateRef.activeTickets.delete(t);
      const entry = t.stateRef;
      if (entry.invalidated) return;

      if (
        t.connected ||
        opts?.failedAfterRedirect === true ||
        !isConnectivityFailure(error, opts?.timedOut)
      ) {
        if (t.isHalfOpenProbe && entry.state === 'half-open') {
          entry.probeInFlight = false;
          entry.state = 'open';
          entry.openedUntil = now();
        }
        return;
      }

      const nowMs = now();
      if (t.isHalfOpenProbe) {
        entry.probeInFlight = false;
        entry.state = 'open';
        entry.openedUntil = nowMs + cooldownMs;
        entry.failureEpoch += 1;
        return;
      }
      if (entry.state !== 'closed') return;
      if (t.admittedAtFailureEpoch < entry.failureEpoch) return;

      entry.failureEpoch += 1;
      entry.failureTimestamps = entry.failureTimestamps.filter(
        (ts) => nowMs - ts <= failureWindowMs,
      );
      entry.failureTimestamps.push(nowMs);
      if (entry.failureTimestamps.length >= failureThreshold) {
        entry.state = 'open';
        entry.openedUntil = nowMs + cooldownMs;
        entry.failureTimestamps.length = 0;
      }
    },

    release(ticket) {
      const t = asInternal(ticket);
      if (t === undefined || t.settled) return;
      t.settled = true;
      t.stateRef.activeTickets.delete(t);
      const entry = t.stateRef;
      if (entry.invalidated) return;
      if (t.isHalfOpenProbe && entry.state === 'half-open') {
        entry.probeInFlight = false;
        entry.state = 'open';
        entry.openedUntil = now();
      }
    },

    resetOrigin(url) {
      const origin = originOf(url);
      if (origin === undefined) return;
      const entry = entries.get(origin);
      if (entry !== undefined) {
        entry.invalidated = true;
        entry.activeTickets.clear();
        entries.delete(origin);
      }
    },

    resetAll() {
      for (const entry of entries.values()) {
        entry.invalidated = true;
        entry.activeTickets.clear();
      }
      entries.clear();
    },
  };
}
