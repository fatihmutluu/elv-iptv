import type { CatalogService, ImportProgress, SourceRow } from '@elv/data';
import type { CatalogRefreshHoursPref, GuideRefreshHoursPref } from '@elv/domain';
import { useCallback, useEffect, useRef, useState } from 'react';

const MS_PER_HOUR = 3_600_000;

/** Single due catalog or guide refresh task scheduled on returning-user cold startup (`#513`). */
export interface StartupRefreshTask {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly kind: 'catalog' | 'guide';
}

/** Reactive state exposed by {@link useStartupRefreshCoordinator}. */
export interface StartupRefreshState {
  readonly evaluated: boolean;
  readonly overlayVisible: boolean;
  readonly running: boolean;
  readonly activeSourceName: string | null;
  readonly activeKind: 'catalog' | 'guide' | null;
  readonly progress: ImportProgress | null;
  readonly completedTasks: number;
  readonly totalTasks: number;
}

/** Options for {@link useStartupRefreshCoordinator}. */
export interface UseStartupRefreshCoordinatorOptions {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly catalogRefreshHours: CatalogRefreshHoursPref;
  readonly guideRefreshHours: GuideRefreshHoursPref;
  /** True strictly once startup gate has settled for a returning user (`onboardingCompleted && ready`). */
  readonly enabled: boolean;
  /** Invoked silently when >= 1 refresh succeeds so shell sources & UI caches update cleanly. */
  readonly onRefreshComplete?: () => Promise<void> | void;
  /** Optional shared failure-backoff map (`${sourceId}\u0000${kind}` -> ms epoch) shared with `useGuideAutoRefresh` (`#513`). */
  readonly sharedFailureAtRef?: { readonly current: Map<string, number> };
  /** Optional clock provider (ms epoch) for deterministic unit tests. */
  readonly now?: () => number;
}

/** Controller returned by {@link useStartupRefreshCoordinator}. */
export interface StartupRefreshCoordinator {
  readonly state: StartupRefreshState;
  /** Hides the startup overlay immediately while letting the active refresh finish quietly in the background. */
  dismissOverlay(): void;
}

const IDLE_STATE: StartupRefreshState = {
  evaluated: false,
  overlayVisible: false,
  running: false,
  activeSourceName: null,
  activeKind: null,
  progress: null,
  completedTasks: 0,
  totalTasks: 0,
};

/**
 * Evaluates which ready sources are overdue for a catalog or EPG guide refresh on cold startup,
 * matching `useGuideAutoRefresh` interval thresholds (`#68`, `#513`).
 */
export function computeDueStartupRefreshTasks(params: {
  readonly sources: readonly SourceRow[];
  readonly catalogRefreshHours: CatalogRefreshHoursPref;
  readonly guideRefreshHours: GuideRefreshHoursPref;
  readonly hasImportGuide: boolean;
  readonly nowMs: number;
}): readonly StartupRefreshTask[] {
  const { sources, catalogRefreshHours, guideRefreshHours, hasImportGuide, nowMs } = params;
  const tasks: StartupRefreshTask[] = [];
  const catalogIntervalMs = catalogRefreshHours * MS_PER_HOUR;
  const guideIntervalMs = guideRefreshHours * MS_PER_HOUR;

  for (const source of sources) {
    if (source.needsImport) continue;
    if (
      catalogRefreshHours > 0 &&
      typeof source.lastCatalogSyncAt === 'number' &&
      Number.isFinite(source.lastCatalogSyncAt) &&
      nowMs - source.lastCatalogSyncAt >= catalogIntervalMs
    ) {
      tasks.push({ sourceId: source.id, sourceName: source.name, kind: 'catalog' });
    }
    if (
      guideRefreshHours > 0 &&
      hasImportGuide &&
      typeof source.lastGuideSyncAt === 'number' &&
      Number.isFinite(source.lastGuideSyncAt) &&
      nowMs - source.lastGuideSyncAt >= guideIntervalMs
    ) {
      tasks.push({ sourceId: source.id, sourceName: source.name, kind: 'guide' });
    }
  }
  return tasks;
}

