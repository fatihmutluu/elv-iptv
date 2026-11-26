import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { getParentalSettings, listParentalLocks, setParentalLock } from './parental-repo';
import {
  createProfile,
  deleteProfile,
  isProfileAvatarToken,
  isValidProfileId,
  listProfiles,
  PROFILE_AVATAR_TOKENS,
  updateProfile,
} from './profiles-repo';
import { listRecentChannels, recordRecentChannel } from './recent-channels-repo';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { getTrackPreference, saveTrackPreference } from './track-preferences-repo';
import {
  listContinueWatching,
  listFavorites,
  saveWatchProgress,
  toggleFavorite,
} from './user-state';
import { decodeUserDataSnapshot, reconcileUserData, type UserDataStore } from './user-state-backup';

async function setup() {
  const handle = testDb();
  const opened = await openCatalog(handle.db);
  if (!opened.ok) throw new Error('openCatalog failed');
  const secrets = memorySecrets();
  let now = 10_000;
  const clock = () => (now += 100);
  return { ...handle, secrets, clock };
}

function memoryUserDataStore(): UserDataStore & { value: string | undefined } {
  const store = {
    value: undefined as string | undefined,
    read: () => store.value,
    write: (next: string) => {
      store.value = next;
    },
  };
  return store;
}

