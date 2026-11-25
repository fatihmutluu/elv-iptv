/** English (source) messages for Wave F7B external display, multi-program TS, external player & crash diagnostics (`#258`, `#304`, `#406`, `#226`). */
export const enWaveF7bMessages = {
  // #258 External display
  'player.externalDisplay.title': 'Playing on external display',
  'player.externalDisplay.subtitle': 'Video is routed to your connected TV or monitor.',
  'player.externalDisplay.hint': 'Use the controls below to pause, seek, or switch tracks.',

  // #304 Multi-program MPEG-TS
  'player.tracks.program': 'Program',
  'player.tracks.programNumber': 'Program {number}',

  // #406 External player
  'settings.playback.externalPlayerTitle': 'External player',
  'settings.playback.externalPlayerHint':
    'Hand off stream playback to another installed media player app.',
  'settings.playback.externalPlayerOff': 'Off',
  'settings.playback.externalPlayerAsk': 'Ask every time',
  'settings.playback.externalPlayerAlways': 'Always',
  'settings.playback.externalPlayerSchemeLabel': 'Custom player URL scheme (optional)',
  'settings.playback.externalPlayerSchemePlaceholder': 'e.g. myplayer',
  'player.externalPrompt.title': 'Open stream with',
  'player.externalPrompt.subtitle':
    'Choose whether to play inside ELV IPTV or hand off to an external player.',
  'player.externalPrompt.integrated': 'Built-in player',
  'player.externalPrompt.external': 'External player',
  'player.externalPrompt.cancel': 'Cancel',
  'player.externalHandoff.failed': 'Could not open the external player on this device.',

  // #226 Crash diagnostics
  'settings.diagnostics.title': 'Crash diagnostics',
  'settings.diagnostics.optInLabel': 'Enable diagnostic crash reports',
  'settings.diagnostics.optInHint':
    'Generate redacted Markdown reports locally when an unexpected error occurs.',
  'settings.diagnostics.includeLogsLabel': 'Include recent redacted logs',
  'settings.diagnostics.includeLogsHint':
    'Attach up to 250 recent redacted log lines when preparing a report.',
  'settings.diagnostics.previewAction': 'Preview diagnostic report',
  'crash.diagnosticsAction': 'View diagnostics',
  'crash.report.title': 'Diagnostic report',
  'crash.report.subtitle':
    'Credentials, stream URLs, and home paths are redacted before display or export.',
  'crash.report.includeLogsToggle': 'Include recent logs',
  'crash.report.copy': 'Copy report',
  'crash.report.copied': 'Copied to clipboard',
  'crash.report.export': 'Export Markdown',
  'crash.report.exported': 'Report exported',
  'crash.report.close': 'Close',
  'crash.report.emptyLogs': 'No recent diagnostic logs captured.',
} as const;

/** Message identifiers for Wave F7B external display, multi-program TS, external player & crash diagnostics. */
export type WaveF7bMessageId = keyof typeof enWaveF7bMessages;
