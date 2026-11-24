import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { secretKey } from './sources';
import { memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

const utf8 = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode(text);
  },
});

const immediateScheduler = { yieldNow: async () => undefined };

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?><tv>';

function xmltv(channels: string, programmes: string): string {
  return `${XML_HEADER}${channels}${programmes}</tv>`;
}

function makeHttp(
  routes: Record<
    string,
    | { status?: number; headers?: Record<string, string>; body: string }
    | ((
        url: string,
        headers: Record<string, string>,
      ) => { status: number; headers?: Record<string, string>; body: string })
  >,
): HttpClient {
  return {
    async get(url, opts) {
      for (const [pattern, handler] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          const res =
            typeof handler === 'function'
              ? handler(url, opts?.headers ?? {})
              : {
                  status: handler.status ?? 200,
                  headers: handler.headers ?? {},
                  body: handler.body,
                };
          return ok({
            status: res.status,
            headers: res.headers ?? {},
            body: utf8(res.body),
            finalUrl: url,
          });
        }
      }
      return ok({ status: 404, headers: {}, body: utf8('missing'), finalUrl: url });
    },
  };
}

describe('multi-guide sources, priority-ordered ingestion, Tier-0 manual overrides, and EPG time offsets (#30)', () => {
  // Base time: 2026-11-24 12:00:00 UTC
  const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

  it('stores guide URLs strictly in SecretStore (zero raw URLs in SQLite), supports CRUD + reorder, and preserves secrets across M3U re-imports', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1" group-title="General",Channel One',
      'https://cdn.example/ch1.ts',
    ].join('\n');

    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http: makeHttp({ 'list.m3u': { body: playlist } }),
        clock: () => NOW,
        newId: () => 'src1',
      }),
    );

    await svc.addSource({
      kind: 'm3u',
      name: 'Main',
      playlistUrl: 'https://cdn.example/list.m3u',
    });

    // Validation failures
    expect(
      await svc.addGuideSource?.({
        sourceId: 'src1',
        name: 'Bad URL',
        url: 'file:///etc/passwd',
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-guide-url' } });
    expect(
      await svc.addGuideSource?.({
        sourceId: 'src1',
        name: 'Whitespace URL',
        url: 'https://epg.example/my guide.xml',
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-guide-url' } });
    expect(
      await svc.addGuideSource?.({
        sourceId: 'src1',
        name: 'Oversized URL',
        url: `https://epg.example/${'a'.repeat(4100)}.xml`,
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-guide-url' } });
    expect(
      await svc.addGuideSource?.({
        sourceId: 'src1',
        name: 'Malformed URL',
        url: 'https://[invalid-host/guide.xml',
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-guide-url' } });
    expect(
      await svc.addGuideSource?.({
        sourceId: 'src1',
        name: '   ',
        url: 'https://epg.example/g1.xml',
      }),
    ).toMatchObject({
      ok: false,
      error: { category: 'source-format', code: 'invalid-guide-source' },
    });

    const g1 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Primary XMLTV',
      url: 'https://epg.example/primary.xml?token=secretTokenA',
      epgShiftMs: 3_600_000,
    });
    const g2 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Fallback XMLTV',
      url: 'https://epg.example/fallback.xml?token=secretTokenB',
      epgShiftMs: -1_800_000,
    });
    expect(g1?.ok).toBe(true);
    expect(g2?.ok).toBe(true);
    if (!g1?.ok || !g2?.ok) return;

    // SQLite never contains raw URLs or tokens
    const dbDump = JSON.stringify(await db.all('SELECT * FROM guide_sources'));
    expect(dbDump).not.toContain('secretTokenA');
    expect(dbDump).not.toContain('secretTokenB');
    expect(dbDump).not.toContain('primary.xml');
    expect(g1.value.urlTemplate).toBe(`{{g:${g1.value.id}}}`);

    // Re-importing the M3U playlist must preserve guide_sources secrets in urlvars!
    expect((await svc.importSource('src1')).ok).toBe(true);
    const varsAfterImport = JSON.parse(secrets.dump()[secretKey('src1', 'urlvars')] ?? '{}');
    expect(varsAfterImport[`g:${g1.value.id}`]).toBe(
      'https://epg.example/primary.xml?token=secretTokenA',
    );
    expect(varsAfterImport[`g:${g2.value.id}`]).toBe(
      'https://epg.example/fallback.xml?token=secretTokenB',
    );

    // Reorder swaps priorities atomically
    expect((await svc.reorderGuideSources?.('src1', [g2.value.id, g1.value.id]))?.ok).toBe(true);
    const ordered = await svc.listGuideSources?.('src1');
    expect(ordered?.map((r) => [r.id, r.priority])).toEqual([
      [g2.value.id, 0],
      [g1.value.id, 1],
    ]);

    // Update name, shift, URL, enabled
    const upd = await svc.updateGuideSource?.(g1.value.id, {
      name: 'Primary Renamed',
      url: 'https://epg.example/new.xml?token=secretTokenC',
      epgShiftMs: 7_200_000,
      enabled: false,
    });
    expect(upd?.ok).toBe(true);
    if (upd?.ok) {
      expect(upd.value.name).toBe('Primary Renamed');
      expect(upd.value.epgShiftMs).toBe(7_200_000);
      expect(upd.value.enabled).toBe(false);
    }
    const varsAfterUpdate = JSON.parse(secrets.dump()[secretKey('src1', 'urlvars')] ?? '{}');
    expect(varsAfterUpdate[`g:${g1.value.id}`]).toBe(
      'https://epg.example/new.xml?token=secretTokenC',
    );

    // Remove guide source deletes row and removes its secret from urlvars
    expect((await svc.removeGuideSource?.(g1.value.id))?.ok).toBe(true);
    expect((await svc.listGuideSources?.('src1'))?.map((r) => r.id)).toEqual([g2.value.id]);
    const varsAfterRemove = JSON.parse(secrets.dump()[secretKey('src1', 'urlvars')] ?? '{}');
    expect(varsAfterRemove[`g:${g1.value.id}`]).toBeUndefined();
    expect(varsAfterRemove[`g:${g2.value.id}`]).toBeDefined();

    await svc.close();
  });

  it('ingests multiple guide sources in priority order, honors Tier-0 manual overrides across refreshes, and composes all EPG shifts', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch.alpha" tvg-shift="1" group-title="Main",Alpha TV',
      'https://cdn.example/alpha.ts',
      '#EXTINF:-1 tvg-id="ch.beta" group-title="Main",Beta TV',
      'https://cdn.example/beta.ts',
      '#EXTINF:-1 tvg-id="ch.gamma" group-title="Main",Gamma TV',
      'https://cdn.example/gamma.ts',
    ].join('\n');

    // Priority-0 guide covers ch.alpha AND manual.target (and has a colliding ch.alpha title)
    const guidePrimary = xmltv(
      [
        '<channel id="ch.alpha"><display-name>Alpha TV</display-name></channel>',
        '<channel id="manual.target"><display-name>Special Feed</display-name></channel>',
      ].join(''),
      [
        '<programme start="20261124110000 +0000" stop="20261124120000 +0000" channel="ch.alpha"><title>Primary Alpha Show</title></programme>',
        '<programme start="20261124120000 +0000" stop="20261124130000 +0000" channel="manual.target"><title>Manual Override Show</title></programme>',
      ].join(''),
    );

    // Priority-1 guide ALSO defines ch.alpha (must NOT overwrite Priority-0!) plus ch.beta
    const guideSecondary = xmltv(
      [
        '<channel id="ch.alpha"><display-name>Alpha TV</display-name></channel>',
        '<channel id="ch.beta"><display-name>Beta TV</display-name></channel>',
      ].join(''),
      [
        '<programme start="20261124110000 +0000" stop="20261124120000 +0000" channel="ch.alpha"><title>Secondary Alpha Duplicate</title></programme>',
        '<programme start="20261124113000 +0000" stop="20261124123000 +0000" channel="ch.beta"><title>Secondary Beta Show</title></programme>',
      ].join(''),
    );

    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http: makeHttp({
          'list.m3u': { body: playlist },
          'primary.xml': { body: guidePrimary },
          'secondary.xml': { body: guideSecondary },
        }),
        clock: () => NOW,
        newId: () => 'src1',
      }),
    );

    await svc.addSource({
      kind: 'm3u',
      name: 'Main',
      playlistUrl: 'https://cdn.example/list.m3u',
    });
    expect((await svc.importSource('src1')).ok).toBe(true);

    const cats = await svc.categories('src1', 'live');
    const channels = await svc.items(cats[0]?.id ?? '', 0, 10);
    const alphaKey = channels.find((c) => c.name === 'Alpha TV')?.key ?? '';
    const betaKey = channels.find((c) => c.name === 'Beta TV')?.key ?? '';
    const gammaKey = channels.find((c) => c.name === 'Gamma TV')?.key ?? '';

    const gs1 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Primary',
      url: 'https://epg.example/primary.xml',
      priority: 0,
      epgShiftMs: 0,
    });
    const gs2 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Secondary',
      url: 'https://epg.example/secondary.xml',
      priority: 1,
      epgShiftMs: 1_800_000, // +30 min on secondary guide!
    });
    expect(gs1?.ok && gs2?.ok).toBe(true);
    if (!gs1?.ok || !gs2?.ok) return;

    // Set Tier-0 manual override mapping Gamma TV -> manual.target with +15 min offset
    const ov = await svc.setChannelGuideOverride?.({
      sourceId: 'src1',
      channelKey: gammaKey,
      guideSourceId: gs1.value.id,
      guideId: 'manual.target',
      epgShiftMs: 900_000, // +15 min
    });
    expect(ov?.ok).toBe(true);

    // Run multi-guide import
    const imported = await svc.importGuide?.('src1');
    expect(imported?.ok).toBe(true);

    // Searchable guide channels list works
    const foundChannels = await svc.listGuideChannels?.('src1', 'special');
    expect(foundChannels?.map((c) => c.guideId)).toEqual(['manual.target']);

    // Manual override survived guide refresh untouched
    const overrides = await svc.listChannelGuideOverrides?.('src1');
    expect(overrides).toHaveLength(1);
    expect(overrides?.[0]).toMatchObject({
      channelKey: gammaKey,
      guideSourceId: gs1.value.id,
      guideId: 'manual.target',
      epgShiftMs: 900_000,
      isManual: true,
    });

    // Verify programmes & combined shifts:
    // - Alpha TV: came from Primary (NOT overwritten by Secondary!), live.epg_shift_ms = +1h -> 11:00..12:00 becomes 12:00..13:00
    // - Beta TV: came from Secondary, guide_sources.epg_shift_ms = +30m -> 11:30..12:30 becomes 12:00..13:00
    // - Gamma TV: Tier-0 manual override -> manual.target (12:00..13:00) + override 15m -> 12:15..13:15
    const win = await svc.epgWindow?.(
      [alphaKey, betaKey, gammaKey],
      NOW - 3_600_000,
      NOW + 7_200_000,
    );
    expect(win?.[alphaKey]?.map((p) => [p.title, p.start, p.stop])).toEqual([
      ['Primary Alpha Show', Date.UTC(2026, 10, 24, 12, 0, 0), Date.UTC(2026, 10, 24, 13, 0, 0)],
    ]);
    expect(win?.[betaKey]?.map((p) => [p.title, p.start, p.stop])).toEqual([
      ['Secondary Beta Show', Date.UTC(2026, 10, 24, 12, 0, 0), Date.UTC(2026, 10, 24, 13, 0, 0)],
    ]);
    expect(win?.[gammaKey]?.map((p) => [p.title, p.start, p.stop])).toEqual([
      [
        'Manual Override Show',
        Date.UTC(2026, 10, 24, 12, 15, 0),
        Date.UTC(2026, 10, 24, 13, 15, 0),
      ],
    ]);

    // Now-next also applies the combined shifts accurately
    const nn = await svc.nowNext?.(
      [alphaKey, betaKey, gammaKey],
      Date.UTC(2026, 10, 24, 12, 20, 0),
    );
    expect(nn?.find((e) => e.channelKey === alphaKey)?.now?.title).toBe('Primary Alpha Show');
    expect(nn?.find((e) => e.channelKey === betaKey)?.now?.title).toBe('Secondary Beta Show');
    expect(nn?.find((e) => e.channelKey === gammaKey)?.now?.title).toBe('Manual Override Show');

    // Add source-wide epgShiftMs (+10m) and verify it stacks cleanly with guide_source + override + live shifts
    await svc.updateSourceSettings?.('src1', { epgShiftMs: 600_000 });
    const winShifted = await svc.epgWindow?.([gammaKey], NOW - 3_600_000, NOW + 7_200_000);
    expect(winShifted?.[gammaKey]?.[0]?.start).toBe(Date.UTC(2026, 10, 24, 12, 25, 0));

    // Clearing manual override removes it
    expect((await svc.clearChannelGuideOverride?.('src1', gammaKey))?.ok).toBe(true);
    expect(await svc.listChannelGuideOverrides?.('src1')).toEqual([]);

    await svc.close();
  });

  it('falls back cleanly when a higher-priority guide fails and supports conditional 304 for a single guide_source', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1" group-title="Main",Channel 1',
      'https://cdn.example/ch1.ts',
    ].join('\n');
    const guideXml = xmltv(
      '<channel id="ch1"><display-name>Channel 1</display-name></channel>',
      '<programme start="20261124120000 +0000" stop="20261124130000 +0000" channel="ch1"><title>Fallback Show</title></programme>',
    );

    let guideRequests = 0;
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http: makeHttp({
        'list.m3u': { body: playlist },
        'broken.xml': { status: 404, body: 'nope' },
        'working.xml': (_url, headers) => {
          guideRequests += 1;
          if (headers['if-none-match'] === '"v1"') {
            return { status: 304, headers: { etag: '"v1"' }, body: '' };
          }
          return { status: 200, headers: { etag: '"v1"' }, body: guideXml };
        },
      }),
      clock: () => NOW,
      newId: () => 'src1',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Main',
      playlistUrl: 'https://cdn.example/list.m3u',
    });
    await svc.importSource('src1');

    const gBroken = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Broken Primary',
      url: 'https://epg.example/broken.xml',
      priority: 0,
    });
    const gWorking = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Working Backup',
      url: 'https://epg.example/working.xml',
      priority: 1,
    });
    expect(gBroken?.ok && gWorking?.ok).toBe(true);
    if (!gBroken?.ok || !gWorking?.ok) return;

    const first = await svc.importGuide?.('src1');
    expect(first?.ok).toBe(true);
    if (first?.ok) {
      expect(first.value.counts.programmes).toBe(1);
      expect(first.value.warnings).toBeGreaterThanOrEqual(1);
    }

    // Disable broken guide so only 1 enabled guide source remains -> conditional 304 triggers cleanly!
    await svc.updateGuideSource?.(gBroken.value.id, { enabled: false });
    const second = await svc.importGuide?.('src1');
    expect(second?.ok).toBe(true);
    if (second?.ok) {
      expect(second.value.unchanged).toBe(true);
    }
    expect(guideRequests).toBe(2);

    await svc.close();
  });

  it('preserves concurrently added/edited guide_sources secrets during importM3u (#30)', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      // resolved when HTTP get starts
      void resolve;
    });
    let markDownloadStarted!: () => void;
    const startedP = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const gateP = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    void downloadStarted;

    let version = 1;
    const http: HttpClient = {
      async get(url) {
        if (version === 2) {
          markDownloadStarted();
          await gateP;
        }
        const playlist = [
          '#EXTM3U',
          '#EXTINF:-1 tvg-id="ch1" group-title="Main",Channel 1',
          `https://cdn.example/v${version}/token${version}/ch1.ts`,
        ].join('\n');
        return ok({ status: 200, headers: {}, body: utf8(playlist), finalUrl: url });
      },
    };

    const svc = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http,
      clock: () => NOW,
      newId: () => 'src1',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Main',
      playlistUrl: 'https://cdn.example/list.m3u',
    });
    // First import establishes oldVars
    expect((await svc.importSource('src1')).ok).toBe(true);
    const gExisting = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Existing Guide',
      url: 'https://epg.example/old.xml',
    });
    expect(gExisting?.ok).toBe(true);
    if (!gExisting?.ok) return;

    // Start second M3U import with new URL token so afterCommit prunes stale playlist vars
    version = 2;
    const importPromise = svc.importSource('src1');
    await startedP;

    // Concurrently add a new guide source and update the existing guide URL while M3U download is in flight
    const gConcurrent = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Concurrent Guide',
      url: 'https://epg.example/concurrent.xml?key=liveKey99',
    });
    expect(gConcurrent?.ok).toBe(true);
    if (!gConcurrent?.ok) return;
    expect(
      (
        await svc.updateGuideSource?.(gExisting.value.id, {
          url: 'https://epg.example/updated.xml?key=updatedKey88',
        })
      )?.ok,
    ).toBe(true);

    releaseDownload();
    expect((await importPromise).ok).toBe(true);

    const vars = JSON.parse(secrets.dump()[secretKey('src1', 'urlvars')] ?? '{}');
    expect(vars[`g:${gConcurrent.value.id}`]).toBe(
      'https://epg.example/concurrent.xml?key=liveKey99',
    );
    expect(vars[`g:${gExisting.value.id}`]).toBe(
      'https://epg.example/updated.xml?key=updatedKey88',
    );
    await svc.close();
  });

  it('populates guideSourceId on listGuideChannels, preserves it on setChannelGuideOverride, and clears manual channel_guide immediately', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch.alpha" group-title="Main",Alpha TV',
      'https://cdn.example/alpha.ts',
      '#EXTINF:-1 tvg-id="ch.beta" group-title="Main",Beta TV',
      'https://cdn.example/beta.ts',
      '#EXTINF:-1 tvg-id="ch.unmatched" group-title="Main",Gamma TV',
      'https://cdn.example/gamma.ts',
    ].join('\n');

    const guidePrimary = xmltv(
      [
        '<channel id="ch.alpha"><display-name>Alpha TV</display-name></channel>',
        '<channel id="manual.feed"><display-name>Manual Feed</display-name></channel>',
      ].join(''),
      [
        '<programme start="20261124120000 +0000" stop="20261124130000 +0000" channel="ch.alpha"><title>Alpha Show</title></programme>',
        '<programme start="20261124120000 +0000" stop="20261124130000 +0000" channel="manual.feed"><title>Manual Feed Show</title></programme>',
      ].join(''),
    );
    const guideSecondary = xmltv(
      '<channel id="ch.beta"><display-name>Beta TV</display-name></channel>',
      '<programme start="20261124120000 +0000" stop="20261124130000 +0000" channel="ch.beta"><title>Beta Show</title></programme>',
    );

    const svc = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http: makeHttp({
        'list.m3u': { body: playlist },
        'primary.xml': { body: guidePrimary },
        'secondary.xml': { body: guideSecondary },
      }),
      clock: () => NOW,
      newId: () => 'src1',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Main',
      playlistUrl: 'https://cdn.example/list.m3u',
    });
    await svc.importSource('src1');
    const cats = await svc.categories('src1', 'live');
    const channels = await svc.items(cats[0]?.id ?? '', 0, 10);
    const alphaKey = channels.find((c) => c.name === 'Alpha TV')?.key ?? '';
    const betaKey = channels.find((c) => c.name === 'Beta TV')?.key ?? '';
    const gammaKey = channels.find((c) => c.name === 'Gamma TV')?.key ?? '';

    const gs1 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Primary',
      url: 'https://epg.example/primary.xml',
      priority: 0,
    });
    const gs2 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Secondary',
      url: 'https://epg.example/secondary.xml',
      priority: 1,
      epgShiftMs: 1_800_000,
    });
    if (!gs1?.ok || !gs2?.ok) throw new Error('expected guides');
    expect((await svc.importGuide?.('src1'))?.ok).toBe(true);

    // listGuideChannels returns populated guideSourceId
    const guideOpts = await svc.listGuideChannels?.('src1');
    expect(guideOpts?.find((c) => c.guideId === 'ch.alpha')?.guideSourceId).toBe(gs1.value.id);
    expect(guideOpts?.find((c) => c.guideId === 'ch.beta')?.guideSourceId).toBe(gs2.value.id);

    // Updating only epgShiftMs (guideSourceId omitted) preserves Beta TV's existing guideSourceId!
    const betaOffset = await svc.setChannelGuideOverride?.({
      sourceId: 'src1',
      channelKey: betaKey,
      guideId: 'ch.beta',
      epgShiftMs: 600_000,
    });
    expect(betaOffset?.ok).toBe(true);
    if (betaOffset?.ok) {
      expect(betaOffset.value.guideSourceId).toBe(gs2.value.id);
    }

    // Explicitly passing guideSourceId: null clears it to null
    const clearedSource = await svc.setChannelGuideOverride?.({
      sourceId: 'src1',
      channelKey: betaKey,
      guideSourceId: null,
      guideId: 'ch.beta',
      epgShiftMs: 600_000,
    });
    expect(clearedSource?.ok && clearedSource.value.guideSourceId).toBeNull();

    // Map Gamma TV manually -> ch.alpha shows Alpha Show immediately
    await svc.setChannelGuideOverride?.({
      sourceId: 'src1',
      channelKey: gammaKey,
      guideSourceId: gs1.value.id,
      guideId: 'ch.alpha',
    });
    expect((await svc.epgWindow?.([gammaKey], NOW, NOW + 3_600_000))?.[gammaKey]?.[0]?.title).toBe(
      'Alpha Show',
    );
    // Clearing Gamma TV's override immediately removes stale manual programmes
    await svc.clearChannelGuideOverride?.('src1', gammaKey);
    expect((await svc.epgWindow?.([gammaKey], NOW, NOW + 3_600_000))?.[gammaKey]).toBeUndefined();

    // Override Alpha TV -> ch.beta, then clear -> restores automatic ch.alpha mapping immediately
    await svc.setChannelGuideOverride?.({
      sourceId: 'src1',
      channelKey: alphaKey,
      guideSourceId: gs2.value.id,
      guideId: 'ch.beta',
    });
    expect((await svc.epgWindow?.([alphaKey], NOW, NOW + 7_200_000))?.[alphaKey]?.[0]?.title).toBe(
      'Beta Show',
    );
    await svc.clearChannelGuideOverride?.('src1', alphaKey);
    expect((await svc.epgWindow?.([alphaKey], NOW, NOW + 3_600_000))?.[alphaKey]?.[0]?.title).toBe(
      'Alpha Show',
    );

    await svc.close();
  });

  it('does not let an empty <channel id> in a higher-priority guide block a lower-priority guide with programmes', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch.alpha" group-title="Main",Alpha TV',
      'https://cdn.example/alpha.ts',
    ].join('\n');

    // Priority-0 declares <channel id="ch.alpha"> with ZERO programmes
    const emptyPrimary = xmltv(
      '<channel id="ch.alpha"><display-name>Alpha TV</display-name></channel>',
      '',
    );
    // Priority-1 actually provides programmes for ch.alpha
    const populatedSecondary = xmltv(
      '<channel id="ch.alpha"><display-name>Alpha TV</display-name></channel>',
      '<programme start="20261124120000 +0000" stop="20261124130000 +0000" channel="ch.alpha"><title>Secondary Schedule Show</title></programme>',
    );

    const svc = createCatalogService({
      db,
      secrets,
      scheduler: immediateScheduler,
      http: makeHttp({
        'list.m3u': { body: playlist },
        'empty-primary.xml': { body: emptyPrimary },
        'populated-secondary.xml': { body: populatedSecondary },
      }),
      clock: () => NOW,
      newId: () => 'src1',
    });

    await svc.addSource({
      kind: 'm3u',
      name: 'Main',
      playlistUrl: 'https://cdn.example/list.m3u',
    });
    await svc.importSource('src1');
    const cats = await svc.categories('src1', 'live');
    const alphaKey = (await svc.items(cats[0]?.id ?? '', 0, 5))[0]?.key ?? '';

    const gs1 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Empty Primary',
      url: 'https://epg.example/empty-primary.xml',
      priority: 0,
    });
    const gs2 = await svc.addGuideSource?.({
      sourceId: 'src1',
      name: 'Populated Secondary',
      url: 'https://epg.example/populated-secondary.xml',
      priority: 1,
    });
    expect(gs1?.ok && gs2?.ok).toBe(true);

    const imported = await svc.importGuide?.('src1');
    expect(imported?.ok).toBe(true);
    const win = await svc.epgWindow?.([alphaKey], NOW - 60_000, NOW + 3_600_000);
    expect(win?.[alphaKey]?.map((p) => p.title)).toEqual(['Secondary Schedule Show']);

    await svc.close();
  });
});
