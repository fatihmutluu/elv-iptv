import type { CatalogService } from '@elv/data';
import {
  type DownloadEnqueueInput,
  type DownloadManagerPort,
  type DownloadRecord,
  elvError,
  err,
  isPlayableDownload,
  ok,
  type Result,
} from '@elv/domain';
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/** Returns `true` when `record` represents an active or completed managed download (excluding canceled/failed). */
export function hasManagedDownload(record: DownloadRecord | undefined): boolean {
  return record !== undefined && record.status !== 'canceled' && record.status !== 'failed';
}

/** Reactive offline downloads state and actions exposed to all feature screens. */
export interface DownloadsContextValue {
  readonly supported: boolean;
  readonly records: readonly DownloadRecord[];
  readonly byItemKey: ReadonlyMap<string, DownloadRecord>;
  readonly completed: readonly DownloadRecord[];
  readonly enqueue: (input: DownloadEnqueueInput) => Promise<Result<DownloadRecord>>;
  readonly enqueueBatch: (
    inputs: readonly DownloadEnqueueInput[],
  ) => Promise<Result<readonly DownloadRecord[]>>;
  readonly pause: (itemKey: string) => Promise<Result<void>>;
  readonly resume: (itemKey: string) => Promise<Result<void>>;
  readonly cancel: (itemKey: string) => Promise<Result<void>>;
  readonly remove: (itemKey: string) => Promise<Result<void>>;
  readonly getOfflineUri: (itemKey: string) => string | null;
  readonly notifyOnlinePlaybackActive: (active: boolean) => void;
}

const UNSUPPORTED_RESULT = err(elvError('storage', 'unsupported'));
const MAX_ENQUEUE_BATCH_CHUNK = 500;

const DEFAULT_VALUE: DownloadsContextValue = {
  supported: false,
  records: [],
  byItemKey: new Map(),
  completed: [],
  enqueue: async () => UNSUPPORTED_RESULT,
  enqueueBatch: async () => UNSUPPORTED_RESULT,
  pause: async () => UNSUPPORTED_RESULT,
  resume: async () => UNSUPPORTED_RESULT,
  cancel: async () => UNSUPPORTED_RESULT,
  remove: async () => UNSUPPORTED_RESULT,
  getOfflineUri: () => null,
  notifyOnlinePlaybackActive: () => {},
};

const DownloadsContext = createContext<DownloadsContextValue>(DEFAULT_VALUE);

/** Props of {@link DownloadsProvider}. */
export interface DownloadsProviderProps {
  readonly manager?: DownloadManagerPort;
  readonly catalog?: CatalogService;
  readonly profileId?: string;
  readonly children: ReactNode;
}

