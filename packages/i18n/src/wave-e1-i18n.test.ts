import { describe, expect, it } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import { createAppI18n, type MessageId } from './index';
import { enWaveE1Messages } from './locales/en-wave-e1';
import { trWaveE1Messages } from './locales/tr-wave-e1';

const EXPECTED_PAIRS: ReadonlyArray<readonly [MessageId, string, string]> = [
  ['settings.section.elvMode', 'ELV Mode', 'ELV Mode'],
  [
    'settings.elvMode.subtitle',
    'Transform any IPTV list into a cinema-grade catalog with zero performance overhead.',
    'Herhangi bir IPTV listesini performans kaybı olmadan sinema kalitesinde bir kataloğa dönüştürün.',
  ],
  ['settings.elvMode.masterTitle', 'ELV Mode', 'ELV Mode'],
  [
    'settings.elvMode.masterDescription',
    'Non-destructive enhancement powered by IMDb metadata and smart multi-source merging. Turn off anytime to return to raw provider data.',
    'IMDb verileri ve akıllı çoklu kaynak birleştirme ile tahribatsız iyileştirme. İstediğiniz an kapatıp ham sağlayıcı görünümüne dönebilirsiniz.',
  ],
  [
    'settings.elvMode.mergeVersions',
    'Merge movie & series versions',
    'Film ve dizi sürümlerini birleştir',
  ],
  [
    'settings.elvMode.mergeVersionsDesc',
    'Combine duplicates and multi-source copies under one clean card with a source/quality picker.',
    'Aynı yapımın farklı sürümlerini ve birden fazla kaynaktaki kopyalarını tek kartta toplayıp detaydan seçtirir.',
  ],
  [
    'settings.elvMode.enrichMetadata',
    'Clean posters, ratings & rich details',
    'Temiz posterler, puanlar ve zengin detay',
  ],
  [
    'settings.elvMode.enrichMetadataDesc',
    'Load crisp IMDb posters, ratings, and localized synopses directly without double-fetching provider art.',
    'Sağlayıcı görsellerini tekrar indirmeden doğrudan temiz IMDb posterlerini, puanlarını ve yerel dil özetlerini yükler.',
  ],
  ['settings.elvMode.titleFormat', 'Title display format', 'Başlık gösterim formatı'],
  [
    'settings.elvMode.titleFormatDesc',
    'Choose how movie and series titles appear across browse, detail, and search.',
    'Film ve dizi adlarının göz atma, detay ve aramada nasıl görüneceğini seçin.',
  ],
  ['settings.elvMode.titleFormat.original', 'Original title', 'Orijinal ad'],
  ['settings.elvMode.titleFormat.system', 'System language', 'Sistem dili'],
  ['settings.elvMode.titleFormat.english', 'English', 'İngilizce'],
  ['settings.elvMode.titleFormat.english_system', 'English (System)', 'İngilizce (Sistem)'],
  ['settings.elvMode.titleFormat.original_system', 'Original (System)', 'Orijinal (Sistem)'],
  ['settings.elvMode.titleFormat.system_english', 'System (English)', 'Sistem (İngilizce)'],
  ['settings.elvMode.titleFormat.system_original', 'System (Original)', 'Sistem (Orijinal)'],
  ['settings.elvMode.categorySource', 'Category source', 'Kategori kaynağı'],
  [
    'settings.elvMode.categorySourceDesc',
    "Browse Movies and Series by clean IMDb genres or keep your IPTV provider's folders.",
    "Filmler ve Diziler'de temiz IMDb türlerini veya IPTV sağlayıcınızın kendi klasörlerini kullanın.",
  ],
  ['settings.elvMode.categorySource.imdb', 'IMDb genres', 'IMDb türleri'],
  ['settings.elvMode.categorySource.provider', 'Provider folders', 'Sağlayıcı klasörleri'],
  [
    'settings.elvMode.smartRecommendations',
    'Smart recommendations & trending showcase',
    'Akıllı öneriler ve ana sayfa gündem vitrini',
  ],
  [
    'settings.elvMode.smartRecommendationsDesc',
    'Personalize picks from your library and trending IMDb lists, automatically hiding disliked items.',
    'Kütüphanenizdeki yapımlardan ve IMDb gündem listelerinden kişisel öneriler sunar, beğenmediklerinizi gizler.',
  ],
  [
    'settings.elvMode.xray',
    'In-player X-Ray (cast & episode info)',
    'Oynatıcı içi X-Ray (oyuncular ve bölüm bilgisi)',
  ],
  [
    'settings.elvMode.xrayDesc',
    'Show clickable cast portraits and episode details when you pause playback.',
    'Oynatmayı duraklattığınızda tıklanabilir oyuncu kadrosu ve bölüm bilgilerini gösterir.',
  ],
  [
    'settings.elvMode.liveEnhance',
    'Live TV cleanup, quality grouping & failover',
    'Canlı TV temizleme, kalite gruplama ve otomatik yedek',
  ],
  [
    'settings.elvMode.liveEnhanceDesc',
    'Strip provider tags, group HD/FHD/4K copies across categories, auto-switch on drop, and demote dead streams.',
    'Sağlayıcı etiketlerini temizler, kategoriler arası kalite kopyalarını birleştirir, kopunca yedeğe geçer ve bozuk yayınları alta alır.',
  ],
  [
    'settings.elvMode.verifyRealQuality',
    'Real quality verification & broken-version memory',
    'Gerçek kalite doğrulama ve bozuk sürüm hafızası',
  ],
  [
    'settings.elvMode.verifyRealQualityDesc',
    'Remember true stream resolution to correct mislabeled 4K streams and deprioritize failing copies.',
    'Gerçek yayın çözünürlüğünü kaydedip sahte 4K etiketlerini düzeltir ve sürekli hata veren sürümleri alta iter.',
  ],
  ['elv.quality.verified', 'Verified {resolution}', 'Doğrulanmış {resolution}'],
  ['elv.quality.fake4k', 'Actual {resolution} (labeled 4K)', 'Gerçek {resolution} (4K etiketli)'],
  ['elv.quality.unreliable', 'Unreliable', 'Sorunlu'],
  ['elv.source.from', 'from {source}', '{source} kaynağından'],
  ['elv.versions.title', 'Sources & versions ({count})', 'Kaynaklar ve sürümler ({count})'],
  [
    'elv.matching.background',
    'Enhancing catalog in background…',
    'Katalog arka planda zenginleştiriliyor…',
  ],
];

