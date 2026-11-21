import type { CatalogService, SourceRow } from '@elv/data';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Options for {@link useShellSources}. */
export interface UseShellSourcesOptions {
  readonly catalog: CatalogService;
  readonly externalRefreshToken: number;
  readonly onEmptySources: () => void;
  readonly onInitialSourcesReady: () => void;
}

/** Source list, resolution flag, refresh/revision counters, and reconciliation helper for `AppShell`. */
export interface ShellSourcesState {
  readonly sources: readonly SourceRow[];
  readonly sourcesRef: { readonly current: readonly SourceRow[] };
  readonly sourcesResolved: boolean;
  readonly refreshToken: number;
  readonly catalogRevision: number;
  readonly bumpCatalogRevision: () => void;
  readonly syncSourcesAndBump: () => Promise<void>;
}

/**
 * Reconciles initial sources, background auto-imports for `needsImport` sources, external refresh
 * triggers, and monotonic `catalogRevision` bumps for {@link CatalogUiCache} invalidation (`#445`).
 */
export function useShellSources({
  catalog,
  externalRefreshToken,
  onEmptySources,
  onInitialSourcesReady,
}: UseShellSourcesOptions): ShellSourcesState {
  const [sources, setSources] = useState<readonly SourceRow[]>([]);
  const [sourcesResolved, setSourcesResolved] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(0);

  const mountedRef = useRef(true);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const autoImportedIdsRef = useRef(new Set<string>());
  const prevExternalRefreshRef = useRef(externalRefreshToken);
  const callbacksRef = useRef({ onEmptySources, onInitialSourcesReady });
  callbacksRef.current = { onEmptySources, onInitialSourcesReady };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const bumpCatalogRevision = useCallback(() => {
    setCatalogRevision((r) => r + 1);
  }, []);

  const syncSourcesAndBump = useCallback(async () => {
    try {
      const rows = await catalog.listSources();
      if (!mountedRef.current) return;
      setSources(rows);
      setSourcesResolved(true);
      if (rows.length === 0) callbacksRef.current.onEmptySources();
      setRefreshToken((n) => n + 1);
      setCatalogRevision((r) => r + 1);
    } catch {
      /* ignore transient catalog open errors in shell background refresh */
    }
  }, [catalog]);

  useEffect(() => {
    let cancelled = false;
    const externalChanged = prevExternalRefreshRef.current !== externalRefreshToken;
    prevExternalRefreshRef.current = externalRefreshToken;
    if (externalChanged) setCatalogRevision((r) => r + 1);

    void catalog
      .listSources()
      .then((initial) => {
        if (cancelled) return;
        setSources(initial);
        setSourcesResolved(true);
        if (initial.length === 0) callbacksRef.current.onEmptySources();
        setRefreshToken((n) => n + 1);
        if (initial.length > 0) callbacksRef.current.onInitialSourcesReady();
        for (const source of initial) {
          if (!source.needsImport || autoImportedIdsRef.current.has(source.id)) continue;
          autoImportedIdsRef.current.add(source.id);
          void catalog
            .importSource(source.id)
            .then((res) => (cancelled || !res.ok ? null : catalog.listSources()))
            .then((updated) => {
              if (cancelled || !updated) return;
              setSources(updated);
              setRefreshToken((n) => n + 1);
              setCatalogRevision((r) => r + 1);
            })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setSourcesResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [catalog, externalRefreshToken]);

  return {
    sources,
    sourcesRef,
    sourcesResolved,
    refreshToken,
    catalogRevision,
    bumpCatalogRevision,
    syncSourcesAndBump,
  };
}
