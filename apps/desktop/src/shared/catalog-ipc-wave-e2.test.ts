import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave E2 ELV Mode discovery & recommendations catalog IPC guards (#512)', () => {
  it('accepts all valid Wave E2 ELV RPC calls', () => {
    const validCalls: unknown[] = [
      { method: 'listElvImdbGenres', kind: 'movie' },
      {
        method: 'listElvImdbGenres',
        kind: 'series',
        opts: {
          excludedSourceIds: ['src_1', 'src_2'],
          profileId: 'p_kids',
          parentalUnlocked: false,
        },
      },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'Action' },
      {
        method: 'listElvItemsByImdbGenre',
        kind: 'series',
        genre: 'imdb-genre:Sci-Fi',
        opts: {
          offset: 0,
          limit: 60,
          excludedSourceIds: ['src_2'],
          profileId: 'p_main',
          parentalUnlocked: false,
          sortBy: 'alpha',
        },
      },
      {
        method: 'getElvRecommendations',
        opts: { profile: 'home' },
      },
      {
        method: 'getElvRecommendations',
        opts: {
          profileId: 'p_kids',
          profile: 'elv_picks',
          kind: 'movie',
          limit: 24,
          excludedSourceIds: ['src_adult'],
          maxRatingAge: 12,
          parentalUnlocked: false,
        },
      },
      {
        method: 'getElvRecommendations',
        opts: { profile: 'home', maxRatingAge: null },
      },
      { method: 'refreshElvFeeds' },
      { method: 'refreshElvFeeds', opts: { force: true } },
      { method: 'listElvFranchiseItems', imdbId: 'tt0133093' },
      {
        method: 'listElvFranchiseItems',
        imdbId: 'tt0133093',
        opts: { excludedSourceIds: ['src_2'], profileId: 'p_main', parentalUnlocked: true },
      },
      {
        method: 'listElvPersonLibraryItems',
        person: { personId: 'nm0000206', name: 'Keanu Reeves' },
      },
      {
        method: 'listElvPersonLibraryItems',
        person: { name: 'Christopher Nolan' },
        opts: { excludedSourceIds: ['src_2'], limit: 30, profileId: 'p_main' },
      },
      {
        method: 'searchElvMatchCandidates',
        query: 'Inception',
        mediaType: 'movie',
      },
      {
        method: 'searchElvMatchCandidates',
        query: 'Dark',
        mediaType: 'series',
      },
      {
        method: 'applyElvFixMatch',
        input: {
          itemKey: 'x:s1:movie:101',
          sourceId: 's1',
          mediaType: 'movie',
          imdbId: 'tt1375666',
        },
      },
      {
        method: 'applyElvFixMatch',
        input: {
          itemKey: 'm:s1:series:t:show@hd',
          sourceId: 's1',
          mediaType: 'series',
          imdbId: 'tt5753856',
          lang: 'tr-TR',
        },
      },
    ];

    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }
  });

  it('rejects invalid kinds, malformed options, non-serializable signals, extra keys, and prototype pollution', () => {
    const invalidCalls: unknown[] = [
      { method: 'listElvImdbGenres', kind: 'live' },
      { method: 'listElvImdbGenres', kind: 'movie', opts: { excludedSourceIds: 's1' } },
      { method: 'listElvImdbGenres', kind: 'movie', opts: { parentalUnlocked: 'yes' } },
      { method: 'listElvImdbGenres', kind: 'movie', opts: { profileId: 'bad profile!' } },
      { method: 'listElvImdbGenres', kind: 'movie', extra: 1 },
      { method: 'listElvItemsByImdbGenre', kind: 'live', genre: 'Action' },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: '' },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: '   ' },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'Action\nDrama' },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'A'.repeat(81) },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'Action', opts: { offset: -1 } },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'Action', opts: { limit: 201 } },
      {
        method: 'listElvItemsByImdbGenre',
        kind: 'movie',
        genre: 'Action',
        opts: { sortBy: 'bogus' },
      },
      { method: 'listElvItemsByImdbGenre', kind: 'movie', genre: 'Action', opts: { extra: 1 } },
      { method: 'getElvRecommendations' },
      { method: 'getElvRecommendations', opts: { profile: 'unknown' } },
      { method: 'getElvRecommendations', opts: { profile: 'home', kind: 'live' } },
      { method: 'getElvRecommendations', opts: { profile: 'home', limit: 101 } },
      { method: 'getElvRecommendations', opts: { profile: 'home', limit: -1 } },
      { method: 'getElvRecommendations', opts: { profile: 'home', maxRatingAge: 22 } },
      { method: 'getElvRecommendations', opts: { profile: 'home', maxRatingAge: -1 } },
      { method: 'getElvRecommendations', opts: { profile: 'home', maxRatingAge: 12.5 } },
      { method: 'getElvRecommendations', opts: { profile: 'home', now: () => 1 } },
      { method: 'refreshElvFeeds', opts: { force: 'yes' } },
      { method: 'refreshElvFeeds', opts: { signal: {} } },
      { method: 'refreshElvFeeds', extra: true },
      { method: 'listElvFranchiseItems', imdbId: 'invalid' },
      { method: 'listElvFranchiseItems', imdbId: 'tt123' },
      { method: 'listElvFranchiseItems', imdbId: 'tt0133093', opts: { extra: true } },
      { method: 'listElvPersonLibraryItems', person: null },
      { method: 'listElvPersonLibraryItems', person: { name: '   ' } },
      { method: 'listElvPersonLibraryItems', person: { name: 'Bad\nName' } },
      { method: 'listElvPersonLibraryItems', person: { personId: 'bad id', name: 'Ok' } },
      { method: 'listElvPersonLibraryItems', person: { name: 'Ok', extra: 1 } },
      { method: 'listElvPersonLibraryItems', person: { name: 'Ok' }, opts: { limit: 201 } },
      { method: 'listElvPersonLibraryItems', person: { name: 'Ok' }, opts: { limit: -1 } },
      { method: 'searchElvMatchCandidates', query: 'Bad\nQuery', mediaType: 'movie' },
      { method: 'searchElvMatchCandidates', query: 'Inception', mediaType: 'live' },
      { method: 'searchElvMatchCandidates', query: 'q'.repeat(257), mediaType: 'movie' },
      { method: 'searchElvMatchCandidates', query: 'Inception', mediaType: 'movie', opts: {} },
      { method: 'applyElvFixMatch', input: null },
      {
        method: 'applyElvFixMatch',
        input: { itemKey: '', sourceId: 's1', mediaType: 'movie', imdbId: 'tt1375666' },
      },
      {
        method: 'applyElvFixMatch',
        input: { itemKey: 'http://bad/k', sourceId: 's1', mediaType: 'movie', imdbId: 'tt1375666' },
      },
      {
        method: 'applyElvFixMatch',
        input: { itemKey: 'x:s1:movie:1', sourceId: '', mediaType: 'movie', imdbId: 'tt1375666' },
      },
      {
        method: 'applyElvFixMatch',
        input: { itemKey: 'x:s1:movie:1', sourceId: 's1', mediaType: 'live', imdbId: 'tt1375666' },
      },
      {
        method: 'applyElvFixMatch',
        input: { itemKey: 'x:s1:movie:1', sourceId: 's1', mediaType: 'movie', imdbId: 'bad' },
      },
      {
        method: 'applyElvFixMatch',
        input: {
          itemKey: 'x:s1:movie:1',
          sourceId: 's1',
          mediaType: 'movie',
          imdbId: 'tt1375666',
          lang: 'en; DROP',
        },
      },
      {
        method: 'applyElvFixMatch',
        input: {
          itemKey: 'x:s1:movie:1',
          sourceId: 's1',
          mediaType: 'movie',
          imdbId: 'tt1375666',
          extra: 1,
        },
      },
    ];

    for (const c of invalidCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(false);
    }

    const protoInjected = JSON.parse(
      '{"type":"call","reqId":1,"call":{"method":"getElvRecommendations","opts":{"profile":"home","__proto__":{"polluted":true}}}}',
    );
    expect(isCatalogClientMessage(protoInjected)).toBe(false);
  });
});