const WAVE_E1_KEYS: readonly MessageId[] = EXPECTED_PAIRS.map(([id]) => id);

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

describe('Wave E1 ELV Mode i18n (#511)', () => {
  it('defines all 35 EN and TR keys with strict parity, .po sync, and clean copy', () => {
    expect(WAVE_E1_KEYS).toHaveLength(35);
    expect(Object.keys(enWaveE1Messages).sort()).toEqual([...WAVE_E1_KEYS].sort());
    expect(Object.keys(trWaveE1Messages).sort()).toEqual([...WAVE_E1_KEYS].sort());

    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const enPoMap = parsePoEntries(enPo);
    const trPoMap = parsePoEntries(trPo);

    const forbidden = new RegExp(
      `\\b(${['d' + 'vr', 'record' + 'ing', 'tivi' + 'mate', 'smar' + 'ters', 'v' + 'lc', 'ko' + 'di', 'pl' + 'ex', 'em' + 'by', 'jelly' + 'fin', 'inf' + 'use'].join('|')})\\b`,
      'i',
    );

    for (const [key, expectedEn, expectedTr] of EXPECTED_PAIRS) {
      const enRaw = enWaveE1Messages[key as keyof typeof enWaveE1Messages];
      const trRaw = trWaveE1Messages[key as keyof typeof trWaveE1Messages];
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

    expect(en.t('elv.quality.verified', { resolution: '1080p' })).toBe('Verified 1080p');
    expect(tr.t('elv.quality.verified', { resolution: '1080p' })).toBe('Doğrulanmış 1080p');
    expect(en.t('elv.quality.fake4k', { resolution: '720p' })).toBe('Actual 720p (labeled 4K)');
    expect(tr.t('elv.quality.fake4k', { resolution: '720p' })).toBe('Gerçek 720p (4K etiketli)');
    expect(en.t('elv.source.from', { source: 'Alpha TV' })).toBe('from Alpha TV');
    expect(tr.t('elv.source.from', { source: 'Alpha TV' })).toBe('Alpha TV kaynağından');
    expect(en.t('elv.versions.title', { count: 3 })).toBe('Sources & versions (3)');
    expect(tr.t('elv.versions.title', { count: 3 })).toBe('Kaynaklar ve sürümler (3)');
  });
});
