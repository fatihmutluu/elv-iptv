import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveF5bMessages } from './locales/en-wave-f5b';
import { trWaveF5bMessages } from './locales/tr-wave-f5b';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // #29 Stalker / Ministra MAC Portals
  ['sources.mode.stalker', 'Stalker / MAC', 'Stalker / MAC'],
  ['sources.stalker.portalUrlLabel', 'Portal URL', 'Portal adresi'],
  [
    'sources.stalker.portalUrlPlaceholder',
    'http://portal.example.test/c/',
    'http://portal.example.test/c/',
  ],
  ['sources.stalker.macLabel', 'MAC address', 'MAC adresi'],
  ['sources.stalker.macPlaceholder', '00:1A:79:00:00:01', '00:1A:79:00:00:01'],
  ['sources.stalker.serialLabel', 'Serial number (optional)', 'Seri numarası (isteğe bağlı)'],
  [
    'sources.stalker.serialPlaceholder',
    'Optional device serial',
    'İsteğe bağlı cihaz seri numarası',
  ],
  ['sources.stalker.invalidMac', 'Enter a valid MAC address.', 'Geçerli bir MAC adresi girin.'],
  [
    'sources.stalker.invalidMacHint',
    'Use 6 hex pairs separated by colons, e.g. 00:1A:79:00:00:01.',
    'İki nokta ile ayrılmış 6 onaltılık çift kullanın, örn. 00:1A:79:00:00:01.',
  ],
  ['sources.stalker.kindBadge', 'Stalker', 'Stalker'],

  // #215 Key-Free VOD Enrichment
  [
    'settings.appearance.vodEnrichmentTitle',
    'Enrich movie & series details',
    'Film ve dizi bilgilerini zenginleştir',
  ],
  [
    'settings.appearance.vodEnrichmentDescription',
    'Fill missing ratings, release years, and genres locally without an API key.',
    'Eksik puanları, yapım yıllarını ve türleri API anahtarı olmadan yerel olarak tamamlar.',
  ],
  ['detail.enrichment.badge', 'Enriched', 'Zenginleştirildi'],
  ['detail.enrichment.ratingLabel', 'Rating', 'Puan'],
  ['detail.enrichment.genresLabel', 'Genres', 'Türler'],

  // #403 Custom VOD Collections
  ['collections.title', 'Collections', 'Koleksiyonlar'],
  [
    'collections.subtitle',
    'Organize movies and series into personal playlists.',
    'Film ve dizileri kişisel listelerde düzenleyin.',
  ],
  [
    'collections.empty',
    'No collections yet. Create one to group your favorite movies and series.',
    'Henüz koleksiyon yok. Favori film ve dizilerinizi gruplamak için bir koleksiyon oluşturun.',
  ],
  ['collections.addToCollection', 'Add to collection', 'Koleksiyona ekle'],
  ['collections.inCollections', 'In collections', 'Koleksiyonlarda'],
  ['collections.manageTitle', 'Manage collections', 'Koleksiyonları yönet'],
  ['collections.createPlaceholder', 'New collection name', 'Yeni koleksiyon adı'],
  ['collections.createAction', 'Create', 'Oluştur'],
  ['collections.rename', 'Rename', 'Yeniden adlandır'],
  ['collections.save', 'Save', 'Kaydet'],
  ['collections.cancel', 'Cancel', 'İptal'],
  ['collections.delete', 'Delete', 'Sil'],
  ['collections.moveUp', 'Move up', 'Yukarı taşı'],
  ['collections.moveDown', 'Move down', 'Aşağı taşı'],
  ['collections.removeItem', 'Remove from collection', 'Koleksiyondan çıkar'],
  ['collections.itemCount', '{count, plural, one {# title} other {# titles}}', '{count} yapım'],
  ['collections.saved', 'Collection updated', 'Koleksiyon güncellendi'],
  ['collections.close', 'Close', 'Kapat'],
  [
    'collections.emptyCollection',
    'No titles in this collection yet.',
    'Bu koleksiyonda henüz yapım yok.',
  ],
  ['collections.viewAll', 'View all', 'Tümünü gör'],
];

const WAVE_F5B_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave F5B Stalker, VOD Enrichment & Collections i18n (#29, #215, #403)', () => {
  it('defines all 35 EN and TR keys with strict parity, .po sync, clean copy, and placeholder formatting', () => {
    expect(WAVE_F5B_KEYS).toHaveLength(35);
    expect(Object.keys(enWaveF5bMessages).sort()).toEqual([...WAVE_F5B_KEYS].sort());
    expect(Object.keys(trWaveF5bMessages).sort()).toEqual([...WAVE_F5B_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveF5bMessages[key as keyof typeof enWaveF5bMessages];
      const trRaw = trWaveF5bMessages[key as keyof typeof trWaveF5bMessages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
    }

    expect(en.t('sources.mode.stalker')).toBe('Stalker / MAC');
    expect(tr.t('sources.mode.stalker')).toBe('Stalker / MAC');
    expect(en.t('sources.stalker.portalUrlPlaceholder')).toBe('http://portal.example.test/c/');
    expect(tr.t('sources.stalker.portalUrlPlaceholder')).toBe('http://portal.example.test/c/');
    expect(en.t('settings.appearance.vodEnrichmentTitle')).toBe('Enrich movie & series details');
    expect(tr.t('settings.appearance.vodEnrichmentTitle')).toBe(
      'Film ve dizi bilgilerini zenginleştir',
    );
    expect(en.t('collections.itemCount', { count: 1 })).toBe('1 title');
    expect(en.t('collections.itemCount', { count: 4 })).toBe('4 titles');
    expect(tr.t('collections.itemCount', { count: 1 })).toBe('1 yapım');
    expect(tr.t('collections.itemCount', { count: 4 })).toBe('4 yapım');
    expect(en.t('collections.saved')).toBe('Collection updated');
    expect(tr.t('collections.saved')).toBe('Koleksiyon güncellendi');
  });
});
