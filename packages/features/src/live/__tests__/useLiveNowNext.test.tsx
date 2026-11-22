import type { CatalogService, NowNextEntry, ProgrammeRow } from '@elv/data';
import { act, render } from '@testing-library/react-native';
import { useEffect, useRef } from 'react';
import { useLiveNowNext } from '../useLiveNowNext';

function makeProgramme(channelKey: string, title: string, nowMs: number): ProgrammeRow {
  return {
    sourceId: 's1',
    guideId: `g:${channelKey}`,
    channelKey,
    start: nowMs - 60_000,
    stop: nowMs + 600_000,
    title,
    subTitle: null,
    description: null,
    episodeNum: null,
    icon: null,
  };
}

function makeStubCatalog(nowNext?: CatalogService['nowNext']): CatalogService {
  return {
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    listSources: jest.fn(),
    categories: jest.fn(),
    items: jest.fn(),
    seasons: jest.fn(),
    episodes: jest.fn(),
    resolveStream: jest.fn(),
    close: jest.fn(),
    ...(nowNext ? { nowNext } : {}),
  };
}

interface HarnessProps {
  catalog: CatalogService;
  nowMs: number;
  initialKeys?: readonly string[];
  fetchShortEpg?: (itemKey: string) => Promise<NowNextEntry | null>;
  onUpdate: (hook: ReturnType<typeof useLiveNowNext>) => void;
}

function LiveNowNextHarness({
  catalog,
  nowMs,
  initialKeys,
  fetchShortEpg,
  onUpdate,
}: HarnessProps) {
  const nowRef = useRef(() => nowMs);
  nowRef.current = () => nowMs;
  const hook = useLiveNowNext({
    catalog,
    refreshToken: 0,
    nowRef,
    ...(fetchShortEpg ? { fetchShortEpg } : {}),
  });
  onUpdate(hook);
  useEffect(() => {
    if (initialKeys) hook.hydrateNowNext(initialKeys);
  }, [hook.hydrateNowNext, initialKeys]);
  return null;
}

