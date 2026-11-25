import type { WaveP2MessageId } from './en-wave-p2';

/** Turkish (`tr`) messages for Wave P2 player OSD polish, mini-player ergonomics & version picker. */
export const trWaveP2Messages: Readonly<Record<WaveP2MessageId, string>> = {
  'player.live.syncing': 'Canlıya dönülüyor...',
  'player.mini.resize': 'Mini oynatıcıyı boyutlandır',
  'player.mini.drag': 'Köşeye taşımak için sürükle',
  'detail.version.choose': 'Sürüm seç',
  'player.settings.desc.subtitles': 'Altyazı izini seçin veya harici altyazı yükleyin',
  'player.settings.desc.audio': 'Mevcut ses dili izleri arasında geçiş yapın',
  'player.settings.desc.audioDelay':
    'Ses senkronizasyon gecikmesini milisaniye cinsinden ayarlayın',
  'player.settings.desc.subtitleDelay': 'Altyazı zamanlamasını öne veya geriye kaydırın',
  'player.settings.desc.subtitleStyle': 'Altyazı boyutunu, rengini ve arka planını özelleştirin',
  'player.settings.desc.audioDevice': 'Sistem ses çıkış cihazını seçin',
  'player.settings.desc.videoQuality': 'Belirli bir yayın çözünürlüğü veya Otomatik seçin',
  'player.settings.desc.quality': 'Alternatif kanal yayın kaliteleri arasında geçiş yapın',
  'player.settings.desc.speed': 'Oynatma hızı çarpanını değiştirin',
  'player.settings.desc.chapters': 'Doğrudan bir bölüm işaretine atlayın',
  'player.settings.desc.sleepTimer':
    'Belirli bir süre sonra oynatmayı otomatik durdurun veya duraklatın',
  'player.settings.desc.videoDecoder': 'Donanım veya yazılım video çözücüsünü seçin',
  'player.settings.desc.resizeMode': 'En-boy oranını Sığdır, Doldur ve Uzat arasında değiştirin',
  'player.settings.desc.timeDisplay': 'Toplam, kalan ve bitiş süresi arasında geçiş yapın',
  'player.settings.desc.info': 'Yayın üst verilerini, kodek ve program ayrıntılarını gösterin',
  'player.settings.desc.alwaysOnTop': 'Oynatıcı penceresini diğer pencerelerin üstünde tutun',
  'player.settings.desc.deinterlace': 'Taramalı yayın video karelerini yumuşatın',
  'player.settings.desc.pitchLock': 'Farklı hızlarda doğal ses tonunu koruyun',
  'player.settings.desc.audioNormalization': 'Kısık diyalogları ve yüksek kanalları dengeleyin',
  'player.settings.desc.autoSubtitlesOnSkipBack':
    'Geri sararken altyazıları geçici olarak gösterin',
  'player.settings.desc.autoPlayNextEpisode': 'Hazır olduğunda sonraki bölümü otomatik başlatın',
  'player.settings.desc.miniPlayer': 'Oynatmayı köşede yüzen mini oynatıcıya küçültün',
  'player.settings.desc.pip': 'Videoyu sistem Resim İçinde Resim moduna alın',
  'player.settings.desc.multiView': 'Birden fazla canlı kanalı yan yana izleyin',
  'player.settings.desc.popout': 'Oynatmayı ayrı bir masaüstü penceresinde açın',
  'player.settings.desc.stats': 'Canlı bit hızı, FPS ve arabellek ölçümlerini gösterin',
};
