import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { commitStagedCatalog } from './catalog-commit';
import { openCatalog } from './migrate';
import {
  DEFAULT_REMINDER_LEAD_TIME_MS,
  listReminders,
  markReminderFired,
  pruneExpiredReminders,
  reconcileRemindersAfterGuideImport,
  removeReminder,
  upsertReminder,
} from './reminders-repo';
import { memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

const utf8 = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode(text);
  },
});

const immediateScheduler = { yieldNow: async () => undefined };

describe('programme reminders repository, guide reconciliation, profile/source cascades, and legacy key remap (#35)', () => {
  const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

  it('supports CRUD, validation, profile isolation, firing, and expired pruning', async () => {
    const { db } = testDb();
    await openCatalog(db);

    // Invalid inputs fail cleanly
    expect(
      await upsertReminder(db, {
        sourceId: 'bad id!',
        channelKey: 'x:s1:live:1',
        channelName: 'Ch 1',
        programmeTitle: 'News',
        programmeStart: NOW + 600_000,
        programmeStop: NOW + 3_600_000,
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-reminder' } });

    expect(
      await upsertReminder(db, {
        sourceId: 's1',
        channelKey: 'https://evil.example/stream',
        channelName: 'Ch 1',
        programmeTitle: 'News',
        programmeStart: NOW + 600_000,
        programmeStop: NOW + 3_600_000,
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-reminder' } });

    expect(
      await upsertReminder(db, {
        sourceId: 's1',
        channelKey: 'x:s1:live:1',
        channelName: 'Ch 1',
        programmeTitle: 'News',
        programmeStart: NOW + 3_600_000,
        programmeStop: NOW + 600_000, // stop <= start
      }),
    ).toMatchObject({ ok: false, error: { category: 'source-format', code: 'invalid-reminder' } });

    const r1 = await upsertReminder(
      db,
      {
        sourceId: 's1',
        channelKey: 'x:s1:live:1',
        channelName: 'Channel One',
        programmeTitle: 'Evening News',
        programmeStart: NOW + 1_800_000,
        programmeStop: NOW + 5_400_000,
      },
      () => NOW,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value).toEqual({
        profileId: 'default',
        sourceId: 's1',
        channelKey: 'x:s1:live:1',
        channelName: 'Channel One',
        programmeTitle: 'Evening News',
        programmeStart: NOW + 1_800_000,
        programmeStop: NOW + 5_400_000,
        leadTimeMs: DEFAULT_REMINDER_LEAD_TIME_MS,
        fired: false,
        createdAt: NOW,
      });
    }

    const r2 = await upsertReminder(
      db,
      {
        profileId: 'kids',
        sourceId: 's1',
        channelKey: 'x:s1:live:2',
        channelName: 'Kids TV',
        programmeTitle: 'Cartoon Hour',
        programmeStart: NOW + 600_000,
        programmeStop: NOW + 2_400_000,
        leadTimeMs: 600_000,
      },
      () => NOW + 1,
    );
    expect(r2.ok).toBe(true);

    // Profile isolation
    expect((await listReminders(db, 'default')).map((r) => r.programmeTitle)).toEqual([
      'Evening News',
    ]);
    expect((await listReminders(db, 'kids')).map((r) => r.programmeTitle)).toEqual([
      'Cartoon Hour',
    ]);

    // Mark fired hides from default list unless includeFired: true
    await markReminderFired(db, 'x:s1:live:1', NOW + 1_800_000, 'default');
    expect(await listReminders(db, 'default')).toEqual([]);
    const withFired = await listReminders(db, 'default', { includeFired: true });
    expect(withFired).toHaveLength(1);
    expect(withFired[0]?.fired).toBe(true);

    // Re-upserting resets fired to false
    const reset = await upsertReminder(
      db,
      {
        sourceId: 's1',
        channelKey: 'x:s1:live:1',
        channelName: 'Channel One',
        programmeTitle: 'Evening News Special',
        programmeStart: NOW + 1_800_000,
        programmeStop: NOW + 5_400_000,
      },
      () => NOW + 10,
    );
    expect(reset.ok && reset.value.fired).toBe(false);
    expect(await listReminders(db, 'default', { fromMs: NOW + 1_800_000 })).toHaveLength(1);
    expect(await listReminders(db, 'default', { fromMs: NOW + 2_000_000 })).toEqual([]);

    // Prune expired removes only reminders whose programmeStop <= nowMs
    const pruned = await pruneExpiredReminders(db, NOW + 3_000_000);
    expect(pruned).toBe(1); // Kids Cartoon Hour (stop = NOW + 2_400_000)
    expect(await listReminders(db, 'kids')).toEqual([]);
    expect(await listReminders(db, 'default')).toHaveLength(1);

    // Remove reminder
    await removeReminder(db, 'x:s1:live:1', NOW + 1_800_000, 'default');
    expect(await listReminders(db, 'default')).toEqual([]);
  });

  it('automatically reconciles shifted programme times (+/- 30 min) on commitGuide and cascades on deleteProfile & removeSource', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    let guideXml = [
      '<?xml version="1.0" encoding="UTF-8"?><tv>',
      '<channel id="ch1"><display-name>Sports 1</display-name></channel>',
      '<programme start="20261124140000 +0000" stop="20261124150000 +0000" channel="ch1"><title>İstanbul Derbisi</title></programme>',
      '<programme start="20261124180000 +0000" stop="20261124190000 +0000" channel="ch1"><title>Late Show</title></programme>',
      '</tv>',
    ].join('');

    const playlist = [
      '#EXTM3U url-tvg="https://epg.example/guide.xml"',
      '#EXTINF:-1 tvg-id="ch1" group-title="Sports",Sports 1',
      'https://cdn.example/sports1.ts',
    ].join('\n');

    const http: HttpClient = {
      async get(url) {
        if (url.includes('list.m3u')) {
          return ok({ status: 200, headers: {}, body: utf8(playlist), finalUrl: url });
        }
        return ok({ status: 200, headers: {}, body: utf8(guideXml), finalUrl: url });
      },
    };

    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http,
        clock: () => NOW,
        newId: () => 'src1',
      }),
    );

    await svc.addSource({
      kind: 'm3u',
      name: 'Sports M3U',
      playlistUrl: 'https://cdn.example/list.m3u',
    });
    expect((await svc.importSource('src1')).ok).toBe(true);
    expect((await svc.importGuide?.('src1'))?.ok).toBe(true);

    const cats = await svc.categories('src1', 'live');
    const chKey = (await svc.items(cats[0]?.id ?? '', 0, 5))[0]?.key ?? '';

    const origStart = Date.UTC(2026, 10, 24, 14, 0, 0);
    const origStop = Date.UTC(2026, 10, 24, 15, 0, 0);
    const lateStart = Date.UTC(2026, 10, 24, 18, 0, 0);
    const lateStop = Date.UTC(2026, 10, 24, 19, 0, 0);

    await svc.upsertReminder?.({
      sourceId: 'src1',
      channelKey: chKey,
      channelName: 'Sports 1',
      programmeTitle: 'İstanbul Derbisi',
      programmeStart: origStart,
      programmeStop: origStop,
    });
    await svc.upsertReminder?.({
      sourceId: 'src1',
      channelKey: chKey,
      channelName: 'Sports 1',
      programmeTitle: 'Late Show',
      programmeStart: lateStart,
      programmeStop: lateStop,
    });

    // Update guide: Istanbul Derbisi shifts +15 min (within +/- 30 min -> reconciled!),
    // Late Show shifts +90 min (outside +/- 30 min -> stays unchanged!)
    guideXml = [
      '<?xml version="1.0" encoding="UTF-8"?><tv>',
      '<channel id="ch1"><display-name>Sports 1</display-name></channel>',
      '<programme start="20261124141500 +0000" stop="20261124153000 +0000" channel="ch1"><title>Istanbul Derbisi</title></programme>',
      '<programme start="20261124193000 +0000" stop="20261124203000 +0000" channel="ch1"><title>Late Show</title></programme>',
      '</tv>',
    ].join('');

    expect((await svc.importGuide?.('src1'))?.ok).toBe(true);
    const afterReconcile = await svc.listReminders?.('default');
    expect(
      afterReconcile?.map((r) => [r.programmeTitle, r.programmeStart, r.programmeStop]),
    ).toEqual([
      ['İstanbul Derbisi', Date.UTC(2026, 10, 24, 14, 15, 0), Date.UTC(2026, 10, 24, 15, 30, 0)],
      ['Late Show', lateStart, lateStop],
    ]);

    // Second reconcile is a no-op (returns 0)
    expect(await reconcileRemindersAfterGuideImport(db, 'src1')).toBe(0);

    // Profile delete cascades programme_reminders for deleted profile only
    const p2 = await svc.createProfile?.({ name: 'Guest' });
    expect(p2?.ok).toBe(true);
    if (!p2?.ok) return;
    await svc.upsertReminder?.({
      profileId: p2.value.id,
      sourceId: 'src1',
      channelKey: chKey,
      channelName: 'Sports 1',
      programmeTitle: 'Guest Reminder',
      programmeStart: origStart,
      programmeStop: origStop,
    });
    expect((await svc.listReminders?.(p2.value.id))?.length).toBe(1);
    expect((await svc.deleteProfile?.(p2.value.id))?.ok).toBe(true);
    expect(await svc.listReminders?.(p2.value.id)).toEqual([]);
    expect((await svc.listReminders?.('default'))?.length).toBe(2);

    // Source removal cleans up programme_reminders
    expect((await svc.removeSource('src1')).ok).toBe(true);
    expect(await svc.listReminders?.('default')).toEqual([]);

    await svc.close();
  });

  it('remaps legacy M3U channel keys in channel_guide_overrides and programme_reminders during catalog commit', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Legacy', 1, '{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:legacy-ch', 'News 1', 'news 1', 1)",
    );
    await db.run(
      `INSERT INTO channel_guide_overrides (source_id, channel_key, guide_source_id, guide_id, epg_shift_ms, is_manual, updated_at)
       VALUES ('s1', 'm:s1:legacy-ch', 'gs1', 'news.one', 600000, 1, 100)`,
    );
    await db.run(
      `INSERT INTO programme_reminders (profile_id, source_id, channel_key, channel_name, programme_title, programme_start, programme_stop, lead_time_ms, fired, created_at)
       VALUES ('default', 's1', 'm:s1:legacy-ch', 'News 1', 'Top Story', 2000, 5000, 300000, 0, 100)`,
    );
    await db.run(
      `INSERT INTO live_next (source_id, key, legacy_key, name, name_fold, sort_title, variant_base_fold, quality_rank, run_id)
       VALUES ('s1', 'm:s1:live:stable-ch', 'm:s1:legacy-ch', 'News 1', 'news 1', 'news 1', 'news 1', 0, 2)`,
    );

    await db.transaction((tx) => commitStagedCatalog(tx, 's1', 2, []));

    expect(
      await db.all(
        'SELECT channel_key, guide_id, epg_shift_ms, is_manual FROM channel_guide_overrides',
      ),
    ).toEqual([
      {
        channel_key: 'm:s1:live:stable-ch',
        guide_id: 'news.one',
        epg_shift_ms: 600000,
        is_manual: 1,
      },
    ]);
    expect(await db.all('SELECT channel_key, programme_title FROM programme_reminders')).toEqual([
      { channel_key: 'm:s1:live:stable-ch', programme_title: 'Top Story' },
    ]);
  });

  it('enforces channel and programme-level parental controls on upsertReminder and listReminders (#31)', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1" group-title="General",Open Channel',
      'https://cdn.example/ch1.ts',
      '#EXTINF:-1 tvg-id="ch2" group-title="General",Locked Channel',
      'https://cdn.example/ch2.ts',
    ].join('\n');
    const http: HttpClient = {
      async get(url) {
        return ok({ status: 200, headers: {}, body: utf8(playlist), finalUrl: url });
      },
    };
    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http,
        clock: () => NOW,
        newId: () => 'srcp',
      }),
    );
    await svc.addSource({
      kind: 'm3u',
      name: 'Parental M3U',
      playlistUrl: 'https://cdn.example/p.m3u',
    });
    expect((await svc.importSource('srcp')).ok).toBe(true);
    const cats = await svc.categories('srcp', 'live');
    const items = await svc.items(cats[0]?.id ?? '', 0, 10);
    const openKey = items.find((i) => i.name === 'Open Channel')?.key ?? '';
    const lockedKey = items.find((i) => i.name === 'Locked Channel')?.key ?? '';

    await svc.updateParentalSettings?.({ enabled: true, blockAdultKeywords: true });
    await svc.setParentalLock?.(
      { sourceId: 'srcp', targetKind: 'item', itemKind: 'live', targetKey: lockedKey },
      true,
    );

    // Locked channel blocked when locked
    expect(
      await svc.upsertReminder?.({
        sourceId: 'srcp',
        channelKey: lockedKey,
        channelName: 'Locked Channel',
        programmeTitle: 'Safe News',
        programmeStart: NOW + 600_000,
        programmeStop: NOW + 3_600_000,
      }),
    ).toMatchObject({ ok: false, error: { category: 'auth', code: 'parental-locked' } });

    // Adult programme title on open channel blocked when locked
    expect(
      await svc.upsertReminder?.({
        sourceId: 'srcp',
        channelKey: openKey,
        channelName: 'Open Channel',
        programmeTitle: 'XXX Midnight Show',
        programmeStart: NOW + 600_000,
        programmeStop: NOW + 3_600_000,
      }),
    ).toMatchObject({ ok: false, error: { category: 'auth', code: 'parental-locked' } });

    // Safe programme on open channel allowed while locked
    expect(
      (
        await svc.upsertReminder?.({
          sourceId: 'srcp',
          channelKey: openKey,
          channelName: 'Open Channel',
          programmeTitle: 'Family Quiz',
          programmeStart: NOW + 900_000,
          programmeStop: NOW + 3_900_000,
        })
      )?.ok,
    ).toBe(true);

    // Unlocked writes succeed for both locked channel and adult programme
    expect(
      (
        await svc.upsertReminder?.({
          sourceId: 'srcp',
          channelKey: lockedKey,
          channelName: 'Locked Channel',
          programmeTitle: 'Safe News',
          programmeStart: NOW + 600_000,
          programmeStop: NOW + 3_600_000,
          parentalUnlocked: true,
        })
      )?.ok,
    ).toBe(true);
    expect(
      (
        await svc.upsertReminder?.({
          sourceId: 'srcp',
          channelKey: openKey,
          channelName: 'Open Channel',
          programmeTitle: 'XXX Midnight Show',
          programmeStart: NOW + 1_200_000,
          programmeStop: NOW + 4_200_000,
          parentalUnlocked: true,
        })
      )?.ok,
    ).toBe(true);

    // Locked listReminders hides both restricted channel and restricted programme title
    const lockedList = await svc.listReminders?.('default');
    expect(lockedList?.map((r) => r.programmeTitle)).toEqual(['Family Quiz']);

    // Unlocked listReminders returns all three
    const unlockedList = await svc.listReminders?.('default', { parentalUnlocked: true });
    expect(unlockedList?.map((r) => r.programmeTitle)).toEqual([
      'Safe News',
      'Family Quiz',
      'XXX Midnight Show',
    ]);

    await svc.close();
  });

  it('does not overwrite an existing fired = 1 reminder when reconciling a shifted duplicate', async () => {
    const { db } = testDb();
    await openCatalog(db);
    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Src', 1, '{}')",
    );
    await db.run(
      "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:live:1', 'Sports 1', 'sports 1', 1)",
    );
    await db.run(
      "INSERT INTO channel_guide (source_id, channel_key, guide_id) VALUES ('s1', 'x:s1:live:1', 'ch1')",
    );

    const oldStart = Date.UTC(2026, 10, 24, 14, 0, 0);
    const oldStop = Date.UTC(2026, 10, 24, 15, 0, 0);
    const shiftedStart = Date.UTC(2026, 10, 24, 14, 10, 0);
    const shiftedStop = Date.UTC(2026, 10, 24, 15, 10, 0);

    // Programme in refreshed guide now starts at shiftedStart
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, run_id, title_fold, description_fold)
       VALUES ('s1', 'ch1', ?, ?, 'Big Match', 1, 'big match', '')`,
      [shiftedStart, shiftedStop],
    );
    // An existing reminder at shiftedStart is ALREADY fired = 1
    await db.run(
      `INSERT INTO programme_reminders (profile_id, source_id, channel_key, channel_name, programme_title, programme_start, programme_stop, lead_time_ms, fired, created_at)
       VALUES ('default', 's1', 'x:s1:live:1', 'Sports 1', 'Big Match', ?, ?, 300000, 1, 100)`,
      [shiftedStart, shiftedStop],
    );
    // An older unfired reminder at oldStart shifts onto shiftedStart
    await db.run(
      `INSERT INTO programme_reminders (profile_id, source_id, channel_key, channel_name, programme_title, programme_start, programme_stop, lead_time_ms, fired, created_at)
       VALUES ('default', 's1', 'x:s1:live:1', 'Sports 1', 'Big Match', ?, ?, 300000, 0, 90)`,
      [oldStart, oldStop],
    );

    await reconcileRemindersAfterGuideImport(db, 's1');

    const rows = await listReminders(db, 'default', { includeFired: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.programmeStart).toBe(shiftedStart);
    expect(rows[0]?.fired).toBe(true);
  });
});
