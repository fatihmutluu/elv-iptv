/** English (source) messages for Wave Q3 Series Detail UX Overhaul. */
export const enWaveQ3Messages = {
  'detail.scopePicker.watchedAction': 'Watched options',
  'detail.scopePicker.watchedTitle': 'Mark watched',
  'detail.scopePicker.downloadAction': 'Download options',
  'detail.scopePicker.downloadActionActive': 'Downloading ({count})',
  'detail.scopePicker.downloadActionCompleted': '{count} downloaded',
  'detail.scopePicker.downloadTitle': 'Download episodes',
  'detail.scopePicker.entireSeries': 'Entire series',
  'detail.scopePicker.season': 'Season',
  'detail.scopePicker.chooseSeason': 'Choose season',
  'detail.scopePicker.markEntireSeriesWatched': 'Mark entire series watched',
  'detail.scopePicker.markEntireSeriesUnwatched': 'Mark entire series unwatched',
  'detail.scopePicker.markSeasonWatched': 'Mark Season {season} watched',
  'detail.scopePicker.markSeasonUnwatched': 'Mark Season {season} unwatched',
  'detail.scopePicker.downloadEntireSeries': 'Download entire series',
  'detail.scopePicker.downloadSeason': 'Download Season {season}',
  'detail.scopePicker.seasonEpisodesCount': '{count} episodes',
} as const;

/** Message identifiers for Wave Q3 Series Detail UX Overhaul. */
export type WaveQ3MessageId = keyof typeof enWaveQ3Messages;
