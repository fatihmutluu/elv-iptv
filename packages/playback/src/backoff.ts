import { positionAt } from './clock';
import type { PlaybackConfig } from './config';
import type { ClockAnchor, EngineError } from './engine';
import type { LiveContainerFormat, ServiceControl, WorkingFormatCache } from './seam';

export interface Budget {
  rung: number;
  lastError: EngineError | undefined;
  notFound: boolean;
  vodStart: number | undefined;
  vodAttempt: number;
}

export interface Limit {
  start: number | undefined;
  attempt: number;
  account: string | undefined;
}

export const freshBudget = (): Budget => ({
  rung: 0,
  lastError: undefined,
  notFound: false,
  vodStart: undefined,
  vodAttempt: 0,
});

export const freshLimit = (): Limit => ({
  start: undefined,
  attempt: 0,
  account: undefined,
});

export const isBudgetUsed = (budget: Budget, limit: Limit): boolean =>
  budget.rung > 0 || budget.notFound || budget.vodStart !== undefined || limit.start !== undefined;

const HTTP_SCHEME_RE = /^https?:\/\//i;
const CONTAINER_EXT_RE = /^(.*?)(\.(?:ts|m3u8))([?#].*)?$/i;
const SIM_FAULT_QUERY_RE = /(?:^|[?&])fault=/i;
const MAX_FORMAT_CACHE = 64;

/** Step backoff helper bounded by `totalMs`. */
export function backoff(
  elapsedMs: number,
  attempt: number,
  steps: readonly number[],
  totalMs: number,
): number | undefined {
  const step = steps[Math.min(attempt, steps.length - 1)];
  return step === undefined || elapsedMs + step > totalMs ? undefined : step;
}

/**
 * Wait before the next connection-limit attempt (2 s, 4 s, 8 s, then 15 s by default), or undefined
 * when that attempt would start after the total budget (60 s) and the service should give up.
 */
export function nextLimitDelay(
  elapsedMs: number,
  attempt: number,
  config: PlaybackConfig,
): number | undefined {
  return backoff(elapsedMs, attempt, config.limitBackoffMs, config.limitTotalMs);
}

function detectLiveContainer(url: string): LiveContainerFormat | undefined {
  if (!HTTP_SCHEME_RE.test(url)) return undefined;
  const match = CONTAINER_EXT_RE.exec(url);
  if (match === null) return undefined;
  const suffix = match[3] ?? '';
  if (SIM_FAULT_QUERY_RE.test(suffix)) return undefined;
  return (match[2] ?? '').toLowerCase() === '.m3u8' ? 'm3u8' : 'ts';
}

/** Swaps `.ts` <-> `.m3u8` (or forces `target`) on an eligible live stream URL. */
export function swapLiveContainerUrl(
  url: string,
  target?: LiveContainerFormat,
): { url: string; format: LiveContainerFormat } | undefined {
  const current = detectLiveContainer(url);
  if (current === undefined) return undefined;
  const nextFormat: LiveContainerFormat = target ?? (current === 'ts' ? 'm3u8' : 'ts');
  if (nextFormat === current) return { url, format: current };
  const match = CONTAINER_EXT_RE.exec(url);
  if (match === null) return undefined;
  return {
    url: `${match[1] ?? ''}.${nextFormat}${match[3] ?? ''}`,
    format: nextFormat,
  };
}

/** Creates a bounded LRU-like per-session working container format cache (`#200`). */
export function createWorkingFormatCache(): WorkingFormatCache {
  const entries = new Map<string, LiveContainerFormat>();
  return {
    get: (accountKey) => entries.get(accountKey),
    set(accountKey, format) {
      if (entries.has(accountKey)) entries.delete(accountKey);
      else if (entries.size >= MAX_FORMAT_CACHE) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(accountKey, format);
    },
    evict(accountKey) {
      entries.delete(accountKey);
    },
    apply(accountKey, stream) {
      const preferred = entries.get(accountKey);
      if (preferred === undefined) return stream;
      const swapped = swapLiveContainerUrl(stream.url, preferred);
      if (swapped === undefined || swapped.url === stream.url) return stream;
      return { ...stream, url: swapped.url };
    },
  };
}

export interface PositionTracker {
  reset(): void;
  resumePosition(): number | undefined;
  freeze(isVod: boolean): void;
  onSeek(clampedMs: number): number;
  onClock(anchor: ClockAnchor): void;
}

/** @internal Tracks VOD resume position, preserving `0 ms` anchors and clamping EOF seeks. */
export function createPositionTracker(ctl: ServiceControl): PositionTracker {
  let resumeFrom: ClockAnchor | undefined;
  let resumeMs: number | undefined;

  const validDuration = (): number | undefined => {
    const d = ctl.getState().anchor?.durationMs;
    return d !== undefined && Number.isFinite(d) && d > 0 ? d : undefined;
  };

  const resumePosition = (): number | undefined => {
    if (resumeFrom !== undefined) {
      resumeMs = positionAt(resumeFrom, ctl.now());
      resumeFrom = undefined;
    }
    if (resumeMs !== undefined) return resumeMs;
    const anchored = ctl.getState().anchor;
    if (anchored !== undefined) return positionAt(anchored, ctl.now());
    return ctl.request()?.startMs;
  };

  return {
    reset() {
      resumeFrom = undefined;
      resumeMs = undefined;
    },
    resumePosition,
    freeze(isVod) {
      if (isVod) resumePosition();
      ctl.freezeAnchor();
    },
    onSeek(clampedMs) {
      const dur = validDuration();
      const safeTarget =
        dur !== undefined && clampedMs >= dur
          ? Math.max(0, dur > 1000 ? dur - 1000 : dur - 1)
          : clampedMs;
      resumeFrom = undefined;
      resumeMs = safeTarget;
      return safeTarget;
    },
    onClock(anchor) {
      if (ctl.getState().status.kind === 'playing' || anchor.rate > 0) {
        resumeFrom = anchor;
        resumeMs = positionAt(anchor, ctl.now());
      }
    },
  };
}
