import { describe, expect, it } from 'vitest';
import {
  parseStalkerTimestampMs,
  toStalkerCategories,
  toStalkerChannels,
  toStalkerEpgEntries,
  toStalkerEpgMap,
  toStalkerEpisodes,
  toStalkerPage,
  toStalkerProfile,
  toStalkerSeasons,
  toStalkerSeriesItems,
  toStalkerVodItems,
} from './stalker-records';
import { normalizeStalkerPortalUrl } from './stalker-url';

describe('normalizeStalkerPortalUrl', () => {
  it('normalizes host, scheme-less, /c/, /stalker_portal/c/, /portal.php, and /server/load.php', () => {
    expect(normalizeStalkerPortalUrl('http://portal.example:8080')).toEqual({
      ok: true,
      value: {
        endpoint: 'http://portal.example:8080/portal.php',
        fallbackEndpoint: 'http://portal.example:8080/server/load.php',
        candidates: [
          'http://portal.example:8080/portal.php',
          'http://portal.example:8080/server/load.php',
          'http://portal.example:8080/stalker_portal/server/load.php',
        ],
      },
    });
    expect(normalizeStalkerPortalUrl('portal.example:8080/c/')).toEqual({
      ok: true,
      value: {
        endpoint: 'http://portal.example:8080/portal.php',
        fallbackEndpoint: 'http://portal.example:8080/server/load.php',
        candidates: [
          'http://portal.example:8080/portal.php',
          'http://portal.example:8080/server/load.php',
          'http://portal.example:8080/stalker_portal/server/load.php',
          'http://portal.example:8080/c/portal.php',
          'http://portal.example:8080/c/server/load.php',
          'http://portal.example:8080/c/stalker_portal/server/load.php',
        ],
      },
    });
    expect(normalizeStalkerPortalUrl('https://portal.example/')).toEqual({
      ok: true,
      value: {
        endpoint: 'https://portal.example/portal.php',
        fallbackEndpoint: 'https://portal.example/server/load.php',
        candidates: [
          'https://portal.example/portal.php',
          'https://portal.example/server/load.php',
          'https://portal.example/stalker_portal/server/load.php',
        ],
      },
    });
    expect(normalizeStalkerPortalUrl('http://portal.example/stalker_portal/c/')).toEqual({
      ok: true,
      value: {
        endpoint: 'http://portal.example/stalker_portal/server/load.php',
        fallbackEndpoint: 'http://portal.example/stalker_portal/portal.php',
        candidates: [
          'http://portal.example/stalker_portal/server/load.php',
          'http://portal.example/stalker_portal/portal.php',
          'http://portal.example/stalker_portal/c/portal.php',
          'http://portal.example/stalker_portal/c/server/load.php',
          'http://portal.example/portal.php',
          'http://portal.example/server/load.php',
        ],
      },
    });
    expect(normalizeStalkerPortalUrl('http://portal.example/portal.php?foo=1#x')).toEqual({
      ok: true,
      value: {
        endpoint: 'http://portal.example/portal.php',
        fallbackEndpoint: 'http://portal.example/server/load.php',
        candidates: [
          'http://portal.example/portal.php',
          'http://portal.example/server/load.php',
          'http://portal.example/stalker_portal/server/load.php',
        ],
      },
    });
    expect(
      normalizeStalkerPortalUrl('https://portal.example/stalker_portal/server/load.php'),
    ).toEqual({
      ok: true,
      value: {
        endpoint: 'https://portal.example/stalker_portal/server/load.php',
        fallbackEndpoint: 'https://portal.example/stalker_portal/portal.php',
        candidates: [
          'https://portal.example/stalker_portal/server/load.php',
          'https://portal.example/stalker_portal/portal.php',
          'https://portal.example/portal.php',
          'https://portal.example/server/load.php',
        ],
      },
    });
    expect(normalizeStalkerPortalUrl('http://portal.example/stalker_portal/')).toEqual({
      ok: true,
      value: {
        endpoint: 'http://portal.example/stalker_portal/server/load.php',
        fallbackEndpoint: 'http://portal.example/stalker_portal/portal.php',
        candidates: [
          'http://portal.example/stalker_portal/server/load.php',
          'http://portal.example/stalker_portal/portal.php',
        ],
      },
    });
  });

  it('rejects empty, control-char, credentialed, or non-http(s) URLs without leaking input', () => {
    for (const bad of [
      '',
      '   ',
      'ftp://portal.example',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://user:pass@portal.example/c/',
      'http://portal.example/\nportal.php',
      'http://',
      '/relative/path',
      `http://portal.example/${'a'.repeat(2100)}`,
    ]) {
      const res = normalizeStalkerPortalUrl(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toEqual({ category: 'source-format', code: 'invalid-portal-url' });
      }
    }
  });
});

