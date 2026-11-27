import type { CatalogService, SourceRow } from '@elv/data';
import type { CatalogRefreshHoursPref, GuideRefreshHoursPref } from '@elv/domain';
import { useEffect, useRef } from 'react';

const MS_PER_HOUR = 3_600_000;
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FAILURE_BACKOFF_MS = 60 * 60_000;

type RefreshKind = 'catalog' | 'guide';

/** Options for {@link useGuideAutoRefresh}. */
export interface UseGuideAutoRefreshOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  /** Catalog auto-refresh interval in hours (`0` = manual only, `#68`). Defaults to `0` when omitted. */
  readonly catalogRefreshHours?: CatalogRefreshHoursPref;
  /** EPG guide auto-refresh interval in hours (`0` = manual only, `#68`). */
  readonly guideRefreshHours: GuideRefreshHoursPref;
  /** Must be true strictly when foregrounded, visible, and not actively playing video (fullscreen or embedded). */
  readonly enabled: boolean;
  /** Optional set of source IDs already auto-imported in this session (avoids immediate duplicate re-import under clock skew). */
  readonly sessionImportedIdsRef?: { readonly current: ReadonlySet<string> };
  /** Optional shared failure-backoff map (`${sourceId}\u0000${kind}` -> ms epoch) populated by startup refresh (`#513`). */
  readonly sharedFailureAtRef?: { readonly current: Map<string, number> };
  /** Invoked after one or more ready sources finish a background catalog or guide refresh. */
  readonly onGuideRefreshed?: () => void;
  /** Optional clock provider (ms epoch) for deterministic tests (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Optional polling cap in ms (defaults to 15 minutes). */
  readonly checkIntervalMs?: number;
  /** Optional per-source failure backoff duration in ms (defaults to 1 hour, `#68`). */
  readonly failureBackoffMs?: number;
  /** Optional timer scheduler for deterministic tests. */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Optional timer canceller for deterministic tests. */
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

function makeKey(sourceId: string, kind: RefreshKind): string {
  return `${sourceId}\u0000${kind}`;
}

