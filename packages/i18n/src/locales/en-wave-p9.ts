/** English (source) messages for Wave P9 unified diagnostics, auto-sync, and bidirectional X25519 pairing (`#509`, `#510`). */
export const enWaveP9Messages = {
  // Unified Diagnostics & Privacy Consent ([1.6])
  'settings.diagnostics.unifiedTitle': 'Diagnostics & performance',
  'settings.diagnostics.unifiedToggle': 'Share anonymous diagnostics & performance data',
  'settings.diagnostics.unifiedDescription':
    'Helps us catch crashes, slow loads, and playback errors faster. Zero playlists, watch history, or personal info are ever sent.',
  'privacy.consent.title': 'Privacy & Diagnostics',
  'privacy.consent.body':
    'ELV IPTV keeps your playlists and watch history private on your device (or end-to-end encrypted when you sign in). You can optionally share anonymous crash and performance metrics to help improve stability.',
  'privacy.consent.telemetryToggle': 'Help improve ELV IPTV with anonymous diagnostics',
  'privacy.consent.continue': 'Continue',

  // Automatic E2EE Sync ([1.44])
  'account.sync.autoBadge': 'Automatic sync active',
  'account.sync.statusSyncing': 'Syncing encrypted vault…',
  'account.sync.statusUpToDate': 'All devices up to date',
  'account.sync.statusPending': 'Changes queued for sync',
  'account.sync.statusOffline': 'Offline — will sync automatically when connected',
  'account.sync.lastSynced': 'Last synced: {time}',
  'account.sync.manualFallback': 'Sync now',

  // Bidirectional Single-QR + 8-Digit X25519 Pairing ([1.45])
  'pair.title': 'Pair another device',
  'pair.subtitle':
    'Scan this QR code or enter the 8-digit code on your other device. Account direction is detected automatically.',
  'pair.codeLabel': '8-digit pairing code',
  'pair.enterCodeLabel': 'Or enter a code from another device',
  'pair.enterCodePlaceholder': '0000 0000',
  'pair.connectButton': 'Connect',
  'pair.scanQrButton': 'Scan QR code',
  'pair.cameraUnavailable':
    'Camera scanning is unavailable on this device — enter the 8-digit code instead.',
  'pair.sasTitle': 'Verify security code',
  'pair.sasBody':
    'Confirm both devices show the same 4-digit security code before transferring your encrypted account:',
  'pair.sasConfirm': 'Codes match — confirm',
  'pair.sasCancel': 'Cancel',
  'pair.caseNeitherTitle': 'Sign in on one device first',
  'pair.caseNeitherBody':
    'Neither device is signed in yet. Sign in or create an account on either device, then pair again.',
  'pair.caseSameAccountTitle': 'Already on the same account',
  'pair.caseSameAccountBody':
    'Both devices are signed in to {email}. Triggering an immediate sync now.',
  'pair.caseTransferToOther': 'Sign in the other device as {email}?',
  'pair.caseReceiveFromOther': 'Sign in this device as {email}?',
  'pair.caseDifferentTitle': 'Two different accounts detected',
  'pair.caseDifferentBody':
    'Choose which account both devices should use. The replaced device will switch to the selected account.',
  'pair.useThisAccount': "Keep this device's account ({email})",
  'pair.useOtherAccount': "Switch to other device's account ({email})",
  'pair.waitingApproval': 'Waiting for confirmation on the other device…',
  'pair.success': 'Devices paired and synced!',
  'pair.errorExpired': 'Pairing code expired. Generate a new code to try again.',
  'pair.errorLocked': 'Too many failed attempts. Code locked for security — generate a new one.',
  'pair.errorInvalidCode': 'Enter a valid 8-digit pairing code.',
  'pair.errorRejected': 'Pairing was cancelled on the other device.',
} as const;

/** Message identifiers for Wave P9 unified diagnostics, auto-sync, and bidirectional X25519 pairing. */
export type WaveP9MessageId = keyof typeof enWaveP9Messages;
