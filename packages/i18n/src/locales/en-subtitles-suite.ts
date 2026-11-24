/** English (source) messages for Wave F4 Subtitles Suite (`#32`, `#402`). */
export const enSubtitlesSuiteMessages = {
  // #402 Dual Subtitles
  'player.secondarySubtitleTracks': 'Secondary subtitle',
  'player.secondarySameAsPrimary': 'Active as primary',

  // #32 External Subtitles
  'player.externalSubtitle.load': 'Load external subtitle',
  'player.externalSubtitle.pickFile': 'Choose subtitle file',
  'player.externalSubtitle.fromUrl': 'Load from URL',
  'player.externalSubtitle.urlTitle': 'External subtitle URL',
  'player.externalSubtitle.urlPlaceholder': 'https://example.invalid/subtitles.srt',
  'player.externalSubtitle.labelPlaceholder': 'Label (optional)',
  'player.externalSubtitle.invalidUrl': 'Enter a valid http(s) subtitle URL.',
  'player.externalSubtitle.loaded': 'External subtitle loaded',
  'player.externalSubtitle.failed': 'Could not load external subtitle.',
  'player.externalSubtitle.badge': 'External',

  // #32 Live Subtitle Styling
  'player.subtitleStyle.section': 'Subtitle style',
  'player.subtitleStyle.size': 'Size',
  'player.subtitleStyle.sizeSmall': 'Small',
  'player.subtitleStyle.sizeMedium': 'Medium',
  'player.subtitleStyle.sizeLarge': 'Large',
  'player.subtitleStyle.sizeExtraLarge': 'Extra large',
  'player.subtitleStyle.color': 'Text color',
  'player.subtitleStyle.colorWhite': 'White',
  'player.subtitleStyle.colorYellow': 'Yellow',
  'player.subtitleStyle.colorCyan': 'Cyan',
  'player.subtitleStyle.colorGreen': 'Green',
  'player.subtitleStyle.background': 'Background',
  'player.subtitleStyle.bgNone': 'None',
  'player.subtitleStyle.bgTranslucent': 'Translucent',
  'player.subtitleStyle.bgOpaque': 'Solid',
  'player.subtitleStyle.edge': 'Edge',
  'player.subtitleStyle.edgeNone': 'None',
  'player.subtitleStyle.edgeOutline': 'Outline',
  'player.subtitleStyle.edgeDropShadow': 'Shadow',
  'player.subtitleStyle.position': 'Position',
  'player.subtitleStyle.posBottom': 'Bottom',
  'player.subtitleStyle.posRaised': 'Raised',
  'player.subtitleStyle.posTop': 'Top',
  'player.subtitleStyle.reset': 'Reset style',
} as const;

/** Message identifiers for Wave F4 Subtitles Suite. */
export type SubtitlesSuiteMessageId = keyof typeof enSubtitlesSuiteMessages;
