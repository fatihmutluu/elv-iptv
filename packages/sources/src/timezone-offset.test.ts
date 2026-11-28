import { describe, expect, it } from 'vitest';
import {
  formatFixedOffsetTimezone,
  inferUtcOffsetTimezone,
  parseFixedOffsetMinutes,
  parseNaiveUtcMs,
  resolveServerTimezone,
  utcMsToCalendarParts,
  wallTimeToUtcMs,
} from './timezone-offset';

describe('timezone-offset (XC-3)', () => {
  it('parses fixed UTC/GMT/bare offsets and rejects out-of-range offsets', () => {
    expect(parseFixedOffsetMinutes('UTC')).toBe(0);
    expect(parseFixedOffsetMinutes('GMT')).toBe(0);
    expect(parseFixedOffsetMinutes('z')).toBe(0);
    expect(parseFixedOffsetMinutes('UTC+3')).toBe(180);
    expect(parseFixedOffsetMinutes('UTC-05:30')).toBe(-330);
    expect(parseFixedOffsetMinutes('GMT+2')).toBe(120);
    expect(parseFixedOffsetMinutes('+03:00')).toBe(180);
    expect(parseFixedOffsetMinutes('-0400')).toBe(-240);
    expect(parseFixedOffsetMinutes('UTC+14:00')).toBe(840);
    expect(parseFixedOffsetMinutes('UTC-12:00')).toBe(-720);
    expect(parseFixedOffsetMinutes('UTC+14:30')).toBeUndefined();
    expect(parseFixedOffsetMinutes('UTC-12:30')).toBeUndefined();
    expect(parseFixedOffsetMinutes('UTC+03:60')).toBeUndefined();
    expect(parseFixedOffsetMinutes('Europe/Berlin')).toBeUndefined();
    expect(parseFixedOffsetMinutes('Etc/GMT-3')).toBeUndefined();
    expect(parseFixedOffsetMinutes('')).toBeUndefined();
  });

  it('formats canonical UTC±HH:MM offset strings', () => {
    expect(formatFixedOffsetTimezone(0)).toBe('UTC+00:00');
    expect(formatFixedOffsetTimezone(-0)).toBe('UTC+00:00');
    expect(formatFixedOffsetTimezone(180)).toBe('UTC+03:00');
    expect(formatFixedOffsetTimezone(-330)).toBe('UTC-05:30');
    expect(formatFixedOffsetTimezone(345)).toBe('UTC+05:45');
  });

  it('parses naive panel datetimes and infers 15-minute-snapped UTC offsets from clock skew', () => {
    const wall = parseNaiveUtcMs('2026-06-01 21:02:10');
    expect(wall).toBe(Date.UTC(2026, 5, 1, 21, 2, 10));
    expect(parseNaiveUtcMs('2026-02-30 12:00:00')).toBeUndefined();
    expect(parseNaiveUtcMs('2026-06-01T21:00:00Z')).toBeUndefined();

    const utcSec = Date.UTC(2026, 5, 1, 18, 0, 0) / 1000;
    // +3h02m10s clock drift snaps to UTC+03:00
    expect(inferUtcOffsetTimezone('2026-06-01 21:02:10', utcSec)).toBe('UTC+03:00');
    // -5h31m snaps to UTC-05:30 (accepts numeric string too)
    expect(inferUtcOffsetTimezone('2026-06-01 12:29:00', String(utcSec))).toBe('UTC-05:30');
    // 13-digit ms timestamp_now is also handled
    expect(inferUtcOffsetTimezone('2026-06-01 23:45:00', utcSec * 1000)).toBe('UTC+05:45');
    // Out-of-range skew (> +14h or < -12h) is rejected
    expect(inferUtcOffsetTimezone('2026-06-02 10:00:00', utcSec)).toBeUndefined();
    expect(inferUtcOffsetTimezone('2026-06-01 05:00:00', utcSec)).toBeUndefined();
    expect(inferUtcOffsetTimezone('2026-06-01 21:00:00', 0)).toBeUndefined();
  });

  it('resolves valid IANA zones, fixed offsets, and falls back to clock skew on invalid/missing zones', () => {
    const utcSec = Date.UTC(2026, 5, 1, 18, 0, 0) / 1000;
    expect(resolveServerTimezone('Europe/Berlin', '2026-06-01 21:00:00', utcSec)).toBe(
      'Europe/Berlin',
    );
    expect(resolveServerTimezone('UTC+3')).toBe('UTC+03:00');
    expect(resolveServerTimezone('GMT-05:30')).toBe('UTC-05:30');
    expect(resolveServerTimezone('UTC')).toBe('UTC');
    expect(resolveServerTimezone('Invalid/Zone', '2026-06-01 21:00:00', utcSec)).toBe('UTC+03:00');
    expect(resolveServerTimezone('', '2026-06-01 14:00:00', utcSec)).toBe('UTC-04:00');
    expect(resolveServerTimezone('Invalid/Zone')).toBeUndefined();
  });

  it('applies fixed-offset and IANA arithmetic accurately in wallTimeToUtcMs and utcMsToCalendarParts', () => {
    const wall = Date.UTC(2026, 5, 1, 21, 30, 0);
    expect(wallTimeToUtcMs(wall, 'UTC+3')).toBe(Date.UTC(2026, 5, 1, 18, 30, 0));
    expect(wallTimeToUtcMs(wall, 'UTC-05:30')).toBe(Date.UTC(2026, 5, 2, 3, 0, 0));
    expect(wallTimeToUtcMs(wall, '+03:00')).toBe(Date.UTC(2026, 5, 1, 18, 30, 0));
    expect(wallTimeToUtcMs(wall, 'GMT+2')).toBe(Date.UTC(2026, 5, 1, 19, 30, 0));

    expect(utcMsToCalendarParts(Date.UTC(2026, 5, 1, 22, 15, 5), 'UTC+3')).toEqual({
      year: '2026',
      month: '06',
      day: '02',
      hour: '01',
      minute: '15',
      second: '05',
    });
    expect(utcMsToCalendarParts(Date.UTC(2026, 5, 1, 2, 0, 0), 'UTC-05:30')).toEqual({
      year: '2026',
      month: '05',
      day: '31',
      hour: '20',
      minute: '30',
      second: '00',
    });
  });
});
