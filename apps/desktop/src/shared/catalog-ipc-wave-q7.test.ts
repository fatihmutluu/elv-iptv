import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';
import { isWaveQ7OpsRpcCall } from './catalog-ipc-guards-q7.ts';

describe('Wave Q7-B Desktop Catalog IPC guards', () => {
  it('accepts valid recent-channel remove/clear and Live TV favorite folder RPC payloads', () => {
    const validCalls = [
      { method: 'removeRecentChannel', itemKey: 'x:s1:live:10' },
      { method: 'removeRecentChannel', itemKey: 'x:s1:live:10', profileId: 'kids' },
      { method: 'clearRecentChannels' },
      { method: 'clearRecentChannels', profileId: 'kids' },
      { method: 'listLiveFavoriteFolders' },
      { method: 'listLiveFavoriteFolders', profileId: 'default', opts: { parentalUnlocked: true } },
      { method: 'createLiveFavoriteFolder', input: { name: 'Sports' } },
      {
        method: 'createLiveFavoriteFolder',
        input: { id: 'lff_1', name: 'Sports', profileId: 'kids' },
      },
      { method: 'renameLiveFavoriteFolder', id: 'lff_1', name: 'Live Sports' },
      { method: 'deleteLiveFavoriteFolder', id: 'lff_1', profileId: 'default' },
      {
        method: 'assignLiveFavoriteFolder',
        input: {
          itemKey: 'x:s1:live:10',
          sourceId: 's1',
          folderId: 'lff_1',
          title: 'Sports One',
          logo: 'https://cdn.example/logo.png',
        },
      },
      {
        method: 'assignLiveFavoriteFolder',
        input: {
          itemKey: 'x:s1:live:10',
          sourceId: 's1',
          folderId: null,
          profileId: 'default',
        },
      },
      { method: 'listLiveFavoriteFolderAssignments' },
      { method: 'listLiveFavoriteFolderAssignments', profileId: 'kids' },
    ];

    for (const call of validCalls) {
      expect(isWaveQ7OpsRpcCall(call as Record<string, unknown>)).toBe(true);
      expect(isCatalogClientMessage({ type: 'call', reqId: 1, call })).toBe(true);
    }
  });

  it('rejects URLs, credentials, extra keys, control chars, and invalid IDs', () => {
    const invalidCalls = [
      { method: 'removeRecentChannel', itemKey: 'http://user:pass@host/live.ts' },
      { method: 'removeRecentChannel', itemKey: 'x:s1:live:10', extra: true },
      { method: 'clearRecentChannels', profileId: 'bad profile!' },
      { method: 'createLiveFavoriteFolder', input: { name: '   ' } },
      { method: 'createLiveFavoriteFolder', input: { name: 'Bad\nName' } },
      { method: 'createLiveFavoriteFolder', input: { id: 'bad/id', name: 'Sports' } },
      { method: 'renameLiveFavoriteFolder', id: 'lff_1', name: '' },
      { method: 'deleteLiveFavoriteFolder', id: '../escape' },
      {
        method: 'assignLiveFavoriteFolder',
        input: { itemKey: 'https://host/stream?tok=1', sourceId: 's1', folderId: 'lff_1' },
      },
      {
        method: 'assignLiveFavoriteFolder',
        input: { itemKey: 'x:s1:live:1', sourceId: '../bad', folderId: 'lff_1' },
      },
      {
        method: 'assignLiveFavoriteFolder',
        input: { itemKey: 'x:s1:live:1', sourceId: 's1', folderId: 'bad/id' },
      },
      { method: 'listLiveFavoriteFolderAssignments', extra: 1 },
    ];

    for (const call of invalidCalls) {
      expect(isWaveQ7OpsRpcCall(call as Record<string, unknown>)).toBe(false);
      expect(isCatalogClientMessage({ type: 'call', reqId: 1, call })).toBe(false);
    }
  });
});
