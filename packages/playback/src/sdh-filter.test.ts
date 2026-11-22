import { describe, expect, it } from 'vitest';
import { stripSdhAnnotations } from './sdh-filter';

describe('stripSdhAnnotations (#310)', () => {
  it('strips balanced [...] and (...) annotations across single, multi-line, and nested cues', () => {
    expect(stripSdhAnnotations('[dramatic music] Hello there.')).toBe('Hello there.');
    expect(stripSdhAnnotations('Hello (whispering) world.')).toBe('Hello world.');
    expect(stripSdhAnnotations('[music (piano) plays]\nLet us go.')).toBe('Let us go.');
    expect(stripSdhAnnotations('(\nphone ringing\nin distance\n)\nHello?')).toBe('Hello?');
    expect(stripSdhAnnotations('[sighs]')).toBe('');
  });

  it('preserves purely numeric, year, range, and percentage parentheticals', () => {
    expect(stripSdhAnnotations('Released in (2024) and (1999).')).toBe(
      'Released in (2024) and (1999).',
    );
    expect(stripSdhAnnotations('Pages (1-2) and (3–4) at (50%).')).toBe(
      'Pages (1-2) and (3–4) at (50%).',
    );
  });

  it('strips Unicode uppercase speaker labels including Turkish letters while preserving prose, RTL, timestamps, ratios, and URLs', () => {
    expect(stripSdhAnnotations('JOHN: Come here.')).toBe('Come here.');
    expect(stripSdhAnnotations('DR. SMITH: Stay back.')).toBe('Stay back.');
    expect(stripSdhAnnotations('ÇAĞRI: Merhaba dünya.')).toBe('Merhaba dünya.');
    expect(stripSdhAnnotations('İBRAHİM ŞÜKRÜ: Geliyorum.')).toBe('Geliyorum.');
    expect(stripSdhAnnotations('ÖĞRETMEN: Sessiz olun.')).toBe('Sessiz olun.');

    // Preserves mixed-case prose, timestamps, ratios, URLs, and RTL uncased text
    expect(stripSdhAnnotations('Note: meet at 10:30 in 16:9.')).toBe(
      'Note: meet at 10:30 in 16:9.',
    );
    expect(stripSdhAnnotations('Visit https://example.com now.')).toBe(
      'Visit https://example.com now.',
    );
    expect(stripSdhAnnotations('مرحبا: أهلا بك')).toBe('مرحبا: أهلا بك');
    expect(stripSdhAnnotations('שלום: בוקר טוב')).toBe('שלום: בוקר טוב');
  });

  it('preserves dialogue dashes and bidi isolates while dropping empty, lone-dash, and lone-music lines', () => {
    expect(stripSdhAnnotations('- JOHN: Hello!\n- MARY: Hi there!')).toBe('- Hello!\n- Hi there!');
    expect(stripSdhAnnotations('– [coughs]\n– Are you okay?')).toBe('– Are you okay?');
    expect(stripSdhAnnotations('— İSMAİL: Gidelim.')).toBe('— Gidelim.');
    expect(stripSdhAnnotations('\u2066- JOHN: Hello\u2069')).toBe('\u2066- Hello\u2069');
    expect(stripSdhAnnotations('♪ [upbeat music] ♪')).toBe('');
    expect(stripSdhAnnotations('♫')).toBe('');
    expect(stripSdhAnnotations('♪ Singing real lyrics ♪')).toBe('♪ Singing real lyrics ♪');
    expect(stripSdhAnnotations('- JOHN:\n- [groans]')).toBe('');
  });

  it('leaves unmatched brackets or parentheses intact without swallowing text', () => {
    expect(stripSdhAnnotations('Wait (what happened')).toBe('Wait (what happened');
    expect(stripSdhAnnotations('Done)')).toBe('Done)');
  });
});
