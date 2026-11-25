import type { WaveF6MessageId } from './en-wave-f6';

/** Turkish (`tr`) messages for Wave F6 PiP, Multi-View, Mini-Player & Desktop Tray/Popout (`#34`, `#158`, `#221`, `#232`, `#233`). */
export const trWaveF6Messages: Readonly<Record<WaveF6MessageId, string>> = {
  // #34 OS Picture-in-Picture
  'player.pip.enter': 'Pencere içinde pencere',
  'player.pip.unsupported': 'Pencere içinde pencere bu yayın için kullanılamıyor',
  'settings.playback.autoEnterPipTitle': 'Otomatik pencere içinde pencere',
  'settings.playback.autoEnterPipDescription':
    'Uygulamadan çıkarken videoyu yüzen pencerede oynatmaya devam eder.',

  // #233 Floating Corner Mini-Player
  'player.miniPlayer.minimize': 'Oynatıcıyı küçült',
  'player.miniPlayer.expand': 'Oynatıcıyı büyüt',
  'player.miniPlayer.close': 'Mini oynatıcıyı kapat',
  'player.miniPlayer.activeLabel': 'Mini oynatıcı etkin',

  // #34, #221, #232 Multi-View Grid + Connection & Thermal Clamps
  'player.multiView.title': 'Çoklu Görünüm',
  'player.multiView.enter': 'Çoklu Görünüm',
  'player.multiView.exit': 'Çoklu Görünümden çık',
  'player.multiView.addChannel': 'Kanal ekle',
  'player.multiView.replaceChannel': 'Kanalı değiştir',
  'player.multiView.removeTile': 'Ekranı kaldır',
  'player.multiView.swapAudio': 'Sesi buraya al',
  'player.multiView.activeAudio': 'Ses etkin',
  'player.multiView.muted': 'Sessiz',
  'player.multiView.emptySlot': 'Kanal ekle',
  'player.multiView.tileCount': '{count} ekran',
  'player.multiView.connectionLimitTitle': 'Bağlantı sınırına ulaşıldı',
  'player.multiView.connectionLimitBody':
    'Bu kaynak {active} / {max} etkin bağlantıya izin verir. Başka bir kaynaktan kanal seçin veya açık bir ekranı kapatın.',
  'player.multiView.thermalSerious': 'Cihaz ısındı — yeni ekran ekleme geçici olarak duraklatıldı.',
  'player.multiView.thermalCriticalShed':
    'Cihaz aşırı ısındı — oynatmayı korumak için ikincil ekranlar kapatıldı.',
  'player.multiView.lowRamUnsupported': 'Çoklu Görünüm bu düşük bellekli cihazda kullanılamıyor.',
  'player.multiView.deviceCapReached': 'Bu cihaz en fazla {max} eşzamanlı ekranı destekler.',

  // #158 Desktop Popout Player Window & System Tray
  'player.popout.open': 'Ayrı pencerede aç',
  'player.popout.dock': 'Ana pencereye dön',
  'player.popout.pin': 'Her zaman üstte',
  'player.popout.unpin': 'Sabitlemeyi kaldır',
  'player.popout.close': 'Pencereyi kapat',
  'settings.desktop.minimizeToTrayTitle': 'Sistem tepsisine küçült',
  'settings.desktop.minimizeToTrayDescription':
    'Ana pencere kapatıldığında uygulamayı sistem tepsisinde çalışır tutar.',
  'desktop.tray.restore': 'ELV IPTV penceresini göster',
  'desktop.tray.quit': 'Çıkış',
};
