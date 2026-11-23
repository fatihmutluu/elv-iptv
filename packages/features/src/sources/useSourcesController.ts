import type {
  CatalogService,
  DiscoveredCategory,
  ImportProgress,
  ImportSummary,
  SourceRow,
} from '@elv/data';
import { elvError, err } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { noopPlaybackGuard, type PlaybackGuard } from '../ports/playback-guard';
import type { PickedPlaylistFile, SourceImportHost } from '../ports/source-import-host';
import {
  buildCategorySelection,
  clearPendingCategories,
  discoveredCategoryKey,
  initialSelectedCategoryKeys,
  mergePendingCategories,
} from './category-selection-model';
import { type DescribedSourceFailure, describeSourceFailure, isEmptyImport } from './errors';
import {
  createInitialSourceForm,
  detectPastedXtreamLink,
  type SourceFormState,
  validateSourceForm,
} from './validate';

/** Active state of the pre-import category picker (`#39`). */
export interface CategoryPickerState {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly categories: readonly DiscoveredCategory[];
  readonly selectedKeys: ReadonlySet<string>;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: DescribedSourceFailure | null;
}

/** Per-source runtime status tracked by the controller during a session. */
export type SourceRuntimeStatus =
  | { readonly kind: 'importing'; readonly progress: ImportProgress | null }
  | { readonly kind: 'ready'; readonly summary: ImportSummary }
  | { readonly kind: 'error'; readonly failure: DescribedSourceFailure };

/** Options accepted by {@link useSourcesController}. */
export interface UseSourcesControllerOptions {
  catalog: CatalogService;
  playbackGuard?: PlaybackGuard;
  sourceImportHost?: SourceImportHost;
  externalRefreshToken?: number;
  /** Localized fallback name when a picked local playlist file has no usable stem (`#51`). */
  defaultLocalPlaylistName?: string;
  /** Optional OS-launched local playlist file to stage into the M3U form (`#259`). */
  incomingLocalPlaylist?: PickedPlaylistFile | null;
  /** Called after {@link incomingLocalPlaylist} has been staged into the form (`#259`). */
  onConsumeIncomingLocalPlaylist?: () => void;
}

