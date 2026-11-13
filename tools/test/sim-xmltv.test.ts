import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/sim/catalog.ts';
import { programmesFor, xmltvChunks, xmltvTime } from '../src/sim/xmltv.ts';

const NOW = new Date('2026-01-01T12:34:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const render = (profile: 'small' | 'compat') =>
  [...xmltvChunks(buildCatalog(profile, 1), NOW)].join('');

describe('programmesFor', () => {
  it('covers the window with contiguous 30, 60 or 90 minute programmes', () => {
    const catalog = buildCatalog('small', 1);
    const list = [...programmesFor(catalog, 0, NOW)];
    const from = Math.floor((NOW.getTime() - 2 * DAY) / HOUR) * HOUR;
    expect(list[0]?.start.getTime()).toBeLessThanOrEqual(from);
    expect(list.at(-1)?.stop.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 7 * DAY);
    list.forEach((p, i) => {
      if (i > 0) expect(p.start.getTime()).toBe(list[i - 1]?.stop.getTime());
      expect([30, 60, 90]).toContain((p.stop.getTime() - p.start.getTime()) / 60_000);
      expect(p.channel).toBe('ch1001');
    });
  });

  it('yields nothing for a channel without a guide id', () => {
    const catalog = buildCatalog('small', 1);
    const index = catalog.live.findIndex((c) => c.epgId === null);
    expect([...programmesFor(catalog, index, NOW)]).toEqual([]);
  });

  it('differs between channels and seeds but not between runs', () => {
    const a = buildCatalog('small', 1);
    const first = [...programmesFor(a, 0, NOW)].map((p) => p.stop.getTime());
    expect([...programmesFor(a, 0, NOW)].map((p) => p.stop.getTime())).toEqual(first);
    expect([...programmesFor(a, 1, NOW)].map((p) => p.stop.getTime())).not.toEqual(first);
    const b = buildCatalog('small', 2);
    expect([...programmesFor(b, 0, NOW)].map((p) => p.stop.getTime())).not.toEqual(first);
  });
});

describe('xmltvChunks', () => {
  it('is deterministic', () => {
    expect(render('small')).toBe(render('small'));
  });

  it('writes the document structure', () => {
    const xml = render('small');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<tv generator-info-name="elv-sim">');
    expect(xml.trimEnd().endsWith('</tv>')).toBe(true);
    expect(xml).toContain(
      '<channel id="ch1001"><display-name>Channel 0001</display-name><icon src="/logos/1001.png"/></channel>',
    );
    const catalog = buildCatalog('small', 1);
    expect(xml.match(/<channel /g)?.length).toBe(catalog.guideChannels);
    expect(xml).toMatch(
      /<programme start="\d{14} \+0000" stop="\d{14} \+0000" channel="ch1001"><title>Programme 1<\/title><desc>[^<]+<\/desc><category>[A-Za-z]+<\/category>/,
    );
    expect(xml).toContain('<episode-num system="onscreen">');
  });

  it('streams the large guide in chunks of at most 64 KB', () => {
    let size = 0;
    let text = '';
    for (const chunk of xmltvChunks(buildCatalog('large', 1), NOW)) {
      expect(chunk.length).toBeLessThanOrEqual(65_536);
      size += chunk.length;
      text += chunk;
      if (size >= 1_000_000) break;
    }
    expect(text).toContain('<programme');
  });
});

describe('compat guide', () => {
  const xml = render('compat');

  it('adds name-only, unknown and duplicate-id channels', () => {
    const catalog = buildCatalog('compat', 1);
    const noId = catalog.live.find((c) => c.compat === 'no-tvg-id');
    expect(xml).toContain(`<channel id="name-only"><display-name>${noId?.name}</display-name>`);
    expect(xml).toContain('<channel id="unknown-channel">');
    expect(xml).toContain('<channel id="dup">');
    expect(xml).toMatch(/<programme [^>]*channel="dup"/);
    expect(xml.match(/<channel /g)?.length).toBe(catalog.guideChannels + 3);
  });

  it('has overlapping programmes on one channel', () => {
    const re = /<programme start="(\d{14}) [+-]\d{4}" stop="(\d{14}) [+-]\d{4}" channel="dup">/g;
    const list = [...xml.matchAll(re)].map((m) => ({ start: m[1] ?? '', stop: m[2] ?? '' }));
    list.sort((x, y) => x.start.localeCompare(y.start));
    const overlaps = list.filter((p, i) => {
      const prev = list[i - 1];
      return prev !== undefined && p.start > prev.start && p.start < prev.stop;
    });
    expect(overlaps.length).toBeGreaterThan(0);
  });

  it('has entities, CDATA and other offsets', () => {
    expect(xml).toContain('<title>Tom &amp; Jerry</title>');
    expect(xml).toContain('&lt;');
    expect(xml).toMatch(/<desc><!\[CDATA\[[^\]]+\]\]><\/desc>/);
    expect(xml).toContain('+0300"');
    expect(xml).toContain('-0500"');
  });

  it('has a programme crossing local midnight', () => {
    const m = xml.match(
      /<programme start="(\d{8})2330\d\d \+0000" stop="(\d{8})0030\d\d \+0000" channel="dup">/,
    );
    expect(m).not.toBeNull();
    expect(m?.[1]).not.toBe(m?.[2]);
  });

  it('ends with a programme missing stop and an unclosed tag, after valid content', () => {
    const missing = xml.indexOf('<programme start="');
    const noStop = [...xml.matchAll(/<programme (?![^>]*stop=)[^>]*>/g)];
    expect(missing).toBeGreaterThan(0);
    expect(noStop).toHaveLength(1);
    const unclosed = xml.indexOf('<title>Unclosed');
    expect(unclosed).toBeGreaterThan(-1);
    const lastValid = xml.lastIndexOf('</programme>', noStop[0]?.index);
    expect(lastValid).toBeGreaterThan(0);
    expect(xml.indexOf('</programme>', unclosed)).toBeGreaterThan(unclosed);
    expect(xml.slice(unclosed)).not.toContain('</title>');
  });
});

describe('xmltvTime', () => {
  it('formats the offset', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(xmltvTime(d, 0)).toBe('20260101000000 +0000');
    expect(xmltvTime(d, 180)).toBe('20260101030000 +0300');
    expect(xmltvTime(d, -300)).toBe('20251231190000 -0500');
  });
});
