import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import {
  constantTimeHexEqual,
  hashParentalPin,
  isAdultKeywordMatch,
  isValidParentalPin,
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MS,
  parseRatingAge,
  pinSecretKey,
  verifyParentalPinHash,
} from './parental-policy';
import {
  getParentalSettings,
  listParentalLocks,
  loadActiveParentalFilter,
  setParentalLock,
  updateParentalSettings,
} from './parental-repo';
import { countingScheduler, memorySecrets, testDb } from './test-db';

function bytesStream(text: string): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return (async function* () {
    yield bytes;
  })();
}

function makeMockHttp(routes: Record<string, string>): HttpClient {
  return {
    async get(url) {
      const matched = Object.entries(routes).find(([key]) => url.startsWith(key));
      const body = matched?.[1] ?? '';
      return ok({
        status: matched ? 200 : 404,
        headers: { 'content-type': 'text/plain' },
        finalUrl: url,
        body: bytesStream(body),
      });
    },
  };
}

async function setupService(routes: Record<string, string> = {}) {
  const handle = testDb();
  const opened = await openCatalog(handle.db);
  if (!opened.ok) throw new Error('openCatalog failed');
  const secrets = memorySecrets();
  let nowMs = 1_000_000;
  let idSeq = 0;
  const service = createCatalogService({
    db: handle.db,
    secrets,
    scheduler: countingScheduler(),
    http: makeMockHttp(routes),
    clock: () => nowMs,
    newId: () => `s${++idSeq}`,
  });
  return {
    ...handle,
    secrets,
    service,
    getNow: () => nowMs,
    advanceClock: (deltaMs: number) => {
      nowMs += deltaMs;
    },
  };
}

