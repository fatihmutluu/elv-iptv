/** English (source) messages for Wave F5B Stalker Portals, VOD Enrichment & Collections (`#29`, `#215`, `#403`). */
export const enWaveF5bMessages = {
  // #29 Stalker / Ministra MAC Portals
  'sources.mode.stalker': 'Stalker / MAC',
  'sources.stalker.portalUrlLabel': 'Portal URL',
  'sources.stalker.portalUrlPlaceholder': 'http://portal.example.test/c/',
  'sources.stalker.macLabel': 'MAC address',
  'sources.stalker.macPlaceholder': '00:1A:79:00:00:01',
  'sources.stalker.serialLabel': 'Serial number (optional)',
  'sources.stalker.serialPlaceholder': 'Optional device serial',
  'sources.stalker.invalidMac': 'Enter a valid MAC address.',
  'sources.stalker.invalidMacHint': 'Use 6 hex pairs separated by colons, e.g. 00:1A:79:00:00:01.',
  'sources.stalker.kindBadge': 'Stalker',

  // #215 Key-Free VOD Enrichment
  'settings.appearance.vodEnrichmentTitle': 'Enrich movie & series details',
  'settings.appearance.vodEnrichmentDescription':
    'Fill missing ratings, release years, and genres locally without an API key.',
  'detail.enrichment.badge': 'Enriched',
  'detail.enrichment.ratingLabel': 'Rating',
  'detail.enrichment.genresLabel': 'Genres',

  // #403 Custom VOD Collections
  'collections.title': 'Collections',
  'collections.subtitle': 'Organize movies and series into personal playlists.',
  'collections.empty': 'No collections yet. Create one to group your favorite movies and series.',
  'collections.addToCollection': 'Add to collection',
  'collections.inCollections': 'In collections',
  'collections.manageTitle': 'Manage collections',
  'collections.createPlaceholder': 'New collection name',
  'collections.createAction': 'Create',
  'collections.rename': 'Rename',
  'collections.save': 'Save',
  'collections.cancel': 'Cancel',
  'collections.delete': 'Delete',
  'collections.moveUp': 'Move up',
  'collections.moveDown': 'Move down',
  'collections.removeItem': 'Remove from collection',
  'collections.itemCount': '{count, plural, one {# title} other {# titles}}',
  'collections.saved': 'Collection updated',
  'collections.close': 'Close',
  'collections.emptyCollection': 'No titles in this collection yet.',
  'collections.viewAll': 'View all',
} as const;

/** Message identifiers for Wave F5B Stalker Portals, VOD Enrichment & Collections. */
export type WaveF5bMessageId = keyof typeof enWaveF5bMessages;
