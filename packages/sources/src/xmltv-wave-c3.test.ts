import { describe, expect, it } from 'vitest';
import { parseXmltvTime, scanXmltv, type XmltvChannel, type XmltvProgramme } from './index';

async function* chunksOf(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

describe('Wave C3 XMLTV DST timezones, <lcn>, and <rating> (#182)', () => {
  describe('parseXmltvTime with defaultTimeZone', () => {
    it('preserves explicit offsets even when defaultTimeZone is provided', () => {
      const expected = Date.UTC(2026, 6, 15, 18, 0, 0);
      expect(parseXmltvTime('20260715200000 +0200', { defaultTimeZone: 'America/New_York' })).toBe(
        expected,
      );
      expect(parseXmltvTime('20260715180000 Z', { defaultTimeZone: 'America/New_York' })).toBe(
        expected,
      );
      expect(parseXmltvTime('20260715180000 UTC', { defaultTimeZone: 'Europe/Berlin' })).toBe(
        expected,
      );
      expect(parseXmltvTime('20260715180000 GMT', { defaultTimeZone: 'Europe/Berlin' })).toBe(
        expected,
      );
    });

    it('applies IANA winter vs summer DST offsets for offset-less timestamps (America/New_York)', () => {
      // Winter (EST = UTC-5): 2026-01-15 12:00 local -> 17:00 UTC
      expect(parseXmltvTime('20260115120000', { defaultTimeZone: 'America/New_York' })).toBe(
        Date.UTC(2026, 0, 15, 17, 0, 0),
      );
      // Summer (EDT = UTC-4): 2026-07-15 12:00 local -> 16:00 UTC
      expect(parseXmltvTime('20260715120000', { defaultTimeZone: 'America/New_York' })).toBe(
        Date.UTC(2026, 6, 15, 16, 0, 0),
      );
    });

    it('applies IANA winter vs summer DST offsets for Europe/Berlin', () => {
      // Winter (CET = UTC+1): 2026-01-15 20:00 local -> 19:00 UTC
      expect(parseXmltvTime('20260115200000', { defaultTimeZone: 'Europe/Berlin' })).toBe(
        Date.UTC(2026, 0, 15, 19, 0, 0),
      );
      // Summer (CEST = UTC+2): 2026-07-15 20:00 local -> 18:00 UTC
      expect(parseXmltvTime('20260715200000', { defaultTimeZone: 'Europe/Berlin' })).toBe(
        Date.UTC(2026, 6, 15, 18, 0, 0),
      );
    });

    it('handles spring-forward gap deterministically (America/New_York & Europe/Berlin)', () => {
      // America/New_York spring-forward: 2026-03-08 02:00 -> 03:00 (02:30 does not exist -> 03:30 EDT = 07:30 UTC)
      expect(parseXmltvTime('20260308023000', { defaultTimeZone: 'America/New_York' })).toBe(
        Date.UTC(2026, 2, 8, 7, 30, 0),
      );
      // Europe/Berlin spring-forward: 2026-03-29 02:00 -> 03:00 (02:30 does not exist -> 03:30 CEST = 01:30 UTC)
      expect(parseXmltvTime('20260329023000', { defaultTimeZone: 'Europe/Berlin' })).toBe(
        Date.UTC(2026, 2, 29, 1, 30, 0),
      );
    });

    it('handles fall-back overlap deterministically (America/New_York & Europe/Berlin)', () => {
      // America/New_York fall-back: 2026-11-01 01:30 occurs at 05:30 UTC (EDT) and 06:30 UTC (EST)
      const nyFallBack = parseXmltvTime('20261101013000', { defaultTimeZone: 'America/New_York' });
      expect([Date.UTC(2026, 10, 1, 5, 30, 0), Date.UTC(2026, 10, 1, 6, 30, 0)]).toContain(
        nyFallBack,
      );
      // Europe/Berlin fall-back: 2026-10-25 02:30 occurs at 00:30 UTC (CEST) and 01:30 UTC (CET)
      const berlinFallBack = parseXmltvTime('20261025023000', { defaultTimeZone: 'Europe/Berlin' });
      expect([Date.UTC(2026, 9, 25, 0, 30, 0), Date.UTC(2026, 9, 25, 1, 30, 0)]).toContain(
        berlinFallBack,
      );
    });

    it('falls back to UTC gracefully for invalid or empty defaultTimeZone', () => {
      const utc = Date.UTC(2026, 6, 15, 12, 0, 0);
      expect(parseXmltvTime('20260715120000', { defaultTimeZone: 'Mars/Olympus_Mons' })).toBe(utc);
      expect(parseXmltvTime('20260715120000', { defaultTimeZone: '' })).toBe(utc);
      expect(parseXmltvTime('20260715120000', { defaultTimeZone: '   ' })).toBe(utc);
    });
  });

  describe('scanXmltv <lcn>, <rating>, and defaultTimeZone wiring', () => {
    it('parses channel <lcn>, programme <rating>, keeps <icon> isolation, and applies defaultTimeZone', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="ch1">
    <display-name>BBC One</display-name>
    <lcn>101</lcn>
    <extra><lcn>999</lcn></extra>
    <icon src="https://example.com/ch1.png" />
  </channel>
  <channel id="ch2">
    <display-name>Blank LCN</display-name>
    <lcn>   </lcn>
  </channel>
  <programme channel="ch1" start="20260715200000" stop="20260715210000">
    <title>Evening News</title>
    <rating system="MPAA">
      <icon src="https://example.com/rating-badge.png" />
      <value>PG-13</value>
    </rating>
    <icon src="https://example.com/poster.png" />
  </programme>
  <programme channel="ch1" start="20260715210000 +0000" stop="20260715220000 +0000">
    <title>Late Show</title>
    <rating><value>16+</value></rating>
    <wrapper><rating system="IGNORED"><value>X</value></rating></wrapper>
  </programme>
</tv>`;

      const channels: XmltvChannel[] = [];
      const programmes: XmltvProgramme[] = [];
      const gen = scanXmltv(chunksOf(xml), { defaultTimeZone: 'Europe/Berlin' });
      for (;;) {
        const step = await gen.next();
        if (step.done) {
          expect(step.value.ok).toBe(true);
          break;
        }
        channels.push(...step.value.channels);
        programmes.push(...step.value.programmes);
      }

      expect(channels).toHaveLength(2);
      expect(channels[0]?.lcn).toBe('101');
      expect(channels[0]?.icon).toBe('https://example.com/ch1.png');
      expect(channels[1]?.lcn).toBeUndefined();

      expect(programmes).toHaveLength(2);
      // 20:00 Europe/Berlin summer (UTC+2) -> 18:00 UTC
      expect(programmes[0]?.start).toBe(Date.UTC(2026, 6, 15, 18, 0, 0));
      expect(programmes[0]?.stop).toBe(Date.UTC(2026, 6, 15, 19, 0, 0));
      expect(programmes[0]?.ratingSystem).toBe('MPAA');
      expect(programmes[0]?.ratingValue).toBe('PG-13');
      // Programme icon must NOT be overwritten by <rating><icon>
      expect(programmes[0]?.icon).toBe('https://example.com/poster.png');

      // Explicit +0000 offset preserved
      expect(programmes[1]?.start).toBe(Date.UTC(2026, 6, 15, 21, 0, 0));
      expect(programmes[1]?.ratingSystem).toBeUndefined();
      expect(programmes[1]?.ratingValue).toBe('16+');
    });
  });
});
