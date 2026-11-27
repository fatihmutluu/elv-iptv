import type { CatalogService, ElvItemEnrichment } from '@elv/data';
import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  type UseElvEnrichmentForKeysResult,
  useElvBackgroundMatcher,
  useElvEnrichmentForKeys,
} from './useElvModeEnrichment';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeEnrichment(itemKey: string, title: string): ElvItemEnrichment {
  return {
    itemKey,
    sourceId: 's1',
    mediaType: 'movie',
    imdbId: 'tt1375666',
    confidence: 0.95,
    manualLock: false,
    title: {
      imdbId: 'tt1375666',
      mediaType: 'movie',
      originalTitle: title,
      englishTitle: title,
      localizedTitles: {},
      year: 2010,
      rating: 8.8,
      votes: 2_000_000,
      runtimeMin: 148,
      genres: ['Sci-Fi'],
      posterUrl: 'https://imdb.example/poster.jpg',
      backdropUrl: null,
      trailerStreamUrl: null,
      trailerYoutubeId: null,
      director: null,
      cast: [],
      mltImdbIds: [],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      synopses: {},
      detailFetchedAt: 1,
      updatedAt: 1,
    },
  };
}

function EnrichProbe({
  catalog,
  keys,
  enabled,
  lang,
  catalogRevision,
  onValue,
}: {
  readonly catalog: Partial<
    Pick<CatalogService, 'getElvEnrichmentForKeys' | 'enrichElvPriorityKeys'>
  >;
  readonly keys: readonly string[];
  readonly enabled: boolean;
  readonly lang: string;
  readonly catalogRevision: number;
  readonly onValue: (result: UseElvEnrichmentForKeysResult) => void;
}) {
  onValue(useElvEnrichmentForKeys(catalog, keys, { enabled, lang, catalogRevision }));
  return null;
}

function MatchProbe({
  catalog,
  enabled,
  lang,
  catalogRevision,
}: {
  readonly catalog: Partial<Pick<CatalogService, 'runElvBackgroundMatching'>>;
  readonly enabled: boolean;
  readonly lang: string;
  readonly catalogRevision: number;
}) {
  useElvBackgroundMatcher(catalog, { enabled, lang, catalogRevision });
  return null;
}

describe('useElvModeEnrichment (Vitest coverage #511)', () => {
  it('batches local lookup, caps priority keys at 40, resets on revision change, and handles disable', async () => {
    const db = new Map<string, ElvItemEnrichment>([['k:0', makeEnrichment('k:0', 'Cached')]]);
    const getElvEnrichmentForKeys = vi.fn(async (itemKeys: readonly string[]) => {
      const out = new Map<string, ElvItemEnrichment>();
      for (const k of itemKeys) {
        const hit = db.get(k);
        if (hit) out.set(k, hit);
      }
      return out;
    });
    const enrichElvPriorityKeys = vi.fn(async (missing: readonly string[]) => {
      for (const k of missing) db.set(k, makeEnrichment(k, `Matched ${k}`));
      return {
        scanned: missing.length,
        layer1Matched: 0,
        remoteMatched: missing.length,
        skipped: 0,
        aborted: false,
      };
    });

    const catalog = { getElvEnrichmentForKeys, enrichElvPriorityKeys };
    const keys = Array.from({ length: 42 }, (_, i) => `k:${i}`);
    let latest: UseElvEnrichmentForKeysResult = {
      enrichmentByKey: new Map(),
      resolvedKeys: new Set(),
      isKeyLookupPending: () => false,
    };

    const root = createRoot();
    await act(async () => {
      root.render(
        createElement(EnrichProbe, {
          catalog,
          keys,
          enabled: true,
          lang: 'tr',
          catalogRevision: 1,
          onValue: (m) => {
            latest = m;
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(enrichElvPriorityKeys).toHaveBeenCalledTimes(1);
    expect(enrichElvPriorityKeys.mock.calls[0]?.[0]).toHaveLength(40);
    expect(latest.enrichmentByKey.get('k:0')?.title?.originalTitle).toBe('Cached');
    expect(latest.enrichmentByKey.get('k:1')?.title?.originalTitle).toBe('Matched k:1');
    expect(latest.resolvedKeys.has('k:0')).toBe(true);
    expect(latest.isKeyLookupPending('k:0')).toBe(false);

    // Changing lang or catalogRevision clears stale enrichmentByKey & resolvedKeys immediately
    let resolveNext!: (m: Map<string, ElvItemEnrichment>) => void;
    const deferredGet = vi.fn(
      () =>
        new Promise<Map<string, ElvItemEnrichment>>((r) => {
          resolveNext = r;
        }),
    );
    await act(async () => {
      root.render(
        createElement(EnrichProbe, {
          catalog: { getElvEnrichmentForKeys: deferredGet },
          keys: ['k:0'],
          enabled: true,
          lang: 'en',
          catalogRevision: 2,
          onValue: (m) => {
            latest = m;
          },
        }),
      );
    });
    expect(latest.enrichmentByKey.size).toBe(0);
    expect(latest.resolvedKeys.size).toBe(0);
    expect(latest.isKeyLookupPending('k:0')).toBe(true);

    await act(async () => {
      resolveNext(new Map());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.resolvedKeys.has('k:0')).toBe(true);
    expect(latest.isKeyLookupPending('k:0')).toBe(false);

    // Disabling returns empty map cleanly and marks lookup not pending
    await act(async () => {
      root.render(
        createElement(EnrichProbe, {
          catalog,
          keys,
          enabled: false,
          lang: 'tr',
          catalogRevision: 2,
          onValue: (m) => {
            latest = m;
          },
        }),
      );
    });
    expect(latest.enrichmentByKey.size).toBe(0);
    expect(latest.isKeyLookupPending('k:0')).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });

  it('runs background matcher once per catalogRevision and aborts cleanly on unmount', async () => {
    let signal: AbortSignal | undefined;
    const runElvBackgroundMatching = vi.fn(async (opts?: { readonly signal?: AbortSignal }) => {
      signal = opts?.signal;
      return {
        scanned: 5,
        layer1Matched: 2,
        remoteMatched: 3,
        skipped: 0,
        aborted: false,
      };
    });
    const catalog = { runElvBackgroundMatching };

    const root = createRoot();
    await act(async () => {
      root.render(
        createElement(MatchProbe, { catalog, enabled: true, lang: 'en', catalogRevision: 1 }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runElvBackgroundMatching).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);

    // Same revision does not re-trigger
    await act(async () => {
      root.render(
        createElement(MatchProbe, { catalog, enabled: true, lang: 'en', catalogRevision: 1 }),
      );
      await Promise.resolve();
    });
    expect(runElvBackgroundMatching).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    expect(signal?.aborted).toBe(true);
  });
});