describe('parseStalkerTimestampMs', () => {
  it('parses epoch seconds, epoch ms, date-only, explicit offsets, and IANA timezones', () => {
    expect(parseStalkerTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseStalkerTimestampMs('1700000000000')).toBe(1_700_000_000_000);
    expect(parseStalkerTimestampMs('2027-01-15')).toBe(Date.UTC(2027, 0, 15));
    expect(parseStalkerTimestampMs('2028-02-29 12:30:45Z')).toBe(Date.UTC(2028, 1, 29, 12, 30, 45));
    expect(parseStalkerTimestampMs('2026-11-24 14:00:00+02:00')).toBe(
      Date.UTC(2026, 10, 24, 12, 0, 0),
    );
    expect(parseStalkerTimestampMs('2026-11-24 14:00:00-05:00')).toBe(
      Date.UTC(2026, 10, 24, 19, 0, 0),
    );
    expect(parseStalkerTimestampMs('2026-07-01 12:00:00', 'Europe/Berlin')).toBe(
      Date.UTC(2026, 6, 1, 10, 0, 0),
    );
    expect(parseStalkerTimestampMs('2026-07-01 12:00:00', 'Invalid/Zone')).toBe(
      Date.UTC(2026, 6, 1, 12, 0, 0),
    );
  });

  it('rejects zero dates, out-of-range calendar dates, and junk', () => {
    expect(parseStalkerTimestampMs(0)).toBeUndefined();
    expect(parseStalkerTimestampMs(-5)).toBeUndefined();
    expect(parseStalkerTimestampMs('0000-00-00 00:00:00')).toBeUndefined();
    expect(parseStalkerTimestampMs('2027-02-29 00:00:00')).toBeUndefined();
    expect(parseStalkerTimestampMs('2026-13-01 00:00:00')).toBeUndefined();
    expect(parseStalkerTimestampMs('2026-11-24 12:00:00+25:00')).toBeUndefined();
    expect(parseStalkerTimestampMs('unlimited')).toBeUndefined();
    expect(parseStalkerTimestampMs(null)).toBeUndefined();
  });
});

describe('toStalkerProfile and toStalkerCategories', () => {
  it('maps blocked, descriptive status, and fallback expiry/connection fields', () => {
    expect(
      toStalkerProfile({
        status: 1,
        blocked: '1',
        tariff_expired_date: '2026-12-31',
        playback_limit: '3',
        timezone: 'UTC',
      }),
    ).toEqual({
      status: 'Blocked',
      blocked: true,
      expiresAt: Date.UTC(2026, 11, 31),
      maxConnections: 3,
      timezone: 'UTC',
    });
    expect(toStalkerProfile({ status: 'Expired', blocked: false })).toEqual({
      status: 'Expired',
      blocked: false,
    });
  });

  it('filters synthetic All/* entries, deduplicates IDs, and keeps valid categories', () => {
    expect(
      toStalkerCategories([
        null,
        { id: '*', title: 'All' },
        { id: 'all', title: 'All Channels' },
        { id: '0', title: 'Everything', alias: 'All' },
        { id: '1', name: 'Movies', censored: true },
        { id: '1', name: 'Movies Duplicate' },
        { id: '2' },
      ]),
    ).toEqual([{ id: '1', title: 'Movies', censored: true }]);
  });
});