/** Reactive state and actions exposed to {@link SourcesScreen}. */
export interface SourcesController {
  form: SourceFormState;
  showAdvanced: boolean;
  detectedXtreamInM3u: boolean;
  formError: DescribedSourceFailure | null;
  clipboardNotice: MessageId | null;
  submitting: boolean;
  sources: readonly SourceRow[];
  statusById: Readonly<Record<string, SourceRuntimeStatus>>;
  canRefreshGuide: boolean;
  canPasteClipboard: boolean;
  canPickLocalFile: boolean;
  canChooseCategories: boolean;
  categoryPicker: CategoryPickerState | null;
  setMode(mode: 'xtream' | 'm3u'): void;
  updateField<K extends keyof SourceFormState>(key: K, value: SourceFormState[K]): void;
  toggleAdvanced(): void;
  pasteFromClipboard(): Promise<void>;
  pickLocalFile(): Promise<void>;
  clearLocalFile(): void;
  submit(opts?: { readonly chooseCategories?: boolean }): Promise<void>;
  openCategoryPicker(source: SourceRow): Promise<void>;
  toggleCategorySelection(key: string): void;
  selectAllCategories(): void;
  clearAllCategories(): void;
  confirmCategorySelection(): Promise<void>;
  closeCategoryPicker(): void;
  includePendingCategories(source: SourceRow): Promise<void>;
  dismissPendingCategories(source: SourceRow): Promise<void>;
  runImport(sourceId: string): Promise<void>;
  runGuideRefresh(sourceId: string): Promise<void>;
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

function defaultSourceNameFromFilename(filename: string): string {
  return filename.replace(/\.(?:m3u\.gz|m3u8?|gz)$/i, '').trim();
}

/** Stateful view-model hook coordinating `CatalogService` operations for `SourcesScreen`. */
export function useSourcesController({
  catalog,
  playbackGuard = noopPlaybackGuard,
  sourceImportHost,
  externalRefreshToken = 0,
  defaultLocalPlaylistName,
  incomingLocalPlaylist,
  onConsumeIncomingLocalPlaylist,
}: UseSourcesControllerOptions): SourcesController {
  const [form, setForm] = useState<SourceFormState>(createInitialSourceForm);
  const formRef = useRef<SourceFormState>(form);
  formRef.current = form;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formError, setFormError] = useState<DescribedSourceFailure | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<MessageId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sources, setSources] = useState<readonly SourceRow[]>([]);
  const [statusById, setStatusById] = useState<Record<string, SourceRuntimeStatus>>({});
  const [categoryPicker, setCategoryPicker] = useState<CategoryPickerState | null>(null);
  const categoryPickerRef = useRef(categoryPicker);
  categoryPickerRef.current = categoryPicker;
  const discoverCtlRef = useRef<AbortController | null>(null);
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
      discoverCtlRef.current?.abort();
      discoverCtlRef.current = null;
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
    setClipboardNotice(null);
  }, []);

  const updateField = useCallback(
    <K extends keyof SourceFormState>(key: K, value: SourceFormState[K]) => {
      const next = { ...formRef.current, [key]: value };
      formRef.current = next;
      setForm(next);
      setFormError(null);
      if (key === 'playlistUrl') setClipboardNotice(null);
    },
    [],
  );

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced((prev) => !prev);
  }, []);

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const read = sourceImportHost?.readClipboardText;
    if (read === undefined) return;
    setClipboardNotice(null);
    try {
      const raw = await read();
      if (!mountedRef.current) return;
      const trimmed = raw?.trim() ?? '';
      if (trimmed === '') {
        setClipboardNotice('sources.clipboardEmpty');
        return;
      }
      const next = { ...formRef.current, playlistUrl: trimmed, localFile: null };
      formRef.current = next;
      setForm(next);
      setFormError(null);
    } catch {
      if (mountedRef.current) setClipboardNotice('sources.clipboardEmpty');
    }
  }, [sourceImportHost]);

  const pickLocalFile = useCallback(async (): Promise<void> => {
    const pick = sourceImportHost?.pickPlaylistFile;
    if (pick === undefined) return;
    try {
      const picked = await pick();
      if (!mountedRef.current || picked === null) return;
      const defaultName = defaultSourceNameFromFilename(picked.name);
      const next: SourceFormState = {
        ...formRef.current,
        localFile: picked,
        name: formRef.current.name.trim() === '' ? defaultName : formRef.current.name,
      };
      formRef.current = next;
      setForm(next);
      setFormError(null);
      setClipboardNotice(null);
    } catch {
      // Cancelled or unavailable picker leaves form intact.
    }
  }, [sourceImportHost]);

  const onConsumeIncomingRef = useRef(onConsumeIncomingLocalPlaylist);
  onConsumeIncomingRef.current = onConsumeIncomingLocalPlaylist;
  const lastConsumedIncomingRef = useRef<PickedPlaylistFile | null>(null);

  useEffect(() => {
    if (
      incomingLocalPlaylist == null ||
      incomingLocalPlaylist === lastConsumedIncomingRef.current
    ) {
      return;
    }
    lastConsumedIncomingRef.current = incomingLocalPlaylist;
    discoverCtlRef.current?.abort();
    discoverCtlRef.current = null;
    setCategoryPicker(null);
    const defaultName = defaultSourceNameFromFilename(incomingLocalPlaylist.name);
    const next: SourceFormState = {
      ...formRef.current,
      mode: 'm3u',
      playlistUrl: '',
      localFile: incomingLocalPlaylist,
      name: defaultName,
    };
    formRef.current = next;
    setForm(next);
    setFormError(null);
    setClipboardNotice(null);
    onConsumeIncomingRef.current?.();
  }, [incomingLocalPlaylist]);

  const clearLocalFile = useCallback(() => {
    const next = { ...formRef.current, localFile: null };
    formRef.current = next;
    setForm(next);
    setFormError(null);
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

  const runGuideRefresh = useCallback(
    async (sourceId: string): Promise<void> => {
      const importGuide = catalog.importGuide;
      if (
        importGuide === undefined ||
        controllersRef.current.has(sourceId) ||
        removedIdsRef.current.has(sourceId)
      ) {
        return;
      }
      const previousStatus = statusByIdRef.current[sourceId];
      const ctl = new AbortController();
      controllersRef.current.set(sourceId, ctl);
      setStatus(sourceId, { kind: 'importing', progress: null });

      const result = await importGuide(sourceId, {
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
        if (result.error.category === 'network' && result.error.code === 'aborted') {
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
      if (previousStatus?.kind === 'ready') {
        setStatus(sourceId, previousStatus);
      } else {
        setStatusById((prev) => {
          const next = { ...prev };
          delete next[sourceId];
          return next;
        });
      }
    },
    [catalog, refreshSources, setStatus],
  );

  const cancelImport = useCallback((sourceId: string) => {
    controllersRef.current.get(sourceId)?.abort();
  }, []);

  const closeCategoryPicker = useCallback(() => {
    discoverCtlRef.current?.abort();
    discoverCtlRef.current = null;
    setCategoryPicker(null);
  }, []);

  const openCategoryPicker = useCallback(
    async (source: SourceRow): Promise<void> => {
      const discover = catalog.discoverSourceCategories;
      if (discover === undefined) return;
      discoverCtlRef.current?.abort();
      const ctl = new AbortController();
      discoverCtlRef.current = ctl;
      setCategoryPicker({
        sourceId: source.id,
        sourceName: source.name,
        categories: [],
        selectedKeys: new Set<string>(),
        loading: true,
        saving: false,
        error: null,
      });
      const res = await discover(source.id, { signal: ctl.signal });
      if (discoverCtlRef.current === ctl) discoverCtlRef.current = null;
      if (!mountedRef.current || ctl.signal.aborted) return;
      if (!res.ok) {
        setCategoryPicker({
          sourceId: source.id,
          sourceName: source.name,
          categories: [],
          selectedKeys: new Set<string>(),
          loading: false,
          saving: false,
          error: describeSourceFailure(res.error),
        });
        return;
      }
      setCategoryPicker({
        sourceId: source.id,
        sourceName: source.name,
        categories: res.value,
        selectedKeys: initialSelectedCategoryKeys(res.value, source.categorySelection),
        loading: false,
        saving: false,
        error: null,
      });
    },
    [catalog],
  );

  const toggleCategorySelection = useCallback((key: string) => {
    setCategoryPicker((prev) => {
      if (prev === null) return null;
      const next = new Set(prev.selectedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, selectedKeys: next };
    });
  }, []);

  const selectAllCategories = useCallback(() => {
    setCategoryPicker((prev) => {
      if (prev === null) return null;
      return {
        ...prev,
        selectedKeys: new Set(prev.categories.map((c) => discoveredCategoryKey(c.kind, c.id))),
      };
    });
  }, []);

  const clearAllCategories = useCallback(() => {
    setCategoryPicker((prev) => (prev === null ? null : { ...prev, selectedKeys: new Set() }));
  }, []);

  const confirmCategorySelection = useCallback(async (): Promise<void> => {
    const picker = categoryPickerRef.current;
    if (picker === null || picker.loading || picker.saving) return;
    setCategoryPicker((prev) => (prev === null ? null : { ...prev, saving: true }));
    const selection = buildCategorySelection(picker.categories, picker.selectedKeys);
    try {
      await catalog.updateSourceSettings?.(picker.sourceId, { categorySelection: selection });
      if (!mountedRef.current) return;
      setCategoryPicker(null);
      await refreshSources();
      void runImport(picker.sourceId);
    } catch {
      if (mountedRef.current) {
        setCategoryPicker((prev) => (prev === null ? null : { ...prev, saving: false }));
      }
    }
  }, [catalog, refreshSources, runImport]);

  const includePendingCategories = useCallback(
    async (source: SourceRow): Promise<void> => {
      if (source.categorySelection === undefined || catalog.updateSourceSettings === undefined) {
        return;
      }
      const merged = mergePendingCategories(source.categorySelection);
      await catalog.updateSourceSettings(source.id, { categorySelection: merged });
      if (!mountedRef.current) return;
      await refreshSources();
      void runImport(source.id);
    },
    [catalog, refreshSources, runImport],
  );

  const dismissPendingCategories = useCallback(
    async (source: SourceRow): Promise<void> => {
      if (source.categorySelection === undefined || catalog.updateSourceSettings === undefined) {
        return;
      }
      const cleared = clearPendingCategories(source.categorySelection);
      await catalog.updateSourceSettings(source.id, { categorySelection: cleared });
      if (!mountedRef.current) return;
      await refreshSources();
    },
    [catalog, refreshSources],
  );

  const submit = useCallback(
    async (opts?: { readonly chooseCategories?: boolean }): Promise<void> => {
      if (submittingRef.current) return;
      const validated = validateSourceForm(
        formRef.current,
        defaultLocalPlaylistName !== undefined ? { defaultLocalPlaylistName } : undefined,
      );
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
            : validated.value.kind === 'local-m3u'
              ? catalog.addLocalM3uSource !== undefined
                ? await catalog.addLocalM3uSource(validated.value.input)
                : err(elvError('storage', 'unsupported'))
              : await catalog.addSourceFromLink(validated.value.input);

        if (!mountedRef.current) return;

        if (!added.ok) {
          setFormError(describeSourceFailure(added.error));
          return;
        }

        if (validated.value.kind === 'link' && validated.value.xmltvTimezone !== undefined) {
          await catalog.updateSourceSettings?.(added.value.id, {
            xmltvTimezone: validated.value.xmltvTimezone,
          });
        }

        removedIdsRef.current.delete(added.value.id);
        const resetForm: SourceFormState = {
          ...createInitialSourceForm(),
          mode: formRef.current.mode,
        };
        formRef.current = resetForm;
        setForm(resetForm);
        setClipboardNotice(null);
        await refreshSources();
        if (opts?.chooseCategories === true && catalog.discoverSourceCategories !== undefined) {
          void openCategoryPicker(added.value);
        } else {
          void runImport(added.value.id);
        }
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) {
          setSubmitting(false);
        }
      }
    },
    [catalog, defaultLocalPlaylistName, openCategoryPicker, refreshSources, runImport],
  );

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

  const detectedXtreamInM3u =
    form.mode === 'm3u' &&
    (form.localFile ?? null) === null &&
    detectPastedXtreamLink(form.playlistUrl);
  const canRefreshGuide = catalog.importGuide !== undefined;
  const canPasteClipboard = sourceImportHost?.readClipboardText !== undefined;
  const canPickLocalFile = sourceImportHost?.pickPlaylistFile !== undefined;
  const canChooseCategories =
    catalog.discoverSourceCategories !== undefined && catalog.updateSourceSettings !== undefined;

  return {
    form,
    showAdvanced,
    detectedXtreamInM3u,
    formError,
    clipboardNotice,
    submitting,
    sources,
    statusById,
    canRefreshGuide,
    canPasteClipboard,
    canPickLocalFile,
    canChooseCategories,
    categoryPicker,
    setMode,
    updateField,
    toggleAdvanced,
    pasteFromClipboard,
    pickLocalFile,
    clearLocalFile,
    submit,
    openCategoryPicker,
    toggleCategorySelection,
    selectAllCategories,
    clearAllCategories,
    confirmCategorySelection,
    closeCategoryPicker,
    includePendingCategories,
    dismissPendingCategories,
    runImport,
    runGuideRefresh,
    cancelImport,
    remove,
  };
}
