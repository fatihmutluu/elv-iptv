import { describe, expect, it } from 'vitest';
import {
  classifyAccountFailure,
  parseXtreamTimestampMs,
  toAccount,
  toEpg,
  toLive,
  toMovies,
  toSeries,
  toVodInfo,
} from './xtream-records';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('toEpg archive & now_playing parsing (#306)', () => {
  it('coerces has_archive tolerantly across numeric, string, boolean, and omitted forms', () => {
    const entries = toEpg({
      epg_listings: [
        { title: b64('Num 1'), start_timestamp: 100, stop_timestamp: 200, has_archive: 1 },
        { title: b64('Num 0'), start_timestamp: 200, stop_timestamp: 300, has_archive: 0 },
        { title: b64('Str 1'), start_timestamp: 300, stop_timestamp: 400, has_archive: '1' },
        { title: b64('Str 0'), start_timestamp: 400, stop_timestamp: 500, has_archive: '0' },
        { title: b64('Bool true'), start_timestamp: 500, stop_timestamp: 600, has_archive: true },
        { title: b64('Bool false'), start_timestamp: 600, stop_timestamp: 700, has_archive: false },
        { title: b64('Omitted'), start_timestamp: 700, stop_timestamp: 800 },
        { title: b64('Null'), start_timestamp: 800, stop_timestamp: 900, has_archive: null },
        { title: b64('Unknown'), start_timestamp: 900, stop_timestamp: 1000, has_archive: 'maybe' },
      ],
    });

    expect(entries.map((e) => e.hasArchive)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      undefined,
      undefined,
      undefined,
    ]);
    expect('hasArchive' in (entries[6] as object)).toBe(false);
  });

  it('coerces now_playing tolerantly and preserves base64 decoding with timezone normalization', () => {
    const entries = toEpg(
      {
        epg_listings: [
          {
            title: b64('Akşam Haberleri'),
            description: b64('Günün özeti'),
            start: '2026-06-01 21:00:00',
            end: '2026-06-01 22:00:00',
            has_archive: '1',
            now_playing: 1,
          },
          {
            title: b64('Gece Kuşağı'),
            description: b64('Belgesel'),
            start: '2026-06-01 22:00:00',
            stop: '2026-06-01 23:00:00',
            has_archive: '0',
            now_playing: '0',
          },
          {
            title: b64('Sabah Yayını'),
            start: '2026-06-02 07:00:00',
            end: '2026-06-02 08:00:00',
            now_playing: true,
          },
          {
            title: b64('Öğle Yayını'),
            start: '2026-06-02 12:00:00',
            end: '2026-06-02 13:00:00',
            now_playing: false,
          },
        ],
      },
      'Europe/Istanbul',
    );

    expect(entries).toEqual([
      {
        start: Date.UTC(2026, 5, 1, 18, 0, 0),
        stop: Date.UTC(2026, 5, 1, 19, 0, 0),
        title: 'Akşam Haberleri',
        desc: 'Günün özeti',
        hasArchive: true,
        nowPlaying: true,
      },
      {
        start: Date.UTC(2026, 5, 1, 19, 0, 0),
        stop: Date.UTC(2026, 5, 1, 20, 0, 0),
        title: 'Gece Kuşağı',
        desc: 'Belgesel',
        hasArchive: false,
        nowPlaying: false,
      },
      {
        start: Date.UTC(2026, 5, 2, 4, 0, 0),
        stop: Date.UTC(2026, 5, 2, 5, 0, 0),
        title: 'Sabah Yayını',
        nowPlaying: true,
      },
      {
        start: Date.UTC(2026, 5, 2, 9, 0, 0),
        stop: Date.UTC(2026, 5, 2, 10, 0, 0),
        title: 'Öğle Yayını',
        nowPlaying: false,
      },
    ]);
  });

  it('supports fixed non-IANA timezone offsets (UTC+3, GMT-05:30) and ms epochs in toEpg (XC-1, XC-3)', () => {
    const entries = toEpg(
      {
        epg_listings: [
          {
            title: b64('Fixed Offset'),
            start: '2026-06-01 21:00:00',
            end: '2026-06-01 22:00:00',
          },
          {
            title: b64('Millis Timestamp'),
            start_timestamp: '1700000000000',
            stop_timestamp: '1700003600000',
          },
        ],
      },
      'UTC+3',
    );
    expect(entries).toEqual([
      {
        start: Date.UTC(2026, 5, 1, 18, 0, 0),
        stop: Date.UTC(2026, 5, 1, 19, 0, 0),
        title: 'Fixed Offset',
      },
      {
        start: 1_700_000_000_000,
        stop: 1_700_003_600_000,
        title: 'Millis Timestamp',
      },
    ]);
  });
});

