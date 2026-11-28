import { describe, expect, it } from 'vitest';
import { createWorkbenchCatalog } from './mock-catalog.ts';

describe('createWorkbenchCatalog — Wave R3 recommendation dismissals', () => {
  it('dismisses, lists newest-first, isolates profiles, validates inputs, and restores keys', async () => {
    const catalog = createWorkbenchCatalog();

    expect(await catalog.listDismissedRecommendationKeys?.()).toEqual([]);

    await expect(catalog.dismissRecommendation?.('   ', 'movie')).rejects.toThrow();
    await expect(
      catalog.dismissRecommendation?.('wb:movie:401', 'live' as 'movie'),
    ).rejects.toThrow();

    await catalog.dismissRecommendation?.('wb:movie:401', 'movie');
    await catalog.dismissRecommendation?.('wb:series:601', 'series');
    await catalog.dismissRecommendation?.('wb:movie:402', 'movie', 'kids');

    expect(await catalog.listDismissedRecommendationKeys?.()).toEqual([
      'wb:series:601',
      'wb:movie:401',
    ]);
    expect(await catalog.listDismissedRecommendationKeys?.('kids')).toEqual(['wb:movie:402']);

    // Re-dismissing moves key to front without duplication
    await catalog.dismissRecommendation?.('wb:movie:401', 'movie');
    expect(await catalog.listDismissedRecommendationKeys?.()).toEqual([
      'wb:movie:401',
      'wb:series:601',
    ]);

    await catalog.restoreRecommendation?.('wb:movie:401');
    expect(await catalog.listDismissedRecommendationKeys?.()).toEqual(['wb:series:601']);
    expect(await catalog.listDismissedRecommendationKeys?.('kids')).toEqual(['wb:movie:402']);
  });
});
