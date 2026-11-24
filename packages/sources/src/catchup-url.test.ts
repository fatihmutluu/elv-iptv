import { describe, expect, it } from 'vitest';
import {
  buildCatchupUrl,
  expandCatchupTemplate,
  formatXtreamTimeshiftStart,
  isProgrammeWithinCatchupWindow,
  normalizeCatchupMode,
} from './catchup-url';

const DAY_MS = 86_400_000;
const dollarToken = (name: string) => `$\u007b${name}\u007d`;

describe('normalizeCatchupMode (#220)', () => {
  it('normalizes canonical modes and common aliases case-insensitively', () => {
    expect(normalizeCatchupMode('default')).toBe('default');
    expect(normalizeCatchupMode('append')).toBe('append');
    expect(normalizeCatchupMode('shift')).toBe('shift');
    expect(normalizeCatchupMode('flussonic')).toBe('flussonic');
    expect(normalizeCatchupMode('flussonic-hls')).toBe('flussonic');
    expect(normalizeCatchupMode('flussonic-ts')).toBe('flussonic');
    expect(normalizeCatchupMode('fs')).toBe('flussonic');
    expect(normalizeCatchupMode('xc')).toBe('xc');
    expect(normalizeCatchupMode('xtream')).toBe('xc');
    expect(normalizeCatchupMode('stalker')).toBe('stalker');
    expect(normalizeCatchupMode('  FLUSSONIC  ')).toBe('flussonic');
    expect(normalizeCatchupMode('XC')).toBe('xc');
  });

  it('returns null for absent or unrecognized values', () => {
    expect(normalizeCatchupMode(undefined)).toBeNull();
    expect(normalizeCatchupMode(null)).toBeNull();
    expect(normalizeCatchupMode('')).toBeNull();
    expect(normalizeCatchupMode('   ')).toBeNull();
    expect(normalizeCatchupMode('unknown-mode')).toBeNull();
  });
});

describe('isProgrammeWithinCatchupWindow (#220)', () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);

  it('accepts past and in-progress programmes within the retention window', () => {
    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs - 3_600_000, stopMs: nowMs - 1_800_000 },
        7,
        nowMs,
      ),
    ).toEqual({ ok: true });

    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs, stopMs: nowMs + 1_800_000, hasArchive: true },
        1,
        nowMs,
      ),
    ).toEqual({ ok: true });

    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs - 7 * DAY_MS - 3_600_000, stopMs: nowMs - 7 * DAY_MS },
        7,
        nowMs,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects unavailable, invalid, future, and expired programmes with typed reasons', () => {
    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs - 3_600_000, stopMs: nowMs - 1_800_000, hasArchive: false },
        7,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'catchup-unavailable' });

    expect(
      isProgrammeWithinCatchupWindow({ startMs: nowMs - 3_600_000, stopMs: nowMs }, 0, nowMs),
    ).toEqual({ ok: false, reason: 'catchup-unavailable' });

    expect(
      isProgrammeWithinCatchupWindow({ startMs: nowMs - 3_600_000, stopMs: nowMs }, null, nowMs),
    ).toEqual({ ok: false, reason: 'catchup-unavailable' });

    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs - 1_800_000, stopMs: nowMs - 1_800_000 },
        7,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'catchup-unavailable' });

    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs + 60_000, stopMs: nowMs + 3_600_000 },
        7,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'catchup-future' });

    expect(
      isProgrammeWithinCatchupWindow(
        { startMs: nowMs - 8 * DAY_MS, stopMs: nowMs - 7 * DAY_MS - 1 },
        7,
        nowMs,
      ),
    ).toEqual({ ok: false, reason: 'catchup-expired' });
  });
});

describe('formatXtreamTimeshiftStart (#220)', () => {
  it('formats YYYY-MM-DD:HH-mm in server IANA timezone including DST and falls back to UTC', () => {
    const winterUtc = Date.UTC(2026, 0, 15, 2, 5, 0);
    const summerUtc = Date.UTC(2026, 6, 15, 2, 5, 0);

    expect(formatXtreamTimeshiftStart(winterUtc)).toBe('2026-01-15:02-05');
    expect(formatXtreamTimeshiftStart(winterUtc, 'Europe/Istanbul')).toBe('2026-01-15:05-05');
    expect(formatXtreamTimeshiftStart(winterUtc, 'America/New_York')).toBe('2026-01-14:21-05');
    expect(formatXtreamTimeshiftStart(summerUtc, 'America/New_York')).toBe('2026-07-14:22-05');
    expect(formatXtreamTimeshiftStart(Date.UTC(2026, 5, 1, 21, 0, 0), 'Europe/Istanbul')).toBe(
      '2026-06-02:00-00',
    );
    expect(formatXtreamTimeshiftStart(winterUtc, 'Not/A_Real_Zone')).toBe('2026-01-15:02-05');
  });
});

