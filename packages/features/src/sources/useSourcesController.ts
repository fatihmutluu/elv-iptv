import type { CatalogService, ImportProgress, ImportSummary, SourceRow } from '@elv/data';
import type { MessageId } from '@elv/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { noopPlaybackGuard, type PlaybackGuard } from '../ports/playback-guard';
import { type DescribedSourceFailure, describeSourceFailure, isEmptyImport } from './errors';
import {
  createInitialSourceForm,
  detectPastedXtreamLink,
  type SourceFormState,
  validateSourceForm,
} from './validate';

/** Per-source runtime status tracked by the controller during a session. */
export type SourceRuntimeStatus =
  | { readonly kind: 'importing'; readonly progress: ImportProgress | null }
  | { readonly kind: 'ready'; readonly summary: ImportSummary }
  | { readonly kind: 'error'; readonly failure: DescribedSourceFailure };

/** Options accepted by {@link useSourcesController}. */
export interface UseSourcesControllerOptions {
  catalog: CatalogService;
  playbackGuard?: PlaybackGuard;
  externalRefreshToken?: number;
}

/** Reactive state and actions exposed to {@link SourcesScreen}. */
export interface SourcesController {
  form: SourceFormState;
  showAdvanced: boolean;
  detectedXtreamInM3u: boolean;
  formError: DescribedSourceFailure | null;
  submitting: boolean;
  sources: readonly SourceRow[];
  statusById: Readonly<Record<string, SourceRuntimeStatus>>;
  setMode(mode: 'xtream' | 'm3u'): void;
  updateField<K extends keyof SourceFormState>(key: K, value: SourceFormState[K]): void;
  toggleAdvanced(): void;
  submit(): Promise<void>;
  runImport(sourceId: string): Promise<void>;
  cancelImport(sourceId: string): void;
  remove(sourceId: string): Promise<void>;
}

const EMPTY_PLAYLIST_FAILURE: DescribedSourceFailure = {
  messageId: 'source.error.emptyPlaylist',
  hintId: 'source.hint.emptyPlaylist',
};

/** Maps `ImportProgress.phase` to its `@elv/i18n` message identifier. */
export function phaseMessageId(phase: ImportProgress['phase']): MessageId {
  switch (phase) {
    case 'categories':
      return 'sources.phase.categories';
    case 'live':
      return 'sources.phase.live';
    case 'movies':
      return 'sources.phase.movies';
    case 'series':
      return 'sources.phase.series';
    case 'episodes':
      return 'sources.phase.episodes';
    case 'guide-channels':
      return 'sources.phase.guideChannels';
    case 'programmes':
      return 'sources.phase.programmes';
    case 'cleanup':
      return 'sources.phase.cleanup';
  }
}

