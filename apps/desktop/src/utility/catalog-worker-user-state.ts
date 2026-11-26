import type { CatalogService } from '@elv/data';
import { elvError, err } from '@elv/domain';
import type { CatalogRpcMethodCall } from '../shared/catalog-ipc.ts';

/** Subset of {@link CatalogRpcMethodCall} for watch progress, favorites, track preferences, and recent channels. */
export type CatalogUserStateRpcCall = Extract<
  CatalogRpcMethodCall,
  {
    method:
      | 'saveProgress'
      | 'setWatched'
      | 'getProgress'
      | 'listContinueWatching'
      | 'listWatched'
      | 'listProgressByKeys'
      | 'listSeriesUnplayedCounts'
      | 'clearProgress'
      | 'toggleFavorite'
      | 'setFavorite'
      | 'reorderFavorites'
      | 'listFavorites'
      | 'listFavoriteKeys'
      | 'listMyListNewEpisodes'
      | 'dismissMyListNewEpisode'
      | 'refreshMyListNewEpisodes'
      | 'getTrackPreference'
      | 'saveTrackPreference'
      | 'clearTrackPreference'
      | 'recordRecentChannel'
      | 'listRecentChannels'
      | 'setRating'
      | 'getRating'
      | 'listRatings'
      | 'listRatingMap';
  }
>;

/** Dispatches user-state RPC calls to {@link CatalogService}. */
export async function executeUserStateRpcCall(
  service: CatalogService,
  call: CatalogUserStateRpcCall,
  sanitizeDisplayText: (text: string) => string,
): Promise<unknown> {
  switch (call.method) {
    case 'saveProgress':
      return service.saveProgress
        ? service.saveProgress({
            ...call.input,
            title: sanitizeDisplayText(call.input.title),
            ...(typeof call.input.subtitle === 'string'
              ? { subtitle: sanitizeDisplayText(call.input.subtitle) }
              : {}),
          })
        : err(elvError('storage', 'unsupported'));
    case 'setWatched':
      return service.setWatched
        ? service.setWatched(call.itemKey, call.watched, call.profileId)
        : err(elvError('storage', 'unsupported'));
    case 'getProgress':
      return service.getProgress ? service.getProgress(call.itemKey, call.profileId) : null;
    case 'listContinueWatching':
      return service.listContinueWatching
        ? service.listContinueWatching(call.limit, call.profileId, call.opts)
        : [];
    case 'listWatched':
      return service.listWatched ? service.listWatched(call.limit, call.profileId, call.opts) : [];
    case 'listProgressByKeys':
      return service.listProgressByKeys
        ? service.listProgressByKeys(call.itemKeys, call.profileId)
        : [];
    case 'listSeriesUnplayedCounts':
      return service.listSeriesUnplayedCounts
        ? service.listSeriesUnplayedCounts(call.seriesKeys, call.profileId)
        : [];
    case 'clearProgress':
      return service.clearProgress
        ? service.clearProgress(call.itemKey, call.profileId)
        : err(elvError('storage', 'unsupported'));
    case 'toggleFavorite':
      return service.toggleFavorite
        ? service.toggleFavorite({
            ...call.input,
            title: sanitizeDisplayText(call.input.title),
          })
        : err(elvError('storage', 'unsupported'));
    case 'setFavorite':
      return service.setFavorite
        ? service.setFavorite(
            {
              ...call.input,
              title: sanitizeDisplayText(call.input.title),
            },
            call.active,
          )
        : err(elvError('storage', 'unsupported'));
    case 'reorderFavorites':
      return service.reorderFavorites
        ? service.reorderFavorites(call.orderedItemKeys, call.profileId)
        : err(elvError('storage', 'unsupported'));
    case 'listFavorites':
      return service.listFavorites
        ? service.listFavorites(call.limit, call.profileId, call.opts)
        : [];
    case 'listFavoriteKeys':
      return service.listFavoriteKeys ? service.listFavoriteKeys(call.profileId) : [];
    case 'listMyListNewEpisodes':
      return service.listMyListNewEpisodes
        ? service.listMyListNewEpisodes(call.limit, call.profileId, call.opts)
        : [];
    case 'dismissMyListNewEpisode':
      return service.dismissMyListNewEpisode
        ? service.dismissMyListNewEpisode(call.episodeKey, call.profileId)
        : err(elvError('storage', 'unsupported'));
    case 'refreshMyListNewEpisodes':
      return service.refreshMyListNewEpisodes
        ? service.refreshMyListNewEpisodes(call.profileId, call.opts)
        : err(elvError('storage', 'unsupported'));
    case 'getTrackPreference':
      return service.getTrackPreference
        ? service.getTrackPreference(call.scopeKey, call.profileId)
        : null;
    case 'saveTrackPreference':
      if (service.saveTrackPreference) await service.saveTrackPreference(call.input);
      return undefined;
    case 'clearTrackPreference':
      if (service.clearTrackPreference) {
        await service.clearTrackPreference(call.scopeKey, call.profileId);
      }
      return undefined;
    case 'recordRecentChannel':
      if (service.recordRecentChannel) {
        await service.recordRecentChannel(call.itemKey, call.sourceId, call.profileId);
      }
      return undefined;
    case 'listRecentChannels':
      return service.listRecentChannels
        ? service.listRecentChannels(call.limit, call.profileId, call.opts)
        : [];
    case 'setRating':
      return service.setRating
        ? service.setRating(
            {
              ...call.input,
              title: sanitizeDisplayText(call.input.title),
            },
            call.value,
          )
        : err(elvError('storage', 'unsupported'));
    case 'getRating':
      return service.getRating ? service.getRating(call.itemKey, call.profileId) : null;
    case 'listRatings':
      return service.listRatings ? service.listRatings(call.opts) : [];
    case 'listRatingMap':
      return service.listRatingMap ? service.listRatingMap(call.profileId) : {};
  }
}
