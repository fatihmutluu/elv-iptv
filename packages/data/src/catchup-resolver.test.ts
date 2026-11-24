import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { getSource } from './sources';
import { memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

const utf8 = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode(text);
  },
});

const immediateScheduler = { yieldNow: async () => undefined };

function mockHttp(routes: Record<string, string | (() => string)>): HttpClient {
  return {
    async get(url) {
      for (const [pattern, body] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          const text = typeof body === 'function' ? body() : body;
          return ok({ status: 200, headers: {}, body: utf8(text), finalUrl: url });
        }
      }
      return ok({ status: 404, headers: {}, body: utf8('not found'), finalUrl: url });
    },
  };
}

describe('catch-up persistence, ItemRow.catchupDays, resolveCatchupStream, and fetchChannelArchiveEpg (#220, #306, #27)', () => {
  const NOW = Date.UTC(2026, 10, 24, 12, 0, 0); // 2026-11-24T12:00:00Z
  const START = Date.UTC(2026, 10, 24, 10, 0, 0); // 2h ago
  const STOP = Date.UTC(2026, 10, 24, 11, 0, 0); // 1h ago

  it('persists M3U catch-up mode, tokenized catchup-source (zero secrets in SQLite), and catchupDays fallbacks', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const archUser = 'alice';
    const archPass = 'hunter2';
    const xcUser = 'bob';
    const xcPass = 'pass99';
    const archSource = `https://${archUser}:${archPass}@archive.example/${['timeshift', archUser, archPass, '{duration}', '{Y}-{m}-{d}:{H}-{M}', '300.ts?token=archtok77'].join('/')}`;
    const xcLiveUrl = `https://panel.example/${['live', xcUser, xcPass, '505.ts'].join('/')}`;
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1" tvg-chno="1" group-title="News" catchup="append" catchup-days="5" catchup-source="?utc={utc}&lutc={lutc}&token=supersecret99",Alpha News',
      '#EXTVLCOPT:http-user-agent=ElvTest/1.0',
      'https://cdn.example/live/ch1/index.m3u8?token=streamtok88',
      '#EXTINF:-1 tvg-id="ch2" tvg-chno="2" group-title="News" catchup="flussonic-hls" timeshift="3",Flussonic Live',
      'https://cdn.example/ch2/index.m3u8',
      `#EXTINF:-1 tvg-id="ch3" tvg-chno="3" group-title="News" catchup="default" tvg-rec="4" catchup-source="${archSource}",Archive Default`,
      'https://cdn.example/ch3/live.ts',
      '#EXTINF:-1 tvg-id="ch4" tvg-chno="4" group-title="News" catchup="shift" catchup-days="2",Shift Channel',
      'https://cdn.example/ch4/stream.m3u8?quality=hd',
      '#EXTINF:-1 tvg-id="ch5" tvg-chno="5" group-title="News" catchup="xc" catchup-days="7",M3U Xtream Catchup',
      xcLiveUrl,
      '#EXTINF:-1 tvg-id="ch6" tvg-chno="6" group-title="News",No Catchup',
      'https://cdn.example/ch6/live.ts',
    ].join('\n');

    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http: mockHttp({ 'playlist.m3u': playlist }),
        clock: () => NOW,
        newId: () => 'm3u1',
      }),
    );

    const added = await svc.addSource({
      kind: 'm3u',
      name: 'M3U Catchup',
      playlistUrl: 'https://cdn.example/playlist.m3u',
    });
    expect(added.ok).toBe(true);
    const imp = await svc.importSource('m3u1');
    expect(imp.ok).toBe(true);

    // Zero raw tokens/credentials anywhere in SQLite `live` table
    const rawLive = await db.all<{
      name: string;
      catchup_days: number | null;
      catchup_mode: string | null;
      catchup_source_template: string | null;
    }>(
      'SELECT name, catchup_days, catchup_mode, catchup_source_template FROM live ORDER BY num ASC',
    );
    const serialized = JSON.stringify(rawLive);
    for (const secret of ['supersecret99', 'streamtok88', 'hunter2', 'archtok77', 'pass99']) {
      expect(serialized).not.toContain(secret);
    }
    expect(rawLive).toEqual([
      {
        name: 'Alpha News',
        catchup_days: 5,
        catchup_mode: 'append',
        catchup_source_template: '{{c:src}}',
      },
      {
        name: 'Flussonic Live',
        catchup_days: 3,
        catchup_mode: 'flussonic',
        catchup_source_template: null,
      },
      {
        name: 'Archive Default',
        catchup_days: 4,
        catchup_mode: 'default',
        catchup_source_template: expect.stringContaining(
          '{{userinfo}}@archive.example/timeshift/{{user}}/{{pass}}',
        ),
      },
      {
        name: 'Shift Channel',
        catchup_days: 2,
        catchup_mode: 'shift',
        catchup_source_template: null,
      },
      {
        name: 'M3U Xtream Catchup',
        catchup_days: 7,
        catchup_mode: 'xc',
        catchup_source_template: null,
      },
      {
        name: 'No Catchup',
        catchup_days: null,
        catchup_mode: null,
        catchup_source_template: null,
      },
    ]);

    // ItemRow.catchupDays surfaced on browse, detail, channelByNumber, recent, and search
    const cats = await svc.categories('m3u1', 'live');
    const items = await svc.items(cats[0]?.id ?? '', 0, 10);
    expect(items.find((i) => i.name === 'Alpha News')?.catchupDays).toBe(5);
    expect(items.find((i) => i.name === 'No Catchup')?.catchupDays).toBeUndefined();

    const alpha = items.find((i) => i.name === 'Alpha News');
    const fluss = items.find((i) => i.name === 'Flussonic Live');
    const archDef = items.find((i) => i.name === 'Archive Default');
    const shiftCh = items.find((i) => i.name === 'Shift Channel');
    const m3uXc = items.find((i) => i.name === 'M3U Xtream Catchup');
    const noCatchup = items.find((i) => i.name === 'No Catchup');

    expect((await svc.itemDetail?.(alpha?.key ?? ''))?.catchupDays).toBe(5);
    expect((await svc.channelByNumber?.(1, 'm3u1'))?.catchupDays).toBe(5);
    await svc.recordRecentChannel?.(alpha?.key ?? '', 'm3u1');
    expect((await svc.listRecentChannels?.(5))?.[0]?.catchupDays).toBe(5);
    expect((await svc.search?.('Alpha'))?.live[0]?.catchupDays).toBe(5);

    const startSec = Math.floor(START / 1000);
    const endSec = Math.floor(STOP / 1000);
    const nowSec = Math.floor(NOW / 1000);

    // 1. M3U append mode + custom headers
    const rAppend = await svc.resolveCatchupStream?.(alpha?.key ?? '', {
      startMs: START,
      stopMs: STOP,
    });
    expect(rAppend?.ok).toBe(true);
    if (rAppend?.ok) {
      expect(rAppend.value.url).toBe(
        `https://cdn.example/live/ch1/index.m3u8?token=streamtok88&utc=${startSec}&lutc=${nowSec}&token=supersecret99`,
      );
      expect(rAppend.value.headers['user-agent']).toBe('ElvTest/1.0');
    }

    // 2. M3U flussonic mode
    const rFluss = await svc.resolveCatchupStream?.(fluss?.key ?? '', {
      startMs: START,
      stopMs: STOP,
    });
    expect(rFluss?.ok).toBe(true);
    if (rFluss?.ok) {
      expect(rFluss.value.url).toBe(`https://cdn.example/ch2/archive-${startSec}-3600.m3u8`);
    }

    // 3. M3U default mode with templated full URL
    const rDef = await svc.resolveCatchupStream?.(archDef?.key ?? '', {
      startMs: START,
      stopMs: STOP,
    });
    expect(rDef?.ok).toBe(true);
    if (rDef?.ok) {
      expect(rDef.value.url).toBe(
        `https://${archUser}:${archPass}@archive.example/${['timeshift', archUser, archPass, '3600', '2026-11-24:10-00', '300.ts?token=archtok77'].join('/')}`,
      );
    }

    // 4. M3U shift mode
    const rShift = await svc.resolveCatchupStream?.(shiftCh?.key ?? '', {
      startMs: START,
      stopMs: STOP,
    });
    expect(rShift?.ok).toBe(true);
    if (rShift?.ok) {
      expect(rShift.value.url).toBe(
        `https://cdn.example/ch4/stream.m3u8?quality=hd&utc=${startSec}&lutc=${endSec}`,
      );
    }

    // 5. M3U xc mode parsed from live URL
    const rM3uXc = await svc.resolveCatchupStream?.(m3uXc?.key ?? '', {
      startMs: START,
      stopMs: STOP,
    });
    expect(rM3uXc?.ok).toBe(true);
    if (rM3uXc?.ok) {
      expect(rM3uXc.value.url).toBe(
        `https://panel.example/${['timeshift', xcUser, xcPass, '60', '2026-11-24:10-00', '505.ts'].join('/')}`,
      );
    }

    // 6. Unavailable, expired, future, and hasArchive === false rejections
    expect(
      await svc.resolveCatchupStream?.(noCatchup?.key ?? '', { startMs: START, stopMs: STOP }),
    ).toMatchObject({ ok: false, error: { category: 'playback', code: 'catchup-unavailable' } });

    expect(
      await svc.resolveCatchupStream?.(alpha?.key ?? '', {
        startMs: START,
        stopMs: STOP,
        hasArchive: false,
      }),
    ).toMatchObject({ ok: false, error: { category: 'playback', code: 'catchup-unavailable' } });

    expect(
      await svc.resolveCatchupStream?.(alpha?.key ?? '', {
        startMs: NOW + 60_000,
        stopMs: NOW + 3_660_000,
      }),
    ).toMatchObject({ ok: false, error: { category: 'playback', code: 'catchup-future' } });

    expect(
      await svc.resolveCatchupStream?.(alpha?.key ?? '', {
        startMs: NOW - 10 * 86_400_000,
        stopMs: NOW - 9 * 86_400_000,
      }),
    ).toMatchObject({ ok: false, error: { category: 'playback', code: 'catchup-expired' } });

    // Non-Xtream fetchChannelArchiveEpg returns ok([])
    const nonXtreamEpg = await svc.fetchChannelArchiveEpg?.(alpha?.key ?? '');
    expect(nonXtreamEpg).toEqual({ ok: true, value: [] });

    await svc.close();
  });

  it('persists Xtream serverTimezone, resolves Xtream catch-up URLs, fetches simpleEpg with hasArchive, and enforces parental controls (#31)', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();

    const http = mockHttp({
      'action=get_live_categories': JSON.stringify([
        { category_id: '10', category_name: 'Sports' },
      ]),
      'action=get_vod_categories': '[]',
      'action=get_series_categories': '[]',
      'action=get_live_streams': JSON.stringify([
        {
          stream_id: 777,
          num: 7,
          name: 'Sports One',
          category_id: '10',
          epg_channel_id: 'sports.one',
          tv_archive: 1,
          tv_archive_duration: 7,
        },
        {
          stream_id: 888,
          num: 8,
          name: 'Restricted Channel',
          category_id: '10',
          tv_archive: 1,
          tv_archive_duration: 3,
        },
      ]),
      'action=get_vod_streams': '[]',
      'action=get_series': '[]',
      'action=get_simple_data_table&stream_id=777': JSON.stringify({
        epg_listings: [
          {
            id: '1',
            title: Buffer.from('Morning Match').toString('base64'),
            description: Buffer.from('Full match replay').toString('base64'),
            start_timestamp: Math.floor(START / 1000),
            stop_timestamp: Math.floor(STOP / 1000),
            has_archive: 1,
            now_playing: 0,
          },
          {
            id: '2',
            title: Buffer.from('XXX Late Night').toString('base64'),
            description: Buffer.from('Adult show').toString('base64'),
            start_timestamp: Math.floor((START + 3_600_000) / 1000),
            stop_timestamp: Math.floor((STOP + 3_600_000) / 1000),
            has_archive: 0,
            now_playing: 1,
          },
        ],
      }),
      'player_api.php': JSON.stringify({
        user_info: {
          status: 'Active',
          is_trial: '0',
          max_connections: '2',
          allowed_output_formats: ['m3u8'],
        },
        server_info: {
          timezone: 'Europe/Istanbul',
        },
      }),
    });

    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http,
        clock: () => NOW,
        newId: () => 'xt1',
      }),
    );

    expect(
      (
        await svc.addSource({
          kind: 'xtream',
          name: 'Xtream Panel',
          server: 'https://xc.example',
          username: 'u1',
          password: 'p1',
        })
      ).ok,
    ).toBe(true);
    expect((await svc.importSource('xt1')).ok).toBe(true);

    // Verify serverTimezone persisted in SourceSettings
    const storedSource = await getSource(db, 'xt1');
    expect(storedSource?.settings.serverTimezone).toBe('Europe/Istanbul');

    const sportsKey = 'x:xt1:live:777';
    const restrictedKey = 'x:xt1:live:888';

    // START = 2026-11-24T10:00:00Z -> Europe/Istanbul (UTC+3) = 2026-11-24:13-00
    const catchup = await svc.resolveCatchupStream?.(sportsKey, {
      startMs: START,
      stopMs: STOP,
      hasArchive: true,
    });
    expect(catchup?.ok).toBe(true);
    if (catchup?.ok) {
      expect(catchup.value.url).toBe(
        'https://xc.example/timeshift/u1/p1/60/2026-11-24:13-00/777.m3u8',
      );
      expect(catchup.value.maxConnections).toBe(2);
    }

    // Enable parental controls & lock channel 888
    await svc.updateParentalSettings?.({ enabled: true, blockAdultKeywords: true });
    await svc.setParentalLock?.(
      {
        sourceId: 'xt1',
        targetKind: 'item',
        itemKind: 'live',
        targetKey: restrictedKey,
      },
      true,
    );

    // Locked channel fails with auth/parental-locked for both resolveCatchupStream and fetchChannelArchiveEpg
    expect(
      await svc.resolveCatchupStream?.(restrictedKey, { startMs: START, stopMs: STOP }),
    ).toMatchObject({ ok: false, error: { category: 'auth', code: 'parental-locked' } });
    expect(await svc.fetchChannelArchiveEpg?.(restrictedKey)).toMatchObject({
      ok: false,
      error: { category: 'auth', code: 'parental-locked' },
    });

    // Unlocked bypass works
    const unlockedRes = await svc.resolveCatchupStream?.(
      restrictedKey,
      { startMs: START, stopMs: STOP },
      { parentalUnlocked: true },
    );
    expect(unlockedRes?.ok).toBe(true);

    // fetchChannelArchiveEpg returns hasArchive flag and filters adult programmes while locked
    const filteredEpg = await svc.fetchChannelArchiveEpg?.(sportsKey);
    expect(filteredEpg?.ok).toBe(true);
    if (filteredEpg?.ok) {
      expect(filteredEpg.value).toHaveLength(1);
      expect(filteredEpg.value[0]).toMatchObject({
        channelKey: sportsKey,
        guideId: 'sports.one',
        title: 'Morning Match',
        description: 'Full match replay',
        hasArchive: true,
      });
    }

    // With parentalUnlocked: true, both entries are returned with exact hasArchive booleans
    const fullEpg = await svc.fetchChannelArchiveEpg?.(sportsKey, { parentalUnlocked: true });
    expect(fullEpg?.ok).toBe(true);
    if (fullEpg?.ok) {
      expect(fullEpg.value).toHaveLength(2);
      expect(fullEpg.value[0]?.hasArchive).toBe(true);
      expect(fullEpg.value[1]?.hasArchive).toBe(false);
    }

    // Programme-level parental lock via supplied title on an unrestricted channel
    expect(
      await svc.resolveCatchupStream?.(sportsKey, {
        startMs: START,
        stopMs: STOP,
        title: 'XXX Late Night Special',
      }),
    ).toMatchObject({ ok: false, error: { category: 'auth', code: 'parental-locked' } });

    // Unlocked bypasses programme title restriction
    expect(
      (
        await svc.resolveCatchupStream?.(
          sportsKey,
          { startMs: START, stopMs: STOP, title: 'XXX Late Night Special' },
          { parentalUnlocked: true },
        )
      )?.ok,
    ).toBe(true);

    // Programme-level parental lock via stored `programmes` DB row (rating or description) even when title is omitted
    await db.run(
      "INSERT OR REPLACE INTO channel_guide (source_id, channel_key, guide_id) VALUES ('xt1', ?, 'sports.one')",
      [sportsKey],
    );
    await db.run(
      `INSERT INTO programmes (source_id, guide_id, start, stop, title, description, rating_value, run_id, title_fold, description_fold)
       VALUES ('xt1', 'sports.one', ?, ?, 'Late Broadcast', 'Explicit adult content', '18+', 1, 'late broadcast', 'explicit adult content')`,
      [START, STOP],
    );
    await svc.updateParentalSettings?.({
      enabled: true,
      blockAdultKeywords: true,
      maxRatingAge: 13,
    });
    expect(
      await svc.resolveCatchupStream?.(sportsKey, { startMs: START, stopMs: STOP }),
    ).toMatchObject({ ok: false, error: { category: 'auth', code: 'parental-locked' } });
    expect(
      (
        await svc.resolveCatchupStream?.(
          sportsKey,
          { startMs: START, stopMs: STOP },
          { parentalUnlocked: true },
        )
      )?.ok,
    ).toBe(true);

    await svc.close();
  });

  it('normalizes Xtream creds.server with /player_api.php and ?query tails during catch-up resolution', async () => {
    const { db } = testDb();
    await openCatalog(db);
    const secrets = memorySecrets();
    const xtUser = 'u2';
    const xtPass = 'p2';
    const http = mockHttp({
      'action=get_live_categories': JSON.stringify([{ category_id: '1', category_name: 'Live' }]),
      'action=get_vod_categories': '[]',
      'action=get_series_categories': '[]',
      'action=get_live_streams': JSON.stringify([
        {
          stream_id: 901,
          num: 1,
          name: 'News 1',
          category_id: '1',
          tv_archive: 1,
          tv_archive_duration: 7,
        },
      ]),
      'action=get_vod_streams': '[]',
      'action=get_series': '[]',
      'player_api.php': JSON.stringify({
        user_info: { status: 'Active', is_trial: '0', max_connections: '1' },
        server_info: { timezone: 'UTC' },
      }),
    });

    const svc = createCoalescedCatalog(
      createCatalogService({
        db,
        secrets,
        scheduler: immediateScheduler,
        http,
        clock: () => NOW,
        newId: () => 'xt2',
      }),
    );

    await svc.addSource({
      kind: 'xtream',
      name: 'Panel With Tail',
      server: 'https://panel.example:8443/portal/player_api.php?foo=bar#frag',
      username: xtUser,
      password: xtPass,
    });
    expect((await svc.importSource('xt2')).ok).toBe(true);
    // Simulate legacy stored secret containing raw /player_api.php?query#frag
    await secrets.set(
      'source.xt2.xtream',
      JSON.stringify({
        server: 'https://panel.example:8443/portal/player_api.php?foo=bar#frag',
        username: xtUser,
        password: xtPass,
      }),
    );

    const resolved = await svc.resolveCatchupStream?.('x:xt2:live:901', {
      startMs: START,
      stopMs: STOP,
    });
    expect(resolved?.ok).toBe(true);
    if (resolved?.ok) {
      expect(resolved.value.url).toBe(
        [
          'https://panel.example:8443/portal',
          'timeshift',
          xtUser,
          xtPass,
          '60',
          '2026-11-24:10-00',
          '901.ts',
        ].join('/'),
      );
    }

    await svc.close();
  });
});