describe('expandCatchupTemplate (#220)', () => {
  it('expands epoch and calendar placeholders with timezone support', () => {
    const startMs = Date.UTC(2026, 5, 1, 18, 5, 9);
    const stopMs = Date.UTC(2026, 5, 1, 19, 5, 9);
    const nowMs = Date.UTC(2026, 5, 1, 20, 5, 9);

    const tpl = `https://cdn.example/catchup?u={utc}&s={start}&ds=${dollarToken('start')}&ts=${dollarToken('timestamp')}&e={end}&ue={utcend}&de=${dollarToken('end')}&dur={duration}&ddur=${dollarToken('duration')}&off={offset}&doff=${dollarToken('offset')}&l={lutc}&dt={Y}-{m}-{d}T{H}:{M}:{S}`;

    expect(
      expandCatchupTemplate(tpl, {
        startMs,
        stopMs,
        nowMs,
        serverTimezone: 'Europe/Istanbul',
      }),
    ).toBe(
      `https://cdn.example/catchup?u=${startMs / 1000}&s=${startMs / 1000}&ds=${startMs / 1000}&ts=${startMs / 1000}&e=${stopMs / 1000}&ue=${stopMs / 1000}&de=${stopMs / 1000}&dur=3600&ddur=3600&off=7200&doff=7200&l=${nowMs / 1000}&dt=2026-06-01T21:05:09`,
    );

    expect(
      expandCatchupTemplate('{Y}{m}{d}-{H}{M}{S}', {
        startMs,
        stopMs,
        nowMs,
        serverTimezone: 'Invalid/Timezone',
      }),
    ).toBe('20260601-180509');
  });
});

