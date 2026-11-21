import { describe, expect, it } from 'vitest';
import { toEpg } from './xtream-records';
import { client, value } from './xtream-test-helpers';

function b64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeSingleByte(text: string, encoding: string): Uint8Array {
  const map = new Map<string, number>();
  const td = new TextDecoder(encoding);
  for (let b = 0x20; b <= 0xff; b++) {
    if (encoding === 'iso-8859-6' && b >= 0x80 && b <= 0x9f) continue;
    const ch = td.decode(new Uint8Array([b]));
    if (ch !== '\ufffd') map.set(ch, b);
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const b = map.get(ch);
    if (b === undefined) throw new Error(`unencodable ${ch} in ${encoding}`);
    out[i] = b;
  }
  return out;
}

describe('Xtream short-EPG codepage fallback (#329)', () => {
  it('decodes Windows-1256 Arabic EPG strings using serverTimezone cached from account()', async () => {
    const title = 'نشرة الأخبار المسائية';
    const desc = 'تغطية شاملة لأهم الأحداث';
    let calls = 0;
    const { c } = client((url) => {
      calls++;
      if (!url.includes('action=')) {
        return {
          json: {
            user_info: { auth: 1, status: 'Active' },
            server_info: { timezone: 'Asia/Riyadh' },
          },
        };
      }
      return {
        json: {
          epg_listings: [
            {
              title: b64Bytes(encodeSingleByte(title, 'windows-1256')),
              description: b64Bytes(encodeSingleByte(desc, 'windows-1256')),
              start_timestamp: 1700000000,
              stop_timestamp: 1700003600,
            },
          ],
        },
      };
    });

    await c.account();
    const list = value(await c.shortEpg(10));
    expect(calls).toBe(2);
    expect(list).toEqual([{ start: 1700000000000, stop: 1700003600000, title, desc }]);
  });

  it('decodes ISO-8859-6, Windows-1254 Turkish, and Windows-1252 Latin EPG strings', () => {
    const arTitle = 'فيلم وثائقي';
    const trTitle = 'Akşam Haberleri';
    const laTitle = 'Café de Paris — Direct';
    const entries = toEpg({
      epg_listings: [
        {
          title: b64Bytes(encodeSingleByte(arTitle, 'iso-8859-6')),
          start_timestamp: 100,
          stop_timestamp: 200,
        },
        {
          title: b64Bytes(encodeSingleByte(trTitle, 'windows-1254')),
          start_timestamp: 200,
          stop_timestamp: 300,
        },
        {
          title: b64Bytes(encodeSingleByte(laTitle, 'windows-1252')),
          start_timestamp: 300,
          stop_timestamp: 400,
        },
      ],
    });
    expect(entries.map((e) => e.title)).toEqual([arTitle, trTitle, laTitle]);
  });

  it('keeps binary control-byte garbage and plain-text words as raw text', () => {
    const binary = b64Bytes(new Uint8Array([0x00, 0x01, 0x02, 0xc7, 0xe1]));
    const bom = b64Bytes(new Uint8Array([0xff, 0xfe]));
    const entries = toEpg(
      {
        epg_listings: [
          { title: binary, description: bom, start_timestamp: 10, stop_timestamp: 20 },
          { title: 'News', start_timestamp: 20, stop_timestamp: 30 },
        ],
      },
      'Asia/Riyadh',
    );
    expect(entries).toEqual([
      { start: 10_000, stop: 20_000, title: binary, desc: bom },
      { start: 20_000, stop: 30_000, title: 'News' },
    ]);
  });

  it('passes ordinary plain-text multi-word and spaceless English titles through untouched', () => {
    const plainTitles = [
      'Live News',
      'Top Story',
      'Wild Life',
      'Safe Zone',
      'Time Line',
      'LiveNews',
      'TopStory',
      'Weather1',
      'WildLife',
      'SafeZone',
      'TimeLine',
      'Program1',
      'Morning1',
      'Evening2',
      'SportsHD',
      'News',
      'Live',
      'Test',
      'Info',
      'Schedule',
      'WorldCup',
      'TrueLife',
    ];
    const entries = toEpg({
      epg_listings: plainTitles.map((title, idx) => ({
        title,
        start_timestamp: 100 + idx * 10,
        stop_timestamp: 105 + idx * 10,
      })),
    });
    expect(entries.map((e) => e.title)).toEqual(plainTitles);
  });
});