describe('toStalkerChannels, VOD, series, seasons, episodes, and EPG mappers', () => {
  it('handles nested cmds, catchup hours vs days, and artwork validation', () => {
    const channels = toStalkerChannels([
      'skip',
      { name: 'No ID' },
      {
        id: '1',
        name: 'Nested Cmd',
        cmds: [{ url: 'ffrt http://host/1' }],
        enable_tv_archive: '1',
        tv_archive_duration: 72,
        logo: 'data:image/png;base64,iVBORw0KGgo=',
        censored: 1,
      },
      {
        id: '2',
        name: 'Day Catchup',
        cmd: 'http://host/2',
        tv_archive: 1,
        tv_archive_duration: 5,
        logo: 'data:image/svg+xml,<svg/>',
      },
      {
        id: '3',
        name: 'Relative Logo',
        cmd: 'http://host/3',
        logo: 'logos/3.png',
        enable_tv_archive: true,
        tv_archive_duration: 0,
      },
    ]);
    expect(channels).toEqual([
      {
        id: '1',
        name: 'Nested Cmd',
        cmd: 'ffrt http://host/1',
        catchupDays: 3,
        logo: 'data:image/png;base64,iVBORw0KGgo=',
        censored: true,
      },
      {
        id: '2',
        name: 'Day Catchup',
        cmd: 'http://host/2',
        catchupDays: 5,
      },
      {
        id: '3',
        name: 'Relative Logo',
        cmd: 'http://host/3',
        catchupDays: 0,
      },
    ]);
  });

  it('bounds cast/director length, parses HMS/MM:SS durations, and maps VOD/series/seasons/episodes', () => {
    const longCast = 'A'.repeat(600);
    const longDir = 'D'.repeat(300);
    const [vod] = toStalkerVodItems([
      {
        id: '10',
        o_name: 'Original Title',
        category_id: '5',
        cmd: 'ffmpeg http://host/vod/10',
        cover: 'https://cdn.example/c.jpg',
        rating_kinopoisk: '7.4',
        year: 2022,
        plot: 'Plot text',
        cast: longCast,
        director: longDir,
        time: '01:30:10',
        added: '2026-10-01 00:00:00',
        is_series: '1',
        censored: true,
      },
    ]);
    expect(vod?.name).toBe('Original Title');
    expect(vod?.rating).toBe(7.4);
    expect(vod?.durationSec).toBe(5410);
    expect(vod?.cast?.length).toBe(512);
    expect(vod?.director?.length).toBe(256);
    expect(vod?.isSeries).toBe(true);
    expect(vod?.censored).toBe(true);

    const [series] = toStalkerSeriesItems([
      {
        id: '20',
        name: 'Series One',
        logo: 'https://cdn.example/s20.jpg',
        rating: '9.0',
        year: '2025-05-01',
        censored: '1',
      },
    ]);
    expect(series).toMatchObject({
      id: '20',
      name: 'Series One',
      cover: 'https://cdn.example/s20.jpg',
      rating: 9,
      year: 2025,
      censored: true,
    });

    expect(toStalkerSeasons('20', [{ id: '20:3', name: 'Season 3' }, { id: '20:4' }])).toEqual([
      { id: '20:3', seriesId: '20', seasonNumber: 3, name: 'Season 3' },
      { id: '20:4', seriesId: '20', seasonNumber: 2, name: 'Season 2' },
    ]);

    expect(
      toStalkerEpisodes('20', '20:3', [
        { id: 'ep1', title: 'First', cmd: 'c1', duration_secs: 1800 },
        { id: 'ep2', episode_num: 4, name: 'Fourth', cmd: 'c2', duration: '45:00' },
      ]),
    ).toEqual([
      {
        id: 'ep1',
        seriesId: '20',
        seasonId: '20:3',
        episodeNumber: 1,
        title: 'First',
        cmd: 'c1',
        durationSec: 1800,
      },
      {
        id: 'ep2',
        seriesId: '20',
        seasonId: '20:3',
        episodeNumber: 4,
        title: 'Fourth',
        cmd: 'c2',
        durationSec: 2700,
      },
    ]);
  });

  it('parses EPG duration fallback, filters invalid ranges, and builds prototype-safe EPG maps', () => {
    expect(
      toStalkerEpgEntries([
        { start_timestamp: 1_700_000_000, duration: 1800, title: 'Half Hour' },
        { start_timestamp: 1_700_000_000, stop_timestamp: 1_699_999_000, name: 'Backwards' },
        { name: 'Missing Start' },
      ]),
    ).toEqual([
      {
        start: 1_700_000_000_000,
        stop: 1_700_001_800_000,
        title: 'Half Hour',
      },
    ]);

    const map = toStalkerEpgMap({
      '55': [{ start: '2026-11-24 10:00:00', end: '2026-11-24 11:00:00', title: 'Morning' }],
      constructor: [],
      notArray: 'skip',
    });
    expect(map['55']).toHaveLength(1);
    expect('constructor' in map).toBe(false);

    const page = toStalkerPage({ data: [{ id: '1', name: 'Ch', cmd: 'c' }] }, 3, toStalkerChannels);
    expect(page).toEqual({
      items: [{ id: '1', name: 'Ch', cmd: 'c', catchupDays: 0 }],
      totalItems: 1,
      maxPageItems: 14,
      page: 3,
    });
  });
});
