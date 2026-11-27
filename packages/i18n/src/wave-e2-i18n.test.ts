import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveE2Messages } from './locales/en-wave-e2';
import { trWaveE2Messages } from './locales/tr-wave-e2';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  // Home Showcase & ELV Picks Recommendations (9)
  ['home.section.elvShowcase', 'Trending & Picks for You', 'Gündem ve Sana Özel'],
  [
    'catalog.elvPicks.emptyTitle',
    'Building your personal picks',
    'Kişisel önerilerin hazırlanıyor',
  ],
  [
    'catalog.elvPicks.emptyBody',
    'Like, star, or watch a few titles and ELV Mode will tailor picks from your library.',
    'Birkaç yapımı beğen, yıldızla veya izle; ELV Mode kütüphanenden sana özel öneriler çıkarsın.',
  ],
  ['elv.reason.moreLikeThis', 'Because of your likes', 'Beğendiklerine benzer'],
  ['elv.reason.trending', 'Trending now', 'Gündemde'],
  ['elv.reason.topPicks', 'Top pick', 'Öne çıkan'],
  ['elv.reason.upcomingTv', 'Current & upcoming', 'Güncel dizi'],
  ['elv.reason.genreMatch', 'Your favorite genre', 'Sevdiğin türde'],
  ['elv.reason.castMatch', 'Cast you follow', 'Takip ettiğin kadro'],

  // IMDb Genre Localization (20)
  ['elv.genre.Action', 'Action', 'Aksiyon'],
  ['elv.genre.Adventure', 'Adventure', 'Macera'],
  ['elv.genre.Animation', 'Animation', 'Animasyon'],
  ['elv.genre.Biography', 'Biography', 'Biyografi'],
  ['elv.genre.Comedy', 'Comedy', 'Komedi'],
  ['elv.genre.Crime', 'Crime', 'Suç'],
  ['elv.genre.Documentary', 'Documentary', 'Belgesel'],
  ['elv.genre.Drama', 'Drama', 'Dram'],
  ['elv.genre.Family', 'Family', 'Aile'],
  ['elv.genre.Fantasy', 'Fantasy', 'Fantastik'],
  ['elv.genre.History', 'History', 'Tarih'],
  ['elv.genre.Horror', 'Horror', 'Korku'],
  ['elv.genre.Music', 'Music', 'Müzik'],
  ['elv.genre.Mystery', 'Mystery', 'Gizem'],
  ['elv.genre.Romance', 'Romance', 'Romantik'],
  ['elv.genre.SciFi', 'Sci-Fi', 'Bilim Kurgu'],
  ['elv.genre.Sport', 'Sport', 'Spor'],
  ['elv.genre.Thriller', 'Thriller', 'Gerilim'],
  ['elv.genre.War', 'War', 'Savaş'],
  ['elv.genre.Western', 'Western', 'Vahşi Batı'],

  // Rich Detail, Trailers & Franchise (10)
  ['detail.action.trailer', 'Watch trailer', 'Fragmanı izle'],
  ['detail.votesCount', '{count} votes', '{count} oy'],
  ['detail.runtimeMin', '{minutes} min', '{minutes} dk'],
  ['detail.directorLabel', 'Director', 'Yönetmen'],
  [
    'detail.franchise.title',
    'More in this series in your library',
    'Bu serinin kütüphanendeki diğer yapımları',
  ],
  ['detail.franchise.current', 'Current', 'Bu yapım'],
  ['detail.trailer.title', 'Trailer', 'Fragman'],
  [
    'detail.trailer.unavailable',
    'Trailer unavailable for this title.',
    'Bu yapım için fragman bulunamadı.',
  ],
  ['detail.trailer.openExternal', 'Open in YouTube', "YouTube'da aç"],
  ['detail.trailer.close', 'Close trailer', 'Fragmanı kapat'],

  // Clickable Cast / Director Library Page (5)
  ['person.alsoInLibrary', 'In your library ({count})', 'Kütüphanendeki yapımları ({count})'],
  [
    'person.emptyLibrary',
    'No other matching titles found in your IPTV library.',
    'IPTV kütüphanende başka eşleşen yapım bulunamadı.',
  ],
  ['person.role.director', 'Director', 'Yönetmen'],
  ['person.role.cast', 'Cast', 'Oyuncu'],
  ['person.close', 'Close', 'Kapat'],

  // Fix Match (9)
  ['detail.fixMatch.action', 'Fix match', 'Eşleşmeyi düzelt'],
  ['detail.fixMatch.title', 'Fix IMDb match', 'IMDb eşleşmesini düzelt'],
  [
    'detail.fixMatch.subtitle',
    'Search and lock the exact title. Future catalog refreshes will keep your choice.',
    'Doğru yapımı arayıp kilitleyin. Sonraki katalog yenilemelerinde seçiminiz korunur.',
  ],
  ['detail.fixMatch.placeholder', 'Search movie or series title…', 'Film veya dizi adı ara…'],
  ['detail.fixMatch.search', 'Search', 'Ara'],
  ['detail.fixMatch.searching', 'Searching IMDb…', "IMDb'de aranıyor…"],
  ['detail.fixMatch.noResults', 'No matching titles found.', 'Eşleşen yapım bulunamadı.'],
  ['detail.fixMatch.lockedBadge', 'Match locked', 'Eşleşme kilitli'],
  ['detail.fixMatch.error', 'Could not update match right now.', 'Eşleşme şu an güncellenemedi.'],

  // In-Player X-Ray (#352) (7)
  ['player.xray.button', 'X-Ray', 'X-Ray'],
  ['player.xray.title', 'X-Ray', 'X-Ray'],
  ['player.xray.cast', 'Cast', 'Oyuncular'],
  ['player.xray.director', 'Director', 'Yönetmen'],
  ['player.xray.episode', 'Now playing', 'Şu an oynatılıyor'],
  ['player.xray.viewLibrary', 'View in library', 'Kütüphanede gör'],
  [
    'player.xray.empty',
    'No cast metadata available for this title.',
    'Bu yapım için oyuncu bilgisi bulunamadı.',
  ],
];

