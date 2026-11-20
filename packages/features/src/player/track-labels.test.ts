import { createAppI18n } from '@elv/i18n';
import type { TrackInfo } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { formatTrackLabel } from './track-labels';

describe('formatTrackLabel', () => {
  it('localizes common ISO language codes in English and Turkish and suppresses redundant labels', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const tracks: readonly TrackInfo[] = [
      { id: 'a:1', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
      { id: 'a:2', language: 'eng', label: 'eng', codec: 'aac', channels: 2 },
    ];

    expect(formatTrackLabel(tracks[0] as TrackInfo, 0, tracks, en)).toBe('Turkish');
    expect(formatTrackLabel(tracks[1] as TrackInfo, 1, tracks, en)).toBe('English');
    expect(formatTrackLabel(tracks[0] as TrackInfo, 0, tracks, tr)).toBe('Türkçe');
    expect(formatTrackLabel(tracks[1] as TrackInfo, 1, tracks, tr)).toBe('İngilizce');
  });

  it('treats Turkish dotted and dotless I casing variants of the language name as redundant', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const variants: readonly TrackInfo[] = [
      { id: 'a:1', language: 'eng', label: 'İNGİLİZCE' },
      { id: 'a:2', language: 'eng', label: 'ingilizce' },
      { id: 'a:3', language: 'eng', label: 'INGILIZCE' },
      { id: 'a:4', language: 'tur', label: 'TÜRKÇE' },
    ];

    expect(formatTrackLabel(variants[0] as TrackInfo, 0, [variants[0] as TrackInfo], tr)).toBe(
      'İngilizce',
    );
    expect(formatTrackLabel(variants[1] as TrackInfo, 0, [variants[1] as TrackInfo], tr)).toBe(
      'İngilizce',
    );
    expect(formatTrackLabel(variants[2] as TrackInfo, 0, [variants[2] as TrackInfo], en)).toBe(
      'English',
    );
    expect(formatTrackLabel(variants[3] as TrackInfo, 0, [variants[3] as TrackInfo], en)).toBe(
      'Turkish',
    );
  });

  it('preserves distinct track titles and forced markers', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const subs: readonly TrackInfo[] = [
      { id: 's:1', language: 'eng', label: 'Director Commentary' },
      { id: 's:2', language: 'tur', forced: true },
    ];

    expect(formatTrackLabel(subs[0] as TrackInfo, 0, subs, en)).toBe(
      'English · Director Commentary',
    );
    expect(formatTrackLabel(subs[1] as TrackInfo, 1, subs, en)).toBe('Turkish · Forced');
    expect(formatTrackLabel(subs[1] as TrackInfo, 1, subs, tr)).toBe('Türkçe · Zorunlu');
  });

  it('disambiguates duplicate language tracks using codec, channel layout, or track number', () => {
    const en = createAppI18n('en');
    const audio: readonly TrackInfo[] = [
      { id: 'a:1', language: 'eng', codec: 'aac', channels: 2 },
      { id: 'a:2', language: 'eng', codec: 'eac3', channels: 6 },
      { id: 'a:3', language: 'deu', codec: 'ac3', channels: 8 },
      { id: 'a:4', language: 'deu', codec: 'ac3', channels: 1 },
      { id: 'a:5', language: 'deu', codec: 'ac3', channels: 4 },
    ];

    expect(formatTrackLabel(audio[0] as TrackInfo, 0, audio, en)).toBe('English (AAC 2.0)');
    expect(formatTrackLabel(audio[1] as TrackInfo, 1, audio, en)).toBe('English (EAC3 5.1)');
    expect(formatTrackLabel(audio[2] as TrackInfo, 2, audio, en)).toBe('German (AC3 7.1)');
    expect(formatTrackLabel(audio[3] as TrackInfo, 3, audio, en)).toBe('German (AC3 1.0)');
    expect(formatTrackLabel(audio[4] as TrackInfo, 4, audio, en)).toBe('German (AC3 4ch)');

    const identical: readonly TrackInfo[] = [
      { id: 's:1', language: 'spa' },
      { id: 's:2', language: 'spa' },
    ];
    expect(formatTrackLabel(identical[0] as TrackInfo, 0, identical, en)).toBe('Spanish #1');
    expect(formatTrackLabel(identical[1] as TrackInfo, 1, identical, en)).toBe('Spanish #2');
  });

  it('falls back to unknown uppercase code, standalone label, or localized track number', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const misc: readonly TrackInfo[] = [
      { id: 'a:1', language: 'pol' },
      { id: 'a:2', label: 'Original Audio' },
      { id: 'a:3', language: 'und' },
    ];

    expect(formatTrackLabel(misc[0] as TrackInfo, 0, misc, en)).toBe('POL');
    expect(formatTrackLabel(misc[1] as TrackInfo, 1, misc, en)).toBe('Original Audio');
    expect(formatTrackLabel(misc[2] as TrackInfo, 2, misc, en)).toBe('Track 3');
    expect(formatTrackLabel(misc[2] as TrackInfo, 2, misc, tr)).toBe('Parça 3');
  });
});