describe('Xtream EPG datetime string fallback (#305)', () => {
  it('prefers numeric timestamps when present and falls back to start/end or stop strings', () => {
    const entries = toEpg(
      {
        epg_listings: [
          {
            title: btoa('Numeric wins'),
            start_timestamp: 1700000000,
            stop_timestamp: 1700003600,
            start: '2026-01-01 00:00:00',
            end: '2026-01-01 01:00:00',
          },
          {
            title: btoa('Winter Berlin'),
            start: '2026-01-15 20:00:00',
            end: '2026-01-15 21:30:00',
          },
          {
            title: btoa('Summer Berlin'),
            start: '2026-07-15 20:00:00',
            stop: '2026-07-15 21:00:00',
          },
        ],
      },
      'Europe/Berlin',
    );

    expect(entries).toEqual([
      { start: 1700000000000, stop: 1700003600000, title: 'Numeric wins' },
      {
        start: Date.UTC(2026, 0, 15, 19, 0, 0),
        stop: Date.UTC(2026, 0, 15, 20, 30, 0),
        title: 'Winter Berlin',
      },
      {
        start: Date.UTC(2026, 6, 15, 18, 0, 0),
        stop: Date.UTC(2026, 6, 15, 19, 0, 0),
        title: 'Summer Berlin',
      },
    ]);
  });

  it('handles DST transitions accurately and honors explicit ISO-8601 offsets', () => {
    const entries = toEpg(
      {
        epg_listings: [
          {
            title: btoa('Across NY spring-forward'),
            start: '2026-03-08 01:30:00',
            end: '2026-03-08 03:30:00',
          },
          {
            title: btoa('Explicit ISO offset'),
            start: '2026-05-01T12:00:00+03:00',
            end: '2026-05-01T13:00:00Z',
          },
        ],
      },
      'America/New_York',
    );

    expect(entries).toEqual([
      {
        // 01:30 EST = 06:30Z, 03:30 EDT = 07:30Z (1 hour elapsed across spring-forward)
        start: Date.UTC(2026, 2, 8, 6, 30, 0),
        stop: Date.UTC(2026, 2, 8, 7, 30, 0),
        title: 'Across NY spring-forward',
      },
      {
        start: Date.UTC(2026, 4, 1, 9, 0, 0),
        stop: Date.UTC(2026, 4, 1, 13, 0, 0),
        title: 'Explicit ISO offset',
      },
    ]);
  });

  it('falls back to UTC when serverTimezone is absent or invalid, and uses client serverTimezone option', async () => {
    const utcFallback = toEpg(
      {
        epg_listings: [
          { title: btoa('Fallback'), start: '2026-06-01 10:00:00', end: '2026-06-01 11:00:00' },
        ],
      },
      'Not/A_Real_Zone',
    );
    expect(utcFallback).toEqual([
      {
        start: Date.UTC(2026, 5, 1, 10, 0, 0),
        stop: Date.UTC(2026, 5, 1, 11, 0, 0),
        title: 'Fallback',
      },
    ]);

    const { c } = client(
      () => ({
        json: {
          epg_listings: [
            {
              title: btoa('Istanbul Show'),
              start: '2026-06-01 21:00:00',
              end: '2026-06-01 22:00:00',
            },
          ],
        },
      }),
      { serverTimezone: 'Europe/Istanbul' },
    );
    expect(value(await c.shortEpg(7))).toEqual([
      {
        start: Date.UTC(2026, 5, 1, 18, 0, 0),
        stop: Date.UTC(2026, 5, 1, 19, 0, 0),
        title: 'Istanbul Show',
      },
    ]);
  });

  it('rejects invalid calendar dates and ranges where stop <= start', () => {
    const entries = toEpg(
      {
        epg_listings: [
          { title: btoa('Bad Feb 30'), start: '2026-02-30 12:00:00', end: '2026-02-30 13:00:00' },
          { title: btoa('Bad Leap'), start: '2026-02-29 12:00:00', end: '2026-02-29 13:00:00' },
          { title: btoa('Equal'), start: '2026-05-01 12:00:00', end: '2026-05-01 12:00:00' },
          { title: btoa('Reversed'), start: '2026-05-01 14:00:00', end: '2026-05-01 13:00:00' },
          { title: btoa('Reversed ts'), start_timestamp: 500, stop_timestamp: 500 },
          {
            title: btoa('Bad offset'),
            start: '2026-05-01T12:00:00+25:00',
            end: '2026-05-01T13:00:00Z',
          },
          {
            title: btoa('Zero ts fallback'),
            start_timestamp: 0,
            stop_timestamp: 0,
            start: '2026-05-01T10:00:00-0500',
            end: '2026-05-01T11:00:00-0500',
          },
          { title: btoa('Valid Leap'), start: '2024-02-29 12:00:00', end: '2024-02-29 13:00:00' },
        ],
      },
      'UTC',
    );
    expect(entries).toEqual([
      {
        start: Date.UTC(2026, 4, 1, 15, 0, 0),
        stop: Date.UTC(2026, 4, 1, 16, 0, 0),
        title: 'Zero ts fallback',
      },
      {
        start: Date.UTC(2024, 1, 29, 12, 0, 0),
        stop: Date.UTC(2024, 1, 29, 13, 0, 0),
        title: 'Valid Leap',
      },
    ]);
  });
});
