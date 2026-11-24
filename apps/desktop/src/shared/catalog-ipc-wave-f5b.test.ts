import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave F5B catalog IPC guards (#29, #215, #403)', () => {
  it('validates Stalker addSource payloads and rejects invalid MAC, portalUrl, serialNumber, or extra keys (#29)', () => {
    const validCalls: unknown[] = [
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Living Room Portal',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Hyphen MAC Portal',
          portalUrl: 'http://portal.example.test:8080/stalker_portal/c/',
          mac: '00-1a-79-ab-cd-ef',
          serialNumber: 'SN-1234567890',
          transport: {
            userAgent: 'ELV-Test/1.0',
            allowLegacyTls: true,
            dnsFamily: 'ipv4',
            hostOverride: '203.0.113.10',
          },
          guideUrl: 'https://guide.example.test/epg.xml',
          xmltvTimezone: 'Europe/Istanbul',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Schemeless Host Portal',
          portalUrl: 'portal.example.test:8080/c/',
          mac: 'AA:BB:CC:DD:EE:FF',
        },
      },
    ];
    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }

    const invalidCalls: unknown[] = [
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Bad MAC',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:00:00:ZZ',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Mixed Separators MAC',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A-79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Missing MAC',
          portalUrl: 'https://portal.example.test/c/',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'File Scheme Portal',
          portalUrl: 'file:///etc/passwd',
          mac: '00:1A:79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Javascript Scheme Portal',
          portalUrl: 'javascript:alert(1)',
          mac: '00:1A:79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Control Char Portal',
          portalUrl: 'https://portal.example.test/c/\r\n',
          mac: '00:1A:79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Embedded Creds Portal',
          portalUrl: 'https://user:pass@portal.example.test/c/',
          mac: '00:1A:79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Oversized Portal',
          portalUrl: `https://portal.example.test/${'a'.repeat(2_049)}`,
          mac: '00:1A:79:00:00:01',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Oversized Serial',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:00:00:01',
          serialNumber: 'S'.repeat(129),
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Control Char Serial',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:00:00:01',
          serialNumber: 'SN\nBAD',
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Bad Transport Host',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:00:00:01',
          transport: { hostOverride: 'evil.example' },
        },
      },
      {
        method: 'addSource',
        input: {
          kind: 'stalker',
          name: 'Extra Key',
          portalUrl: 'https://portal.example.test/c/',
          mac: '00:1A:79:00:00:01',
          token: 'should-not-pass',
        },
      },
    ];
    for (const c of invalidCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(false);
    }
  });

  it('validates all 12 VOD enrichment and custom collection RPC calls (#215, #403)', () => {
    const validCalls: unknown[] = [
      { method: 'getVodEnrichment', itemKey: 'x:s1:movie:101' },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:101' },
      { method: 'enrichVodItem', itemKey: 's:s1:series:42', opts: { enabled: true } },
      {
        method: 'enrichVodItem',
        itemKey: 'm:s1:movie:n:metropolis|cinema',
        opts: { enabled: false, ttlMs: 86_400_000 },
      },
      { method: 'listCollections' },
      { method: 'listCollections', profileId: 'p_main' },
      { method: 'createCollection', input: { name: 'Sci-Fi Classics' } },
      {
        method: 'createCollection',
        input: { id: 'vc_scifi_1', profileId: 'p_main', name: 'Sci-Fi Classics' },
      },
      { method: 'renameCollection', id: 'vc_scifi_1', name: 'Weekend Queue' },
      { method: 'renameCollection', id: 'vc_scifi_1', name: 'Weekend Queue', profileId: 'p_main' },
      { method: 'reorderCollections', orderedIds: ['vc_2', 'vc_1'] },
      { method: 'reorderCollections', orderedIds: ['vc_2', 'vc_1'], profileId: 'p_main' },
      { method: 'deleteCollection', id: 'vc_scifi_1' },
      { method: 'deleteCollection', id: 'vc_scifi_1', profileId: 'p_main' },
      { method: 'listCollectionItems', collectionId: 'vc_scifi_1' },
      {
        method: 'listCollectionItems',
        collectionId: 'vc_scifi_1',
        opts: { profileId: 'p_main', parentalUnlocked: false },
      },
      { method: 'listCollectionsForItem', itemKey: 'x:s1:movie:101' },
      { method: 'listCollectionsForItem', itemKey: 'x:s1:movie:101', profileId: 'p_main' },
      {
        method: 'addItemToCollection',
        collectionId: 'vc_scifi_1',
        itemKey: 'x:s1:movie:101',
        kind: 'movie',
      },
      {
        method: 'addItemToCollection',
        collectionId: 'vc_scifi_1',
        itemKey: 's:s1:series:42',
        kind: 'series',
        profileId: 'p_main',
      },
      {
        method: 'removeItemFromCollection',
        collectionId: 'vc_scifi_1',
        itemKey: 'x:s1:movie:101',
      },
      {
        method: 'removeItemFromCollection',
        collectionId: 'vc_scifi_1',
        itemKey: 'x:s1:movie:101',
        profileId: 'p_main',
      },
      {
        method: 'reorderCollectionItems',
        collectionId: 'vc_scifi_1',
        orderedItemKeys: ['s:s1:series:42', 'x:s1:movie:101'],
      },
      {
        method: 'reorderCollectionItems',
        collectionId: 'vc_scifi_1',
        orderedItemKeys: ['s:s1:series:42', 'x:s1:movie:101'],
        profileId: 'p_main',
      },
    ];
    for (const c of validCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(true);
    }
  });

  it('rejects invalid VOD enrichment, collection payloads, non-serializable remoteFetcher, and prototype pollution', () => {
    const invalidCalls: unknown[] = [
      { method: 'getVodEnrichment', itemKey: '' },
      { method: 'getVodEnrichment', itemKey: 'http://evil.test/movie' },
      { method: 'getVodEnrichment', itemKey: 'x:s1:movie:1', extra: 1 },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', opts: { remoteFetcher: () => null } },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', opts: { nowMs: 1_700_000_000_000 } },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', opts: { enabled: 'yes' } },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', opts: { ttlMs: 0 } },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', opts: { ttlMs: -500 } },
      {
        method: 'enrichVodItem',
        itemKey: 'x:s1:movie:1',
        opts: { ttlMs: Number.POSITIVE_INFINITY },
      },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', opts: { ttlMs: 400 * 86_400_000 } },
      { method: 'enrichVodItem', itemKey: 'x:s1:movie:1', extra: true },
      { method: 'listCollections', profileId: '../bad' },
      { method: 'listCollections', extra: 1 },
      { method: 'createCollection', input: null },
      { method: 'createCollection', input: { name: '   ' } },
      { method: 'createCollection', input: { name: 'a'.repeat(81) } },
      { method: 'createCollection', input: { name: 'Bad\nName' } },
      { method: 'createCollection', input: { id: '../bad', name: 'Ok' } },
      { method: 'createCollection', input: { profileId: '../bad', name: 'Ok' } },
      { method: 'createCollection', input: { name: 'Ok', extra: 1 } },
      { method: 'renameCollection', id: '../bad', name: 'Ok' },
      { method: 'renameCollection', id: 'vc_1', name: '' },
      { method: 'renameCollection', id: 'vc_1', name: 'Bad\rName' },
      { method: 'renameCollection', id: 'vc_1', name: 'Ok', profileId: '../bad' },
      { method: 'reorderCollections', orderedIds: 'not-array' },
      { method: 'reorderCollections', orderedIds: ['../bad'] },
      {
        method: 'reorderCollections',
        orderedIds: Array.from({ length: 257 }, (_, i) => `vc_${i}`),
      },
      { method: 'deleteCollection', id: '' },
      { method: 'deleteCollection', id: '../bad' },
      { method: 'deleteCollection', id: 'vc_1', extra: 1 },
      { method: 'listCollectionItems', collectionId: '../bad' },
      {
        method: 'listCollectionItems',
        collectionId: 'vc_1',
        opts: { parentalUnlocked: 'yes' },
      },
      {
        method: 'listCollectionItems',
        collectionId: 'vc_1',
        opts: { extra: 1 },
      },
      { method: 'listCollectionsForItem', itemKey: 'bad\nkey' },
      { method: 'listCollectionsForItem', itemKey: 'x:s1:movie:1', profileId: '../bad' },
      {
        method: 'addItemToCollection',
        collectionId: 'vc_1',
        itemKey: 'x:s1:live:1',
        kind: 'live',
      },
      {
        method: 'addItemToCollection',
        collectionId: 'vc_1',
        itemKey: 'x:s1:episode:1',
        kind: 'episode',
      },
      {
        method: 'addItemToCollection',
        collectionId: '../bad',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
      },
      {
        method: 'addItemToCollection',
        collectionId: 'vc_1',
        itemKey: 'http://evil.test/1',
        kind: 'movie',
      },
      {
        method: 'removeItemFromCollection',
        collectionId: 'vc_1',
        itemKey: 'bad\0key',
      },
      {
        method: 'reorderCollectionItems',
        collectionId: 'vc_1',
        orderedItemKeys: 'not-array',
      },
      {
        method: 'reorderCollectionItems',
        collectionId: 'vc_1',
        orderedItemKeys: Array.from({ length: 501 }, (_, i) => `x:s1:movie:${i}`),
      },
    ];
    for (const c of invalidCalls) {
      expect(isCatalogClientMessage(call(c))).toBe(false);
    }

    const protoInjected = JSON.parse(
      '{"type":"call","reqId":1,"call":{"method":"createCollection","input":{"name":"Ok","__proto__":{"polluted":true}}}}',
    );
    expect(isCatalogClientMessage(protoInjected)).toBe(false);
  });
});
