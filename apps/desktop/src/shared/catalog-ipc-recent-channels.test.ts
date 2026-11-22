import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

describe('catalog-ipc recent channels guards (#53)', () => {
  it('accepts valid recordRecentChannel and listRecentChannels calls', () => {
    const valid: unknown[] = [
      {
        type: 'call',
        reqId: 1,
        call: { method: 'recordRecentChannel', itemKey: 'x:src_1:live:101', sourceId: 'src_1' },
      },
      {
        type: 'call',
        reqId: 2,
        call: {
          method: 'recordRecentChannel',
          itemKey: 'm:src_2:live:42',
          sourceId: 'src_2',
          profileId: 'kids',
        },
      },
      { type: 'call', reqId: 3, call: { method: 'listRecentChannels' } },
      { type: 'call', reqId: 4, call: { method: 'listRecentChannels', limit: 20 } },
      {
        type: 'call',
        reqId: 5,
        call: { method: 'listRecentChannels', limit: 50, profileId: 'default' },
      },
    ];
    for (const msg of valid) {
      expect(isCatalogClientMessage(msg), JSON.stringify(msg)).toBe(true);
    }
  });

  it('rejects malformed or unsafe recordRecentChannel and listRecentChannels calls', () => {
    const invalid: unknown[] = [
      {
        type: 'call',
        reqId: 1,
        call: { method: 'recordRecentChannel', itemKey: '', sourceId: 's1' },
      },
      {
        type: 'call',
        reqId: 2,
        call: { method: 'recordRecentChannel', itemKey: 'x:s1:live:1', sourceId: '' },
      },
      {
        type: 'call',
        reqId: 3,
        call: {
          method: 'recordRecentChannel',
          itemKey: 'http://user:pass@host/live.ts',
          sourceId: 's1',
        },
      },
      {
        type: 'call',
        reqId: 4,
        call: {
          method: 'recordRecentChannel',
          itemKey: 'x:s1:live:1?token=secret',
          sourceId: 's1',
        },
      },
      {
        type: 'call',
        reqId: 5,
        call: {
          method: 'recordRecentChannel',
          itemKey: 'x:s1:live:1',
          sourceId: 's1',
          profileId: 'bad\nprofile',
        },
      },
      { type: 'call', reqId: 6, call: { method: 'listRecentChannels', limit: -1 } },
      { type: 'call', reqId: 7, call: { method: 'listRecentChannels', limit: 101 } },
      { type: 'call', reqId: 8, call: { method: 'listRecentChannels', limit: 1.5 } },
      { type: 'call', reqId: 9, call: { method: 'listRecentChannels', profileId: '' } },
    ];
    for (const msg of invalid) {
      expect(isCatalogClientMessage(msg), JSON.stringify(msg)).toBe(false);
    }
  });
});
