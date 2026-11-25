/** English (source) messages for Wave F7A AFR/HDR, Desktop Audio Passthrough, Night-Mode DRC & DRM (`#115`, `#116`, `#188`, `#199`, `#213`, `#214`, `#272`). */
export const enWaveF7aMessages = {
  // #116, #188, #199, #214 Display AFR & HDR
  'settings.playback.autoFrameRateTitle': 'Match frame rate',
  'settings.playback.autoFrameRateDescription':
    'Switch display refresh rate to match video frame rate for smoother motion.',
  'settings.playback.autoFrameRateOff': 'Off',
  'settings.playback.autoFrameRateSeamless': 'Seamless only',
  'settings.playback.autoFrameRateAlways': 'Always',
  'settings.playback.autoDynamicRangeTitle': 'Match dynamic range',
  'settings.playback.autoDynamicRangeDescription':
    'Automatically switch display output between SDR, HDR10, HLG, and Dolby Vision.',

  // #115 Night-Mode DRC & Per-Refresh-Rate Audio Delay
  'settings.playback.nightModeDrcTitle': 'Night mode (dynamic range)',
  'settings.playback.nightModeDrcDescription':
    'Compress loud sound effects and boost quiet dialogue for late-night viewing.',
  'settings.playback.nightModeDrcOff': 'Off',
  'settings.playback.nightModeDrcLight': 'Light',
  'settings.playback.nightModeDrcNight': 'Night',
  'settings.playback.refreshRateAudioDelayTitle': 'Per-refresh-rate audio delay',
  'settings.playback.refreshRateAudioDelayDescription':
    'Apply fine audio sync offsets automatically for each display refresh rate.',

  // #213 Desktop Audio Passthrough & Channel Layout
  'settings.desktop.audioPassthroughTitle': 'Audio passthrough (bitstream)',
  'settings.desktop.audioPassthroughDescription':
    'Send encoded surround audio directly to an external receiver over HDMI or optical.',
  'settings.desktop.audioPassthroughCodecsTitle': 'Passthrough codecs',
  'settings.desktop.audioExclusiveTitle': 'Exclusive audio device',
  'settings.desktop.audioExclusiveDescription':
    'Request exclusive OS audio output to bypass system mixing during playback.',
  'settings.desktop.audioAc3EncodeTitle': 'Real-time AC-3 encoding',
  'settings.desktop.audioAc3EncodeDescription':
    'Encode multichannel audio to AC-3 for optical S/PDIF receivers.',
  'settings.desktop.audioChannelLayoutTitle': 'Speaker channel layout',
  'settings.desktop.audioChannelLayoutAuto': 'Auto',
  'settings.desktop.audioChannelLayoutStereo': 'Stereo (2.0)',
  'settings.desktop.audioChannelLayout51': '5.1 Surround',
  'settings.desktop.audioChannelLayout71': '7.1 Surround',

  // #213, #272 Player notices & errors
  'player.audio.passthroughFallbackNotice':
    'Audio passthrough unavailable on this device — switched to PCM.',
  'player.error.drmUnsupported': 'Protected stream cannot be played on this device.',
} as const;

/** Message identifiers for Wave F7A AFR/HDR, Desktop Audio Passthrough, Night-Mode DRC & DRM. */
export type WaveF7aMessageId = keyof typeof enWaveF7aMessages;
