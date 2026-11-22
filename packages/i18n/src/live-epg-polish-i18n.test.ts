import { describe, expect, it } from 'vitest';
import { createAppI18n, enMessages, type MessageId, trMessages } from './index';

describe('@elv/i18n Wave C2 Live TV & EPG polish strings (#68, #52, #53, #251, #395, #396, #400)', () => {
  it('localizes Wave C2 auto-refresh, previous channel, recent channels, preview, EPG, badges, and context menu static strings in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      // #68 Auto-Refresh
      [
        'settings.liveTv.catalogRefreshInterval',
        'Catalog auto-refresh',
        'Katalog otomatik yenileme',
      ],
      [
        'settings.liveTv.catalogRefreshIntervalDesc',
        'Automatically refresh channels, movies, and series in the background',
        'Kanalları, filmleri ve dizileri arka planda otomatik yenile',
      ],
      ['settings.liveTv.refreshManualOnly', 'Manual only', 'Yalnızca manuel'],
      ['sources.refreshGuide', 'Refresh guide', 'Rehberi yenile'],
      ['sources.neverSynced', 'Not synced yet', 'Henüz güncellenmedi'],
      // #52 Previous Channel
      ['live.previousChannel', 'Previous channel', 'Önceki kanal'],
      // #53 Recently Watched Channels
      ['home.recentChannels', 'Recently watched channels', 'Son izlenen kanallar'],
      ['player.channelDrawerAll', 'All', 'Tümü'],
      ['player.channelDrawerRecent', 'Recent', 'Son izlenenler'],
      [
        'player.channelDrawerRecentEmpty',
        'Channels you watch appear here',
        'İzlediğin kanallar burada görünür',
      ],
      // #251 Browse-While-Watching (NO_SWITCH) Preview
      [
        'settings.liveTv.channelSwitchMode',
        'CH+/CH- channel switching',
        'CH+/CH- kanal değiştirme',
      ],
      [
        'settings.liveTv.channelSwitchModeDesc',
        'Switch immediately or preview programme info before tuning',
        'Hemen kanala geç veya açmadan önce program bilgisini önizle',
      ],
      ['settings.liveTv.switchInstant', 'Instant switch', 'Anında geç'],
      ['settings.liveTv.switchPreview', 'Preview first', 'Önce önizle'],
      [
        'player.previewChannelHint',
        'Press OK to tune · Back to cancel',
        'Açmak için OK · İptal için Geri',
      ],
      ['player.previewBadge', 'Preview', 'Önizleme'],
      // #395 Multi-Day EPG & Programme Detail Modal
      ['epg.today', 'Today', 'Bugün'],
      ['epg.tomorrow', 'Tomorrow', 'Yarın'],
      ['epg.programmeDetails', 'Programme details', 'Program detayları'],
      ['epg.tuneChannel', 'Tune to channel', 'Kanalı aç'],
      [
        'epg.noDescription',
        'No programme description available.',
        'Program açıklaması bulunmuyor.',
      ],
      ['epg.upcoming', 'Upcoming', 'Yaklaşan'],
      // #396 EPG Badges & Genres
      ['epg.badge.live', 'Live', 'Canlı'],
      ['epg.badge.new', 'New', 'Yeni'],
      ['epg.badge.premiere', 'Premiere', 'İlk gösterim'],
      ['epg.genre.sports', 'Sports', 'Spor'],
      ['epg.genre.movie', 'Movie', 'Film'],
      ['epg.genre.news', 'News', 'Haber'],
      ['epg.genre.kids', 'Kids', 'Çocuk'],
      ['epg.genre.series', 'Series', 'Dizi'],
      ['epg.genre.other', 'General', 'Genel'],
      // #400 Long-Press Context Menu
      ['live.contextMenuTitle', 'Channel options', 'Kanal seçenekleri'],
      ['live.context.play', 'Play channel', 'Kanalı oynat'],
      ['live.context.addFavorite', 'Add to favorites', 'Favorilere ekle'],
      ['live.context.removeFavorite', 'Remove from favorites', 'Favorilerden çıkar'],
      ['live.context.programmeDetails', 'Programme details', 'Program detayları'],
      ['live.context.hideChannel', 'Hide channel', 'Kanalı gizle'],
    ];

    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('interpolates Wave C2 refreshHours, lastSynced, and durationMinutes placeholders in EN and TR', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('settings.liveTv.refreshHours', { hours: 12 })).toBe('Every 12h');
    expect(tr.t('settings.liveTv.refreshHours', { hours: 12 })).toBe('12 saatte bir');

    expect(en.t('sources.lastSynced', { time: '14:30' })).toBe('Synced 14:30');
    expect(tr.t('sources.lastSynced', { time: '14:30' })).toBe('Güncellendi: 14:30');

    expect(en.t('epg.durationMinutes', { minutes: 45 })).toBe('45 min');
    expect(tr.t('epg.durationMinutes', { minutes: 45 })).toBe('45 dk');
  });

  it('contains zero DVR/recording copy or competitor brand names in Wave C2 strings and catalogs', () => {
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
