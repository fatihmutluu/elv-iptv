import type { HttpClient, SqlDriver } from '@elv/domain';
import { elvError, err } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import {
  addFailoverGroupMember,
  applySuggestedFailoverGroups,
  createFailoverGroup,
  deleteFailoverGroup,
  getFailoverGroupByChannel,
  listFailoverGroups,
  pruneSourceFailoverMembers,
  removeFailoverGroupMember,
  renameFailoverGroup,
  reorderFailoverGroupMembers,
  suggestFailoverGroups,
} from './failover-groups-repo';
import { foldText } from './fold';
import { openCatalog } from './migrate';
import { removeSource } from './sources';
import { memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

async function seedSourceAndChannels(
  db: SqlDriver,
  sourceId: string,
  sourceName: string,
  channels: readonly { key: string; name: string; logo?: string | null; guideId?: string | null }[],
): Promise<void> {
  await db.run(
    "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES (?, 'm3u', ?, ?, '{}')",
    [sourceId, sourceName, 1_000],
  );
  for (const ch of channels) {
    await db.run(
      `INSERT INTO live (source_id, key, name, name_fold, logo, guide_id, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [sourceId, ch.key, ch.name, foldText(ch.name), ch.logo ?? null, ch.guideId ?? null],
    );
  }
}

const noopHttp: HttpClient = {
  get: async () => err(elvError('network', 'not-implemented')),
};
const noopScheduler = { yieldNow: async () => undefined };

describe('failover-groups-repo (#157)', () => {
  it('supports CRUD, member hydration, idempotent add, removal compaction, and transactional reorder', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    await seedSourceAndChannels(db, 's1', 'Provider Alpha', [
      { key: 'm:s1:live:1', name: 'TRT 1 HD', logo: 'https://a.example/trt1.png' },
    ]);
    await seedSourceAndChannels(db, 's2', 'Provider Beta', [
      { key: 'm:s2:live:1', name: 'TRT 1 FHD', logo: 'https://b.example/trt1.png' },
    ]);
    await seedSourceAndChannels(db, 's3', 'Provider Gamma', [
      { key: 'm:s3:live:1', name: 'TRT 1 4K', logo: null },
    ]);

    const invalidName = await createFailoverGroup(db, { name: '   ' });
    expect(invalidName.ok).toBe(false);

    const created = await createFailoverGroup(db, {
      id: 'fg-trt1',
      name: '  TRT 1  ',
      channelKeys: ['m:s1:live:1', 'm:s2:live:1', 'm:s1:live:1'],
      nowMs: 1_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toBe('fg-trt1');
    expect(created.value.name).toBe('TRT 1');
    expect(created.value.autoMatched).toBe(false);
    expect(created.value.members).toEqual([
      {
        groupId: 'fg-trt1',
        sourceId: 's1',
        channelKey: 'm:s1:live:1',
        position: 0,
        channelName: 'TRT 1 HD',
        logo: 'https://a.example/trt1.png',
        sourceName: 'Provider Alpha',
      },
      {
        groupId: 'fg-trt1',
        sourceId: 's2',
        channelKey: 'm:s2:live:1',
        position: 1,
        channelName: 'TRT 1 FHD',
        logo: 'https://b.example/trt1.png',
        sourceName: 'Provider Beta',
      },
    ]);

    // Add third member + verify idempotency when adding an existing member
    const added3 = await addFailoverGroupMember(db, 'fg-trt1', 'm:s3:live:1', 2_000);
    expect(added3.ok).toBe(true);
    if (!added3.ok) return;
    expect(added3.value.members.map((m) => [m.channelKey, m.position])).toEqual([
      ['m:s1:live:1', 0],
      ['m:s2:live:1', 1],
      ['m:s3:live:1', 2],
    ]);

    const addedDup = await addFailoverGroupMember(db, 'fg-trt1', 'm:s2:live:1', 2_500);
    expect(addedDup.ok).toBe(true);
    if (!addedDup.ok) return;
    expect(addedDup.value.members).toHaveLength(3);

    // Reorder members and verify persisted order
    const reordered = await reorderFailoverGroupMembers(
      db,
      'fg-trt1',
      ['m:s3:live:1', 'm:s1:live:1', 'm:s2:live:1'],
      3_000,
    );
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;
    expect(reordered.value.members.map((m) => [m.channelKey, m.position])).toEqual([
      ['m:s3:live:1', 0],
      ['m:s1:live:1', 1],
      ['m:s2:live:1', 2],
    ]);

    const lookedUp = await getFailoverGroupByChannel(db, 'm:s1:live:1');
    expect(lookedUp?.id).toBe('fg-trt1');
    expect(lookedUp?.members.map((m) => m.channelKey)).toEqual([
      'm:s3:live:1',
      'm:s1:live:1',
      'm:s2:live:1',
    ]);

    // Remove middle member and verify positions compact to 0..1
    const afterRemove = await removeFailoverGroupMember(db, 'fg-trt1', 'm:s1:live:1', 4_000);
    expect(afterRemove.ok).toBe(true);
    if (!afterRemove.ok) return;
    expect(afterRemove.value.members.map((m) => [m.channelKey, m.position])).toEqual([
      ['m:s3:live:1', 0],
      ['m:s2:live:1', 1],
    ]);

    // Rename & list
    const renamed = await renameFailoverGroup(db, 'fg-trt1', 'TRT 1 National', 5_000);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.name).toBe('TRT 1 National');
    expect((await listFailoverGroups(db)).map((g) => g.name)).toEqual(['TRT 1 National']);

    // Delete
    expect((await deleteFailoverGroup(db, 'fg-trt1')).ok).toBe(true);
    expect(await listFailoverGroups(db)).toEqual([]);
    expect(await getFailoverGroupByChannel(db, 'm:s3:live:1')).toBeUndefined();

    // Error paths for invalid IDs and missing groups
    expect((await createFailoverGroup(db, { id: 'bad id!', name: 'Valid' })).ok).toBe(false);
    expect((await renameFailoverGroup(db, 'missing', 'New')).ok).toBe(false);
    expect((await addFailoverGroupMember(db, 'missing', 'm:s1:live:1')).ok).toBe(false);
    expect((await removeFailoverGroupMember(db, 'missing', 'm:s1:live:1')).ok).toBe(false);
    expect((await reorderFailoverGroupMembers(db, 'missing', ['m:s1:live:1'])).ok).toBe(false);
  });

  it('prunes failover members when a source is removed and compacts remaining positions', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();

    await seedSourceAndChannels(db, 's1', 'Provider A', [{ key: 'm:s1:live:1', name: 'News 1' }]);
    await seedSourceAndChannels(db, 's2', 'Provider B', [{ key: 'm:s2:live:1', name: 'News 1' }]);
    await seedSourceAndChannels(db, 's3', 'Provider C', [{ key: 'm:s3:live:1', name: 'News 1' }]);

    const created = await createFailoverGroup(db, {
      id: 'fg-news',
      name: 'News 1',
      channelKeys: ['m:s1:live:1', 'm:s2:live:1', 'm:s3:live:1'],
      nowMs: 1_000,
    });
    expect(created.ok).toBe(true);

    // removeSource must purge failover_group_members for s2 and compact s1->0, s3->1
    expect((await removeSource('s2', { db, secrets })).ok).toBe(true);
    const remaining = await listFailoverGroups(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.members.map((m) => [m.sourceId, m.channelKey, m.position])).toEqual([
      ['s1', 'm:s1:live:1', 0],
      ['s3', 'm:s3:live:1', 1],
    ]);

    // Direct pruneSourceFailoverMembers removes s1 and leaves s3 at position 0
    const pruned = await pruneSourceFailoverMembers(db, 's1');
    expect(pruned).toBe(1);
    const afterDirect = await listFailoverGroups(db);
    expect(afterDirect[0]?.members.map((m) => [m.sourceId, m.position])).toEqual([['s3', 0]]);
  });

  it('suggests cross-source clusters by guide_id and normalized names, ignoring same-source duplicates and already-grouped channels', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);

    await seedSourceAndChannels(db, 's1', 'Source 1', [
      { key: 'm:s1:live:1', name: '[TR] TRT 1 FHD', guideId: 'TRT1.tr' },
      { key: 'm:s1:live:2', name: 'TR | İstanbul Haber 4K HEVC 50FPS', guideId: null },
      { key: 'm:s1:live:3', name: 'Solo Sports HD', guideId: null },
      { key: 'm:s1:live:4', name: 'Solo Sports 4K', guideId: null }, // same-source duplicate only
      { key: 'm:s1:live:5', name: 'Already Grouped HD', guideId: 'grouped.tv' },
    ]);
    await seedSourceAndChannels(db, 's2', 'Source 2', [
      { key: 'm:s2:live:1', name: 'TRT Bir Backup (SD)', guideId: ' trt1.tr ' }, // matches by guide_id!
      { key: 'm:s2:live:2', name: 'US: ISTANBUL HABER (HD) H264 RAW BACKUP', guideId: null }, // matches by normalized Turkish name!
      { key: 'm:s2:live:5', name: 'Already Grouped FHD', guideId: 'grouped.tv' },
    ]);

    // Pre-group channel 5 so it is excluded from suggestions
    const existing = await createFailoverGroup(db, {
      id: 'fg-existing',
      name: 'Already Grouped',
      channelKeys: ['m:s1:live:5', 'm:s2:live:5'],
      nowMs: 1_000,
    });
    expect(existing.ok).toBe(true);

    const suggestions = await suggestFailoverGroups(db);
    expect(suggestions).toHaveLength(2);

    const byGuide = suggestions.find((c) => c.matchReason === 'guide-id');
    expect(byGuide).toBeDefined();
    expect(byGuide?.members.map((m) => m.channelKey)).toEqual(['m:s1:live:1', 'm:s2:live:1']);

    const byName = suggestions.find((c) => c.matchReason === 'name');
    expect(byName).toBeDefined();
    expect(byName?.members.map((m) => m.channelKey)).toEqual(['m:s1:live:2', 'm:s2:live:2']);

    // Apply suggestions in one transaction -> auto_matched = true
    const applied = await applySuggestedFailoverGroups(db, suggestions, 2_000);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value).toHaveLength(2);
    expect(applied.value.every((g) => g.autoMatched)).toBe(true);

    // Re-running suggestions now yields empty because all matched channels are already grouped
    expect(await suggestFailoverGroups(db)).toEqual([]);
  });

  it('exposes failover group operations on CatalogService and createCoalescedCatalog', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    await seedSourceAndChannels(db, 's1', 'A', [{ key: 'm:s1:live:1', name: 'Alpha News HD' }]);
    await seedSourceAndChannels(db, 's2', 'B', [
      { key: 'm:s2:live:1', name: '[US] Alpha News 4K' },
    ]);

    const raw = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler,
      http: noopHttp,
      clock: () => 5_000,
    });
    const svc = createCoalescedCatalog(raw, { windowMs: 0 });

    const suggestions = await svc.suggestFailoverGroups?.();
    expect(suggestions).toHaveLength(1);
    const applied = await svc.applySuggestedFailoverGroups?.(suggestions ?? []);
    expect(applied?.ok).toBe(true);
    const groups = await svc.listFailoverGroups?.();
    expect(groups).toHaveLength(1);
    const groupId = groups?.[0]?.id ?? '';
    expect((await svc.getFailoverGroupByChannel?.('m:s1:live:1'))?.id).toBe(groupId);
    expect((await svc.renameFailoverGroup?.(groupId, 'Alpha News'))?.ok).toBe(true);
    expect(
      (await svc.reorderFailoverGroupMembers?.(groupId, ['m:s2:live:1', 'm:s1:live:1']))?.ok,
    ).toBe(true);
    expect((await svc.removeFailoverGroupMember?.(groupId, 'm:s1:live:1'))?.ok).toBe(true);
    expect((await svc.addFailoverGroupMember?.(groupId, 'm:s1:live:1'))?.ok).toBe(true);
    expect((await svc.deleteFailoverGroup?.(groupId))?.ok).toBe(true);
    expect(await svc.listFailoverGroups?.()).toEqual([]);

    await svc.close();
  });
});
