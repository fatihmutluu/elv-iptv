/** English (source) messages for Wave P7 Settings simplification, Kids Mode, Profiles & Sources Advanced. */
export const enWaveP7Messages = {
  'parental.modeDescription':
    'Keep younger viewers safe with PIN-protected category locks, age limits, and automatic adult keyword filtering.',
  'profiles.whoIsWatching': "Who's Watching?",
  'profiles.addNew': 'Add profile',
  'profiles.chooseTypeTitle': 'Choose profile type',
  'profiles.typeAdultTitle': 'Standard profile',
  'profiles.typeAdultDesc':
    'Full catalog access with personal favorites, watch history, and settings.',
  'profiles.typeKidsTitle': 'Kids profile',
  'profiles.typeKidsDesc':
    'Child-safe experience with Kids Mode, age limits, and keyword filtering enabled by default.',
  'profiles.editProfileTitle': 'Edit profile',
  'profiles.kidsToggleLabel': 'Kids Mode',
  'profiles.pinManageLabel': 'Manage PIN',
  'profiles.setPinOnCreate': 'Set a PIN for this profile',
  'profiles.deleteProfileAction': 'Delete profile',
  'profiles.continueAction': 'Continue',
  'profiles.cancelAction': 'Cancel',
  'settings.dropdown.selectHint': 'Select an option',
  'settings.artworkCacheUsage': '{usedMb} MB of {limitMb} MB used',
  'settings.playback.advancedAudioTitle': 'Advanced audio',
  'settings.playback.advancedAudioDescription':
    'Output device, channel layout, exclusive mode, and bitstream passthrough.',
  'settings.liveTv.refreshNow': 'Refresh now',
  'settings.liveTv.refreshing': 'Refreshing…',
  'settings.liveTv.refreshed': 'Refreshed',
  'sources.action.refreshShort': 'Refresh',
  'sources.action.removeShort': 'Remove',
  'sources.action.advanced': 'Advanced',
  'sources.advanced.title': 'Source settings',
  'sources.advanced.rename': 'Rename source',
  'sources.advanced.renamePlaceholder': 'Enter source name',
  'sources.advanced.renameSave': 'Save name',
  'sources.advanced.sharedProfiles': 'Shared with profiles',
  'sources.advanced.sharedProfilesHint':
    'Choose which profiles can view channels and catalog items from this source.',
  'sources.advanced.allProfilesShared': 'Shared with all profiles',
} as const;

/** Message identifiers for Wave P7. */
export type WaveP7MessageId = keyof typeof enWaveP7Messages;
