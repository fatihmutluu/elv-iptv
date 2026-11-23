import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import {
  buildCategorySelection,
  clearPendingCategories,
  countPendingCategories,
  discoveredCategoryKey,
  initialSelectedCategoryKeys,
  mergePendingCategories,
} from './category-selection-model';
import { createLazyCatalog } from './lazy-catalog';
import { createInitialSourceForm, isValidIanaTimeZone, validateSourceForm } from './validate';

describe('Wave C3 source validation & category helpers (#51, #39, #182)', () => {
  it('accepts local M3U file submissions without requiring an HTTP URL (#51)', () => {
    const form = {
      ...createInitialSourceForm(),
      mode: 'm3u' as const,
      localFile: {
        name: 'Living Room.m3u8',
        bytes: new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Ch 1\nhttp://127.0.0.1/1.ts\n'),
      },
      xmltvTimezone: 'Europe/Istanbul',
      allowLegacyTls: true,
    };
    const res = validateSourceForm(form);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe('local-m3u');
    if (res.value.kind !== 'local-m3u') return;
    expect(res.value.input.name).toBe('Living Room');
    expect(res.value.input.xmltvTimezone).toBe('Europe/Istanbul');
    expect(res.value.input.transport?.allowLegacyTls).toBe(true);
  });

  it('validates IANA XMLTV timezones and opt-in legacy TLS (#182)', () => {
    expect(isValidIanaTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
    expect(isValidIanaTimeZone('Not/A_Zone')).toBe(false);

    const invalid = validateSourceForm({
      ...createInitialSourceForm(),
      mode: 'm3u',
      playlistUrl: 'http://127.0.0.1/list.m3u8',
      xmltvTimezone: 'Mars/Olympus',
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid-timezone');

    const valid = validateSourceForm({
      ...createInitialSourceForm(),
      mode: 'xtream',
      server: 'http://127.0.0.1:8080',
      username: 'u',
      password: 'p',
      xmltvTimezone: 'America/New_York',
      allowLegacyTls: true,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok && valid.value.kind === 'xtream') {
      expect(valid.value.input.xmltvTimezone).toBe('America/New_York');
      expect(valid.value.input.transport?.allowLegacyTls).toBe(true);
    }
  });

  it('builds category selection allowlists and reconciles pending categories (#39)', () => {
    const discovered = [
      { id: '1', name: 'News', kind: 'live' as const, itemCount: 10 },
      { id: '2', name: 'Sports', kind: 'live' as const, itemCount: 25 },
      { id: '10', name: 'Action', kind: 'movie' as const, itemCount: 40 },
    ];
    const initial = initialSelectedCategoryKeys(discovered, undefined);
    expect(initial.size).toBe(3);

    initial.delete(discoveredCategoryKey('live', '2'));
    const selection = buildCategorySelection(discovered, initial);
    expect(selection).toEqual({
      live: ['1'],
      knownLive: ['1', '2'],
      movie: ['10'],
      knownMovie: ['10'],
    });

    const withPending = {
      ...selection,
      pendingLive: ['3'],
      pendingMovie: ['11', '12'],
    };
    expect(countPendingCategories(withPending)).toBe(3);

    const merged = mergePendingCategories(withPending);
    expect(merged.live).toEqual(['1', '3']);
    expect(merged.movie).toEqual(['10', '11', '12']);
    expect(countPendingCategories(merged)).toBe(0);

    const dismissed = clearPendingCategories(withPending);
    expect(dismissed.live).toEqual(['1']);
    expect(countPendingCategories(dismissed)).toBe(0);
  });

  it('forwards Wave C3 methods through createLazyCatalog', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    const stored = new Map<string, Uint8Array>();
    const underlying = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get() {
          return ok({ status: 200, headers: {}, body: { async *[Symbol.asyncIterator]() {} } });
        },
      },
      clock: () => 1_000,
      localPlaylistStore: {
        async write(id, bytes) {
          stored.set(id, bytes);
        },
        async openRead(id) {
          const bytes = stored.get(id);
          if (!bytes) return undefined;
          return {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          };
        },
        async remove(id) {
          stored.delete(id);
        },
      },
    });

    const lazy = createLazyCatalog(async () => underlying);

    const added = await lazy.addLocalM3uSource?.({
      name: 'Local Test',
      bytes: new TextEncoder().encode(
        '#EXTM3U\n#EXTINF:-1 group-title="Sports",Arena HD\nhttp://127.0.0.1/1.ts\n',
      ),
    });
    expect(added?.ok).toBe(true);
    if (!added?.ok) return;

    const discovered = await lazy.discoverSourceCategories?.(added.value.id);
    expect(discovered?.ok).toBe(true);
    if (discovered?.ok) {
      expect(discovered.value.length).toBe(1);
    }

    await lazy.updateSourceSettings?.(added.value.id, { xmltvTimezone: 'UTC' });

    const sources = await lazy.listSources();
    expect(sources[0]?.isLocalPlaylist).toBe(true);
    expect(sources[0]?.xmltvTimezone).toBe('UTC');

    expect(await lazy.liveVariants?.('missing')).toEqual([]);
    expect(await lazy.itemVersions?.('missing')).toEqual([]);

    await lazy.close();
    handle.close();
  });
});
