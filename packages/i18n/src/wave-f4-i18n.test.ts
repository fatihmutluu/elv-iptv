import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enSubtitlesSuiteMessages } from './locales/en-subtitles-suite';
import { trSubtitlesSuiteMessages } from './locales/tr-subtitles-suite';

const WAVE_F4_KEYS: readonly MessageId[] = [
  'player.secondarySubtitleTracks',
  'player.secondarySameAsPrimary',
  'player.externalSubtitle.load',
  'player.externalSubtitle.pickFile',
  'player.externalSubtitle.fromUrl',
  'player.externalSubtitle.urlTitle',
  'player.externalSubtitle.urlPlaceholder',
  'player.externalSubtitle.labelPlaceholder',
  'player.externalSubtitle.invalidUrl',
  'player.externalSubtitle.loaded',
  'player.externalSubtitle.failed',
  'player.externalSubtitle.badge',
  'player.subtitleStyle.section',
  'player.subtitleStyle.size',
  'player.subtitleStyle.sizeSmall',
  'player.subtitleStyle.sizeMedium',
  'player.subtitleStyle.sizeLarge',
  'player.subtitleStyle.sizeExtraLarge',
  'player.subtitleStyle.color',
  'player.subtitleStyle.colorWhite',
  'player.subtitleStyle.colorYellow',
  'player.subtitleStyle.colorCyan',
  'player.subtitleStyle.colorGreen',
  'player.subtitleStyle.background',
  'player.subtitleStyle.bgNone',
  'player.subtitleStyle.bgTranslucent',
  'player.subtitleStyle.bgOpaque',
  'player.subtitleStyle.edge',
  'player.subtitleStyle.edgeNone',
  'player.subtitleStyle.edgeOutline',
  'player.subtitleStyle.edgeDropShadow',
  'player.subtitleStyle.position',
  'player.subtitleStyle.posBottom',
  'player.subtitleStyle.posRaised',
  'player.subtitleStyle.posTop',
  'player.subtitleStyle.reset',
];

function parsePoEntries(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let currentKey: 'msgid' | 'msgstr' | null = null;
  let msgid = '';
  let msgstr = '';

  const flush = () => {
    if (msgid !== '') entries[msgid] = msgstr;
    msgid = '';
    msgstr = '';
    currentKey = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      if (line === '') flush();
      continue;
    }
    if (line.startsWith('msgid ')) {
      flush();
      currentKey = 'msgid';
      msgid += JSON.parse(line.slice('msgid '.length).trim()) as string;
    } else if (line.startsWith('msgstr ')) {
      currentKey = 'msgstr';
      msgstr += JSON.parse(line.slice('msgstr '.length).trim()) as string;
    } else if (line.startsWith('"') && currentKey !== null) {
      if (currentKey === 'msgid') msgid += JSON.parse(line) as string;
      else msgstr += JSON.parse(line) as string;
    }
  }
  flush();
  return entries;
}

describe('Wave F4 Subtitles Suite i18n (#32, #402)', () => {
  it('defines all 36 EN and TR keys with strict parity, .po sync, non-empty strings, and clean copy', () => {
    expect(WAVE_F4_KEYS).toHaveLength(36);
    expect(Object.keys(enSubtitlesSuiteMessages).sort()).toEqual([...WAVE_F4_KEYS].sort());
    expect(Object.keys(trSubtitlesSuiteMessages).sort()).toEqual([...WAVE_F4_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di'].join('|')})\\b`,
      'i',
    );

    for (const key of WAVE_F4_KEYS) {
      const enVal = en.t(key);
      const trVal = tr.t(key);
      expect(enVal.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trVal.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enVal, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trVal, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enVal);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trVal);
    }

    expect(en.t('player.secondarySubtitleTracks')).toBe('Secondary subtitle');
    expect(tr.t('player.secondarySubtitleTracks')).toBe('İkincil altyazı');
    expect(en.t('player.externalSubtitle.fromUrl')).toBe('Load from URL');
    expect(tr.t('player.externalSubtitle.fromUrl')).toBe("URL'den yükle");
    expect(en.t('player.subtitleStyle.section')).toBe('Subtitle style');
    expect(tr.t('player.subtitleStyle.section')).toBe('Altyazı stili');
    expect(en.t('player.subtitleStyle.reset')).toBe('Reset style');
    expect(tr.t('player.subtitleStyle.reset')).toBe('Stili sıfırla');
  });
});
