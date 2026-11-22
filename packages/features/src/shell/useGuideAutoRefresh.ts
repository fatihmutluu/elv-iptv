import type { CatalogService, SourceRow } from '@elv/data';
import type { GuideRefreshHoursPref } from '@elv/domain';
import { useEffect, useRef } from 'react';

const MS_PER_HOUR = 3_600_000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60_000;

/** Options for {@link useGuideAutoRefresh}. */
export interface UseGuideAutoRefreshOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly guideRefreshHours: GuideRefreshHoursPref;
  /** Must be true strictly when foregrounded, visible, and not actively playing video. */
  readonly enabled: boolean;
  /** Invoked after one or more ready sources finish a background guide refresh. */
  readonly onGuideRefreshed?: () => void;
  /** Optional clock provider (ms epoch) for deterministic tests (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Optional polling cap in ms (defaults to 15 minutes). */
  readonly checkIntervalMs?: number;
  /** Optional timer scheduler for deterministic tests. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Optional timer canceller for deterministic tests. */
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Schedules non-blocking periodic EPG guide refreshes for ready sources based on the persisted
 * `guideRefreshHours` preference (`#401`), pausing while playing or backgrounded and aborting
 * cleanly via `AbortController` when disabled or unmounted.
 */
export function useGuideAutoRefresh({
  catalog,
  sources,
  guideRefreshHours,
  enabled,
  onGuideRefreshed,
  now = Date.now,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (handle) => globalThis.clearTimeout(handle),
}: UseGuideAutoRefreshOptions): void {
  const lastRefreshAtRef = useRef<Map<string, number>>(new Map());
  const callbacksRef = useRef({ onGuideRefreshed, now, setTimeoutFn, clearTimeoutFn });
  callbacksRef.current = { onGuideRefreshed, now, setTimeoutFn, clearTimeoutFn };

  const readySourceIds = sources.filter((s) => !s.needsImport).map((s) => s.id);
  const readySourcesKey = readySourceIds.join('\u0000');

  // Reconcile baseline timestamps whenever the set of ready sources changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed stably on readySourcesKey
  useEffect(() => {
    const map = lastRefreshAtRef.current;
    const active = new Set(readySourceIds);
    for (const id of map.keys()) {
      if (!active.has(id)) map.delete(id);
    }
    const baseline = callbacksRef.current.now();
    for (const id of readySourceIds) {
      if (!map.has(id)) map.set(id, baseline);
    }
  }, [readySourcesKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: readySourcesKey represents readySourceIds stably
  useEffect(() => {
    const importGuide = catalog.importGuide;
    if (!enabled || importGuide === undefined || readySourceIds.length === 0) return;

    const intervalMs = Math.max(1, guideRefreshHours) * MS_PER_HOUR;
    const pollCapMs = Math.max(1, checkIntervalMs);
    let cancelled = false;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    const clearPendingTimer = (): void => {
      if (timerHandle !== null) {
        callbacksRef.current.clearTimeoutFn(timerHandle);
        timerHandle = null;
      }
    };

    const scheduleNext = (): void => {
      if (cancelled) return;
      clearPendingTimer();
      const currentNow = callbacksRef.current.now();
      let minRemaining = intervalMs;
      for (const id of readySourceIds) {
        const lastAt = lastRefreshAtRef.current.get(id) ?? currentNow;
        const remaining = Math.max(0, lastAt + intervalMs - currentNow);
        if (remaining < minRemaining) minRemaining = remaining;
      }
      const delayMs = Math.min(minRemaining, pollCapMs);
      timerHandle = callbacksRef.current.setTimeoutFn(() => {
        timerHandle = null;
        void checkAndRefresh();
      }, delayMs);
    };

    const checkAndRefresh = async (): Promise<void> => {
      if (cancelled) return;
      const currentNow = callbacksRef.current.now();
      const dueIds = readySourceIds.filter((id) => {
        const lastAt = lastRefreshAtRef.current.get(id) ?? currentNow;
        return currentNow - lastAt >= intervalMs;
      });
      if (dueIds.length === 0) {
        scheduleNext();
        return;
      }

      const controller = new AbortController();
      activeController = controller;
      let refreshedAny = false;

      for (const id of dueIds) {
        if (cancelled || controller.signal.aborted) break;
        try {
          const result = await importGuide(id, { signal: controller.signal });
          if (cancelled || controller.signal.aborted) break;
          lastRefreshAtRef.current.set(id, callbacksRef.current.now());
          if (result.ok) refreshedAny = true;
        } catch {
          if (cancelled || controller.signal.aborted) break;
          lastRefreshAtRef.current.set(id, callbacksRef.current.now());
        }
      }

      if (activeController === controller) activeController = null;
      if (cancelled || controller.signal.aborted) return;

      if (refreshedAny) {
        callbacksRef.current.onGuideRefreshed?.();
      }
      scheduleNext();
    };

    scheduleNext();

    return () => {
      cancelled = true;
      clearPendingTimer();
      if (activeController !== null) {
        activeController.abort();
        activeController = null;
      }
    };
  }, [catalog, checkIntervalMs, enabled, guideRefreshHours, readySourcesKey]);
}
