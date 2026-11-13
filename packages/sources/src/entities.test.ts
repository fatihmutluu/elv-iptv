import { describe, expect, it } from 'vitest';
import { decodeEntities } from './entities';

describe('decodeEntities', () => {
  it('decodes named and numeric entities, leaves unknown ones', () => {
    expect(decodeEntities('&amp;&lt;&#39;&#x1F600;&nbsp;')).toBe("&<'😀&nbsp;");
    expect(decodeEntities('&gt;&quot;&apos;&#X41;')).toBe('>"\'A');
  });

  it('returns text without ampersands unchanged', () => {
    expect(decodeEntities('plain')).toBe('plain');
  });

  it('leaves invalid numeric references and bare ampersands literal', () => {
    expect(decodeEntities('&#0; &#xD800; &#99999999; & &amp')).toBe(
      '&#0; &#xD800; &#99999999; & &amp',
    );
  });

  it('does not decode twice', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});
