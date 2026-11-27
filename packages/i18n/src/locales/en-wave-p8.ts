/** English (source) messages for Wave P8 VOD Seek Bar, Live Stage, Folder Collections & ELV Picks. */
export const enWaveP8Messages = {
  'library.collections.create': 'Create collection',
  'library.collections.createTitle': 'New collection',
  'library.collections.rename': 'Rename',
  'library.collections.renameTitle': 'Rename collection',
  'library.collections.delete': 'Delete collection',
  'library.collections.deleteConfirmTitle': 'Delete collection?',
  'library.collections.deleteConfirmBody':
    'Items stay in My List and return to your general Movies and Series rows.',
  'library.collections.emptySection':
    'Empty collection — move items here from the menu or drag them in.',
  'library.collections.moveTo': 'Move to collection',
  'library.collections.moveToNamed': 'Move to {name}',
  'library.collections.removeFrom': 'Remove from collection',
  'library.collections.dropHere': 'Drop to move here',
  'library.collections.namePlaceholder': 'Collection name',
  'catalog.filter.elvPicks': 'ELV Picks',
  'live.stage.fullscreen': 'Fullscreen',
  'live.stage.doubleClickHint': 'Double-click video for fullscreen',
  'live.zap.favoriteAdd': 'Add to Favorites',
  'live.zap.favoriteRemove': 'Remove from Favorites',
} as const;

/** Message identifiers for Wave P8. */
export type WaveP8MessageId = keyof typeof enWaveP8Messages;
