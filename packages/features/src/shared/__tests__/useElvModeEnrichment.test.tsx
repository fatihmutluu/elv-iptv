import type { CatalogService, ElvItemEnrichment } from '@elv/data';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import { CatalogUiCacheProvider } from '../CatalogUiCacheProvider';
import { createCatalogUiCache } from '../catalog-ui-cache';
import { useElvBackgroundMatcher, useElvEnrichmentForKeys } from '../useElvModeEnrichment';

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

function EnrichmentProbe({
  catalog,
  keys,
  enabled,
  lang,
  catalogRevision,
}: {
  readonly catalog: Partial<
    Pick<CatalogService, 'getElvEnrichmentForKeys' | 'enrichElvPriorityKeys'>
  >;
  readonly keys: readonly string[];
  readonly enabled: boolean;
  readonly lang: string;
  readonly catalogRevision: number;
}): ReactElement {
  const { enrichmentByKey: map, isKeyLookupPending } = useElvEnrichmentForKeys(catalog, keys, {
    enabled,
    lang,
    catalogRevision,
  });
  const summary = keys
    .map(
      (k) =>
        `${k}=${map.get(k)?.title?.originalTitle ?? 'none'}(${isKeyLookupPending(k) ? 'pending' : 'settled'})`,
    )
    .join(',');
  return <Text testID="enrichment-summary">{summary}</Text>;
}

function MatcherProbe({
  catalog,
  enabled,
  lang,
  catalogRevision,
}: {
  readonly catalog: Partial<Pick<CatalogService, 'runElvBackgroundMatching'>>;
  readonly enabled: boolean;
  readonly lang: string;
  readonly catalogRevision: number;
}): null {
  useElvBackgroundMatcher(catalog, { enabled, lang, catalogRevision });
  return null;
}

