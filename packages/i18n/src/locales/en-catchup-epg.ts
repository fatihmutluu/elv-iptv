/** English (source) messages for Wave F3 Catch-Up, Live Time-Shift, Multi-Guide & Reminders (`#27`, `#28`, `#30`, `#35`). */
export const enCatchupEpgMessages = {
  // #27 Catch-Up
  'epg.catchupBadge': 'Catch-up',
  'epg.watchCatchup': 'Watch catch-up',
  'epg.catchupUnavailable': 'Catch-up is not available for this programme.',
  'epg.catchupExpired': 'Catch-up window has expired for this programme.',
  'player.catchupBadge': 'CATCH-UP',
  'player.backToLive': 'Back to live',

  // #28 Live Time-Shift
  'player.livePaused': 'Live paused',
  'player.behindLive': '{offset} behind live',
  'player.timeShiftUnavailable': 'Live rewind is not available for this stream.',
  'player.liveEdge': 'At live edge',

  // #30 Multi-Guide & Channel Mapper
  'sources.guides.button': 'Guides & mapping',
  'sources.guides.title': 'TV guides & channel mapping',
  'sources.guides.subtitle': 'Manage XMLTV guide priority, time offsets, and manual channel links.',
  'sources.guides.guidesTab': 'Guide sources',
  'sources.guides.mapperTab': 'Channel mapper',
  'sources.guides.addGuide': 'Add guide source',
  'sources.guides.namePlaceholder': 'Guide name (e.g. Backup XMLTV)',
  'sources.guides.urlPlaceholder': 'http://example.invalid/epg.xml.gz',
  'sources.guides.offsetLabel': 'Time offset',
  'sources.guides.offsetHours': '{hours}h',
  'sources.guides.priorityUp': 'Move up',
  'sources.guides.priorityDown': 'Move down',
  'sources.guides.remove': 'Remove',
  'sources.guides.empty': 'No additional guide sources configured.',
  'sources.guides.filterAll': 'All channels',
  'sources.guides.filterUnmatched': 'Unmatched',
  'sources.guides.searchPlaceholder': 'Search channels or guide IDs…',
  'sources.guides.unmatchedBadge': 'Unmatched',
  'sources.guides.manualBadge': 'Manual',
  'sources.guides.assignGuide': 'Assign guide channel',
  'sources.guides.clearOverride': 'Reset to automatic',
  'sources.guides.channelOffsetLabel': 'Channel time offset',
  'sources.guides.noGuideChannels': 'No guide channels available. Refresh the guide first.',
  'sources.guides.save': 'Save',
  'sources.guides.cancel': 'Cancel',

  // #35 Programme Reminders
  'epg.remindMe': 'Remind me',
  'epg.cancelReminder': 'Cancel reminder',
  'epg.reminderScheduled': 'Reminder set',
  'epg.reminderLeadLabel': 'Remind before start',
  'epg.reminderBannerTitle': 'Starting soon',
  'epg.reminderStartsIn': 'Starts in {minutes} min',
  'epg.reminderStartingNow': 'Starting now',
  'epg.reminderTuneNow': 'Tune now',
  'epg.reminderDismiss': 'Dismiss',
} as const;

/** Message identifiers for Wave F3 Catch-Up, Live Time-Shift, Multi-Guide & Reminders. */
export type CatchupEpgMessageId = keyof typeof enCatchupEpgMessages;
