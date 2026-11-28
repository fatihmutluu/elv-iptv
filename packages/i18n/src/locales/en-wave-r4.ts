/** English (source) messages for Wave R4 player simplification, 2-level settings, and window mode popup. */
export const enWaveR4Messages = {
  'player.subtitleSettings': 'Subtitle settings',
  'player.audioSettings': 'Audio settings',
  'player.advancedSettings': 'Advanced settings',
  'player.settings.desc.advanced': 'Decoder, deinterlace and playback options',
  'player.windowMode': 'Window mode',
  'player.windowMode.mini': 'Mini player',
  'player.windowMode.popout': 'Separate window',
} as const;

/** Message identifiers for Wave R4 player simplification. */
export type WaveR4MessageId = keyof typeof enWaveR4Messages;