describe('profiles-repo (#15)', () => {
  it('seeds default profile on v14 migration and validates profile IDs and avatar tokens', async () => {
    const { db, close } = await setup();
    try {
      const profiles = await listProfiles(db);
      expect(profiles).toEqual([
        {
          id: 'default',
          name: 'Default',
          avatarToken: 'crimson',
          isKids: false,
          isDefault: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ]);

      // Auto-re-seeds default if table is ever cleared
      await db.run('DELETE FROM profiles');
      expect((await listProfiles(db)).map((p) => p.id)).toEqual(['default']);

      expect(PROFILE_AVATAR_TOKENS).toEqual([
        'crimson',
        'sapphire',
        'amber',
        'violet',
        'emerald',
        'slate',
        'coral',
        'teal',
        'indigo',
      ]);
      expect(isProfileAvatarToken('sapphire')).toBe(true);
      expect(isProfileAvatarToken('coral')).toBe(true);
      expect(isProfileAvatarToken('teal')).toBe(true);
      expect(isProfileAvatarToken('indigo')).toBe(true);
      expect(isProfileAvatarToken('neon')).toBe(false);
      expect(isValidProfileId('default')).toBe(true);
      expect(isValidProfileId('p_123-abc.ok')).toBe(true);
      expect(isValidProfileId('')).toBe(false);
      expect(isValidProfileId('a'.repeat(65))).toBe(false);
      expect(isValidProfileId('bad id')).toBe(false);
      expect(isValidProfileId('bad/id')).toBe(false);
      expect(isValidProfileId('bad:id')).toBe(false);
    } finally {
      close();
    }
  });

  it('creates, updates, and validates profiles, seeding kids parental policy on isKids: true', async () => {
    const { db, clock, close } = await setup();
    try {
      expect(await createProfile(db, { name: '   ' }, clock)).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-profile-name' },
      });
      expect(await createProfile(db, { name: 'x'.repeat(41) }, clock)).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-profile-name' },
      });
      expect(
        await createProfile(db, { name: 'Bad Avatar', avatarToken: 'invalid' as 'crimson' }, clock),
      ).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-avatar-token' },
      });
      expect(await createProfile(db, { name: 'Bad ID' }, clock, () => 'bad/id')).toEqual({
        ok: false,
        error: { category: 'storage', code: 'invalid-profile-id' },
      });

      const adult = await createProfile(
        db,
        { name: '  Living Room  ', avatarToken: 'sapphire' },
        clock,
        () => 'living',
      );
      expect(adult.ok).toBe(true);
      if (!adult.ok) return;
      expect(adult.value.name).toBe('Living Room');
      expect(adult.value.avatarToken).toBe('sapphire');
      expect(adult.value.isKids).toBe(false);
      expect(adult.value.isDefault).toBe(false);

      // Duplicate ID fails cleanly
      expect(await createProfile(db, { name: 'Dup' }, clock, () => 'living')).toEqual({
        ok: false,
        error: { category: 'storage', code: 'profile-write-failed' },
      });

      // Kids profile seeds enabled parental settings with maxRatingAge: 12
      const kids = await createProfile(
        db,
        { name: 'Kids', avatarToken: 'emerald', isKids: true },
        clock,
        () => 'kids',
      );
      expect(kids.ok).toBe(true);
      const kidsSettings = await getParentalSettings(db, 'kids');
      expect(kidsSettings.enabled).toBe(true);
      expect(kidsSettings.blockAdultKeywords).toBe(true);
      expect(kidsSettings.maxRatingAge).toBe(12);
      expect(kidsSettings.unlockTimeoutMin).toBe(30);

      // Update validations & success
      expect(await updateProfile(db, 'bad/id', { name: 'X' }, clock)).toEqual({
        ok: false,
        error: { category: 'storage', code: 'profile-not-found' },
      });
      expect(await updateProfile(db, 'missing', { name: 'X' }, clock)).toEqual({
        ok: false,
        error: { category: 'storage', code: 'profile-not-found' },
      });
      expect(await updateProfile(db, 'living', { name: '' }, clock)).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-profile-name' },
      });
      expect(await updateProfile(db, 'living', { avatarToken: 'bad' as 'crimson' }, clock)).toEqual(
        {
          ok: false,
          error: { category: 'source-format', code: 'invalid-avatar-token' },
        },
      );

      const updated = await updateProfile(
        db,
        'living',
        { name: 'Cinema Room', avatarToken: 'amber', isKids: true },
        clock,
      );
      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.value.name).toBe('Cinema Room');
        expect(updated.value.avatarToken).toBe('amber');
        expect(updated.value.isKids).toBe(true);
      }

      const listed = await listProfiles(db);
      expect(listed.map((p) => p.id)).toEqual(['default', 'living', 'kids']);
    } finally {
      close();
    }
  });

  it('isolates user state across profiles, refuses deleting last profile, and cascades deletes + SecretStore PIN', async () => {
    const { db, secrets, clock, close } = await setup();
    try {
      // Seed catalog rows so recent_channels join resolves
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
      );
      await db.run(
        "INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:live:1', 'News One', 'news one', 1)",
      );

      // Cannot delete last remaining profile
      expect(await deleteProfile(db, secrets, 'default')).toEqual({
        ok: false,
        error: { category: 'storage', code: 'cannot-delete-last-profile' },
      });
      expect(await deleteProfile(db, secrets, 'missing')).toEqual({
        ok: false,
        error: { category: 'storage', code: 'profile-not-found' },
      });
      expect(await deleteProfile(db, secrets, 'bad/id')).toEqual({
        ok: false,
        error: { category: 'storage', code: 'profile-not-found' },
      });

      const p2 = await createProfile(db, { name: 'Kids', isKids: true }, clock, () => 'kids');
      expect(p2.ok).toBe(true);

      // Write isolated user state for both 'default' and 'kids'
      await saveWatchProgress(
        db,
        {
          profileId: 'default',
          sourceId: 's1',
          itemKey: 'm:s1:movie:a',
          kind: 'movie',
          title: 'Adult Movie',
          positionMs: 30_000,
          durationMs: 120_000,
        },
        clock,
      );
      await saveWatchProgress(
        db,
        {
          profileId: 'kids',
          sourceId: 's1',
          itemKey: 'm:s1:movie:b',
          kind: 'movie',
          title: 'Kids Cartoon',
          positionMs: 40_000,
          durationMs: 120_000,
        },
        clock,
      );
      await toggleFavorite(
        db,
        {
          profileId: 'default',
          sourceId: 's1',
          itemKey: 'm:s1:movie:a',
          kind: 'movie',
          title: 'Adult Movie',
        },
        clock,
      );
      await toggleFavorite(
        db,
        {
          profileId: 'kids',
          sourceId: 's1',
          itemKey: 'm:s1:movie:b',
          kind: 'movie',
          title: 'Kids Cartoon',
        },
        clock,
      );
      await saveTrackPreference(
        db,
        { profileId: 'default', scopeKey: 'm:s1:movie:a', sourceId: 's1', audioLang: 'en' },
        clock,
      );
      await saveTrackPreference(
        db,
        { profileId: 'kids', scopeKey: 'm:s1:movie:b', sourceId: 's1', audioLang: 'tr' },
        clock,
      );
      await recordRecentChannel(db, 'm:s1:live:1', 's1', 'default', 1_000);
      await recordRecentChannel(db, 'm:s1:live:1', 's1', 'kids', 2_000);
      await setParentalLock(
        db,
        {
          profileId: 'kids',
          sourceId: 's1',
          targetKind: 'category',
          itemKind: 'live',
          targetKey: 'cat1',
        },
        true,
        clock,
      );
      await secrets.set('profile.kids.pin', 'v1:salt:hash');
      await secrets.set('profile.default.pin', 'v1:salt:def');

      // Verify strict isolation
      expect((await listContinueWatching(db, 10, 'default')).map((r) => r.itemKey)).toEqual([
        'm:s1:movie:a',
      ]);
      expect((await listContinueWatching(db, 10, 'kids')).map((r) => r.itemKey)).toEqual([
        'm:s1:movie:b',
      ]);
      expect((await listFavorites(db, 10, 'default')).map((r) => r.itemKey)).toEqual([
        'm:s1:movie:a',
      ]);
      expect((await listFavorites(db, 10, 'kids')).map((r) => r.itemKey)).toEqual(['m:s1:movie:b']);
      expect((await getTrackPreference(db, 'm:s1:movie:a', 'default'))?.audioLang).toBe('en');
      expect(await getTrackPreference(db, 'm:s1:movie:b', 'default')).toBeNull();
      expect((await getTrackPreference(db, 'm:s1:movie:b', 'kids'))?.audioLang).toBe('tr');
      expect((await listRecentChannels(db, 10, 'kids')).map((c) => c.key)).toEqual(['m:s1:live:1']);

      // Delete 'kids' profile -> cascades all 7 tables + clears profile.kids.pin
      const delRes = await deleteProfile(db, secrets, 'kids');
      expect(delRes).toEqual(ok(undefined));
      expect((await listProfiles(db)).map((p) => p.id)).toEqual(['default']);
      expect(await listContinueWatching(db, 10, 'kids')).toEqual([]);
      expect(await listFavorites(db, 10, 'kids')).toEqual([]);
      expect(await getTrackPreference(db, 'm:s1:movie:b', 'kids')).toBeNull();
      expect(await listRecentChannels(db, 10, 'kids')).toEqual([]);
      expect(await listParentalLocks(db, 'kids')).toEqual([]);
      expect(await db.all("SELECT * FROM parental_settings WHERE profile_id = 'kids'")).toEqual([]);
      expect(await secrets.get('profile.kids.pin')).toBeUndefined();

      // Default profile's data & PIN remain untouched
      expect((await listContinueWatching(db, 10, 'default')).map((r) => r.itemKey)).toEqual([
        'm:s1:movie:a',
      ]);
      expect(await secrets.get('profile.default.pin')).toBe('v1:salt:def');

      // Creating another profile and deleting 'default' promotes remaining profile to isDefault
      await createProfile(db, { name: 'Guest' }, clock, () => 'guest');
      expect(await deleteProfile(db, secrets, 'default')).toEqual(ok(undefined));
      const remaining = await listProfiles(db);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe('guest');
      expect(remaining[0]?.isDefault).toBe(true);
    } finally {
      close();
    }
  });

  it('backs up and restores profiles through CatalogService and reconcileUserData (#15, #79)', async () => {
    const first = await setup();
    const purged = await setup();
    try {
      const store = memoryUserDataStore();
      const service = createCatalogService({
        db: first.db,
        secrets: first.secrets,
        scheduler: countingScheduler(),
        http: {
          get: vi.fn(async () =>
            ok({
              status: 200,
              headers: {},
              finalUrl: 'https://example.invalid',
              body: (async function* () {})(),
            }),
          ),
        },
        clock: first.clock,
        userData: store,
      });

      const renamed = await service.updateProfile?.('default', {
        name: 'Living Room',
        avatarToken: 'sapphire',
      });
      expect(renamed?.ok).toBe(true);
      const kids = await service.createProfile?.({
        name: 'Kids',
        avatarToken: 'emerald',
        isKids: true,
      });
      expect(kids?.ok).toBe(true);

      const snapshot = decodeUserDataSnapshot(store.value);
      expect(
        snapshot.profiles.map((p) => ({ name: p.name, avatar: p.avatar, isKids: p.isKids })),
      ).toEqual([
        { name: 'Living Room', avatar: 'sapphire', isKids: false },
        { name: 'Kids', avatar: 'emerald', isKids: true },
      ]);

      // Restore onto freshly purged v14 database
      const restored = await reconcileUserData(purged.db, store);
      expect(restored.profilesRestored).toBe(2);

      const restoredProfiles = await listProfiles(purged.db);
      expect(
        restoredProfiles.map((p) => ({
          name: p.name,
          avatarToken: p.avatarToken,
          isKids: p.isKids,
        })),
      ).toEqual([
        { name: 'Living Room', avatarToken: 'sapphire', isKids: false },
        { name: 'Kids', avatarToken: 'emerald', isKids: true },
      ]);
    } finally {
      first.close();
      purged.close();
    }
  });
});
