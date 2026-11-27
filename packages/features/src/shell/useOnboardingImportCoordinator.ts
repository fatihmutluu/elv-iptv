import type { CatalogService, ImportProgress, ImportSummary } from '@elv/data';
import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Lifecycle status of the shell-lifted onboarding background import (`#513`). */
export type OnboardingImportStatus = 'idle' | 'importing' | 'ready' | 'error';

/** Reactive snapshot exposed by {@link useOnboardingImportCoordinator}. */
export interface OnboardingImportState {
  readonly status: OnboardingImportStatus;
  readonly sourceId: string | null;
  readonly progress: ImportProgress | null;
  readonly errorMessageId: MessageId | null;
}

/** Options for {@link useOnboardingImportCoordinator}. */
export interface UseOnboardingImportCoordinatorOptions {
  readonly catalog: CatalogService;
  /** Invoked once an import completes with >= 1 item so shell caches & sources refresh before entering the app. */
  readonly onImportComplete?: (sourceId: string) => Promise<void> | void;
}

/** Controller returned by {@link useOnboardingImportCoordinator}. */
export interface OnboardingImportCoordinator {
  readonly state: OnboardingImportState;
  startImport(sourceId: string): void;
  retryImport(): void;
  reset(): void;
}

const INITIAL_STATE: OnboardingImportState = {
  status: 'idle',
  sourceId: null,
  progress: null,
  errorMessageId: null,
};

function isEmptySummary(summary: ImportSummary): boolean {
  return (
    (summary.counts.live ?? 0) + (summary.counts.movies ?? 0) + (summary.counts.series ?? 0) === 0
  );
}

function mapImportErrorToMessageId(error: ElvError): MessageId {
  switch (error.category) {
    case 'auth':
      if (
        error.code === 'invalid-credentials' ||
        error.code === 'http-401' ||
        error.code === 'http-403'
      ) {
        return 'source.error.invalidCredentials';
      }
      return 'source.error.accountExpired';
    case 'network':
      if (error.code === 'aborted') return 'source.error.aborted';
      if (error.code === 'rate-limited' || error.code === 'http-429' || error.code === 'http-509') {
        return 'source.error.rateLimited';
      }
      if (error.code === 'timeout') return 'source.error.timeout';
      if (error.code === 'http-404') return 'source.error.notFound';
      return 'source.error.unreachable';
    case 'source-format':
      if (error.code === 'empty-source') return 'source.error.emptyPlaylist';
      if (error.code === 'too-large' || error.code === 'urlvars-too-large') {
        return 'source.error.tooLarge';
      }
      return 'source.error.invalidFormat';
    case 'storage':
    case 'playback':
      if (error.code === 'import-in-progress') return 'source.error.importInProgress';
      if (
        error.code === 'secret-store-failed' ||
        error.code === 'secret-write-failed' ||
        error.code === 'secret-missing' ||
        error.code === 'secret-delete-failed'
      ) {
        return 'source.error.secretStore';
      }
      return 'source.error.storage';
  }
}

/**
 * Shell-lifted background catalog import coordinator for Wave E3 Smart Onboarding (`#513`).
 * Survives all onboarding step transitions (Screen 2 -> Screen 3 -> Personalize Cards 1–4 -> Waiting)
 * without aborting the active `catalog.importSource(...)`, cleaning up only on explicit reset or
 * `AppShell` unmount.
 */
export function useOnboardingImportCoordinator({
  catalog,
  onImportComplete,
}: UseOnboardingImportCoordinatorOptions): OnboardingImportCoordinator {
  const [state, setState] = useState<OnboardingImportState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const mountedRef = useRef(true);
  const runSeqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const onCompleteRef = useRef(onImportComplete);
  onCompleteRef.current = onImportComplete;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runSeqRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const startImport = useCallback(
    (sourceId: string) => {
      const seq = ++runSeqRef.current;
      controllerRef.current?.abort();
      const ctl = new AbortController();
      controllerRef.current = ctl;

      const importingState: OnboardingImportState = {
        status: 'importing',
        sourceId,
        progress: null,
        errorMessageId: null,
      };
      stateRef.current = importingState;
      setState(importingState);

      void (async () => {
        try {
          const result = await catalog.importSource(sourceId, {
            signal: ctl.signal,
            onProgress: (progress) => {
              if (!mountedRef.current || runSeqRef.current !== seq || ctl.signal.aborted) return;
              setState((prev) =>
                prev.status === 'importing' && prev.sourceId === sourceId
                  ? { ...prev, progress }
                  : prev,
              );
            },
          });

          if (controllerRef.current === ctl) controllerRef.current = null;
          if (!mountedRef.current || runSeqRef.current !== seq || ctl.signal.aborted) return;

          if (!result.ok) {
            setState({
              status: 'error',
              sourceId,
              progress: null,
              errorMessageId: mapImportErrorToMessageId(result.error),
            });
            return;
          }

          if (isEmptySummary(result.value)) {
            setState({
              status: 'error',
              sourceId,
              progress: null,
              errorMessageId: 'source.error.emptyPlaylist',
            });
            return;
          }

          await Promise.resolve(onCompleteRef.current?.(sourceId)).catch(() => undefined);
          if (!mountedRef.current || runSeqRef.current !== seq || ctl.signal.aborted) return;

          setState({
            status: 'ready',
            sourceId,
            progress: null,
            errorMessageId: null,
          });
        } catch {
          if (controllerRef.current === ctl) controllerRef.current = null;
          if (!mountedRef.current || runSeqRef.current !== seq || ctl.signal.aborted) return;
          setState({
            status: 'error',
            sourceId,
            progress: null,
            errorMessageId: 'onboarding.import.failed',
          });
        }
      })();
    },
    [catalog],
  );

  const retryImport = useCallback(() => {
    const targetId = stateRef.current.sourceId;
    if (targetId !== null) {
      startImport(targetId);
    }
  }, [startImport]);

  const reset = useCallback(() => {
    runSeqRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
  }, []);

  return {
    state,
    startImport,
    retryImport,
    reset,
  };
}