/**
 * Coordinates the one-shot returning-user cold-startup catalog/guide refresh (`#513` `[5.4]`).
 * Dismissing the overlay (`dismissOverlay`) immediately returns control to the user on cached data
 * while keeping the refresh running silently in the background — aborting strictly on unmount.
 */
export function useStartupRefreshCoordinator({
  catalog,
  sources,
  catalogRefreshHours,
  guideRefreshHours,
  enabled,
  onRefreshComplete,
  sharedFailureAtRef,
  now = Date.now,
}: UseStartupRefreshCoordinatorOptions): StartupRefreshCoordinator {
  const [state, setState] = useState<StartupRefreshState>(IDLE_STATE);
  const mountedRef = useRef(true);
  const evaluatedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const callbacksRef = useRef({ onRefreshComplete, sharedFailureAtRef, now });
  callbacksRef.current = { onRefreshComplete, sharedFailureAtRef, now };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled || evaluatedRef.current) return;
    evaluatedRef.current = true;

    const tasks = computeDueStartupRefreshTasks({
      sources,
      catalogRefreshHours,
      guideRefreshHours,
      hasImportGuide: catalog.importGuide !== undefined,
      nowMs: callbacksRef.current.now(),
    });
    if (tasks.length === 0) {
      setState((prev) => (prev.evaluated ? prev : { ...prev, evaluated: true }));
      return;
    }

    const ctl = new AbortController();
    controllerRef.current = ctl;
    const first = tasks[0];

    setState({
      evaluated: true,
      overlayVisible: true,
      running: true,
      activeSourceName: first?.sourceName ?? null,
      activeKind: first?.kind ?? null,
      progress: null,
      completedTasks: 0,
      totalTasks: tasks.length,
    });

    void (async () => {
      let refreshedAny = false;
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i];
        if (!task || !mountedRef.current || ctl.signal.aborted) break;

        setState((prev) => ({
          ...prev,
          activeSourceName: task.sourceName,
          activeKind: task.kind,
          progress: null,
          completedTasks: i,
        }));

        const failureKey = `${task.sourceId}\u0000${task.kind}`;
        try {
          const onProgress = (progress: ImportProgress) => {
            if (!mountedRef.current || ctl.signal.aborted) return;
            setState((prev) => ({ ...prev, progress }));
          };
          const res =
            task.kind === 'catalog'
              ? await catalog.importSource(task.sourceId, { signal: ctl.signal, onProgress })
              : await catalog.importGuide?.(task.sourceId, { signal: ctl.signal, onProgress });
          if (ctl.signal.aborted || !mountedRef.current) break;
          if (res?.ok) {
            callbacksRef.current.sharedFailureAtRef?.current.delete(failureKey);
            refreshedAny = true;
          } else {
            callbacksRef.current.sharedFailureAtRef?.current.set(
              failureKey,
              callbacksRef.current.now(),
            );
          }
        } catch {
          if (ctl.signal.aborted || !mountedRef.current) break;
          callbacksRef.current.sharedFailureAtRef?.current.set(
            failureKey,
            callbacksRef.current.now(),
          );
        }
      }

      if (controllerRef.current === ctl) controllerRef.current = null;
      if (!mountedRef.current || ctl.signal.aborted) return;

      if (refreshedAny) {
        await Promise.resolve(callbacksRef.current.onRefreshComplete?.()).catch(() => undefined);
      }
      if (!mountedRef.current || ctl.signal.aborted) return;

      setState({
        evaluated: true,
        overlayVisible: false,
        running: false,
        activeSourceName: null,
        activeKind: null,
        progress: null,
        completedTasks: tasks.length,
        totalTasks: tasks.length,
      });
    })();
  }, [catalog, catalogRefreshHours, enabled, guideRefreshHours, sources]);

  const dismissOverlay = useCallback(() => {
    setState((prev) => (prev.overlayVisible ? { ...prev, overlayVisible: false } : prev));
  }, []);

  return { state, dismissOverlay };
}
