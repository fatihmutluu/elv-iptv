import type { WaveF7aMessageId } from './en-wave-f7a';

/** Turkish (`tr`) messages for Wave F7A AFR/HDR, Desktop Audio Passthrough, Night-Mode DRC & DRM (`#115`, `#116`, `#188`, `#199`, `#213`, `#214`, `#272`). */
export const trWaveF7aMessages: Readonly<Record<WaveF7aMessageId, string>> = {
  // #116, #188, #199, #214 Display AFR & HDR
  'settings.playback.autoFrameRateTitle': 'Kare hızını eşleştir',
  'settings.playback.autoFrameRateDescription':
    'Daha akıcı görüntü için ekran yenileme hızını video kare hızıyla eşleştirir.',
  'settings.playback.autoFrameRateOff': 'Kapalı',
  'settings.playback.autoFrameRateSeamless': 'Yalnızca kesintisiz',
  'settings.playback.autoFrameRateAlways': 'Her zaman',
  'settings.playback.autoDynamicRangeTitle': 'Dinamik aralığı eşleştir',
  'settings.playback.autoDynamicRangeDescription':
    'Ekran çıkışını SDR, HDR10, HLG ve Dolby Vision arasında otomatik değiştirir.',

  // #115 Night-Mode DRC & Per-Refresh-Rate Audio Delay
  'settings.playback.nightModeDrcTitle': 'Gece modu (dinamik aralık)',
  'settings.playback.nightModeDrcDescription':
    'Gece izlerken yüksek ses efektlerini kısar ve alçak diyalogları netleştirir.',
  'settings.playback.nightModeDrcOff': 'Kapalı',
  'settings.playback.nightModeDrcLight': 'Hafif',
  'settings.playback.nightModeDrcNight': 'Gece',
  'settings.playback.refreshRateAudioDelayTitle': 'Yenileme hızına göre ses gecikmesi',
  'settings.playback.refreshRateAudioDelayDescription':
    'Her ekran yenileme hızı için ayrı ses eşitleme gecikmesini otomatik uygular.',

  // #213 Desktop Audio Passthrough & Channel Layout
  'settings.desktop.audioPassthroughTitle': 'Ses doğrudan aktarımı (bit akışı)',
  'settings.desktop.audioPassthroughDescription':
    'Kodlanmış çevresel sesi HDMI veya optik çıkışla doğrudan harici alıcıya gönderir.',
  'settings.desktop.audioPassthroughCodecsTitle': 'Doğrudan aktarım çözücüleri',
  'settings.desktop.audioExclusiveTitle': 'Özel ses aygıtı modu',
  'settings.desktop.audioExclusiveDescription':
    'Oynatma sırasında sistem karıştırıcısını atlamak için ses çıkışını özel modda kullanır.',
  'settings.desktop.audioAc3EncodeTitle': 'Gerçek zamanlı AC-3 kodlama',
  'settings.desktop.audioAc3EncodeDescription':
    'Çok kanallı sesi optik S/PDIF alıcılar için gerçek zamanlı AC-3 olarak kodlar.',
  'settings.desktop.audioChannelLayoutTitle': 'Hoparlör kanal düzeni',
  'settings.desktop.audioChannelLayoutAuto': 'Otomatik',
  'settings.desktop.audioChannelLayoutStereo': 'Stereo (2.0)',
  'settings.desktop.audioChannelLayout51': '5.1 Çevresel',
  'settings.desktop.audioChannelLayout71': '7.1 Çevresel',

  // #213, #272 Player notices & errors
  'player.audio.passthroughFallbackNotice':
    'Bu cihazda ses doğrudan aktarımı kullanılamıyor — PCM çıkışına geçildi.',
  'player.error.drmUnsupported': 'Korumalı yayın bu cihazda oynatılamıyor.',
};
