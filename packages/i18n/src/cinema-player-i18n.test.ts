import { describe, expect, it } from 'vitest';
import { createAppI18n, enMessages, type MessageId, trMessages } from './index';

describe('@elv/i18n Wave C1 cinema player, sleep timer, screensaver, scrub & track prefs', () => {
  it('localizes Minimalist Player OSD, #118, #160, #355, #124, #393, and #310 static strings in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      // Minimalist Player OSD (+ existing aspect keys verified)
      ['player.close', 'Close', 'Kapat'],
      ['player.nextEpisodeCta', 'Next Episode', 'Sonraki Bölüm'],
      ['player.channelsCta', 'Channels', 'Kanallar'],
      ['player.aspect.fit', 'Fit', 'Sığdır'],
      ['player.aspect.fill', 'Fill', 'Doldur'],
      ['player.aspect.stretch', 'Stretch', 'Uzat'],
      ['player.remainingTime', 'Remaining', 'Kalan süre'],
      ['player.totalDuration', 'Total duration', 'Toplam süre'],
      ['player.timeDisplayMode', 'Time display', 'Süre gösterimi'],
      [
        'player.timeDisplayToggleHint',
        'Tap time to switch between total, remaining, and end time',
        'Toplam, kalan ve bitiş saati arasında geçmek için süreye dokun',
      ],
      // #118 Sleep Timer, Chapters & Still Watching
      ['player.sleepTimer', 'Sleep timer', 'Uyku zamanlayıcı'],
      ['player.sleepTimerOff', 'Off', 'Kapalı'],
      ['player.sleepTimerAction', 'When timer ends', 'Süre dolunca'],
      ['player.sleepTimerStop', 'Stop playback', 'Oynatmayı durdur'],
      ['player.sleepTimerPause', 'Pause playback', 'Duraklat'],
      [
        'player.sleepTimerEnded',
        'Playback stopped by sleep timer',
        'Uyku zamanlayıcı oynatmayı durdurdu',
      ],
      ['player.chapters', 'Chapters', 'Bölümler'],
      ['player.prevChapter', 'Previous chapter', 'Önceki bölüm'],
      ['player.nextChapter', 'Next chapter', 'Sonraki bölüm'],
      ['player.stillWatchingTitle', 'Are you still watching?', 'Hâlâ izliyor musunuz?'],
      ['player.stillWatchingContinue', 'Keep watching', 'İzlemeye devam et'],
      ['player.stillWatchingStop', 'Stop now', 'Şimdi durdur'],
      // #160 OLED Screensaver & Diagnostics
      ['screensaver.title', 'Screensaver active', 'Ekran koruyucu etkin'],
      [
        'screensaver.wakeHint',
        'Press any key or tap to return',
        'Dönmek için bir tuşa basın veya dokunun',
      ],
      ['settings.playback.oledScreensaver', 'OLED screensaver', 'OLED ekran koruyucu'],
      [
        'settings.playback.oledScreensaverDesc',
        'Dim to pure black when menus or paused playback stay idle',
        'Menüler veya duraklatılmış oynatma boşta kalınca saf siyaha geçer',
      ],
      ['settings.playback.stillWatching', 'Still-watching prompt', 'İzleme onayı uyarısı'],
      [
        'settings.playback.stillWatchingDesc',
        'Confirm active viewing after continuous playback',
        'Uzun süreli kesintisiz izlemede onay iste',
      ],
      ['settings.playback.off', 'Off', 'Kapalı'],
      ['player.stats.droppedFrames', 'Dropped frames', 'Atlanan kare'],
      ['player.stats.cacheHitRate', 'Cache hit rate', 'Önbellek isabeti'],
      ['player.stats.longTasks', 'UI stalls', 'Arayüz takılmaları'],
      // #355 Fine Scrubbing
      ['player.scrub.normal', '1×', '1×'],
      ['player.scrub.quarter', '0.25× · Fine', '0.25× · Hassas'],
      ['player.scrub.fine', '0.1× · Ultra fine', '0.1× · Çok hassas'],
      ['player.scrub.dragUpHint', 'Slide up for fine scrubbing', 'Hassas sarma için yukarı kaydır'],
      // #124, #393, #310 Settings & Player Labels
      ['settings.playback.subtitleModeDefault', 'Default', 'Varsayılan'],
      ['settings.playback.subtitleModeSmart', 'Smart', 'Akıllı'],
      ['settings.playback.subtitleModeOnlyForced', 'Forced only', 'Yalnızca zorunlu'],
      ['settings.playback.subtitleModeAlways', 'Always', 'Her zaman'],
      ['settings.playback.subtitleModeOff', 'Off', 'Kapalı'],
      [
        'settings.playback.preferDefaultAudio',
        'Prefer stream default audio',
        'Yayının varsayılan sesini tercih et',
      ],
      [
        'settings.playback.preferDefaultAudioDesc',
        "Keep the provider's default audio track unless overridden",
        'Aksi seçilmedikçe yayının varsayılan ses parçasını kullan',
      ],
      [
        'settings.playback.preferHevcOverDv',
        'Prefer HEVC over Dolby Vision',
        'Dolby Vision yerine HEVC tercih et',
      ],
      [
        'settings.playback.preferHevcOverDvDesc',
        'Skip Dolby Vision and use standard HEVC on devices with color or black-screen issues.',
        "Renk veya siyah ekran sorunu yaşayan cihazlarda Dolby Vision'ı atlayıp doğrudan standart HEVC kullanır.",
      ],
      [
        'settings.playback.filterSdh',
        'Filter SDH subtitle cues',
        'SDH altyazı açıklamalarını filtrele',
      ],
      [
        'settings.playback.filterSdhDesc',
        'Hide [sound effects], (descriptions), and SPEAKER: labels in text subtitles',
        'Metin altyazılardaki [ses efekti], (açıklama) ve KONUŞMACI: etiketlerini gizle',
      ],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('interpolates Wave C1 time, sleep timer, chapter count, and still-watching placeholders in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('player.endsAt', { time: '22:45' })).toBe('Ends at 22:45');
    expect(tr.t('player.endsAt', { time: '22:45' })).toBe('Bitiş 22:45');

    expect(en.t('player.sleepTimerMinutes', { minutes: 30 })).toBe('30 min');
    expect(tr.t('player.sleepTimerMinutes', { minutes: 30 })).toBe('30 dk');

    expect(en.t('player.sleepTimerRemaining', { minutes: 14 })).toBe('14m left');
    expect(tr.t('player.sleepTimerRemaining', { minutes: 14 })).toBe('14 dk kaldı');

    expect(en.t('player.chapterCount', { count: 8 })).toBe('8 chapters');
    expect(tr.t('player.chapterCount', { count: 8 })).toBe('8 bölüm');

    expect(en.t('player.stillWatchingBody', { seconds: 45 })).toBe(
      'Playback will stop in 45s to save bandwidth.',
    );
    expect(tr.t('player.stillWatchingBody', { seconds: 45 })).toBe(
      'Bant genişliğini korumak için oynatma 45 sn içinde duracak.',
    );

    expect(en.t('settings.playback.minutesOption', { minutes: 15 })).toBe('15 min');
    expect(tr.t('settings.playback.minutesOption', { minutes: 15 })).toBe('15 dk');

    expect(en.t('settings.playback.hoursOption', { hours: 2 })).toBe('2 hr');
    expect(tr.t('settings.playback.hoursOption', { hours: 2 })).toBe('2 sa');
  });

  it('contains zero DVR mentions or third-party competitor brand names across catalogs', () => {
    const forbidden = /\b(dvr|tivimate|ott\s*navigator|kodi|plex|emby|jellyfin|vlc|iina|infuse)\b/i;
    for (const [id, text] of Object.entries(enMessages)) {
      expect(text, `forbidden term in en:${id}`).not.toMatch(forbidden);
    }
    for (const [id, text] of Object.entries(trMessages)) {
      expect(text, `forbidden term in tr:${id}`).not.toMatch(forbidden);
    }
  });
});
