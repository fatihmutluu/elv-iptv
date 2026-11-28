import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { getSource } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';

describe('source transport settings (userAgent & streamUserAgent)', () => {
  it('persists, updates, clears, sanitizes, and surfaces userAgent and streamUserAgent on SourceRow', async () => {
    const t = testDb();
    await openCatalog(t.db);
    const catalog = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: { get: async () => Promise.reject(new Error('unused')) },
      clock: () => 10_000,
    });
    const added = await catalog.addSource({
      kind: 'm3u',
      id: 'ua-src-1',
      name: 'Split UA Source',
      playlistUrl: 'https://h.example/list.m3u',
      transport: {
        userAgent: '  FeedAgent/1.0  ',
        streamUserAgent: '  PlayerAgent/2.0  ',
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.userAgent).toBe('FeedAgent/1.0');
    expect(added.value.streamUserAgent).toBe('PlayerAgent/2.0');

    const listed1 = await catalog.listSources();
    expect(listed1.find((r) => r.id === 'ua-src-1')).toMatchObject({
      userAgent: 'FeedAgent/1.0',
      streamUserAgent: 'PlayerAgent/2.0',
    });

    const updateSettings = catalog.updateSourceSettings;
    expect(updateSettings).toBeDefined();
    if (updateSettings === undefined) return;

    const updated = await updateSettings('ua-src-1', {
      transport: { streamUserAgent: 'UpdatedPlayer/3.0' },
    });
    expect(updated).toEqual({ ok: true, value: undefined });
    const listed2 = await catalog.listSources();
    expect(listed2.find((r) => r.id === 'ua-src-1')).toMatchObject({
      userAgent: 'FeedAgent/1.0',
      streamUserAgent: 'UpdatedPlayer/3.0',
    });

    // Clearing streamUserAgent with whitespace removes it while preserving userAgent.
    const cleared = await updateSettings('ua-src-1', {
      transport: { streamUserAgent: '   ' },
    });
    expect(cleared).toEqual({ ok: true, value: undefined });
    const listed3 = await catalog.listSources();
    const row3 = listed3.find((r) => r.id === 'ua-src-1');
    expect(row3?.userAgent).toBe('FeedAgent/1.0');
    expect(row3?.streamUserAgent).toBeUndefined();
    const stored = await getSource(t.db, 'ua-src-1');
    expect(stored?.settings.transport?.streamUserAgent).toBeUndefined();
    expect(stored?.settings.transport?.userAgent).toBe('FeedAgent/1.0');

    // Control characters are stripped/rejected when updating streamUserAgent.
    const unsafe = await updateSettings('ua-src-1', {
      transport: { streamUserAgent: 'Bad\r\nX-Inject: 1' },
    });
    expect(unsafe).toEqual({ ok: true, value: undefined });
    const stored2 = await getSource(t.db, 'ua-src-1');
    expect(stored2?.settings.transport?.streamUserAgent).toBe('BadX-Inject: 1');

    // Clearing userAgent removes it cleanly while leaving streamUserAgent intact.
    const clearedUa = await updateSettings('ua-src-1', {
      transport: { userAgent: '' },
    });
    expect(clearedUa).toEqual({ ok: true, value: undefined });
    const row4 = (await catalog.listSources()).find((r) => r.id === 'ua-src-1');
    expect(row4?.userAgent).toBeUndefined();
    expect(row4?.streamUserAgent).toBe('BadX-Inject: 1');

    await catalog.close();
  });
});