describe('useLiveNowNext with optional lazy short-EPG LIFO queue (#217)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('preserves existing SQLite nowNext behavior when fetchShortEpg is omitted', async () => {
    const nowMs = 1_700_000_000_000;
    const prog = makeProgramme('ch-1', 'Evening News', nowMs);
    const nowNext = jest.fn(async (keys: readonly string[]) =>
      keys.map((k) => ({
        channelKey: k,
        now: k === 'ch-1' ? prog : null,
        next: null,
      })),
    );
    const catalog = makeStubCatalog(nowNext);
    const initialKeys = ['ch-1', 'ch-2'];
    let latest: ReturnType<typeof useLiveNowNext> | undefined;

    const view = await render(
      <LiveNowNextHarness
        catalog={catalog}
        nowMs={nowMs}
        initialKeys={initialKeys}
        onUpdate={(h) => {
          latest = h;
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nowNext).toHaveBeenCalledTimes(1);
    expect(latest?.byKey.get('ch-1')?.now?.title).toBe('Evening News');
    expect(latest?.byKey.get('ch-2')?.now).toBeNull();
    await view.unmount();
  });

  it('lazily fills missing rows via LIFO short-EPG queue in batched 150ms updates without request storms', async () => {
    jest.useFakeTimers();
    const nowMs = 1_700_000_000_000;
    const nowNext = jest.fn(async (keys: readonly string[]) =>
      keys.map((k) => ({
        channelKey: k,
        now: k === 'ch-1' ? makeProgramme('ch-1', 'XMLTV Show', nowMs) : null,
        next: null,
      })),
    );
    const fetchedKeys: string[] = [];
    const fetchShortEpg = jest.fn(async (itemKey: string): Promise<NowNextEntry | null> => {
      fetchedKeys.push(itemKey);
      return {
        channelKey: itemKey,
        now: makeProgramme(itemKey, `ShortEPG ${itemKey}`, nowMs),
        next: null,
      };
    });
    const catalog = makeStubCatalog(nowNext);
    let latest: ReturnType<typeof useLiveNowNext> | undefined;

    const view = await render(
      <LiveNowNextHarness
        catalog={catalog}
        nowMs={nowMs}
        fetchShortEpg={fetchShortEpg}
        onUpdate={(h) => {
          latest = h;
        }}
      />,
    );

    await act(async () => {
      latest?.hydrateNowNext(['ch-1', 'ch-2', 'ch-3', 'ch-4']);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(fetchedKeys).not.toContain('ch-1');
    expect(fetchedKeys[0]).toBe('ch-4');
    expect(new Set(fetchedKeys)).toEqual(new Set(['ch-2', 'ch-3', 'ch-4']));

    await act(async () => {
      jest.advanceTimersByTime(150);
    });

    expect(latest?.byKey.get('ch-1')?.now?.title).toBe('XMLTV Show');
    expect(latest?.byKey.get('ch-4')?.now?.title).toBe('ShortEPG ch-4');
    expect(latest?.byKey.get('ch-3')?.now?.title).toBe('ShortEPG ch-3');
    expect(latest?.byKey.get('ch-2')?.now?.title).toBe('ShortEPG ch-2');
    await view.unmount();
  });

  it('re-enqueues and promotes previously evicted empty rows on scroll-back without refetching already-resolved keys', async () => {
    jest.useFakeTimers();
    const nowMs = 1_700_000_000_000;
    const nowNext = jest.fn(async (keys: readonly string[]) =>
      keys.map((k) => ({ channelKey: k, now: null, next: null })),
    );
    const fetchedKeys: string[] = [];
    const resolvers = new Map<string, (entry: NowNextEntry | null) => void>();
    const fetchShortEpg = jest.fn(
      (itemKey: string) =>
        new Promise<NowNextEntry | null>((resolve) => {
          fetchedKeys.push(itemKey);
          resolvers.set(itemKey, resolve);
        }),
    );
    const catalog = makeStubCatalog(nowNext);
    let latest: ReturnType<typeof useLiveNowNext> | undefined;

    const view = await render(
      <LiveNowNextHarness
        catalog={catalog}
        nowMs={nowMs}
        fetchShortEpg={fetchShortEpg}
        onUpdate={(h) => {
          latest = h;
        }}
      />,
    );

    // Enqueue 70 rows (two SQLite chunks of 60 + 10) -> ch-1..ch-10 get evicted from the 60-cap LIFO head
    const seventy = Array.from({ length: 70 }, (_, i) => `ch-${i + 1}`);
    await act(async () => {
      latest?.hydrateNowNext(seventy);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    // Resolve the 2 currently in-flight tail fetches (ch-70, ch-69), but before draining all 60,
    // scroll back up to ch-1 and ch-2!
    await act(async () => {
      latest?.hydrateNowNext(['ch-1', 'ch-2']);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    // Complete currently in-flight fetches so the worker pops the promoted tail (ch-2, ch-1) next
    await act(async () => {
      for (const [key, resolve] of [...resolvers.entries()]) {
        resolvers.delete(key);
        resolve({
          channelKey: key,
          now: makeProgramme(key, `Show ${key}`, nowMs),
          next: null,
        });
      }
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    // ch-2 and ch-1 must have been promoted to the tail and fetched immediately on scroll-back
    expect(fetchedKeys).toContain('ch-2');
    expect(fetchedKeys).toContain('ch-1');

    // Resolve ch-2 and ch-1 and flush the 150ms batch timer
    await act(async () => {
      for (const [key, resolve] of [...resolvers.entries()]) {
        resolvers.delete(key);
        resolve({
          channelKey: key,
          now: makeProgramme(key, `Show ${key}`, nowMs),
          next: null,
        });
      }
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(150);
    });

    expect(latest?.byKey.get('ch-1')?.now?.title).toBe('Show ch-1');
    expect(latest?.byKey.get('ch-2')?.now?.title).toBe('Show ch-2');
    await view.unmount();
  });
});
