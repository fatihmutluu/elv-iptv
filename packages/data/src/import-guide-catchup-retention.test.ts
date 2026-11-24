import { describe, expect, it } from 'vitest';
import {
  channelXml,
  HOUR,
  NOW,
  programmeXml,
  rows,
  run,
  setupGuide,
  stream,
  titles,
  tv,
} from './import-guide-test-helpers';
import { extinf } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { MIGRATIONS } from './schema';
import { testDb } from './test-db';

const DAY = 24 * HOUR;

async function setupCatchupSource(catchupDays: number) {
  const playlist =
    '#EXTM3U\n' +
    extinf(
      'Haber Bir',
      stream(1),
      `tvg-id="haber1.tr" catchup="default" catchup-days="${catchupDays}"`,
    );
  const e = await setupGuide(playlist);
  const catalogRes = await importCatalog(e.sourceId, e.deps);
  expect(catalogRes.ok).toBe(true);
  return e;
}

describe('catch-up retention & bad-timestamp guard (#268)', () => {
  it('leaves retained catch-up history intact when a refresh contains 19700101 bad timestamps', async () => {
    const e = await setupCatchupSource(7);
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', -3 * DAY, 1, 'Three Days Ago'),
      programmeXml('haber1.tr', -1 * DAY, 1, 'Yesterday News'),
      programmeXml('haber1.tr', 0, 1, 'Today Live'),
    );
    expect((await run(e)).ok).toBe(true);
    expect(await titles(e)).toEqual(['Three Days Ago', 'Yesterday News', 'Today Live']);

    // Refresh with ONLY corrupt 19700101 timestamps -> dropped as programme-bad-time, previous guide stays intact
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      `<programme start="19700101000000 +0000" stop="19700101010000 +0000" channel="haber1.tr"><title>Corrupt Epoch</title></programme>`,
    );
    const badOnly = await run(e, { now: NOW + HOUR });
    expect(badOnly.ok).toBe(true);
    expect(await titles(e)).toEqual(['Three Days Ago', 'Yesterday News', 'Today Live']);

    // Refresh with BOTH corrupt 19700101 timestamps AND valid future programme -> corrupt rows dropped,
    // earliestValidFreshStart is NOT poisoned to 1970, and past catch-up history is preserved alongside fresh programme
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      `<programme start="19700101000000 +0000" stop="19700101010000 +0000" channel="haber1.tr"><title>Corrupt Epoch</title></programme>`,
      programmeXml('haber1.tr', 2 * HOUR, 1, 'Future Update'),
    );
    const mixed = await run(e, { now: NOW + 2 * HOUR });
    expect(mixed.ok).toBe(true);
    expect(await titles(e)).toEqual([
      'Three Days Ago',
      'Yesterday News',
      'Today Live',
      'Future Update',
    ]);
  });

  it('preserves past catch-up programmes within catchup_days on a future-only refresh and prunes older ones', async () => {
    const e = await setupCatchupSource(5);
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', -4 * DAY, 1, 'Day Minus 4'),
      programmeXml('haber1.tr', -2 * DAY, 1, 'Day Minus 2'),
      programmeXml('haber1.tr', 0, 1, 'Day Zero'),
    );
    expect((await run(e)).ok).toBe(true);
    expect(await titles(e)).toEqual(['Day Minus 4', 'Day Minus 2', 'Day Zero']);

    // Advance time by 2 days with a future-only feed:
    // now2 = NOW + 2*DAY, catchup_days = 5 -> retentionFloorMs = NOW - 3*DAY.
    // 'Day Minus 4' (stop = NOW - 4*DAY + 1h <= NOW - 3*DAY) must be pruned!
    // 'Day Minus 2' and 'Day Zero' remain inside retention and are preserved alongside 'Day Plus 2'.
    const now2 = NOW + 2 * DAY;
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', 2 * DAY, 1, 'Day Plus 2'),
    );
    expect((await run(e, { now: now2 })).ok).toBe(true);
    expect(await titles(e)).toEqual(['Day Minus 2', 'Day Zero', 'Day Plus 2']);
  });

  it('clamps catchup_days retention ceiling to 30 days', async () => {
    const e = await setupCatchupSource(90);
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', -35 * DAY, 1, 'Beyond 30 Days'),
      programmeXml('haber1.tr', -20 * DAY, 1, 'Within 30 Days'),
      programmeXml('haber1.tr', 0, 1, 'Current Show'),
    );
    expect((await run(e)).ok).toBe(true);
    expect(await titles(e)).toEqual(['Within 30 Days', 'Current Show']);
  });

  it('replaces overlapping fresh programmes cleanly without duplicates and keeps programmes_fts in sync', async () => {
    const e = await setupCatchupSource(7);
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', -3 * HOUR, 1, 'Archive Documentary'),
      programmeXml('haber1.tr', -HOUR, 2, 'Stale Overlap'),
      programmeXml('haber1.tr', HOUR, 1, 'Stale Future'),
    );
    expect((await run(e)).ok).toBe(true);

    // Fresh refresh starts at NOW (overlapping 'Stale Overlap' [NOW-1h, NOW+1h)) and replaces 'Stale Future'
    e.server.body = tv(
      channelXml('haber1.tr', 'Haber Bir'),
      programmeXml('haber1.tr', 0, 1, 'Fresh Breaking News'),
      programmeXml('haber1.tr', HOUR, 1, 'Fresh Evening'),
    );
    expect((await run(e, { now: NOW })).ok).toBe(true);

    const stored = await rows(
      e,
      'SELECT start, stop, title FROM programmes WHERE source_id = ? ORDER BY start',
      [e.sourceId],
    );
    expect(stored).toEqual([
      { start: NOW - 3 * HOUR, stop: NOW - 2 * HOUR, title: 'Archive Documentary' },
      { start: NOW - HOUR, stop: NOW, title: 'Stale Overlap' },
      { start: NOW, stop: NOW + HOUR, title: 'Fresh Breaking News' },
      { start: NOW + HOUR, stop: NOW + 2 * HOUR, title: 'Fresh Evening' },
    ]);

    // FTS must match both preserved past programmes and fresh programmes, and NOT stale replaced ones
    const ftsPreserved = await rows(
      e,
      `SELECT title_fold FROM programmes_fts WHERE programmes_fts MATCH '"documentary"*'`,
    );
    expect(ftsPreserved).toHaveLength(1);

    const ftsFresh = await rows(
      e,
      `SELECT title_fold FROM programmes_fts WHERE programmes_fts MATCH '"breaking"*'`,
    );
    expect(ftsFresh).toHaveLength(1);

    const ftsReplaced = await rows(
      e,
      `SELECT title_fold FROM programmes_fts WHERE programmes_fts MATCH '"future"*'`,
    );
    expect(ftsReplaced).toHaveLength(0);

    const ftsCount = await rows(e, 'SELECT count(*) AS n FROM programmes_fts WHERE source_id = ?', [
      e.sourceId,
    ]);
    expect(ftsCount).toEqual([{ n: stored.length }]);
  });

  it('isolates retention cutoff per guide_id so one channel with -6d fresh rows does not wipe another catch-up channel', async () => {
    const playlist =
      '#EXTM3U\n' +
      extinf('Channel A', stream(1), 'tvg-id="ch-a.tr" catchup="default" catchup-days="7"') +
      extinf('Channel B', stream(2), 'tvg-id="ch-b.tr" catchup="default" catchup-days="7"');
    const e = await setupGuide(playlist);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    // Initial import: both channels have past (-2d) and current (0) programmes
    e.server.body = tv(
      channelXml('ch-a.tr', 'Channel A'),
      channelXml('ch-b.tr', 'Channel B'),
      programmeXml('ch-a.tr', -2 * DAY, 1, 'Ch A Past'),
      programmeXml('ch-a.tr', 0, 1, 'Ch A Now'),
      programmeXml('ch-b.tr', -2 * DAY, 1, 'Ch B Retained -2d'),
      programmeXml('ch-b.tr', 0, 1, 'Ch B Retained Now'),
    );
    expect((await run(e)).ok).toBe(true);

    // Refresh: Channel A (and an unmapped channel) carry -6d fresh rows, while Channel B only gets future (+2h) rows.
    // Channel B's retained -2d and 0 catch-up history MUST survive!
    e.server.body = tv(
      channelXml('ch-a.tr', 'Channel A'),
      channelXml('ch-b.tr', 'Channel B'),
      channelXml('unmapped.tr', 'Unmapped Channel'),
      programmeXml('unmapped.tr', -6 * DAY, 1, 'Unmapped -6d'),
      programmeXml('ch-a.tr', -6 * DAY, 1, 'Ch A Fresh -6d'),
      programmeXml('ch-a.tr', 2 * HOUR, 1, 'Ch A Fresh +2h'),
      programmeXml('ch-b.tr', 2 * HOUR, 1, 'Ch B Fresh +2h'),
    );
    expect((await run(e, { now: NOW + HOUR })).ok).toBe(true);

    const chBTitles = (
      await rows(
        e,
        'SELECT title FROM programmes WHERE source_id = ? AND guide_id = ? ORDER BY start',
        [e.sourceId, 'ch-b.tr'],
      )
    ).map((r) => r.title);
    expect(chBTitles).toEqual(['Ch B Retained -2d', 'Ch B Retained Now', 'Ch B Fresh +2h']);

    const chATitles = (
      await rows(
        e,
        'SELECT title FROM programmes WHERE source_id = ? AND guide_id = ? ORDER BY start',
        [e.sourceId, 'ch-a.tr'],
      )
    ).map((r) => r.title);
    expect(chATitles).toEqual(['Ch A Fresh -6d', 'Ch A Fresh +2h']);
  });
});