describe('parental-policy pure helpers (#31)', () => {
  it('hashes and verifies 4..8 digit PINs with salted pure-TS SHA-256 and constant-time equality', () => {
    expect(isValidParentalPin('1234')).toBe(true);
    expect(isValidParentalPin('00001234')).toBe(true);
    expect(isValidParentalPin('123')).toBe(false);
    expect(isValidParentalPin('123456789')).toBe(false);
    expect(isValidParentalPin('12ab')).toBe(false);
    expect(isValidParentalPin(1234)).toBe(false);

    expect(pinSecretKey()).toBe('profile.default.pin');
    expect(pinSecretKey('kids')).toBe('profile.kids.pin');

    const h1 = hashParentalPin('2468');
    const h2 = hashParentalPin('2468');
    expect(h1).toMatch(/^v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain('2468');

    expect(verifyParentalPinHash('2468', h1)).toBe(true);
    expect(verifyParentalPinHash('2469', h1)).toBe(false);
    expect(verifyParentalPinHash('12', h1)).toBe(false);
    expect(verifyParentalPinHash('2468', 'corrupt')).toBe(false);
    expect(constantTimeHexEqual('abcd', 'abcd')).toBe(true);
    expect(constantTimeHexEqual('abcd', 'abce')).toBe(false);
    expect(constantTimeHexEqual('abc', 'abcd')).toBe(false);

    expect(() => hashParentalPin('bad')).toThrow();
    expect(() => hashParentalPin('1234', 'short-salt')).toThrow();
  });

  it('matches adult keywords with strict token boundaries and zero false positives', () => {
    const positives = [
      '18+',
      '+18',
      'TR | 18+ VIP',
      'VIP [+18] HD',
      'XXX Movies',
      'Adult Channels',
      'Adults Only',
      'Movies For Adults',
      'Late Night Erotic',
      'Erotica Cinema',
      'Porn HD',
      'Porno Live',
      'NSFW Clips',
      'Yetişkin Kanallar',
      'yetiskin vod',
    ];
    for (const sample of positives) {
      expect(isAdultKeywordMatch(sample), `expected true for ${sample}`).toBe(true);
    }

    const negatives = [
      '',
      '   ',
      'Adultery Drama',
      '1800 History',
      'Apollo 18',
      'Channel 18 HD',
      '2018+ Hits',
      '+180 Days',
      'Family Cinema',
      'Kids Cartoons',
    ];
    for (const sample of negatives) {
      expect(isAdultKeywordMatch(sample), `expected false for ${sample}`).toBe(false);
    }
  });

  it('parses broadcast & XMLTV parental ratings into minimum ages', () => {
    expect(parseRatingAge('TV-MA')).toBe(18);
    expect(parseRatingAge('NC-17')).toBe(18);
    expect(parseRatingAge('R')).toBe(18);
    expect(parseRatingAge('X')).toBe(18);
    expect(parseRatingAge('18+')).toBe(18);
    expect(parseRatingAge('18')).toBe(18);
    expect(parseRatingAge('US:TV-MA')).toBe(18);
    expect(parseRatingAge('16+')).toBe(16);
    expect(parseRatingAge('16')).toBe(16);
    expect(parseRatingAge('15')).toBe(15);
    expect(parseRatingAge('TV-14')).toBe(14);
    expect(parseRatingAge('14+')).toBe(14);
    expect(parseRatingAge('PG-13')).toBe(13);
    expect(parseRatingAge('13+')).toBe(13);
    expect(parseRatingAge('12+')).toBe(12);
    expect(parseRatingAge('12')).toBe(12);
    expect(parseRatingAge('PG')).toBe(12);
    expect(parseRatingAge('TV-PG')).toBe(7);
    expect(parseRatingAge('7+')).toBe(7);
    expect(parseRatingAge('7')).toBe(7);
    expect(parseRatingAge('G')).toBe(0);
    expect(parseRatingAge('TV-G')).toBe(0);
    expect(parseRatingAge('TV-Y')).toBe(0);
    expect(parseRatingAge('21+')).toBe(21);
    expect(parseRatingAge('NR')).toBeNull();
    expect(parseRatingAge('')).toBeNull();
    expect(parseRatingAge(null)).toBeNull();
    expect(parseRatingAge(undefined)).toBeNull();
  });
});

describe('PIN storage, rate limiting, and settings/locks CRUD (#31)', () => {
  it('stores salted PIN strictly in SecretStore (never SQLite), enforces currentPin on change/clear, and locks out after 5 wrong attempts', async () => {
    const { db, secrets, service, getNow, advanceClock, close } = await setupService();
    try {
      expect(await service.hasParentalPin?.()).toBe(false);
      expect(await service.verifyParentalPin?.('1234')).toEqual({
        ok: false,
        remainingAttempts: MAX_PIN_ATTEMPTS,
      });

      expect(await service.setParentalPin?.('12')).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-pin' },
      });

      expect(await service.setParentalPin?.('4321')).toEqual(ok(undefined));
      expect(await service.hasParentalPin?.()).toBe(true);
      const storedSecret = secrets.dump()['profile.default.pin'];
      expect(storedSecret).toMatch(/^v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
      expect(storedSecret).not.toBe('4321');
      expect(storedSecret?.split(':')[2]).not.toBe('4321');

      // Re-hashing the same PIN must generate a distinct 128-bit random salt.
      expect(await service.setParentalPin?.('4321', 'default', '4321')).toEqual(ok(undefined));
      const rehashedSecret = secrets.dump()['profile.default.pin'];
      expect(rehashedSecret).toMatch(/^v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
      expect(rehashedSecret?.split(':')[1]).not.toBe(storedSecret?.split(':')[1]);

      const tables = await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
      );
      for (const { name } of tables) {
        const rows = await db.all(`SELECT * FROM ${name}`);
        const serialized = JSON.stringify(rows);
        expect(serialized).not.toContain('4321');
        expect(serialized).not.toContain(storedSecret as string);
      }

      expect(await service.setParentalPin?.('9999', 'default', '0000')).toEqual({
        ok: false,
        error: { category: 'auth', code: 'invalid-pin' },
      });
      expect(await service.verifyParentalPin?.('4321')).toEqual({ ok: true });

      for (let i = 1; i <= 4; i += 1) {
        expect(await service.verifyParentalPin?.('1111')).toEqual({
          ok: false,
          remainingAttempts: MAX_PIN_ATTEMPTS - i,
        });
      }
      const lockedRes = await service.verifyParentalPin?.('1111');
      expect(lockedRes).toEqual({
        ok: false,
        remainingAttempts: 0,
        lockedUntilMs: getNow() + PIN_LOCKOUT_MS,
      });

      expect(await service.verifyParentalPin?.('4321')).toEqual(lockedRes);
      expect(await service.setParentalPin?.('9999', 'default', '4321')).toEqual({
        ok: false,
        error: { category: 'auth', code: 'pin-locked' },
      });
      expect(await service.clearParentalPin?.('4321')).toEqual({
        ok: false,
        error: { category: 'auth', code: 'pin-locked' },
      });

      advanceClock(PIN_LOCKOUT_MS + 1);
      expect(await service.verifyParentalPin?.('4321')).toEqual({ ok: true });

      expect(await service.setParentalPin?.('5678', 'default', '4321')).toEqual(ok(undefined));
      expect(await service.verifyParentalPin?.('5678')).toEqual({ ok: true });

      expect(await service.clearParentalPin?.('4321')).toEqual({
        ok: false,
        error: { category: 'auth', code: 'invalid-pin' },
      });
      expect(await service.clearParentalPin?.('5678')).toEqual(ok(undefined));
      expect(await service.hasParentalPin?.()).toBe(false);
      expect(await service.clearParentalPin?.('0000')).toEqual(ok(undefined));
    } finally {
      close();
    }
  });

  it('validates parental settings and locks, and preserves zero-overhead fast path when inactive', async () => {
    const { db, close } = await setupService();
    try {
      expect(await loadActiveParentalFilter(db, 'default', false)).toBeNull();

      expect(await updateParentalSettings(db, 'default', { maxRatingAge: 99 })).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-parental-settings' },
      });
      expect(await updateParentalSettings(db, 'default', { unlockTimeoutMin: -5 })).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-parental-settings' },
      });
      expect(
        await setParentalLock(
          db,
          { sourceId: 'bad id!', targetKind: 'category', itemKind: 'live', targetKey: 'c1' },
          true,
        ),
      ).toEqual({
        ok: false,
        error: { category: 'source-format', code: 'invalid-parental-lock' },
      });

      const updated = await updateParentalSettings(db, 'default', {
        enabled: true,
        blockAdultKeywords: true,
        maxRatingAge: 14,
        unlockTimeoutMin: 15,
      });
      expect(updated.ok).toBe(true);
      expect((await getParentalSettings(db, 'default')).maxRatingAge).toBe(14);

      expect(await loadActiveParentalFilter(db, 'default', false)).not.toBeNull();
      expect(await loadActiveParentalFilter(db, 'default', true)).toBeNull();

      await setParentalLock(
        db,
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 's1|live|catA' },
        true,
      );
      expect(
        await listParentalLocks(db, 'default', {
          sourceId: 's1',
          targetKind: 'category',
          itemKind: 'live',
        }),
      ).toHaveLength(1);
      await setParentalLock(
        db,
        { sourceId: 's1', targetKind: 'category', itemKind: 'live', targetKey: 'catA' },
        false,
      );
      expect(await listParentalLocks(db, 'default')).toEqual([]);

      await updateParentalSettings(db, 'default', { enabled: false });
      expect(await loadActiveParentalFilter(db, 'default', false)).toBeNull();
    } finally {
      close();
    }
  });

  it('preserves category and item locks across full M3U and Xtream re-imports, and purges them on removeSource (#31)', async () => {
    const m3uUrl = 'http://m3u.example/list.m3u';
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="Sports",Channel A',
      'http://cdn.example/live/a.ts',
      '#EXTINF:-1 group-title="Late",Channel B',
      'http://cdn.example/live/b.ts',
    ].join('\n');

    const xtBase = 'http://xt.example';
    const xtRoutes: Record<string, string> = {
      [m3uUrl]: playlist,
      [`${xtBase}/player_api.php?username=u&password=p&action=get_live_categories`]: JSON.stringify(
        [
          { category_id: '10', category_name: 'General' },
          { category_id: '20', category_name: 'Private' },
        ],
      ),
      [`${xtBase}/player_api.php?username=u&password=p&action=get_live_streams`]: JSON.stringify([
        { num: 1, name: 'Ch 1', stream_id: 101, category_id: '10' },
        { num: 2, name: 'Ch 2', stream_id: 102, category_id: '20' },
      ]),
      [`${xtBase}/player_api.php?username=u&password=p&action=get_vod_categories`]: '[]',
      [`${xtBase}/player_api.php?username=u&password=p&action=get_vod_streams`]: '[]',
      [`${xtBase}/player_api.php?username=u&password=p&action=get_series_categories`]: '[]',
      [`${xtBase}/player_api.php?username=u&password=p&action=get_series`]: '[]',
      [`${xtBase}/player_api.php?username=u&password=p`]: JSON.stringify({
        user_info: { auth: 1, status: 'Active', allowed_output_formats: ['ts'] },
      }),
    };

    const { service, close } = await setupService(xtRoutes);
    try {
      const m3uSrc = await service.addSource({ kind: 'm3u', name: 'M3U', playlistUrl: m3uUrl });
      const xtSrc = await service.addSource({
        kind: 'xtream',
        name: 'Xtream',
        server: xtBase,
        username: 'u',
        password: 'p',
      });
      if (!m3uSrc.ok || !xtSrc.ok) throw new Error('addSource failed');

      expect((await service.importSource(m3uSrc.value.id)).ok).toBe(true);
      expect((await service.importSource(xtSrc.value.id)).ok).toBe(true);

      const m3uLateCat = (await service.categories(m3uSrc.value.id, 'live')).find(
        (c) => c.name === 'Late',
      );
      const xtPrivCat = (await service.categories(xtSrc.value.id, 'live')).find(
        (c) => c.name === 'Private',
      );
      expect(m3uLateCat).toBeDefined();
      expect(xtPrivCat).toBeDefined();

      await service.setParentalLock?.(
        {
          sourceId: m3uSrc.value.id,
          targetKind: 'category',
          itemKind: 'live',
          targetKey: m3uLateCat?.id ?? '',
        },
        true,
      );
      await service.setParentalLock?.(
        {
          sourceId: xtSrc.value.id,
          targetKind: 'category',
          itemKind: 'live',
          targetKey: xtPrivCat?.id ?? '',
        },
        true,
      );

      expect((await service.importSource(m3uSrc.value.id)).ok).toBe(true);
      expect((await service.importSource(xtSrc.value.id)).ok).toBe(true);

      expect(await service.listParentalLocks?.()).toHaveLength(2);
      expect((await service.categories(m3uSrc.value.id, 'live')).map((c) => c.name)).toEqual([
        'Sports',
      ]);
      expect((await service.categories(xtSrc.value.id, 'live')).map((c) => c.name)).toEqual([
        'General',
      ]);

      expect((await service.removeSource(m3uSrc.value.id)).ok).toBe(true);
      const remainingLocks = await service.listParentalLocks?.();
      expect(remainingLocks).toHaveLength(1);
      expect(remainingLocks?.[0]?.sourceId).toBe(xtSrc.value.id);
    } finally {
      close();
    }
  });
});
