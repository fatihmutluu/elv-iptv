import { describe, expect, it, vi } from 'vitest';
import { openElvEnrichmentStore } from './elv-enrichment-repo';
import { findGuideChannelByCleanName, normalizeLiveEpgTitle } from './elv-live-epg';
import { recordPlaybackVariantFailure } from './elv-quality-memory';
import { openCatalog } from './migrate';
import { queryLiveVariants } from './queries-variants';
import { testDb } from './test-db';

describe('Live TV ELV Mode: cross-category variants, healthy-first failover & clean-name EPG fallback (#511)', () => {
  it('collapses live variants across categories & sources when crossCategory is true and ranks healthy variants ahead of failed ones', async () => {
    const catalog = testDb();
    expect((await openCatalog(catalog.db)).ok).toBe(true);
    await catalog.db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Main IPTV', 1, '{}'],
        ['s2', 'xtream', 'Backup IPTV', 2, '{}'],
      ],
    );
    await catalog.db.batch(
      `INSERT INTO live (source_id, key, name, name_fold, variant_base_fold, quality_rank, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [
        ['s1', 'x:s1:live:4k', 'Sports One 4K', 'sports one 4k', 'sports one', 40],
        ['s1', 'x:s1:live:fhd', 'Sports One FHD', 'sports one fhd', 'sports one', 30],
        ['s1', 'x:s1:live:hd', 'Sports One HD', 'sports one hd', 'sports one', 20],
        ['s2', 'x:s2:live:fhd', 'Sports One 1080p', 'sports one 1080p', 'sports one', 30],
      ],
    );
    await catalog.db.batch(
      `INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id)
       VALUES (?, 'live', ?, ?, ?, 1)`,
      [
        ['s1', 'x:s1:live:4k', 'cat-4k', 0],
        ['s1', 'x:s1:live:fhd', 'cat-sports', 0],
        ['s1', 'x:s1:live:hd', 'cat-sports', 1],
        ['s2', 'x:s2:live:fhd', 'cat-other', 0],
      ],
    );

    const enrichment = testDb();
    const store = await openElvEnrichmentStore(enrichment.db, { clock: () => 5_000 });
    // 4K stream failed twice -> dead/unreliable!
    await recordPlaybackVariantFailure(store, 'x:s1:live:4k', 5_000);
    await recordPlaybackVariantFailure(store, 'x:s1:live:4k', 6_000);

    // Default behavior (crossCategory omitted/false) stays strictly scoped to cat-sports!
    const scoped = await queryLiveVariants(catalog.db, 'x:s1:live:fhd', 's1|live|cat-sports');
    expect(scoped.map((v) => v.key)).toEqual(['x:s1:live:fhd', 'x:s1:live:hd']);

    // crossCategory = true includes cat-4k too, demoting failed 4K below healthy FHD and HD!
    const crossCat = await queryLiveVariants(catalog.db, 'x:s1:live:fhd', 's1|live|cat-sports', {
      crossCategory: true,
      enrichmentStore: store,
    });
    expect(crossCat.map((v) => v.key)).toEqual(['x:s1:live:fhd', 'x:s1:live:hd', 'x:s1:live:4k']);
    expect(crossCat[2]?.isUnreliable).toBe(true);
    expect(crossCat[2]?.failCount).toBe(2);

    // crossCategory + crossSource includes Backup IPTV's healthy FHD ahead of dead 4K!
    const crossSrc = await queryLiveVariants(catalog.db, 'x:s1:live:fhd', 's1|live|cat-sports', {
      crossCategory: true,
      crossSource: true,
      enrichmentStore: store,
    });
    expect(crossSrc.map((v) => v.key)).toEqual([
      'x:s1:live:fhd',
      'x:s2:live:fhd',
      'x:s1:live:hd',
      'x:s1:live:4k',
    ]);
    expect(crossSrc[1]?.sourceName).toBe('Backup IPTV');
  });

  it('findGuideChannelByCleanName matches live channels missing tvg-id via cleaned display title', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
    );
    await db.batch(
      `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, run_id)
       VALUES ('s1', ?, ?, ?, 1)`,
      [
        ['bein1.tr', 'beIN Sports 1 HD', 'bein sports 1 hd'],
        ['cnn.us', 'CNN International', 'cnn international'],
        ['rtl.de', 'RTL Television', 'rtl television'],
      ],
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, run_id)
       VALUES ('s1', 'bein1.tr', 1000, 2000, 'Live Match', 1)`,
    );

    expect(normalizeLiveEpgTitle('TR: [VIP] beIN Sports 1 FHD HEVC 50fps')).toBe('bein sports 1');
    expect(normalizeLiveEpgTitle('UK | Sky Sports +1 [4K] RAW')).toBe('sky sports plus1');

    const hit = await findGuideChannelByCleanName(db, {
      sourceId: 's1',
      channelName: 'TR: [VIP] beIN Sports 1 FHD HEVC Backup',
    });
    expect(hit).toEqual({
      sourceId: 's1',
      guideId: 'bein1.tr',
      guideName: 'beIN Sports 1 HD',
      matchedBy: 'clean-name',
    });

    const exact = await findGuideChannelByCleanName(db, {
      sourceId: 's1',
      channelName: 'CNN International',
    });
    expect(exact).toEqual({
      sourceId: 's1',
      guideId: 'cnn.us',
      guideName: 'CNN International',
      matchedBy: 'exact-fold',
    });

    const miss = await findGuideChannelByCleanName(db, {
      sourceId: 's1',
      channelName: 'Unknown Local Channel 99',
    });
    expect(miss).toBeNull();
  });

  it('findGuideChannelByCleanName enforces excludedSourceIds in SQL and bounds fallback candidate rows via LIKE + LIMIT 250', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await db.batch(
      'INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
      [
        ['s1', 'xtream', 'Source One', 1, '{}'],
        ['s2', 'xtream', 'Excluded Source', 2, '{}'],
        ['s3', 'xtream', 'Allowed Backup', 3, '{}'],
      ],
    );

    // Seed 350 unrelated channels plus specific matches on s2 (excluded) and s3 (allowed)
    const bulkRows = Array.from({ length: 350 }, (_, i) => [
      's1',
      `filler.${i}`,
      `Filler Broadcast ${i} HD`,
      `filler broadcast ${i} hd`,
    ]);
    await db.batch(
      `INSERT INTO guide_channels (source_id, guide_id, name, name_fold, run_id)
       VALUES (?, ?, ?, ?, 1)`,
      [
        ...bulkRows,
        ['s2', 'cnn.s2', 'CNN International', 'cnn international'],
        ['s2', 'sky1.s2', 'Sky Sports +1 HD', 'sky sports 1 hd'],
        ['s3', 'sky1.s3', 'Sky Sports +1 FHD', 'sky sports 1 fhd'],
      ],
    );

    // Profile isolation: exact-fold cross-source MUST NOT leak excluded source s2
    expect(
      await findGuideChannelByCleanName(db, {
        sourceId: 's1',
        channelName: 'CNN International',
        crossSource: true,
        excludedSourceIds: ['s2'],
      }),
    ).toBeNull();

    // Profile isolation: same-source lookup returns null when sourceId itself is excluded
    expect(
      await findGuideChannelByCleanName(db, {
        sourceId: 's2',
        channelName: 'CNN International',
        excludedSourceIds: ['s2'],
      }),
    ).toBeNull();

    // Bounded SQL pre-filter + profile isolation: excludes s2, finds s3, and never scans 350 filler rows into JS
    const allSpy = vi.spyOn(db, 'all');
    const hit = await findGuideChannelByCleanName(db, {
      sourceId: 's1',
      channelName: 'UK | Sky Sports +1 [4K] RAW',
      crossSource: true,
      excludedSourceIds: ['s2'],
    });
    expect(hit).toEqual({
      sourceId: 's3',
      guideId: 'sky1.s3',
      guideName: 'Sky Sports +1 FHD',
      matchedBy: 'clean-name',
    });

    const fallbackCall = allSpy.mock.calls.find(([sql]) => sql.includes('LIMIT ?'));
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall?.[0]).toContain('LOWER(gc.name) LIKE ?');
    expect(fallbackCall?.[0]).toContain('gc.source_id NOT IN');
    expect(fallbackCall?.[1]).toContain(250);
    // Verify SQL returned far fewer than 350 rows (only sky matches!)
    const fallbackResult = await allSpy.mock.results[allSpy.mock.calls.length - 1]?.value;
    expect(Array.isArray(fallbackResult) ? fallbackResult.length : 0).toBe(1);
    allSpy.mockRestore();
  });
});
