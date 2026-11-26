/** English (source) messages for Wave P5 offline VOD downloads & cross-media Multi-View. */
export const enWaveP5Messages = {
  'nav.downloads': 'Downloads',
  'downloads.title': 'Downloads',
  'downloads.activeSection': 'In progress',
  'downloads.completedSection': 'Ready to watch offline',
  'downloads.emptyTitle': 'No downloads yet',
  'downloads.emptyBody':
    'Download movies or series episodes from their detail page to watch offline or alongside Live TV in Multi-View.',
  'downloads.unsupportedTitle': 'Downloads unavailable on this device',
  'downloads.unsupportedBody':
    'Offline movie and episode downloads are currently supported on Desktop.',
  'downloads.actionDownload': 'Download',
  'downloads.actionDownloading': 'Downloading {percent}%',
  'downloads.actionDownloaded': 'Downloaded',
  'downloads.actionPause': 'Pause download',
  'downloads.actionResume': 'Resume download',
  'downloads.actionCancel': 'Cancel download',
  'downloads.actionDelete': 'Delete download',
  'downloads.actionPlayOffline': 'Play offline',
  'downloads.statusQueued': 'Queued',
  'downloads.statusDownloading': 'Downloading',
  'downloads.statusPaused': 'Paused',
  'downloads.statusPausedForPlayback': 'Paused while streaming',
  'downloads.statusFailed': 'Download failed',
  'downloads.statusCompleted': 'Offline',
  'downloads.offlineBadge': 'Offline',
  'downloads.storageUsed': '{size} saved offline',
  'context.download': 'Download for offline',
  'context.deleteDownload': 'Delete download',
  'multiview.picker.title': 'Choose stream',
  'multiview.picker.tabLive': 'Live TV',
  'multiview.picker.tabMovies': 'Movies',
  'multiview.picker.tabSeries': 'Series',
  'multiview.picker.tabDownloads': 'Downloads',
  'multiview.picker.downloadsHint': 'Offline downloads use zero provider connections.',
  'multiview.picker.emptyDownloads': 'No completed downloads yet.',
  'multiview.picker.emptyMovies': 'No movies available.',
  'multiview.picker.emptySeries': 'No series episodes available.',
} as const;

/** Message identifiers for Wave P5. */
export type WaveP5MessageId = keyof typeof enWaveP5Messages;
