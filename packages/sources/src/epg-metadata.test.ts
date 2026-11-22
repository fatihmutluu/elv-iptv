import { describe, expect, it } from 'vitest';
import {
  decodeProgrammeFlags,
  EPG_FLAG_LIVE,
  EPG_FLAG_NEW,
  EPG_FLAG_PREMIERE,
  EPG_FLAG_REPEAT,
  type EpgGenre,
  encodeProgrammeFlags,
  normalizeEpgGenre,
  scanXmltv,
  type XmltvProgramme,
} from './index';

async function* chunksOf(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

describe('epg-metadata (#396)', () => {
  it('returns null for empty or whitespace-only category lists', () => {
    expect(normalizeEpgGenre([])).toBeNull();
    expect(normalizeEpgGenre(['', '   ', '\t'])).toBeNull();
  });

  it('normalizes multilingual EN/TR/DE/FR/ES category labels to canonical EpgGenre', () => {
    const cases: ReadonlyArray<readonly [readonly string[], EpgGenre]> = [
      [['Sports'], 'sports'],
      [['Spor', 'Futbol'], 'sports'],
      [['Canlı Basketbol'], 'sports'],
      [['Tennis'], 'sports'],
      [['Deportes'], 'sports'],
      [['Movie', 'Action'], 'movie'],
      [['Sinema'], 'movie'],
      [['Kino / Film'], 'movie'],
      [['Películas'], 'movie'],
      [['News'], 'news'],
      [['Haberler'], 'news'],
      [['Current Affairs'], 'news'],
      [['Nachrichten'], 'news'],
      [['Actualités'], 'news'],
      [['Noticias'], 'news'],
      [['Kids'], 'kids'],
      [['Çocuk'], 'kids'],
      [['ÇOCUK & AİLE'], 'kids'],
      [['Animation'], 'kids'],
      [['Cartoon'], 'kids'],
      [['Kinder'], 'kids'],
      [['Jeunesse'], 'kids'],
      [['Infantil'], 'kids'],
      [['Series'], 'series'],
      [['Dizi'], 'series'],
      [['Drama'], 'series'],
      [['Comedy'], 'series'],
      [['Documentary'], 'series'],
      [['Belgesel'], 'series'],
      [['Dokumentation'], 'series'],
      [['Séries'], 'series'],
      [['Music & Arts'], 'other'],
      [['Unrecognized Custom Genre'], 'other'],
    ];

    for (const [categories, expected] of cases) {
      expect(normalizeEpgGenre(categories), `categories=${JSON.stringify(categories)}`).toBe(
        expected,
      );
    }
  });

  it('encodes and decodes programme broadcast flag bitmasks', () => {
    expect(EPG_FLAG_LIVE).toBe(1);
    expect(EPG_FLAG_NEW).toBe(2);
    expect(EPG_FLAG_PREMIERE).toBe(4);
    expect(EPG_FLAG_REPEAT).toBe(8);

    expect(encodeProgrammeFlags({})).toBe(0);
    expect(decodeProgrammeFlags(0)).toEqual({
      isLive: false,
      isNew: false,
      isPremiere: false,
      isRepeat: false,
    });

    const allMask = encodeProgrammeFlags({
      isLive: true,
      isNew: true,
      isPremiere: true,
      previouslyShown: true,
    });
    expect(allMask).toBe(EPG_FLAG_LIVE | EPG_FLAG_NEW | EPG_FLAG_PREMIERE | EPG_FLAG_REPEAT);
    expect(decodeProgrammeFlags(allMask)).toEqual({
      isLive: true,
      isNew: true,
      isPremiere: true,
      isRepeat: true,
    });

    const livePremiere = encodeProgrammeFlags({ isLive: true, isPremiere: true });
    expect(livePremiere).toBe(EPG_FLAG_LIVE | EPG_FLAG_PREMIERE);
    expect(decodeProgrammeFlags(livePremiere)).toEqual({
      isLive: true,
      isNew: false,
      isPremiere: true,
      isRepeat: false,
    });

    expect(encodeProgrammeFlags({ isRepeat: true })).toBe(EPG_FLAG_REPEAT);
  });

  it('parses top-level <premiere> elements in scanXmltv and ignores nested <premiere>', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="ch1"><display-name>Channel 1</display-name></channel>
  <programme start="20261122120000 +0000" stop="20261122130000 +0000" channel="ch1">
    <title>Self-closing premiere</title>
    <premiere/>
    <live/>
  </programme>
  <programme start="20261122130000 +0000" stop="20261122140000 +0000" channel="ch1">
    <title>Text premiere</title>
    <premiere>First broadcast on channel</premiere>
    <new/>
  </programme>
  <programme start="20261122140000 +0000" stop="20261122150000 +0000" channel="ch1">
    <title>Nested premiere ignored</title>
    <rating><premiere/></rating>
  </programme>
</tv>`;

    const programmes: XmltvProgramme[] = [];
    const gen = scanXmltv(chunksOf(xml), {});
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value.ok).toBe(true);
        break;
      }
      programmes.push(...step.value.programmes);
    }
    expect(programmes).toHaveLength(3);

    expect(programmes[0]?.isPremiere).toBe(true);
    expect(programmes[0]?.isLive).toBe(true);
    expect(programmes[1]?.isPremiere).toBe(true);
    expect(programmes[1]?.isNew).toBe(true);
    expect(programmes[2]?.isPremiere).toBeUndefined();
  });
});
