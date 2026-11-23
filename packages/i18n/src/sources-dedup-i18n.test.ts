import { describe, expect, it } from 'vitest';
import { createAppI18n, enMessages, type MessageId, trMessages } from './index';

describe('@elv/i18n Wave C3 sources, import ergonomics, and catalog deduplication strings (#51, #39, #182, #218, #404)', () => {
  it('localizes Wave C3 clipboard, local file, category picker, XMLTV/TLS, and deduplication static strings in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      // #51 Clipboard & Local File
      ['sources.pasteClipboard', 'Paste', 'Yapıştır'],
      ['sources.chooseLocalFile', 'Choose M3U file', 'M3U dosyası seç'],
      ['sources.clearLocalFile', 'Clear file', 'Dosyayı temizle'],
      [
        'sources.clipboardEmpty',
        'Clipboard has no text to paste.',
        'Panoda yapıştırılacak metin yok.',
      ],
      ['sources.localFileBadge', 'Local file', 'Yerel dosya'],
      // #39 Choose Categories Before Import
      ['sources.chooseCategories', 'Choose categories', 'Kategorileri seç'],
      ['sources.discoveringCategories', 'Loading categories…', 'Kategoriler yükleniyor…'],
      [
        'sources.categoriesStepTitle',
        'Select categories to import',
        'İçe aktarılacak kategorileri seç',
      ],
      ['sources.selectAllCategories', 'Select all', 'Tümünü seç'],
      ['sources.clearCategories', 'Select none', 'Hiçbirini seçme'],
      ['sources.importSelected', 'Import selected', 'Seçilenleri içe aktar'],
      ['sources.reviewNewCategories', 'Review', 'İncele'],
      ['sources.dismissNewCategories', 'Dismiss', 'Yoksay'],
      ['sources.includeNewCategories', 'Include new', 'Yenileri ekle'],
      // #182 XMLTV Timezone & Opt-In Legacy TLS
      ['sources.xmltvTimezoneLabel', 'XMLTV timezone (IANA)', 'XMLTV saat dilimi (IANA)'],
      [
        'sources.xmltvTimezonePlaceholder',
        'Auto (e.g. Europe/Istanbul)',
        'Otomatik (ör. Europe/Istanbul)',
      ],
      [
        'sources.xmltvTimezoneHint',
        'Used only when guide timestamps omit timezone offsets.',
        'Yalnızca rehber zaman damgalarında saat dilimi yoksa kullanılır.',
      ],
      [
        'sources.allowLegacyTls',
        'Allow legacy TLS (older endpoints)',
        'Eski TLS desteğine izin ver',
      ],
      [
        'sources.allowLegacyTlsDesc',
        'Opt-in compatibility for older local tuners or TLS 1.0/1.1 servers.',
        'Eski yerel alıcılar veya TLS 1.0/1.1 sunucuları için isteğe bağlı uyumluluk.',
      ],
      // #218 Live Quality Variants
      [
        'settings.liveTv.collapseVariants',
        'Collapse live quality variants',
        'Canlı kalite sürümlerini grupla',
      ],
      [
        'settings.liveTv.collapseVariantsDesc',
        'Group same-category 4K/FHD/HD/SD duplicates into one row with in-player switching',
        'Aynı kategorideki 4K/FHD/HD/SD kanallarını tek satırda topla ve oynatıcıdan değiştir',
      ],
      ['player.qualityVariant', 'Stream quality', 'Yayın kalitesi'],
      // #404 Multi-Version VOD Grouping
      [
        'settings.playback.groupVodVersions',
        'Group multi-version movies',
        'Çoklu film sürümlerini grupla',
      ],
      [
        'settings.playback.groupVodVersionsDesc',
        'Combine duplicate quality or language editions under one card',
        'Farklı kalite veya dil sürümlerini tek kartta birleştir',
      ],
      ['detail.versionLabel', 'Version', 'Sürüm'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('interpolates Wave C3 localFileSelected, categoriesSelectedCount, pendingCategoriesBanner, qualityVariantCount, and versionCount in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('sources.localFileSelected', { name: 'channels.m3u' })).toBe('File: channels.m3u');
    expect(tr.t('sources.localFileSelected', { name: 'channels.m3u' })).toBe('Dosya: channels.m3u');

    expect(en.t('sources.categoriesSelectedCount', { selected: 5, total: 12 })).toBe(
      '5 of 12 selected',
    );
    expect(tr.t('sources.categoriesSelectedCount', { selected: 5, total: 12 })).toBe(
      '12 kategoriden 5 seçili',
    );

    expect(en.t('sources.pendingCategoriesBanner', { count: 3 })).toBe(
      '3 new categories available',
    );
    expect(tr.t('sources.pendingCategoriesBanner', { count: 3 })).toBe('3 yeni kategori bulundu');

    expect(en.t('player.qualityVariantCount', { count: 4 })).toBe('4 qualities');
    expect(tr.t('player.qualityVariantCount', { count: 4 })).toBe('4 kalite');

    expect(en.t('detail.versionCount', { count: 2 })).toBe('2 versions');
    expect(tr.t('detail.versionCount', { count: 2 })).toBe('2 sürüm');
  });

  it('contains zero DVR/recording copy or competitor brand names across catalogs', () => {
    const forbidden =
      /\b(dvr|recording|tivimate|ott\s*navigator|kodi|plex|emby|jellyfin|vlc|iina|infuse)\b/i;
    for (const [id, text] of Object.entries(enMessages)) {
      expect(text, `forbidden term in en:${id}`).not.toMatch(forbidden);
    }
    for (const [id, text] of Object.entries(trMessages)) {
      expect(text, `forbidden term in tr:${id}`).not.toMatch(forbidden);
    }
  });
});
