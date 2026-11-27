/** English (source) messages for Wave E3 Smart Onboarding, Live ELV Mode Preview & Returning-User Startup (`#513`). */
export const enWaveE3Messages = {
  // Shared Interactive ELV Mode Preview
  'elv.preview.badgeClean': 'ELV Mode Active',
  'elv.preview.badgeRaw': 'Raw IPTV Feed',
  'elv.preview.captionAllOn':
    'Smart categories, personalized movie & series picks, clean posters, and merged copies.',
  'elv.preview.captionChaos':
    'Toggle ELV Mode features on to tame duplicates, broken art, and messy folders.',
  'elv.preview.genre.scifi': 'Sci-Fi',
  'elv.preview.genre.drama': 'Drama',
  'elv.preview.genre.thriller': 'Thriller',
  'elv.preview.genre.mystery': 'Mystery',
  'elv.preview.rawCat1': '### === VIP VOD 2026 === ###',
  'elv.preview.rawCat2': '*** 4K_NEW_MIX_2025 ***',
  'elv.preview.rawCat3': 'HD | MOVIES | BACKUP 2',
  'elv.preview.film1.title': 'Velvet Meridian',
  'elv.preview.film2.title': 'Solar Drift',
  'elv.preview.film3.title': 'Glass Harbor',
  'elv.preview.film4.title': 'Cinder Waltz',
  'elv.preview.rawNoPoster': 'NO_IMG_404.jpg',
  'elv.preview.rawNoRating': '???',
  'elv.preview.duplicateTag': '4x duplicates',

  // Onboarding Screen 1 — Smart Welcome & Auth
  'onboarding.welcome.title': 'Welcome to ELV IPTV',
  'onboarding.welcome.subtitle':
    'Sign in to sync your encrypted library across every screen, or start locally right away.',
  'onboarding.welcome.emailOption': 'Continue with email',
  'onboarding.welcome.emailContinue': 'Continue',
  'onboarding.welcome.checkingEmail': 'Checking account…',
  'onboarding.welcome.existingAccountHint':
    'Welcome back — enter your password to unlock your encrypted vault.',
  'onboarding.welcome.notFoundPrompt':
    'No account found for this email — would you like to create one?',
  'onboarding.welcome.createWithEmailAction': 'Create account with this email',
  'onboarding.welcome.backToEmail': 'Use a different email',
  'onboarding.welcome.guestAction': 'Continue without account',
  'onboarding.welcome.transferAction': 'Transfer from another device',
  'onboarding.welcome.privacyStripPrefix': 'By continuing, you agree to our',
  'onboarding.welcome.privacyPolicyLink': 'Privacy Policy',
  'onboarding.welcome.diagnosticsLabel': 'Share anonymous playback & crash diagnostics',

  // Privacy Policy Modal
  'onboarding.privacy.title': 'Privacy & Data Notice',
  'onboarding.privacy.summary':
    'ELV IPTV is designed for privacy first. Your playlists, provider credentials, and watch history stay encrypted and under your control.',
  'onboarding.privacy.sectionDataTitle': 'Zero-Knowledge Sync & Local Storage',
  'onboarding.privacy.sectionDataBody':
    'Without an account, all playlists and credentials remain strictly on your device. If you sign in, sync data is encrypted end-to-end on your device before upload — we can never read your URLs, passwords, or viewing history.',
  'onboarding.privacy.sectionDiagnosticsTitle': 'Optional Anonymous Diagnostics',
  'onboarding.privacy.sectionDiagnosticsBody':
    'When enabled, anonymous performance metrics and codec error codes help improve playback stability. Provider URLs, credentials, IP addresses, and media titles are never collected. You can change this anytime in Settings.',
  'onboarding.privacy.sectionRightsTitle': 'Your Rights (KVKK & GDPR)',
  'onboarding.privacy.sectionRightsBody':
    'You may review or permanently erase your sync account and encrypted vault at any time from Settings > Account & Sync.',
  'onboarding.privacy.close': 'Close',

  // Onboarding Syncing Step
  'onboarding.syncing.title': 'Syncing your data…',
  'onboarding.syncing.subtitle': 'Downloading your encrypted vault and preferences.',
  'onboarding.syncing.stageAccount': 'Syncing account & profiles',
  'onboarding.syncing.stageSources': 'Loading sources & catalog',
  'onboarding.syncing.stagePreparing': 'Preparing ELV Mode & home screen',
  'onboarding.syncing.sourceCounter': 'Source {index} of {total}: {name}',
  'onboarding.syncing.itemsProgress': '{count} items loaded',
  'onboarding.syncing.failedTitle': 'Some sources could not finish loading',
  'onboarding.syncing.failedBody':
    'Your account synced cleanly. Retry now or continue into the app and finish loading later.',
  'onboarding.syncing.retryAction': 'Retry',
  'onboarding.syncing.continueAction': 'Continue to App',

  // Onboarding Screen 2 — Add First Source
  'onboarding.source.title': 'Add Your First Source',
  'onboarding.source.subtitle':
    'Bring your own M3U playlist, Xtream Codes account, or Stalker portal. ELV IPTV ships no content.',
  'onboarding.source.continueAction': 'Add & Continue',
  'onboarding.source.browseWithoutSource': 'Browse without a source for now',
  'onboarding.source.pairPhoneAction': 'Send playlist from your phone',

  // Onboarding Screen 3 — ELV Mode
  'onboarding.elv.title': 'Meet ELV Mode',
  'onboarding.elv.subtitle':
    'Organize messy playlists into smart categories, get personalized movie and series recommendations, clean up posters and ratings, and merge duplicate copies.',
  'onboarding.elv.masterToggle': 'ELV Mode',
  'onboarding.elv.mergeToggle': 'Merge movie & series versions',
  'onboarding.elv.postersToggle': 'Enhance posters & ratings',
  'onboarding.elv.categoriesToggle': 'Smart category organization',
  'onboarding.elv.recommendationsToggle': 'Personalized movie & series recommendations',

  // Onboarding Top Import Bar & Dynamic CTA
  'onboarding.import.loading': 'Importing your library…',
  'onboarding.import.ready': 'Your library is ready!',
  'onboarding.import.failed': 'Could not import your source.',
  'onboarding.import.providerWaitHint':
    'Waiting on your provider — this is not on our end. Feel free to keep personalizing while it finishes.',
  'onboarding.import.continueAction': 'Continue',
  'onboarding.import.enterAppAction': 'Enter App',
  'onboarding.import.continueCustomizing': 'Continue customizing',
  'onboarding.import.retryAction': 'Retry',
  'onboarding.import.editSourceAction': 'Edit source details',

  // Onboarding Personalization Cards 1–4
  'onboarding.personalize.stepCounter': 'Step {step} of {total}',
  'onboarding.personalize.profileTitle': 'Make Your Profile Yours',
  'onboarding.personalize.profileSubtitle':
    'Pick a name and avatar for this viewer profile. You can add more profiles anytime.',
  'onboarding.personalize.profileNameLabel': 'Profile name',
  'onboarding.personalize.avatarLabel': 'Avatar',
  'onboarding.personalize.themeTitle': 'Choose Your Cinema Palette',
  'onboarding.personalize.themeSubtitle':
    'Crafted for dark rooms and crisp readability across every display.',
  'onboarding.personalize.layoutTitle': 'Home Screen Layout',
  'onboarding.personalize.layoutSubtitle': 'Choose how your home rows and spotlight are arranged.',
  'onboarding.personalize.layoutPreviewLabel': 'Live layout preview',
  'onboarding.personalize.tipsTitle': 'Quick Tips for Your Screen',
  'onboarding.personalize.tipsSubtitle':
    'A couple of handy shortcuts to get the most out of ELV IPTV.',
  'onboarding.personalize.tipDesktop1':
    'Use Space to pause, F for fullscreen, and arrow keys to scrub or jump between rows.',
  'onboarding.personalize.tipDesktop2':
    'Right-click any channel or title for quick favorites, version switching, and audio or subtitle options.',
  'onboarding.personalize.tipMobile1':
    'Swipe up or down on the left side for brightness and the right side for volume during playback.',
  'onboarding.personalize.tipMobile2':
    'Long-press the video for 2× speed, or slide up while scrubbing for frame-accurate control.',
  'onboarding.personalize.tipTv1':
    'Press OK twice on a live channel for fullscreen, and use CH+/CH- or number keys to zap instantly.',
  'onboarding.personalize.tipTv2':
    'Long-press OK on any channel or movie card for quick options, and press Back to return smoothly.',

  // Onboarding Centered Waiting Stage & Returning-User Startup Refresh
  'onboarding.waiting.title': 'Finishing Your Library Import',
  'onboarding.waiting.subtitle':
    'Your setup is saved. We will open your screening room the moment your provider finishes responding.',
  'startup.refresh.title': 'Refreshing Your Library',
  'startup.refresh.subtitle':
    'Checking your sources for the latest channels, movies, series, and TV guide.',
  'startup.refresh.cancelContinue': 'Cancel / Continue with old data',
  'startup.refresh.backgroundNote': 'Refresh will continue quietly in the background.',

  // Original Evening & Cinema Quotes
  'onboarding.quote.1': 'Dim the lights — great stories deserve a quiet room and a crisp picture.',
  'onboarding.quote.2': 'Every memorable evening begins with the right film and zero distractions.',
  'onboarding.quote.3':
    'Cinema is at its best when the player steps back and lets the frame breathe.',
  'onboarding.quote.4':
    'Take a breath, settle in, and let tonight bring a story worth staying up for.',
  'onboarding.quote.5':
    'Your library, your pace — curated cleanly so you spend less time scrolling and more time watching.',
  'onboarding.quote.6':
    'The best seat in the theater is always the one waiting right in your living room.',
} as const;
