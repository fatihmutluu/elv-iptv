/** English (source) messages for Wave F9 E2EE sync, welcome, QR pairing, telemetry & feedback (`#26`, `#458`). */
export const enWaveF9Messages = {
  // Settings tabs
  'settings.section.account': 'Account & Sync',
  'settings.section.feedback': 'Feedback & Telemetry',

  // First-run Welcome Sign In / Create Account screen
  'welcome.title': 'Sync Across Every Screen',
  'welcome.subtitle':
    'Sign in to keep your playlists, favorites, and watch progress end-to-end encrypted across TV, mobile, and desktop.',
  'welcome.tabSignIn': 'Sign In',
  'welcome.tabCreateAccount': 'Create Account',
  'welcome.tabPairQr': 'Pair via QR',
  'welcome.continueWithoutAccount': 'Continue without account',
  'welcome.localOnlyNote':
    'All playback and playlist features work 100% locally without an account.',

  // Auth & Account form/panel
  'account.title': 'Sync Account',
  'account.subtitle':
    'Zero-knowledge end-to-end encrypted sync. Provider credentials never leave your devices unencrypted.',
  'account.emailLabel': 'Email',
  'account.emailPlaceholder': 'you@example.com',
  'account.passwordLabel': 'Password',
  'account.passwordPlaceholder': 'At least 10 characters',
  'account.confirmPasswordLabel': 'Confirm password',
  'account.confirmPasswordPlaceholder': 'Re-enter password',
  'account.signInAction': 'Sign In',
  'account.createAccountAction': 'Create Account',
  'account.signOutAction': 'Sign Out',
  'account.syncNowAction': 'Sync Now',
  'account.syncingStatus': 'Syncing encrypted vault...',
  'account.syncedStatus': 'Encrypted vault up to date',
  'account.signedInAs': 'Signed in as',
  'account.serverUrlLabel': 'Sync server URL (optional)',
  'account.oauthComingSoon':
    'Sign in with your email and password, or pair this device with a QR code.',
  'account.recoveryTitle': 'Save Your Recovery Code',
  'account.recoveryBody':
    'Store this recovery code offline. Because sync is end-to-end encrypted, we cannot reset your vault key without it.',
  'account.recoverySavedAction': 'I Saved My Recovery Code',
  'account.qrTitle': 'Pair Another Device via QR',
  'account.qrBody':
    'Scan this QR code from a signed-in ELV IPTV app on your phone, tablet, or desktop to sign in automatically.',
  'account.qrGenerateAction': 'Show Pairing QR',
  'account.qrClaimTitle': 'Approve Device Pairing',
  'account.qrClaimInputLabel': 'Pairing code or QR link',
  'account.qrClaimAction': 'Approve Pairing',
  'account.qrClaimSignInFirst': 'Sign in or create an account first to finish pairing this device.',
  'account.qrClaimSuccess': 'Device paired securely.',
  'account.qrExpired': 'Pairing code expired. Generate a new code.',
  'account.deleteTitle': 'Delete Account Permanently',
  'account.deleteBody':
    'Permanently erases your sync account, encrypted vault, and active sessions from the server. Local playlists on this device stay untouched.',
  'account.deleteAction': 'Delete Account Permanently',
  'account.deleteConfirmAction': 'Confirm Permanent Deletion',
  'account.deleteCancelAction': 'Cancel',
  'account.deleteSuccess': 'Your account has been permanently deleted.',
  'account.errorInvalidEmail': 'Enter a valid email address.',
  'account.errorWeakPassword': 'Password must be at least 10 characters.',
  'account.errorPasswordMismatch': 'Passwords do not match.',
  'account.errorGeneric': 'Sync request failed. Check your connection and try again.',

  // Telemetry & Feedback panel
  'telemetry.title': 'Opt-In Runtime Telemetry',
  'telemetry.subtitle':
    'Help improve startup speed, smoothness, and playback codec compatibility. Strictly opt-in; never collects URLs, credentials, or watched titles.',
  'telemetry.optInLabel': 'Share anonymous performance & codec diagnostics',
  'telemetry.previewAction': 'Preview JSON Payload',
  'telemetry.hidePreviewAction': 'Hide Preview',
  'telemetry.queuedLabel': 'Queued events',
  'feedback.title': 'Feedback & Report Issue',
  'feedback.subtitle':
    'Report a playback bug, EPG mismatch, or suggest an improvement directly to the ELV IPTV team.',
  'feedback.categoryLabel': 'Category',
  'feedback.catPlayback': 'Playback Issue',
  'feedback.catChannelEpg': 'Channel / EPG',
  'feedback.catUiRemote': 'UI & Remote',
  'feedback.catSyncAccount': 'Sync & Account',
  'feedback.catFeature': 'Feature Request',
  'feedback.catOther': 'Other',
  'feedback.messageLabel': 'Details',
  'feedback.messagePlaceholder': 'Describe what happened or what we can improve...',
  'feedback.attachDiagnosticsLabel': 'Attach redacted device & codec diagnostics',
  'feedback.submitAction': 'Send Feedback',
  'feedback.sendingStatus': 'Sending feedback...',
  'feedback.sentSuccess': 'Thank you! Your feedback has been received.',
  'feedback.errorEmpty': 'Please write a brief description before sending.',
  'feedback.errorFailed': 'Could not send feedback right now. Please try again later.',
} as const;

/** Message identifiers for Wave F9 E2EE sync, welcome, QR pairing, telemetry & feedback. */
export type WaveF9MessageId = keyof typeof enWaveF9Messages;
