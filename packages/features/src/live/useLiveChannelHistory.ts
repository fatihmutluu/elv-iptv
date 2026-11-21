import type { CatalogService, ItemRow } from '@elv/data';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PagedListSource } from '../shared';
import { LIVE_PAGE_SIZE, recordChannelTune } from './live-model';

/** Active and previous channel history snapshot inside Live TV. */
export interface LiveChannelHistory {
  readonly active: ItemRow | null;
  readonly activeIndex: number;
  readonly previous: ItemRow | null;
  readonly previousIndex: number;
}

const EMPTY_CHANNEL_HISTORY: LiveChannelHistory = {
  active: null,
  activeIndex: 0,
  previous: null,
  previousIndex: 0,
};

function findChannelByKey(source: PagedListSource<ItemRow>, key: string) {
  const limit = Math.min(source.count(), LIVE_PAGE_SIZE);
  for (let i = 0; i < limit; i++) {
    const candidate = source.get(i);
    if (candidate?.key === key) return { item: candidate, index: i };
  }
  return null;
}

function findInitialChannel(source: PagedListSource<ItemRow>, preferredKey: string | null) {
  if (preferredKey !== null) {
    const matched = findChannelByKey(source, preferredKey);
    if (matched) return matched;
  }
  const first = source.get(0);
  return first ? { item: first, index: 0 } : null;
}

/** Manages Live TV active/previous channel hydration from session memory and tuning (`#43`). */
export function useLiveChannelHistory(opts: {
  readonly catalog: CatalogService;
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly sourceVersion: number;
  readonly activeChannelKey: string | null;
  readonly previousChannelKey: string | null;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onChannelHistoryChange?: (next: {
    readonly activeChannelKey: string | null;
    readonly previousChannelKey: string | null;
  }) => void;
}): {
  readonly history: LiveChannelHistory;
  readonly historyRef: MutableRefObject<LiveChannelHistory>;
  readonly resetHistory: () => void;
  readonly tuneChannel: (channel: ItemRow, index?: number) => void;
  readonly tunePreviousChannel: () => ItemRow | null;
} {
  const { catalog, channelSource, sourceVersion, activeChannelKey, previousChannelKey } = opts;
  const { hydrateNowNext, onChannelHistoryChange } = opts;

  const [history, setHistory] = useState<LiveChannelHistory>(() => {
    if (!channelSource) return EMPTY_CHANNEL_HISTORY;
    const hit = findInitialChannel(channelSource, activeChannelKey);
    return hit
      ? { ...EMPTY_CHANNEL_HISTORY, active: hit.item, activeIndex: hit.index }
      : EMPTY_CHANNEL_HISTORY;
  });

  const historyRef = useRef(history);
  historyRef.current = history;
  const onChangeRef = useRef(onChannelHistoryChange);
  onChangeRef.current = onChannelHistoryChange;
  const aliveRef = useRef(true);
  const prevHydrateGenRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const resetHistory = useCallback(() => {
    prevHydrateGenRef.current += 1;
    historyRef.current = EMPTY_CHANNEL_HISTORY;
    setHistory(EMPTY_CHANNEL_HISTORY);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceVersion notifies when page 0 arrives
  useEffect(() => {
    if (!channelSource) return;
    const cur = historyRef.current;
    if (cur.active === null) {
      const hit = findInitialChannel(channelSource, activeChannelKey);
      if (hit) {
        const nextHistory: LiveChannelHistory = {
          ...cur,
          active: hit.item,
          activeIndex: hit.index,
        };
        historyRef.current = nextHistory;
        setHistory(nextHistory);
        hydrateNowNext([hit.item.key]);
        onChangeRef.current?.({ activeChannelKey: hit.item.key, previousChannelKey });
      }
    }
    const afterActive = historyRef.current;
    if (!previousChannelKey || afterActive.previous?.key === previousChannelKey) return;
    const prevHit = findChannelByKey(channelSource, previousChannelKey);
    if (prevHit) {
      const nextHistory: LiveChannelHistory = {
        ...afterActive,
        previous: prevHit.item,
        previousIndex: prevHit.index,
      };
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      return;
    }
    if (!catalog.itemDetail) return;
    const gen = ++prevHydrateGenRef.current;
    void catalog
      .itemDetail(previousChannelKey)
      .then((detail) => {
        if (!aliveRef.current || prevHydrateGenRef.current !== gen || !detail) return;
        const latestHist = historyRef.current;
        if (latestHist.previous?.key === detail.key) return;
        const nextHistory: LiveChannelHistory = {
          ...latestHist,
          previous: detail,
          previousIndex: 0,
        };
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      })
      .catch(() => undefined);
  }, [activeChannelKey, catalog, channelSource, hydrateNowNext, previousChannelKey, sourceVersion]);

  const tuneChannel = useCallback(
    (channel: ItemRow, index?: number) => {
      prevHydrateGenRef.current += 1;
      const cur = historyRef.current;
      const keyHistory = recordChannelTune(
        {
          activeChannelKey: cur.active?.key ?? null,
          previousChannelKey: cur.previous?.key ?? null,
        },
        channel.key,
      );
      const changed = cur.active !== null && cur.active.key !== channel.key;
      const nextHistory: LiveChannelHistory = {
        active: channel,
        activeIndex: index ?? cur.activeIndex,
        previous: changed ? cur.active : cur.previous,
        previousIndex: changed ? cur.activeIndex : cur.previousIndex,
      };
      historyRef.current = nextHistory;
      setHistory(nextHistory);
      hydrateNowNext([channel.key]);
      onChangeRef.current?.(keyHistory);
    },
    [hydrateNowNext],
  );

  const tunePreviousChannel = useCallback((): ItemRow | null => {
    const cur = historyRef.current;
    if (!cur.previous) return null;
    tuneChannel(cur.previous, cur.previousIndex);
    return cur.previous;
  }, [tuneChannel]);

  return { history, historyRef, resetHistory, tuneChannel, tunePreviousChannel };
}
