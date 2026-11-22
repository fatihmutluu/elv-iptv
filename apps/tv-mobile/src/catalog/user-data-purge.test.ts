import {
  DEFAULT_USER_DATA_MAX_BYTES,
  type ManifestStore,
  reconcileManifest,
  reconcileUserData,
  type UserDataStore,
} from '@elv/data';
import { memorySecrets } from '@elv/data/testing';
import { describe, expect, it } from 'vitest';
import { addAccount, env, must, useSim } from './catalog-test-env';

const sim = useSim();

function memoryKv(
  maxBytes?: number,
): ManifestStore & UserDataStore & { value: string | undefined } {
  return {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    value: undefined,
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
    },
  };
}

describe('tvOS Library/Caches purge recovery (#79, ADR 0014)', () => {
  it('restores sources, favorites, and watch progress after catalog.db is deleted with zero secrets leaked', async () => {
    const manifest = memoryKv();
    const userData = memoryKv(DEFAULT_USER_DATA_MAX_BYTES);
    const secrets = memorySecrets();

    const before = await env({ manifest, userData, secrets });
    const sourceId = await addAccount(before, sim.url(), 'demo', 'Living Room');
    must(await before.service.importSource(sourceId));

    const liveCats = await before.service.categories(sourceId, 'live');
    const liveItems = await before.service.items(liveCats[0]?.id ?? '', 0, 5);
    const movieCats = await before.service.categories(sourceId, 'movie');
    const movieItems = await before.service.items(movieCats[0]?.id ?? '', 0, 5);

    const favChannel = liveItems[0];
    const vodMovie = movieItems[0];
    expect(favChannel).toBeDefined();
    expect(vodMovie).toBeDefined();
    if (!favChannel || !vodMovie) return;

    const toggleFavoriteBefore = before.service.toggleFavorite;
    const saveProgressBefore = before.service.saveProgress;
    expect(toggleFavoriteBefore).toBeDefined();
    expect(saveProgressBefore).toBeDefined();
    if (!toggleFavoriteBefore || !saveProgressBefore) return;

    const addedFav = must(
      await toggleFavoriteBefore({
        sourceId,
        itemKey: favChannel.key,
        kind: 'live',
        title: favChannel.name,
        logo: 'https://cdn.example.invalid/logo.png',
      }),
    );
    expect(addedFav).toBe(true);

    must(
      await saveProgressBefore({
        sourceId,
        itemKey: vodMovie.key,
        kind: 'movie',
        title: vodMovie.name,
        positionMs: 420_000,
        durationMs: 3_600_000,
      }),
    );

    const credLogo = `https://${'demo'}:${'supersecret'}@cdn.example.invalid/icon.png?${'token'}=${'tok123'}`;
    const addedCredentialedLogoFav = must(
      await toggleFavoriteBefore({
        sourceId,
        itemKey: 'custom:cred-test',
        kind: 'live',
        title: 'Credential Guard Channel',
        logo: credLogo,
      }),
    );
    expect(addedCredentialedLogoFav).toBe(true);

    // Zero credentials may ever enter manifest or user-data storage (Keychain-only invariant).
    for (const forbidden of ['demo', sim.url(), '127.0.0.1']) {
      expect(manifest.value ?? '').not.toContain(forbidden);
    }
    for (const secret of ['demo', 'supersecret', 'tok123']) {
      expect(userData.value ?? '').not.toContain(secret);
    }

    // Simulate tvOS purging Library/Caches/catalog.db completely: brand-new empty SQLite database.
    const after = await env({ manifest, userData, secrets });
    const restoredSources = await reconcileManifest(after.db, manifest);
    const restoredUser = await reconcileUserData(after.db, userData);

    expect(restoredSources).toEqual([sourceId]);
    expect(restoredUser).toEqual({ favoritesRestored: 2, progressRestored: 1 });

    const sources = await after.service.listSources();
    expect(sources.map((s) => s.id)).toEqual([sourceId]);
    expect(sources[0]?.needsImport).toBe(true);

    const listFavoriteKeysAfter = after.service.listFavoriteKeys;
    const listFavoritesAfter = after.service.listFavorites;
    const getProgressAfter = after.service.getProgress;
    const listContinueWatchingAfter = after.service.listContinueWatching;
    expect(listFavoriteKeysAfter).toBeDefined();
    expect(listFavoritesAfter).toBeDefined();
    expect(getProgressAfter).toBeDefined();
    expect(listContinueWatchingAfter).toBeDefined();
    if (
      !listFavoriteKeysAfter ||
      !listFavoritesAfter ||
      !getProgressAfter ||
      !listContinueWatchingAfter
    ) {
      return;
    }

    const favKeys = await listFavoriteKeysAfter();
    expect(favKeys).toEqual(expect.arrayContaining([favChannel.key, 'custom:cred-test']));
    const favorites = await listFavoritesAfter(10);
    const restoredPrimary = favorites.find((f) => f.itemKey === favChannel.key);
    const restoredGuarded = favorites.find((f) => f.itemKey === 'custom:cred-test');
    expect(restoredPrimary?.title).toBe(favChannel.name);
    expect(restoredGuarded?.logo).toBeNull();

    const progress = await getProgressAfter(vodMovie.key);
    expect(progress?.positionMs).toBe(420_000);
    expect(progress?.durationMs).toBe(3_600_000);
    expect(progress?.watched).toBe(false);

    const cw = await listContinueWatchingAfter(10);
    expect(cw.map((r) => r.itemKey)).toEqual([vodMovie.key]);

    // Source re-import works seamlessly using credentials kept strictly in SecretStore (Keychain).
    const reimported = must(await after.service.importSource(sourceId));
    expect(reimported.counts.live).toBeGreaterThan(0);
    expect(await listFavoriteKeysAfter()).toEqual(
      expect.arrayContaining([favChannel.key, 'custom:cred-test']),
    );
  });
});