describe('useElvEnrichmentForKeys & useElvBackgroundMatcher (Wave E1 #511)', () => {
  it('batches local enrichment lookup, caps missing priority keys at 40, and updates smoothly when priority matching completes', async () => {
    const db = new Map<string, ElvItemEnrichment>([['k:0', makeEnrichment('k:0', 'Cached Movie')]]);
    const getElvEnrichmentForKeys = jest.fn(async (itemKeys: readonly string[]) => {
      const out = new Map<string, ElvItemEnrichment>();
      for (const k of itemKeys) {
        const hit = db.get(k);
        if (hit) out.set(k, hit);
      }
      return out;
    });
    const enrichElvPriorityKeys = jest.fn(async (missing: readonly string[]) => {
      for (const k of missing) {
        db.set(k, makeEnrichment(k, `Matched ${k}`));
      }
      return {
        scanned: missing.length,
        layer1Matched: 0,
        remoteMatched: missing.length,
        skipped: 0,
        aborted: false,
      };
    });

    const keys = Array.from({ length: 45 }, (_, i) => `k:${i}`);
    await render(
      <EnrichmentProbe
        catalog={{ getElvEnrichmentForKeys, enrichElvPriorityKeys }}
        keys={keys}
        enabled
        lang="tr"
        catalogRevision={1}
      />,
    );

    await waitFor(() => {
      expect(enrichElvPriorityKeys).toHaveBeenCalledTimes(1);
    });
    // Capped strictly at 40 missing keys (k:0 was cached, so k:1..k:40)
    const calledMissing = enrichElvPriorityKeys.mock.calls[0]?.[0] ?? [];
    expect(calledMissing).toHaveLength(40);
    expect(calledMissing[0]).toBe('k:1');

    await waitFor(() => {
      expect(screen.getByTestId('enrichment-summary')).toHaveTextContent(
        /k:0=Cached Movie\(settled\),k:1=Matched k:1\(settled\).*k:40=Matched k:40\(settled\),k:41=none\(settled\)/,
      );
    });
  });

  it('hydrates synchronously on tab remount with zero isKeyLookupPending flash for matched and unmatched keys', async () => {
    const db = new Map<string, ElvItemEnrichment>([['k:0', makeEnrichment('k:0', 'Inception')]]);
    const getElvEnrichmentForKeys = jest.fn(async (itemKeys: readonly string[]) => {
      const out = new Map<string, ElvItemEnrichment>();
      for (const k of itemKeys) {
        const hit = db.get(k);
        if (hit) out.set(k, hit);
      }
      return out;
    });
    const catalog = { getElvEnrichmentForKeys };
    const uiCache = createCatalogUiCache({ revision: 1, locale: 'tr' });

    const firstMount = await render(
      <CatalogUiCacheProvider cache={uiCache}>
        <EnrichmentProbe
          catalog={catalog}
          keys={['k:0', 'k:1']}
          enabled
          lang="tr"
          catalogRevision={1}
        />
      </CatalogUiCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('enrichment-summary')).toHaveTextContent(
        'k:0=Inception(settled),k:1=none(settled)',
      );
    });
    await firstMount.unmount();

    // Simulate slow/pending lookup on remount: synchronous frame 0 must already show cached result & settled state
    let resolveRemount!: (value: Map<string, ElvItemEnrichment>) => void;
    const pendingRemountGet = jest.fn(
      () =>
        new Promise<Map<string, ElvItemEnrichment>>((resolve) => {
          resolveRemount = resolve;
        }),
    );

    const remount = await render(
      <CatalogUiCacheProvider cache={uiCache}>
        <EnrichmentProbe
          catalog={{ getElvEnrichmentForKeys: pendingRemountGet }}
          keys={['k:0', 'k:1']}
          enabled
          lang="tr"
          catalogRevision={1}
        />
      </CatalogUiCacheProvider>,
    );

    expect(screen.getByTestId('enrichment-summary')).toHaveTextContent(
      'k:0=Inception(settled),k:1=none(settled)',
    );

    // Also verify standalone remount without CatalogUiCacheProvider uses catalog+lang WeakMap cache
    await remount.unmount();
    const standalone1 = await render(
      <EnrichmentProbe catalog={catalog} keys={['k:0']} enabled lang="tr" catalogRevision={1} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('enrichment-summary')).toHaveTextContent('k:0=Inception(settled)');
    });
    await standalone1.unmount();

    const standalone2 = await render(
      <EnrichmentProbe catalog={catalog} keys={['k:0']} enabled lang="tr" catalogRevision={1} />,
    );
    expect(screen.getByTestId('enrichment-summary')).toHaveTextContent('k:0=Inception(settled)');
    resolveRemount(new Map([['k:0', makeEnrichment('k:0', 'Inception')]]));
    await standalone2.unmount();
  });

  it('keeps previous resolved posters visible during catalogRevision bumps (stale-while-revalidate) and clears cleanly on lang change', async () => {
    let resolveRev2!: (value: Map<string, ElvItemEnrichment>) => void;
    let resolveLangEn!: (value: Map<string, ElvItemEnrichment>) => void;
    let callIdx = 0;
    const getElvEnrichmentForKeys = jest.fn(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return Promise.resolve(new Map([['k:0', makeEnrichment('k:0', 'Dune TR')]]));
      }
      if (callIdx === 2) {
        return new Promise<Map<string, ElvItemEnrichment>>((resolve) => {
          resolveRev2 = resolve;
        });
      }
      return new Promise<Map<string, ElvItemEnrichment>>((resolve) => {
        resolveLangEn = resolve;
      });
    });

    const catalog = { getElvEnrichmentForKeys };
    const view = await render(
      <EnrichmentProbe catalog={catalog} keys={['k:0']} enabled lang="tr" catalogRevision={1} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('enrichment-summary')).toHaveTextContent('k:0=Dune TR(settled)');
    });

    // Bumping catalogRevision while lookup is in-flight MUST keep previous resolved entry & settled state
    await view.rerender(
      <EnrichmentProbe catalog={catalog} keys={['k:0']} enabled lang="tr" catalogRevision={2} />,
    );
    expect(screen.getByTestId('enrichment-summary')).toHaveTextContent('k:0=Dune TR(settled)');

    // Once rev 2 SQLite lookup settles with updated metadata, display updates cleanly
    resolveRev2(new Map([['k:0', makeEnrichment('k:0', 'Dune Updated')]]));
    await waitFor(() => {
      expect(screen.getByTestId('enrichment-summary')).toHaveTextContent(
        'k:0=Dune Updated(settled)',
      );
    });

    // Changing lang refreshes cleanly and marks lookup pending until new lang settles
    await view.rerender(
      <EnrichmentProbe catalog={catalog} keys={['k:0']} enabled lang="en" catalogRevision={2} />,
    );
    expect(screen.getByTestId('enrichment-summary')).toHaveTextContent('k:0=none(pending)');

    resolveLangEn(new Map([['k:0', makeEnrichment('k:0', 'Dune EN')]]));
    await waitFor(() => {
      expect(screen.getByTestId('enrichment-summary')).toHaveTextContent('k:0=Dune EN(settled)');
    });
    await view.unmount();
  });

  it('does not query catalog when disabled', async () => {
    const getElvEnrichmentForKeys = jest.fn(async () => new Map());
    const enrichElvPriorityKeys = jest.fn();

    await render(
      <EnrichmentProbe
        catalog={{ getElvEnrichmentForKeys, enrichElvPriorityKeys }}
        keys={['k:1']}
        enabled={false}
        lang="en"
        catalogRevision={1}
      />,
    );

    expect(getElvEnrichmentForKeys).not.toHaveBeenCalled();
    expect(enrichElvPriorityKeys).not.toHaveBeenCalled();
  });

  it('runs background matcher once per catalogRevision and aborts cleanly on disable or unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runElvBackgroundMatching = jest.fn(async (opts?: { readonly signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return {
        scanned: 10,
        layer1Matched: 5,
        remoteMatched: 5,
        skipped: 0,
        aborted: false,
      };
    });

    const catalog = { runElvBackgroundMatching };
    const view = await render(
      <MatcherProbe catalog={catalog} enabled lang="en" catalogRevision={1} />,
    );

    await waitFor(() => {
      expect(runElvBackgroundMatching).toHaveBeenCalledTimes(1);
    });
    expect(capturedSignal?.aborted).toBe(false);

    // Same revision rerender does not duplicate run
    await view.rerender(<MatcherProbe catalog={catalog} enabled lang="en" catalogRevision={1} />);
    expect(runElvBackgroundMatching).toHaveBeenCalledTimes(1);

    // Unmount aborts the signal cleanly
    await view.unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