/** Provides reactive offline VOD download state and actions across feature screens. */
export function DownloadsProvider({
  manager,
  catalog,
  profileId,
  children,
}: DownloadsProviderProps): ReactElement {
  const [records, setRecords] = useState<readonly DownloadRecord[]>([]);

  useEffect(() => {
    if (!manager) {
      setRecords([]);
      return;
    }
    let alive = true;
    void manager
      .list(profileId)
      .then((initial) => {
        if (alive) setRecords(initial);
      })
      .catch(() => {});
    const unsubscribe = manager.subscribe((next) => {
      if (!alive) return;
      if (profileId === undefined) {
        setRecords(next);
      } else {
        setRecords(next.filter((r) => r.profileId === profileId));
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [manager, profileId]);

  const byItemKey = useMemo(() => {
    const map = new Map<string, DownloadRecord>();
    for (const r of records) map.set(r.itemKey, r);
    return map;
  }, [records]);

  const completed = useMemo(() => records.filter(isPlayableDownload), [records]);

  const enqueue = useCallback(
    async (input: DownloadEnqueueInput): Promise<Result<DownloadRecord>> => {
      if (!manager?.supported) return UNSUPPORTED_RESULT;
      let resolvedUrl = input.streamUrl;
      let resolvedHeaders = input.headers;
      if (!resolvedUrl && catalog?.resolveStream) {
        const res = await catalog.resolveStream(input.itemKey);
        if (!res.ok) return res;
        resolvedUrl = res.value.url;
        resolvedHeaders = res.value.headers;
      }
      const effectiveProfileId = input.profileId ?? profileId;
      return manager.enqueue({
        ...input,
        ...(effectiveProfileId !== undefined ? { profileId: effectiveProfileId } : {}),
        ...(resolvedUrl !== undefined ? { streamUrl: resolvedUrl } : {}),
        ...(resolvedHeaders !== undefined ? { headers: resolvedHeaders } : {}),
      });
    },
    [catalog, manager, profileId],
  );

  const enqueueBatch = useCallback(
    async (inputs: readonly DownloadEnqueueInput[]): Promise<Result<readonly DownloadRecord[]>> => {
      if (!manager?.supported) return UNSUPPORTED_RESULT;
      if (inputs.length === 0) return ok([]);

      const normalized = inputs.map((input) => {
        const effectiveProfileId = input.profileId ?? profileId;
        return effectiveProfileId !== undefined
          ? { ...input, profileId: effectiveProfileId }
          : { ...input };
      });

      const enqueueSequentially = async (
        items: readonly DownloadEnqueueInput[],
        alreadyEnqueued: DownloadRecord[],
      ): Promise<Result<readonly DownloadRecord[]>> => {
        const out = [...alreadyEnqueued];
        for (const item of items) {
          const existing = byItemKey.get(item.itemKey);
          if (
            existing &&
            (existing.status === 'queued' ||
              existing.status === 'downloading' ||
              isPlayableDownload(existing))
          ) {
            continue;
          }
          const res = await enqueue(item);
          if (!res.ok) {
            return out.length > 0 ? ok(out) : res;
          }
          out.push(res.value);
        }
        return ok(out);
      };

      if (typeof manager.enqueueBatch === 'function') {
        const collected: DownloadRecord[] = [];
        for (let offset = 0; offset < normalized.length; offset += MAX_ENQUEUE_BATCH_CHUNK) {
          const chunk = normalized.slice(offset, offset + MAX_ENQUEUE_BATCH_CHUNK);
          const res = await manager.enqueueBatch(chunk);
          if (res.ok) {
            collected.push(...res.value);
            continue;
          }
          if (res.error.code === 'invalid-download-url' && catalog?.resolveStream) {
            return enqueueSequentially(normalized.slice(offset), collected);
          }
          return res;
        }
        return ok(collected);
      }

      return enqueueSequentially(normalized, []);
    },
    [byItemKey, catalog, enqueue, manager, profileId],
  );

  const pause = useCallback(
    (itemKey: string) =>
      manager?.supported ? manager.pause(itemKey, profileId) : Promise.resolve(UNSUPPORTED_RESULT),
    [manager, profileId],
  );

  const resume = useCallback(
    async (itemKey: string): Promise<Result<void>> => {
      if (!manager?.supported) return UNSUPPORTED_RESULT;
      const res = await manager.resume(itemKey, profileId);
      if (!res.ok && res.error.code === 'download-source-unavailable' && catalog?.resolveStream) {
        const record = byItemKey.get(itemKey) ?? (await manager.get(itemKey, profileId));
        if (!record) return res;
        const resolved = await catalog.resolveStream(itemKey);
        if (!resolved.ok) return resolved;
        const enqueued = await manager.enqueue({
          profileId: profileId ?? record.profileId,
          sourceId: record.sourceId,
          itemKey: record.itemKey,
          kind: record.kind,
          title: record.title,
          ...(record.seriesKey !== undefined ? { seriesKey: record.seriesKey } : {}),
          ...(record.seriesTitle !== undefined ? { seriesTitle: record.seriesTitle } : {}),
          ...(record.season !== undefined ? { season: record.season } : {}),
          ...(record.episodeNum !== undefined ? { episodeNum: record.episodeNum } : {}),
          ...(record.poster !== undefined ? { poster: record.poster } : {}),
          streamUrl: resolved.value.url,
          ...(resolved.value.headers !== undefined ? { headers: resolved.value.headers } : {}),
        });
        if (!enqueued.ok) return enqueued;
        return ok(undefined);
      }
      return res;
    },
    [byItemKey, catalog, manager, profileId],
  );

  const cancel = useCallback(
    (itemKey: string) =>
      manager?.supported ? manager.cancel(itemKey, profileId) : Promise.resolve(UNSUPPORTED_RESULT),
    [manager, profileId],
  );

  const remove = useCallback(
    (itemKey: string) =>
      manager?.supported ? manager.remove(itemKey, profileId) : Promise.resolve(UNSUPPORTED_RESULT),
    [manager, profileId],
  );

  const getOfflineUri = useCallback(
    (itemKey: string): string | null => {
      const rec = byItemKey.get(itemKey);
      return rec && isPlayableDownload(rec) ? rec.localUri : null;
    },
    [byItemKey],
  );

  const notifyOnlinePlaybackActive = useCallback(
    (active: boolean) => {
      void manager?.notifyOnlinePlaybackActive?.(active);
    },
    [manager],
  );

  const value = useMemo<DownloadsContextValue>(
    () => ({
      supported: manager?.supported ?? false,
      records,
      byItemKey,
      completed,
      enqueue,
      enqueueBatch,
      pause,
      resume,
      cancel,
      remove,
      getOfflineUri,
      notifyOnlinePlaybackActive,
    }),
    [
      byItemKey,
      cancel,
      completed,
      enqueue,
      enqueueBatch,
      getOfflineUri,
      manager?.supported,
      notifyOnlinePlaybackActive,
      pause,
      records,
      remove,
      resume,
    ],
  );

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

/** Reads reactive offline download state and actions (returns safe unsupported defaults outside provider). */
export function useDownloads(): DownloadsContextValue {
  return useContext(DownloadsContext);
}
