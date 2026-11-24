import { describe, expect, it } from 'vitest';
import { toEpg } from './xtream-records';

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
});
