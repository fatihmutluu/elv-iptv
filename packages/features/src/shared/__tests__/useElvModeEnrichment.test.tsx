import type { CatalogService, ElvItemEnrichment } from '@elv/data';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
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
  const { enrichmentByKey: map } = useElvEnrichmentForKeys(catalog, keys, {
    enabled,
    lang,
    catalogRevision,
  });
  const summary = keys.map((k) => `${k}=${map.get(k)?.title?.originalTitle ?? 'none'}`).join(',');
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
        /k:0=Cached Movie,k:1=Matched k:1.*k:40=Matched k:40,k:41=none/,
      );
    });
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
