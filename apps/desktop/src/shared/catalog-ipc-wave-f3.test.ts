import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

const call = (c: unknown) => ({ type: 'call', reqId: 1, call: c });

describe('Wave F3 catalog IPC guards (#220, #306, #30, #35)', () => {
  it('validates resolveCatchupStream and fetchChannelArchiveEpg and rejects invalid payloads', () => {
    expect(
      isCatalogClientMessage(
        call({
          method: 'resolveCatchupStream',
          itemKey: 'm:s1:ch1',
          programme: { startMs: 1_700_000_000_000, stopMs: 1_700_003_600_000, hasArchive: true },
          opts: { profileId: 'p_living', parentalUnlocked: false },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'resolveCatchupStream',
          itemKey: 'm:s1:ch1',
          programme: { startMs: 1_000, stopMs: 2_000 },
        }),
      ),
    ).toBe(true);

    for (const bad of [
      { method: 'resolveCatchupStream', itemKey: '', programme: { startMs: 1000, stopMs: 2000 } },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1\n',
        programme: { startMs: 1000, stopMs: 2000 },
      },
      { method: 'resolveCatchupStream', itemKey: 'm:s1:ch1', programme: null },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 0, stopMs: 2000 },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 2000, stopMs: 2000 },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 3000, stopMs: 2000 },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: Number.NaN, stopMs: 2000 },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 1000, stopMs: 2000, hasArchive: 'yes' },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 1000, stopMs: 2000, extra: 1 },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 1000, stopMs: 2000 },
        opts: { profileId: '../bad' },
      },
      {
        method: 'resolveCatchupStream',
        itemKey: 'm:s1:ch1',
        programme: { startMs: 1000, stopMs: 2000 },
        extra: true,
      },
    ]) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'fetchChannelArchiveEpg',
          itemKey: 'x:s1:live:101',
          opts: { profileId: 'default', parentalUnlocked: true },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'fetchChannelArchiveEpg', itemKey: 'x:s1:live:101' })),
    ).toBe(true);
    for (const bad of [
      { method: 'fetchChannelArchiveEpg', itemKey: '' },
      { method: 'fetchChannelArchiveEpg', itemKey: 'x:s1:live:101', opts: { extra: 1 } },
      { method: 'fetchChannelArchiveEpg', itemKey: 'x:s1:live:101', extra: 1 },
    ]) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }
  });

  it('validates multi-guide source CRUD and reorder RPCs and blocks unsafe URLs/shifts/arrays', () => {
    expect(isCatalogClientMessage(call({ method: 'listGuideSources', sourceId: 's1' }))).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'listGuideSources', sourceId: '../bad' }))).toBe(
      false,
    );
    expect(
      isCatalogClientMessage(call({ method: 'listGuideSources', sourceId: 's1', extra: 1 })),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'addGuideSource',
          input: {
            sourceId: 's1',
            name: 'Primary XMLTV',
            url: 'https://guide.example.test/epg.xml.gz',
            priority: 0,
            epgShiftMs: -3_600_000,
            enabled: true,
          },
        }),
      ),
    ).toBe(true);

    for (const badInput of [
      null,
      {},
      { sourceId: '../bad', name: 'Guide', url: 'https://guide.example.test/epg.xml' },
      { sourceId: 's1', name: '   ', url: 'https://guide.example.test/epg.xml' },
      { sourceId: 's1', name: 'a'.repeat(81), url: 'https://guide.example.test/epg.xml' },
      { sourceId: 's1', name: 'Bad\nName', url: 'https://guide.example.test/epg.xml' },
      { sourceId: 's1', name: 'Guide', url: 'file:///etc/passwd' },
      { sourceId: 's1', name: 'Guide', url: 'javascript:alert(1)' },
      { sourceId: 's1', name: 'Guide', url: 'ftp://guide.example.test/epg.xml' },
      { sourceId: 's1', name: 'Guide', url: `https://guide.example.test/${'a'.repeat(4100)}` },
      { sourceId: 's1', name: 'Guide', url: 'https://guide.example.test/epg.xml\r\n' },
      {
        sourceId: 's1',
        name: 'Guide',
        url: 'https://guide.example.test/epg.xml',
        epgShiftMs: 43_200_001,
      },
      {
        sourceId: 's1',
        name: 'Guide',
        url: 'https://guide.example.test/epg.xml',
        epgShiftMs: -43_200_001,
      },
      {
        sourceId: 's1',
        name: 'Guide',
        url: 'https://guide.example.test/epg.xml',
        epgShiftMs: 1.5,
      },
      {
        sourceId: 's1',
        name: 'Guide',
        url: 'https://guide.example.test/epg.xml',
        priority: -1,
      },
      {
        sourceId: 's1',
        name: 'Guide',
        url: 'https://guide.example.test/epg.xml',
        enabled: 'yes',
      },
      {
        sourceId: 's1',
        name: 'Guide',
        url: 'https://guide.example.test/epg.xml',
        extra: true,
      },
    ]) {
      expect(isCatalogClientMessage(call({ method: 'addGuideSource', input: badInput }))).toBe(
        false,
      );
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'updateGuideSource',
          id: 'gs_123_abc',
          patch: {
            name: 'Backup XMLTV',
            url: 'http://guide.example.test/backup.xml',
            priority: 2,
            epgShiftMs: 43_200_000,
            enabled: false,
          },
        }),
      ),
    ).toBe(true);
    for (const bad of [
      { method: 'updateGuideSource', id: '../escape', patch: { enabled: false } },
      { method: 'updateGuideSource', id: 'gs_1', patch: { url: 'file:///tmp/x.xml' } },
      { method: 'updateGuideSource', id: 'gs_1', patch: { epgShiftMs: 50_000_000 } },
      { method: 'updateGuideSource', id: 'gs_1', patch: { extra: 1 } },
      { method: 'updateGuideSource', id: 'gs_1', patch: {}, extra: 1 },
    ]) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }

    expect(isCatalogClientMessage(call({ method: 'removeGuideSource', id: 'gs_123' }))).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'removeGuideSource', id: '../bad' }))).toBe(false);
    expect(
      isCatalogClientMessage(call({ method: 'removeGuideSource', id: 'gs_123', extra: 1 })),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({ method: 'reorderGuideSources', sourceId: 's1', orderedIds: ['gs_2', 'gs_1'] }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'reorderGuideSources',
          sourceId: 's1',
          orderedIds: Array.from({ length: 101 }, (_, i) => `gs_${i}`),
        }),
      ),
    ).toBe(false);
    expect(
      isCatalogClientMessage(
        call({ method: 'reorderGuideSources', sourceId: 's1', orderedIds: ['../bad'] }),
      ),
    ).toBe(false);
  });

  it('validates guide channel listing and manual channel-to-guide override RPCs', () => {
    expect(
      isCatalogClientMessage(
        call({ method: 'listGuideChannels', sourceId: 's1', query: 'BBC', limit: 50 }),
      ),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'listGuideChannels', sourceId: 's1' }))).toBe(
      true,
    );
    for (const bad of [
      { method: 'listGuideChannels', sourceId: '../bad' },
      { method: 'listGuideChannels', sourceId: 's1', query: 'a'.repeat(257) },
      { method: 'listGuideChannels', sourceId: 's1', query: 'bad\nquery' },
      { method: 'listGuideChannels', sourceId: 's1', limit: 501 },
      { method: 'listGuideChannels', sourceId: 's1', limit: -1 },
      { method: 'listGuideChannels', sourceId: 's1', extra: true },
    ]) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }

    expect(
      isCatalogClientMessage(call({ method: 'listChannelGuideOverrides', sourceId: 's1' })),
    ).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'listChannelGuideOverrides', sourceId: 'bad/id' })),
    ).toBe(false);

    expect(
      isCatalogClientMessage(
        call({
          method: 'setChannelGuideOverride',
          input: {
            sourceId: 's1',
            channelKey: 'm:s1:ch1',
            guideSourceId: 'gs_1',
            guideId: 'bbc1.uk',
            epgShiftMs: 1_800_000,
          },
        }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'setChannelGuideOverride',
          input: {
            sourceId: 's1',
            channelKey: 'm:s1:ch1',
            guideSourceId: null,
            guideId: null,
          },
        }),
      ),
    ).toBe(true);
    for (const badInput of [
      null,
      { sourceId: '../bad', channelKey: 'm:s1:ch1' },
      { sourceId: 's1', channelKey: 'http://evil.test/ch' },
      { sourceId: 's1', channelKey: 'm:s1:ch1', guideSourceId: '../bad' },
      { sourceId: 's1', channelKey: 'm:s1:ch1', guideId: 'a'.repeat(257) },
      { sourceId: 's1', channelKey: 'm:s1:ch1', guideId: 'bbc\n1' },
      { sourceId: 's1', channelKey: 'm:s1:ch1', epgShiftMs: 43_200_001 },
      { sourceId: 's1', channelKey: 'm:s1:ch1', extra: 1 },
    ]) {
      expect(
        isCatalogClientMessage(call({ method: 'setChannelGuideOverride', input: badInput })),
      ).toBe(false);
    }

    expect(
      isCatalogClientMessage(
        call({ method: 'clearChannelGuideOverride', sourceId: 's1', channelKey: 'm:s1:ch1' }),
      ),
    ).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'clearChannelGuideOverride',
          sourceId: 's1',
          channelKey: 'http://evil.test/ch',
        }),
      ),
    ).toBe(false);
  });

  it('validates programme reminder RPCs and rejects invalid timestamps, lead times, and proto keys', () => {
    expect(isCatalogClientMessage(call({ method: 'listReminders' }))).toBe(true);
    expect(
      isCatalogClientMessage(
        call({
          method: 'listReminders',
          profileId: 'p_living',
          opts: { includeFired: true, fromMs: 1_700_000_000_000, limit: 50 },
        }),
      ),
    ).toBe(true);
    for (const bad of [
      { method: 'listReminders', profileId: '../bad' },
      { method: 'listReminders', opts: { includeFired: 'yes' } },
      { method: 'listReminders', opts: { fromMs: -1 } },
      { method: 'listReminders', opts: { limit: 501 } },
      { method: 'listReminders', opts: { extra: 1 } },
    ]) {
      expect(isCatalogClientMessage(call(bad))).toBe(false);
    }

    expect(
      isCatalogClientMessage(
        call({
          method: 'upsertReminder',
          input: {
            profileId: 'default',
            sourceId: 's1',
            channelKey: 'm:s1:ch1',
            channelName: 'News HD',
            programmeTitle: 'Evening News',
            programmeStart: 1_700_003_600_000,
            programmeStop: 1_700_007_200_000,
            leadTimeMs: 300_000,
          },
        }),
      ),
    ).toBe(true);
    for (const badInput of [
      null,
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: '',
        programmeTitle: 'Show',
        programmeStart: 1000,
        programmeStop: 2000,
      },
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News',
        programmeTitle: 'a'.repeat(257),
        programmeStart: 1000,
        programmeStop: 2000,
      },
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News',
        programmeTitle: 'Show\nInjected',
        programmeStart: 1000,
        programmeStop: 2000,
      },
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News',
        programmeTitle: 'Show',
        programmeStart: 2000,
        programmeStop: 2000,
      },
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News',
        programmeTitle: 'Show',
        programmeStart: 1000,
        programmeStop: 2000,
        leadTimeMs: 3_600_001,
      },
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News',
        programmeTitle: 'Show',
        programmeStart: 1000,
        programmeStop: 2000,
        leadTimeMs: -1,
      },
      {
        sourceId: 's1',
        channelKey: 'm:s1:ch1',
        channelName: 'News',
        programmeTitle: 'Show',
        programmeStart: 1000,
        programmeStop: 2000,
        extra: true,
      },
    ]) {
      expect(isCatalogClientMessage(call({ method: 'upsertReminder', input: badInput }))).toBe(
        false,
      );
    }

    for (const method of ['removeReminder', 'markReminderFired'] as const) {
      expect(
        isCatalogClientMessage(
          call({
            method,
            channelKey: 'm:s1:ch1',
            programmeStart: 1_700_003_600_000,
            profileId: 'default',
          }),
        ),
      ).toBe(true);
      expect(
        isCatalogClientMessage(
          call({ method, channelKey: 'http://evil.test/ch', programmeStart: 1000 }),
        ),
      ).toBe(false);
      expect(
        isCatalogClientMessage(call({ method, channelKey: 'm:s1:ch1', programmeStart: -5 })),
      ).toBe(false);
      expect(
        isCatalogClientMessage(
          call({ method, channelKey: 'm:s1:ch1', programmeStart: 1000, extra: 1 }),
        ),
      ).toBe(false);
    }

    expect(isCatalogClientMessage(call({ method: 'pruneExpiredReminders' }))).toBe(true);
    expect(
      isCatalogClientMessage(call({ method: 'pruneExpiredReminders', nowMs: 1_700_000_000_000 })),
    ).toBe(true);
    expect(isCatalogClientMessage(call({ method: 'pruneExpiredReminders', nowMs: -1 }))).toBe(
      false,
    );
    expect(isCatalogClientMessage(call({ method: 'pruneExpiredReminders', extra: 1 }))).toBe(false);

    const protoInjected = JSON.parse(
      '{"type":"call","reqId":1,"call":{"method":"addGuideSource","input":{"sourceId":"s1","name":"Guide","url":"https://guide.example.test/epg.xml","__proto__":{"polluted":true}}}}',
    );
    expect(isCatalogClientMessage(protoInjected)).toBe(false);
  });
});