/** Stateful view-model hook coordinating `CatalogService` operations for `SourcesScreen`. */
export function useSourcesController({
  catalog,
  playbackGuard = noopPlaybackGuard,
  externalRefreshToken = 0,
}: UseSourcesControllerOptions): SourcesController {
  const [form, setForm] = useState<SourceFormState>(createInitialSourceForm);
  const formRef = useRef<SourceFormState>(form);
  formRef.current = form;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formError, setFormError] = useState<DescribedSourceFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sources, setSources] = useState<readonly SourceRow[]>([]);
  const [statusById, setStatusById] = useState<Record<string, SourceRuntimeStatus>>({});
  const statusByIdRef = useRef(statusById);
  statusByIdRef.current = statusById;

  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const latestAppliedRefreshRef = useRef(0);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const removedIdsRef = useRef<Set<string>>(new Set());

  const refreshSources = useCallback(async (): Promise<SourceRow[]> => {
    const seq = ++refreshSeqRef.current;
    const rows = await catalog.listSources();
    if (mountedRef.current && seq >= latestAppliedRefreshRef.current) {
      latestAppliedRefreshRef.current = seq;
      setSources(rows);
      setStatusById((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const row of rows) {
          const cur = next[row.id];
          if (
            !row.needsImport &&
            cur?.kind === 'error' &&
            cur.failure.messageId === 'source.error.importInProgress'
          ) {
            delete next[row.id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    return rows;
  }, [catalog]);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    void refreshSources().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      for (const ctl of controllers.values()) {
        ctl.abort();
      }
      controllers.clear();
    };
  }, [refreshSources]);

  useEffect(() => {
    if (externalRefreshToken === 0) return;
    void refreshSources().catch(() => undefined);
  }, [externalRefreshToken, refreshSources]);

  const setStatus = useCallback((id: string, next: SourceRuntimeStatus) => {
    if (!mountedRef.current || removedIdsRef.current.has(id)) return;
    setStatusById((prev) => ({ ...prev, [id]: next }));
  }, []);

  const setMode = useCallback((mode: 'xtream' | 'm3u') => {
    const next = { ...formRef.current, mode };
    formRef.current = next;
    setForm(next);
    setFormError(null);
  }, []);

  const updateField = useCallback(
    <K extends keyof SourceFormState>(key: K, value: SourceFormState[K]) => {
      const next = { ...formRef.current, [key]: value };
      formRef.current = next;
      setForm(next);
      setFormError(null);
    },
    [],
  );

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, []);

  const runImport = useCallback(
    async (sourceId: string): Promise<void> => {
      if (controllersRef.current.has(sourceId) || removedIdsRef.current.has(sourceId)) {
        return;
      }
      const previousStatus = statusByIdRef.current[sourceId];
      const ctl = new AbortController();
      controllersRef.current.set(sourceId, ctl);
      setStatus(sourceId, { kind: 'importing', progress: null });

      const result = await catalog.importSource(sourceId, {
        signal: ctl.signal,
        onProgress: (progress) => {
          if (controllersRef.current.get(sourceId) === ctl) {
            setStatus(sourceId, { kind: 'importing', progress });
          }
        },
      });

      if (controllersRef.current.get(sourceId) === ctl) {
        controllersRef.current.delete(sourceId);
      }
      if (!mountedRef.current || removedIdsRef.current.has(sourceId)) {
        return;
      }

      const rows = await refreshSources().catch(() => []);
      if (!mountedRef.current || removedIdsRef.current.has(sourceId)) {
        return;
      }
      const currentRow = rows.find((row) => row.id === sourceId);
      if (currentRow === undefined) {
        return;
      }

      if (!result.ok) {
        if (
          result.error.category === 'network' &&
          result.error.code === 'aborted' &&
          !currentRow.needsImport
        ) {
          if (previousStatus?.kind === 'ready') {
            setStatus(sourceId, previousStatus);
          } else {
            setStatusById((prev) => {
              const next = { ...prev };
              delete next[sourceId];
              return next;
            });
          }
          return;
        }
        setStatus(sourceId, { kind: 'error', failure: describeSourceFailure(result.error) });
        return;
      }
      if (isEmptyImport(result.value)) {
        setStatus(sourceId, { kind: 'error', failure: EMPTY_PLAYLIST_FAILURE });
        return;
      }
      setStatus(sourceId, { kind: 'ready', summary: result.value });
    },
    [catalog, refreshSources, setStatus],
  );

  const cancelImport = useCallback((sourceId: string) => {
    controllersRef.current.get(sourceId)?.abort();
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (submittingRef.current) return;
    const validated = validateSourceForm(formRef.current);
    if (!validated.ok) {
      setFormError({
        messageId: validated.error.messageId,
        hintId: validated.error.hintId,
      });
      return;
    }

    submittingRef.current = true;
    setFormError(null);
    setSubmitting(true);
    try {
      const added =
        validated.value.kind === 'xtream'
          ? await catalog.addSource(validated.value.input)
          : await catalog.addSourceFromLink(validated.value.input);

      if (!mountedRef.current) return;

      if (!added.ok) {
        setFormError(describeSourceFailure(added.error));
        return;
      }

      removedIdsRef.current.delete(added.value.id);
      const resetForm: SourceFormState = {
        ...createInitialSourceForm(),
        mode: formRef.current.mode,
      };
      formRef.current = resetForm;
      setForm(resetForm);
      await refreshSources();
      void runImport(added.value.id);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }, [catalog, refreshSources, runImport]);

  const remove = useCallback(
    async (sourceId: string): Promise<void> => {
      removedIdsRef.current.add(sourceId);
      const activeCtl = controllersRef.current.get(sourceId);
      if (activeCtl !== undefined) {
        activeCtl.abort();
        controllersRef.current.delete(sourceId);
      }

      try {
        await playbackGuard.stopIfUsingSource(sourceId);
      } catch {
        // Best-effort playback stop so source removal still completes cleanly.
      }

      let removed: Awaited<ReturnType<CatalogService['removeSource']>>;
      try {
        removed = await catalog.removeSource(sourceId);
      } catch {
        removedIdsRef.current.delete(sourceId);
        return;
      }

      if (!mountedRef.current) return;

      if (!removed.ok) {
        removedIdsRef.current.delete(sourceId);
        setStatus(sourceId, { kind: 'error', failure: describeSourceFailure(removed.error) });
        await refreshSources();
        return;
      }

      setStatusById((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
      await refreshSources();
    },
    [catalog, playbackGuard, refreshSources, setStatus],
  );

  const detectedXtreamInM3u = form.mode === 'm3u' && detectPastedXtreamLink(form.playlistUrl);

  return {
    form,
    showAdvanced,
    detectedXtreamInM3u,
    formError,
    submitting,
    sources,
    statusById,
    setMode,
    updateField,
    toggleAdvanced,
    submit,
    runImport,
    cancelImport,
    remove,
  };
}