function resolvePersistedTimestamp(source: SourceRow, kind: RefreshKind): number | null {
  const raw = kind === 'catalog' ? source.lastCatalogSyncAt : source.lastGuideSyncAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * Schedules non-blocking periodic catalog and EPG guide refreshes for ready sources based on
 * `catalogRefreshHours` and `guideRefreshHours` (`#68`, `#401`).
 *
 * Checks persisted `lastCatalogSyncAt` / `lastGuideSyncAt` timestamps immediately on startup,
 * every 15 minutes while foregrounded, and on browser/app `online` reconnect. Pauses and aborts
 * cleanly via `AbortController` whenever fullscreen or embedded live playback is active, and
 * applies a 1-hour per-source `(sourceId, kind)` failure backoff so offline/5xx sources never
 * tight-loop.
 */
export function useGuideAutoRefresh({
  catalog,
  sources,
  catalogRefreshHours = 0,
  guideRefreshHours,
  enabled,
  sessionImportedIdsRef,
  sharedFailureAtRef,
  onGuideRefreshed,
  now = Date.now,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  failureBackoffMs = DEFAULT_FAILURE_BACKOFF_MS,
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (handle) => globalThis.clearTimeout(handle),
}: UseGuideAutoRefreshOptions): void {
  const lastRefreshAtRef = useRef<Map<string, number>>(new Map());
  const ownFailureAtRef = useRef<Map<string, number>>(new Map());
  const lastFailureAtRef = sharedFailureAtRef ?? ownFailureAtRef;
  const pendingImportIdsRef = useRef<Set<string>>(new Set());
  const callbacksRef = useRef({ onGuideRefreshed, now, setTimeoutFn, clearTimeoutFn });
  callbacksRef.current = { onGuideRefreshed, now, setTimeoutFn, clearTimeoutFn };

  for (const s of sources) {
    if (s.needsImport) pendingImportIdsRef.current.add(s.id);
  }

  const readySources = sources.filter((s) => !s.needsImport);
  const readySourcesKey = readySources
    .map((s) => `${s.id}:${s.lastCatalogSyncAt ?? ''}:${s.lastGuideSyncAt ?? ''}`)
    .join('\u0001');

  // Reconcile baseline & persisted timestamps whenever the ready sources or their sync timestamps change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed stably on readySourcesKey
  useEffect(() => {
    const refreshMap = lastRefreshAtRef.current;
    const failureMap = lastFailureAtRef.current;
    const activeIds = new Set(readySources.map((s) => s.id));
    for (const key of refreshMap.keys()) {
      const sourceId = key.split('\u0000')[0] ?? '';
      if (!activeIds.has(sourceId)) refreshMap.delete(key);
    }
    for (const key of failureMap.keys()) {
      const sourceId = key.split('\u0000')[0] ?? '';
      if (!activeIds.has(sourceId)) failureMap.delete(key);
    }
    const baseline = callbacksRef.current.now();
    for (const source of readySources) {
      const justFinishedInitialImport =
        pendingImportIdsRef.current.delete(source.id) ||
        (sessionImportedIdsRef?.current.has(source.id) === true &&
          !refreshMap.has(makeKey(source.id, 'catalog')));
      for (const kind of ['catalog', 'guide'] as const) {
        const key = makeKey(source.id, kind);
        if (justFinishedInitialImport) {
          refreshMap.set(key, baseline);
          continue;
        }
        const persisted = resolvePersistedTimestamp(source, kind);
        const existing = refreshMap.get(key);
        if (persisted !== null) {
          refreshMap.set(key, existing !== undefined ? Math.max(existing, persisted) : persisted);
        } else if (existing === undefined) {
          refreshMap.set(key, baseline);
        }
      }
    }
  }, [readySourcesKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: readySourcesKey represents readySources stably
  useEffect(() => {
    const canCatalog = catalogRefreshHours > 0;
    const canGuide = guideRefreshHours > 0 && catalog.importGuide !== undefined;
    if (!enabled || readySources.length === 0 || (!canCatalog && !canGuide)) return;

    const catalogIntervalMs = catalogRefreshHours * MS_PER_HOUR;
    const guideIntervalMs = guideRefreshHours * MS_PER_HOUR;
    const pollCapMs = Math.max(1, checkIntervalMs);
    const backoffMs = Math.max(1, failureBackoffMs);

    let cancelled = false;
    let inFlight = false;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    const clearPendingTimer = (): void => {
      if (timerHandle !== null) {
        callbacksRef.current.clearTimeoutFn(timerHandle);
        timerHandle = null;
      }
    };

    const nextDueInMs = (sourceId: string, kind: RefreshKind, currentNow: number): number => {
      const intervalMs = kind === 'catalog' ? catalogIntervalMs : guideIntervalMs;
      const key = makeKey(sourceId, kind);
      const lastAt = lastRefreshAtRef.current.get(key) ?? currentNow;
      const intervalRemaining = Math.max(0, lastAt + intervalMs - currentNow);
      const failedAt = lastFailureAtRef.current.get(key);
      const backoffRemaining =
        failedAt !== undefined ? Math.max(0, failedAt + backoffMs - currentNow) : 0;
      return Math.max(intervalRemaining, backoffRemaining);
    };

    const scheduleNext = (): void => {
      if (cancelled || inFlight) return;
      clearPendingTimer();
      const currentNow = callbacksRef.current.now();
      let minRemaining = pollCapMs;
      for (const source of readySources) {
        if (canCatalog) {
          const rem = nextDueInMs(source.id, 'catalog', currentNow);
          if (rem < minRemaining) minRemaining = rem;
        }
        if (canGuide) {
          const rem = nextDueInMs(source.id, 'guide', currentNow);
          if (rem < minRemaining) minRemaining = rem;
        }
      }
      const delayMs = Math.min(minRemaining, pollCapMs);
      timerHandle = callbacksRef.current.setTimeoutFn(() => {
        timerHandle = null;
        void checkAndRefresh();
      }, delayMs);
    };

    const checkAndRefresh = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      const currentNow = callbacksRef.current.now();
      const dueTasks: Array<{ readonly sourceId: string; readonly kind: RefreshKind }> = [];
      for (const source of readySources) {
        if (canCatalog && nextDueInMs(source.id, 'catalog', currentNow) <= 0) {
          dueTasks.push({ sourceId: source.id, kind: 'catalog' });
        }
        if (canGuide && nextDueInMs(source.id, 'guide', currentNow) <= 0) {
          dueTasks.push({ sourceId: source.id, kind: 'guide' });
        }
      }
      if (dueTasks.length === 0) {
        scheduleNext();
        return;
      }

      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      let refreshedAny = false;

      for (const task of dueTasks) {
        if (cancelled || controller.signal.aborted) break;
        const key = makeKey(task.sourceId, task.kind);
        try {
          const result =
            task.kind === 'catalog'
              ? await catalog.importSource(task.sourceId, { signal: controller.signal })
              : await catalog.importGuide?.(task.sourceId, { signal: controller.signal });
          if (cancelled || controller.signal.aborted) break;
          if (result?.ok) {
            lastRefreshAtRef.current.set(key, callbacksRef.current.now());
            lastFailureAtRef.current.delete(key);
            refreshedAny = true;
          } else {
            lastFailureAtRef.current.set(key, callbacksRef.current.now());
          }
        } catch {
          if (cancelled || controller.signal.aborted) break;
          lastFailureAtRef.current.set(key, callbacksRef.current.now());
        }
      }

      if (activeController === controller) activeController = null;
      inFlight = false;
      if (cancelled || controller.signal.aborted) return;

      if (refreshedAny) {
        callbacksRef.current.onGuideRefreshed?.();
      }
      scheduleNext();
    };

    const handleOnline = (): void => {
      if (cancelled || inFlight) return;
      lastFailureAtRef.current.clear();
      clearPendingTimer();
      void checkAndRefresh();
    };

    const win = globalThis as {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    const hasWindowOnline =
      typeof win.addEventListener === 'function' && typeof win.removeEventListener === 'function';
    if (hasWindowOnline) {
      win.addEventListener?.('online', handleOnline);
    }

    scheduleNext();

    return () => {
      cancelled = true;
      clearPendingTimer();
      if (hasWindowOnline) {
        win.removeEventListener?.('online', handleOnline);
      }
      if (activeController !== null) {
        activeController.abort();
        activeController = null;
      }
    };
  }, [
    catalog,
    catalogRefreshHours,
    checkIntervalMs,
    enabled,
    failureBackoffMs,
    guideRefreshHours,
    readySourcesKey,
  ]);
}
