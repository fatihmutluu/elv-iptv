import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';
import { MAX_PICKED_PLAYLIST_BYTES } from './sources-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave C3 catalog IPC guards (#51, #39, #182, #218, #404)', () => {
  it('accepts addLocalM3uSource with valid Uint8Array bytes and rejects malformed or oversized payloads (#51)', () => {
    const bytes = new Uint8Array([35, 69, 88, 84, 77, 51, 85]);
    expect(
      isCatalogClientMessage(
        call({
          method: 'addLocalM3uSource',
          input: {
            name: 'Local List',
            bytes,
            guideUrl: 'https://guide.example/epg.xml',
            vodPlaylist: false,
            transport: { allowLegacyTls: true },
          },
        }),
      ),
    ).toBe(true);

    expect(
      isCatalogClientMessage(
        call({
          method: 'addLocalM3uSource',
          input: { name: 'Minimal', bytes: new Uint8Array(0) },
        }),
      ),
    ).toBe(true);

    // Rejects non-Uint8Array, control chars in guideUrl, non-boolean allowLegacyTls, oversized bytes
    const fakeOversized = new Uint8Array(0);
    Object.defineProperty(fakeOversized, 'byteLength', { value: MAX_PICKED_PLAYLIST_BYTES + 1 });
    for (const bad of [
      null,
      { name: 'NoBytes' },
      { name: 'StringBytes', bytes: '#EXTM3U' },
      { name: 'ArrayBytes', bytes: [1, 2, 3] },
      { name: 'BadGuide', bytes, guideUrl: 'https://a.test/\nfoo' },
      { name: 'BadVod', bytes, vodPlaylist: 'yes' },
      { name: 'BadTls', bytes, transport: { allowLegacyTls: 'yes' } },
      { name: 'TooBig', bytes: fakeOversized },
    ]) {
      expect(isCatalogClientMessage(call({ method: 'addLocalM3uSource', input: bad }))).toBe(false);
    }
  });

  it('accepts allowLegacyTls on addSource and addSourceFromLink transport settings (#182)', () => {
    expect(
      isCatalogClientMessage(
        call({
          method: 'addSource',
          input: {
            kind: 'm3u',
            name: 'Legacy Tuner',
            playlistUrl: 'https://tuner.local/list.m3u',
            transport: { allowLegacyTls: true },
          },
        }),
      ),
    ).toBe(true);

    expect(
      isCatalogClientMessage(
        call({
          method: 'addSourceFromLink',
          input: {
            name: 'Legacy Link',
            url: 'https://legacy.local/get.php?username=a&password=b',
            transport: { allowLegacyTls: false },
          },
        }),
      ),
    ).toBe(true);

    expect(
      isCatalogClientMessage(
        call({
          method: 'addSource',
          input: {
            kind: 'm3u',
            name: 'Bad TLS Flag',
            playlistUrl: 'https://tuner.local/list.m3u',
            transport: { allowLegacyTls: 1 },
          },
        }),
      ),
    ).toBe(false);
  });

  it('accepts discoverSourceCategories, liveVariants, and itemVersions and rejects invalid keys (#39, #218, #404)', () => {
    expect(
      isCatalogClientMessage(call({ method: 'discoverSourceCategories', sourceId: 'src-1' })),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'discoverSourceCategories', sourceId: '' }))).toBe(
      false,
    );
    expect(
      isCatalogClientMessage(call({ method: 'discoverSourceCategories', sourceId: 'src\n1' })),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({ method: 'liveVariants', itemKey: 'src-1:live:10', categoryId: 'src-1|live|1' }),
      ),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'liveVariants', itemKey: 'src-1:live:10' }))).toBe(
      true,
    );
    expect(isCatalogClientMessage(call({ method: 'liveVariants', itemKey: '' }))).toBe(false);
    expect(
      isCatalogClientMessage(
        call({ method: 'liveVariants', itemKey: 'src-1:live:10', categoryId: 'bad\ncat' }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(call({ method: 'itemVersions', itemKey: 'src-1:movie:42' })),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'itemVersions', itemKey: '' }))).toBe(false);
    expect(isCatalogClientMessage(call({ method: 'itemVersions', itemKey: 'bad\0key' }))).toBe(
      false,
    );
  });

  it('accepts collapseVariants and groupVersions on categories, items, and allSourcesItems (#218, #404)', () => {
    expect(
      isCatalogClientMessage(
        call({
          method: 'categories',
          sourceId: 'src-1',
          kind: 'live',
          opts: { collapseVariants: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'categories',
          sourceId: 'src-1',
          kind: 'movie',
          opts: { groupVersions: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'categories',
          sourceId: 'src-1',
          kind: 'live',
          opts: { collapseVariants: 'yes' },
        }),
      ),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'items',
          categoryId: 'src-1|live|1',
          offset: 0,
          limit: 50,
          opts: { collapseVariants: true, groupVersions: false },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'allSourcesItems',
          kind: 'movie',
          offset: 0,
          limit: 50,
          opts: { groupVersions: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'items',
          categoryId: 'src-1|live|1',
          offset: 0,
          limit: 50,
          opts: { collapseVariants: 1 },
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({
          method: 'items',
          categoryId: 'src-1|movie|1',
          offset: 0,
          limit: 50,
          opts: { groupVersions: 'true' },
        }),
      ),
    ).toBe(false);
  });
});
