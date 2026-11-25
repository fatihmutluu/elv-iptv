import type { WaveF7bMessageId } from './en-wave-f7b';

/** Turkish (`tr`) messages for Wave F7B external display, multi-program TS, external player & crash diagnostics (`#258`, `#304`, `#406`, `#226`). */
export const trWaveF7bMessages: Readonly<Record<WaveF7bMessageId, string>> = {
  // #258 External display
  'player.externalDisplay.title': 'Harici ekranda oynatılıyor',
  'player.externalDisplay.subtitle': 'Video bağlı TV veya monitöre aktarılıyor.',
  'player.externalDisplay.hint':
    'Duraklatmak, sarmak veya parça değiştirmek için aşağıdaki kontrolleri kullanın.',

  // #304 Multi-program MPEG-TS
  'player.tracks.program': 'Program',
  'player.tracks.programNumber': 'Program {number}',

  // #406 External player
  'settings.playback.externalPlayerTitle': 'Harici oynatıcı',
  'settings.playback.externalPlayerHint':
    'Yayın oynatmayı cihazda yüklü başka bir medya oynatıcı uygulamasına devreder.',
  'settings.playback.externalPlayerOff': 'Kapalı',
  'settings.playback.externalPlayerAsk': 'Her seferinde sor',
  'settings.playback.externalPlayerAlways': 'Her zaman',
  'settings.playback.externalPlayerSchemeLabel': 'Özel oynatıcı URL şeması (isteğe bağlı)',
  'settings.playback.externalPlayerSchemePlaceholder': 'örn. oynatici',
  'player.externalPrompt.title': 'Yayını şununla aç',
  'player.externalPrompt.subtitle':
    'ELV IPTV içinde oynatmayı veya harici bir oynatıcıya devretmeyi seçin.',
  'player.externalPrompt.integrated': 'Dahili oynatıcı',
  'player.externalPrompt.external': 'Harici oynatıcı',
  'player.externalPrompt.cancel': 'İptal',
  'player.externalHandoff.failed': 'Bu cihazda harici oynatıcı açılamadı.',

  // #226 Crash diagnostics
  'settings.diagnostics.title': 'Çökme tanılama',
  'settings.diagnostics.optInLabel': 'Tanılama çökme raporlarını etkinleştir',
  'settings.diagnostics.optInHint':
    'Beklenmeyen bir hata oluştuğunda yerel olarak gizlenmiş Markdown raporları oluşturur.',
  'settings.diagnostics.includeLogsLabel': 'Son gizlenmiş günlükleri ekle',
  'settings.diagnostics.includeLogsHint':
    'Rapor hazırlarken en fazla 250 son gizlenmiş günlük satırı ekler.',
  'settings.diagnostics.previewAction': 'Tanılama raporunu önizle',
  'crash.diagnosticsAction': 'Tanılamayı görüntüle',
  'crash.report.title': 'Tanılama raporu',
  'crash.report.subtitle':
    'Kimlik bilgileri, yayın adresleri ve kullanıcı yolları görüntüleme veya dışa aktarma öncesinde gizlenir.',
  'crash.report.includeLogsToggle': 'Son günlükleri ekle',
  'crash.report.copy': 'Raporu kopyala',
  'crash.report.copied': 'Panoya kopyalandı',
  'crash.report.export': 'Markdown dışa aktar',
  'crash.report.exported': 'Rapor dışa aktarıldı',
  'crash.report.close': 'Kapat',
  'crash.report.emptyLogs': 'Yakalanan son tanılama günlüğü yok.',
};