describe('parseXtreamTimestampMs and Xtream record hardening (XC-1, XC-2, XC-3, XC-4)', () => {
  const fixedNow = Date.UTC(2026, 10, 28, 12, 0, 0);

  it('parses seconds, 13-digit ms epochs without multiplying by 1000, ISO strings, and rejects <= 0 or distant future (XC-1)', () => {
    expect(parseXtreamTimestampMs('1700000000')).toBe(1_700_000_000_000);
    expect(parseXtreamTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseXtreamTimestampMs('1700000000000')).toBe(1_700_000_000_000);
    expect(parseXtreamTimestampMs('2025-04-10 15:30:00')).toBe(Date.UTC(2025, 3, 10, 15, 30, 0));
    expect(parseXtreamTimestampMs('2025-04-10T15:30:00Z')).toBe(Date.UTC(2025, 3, 10, 15, 30, 0));
    expect(parseXtreamTimestampMs('2025-04-10T18:30:00+03:00')).toBe(
      Date.UTC(2025, 3, 10, 15, 30, 0),
    );
    expect(parseXtreamTimestampMs('0')).toBeUndefined();
    expect(parseXtreamTimestampMs(0)).toBeUndefined();
    expect(parseXtreamTimestampMs('-1')).toBeUndefined();
    expect(parseXtreamTimestampMs('')).toBeUndefined();
    expect(parseXtreamTimestampMs(null)).toBeUndefined();

    // Future guard: within +24h allowed, beyond +24h dropped when rejectFuture is true
    expect(
      parseXtreamTimestampMs(Math.floor((fixedNow + 12 * 3_600_000) / 1000), {
        nowMs: fixedNow,
        rejectFuture: true,
      }),
    ).toBe(fixedNow + 12 * 3_600_000);
    expect(
      parseXtreamTimestampMs(Math.floor((fixedNow + 48 * 3_600_000) / 1000), {
        nowMs: fixedNow,
        rejectFuture: true,
      }),
    ).toBeUndefined();
    // Without rejectFuture (e.g. exp_date), future dates are preserved
    expect(
      parseXtreamTimestampMs(Math.floor((fixedNow + 365 * 86_400_000) / 1000), {
        nowMs: fixedNow,
      }),
    ).toBe(fixedNow + 365 * 86_400_000);
  });

  it('drops spoofed future added/last_modified and keeps ms/ISO recency timestamps on live, movies, and series (XC-1)', () => {
    const farFutureSec = Math.floor((Date.now() + 90 * 86_400_000) / 1000);
    const live = toLive([
      { stream_id: 1, name: 'A', added: '1700000000000' },
      { stream_id: 2, name: 'B', added: String(farFutureSec) },
      { stream_id: 3, name: 'C', added: '0' },
    ]);
    expect(live.map((x) => x.added)).toEqual([1_700_000_000_000, undefined, undefined]);

    const movies = toMovies([
      { stream_id: 10, name: 'M1', added: '2025-01-15 10:00:00' },
      { stream_id: 11, name: 'M2', added: String(farFutureSec) },
    ]);
    expect(movies.map((x) => x.added)).toEqual([Date.UTC(2025, 0, 15, 10, 0, 0), undefined]);

    const series = toSeries([
      { series_id: 20, name: 'S1', last_modified: '1700000001000' },
      { series_id: 21, name: 'S2', last_modified: String(farFutureSec) },
    ]);
    expect(series.map((x) => x.lastModified)).toEqual([1_700_000_001_000, undefined]);
  });

  it('maps exp_date <= 0 to undefined, normalizes status/auth/past expiry, and infers clock-skew timezone in toAccount (XC-2, XC-3)', () => {
    const utcSec = Date.UTC(2026, 5, 1, 18, 0, 0) / 1000;
    const unlimited = toAccount(
      { auth: 1, status: 'active', exp_date: '0' },
      { timezone: 'Invalid/Zone', time_now: '2026-06-01 21:00:00', timestamp_now: utcSec },
      undefined,
      fixedNow,
    );
    expect(unlimited.status).toBe('Active');
    expect(unlimited.expiresAt).toBeUndefined();
    expect('expiresAt' in unlimited).toBe(false);
    expect(unlimited.serverTimezone).toBe('UTC+03:00');

    expect(
      toAccount({ auth: 1, exp_date: '-1' }, {}, undefined, fixedNow).expiresAt,
    ).toBeUndefined();
    expect(toAccount({ auth: '0' }, {}, undefined, fixedNow).status).toBe('Disabled');
    expect(toAccount({ auth: false }, {}, undefined, fixedNow).status).toBe('Disabled');
    expect(toAccount({ auth: 1, status: 'banned' }, {}, undefined, fixedNow).status).toBe(
      'Disabled',
    );
    expect(
      toAccount({ auth: 1, status: 'Active', exp_date: '1600000000' }, {}, undefined, fixedNow)
        .status,
    ).toBe('Expired');

    expect(classifyAccountFailure({ auth: false }, fixedNow)).toEqual({
      category: 'auth',
      code: 'invalid-credentials',
    });
    expect(classifyAccountFailure({ auth: 'false' }, fixedNow)).toEqual({
      category: 'auth',
      code: 'invalid-credentials',
    });
    expect(classifyAccountFailure({ auth: 1, status: 'Banned' }, fixedNow)).toEqual({
      category: 'auth',
      code: 'account-disabled',
    });
    expect(
      classifyAccountFailure({ auth: 1, status: 'Active', exp_date: '1600000000' }, fixedNow),
    ).toEqual({
      category: 'auth',
      code: 'account-expired',
    });
    expect(
      classifyAccountFailure({ auth: 1, status: 'Active', exp_date: '0' }, fixedNow),
    ).toBeUndefined();
  });

  it('filters placeholder metadata strings and unrated <= 0 scores, and extracts direct_source without synthetic extension in toVodInfo (XC-4)', () => {
    const movies = toMovies([
      {
        stream_id: 1,
        name: 'Placeholder Film',
        rating: '0',
        cast: 'N/A',
        director: '-',
      },
      {
        stream_id: 2,
        name: 'Negative Score Film',
        rating: -2,
        cast: 'null',
        director: 'None',
      },
      {
        stream_id: 3,
        name: 'Rated Film',
        rating: '7.4',
        cast: 'Ada Lovelace',
        director: 'Grace Hopper',
      },
    ]);
    expect(movies[0]?.rating).toBeUndefined();
    expect(movies[0]?.cast).toBeUndefined();
    expect(movies[0]?.director).toBeUndefined();
    expect(movies[1]?.rating).toBeUndefined();
    expect(movies[1]?.cast).toBeUndefined();
    expect(movies[1]?.director).toBeUndefined();
    expect(movies[2]?.rating).toBe(7.4);
    expect(movies[2]?.cast).toBe('Ada Lovelace');
    expect(movies[2]?.director).toBe('Grace Hopper');

    const series = toSeries([
      { series_id: 10, name: 'Unrated Show', rating: '0.0', plot: 'N/A', cast: '---' },
    ]);
    expect(series[0]?.rating).toBeUndefined();
    expect(series[0]?.plot).toBeUndefined();
    expect(series[0]?.cast).toBeUndefined();

    const vod = toVodInfo({
      info: { plot: 'N/A', director: 'none', cast: '-' },
      movie_data: { direct_source: 'https://cdn.example/vod/123.mkv' },
    });
    expect(vod).toEqual({ directSource: 'https://cdn.example/vod/123.mkv' });
    expect('extension' in vod).toBe(false);

    const vodBadDirect = toVodInfo({
      movie_data: { direct_source: 'file:///etc/passwd', container_extension: 'mkv' },
    });
    expect(vodBadDirect).toEqual({ extension: 'mkv' });
  });
});