describe('buildCatchupUrl (#220)', () => {
  const startMs = Date.UTC(2026, 5, 1, 18, 0, 0);
  const stopMs = Date.UTC(2026, 5, 1, 19, 30, 0);
  const nowMs = Date.UTC(2026, 5, 1, 21, 0, 0);
  const startSec = startMs / 1000;
  const endSec = stopMs / 1000;
  const durationSec = (stopMs - startMs) / 1000;

  it('builds Xtream (xc) timeshift URLs with encoded credentials, timezone, ext, and min 1m duration', () => {
    const res = buildCatchupUrl({
      mode: 'xc',
      server: 'https://panel.example:8443///',
      username: 'user name',
      password: 'p@ss/word',
      streamId: 105,
      serverTimezone: 'Europe/Istanbul',
      programme: { startMs, stopMs, hasArchive: true },
      catchupDays: 7,
      nowMs,
    });
    expect(res).toEqual({
      ok: true,
      value: [
        'https://panel.example:8443',
        'timeshift',
        'user%20name',
        'p%40ss%2Fword',
        '90',
        '2026-06-01:21-00',
        '105.ts',
      ].join('/'),
    });

    const shortRes = buildCatchupUrl({
      mode: 'xc',
      server: 'http://panel.example:8080',
      username: 'u',
      password: 'p',
      streamId: '202',
      ext: '.m3u8',
      serverTimezone: 'America/New_York',
      programme: { startMs, stopMs: startMs + 20_000 },
      catchupDays: 3,
      nowMs,
    });
    expect(shortRes).toEqual({
      ok: true,
      value: 'http://panel.example:8080/timeshift/u/p/1/2026-06-01:14-00/202.m3u8',
    });
  });

  it('builds stalker and shift URLs preserving existing query parameters', () => {
    const plain = buildCatchupUrl({
      mode: 'stalker',
      liveUrl: 'http://tv.example/ch/10/index.m3u8',
      programme: { startMs, stopMs },
      catchupDays: 5,
      nowMs,
    });
    expect(plain).toEqual({
      ok: true,
      value: `http://tv.example/ch/10/index.m3u8?utc=${startSec}&lutc=${endSec}`,
    });

    const withQuery = buildCatchupUrl({
      mode: 'shift',
      liveUrl: 'https://tv.example/ch/10/stream.ts?token=abc123#top',
      programme: { startMs, stopMs },
      catchupDays: 5,
      nowMs,
    });
    expect(withQuery).toEqual({
      ok: true,
      value: `https://tv.example/ch/10/stream.ts?token=abc123&utc=${startSec}&lutc=${endSec}#top`,
    });

    const trailingAmp = buildCatchupUrl({
      mode: 'shift',
      liveUrl: 'https://tv.example/ch/10/stream.ts?token=abc123&',
      programme: { startMs, stopMs },
      catchupDays: 5,
      nowMs,
    });
    expect(trailingAmp).toEqual({
      ok: true,
      value: `https://tv.example/ch/10/stream.ts?token=abc123&utc=${startSec}&lutc=${endSec}`,
    });
  });

  it('builds flussonic URLs for .m3u8 and .ts preserving path prefix and query string', () => {
    const hls = buildCatchupUrl({
      mode: 'flussonic',
      liveUrl: 'https://cdn.example/live/channel1/index.m3u8?token=xyz#part',
      programme: { startMs, stopMs },
      catchupDays: 7,
      nowMs,
    });
    expect(hls).toEqual({
      ok: true,
      value: `https://cdn.example/live/channel1/archive-${startSec}-${durationSec}.m3u8?token=xyz#part`,
    });

    const ts = buildCatchupUrl({
      mode: 'flussonic',
      liveUrl: 'http://cdn.example/live/channel1/mpegts.ts?token=xyz',
      programme: { startMs, stopMs },
      catchupDays: 7,
      nowMs,
    });
    expect(ts).toEqual({
      ok: true,
      value: `http://cdn.example/live/channel1/timeshift_abs-${startSec}.ts?token=xyz`,
    });

    const rootHost = buildCatchupUrl({
      mode: 'flussonic',
      liveUrl: 'http://cdn.example',
      programme: { startMs, stopMs },
      catchupDays: 7,
      nowMs,
    });
    expect(rootHost).toEqual({
      ok: true,
      value: `http://cdn.example/timeshift_abs-${startSec}.ts`,
    });
  });

  it('builds append URLs with smart ?/& joining and template expansion', () => {
    const noQuery = buildCatchupUrl({
      mode: 'append',
      liveUrl: 'https://cdn.example/live/100.m3u8',
      catchupSource: '?utc={utc}&duration={duration}',
      programme: { startMs, stopMs },
      catchupDays: 3,
      nowMs,
    });
    expect(noQuery).toEqual({
      ok: true,
      value: `https://cdn.example/live/100.m3u8?utc=${startSec}&duration=${durationSec}`,
    });

    const hasQuery = buildCatchupUrl({
      mode: 'append',
      liveUrl: 'https://cdn.example/live/100.m3u8?token=tk',
      catchupSource: '?utc={utc}&lutc={lutc}',
      programme: { startMs, stopMs },
      catchupDays: 3,
      nowMs,
    });
    expect(hasQuery).toEqual({
      ok: true,
      value: `https://cdn.example/live/100.m3u8?token=tk&utc=${startSec}&lutc=${nowMs / 1000}`,
    });

    const leadingAmp = buildCatchupUrl({
      mode: 'append',
      liveUrl: 'https://cdn.example/live/100.m3u8',
      catchupSource: `&start=${dollarToken('start')}&end=${dollarToken('end')}`,
      programme: { startMs, stopMs },
      catchupDays: 3,
      nowMs,
    });
    expect(leadingAmp).toEqual({
      ok: true,
      value: `https://cdn.example/live/100.m3u8?start=${startSec}&end=${endSec}`,
    });

    const leadingAmpWithQuery = buildCatchupUrl({
      mode: 'append',
      liveUrl: 'https://cdn.example/live/100.m3u8?token=1',
      catchupSource: `&start=${dollarToken('start')}`,
      programme: { startMs, stopMs },
      catchupDays: 3,
      nowMs,
    });
    expect(leadingAmpWithQuery).toEqual({
      ok: true,
      value: `https://cdn.example/live/100.m3u8?token=1&start=${startSec}`,
    });

    const pathSuffix = buildCatchupUrl({
      mode: 'append',
      liveUrl: 'https://cdn.example/live/100',
      catchupSource: '/archive-{Y}{m}{d}-{H}{M}.ts',
      serverTimezone: 'Europe/Istanbul',
      programme: { startMs, stopMs },
      catchupDays: 3,
      nowMs,
    });
    expect(pathSuffix).toEqual({
      ok: true,
      value: 'https://cdn.example/live/100/archive-20260601-2100.ts',
    });

    const missingSource = buildCatchupUrl({
      mode: 'append',
      liveUrl: 'https://cdn.example/live/100.m3u8',
      programme: { startMs, stopMs },
      catchupDays: 3,
      nowMs,
    });
    expect(missingSource.ok).toBe(false);
    if (!missingSource.ok) {
      expect(missingSource.error.category).toBe('source-format');
      expect(missingSource.error.code).toBe('invalid-catchup-url');
    }
  });

  it('builds default URLs from full catchupSource template or falls back to shift', () => {
    const withTemplate = buildCatchupUrl({
      mode: 'default',
      liveUrl: 'https://cdn.example/live/100.m3u8',
      catchupSource: `https://archive.example/ch100/${dollarToken('start')}-${dollarToken('duration')}.m3u8`,
      programme: { startMs, stopMs },
      catchupDays: 7,
      nowMs,
    });
    expect(withTemplate).toEqual({
      ok: true,
      value: `https://archive.example/ch100/${startSec}-${durationSec}.m3u8`,
    });

    const fallbackShift = buildCatchupUrl({
      mode: 'default',
      liveUrl: 'https://cdn.example/live/100.m3u8?auth=1',
      programme: { startMs, stopMs },
      catchupDays: 7,
      nowMs,
    });
    expect(fallbackShift).toEqual({
      ok: true,
      value: `https://cdn.example/live/100.m3u8?auth=1&utc=${startSec}&lutc=${endSec}`,
    });
  });

  it('rejects expired, future, and hasArchive:false windows with playback errors', () => {
    const expired = buildCatchupUrl({
      mode: 'shift',
      liveUrl: 'http://tv.example/1.ts',
      programme: { startMs: nowMs - 10 * DAY_MS, stopMs: nowMs - 9 * DAY_MS },
      catchupDays: 7,
      nowMs,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.error.category).toBe('playback');
      expect(expired.error.code).toBe('catchup-expired');
    }

    const future = buildCatchupUrl({
      mode: 'shift',
      liveUrl: 'http://tv.example/1.ts',
      programme: { startMs: nowMs + 60_000, stopMs: nowMs + 120_000 },
      catchupDays: 7,
      nowMs,
    });
    expect(future.ok).toBe(false);
    if (!future.ok) {
      expect(future.error.category).toBe('playback');
      expect(future.error.code).toBe('catchup-future');
    }

    const noArchive = buildCatchupUrl({
      mode: 'xc',
      server: 'http://panel.example:8080',
      username: 'u',
      password: 'p',
      streamId: 1,
      programme: { startMs, stopMs, hasArchive: false },
      catchupDays: 7,
      nowMs,
    });
    expect(noArchive.ok).toBe(false);
    if (!noArchive.ok) {
      expect(noArchive.error.category).toBe('playback');
      expect(noArchive.error.code).toBe('catchup-unavailable');
    }
  });

  it('rejects scheme injection, control characters, and malformed URLs', () => {
    const badInputs = [
      {
        mode: 'default' as const,
        liveUrl: 'http://tv.example/1.ts',
        catchupSource: 'javascript:alert(1)',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'default' as const,
        liveUrl: 'http://tv.example/1.ts',
        catchupSource: 'file:///etc/passwd',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'shift' as const,
        liveUrl: 'http://tv.example/1.ts\r\nX-Injected: 1',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'append' as const,
        liveUrl: 'https://tv.example/1.ts',
        catchupSource: '?utc={utc}\x00evil',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'flussonic' as const,
        liveUrl: 'ftp://tv.example/live/index.m3u8',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'xc' as const,
        server: 'javascript://panel.example',
        username: 'u',
        password: 'p',
        streamId: 10,
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'xc' as const,
        server: 'http://panel.example',
        username: 'u',
        password: 'p',
        streamId: '   ',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'xc' as const,
        server: 'http://panel.example',
        username: 'u',
        password: 'p',
        streamId: 10,
        ext: 'ts/evil',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'flussonic' as const,
        liveUrl: 'no-scheme/index.m3u8',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
      {
        mode: 'shift' as const,
        liveUrl: 'http://tv.example/1.ts\x7f',
        programme: { startMs, stopMs },
        catchupDays: 7,
        nowMs,
      },
    ];

    for (const bad of badInputs) {
      const res = buildCatchupUrl(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.category).toBe('source-format');
        expect(res.error.code).toBe('invalid-catchup-url');
      }
    }
  });
});