describe('MIGRATION_V13 idx_programmes_source_stop (#6, #25, #268)', () => {
  it('creates idx_programmes_source_stop on fresh and v12-upgraded databases', async () => {
    const fresh = testDb();
    expect(SCHEMA_VERSION).toBe(13);
    expect((await openCatalog(fresh.db)).ok).toBe(true);
    const freshIndexes = (
      await fresh.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_programmes_source_stop'",
      )
    ).map((r) => r.name);
    expect(freshIndexes).toEqual(['idx_programmes_source_stop']);

    const upgraded = testDb();
    for (let i = 0; i < 12; i += 1) {
      await upgraded.db.exec(MIGRATIONS[i] ?? '');
    }
    await upgraded.db.exec('PRAGMA user_version = 12');
    await upgraded.db.run(
      'INSERT INTO programmes (source_id, guide_id, start, stop, title, description, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['s1', 'ch-a.tr', 1000, 2000, 'İstanbul Gecesi', 'Çağrı Özeti', 1],
    );
    const before = await upgraded.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_programmes_source_stop'",
    );
    expect(before).toEqual([]);

    expect((await openCatalog(upgraded.db)).ok).toBe(true);
    expect(await upgraded.db.all('PRAGMA user_version')).toEqual([{ user_version: 13 }]);
    const after = (
      await upgraded.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_programmes_source_stop'",
      )
    ).map((r) => r.name);
    expect(after).toEqual(['idx_programmes_source_stop']);
    const folded = await upgraded.db.all<{ title_fold: string; description_fold: string }>(
      'SELECT title_fold, description_fold FROM programmes WHERE source_id = ?',
      ['s1'],
    );
    expect(folded).toEqual([{ title_fold: 'istanbul gecesi', description_fold: 'cagri ozeti' }]);
  });
});
