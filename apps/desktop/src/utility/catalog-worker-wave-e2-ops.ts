import type { CatalogService } from '@elv/data';
import {
  type CatalogWaveE2OpsRpcCall,
  WAVE_E2_RPC_METHODS,
} from '../shared/catalog-ipc-wave-e2-guards.ts';

/** Narrowing type guard for Wave E2 ELV Mode discovery & recommendations RPC calls inside the catalog worker runtime. */
export function isWaveE2RpcCall(call: { method: string }): call is CatalogWaveE2OpsRpcCall {
  return WAVE_E2_RPC_METHODS.has(call.method);
}

/** Dispatches all Wave E2 ELV Mode discovery, recommendations, franchise, cast & Fix Match RPC calls (`#512`). */
export async function executeWaveE2OpsRpcCall(
  service: CatalogService,
  call: CatalogWaveE2OpsRpcCall,
): Promise<unknown> {
  switch (call.method) {
    case 'listElvImdbGenres':
      return service.listElvImdbGenres ? service.listElvImdbGenres(call.kind, call.opts) : [];
    case 'listElvItemsByImdbGenre':
      return service.listElvItemsByImdbGenre
        ? service.listElvItemsByImdbGenre(call.kind, call.genre, call.opts)
        : [];
    case 'getElvRecommendations':
      return service.getElvRecommendations ? service.getElvRecommendations(call.opts) : [];
    case 'refreshElvFeeds':
      return service.refreshElvFeeds ? service.refreshElvFeeds(call.opts) : false;
    case 'listElvFranchiseItems':
      return service.listElvFranchiseItems
        ? service.listElvFranchiseItems(call.imdbId, call.opts)
        : [];
    case 'listElvPersonLibraryItems':
      return service.listElvPersonLibraryItems
        ? service.listElvPersonLibraryItems(call.person, call.opts)
        : [];
    case 'searchElvMatchCandidates':
      return service.searchElvMatchCandidates
        ? service.searchElvMatchCandidates(call.query, call.mediaType)
        : [];
    case 'applyElvFixMatch':
      return service.applyElvFixMatch ? service.applyElvFixMatch(call.input) : null;
  }
}
