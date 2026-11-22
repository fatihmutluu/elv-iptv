import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('@elv/i18n Wave P3 screens polish strings (#401, #405, #63, #65, #399, #398, #145)', () => {
  it('localizes Playback, Live TV & Guide, and artwork cache settings strings in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['settings.section.playback', 'Playback', 'Oynatma'],
      ['settings.section.liveTv', 'Live TV & Guide', 'Canlı TV ve Rehber'],
      ['settings.playback.title', 'Playback', 'Oynatma'],
      [
        'settings.playback.subtitle',
        'Audio, subtitles, seek step, and video defaults',
        'Ses, altyazı, sarma adımı ve video varsayılanları',
      ],
      ['settings.playback.audioLang', 'Preferred audio language', 'Tercih edilen ses dili'],
      [
        'settings.playback.subtitleLang',
        'Preferred subtitle language',
        'Tercih edilen altyazı dili',
      ],
      ['settings.playback.langAuto', 'Automatic', 'Otomatik'],
      ['settings.playback.subtitleMode', 'Subtitle mode', 'Altyazı modu'],
      ['settings.playback.subtitleMode.auto', 'Automatic', 'Otomatik'],
      ['settings.playback.subtitleMode.always', 'Always on', 'Her zaman açık'],
      ['settings.playback.subtitleMode.off', 'Off', 'Kapalı'],
      ['settings.playback.seekStep', 'Skip interval', 'Atlama süresi'],
      ['settings.playback.defaultAspect', 'Default aspect ratio', 'Varsayılan en-boy oranı'],
      ['settings.playback.bufferPreset', 'Buffer preset', 'Tampon ön ayarı'],
      ['settings.playback.buffer.fast', 'Fast zap', 'Hızlı geçiş'],
      ['settings.playback.buffer.auto', 'Balanced', 'Dengeli'],
      ['settings.playback.buffer.resilient', 'Resilient', 'Dayanıklı'],
      ['settings.liveTv.title', 'Live TV & Guide', 'Canlı TV ve Rehber'],
      [
        'settings.liveTv.subtitle',
        'Default view, TV guide window, channel logos, and zapping',
        'Varsayılan görünüm, rehber aralığı, kanal logoları ve geçiş',
      ],
      ['settings.liveTv.defaultMode', 'Default Live TV view', 'Varsayılan Canlı TV görünümü'],
      ['settings.liveTv.epgSpan', 'TV guide time span', 'TV rehberi zaman aralığı'],
      ['settings.liveTv.epgGenreTints', 'Color-code guide genres', 'Rehber türlerini renklendir'],
      ['settings.liveTv.epgShowClock', 'Show clock in TV guide', 'TV rehberinde saati göster'],
      ['settings.liveTv.guideRefresh', 'Guide refresh interval', 'Rehber yenileme aralığı'],
      ['settings.liveTv.logoBackdrop', 'Channel logo readability', 'Kanal logosu okunabilirliği'],
      ['settings.liveTv.logoBackdrop.plate', 'Subtle plate', 'Hafif zemin'],
      ['settings.liveTv.logoBackdrop.invert', 'Invert dark logos', 'Koyu logoları ters çevir'],
      ['settings.liveTv.logoBackdrop.off', 'Original', 'Orijinal'],
      ['settings.liveTv.sourceBadges', 'Show source badges', 'Kaynak rozetlerini göster'],
      [
        'settings.liveTv.twoStepPreview',
        'Preview channel before fullscreen',
        'Tam ekrandan önce kanalı önizle',
      ],
      [
        'settings.liveTv.cleanTitles',
        'Clean provider tags from channel names',
        'Kanal adlarından sağlayıcı etiketlerini temizle',
      ],
      ['settings.artworkCache', 'Artwork cache limit', 'Görsel önbellek sınırı'],
      ['settings.artworkCacheClear', 'Clear artwork cache', 'Görsel önbelleğini temizle'],
      ['settings.artworkCacheCleared', 'Artwork cache cleared', 'Görsel önbelleği temizlendi'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('settings.playback.seekStepValue', { seconds: 15 })).toBe('15 s');
    expect(tr.t('settings.playback.seekStepValue', { seconds: 15 })).toBe('15 sn');
    expect(en.t('settings.liveTv.epgSpanHours', { hours: 3 })).toBe('3 hours');
    expect(tr.t('settings.liveTv.epgSpanHours', { hours: 3 })).toBe('3 saat');
    expect(en.t('settings.liveTv.guideRefreshHours', { hours: 12 })).toBe('Every 12 h');
    expect(tr.t('settings.liveTv.guideRefreshHours', { hours: 12 })).toBe('Her 12 sa');
    expect(en.t('settings.artworkCacheLimitMb', { mb: 128 })).toBe('128 MB');
    expect(tr.t('settings.artworkCacheLimitMb', { mb: 128 })).toBe('128 MB');
  });

  it('localizes HTTP status errors, import percent, Home/Detail, and live preview strings in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['home.details', 'Details', 'Detaylar'],
      ['detail.readMore', 'Read more', 'Devamını oku'],
      ['detail.readLess', 'Show less', 'Daha az göster'],
      ['detail.synopsisTitle', 'Synopsis', 'Özet'],
      ['detail.prePlayAudio', 'Audio', 'Ses'],
      ['detail.prePlaySubtitles', 'Subtitles', 'Altyazı'],
      ['detail.trackDefault', 'Default', 'Varsayılan'],
      ['detail.director', 'Director', 'Yönetmen'],
      [
        'live.pressAgainFullscreen',
        'Press OK again for fullscreen',
        "Tam ekran için tekrar OK'a basın",
      ],
      ['catalog.sortAlpha', 'A–Z', 'A–Z'],
      ['catalog.sortAlphaLabel', 'Sort alphabetically', 'Alfabetik sırala'],
      ['catalog.sortDefaultLabel', 'Default order', 'Varsayılan sıralama'],
    ];

    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('source.error.httpStatus', { status: 403 })).toBe('Server returned HTTP 403');
    expect(tr.t('source.error.httpStatus', { status: 403 })).toBe('Sunucu HTTP 403 döndürdü');
    expect(en.t('player.error.httpStatus', { status: 503 })).toBe(
      'Stream server returned HTTP 503',
    );
    expect(tr.t('player.error.httpStatus', { status: 503 })).toBe(
      'Yayın sunucusu HTTP 503 döndürdü',
    );
    expect(
      en.t('sources.status.importingPercent', { phase: 'movies', done: 420, percent: 68 }),
    ).toBe('movies · 420 (68%)');
    expect(
      tr.t('sources.status.importingPercent', { phase: 'filmler', done: 420, percent: 68 }),
    ).toBe('filmler · 420 (%68)');
    expect(en.t('detail.searchPerson', { name: 'Nuri Bilge Ceylan' })).toBe(
      'Search Nuri Bilge Ceylan',
    );
    expect(tr.t('detail.searchPerson', { name: 'Nuri Bilge Ceylan' })).toBe(
      'Nuri Bilge Ceylan için ara',
    );
  });
});
