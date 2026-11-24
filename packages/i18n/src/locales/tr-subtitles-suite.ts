import type { SubtitlesSuiteMessageId } from './en-subtitles-suite';

/** Turkish (`tr`) messages for Wave F4 Subtitles Suite (`#32`, `#402`). */
export const trSubtitlesSuiteMessages: Readonly<Record<SubtitlesSuiteMessageId, string>> = {
  // #402 Dual Subtitles
  'player.secondarySubtitleTracks': 'İkincil altyazı',
  'player.secondarySameAsPrimary': 'Birincil olarak seçili',

  // #32 External Subtitles
  'player.externalSubtitle.load': 'Harici altyazı yükle',
  'player.externalSubtitle.pickFile': 'Altyazı dosyası seç',
  'player.externalSubtitle.fromUrl': "URL'den yükle",
  'player.externalSubtitle.urlTitle': 'Harici altyazı adresi',
  'player.externalSubtitle.urlPlaceholder': 'https://example.invalid/altyazi.srt',
  'player.externalSubtitle.labelPlaceholder': 'Etiket (isteğe bağlı)',
  'player.externalSubtitle.invalidUrl': 'Geçerli bir http(s) altyazı adresi girin.',
  'player.externalSubtitle.loaded': 'Harici altyazı yüklendi',
  'player.externalSubtitle.failed': 'Harici altyazı yüklenemedi.',
  'player.externalSubtitle.badge': 'Harici',

  // #32 Live Subtitle Styling
  'player.subtitleStyle.section': 'Altyazı stili',
  'player.subtitleStyle.size': 'Boyut',
  'player.subtitleStyle.sizeSmall': 'Küçük',
  'player.subtitleStyle.sizeMedium': 'Orta',
  'player.subtitleStyle.sizeLarge': 'Büyük',
  'player.subtitleStyle.sizeExtraLarge': 'Çok büyük',
  'player.subtitleStyle.color': 'Metin rengi',
  'player.subtitleStyle.colorWhite': 'Beyaz',
  'player.subtitleStyle.colorYellow': 'Sarı',
  'player.subtitleStyle.colorCyan': 'Camgöbeği',
  'player.subtitleStyle.colorGreen': 'Yeşil',
  'player.subtitleStyle.background': 'Arka plan',
  'player.subtitleStyle.bgNone': 'Yok',
  'player.subtitleStyle.bgTranslucent': 'Yarı saydam',
  'player.subtitleStyle.bgOpaque': 'Opak',
  'player.subtitleStyle.edge': 'Kenarlık',
  'player.subtitleStyle.edgeNone': 'Yok',
  'player.subtitleStyle.edgeOutline': 'Dış çizgi',
  'player.subtitleStyle.edgeDropShadow': 'Gölge',
  'player.subtitleStyle.position': 'Konum',
  'player.subtitleStyle.posBottom': 'Alt',
  'player.subtitleStyle.posRaised': 'Yükseltilmiş',
  'player.subtitleStyle.posTop': 'Üst',
  'player.subtitleStyle.reset': 'Stili sıfırla',
};
