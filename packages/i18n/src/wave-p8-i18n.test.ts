import { describe, expect, it } from 'vitest';
import { createAppI18n, enMessages, type MessageId, trMessages } from './index';

describe('Wave P8 i18n strings (VOD Seek Bar, Live Stage, Folder Collections, ELV Picks)', () => {
  it('localizes all Wave P8 keys in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['library.collections.create', 'Create collection', 'Koleksiyon oluştur'],
      ['library.collections.createTitle', 'New collection', 'Yeni koleksiyon'],
      ['library.collections.rename', 'Rename', 'Yeniden adlandır'],
      ['library.collections.renameTitle', 'Rename collection', 'Koleksiyonu yeniden adlandır'],
      ['library.collections.delete', 'Delete collection', 'Koleksiyonu sil'],
      ['library.collections.deleteConfirmTitle', 'Delete collection?', 'Koleksiyon silinsin mi?'],
      [
        'library.collections.deleteConfirmBody',
        'Items stay in My List and return to your general Movies and Series rows.',
        "İçerikler Listem'de kalır ve genel Filmler ile Diziler satırlarına geri döner.",
      ],
      [
        'library.collections.emptySection',
        'Empty collection — move items here from the menu or drag them in.',
        'Boş koleksiyon — içerikleri menüden taşıyabilir veya buraya sürükleyebilirsiniz.',
      ],
      ['library.collections.moveTo', 'Move to collection', 'Koleksiyona taşı'],
      ['library.collections.removeFrom', 'Remove from collection', 'Koleksiyondan çıkar'],
      ['library.collections.dropHere', 'Drop to move here', 'Taşımak için buraya bırakın'],
      ['library.collections.namePlaceholder', 'Collection name', 'Koleksiyon adı'],
      ['catalog.filter.elvPicks', 'ELV Picks', 'ELV Öneri'],
      ['live.stage.fullscreen', 'Fullscreen', 'Tam ekran'],
      [
        'live.stage.doubleClickHint',
        'Double-click video for fullscreen',
        'Tam ekran için videoya çift tıklayın',
      ],
      ['live.zap.favoriteAdd', 'Add to Favorites', 'Favorilere ekle'],
      ['live.zap.favoriteRemove', 'Remove from Favorites', 'Favorilerden çıkar'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('library.collections.moveToNamed', { name: 'Sci-Fi' })).toBe('Move to Sci-Fi');
    expect(tr.t('library.collections.moveToNamed', { name: 'Bilim Kurgu' })).toBe(
      'Bilim Kurgu koleksiyonuna taşı',
    );
  });

  it('removes legacy settings.playback.osdTimeMode and maintains EN/TR parity with zero forbidden copy', () => {
    expect(Object.hasOwn(enMessages, 'settings.playback.osdTimeMode')).toBe(false);
    expect(Object.hasOwn(trMessages, 'settings.playback.osdTimeMode')).toBe(false);
    expect(Object.keys(trMessages).sort()).toEqual(Object.keys(enMessages).sort());

    const forbidden = /\b(dvr|tivimate|ott\s*navigator|kodi|plex|emby|jellyfin|vlc|iina|infuse)\b/i;
    for (const [id, text] of Object.entries(enMessages)) {
      expect(text, `forbidden term in en:${id}`).not.toMatch(forbidden);
    }
    for (const [id, text] of Object.entries(trMessages)) {
      expect(text, `forbidden term in tr:${id}`).not.toMatch(forbidden);
    }
  });
});
