import { describe, expect, it, vi } from 'vitest';
import { openCatalog } from './migrate';
import { testDb } from './test-db';
import { enrichVodItem, getVodEnrichment } from './vod-enrichment-repo';
import { lookupLocalVodIndex } from './vod-rating-index';
import { cleanVodTitle } from './vod-title-cleaner';

describe('VOD metadata & local rating index enrichment (#215)', () => {
  describe('cleanVodTitle', () => {
    it('strips noisy IPTV prefixes, quality/codec/audio tags and extracts releaseYear', () => {
      expect(cleanVodTitle('TR: [4K] Solaris (1972) HEVC x265 TR-DUB')).toEqual({
        cleanTitle: 'Solaris',
        releaseYear: 1972,
        foldedTitle: 'solaris',
      });
      expect(cleanVodTitle('US | Metropolis [1927] (UHD) BLURAY MULTI SUB')).toEqual({
        cleanTitle: 'Metropolis',
        releaseYear: 1927,
        foldedTitle: 'metropolis',
      });
      expect(cleanVodTitle('[FHD] Big Buck Bunny 2008 1080p WEB-DL H.264')).toEqual({
        cleanTitle: 'Big Buck Bunny',
        releaseYear: 2008,
        foldedTitle: 'big buck bunny',
      });
    });

    it('preserves sequel numbers, roman numerals, and leading numeric titles', () => {
      expect(cleanVodTitle('The Godfather Part II [4K] (1974) HDR')).toEqual({
        cleanTitle: 'The Godfather Part II',
        releaseYear: 1974,
        foldedTitle: 'the godfather part ii',
      });
      expect(cleanVodTitle('TR: Mad Max 2 (1981) [FHD] ALT')).toEqual({
        cleanTitle: 'Mad Max 2',
        releaseYear: 1981,
        foldedTitle: 'mad max 2',
      });
      expect(cleanVodTitle('2001: A Space Odyssey (1968) [UHD]')).toEqual({
        cleanTitle: '2001: A Space Odyssey',
        releaseYear: 1968,
        foldedTitle: '2001 a space odyssey',
      });
      expect(cleanVodTitle('Blade Runner 2049 (2017) [4K]')).toEqual({
        cleanTitle: 'Blade Runner 2049',
        releaseYear: 2017,
        foldedTitle: 'blade runner 2049',
      });
    });

    it('falls back to existingYear when title has no year', () => {
      expect(cleanVodTitle('TR | Night of the Living Dead [FHD]', 1968)).toEqual({
        cleanTitle: 'Night of the Living Dead',
        releaseYear: 1968,
        foldedTitle: 'night of the living dead',
      });
    });
  });

  describe('lookupLocalVodIndex', () => {
    it('finds well-known public-domain and canonical titles offline', () => {
      const hit = lookupLocalVodIndex({
        cleanTitle: 'Night of the Living Dead',
        foldedTitle: 'night of the living dead',
        releaseYear: 1968,
        kind: 'movie',
      });
      expect(hit).not.toBeNull();
      expect(hit?.rating).toBeGreaterThan(7);
      expect(hit?.ratingSource).toBe('local-index');
      expect(hit?.genres?.length).toBeGreaterThan(0);
      expect(hit?.synopsis).toBeTruthy();

      const seriesHit = lookupLocalVodIndex({
        cleanTitle: 'The Twilight Zone',
        foldedTitle: 'the twilight zone',
        releaseYear: 1959,
        kind: 'series',
      });
      expect(seriesHit?.ratingSource).toBe('local-index');
    });
  });

  describe('enrichVodItem & SQLite cache persistence', () => {
    it('returns null with ZERO DB writes and ZERO remoteFetcher calls when disabled', async () => {
      const { db } = testDb();
      expect((await openCatalog(db)).ok).toBe(true);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 1, '{}')",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'm:s1:movie:1', 'TR: Solaris (1972) [4K]', 'tr solaris 1972 4k', 1)",
      );

      const remoteFetcher = vi.fn(async () => ({
        rating: 9.0,
        ratingSource: 'remote',
      }));
      const res = await enrichVodItem(db, 'm:s1:movie:1', {
        enabled: false,
        nowMs: 1_000_000,
        remoteFetcher,
      });
      expect(res).toBeNull();
      expect(remoteFetcher).not.toHaveBeenCalled();
      expect(await db.all('SELECT * FROM vod_enrichment')).toEqual([]);
    });

    it('enriches via local index, persists across restarts, respects TTL expiry, and calls remoteFetcher on local miss', async () => {
      const { db } = testDb();
      expect((await openCatalog(db)).ok).toBe(true);
      await db.run(
        "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'xtream', 'Main', 1, '{}')",
      );
      await db.run(
        "INSERT INTO movies (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:movie:1', 'TR: [4K] Solaris (1972) HEVC', 'tr 4k solaris 1972 hevc', 1)",
      );
      await db.run(
        "INSERT INTO series (source_id, key, name, name_fold, run_id) VALUES ('s1', 'x:s1:series:2', 'US | Unknown Indie Show (2025) [FHD]', 'us unknown indie show 2025 fhd', 1)",
      );

      const now = 1_700_000_000_000;
      const remoteFetcher = vi.fn(async () => ({
        rating: 8.3,
        ratingSource: 'open-db',
        genres: ['Drama', 'Mystery'],
        synopsis: 'Fetched remotely.',
        certification: 'TV-14',
      }));

      // 1. Local index hit -> ZERO remoteFetcher call
      const localRes = await enrichVodItem(db, 'x:s1:movie:1', {
        enabled: true,
        nowMs: now,
        remoteFetcher,
      });
      expect(localRes).not.toBeNull();
      expect(localRes?.cleanTitle).toBe('Solaris');
      expect(localRes?.releaseYear).toBe(1972);
      expect(localRes?.ratingSource).toBe('local-index');
      expect(localRes?.expiresAt).toBe(now + 7 * 86_400_000);
      expect(remoteFetcher).not.toHaveBeenCalled();

      // 2. Cached lookup persists in SQLite
      const cached = await getVodEnrichment(db, 'x:s1:movie:1', now + 1000);
      expect(cached).toEqual(localRes);

      // 3. Expired cache returns null from getVodEnrichment and refreshes on enrichVodItem
      const afterExpiry = now + 8 * 86_400_000;
      expect(await getVodEnrichment(db, 'x:s1:movie:1', afterExpiry)).toBeNull();

      // 4. Local miss invokes optional remoteFetcher and caches result
      const remoteRes = await enrichVodItem(db, 'x:s1:series:2', {
        enabled: true,
        nowMs: now,
        remoteFetcher,
      });
      expect(remoteFetcher).toHaveBeenCalledTimes(1);
      expect(remoteRes?.cleanTitle).toBe('Unknown Indie Show');
      expect(remoteRes?.releaseYear).toBe(2025);
      expect(remoteRes?.rating).toBe(8.3);
      expect(remoteRes?.ratingSource).toBe('open-db');
      expect(remoteRes?.genres).toEqual(['Drama', 'Mystery']);
      expect(remoteRes?.certification).toBe('TV-14');

      // 5. Second call hits SQLite cache without invoking remoteFetcher again
      const cachedRemote = await enrichVodItem(db, 'x:s1:series:2', {
        enabled: true,
        nowMs: now + 60_000,
        remoteFetcher,
      });
      expect(remoteFetcher).toHaveBeenCalledTimes(1);
      expect(cachedRemote).toEqual(remoteRes);

      // 6. After TTL expiry, remoteFetcher is called again
      const refreshed = await enrichVodItem(db, 'x:s1:series:2', {
        enabled: true,
        nowMs: afterExpiry,
        remoteFetcher,
      });
      expect(remoteFetcher).toHaveBeenCalledTimes(2);
      expect(refreshed?.fetchedAt).toBe(afterExpiry);
    });
  });
});
