/** English (source) messages for Wave F6 PiP, Multi-View, Mini-Player & Desktop Tray/Popout (`#34`, `#158`, `#221`, `#232`, `#233`). */
export const enWaveF6Messages = {
  // #34 OS Picture-in-Picture
  'player.pip.enter': 'Picture-in-Picture',
  'player.pip.unsupported': 'Picture-in-Picture is unavailable for this stream',
  'settings.playback.autoEnterPipTitle': 'Auto-enter Picture-in-Picture',
  'settings.playback.autoEnterPipDescription':
    'Keep video playing in a floating window when leaving the app.',

  // #233 Floating Corner Mini-Player
  'player.miniPlayer.minimize': 'Minimize player',
  'player.miniPlayer.expand': 'Expand player',
  'player.miniPlayer.close': 'Close mini-player',
  'player.miniPlayer.activeLabel': 'Mini-player active',

  // #34, #221, #232 Multi-View Grid + Connection & Thermal Clamps
  'player.multiView.title': 'Multi-View',
  'player.multiView.enter': 'Multi-View',
  'player.multiView.exit': 'Exit Multi-View',
  'player.multiView.addChannel': 'Add channel',
  'player.multiView.replaceChannel': 'Replace channel',
  'player.multiView.removeTile': 'Remove screen',
  'player.multiView.swapAudio': 'Switch audio here',
  'player.multiView.activeAudio': 'Audio active',
  'player.multiView.muted': 'Muted',
  'player.multiView.emptySlot': 'Add channel',
  'player.multiView.tileCount': '{count, plural, one {# screen} other {# screens}}',
  'player.multiView.connectionLimitTitle': 'Connection limit reached',
  'player.multiView.connectionLimitBody':
    'This source allows {active} / {max} active connections. Pick a channel from another source or close an open screen.',
  'player.multiView.thermalSerious': 'Device is warm — adding more screens is temporarily paused.',
  'player.multiView.thermalCriticalShed':
    'Device overheated — secondary screens were closed to protect playback.',
  'player.multiView.lowRamUnsupported': 'Multi-View is unavailable on this low-memory device.',
  'player.multiView.deviceCapReached': 'This device supports up to {max} simultaneous screens.',

  // #158 Desktop Popout Player Window & System Tray
  'player.popout.open': 'Pop out player',
  'player.popout.dock': 'Return to main window',
  'player.popout.pin': 'Always on top',
  'player.popout.unpin': 'Unpin window',
  'player.popout.close': 'Close popout',
  'settings.desktop.minimizeToTrayTitle': 'Minimize to system tray',
  'settings.desktop.minimizeToTrayDescription':
    'Keep the app running in the system tray when closing the main window.',
  'desktop.tray.restore': 'Restore ELV IPTV',
  'desktop.tray.quit': 'Quit',
} as const;

/** Message identifiers for Wave F6 PiP, Multi-View, Mini-Player & Desktop Tray/Popout. */
export type WaveF6MessageId = keyof typeof enWaveF6Messages;