const WAVE_E2_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave E2 ELV Mode Discovery & X-Ray i18n (#512, #352, #459)', () => {
  it('defines all 60 EN and TR keys with strict parity, .po sync, and clean copy', () => {
    expect(WAVE_E2_KEYS).toHaveLength(60);
    expect(Object.keys(enWaveE2Messages).sort()).toEqual([...WAVE_E2_KEYS].sort());
    expect(Object.keys(trWaveE2Messages).sort()).toEqual([...WAVE_E2_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin', 'inf' + 'use'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveE2Messages[key as keyof typeof enWaveE2Messages];
      const trRaw = trWaveE2Messages[key as keyof typeof trWaveE2Messages];
      expect(enRaw).toBe(expectedEn);
      expect(trRaw).toBe(expectedTr);
      expect(enRaw.trim().length, `empty EN for ${key}`).toBeGreaterThan(0);
      expect(trRaw.trim().length, `empty TR for ${key}`).toBeGreaterThan(0);
      expect(enRaw, `forbidden word in EN ${key}`).not.toMatch(forbidden);
      expect(trRaw, `forbidden word in TR ${key}`).not.toMatch(forbidden);
      expect(enPoMap[key], `missing/mismatched EN .po for ${key}`).toBe(enRaw);
      expect(trPoMap[key], `missing/mismatched TR .po for ${key}`).toBe(trRaw);
      if (!expectedEn.includes('{')) {
        expect(en.t(key)).toBe(expectedEn);
        expect(tr.t(key)).toBe(expectedTr);
      }
    }

    expect(en.t('detail.votesCount', { count: '12.4K' })).toBe('12.4K votes');
    expect(tr.t('detail.votesCount', { count: '12.4K' })).toBe('12.4K oy');
    expect(en.t('detail.runtimeMin', { minutes: 142 })).toBe('142 min');
    expect(tr.t('detail.runtimeMin', { minutes: 142 })).toBe('142 dk');
    expect(en.t('person.alsoInLibrary', { count: 4 })).toBe('In your library (4)');
    expect(tr.t('person.alsoInLibrary', { count: 4 })).toBe('Kütüphanendeki yapımları (4)');
  });
});
