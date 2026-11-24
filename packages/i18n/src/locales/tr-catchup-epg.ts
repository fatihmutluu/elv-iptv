import type { CatchupEpgMessageId } from './en-catchup-epg';

/** Turkish (`tr`) messages for Wave F3 Catch-Up, Live Time-Shift, Multi-Guide & Reminders (`#27`, `#28`, `#30`, `#35`). */
export const trCatchupEpgMessages: Readonly<Record<CatchupEpgMessageId, string>> = {
  // #27 Catch-Up
  'epg.catchupBadge': 'Arşiv',
  'epg.watchCatchup': 'Arşivden izle',
  'epg.catchupUnavailable': 'Bu program için arşiv yayını kullanılamıyor.',
  'epg.catchupExpired': 'Bu programın arşiv izleme süresi doldu.',
  'player.catchupBadge': 'ARŞİV',
  'player.backToLive': 'Canlı yayına dön',

  // #28 Live Time-Shift
  'player.livePaused': 'Canlı duraklatıldı',
  'player.behindLive': 'Canlıdan {offset} geride',
  'player.timeShiftUnavailable': 'Bu yayın için canlı geri sarma kullanılamıyor.',
  'player.liveEdge': 'Canlı uçta',

  // #30 Multi-Guide & Channel Mapper
  'sources.guides.button': 'Rehberler ve eşleştirme',
  'sources.guides.title': 'TV rehberleri ve kanal eşleştirme',
  'sources.guides.subtitle':
    'XMLTV rehber önceliğini, saat farklarını ve manuel kanal eşleştirmelerini yönetin.',
  'sources.guides.guidesTab': 'Rehber kaynakları',
  'sources.guides.mapperTab': 'Kanal eşleştirici',
  'sources.guides.addGuide': 'Rehber kaynağı ekle',
  'sources.guides.namePlaceholder': 'Rehber adı (ör. Yedek XMLTV)',
  'sources.guides.urlPlaceholder': 'http://example.invalid/epg.xml.gz',
  'sources.guides.offsetLabel': 'Saat farkı',
  'sources.guides.offsetHours': '{hours} sa',
  'sources.guides.priorityUp': 'Yukarı taşı',
  'sources.guides.priorityDown': 'Aşağı taşı',
  'sources.guides.remove': 'Kaldır',
  'sources.guides.empty': 'Henüz ek rehber kaynağı tanımlanmadı.',
  'sources.guides.filterAll': 'Tüm kanallar',
  'sources.guides.filterUnmatched': 'Eşleşmeyenler',
  'sources.guides.searchPlaceholder': 'Kanal veya rehber kimliği ara…',
  'sources.guides.unmatchedBadge': 'Eşleşmedi',
  'sources.guides.manualBadge': 'Manuel',
  'sources.guides.assignGuide': 'Rehber kanalı ata',
  'sources.guides.clearOverride': 'Otomatiğe sıfırla',
  'sources.guides.channelOffsetLabel': 'Kanal saat farkı',
  'sources.guides.noGuideChannels': 'Kullanılabilir rehber kanalı yok. Önce rehberi yenileyin.',
  'sources.guides.save': 'Kaydet',
  'sources.guides.cancel': 'İptal',

  // #35 Programme Reminders
  'epg.remindMe': 'Hatırlat',
  'epg.cancelReminder': 'Hatırlatıcıyı iptal et',
  'epg.reminderScheduled': 'Hatırlatıcı kuruldu',
  'epg.reminderLeadLabel': 'Başlamadan önce hatırlat',
  'epg.reminderBannerTitle': 'Birazdan başlıyor',
  'epg.reminderStartsIn': '{minutes} dk içinde başlıyor',
  'epg.reminderStartingNow': 'Şimdi başlıyor',
  'epg.reminderTuneNow': 'Şimdi aç',
  'epg.reminderDismiss': 'Kapat',
};
