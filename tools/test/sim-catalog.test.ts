import { describe, expect, it } from 'vitest';
import { findAccount } from '../src/sim/accounts.ts';
import { buildCatalog, COMPAT_CASES, createCatalog, rng } from '../src/sim/catalog.ts';

describe('buildCatalog', () => {
  it('builds the same catalog for the same seed', () => {
    const a = JSON.stringify(createCatalog('small', 1));
    expect(JSON.stringify(createCatalog('small', 1))).toBe(a);
    expect(JSON.stringify(createCatalog('small', 2))).not.toBe(a);
  });

  it('small profile sizes', () => {
    const c = buildCatalog('small', 1);
    expect([c.live.length, c.movies.length, c.series.length, c.categories.length]).toEqual([
      50, 30, 5, 10,
    ]);
    const kindOf = (id: string) => c.categories.find((x) => x.id === id)?.kind;
    expect(c.live.every((x) => kindOf(x.categoryId) === 'live')).toBe(true);
    expect(c.movies.every((x) => kindOf(x.categoryId) === 'vod')).toBe(true);
    expect(c.series.every((x) => kindOf(x.categoryId) === 'series')).toBe(true);
  });

  it('small profile carries two catalog faults', () => {
    const c = buildCatalog('small', 1);
    expect(c.live.filter((x) => x.fault !== null).map((x) => [x.id, x.fault])).toEqual([
      [1013, 'status=503'],
      [1014, 'drop@10s'],
    ]);
  });

  it('large profile reaches 100k entries', () => {
    const start = Date.now();
    const c = buildCatalog('large', 1);
    expect(Date.now() - start).toBeLessThan(3000);
    const episodes = c.series.reduce((n, s) => n + s.episodes.length, 0);
    expect([c.live.length, c.movies.length, c.series.length, episodes]).toEqual([
      25000, 70000, 500, 5000,
    ]);
    expect(c.series.every((s) => s.episodes.length === 10)).toBe(true);
    expect(c.live.length + c.movies.length + episodes).toBe(100_000);
    expect(c.categories.length).toBe(300);
    expect(c.guideChannels).toBe(5000);
    expect(c.guideWindow).toEqual({ daysBack: 0, daysForward: 7 });
  });

  it('compat profile has one live channel per case', () => {
    const c = buildCatalog('compat', 1);
    expect(c.live.length).toBe(COMPAT_CASES.length);
    expect(new Set(c.live.map((x) => x.id)).size).toBe(COMPAT_CASES.length);
    expect(c.live.map((x) => x.compat)).toEqual([...COMPAT_CASES]);
    for (const ch of c.live) {
      expect(ch.archiveDays).toBe(ch.compat?.startsWith('catchup-') ? 3 : 0);
    }
    expect(c.live.find((x) => x.compat === 'radio')?.recipe).toBe('aac-radio');
  });

  it('small and compat guide window', () => {
    for (const p of ['small', 'compat'] as const) {
      const c = buildCatalog(p, 1);
      expect(c.guideWindow).toEqual({ daysBack: 2, daysForward: 7 });
      expect(c.guideChannels).toBe(c.live.filter((x) => x.epgId !== null).length);
    }
  });

  it('names are fictional and padded', () => {
    const c = buildCatalog('small', 1);
    expect(c.live.every((x) => /^Channel \d{4}$/.test(x.name))).toBe(true);
    expect(c.movies.every((x) => /^Movie \d{4}$/.test(x.name))).toBe(true);
    const titles = c.series.flatMap((s) => s.episodes.map((e) => e.title));
    expect(titles.every((t) => /^Series \d{4} S\d{2}E\d{2}$/.test(t))).toBe(true);
  });

  it('uses fixed id bases and the radio recipe on every 25th channel', () => {
    const c = buildCatalog('small', 1);
    expect([c.live[0]?.id, c.movies[0]?.id, c.series[0]?.id, c.series[0]?.episodes[0]?.id]).toEqual(
      [1001, 200001, 300001, 400001],
    );
    expect(c.live.filter((x) => x.recipe === 'aac-radio').map((x) => x.num)).toEqual([25, 50]);
  });
});

const hugeOptIn = process.env.SIM_HUGE === '1';
if (!hugeOptIn) process.stderr.write('sim-catalog: huge profile tests skipped (set SIM_HUGE=1)\n');

describe('huge profile', () => {
  it.runIf(hugeOptIn)(
    'has the documented shape with unique ids across kinds',
    () => {
      const c = createCatalog('huge', 1);
      const episodes = c.series.reduce((n, s) => n + s.episodes.length, 0);
      expect([c.live.length, c.movies.length, c.series.length, episodes]).toEqual([
        50_000, 300_000, 6000, 150_000,
      ]);
      expect(c.live.length + c.movies.length + episodes).toBe(500_000);
      expect(c.categories).toHaveLength(2000);
      expect(c.guideChannels).toBe(20_000);
      expect(c.guideWindow).toEqual({ daysBack: 0, daysForward: 7 });
      const ids = new Set<number>();
      for (const l of c.live) ids.add(l.id);
      for (const m of c.movies) ids.add(m.id);
      for (const s of c.series) {
        ids.add(s.id);
        for (const e of s.episodes) ids.add(e.id);
      }
      expect(ids.size).toBe(50_000 + 300_000 + 6000 + 150_000);
    },
    60_000,
  );

  it('has an account with two connections and the 509 policy', () => {
    expect(findAccount('huge', 'huge')).toMatchObject({
      profile: 'huge',
      maxConnections: 2,
      limitPolicy: 'status-509',
      quirks: false,
    });
  });
});

describe('buildCatalog caching', () => {
  it('returns the shared catalog for the same arguments', () => {
    expect(buildCatalog('small', 5)).toBe(buildCatalog('small', 5));
  });
});

describe('rng', () => {
  it('is deterministic and within [0, 1)', () => {
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('accounts', () => {
  it('resolves the synthetic accounts', () => {
    expect(findAccount('demo', 'demo')).toMatchObject({
      profile: 'small',
      maxConnections: 1,
      limitPolicy: 'status-509',
    });
    expect(findAccount('large', 'large')).toMatchObject({
      profile: 'large',
      maxConnections: 2,
      limitPolicy: 'status-403',
    });
    expect(findAccount('compat', 'compat')).toMatchObject({
      profile: 'compat',
      maxConnections: 1,
      limitPolicy: 'text-notice',
    });
    expect(findAccount('expired', 'expired')?.status).toBe('Expired');
    expect(findAccount('quirks', 'quirks')).toMatchObject({
      profile: 'small',
      quirks: true,
      limitPolicy: 'status-509',
    });
  });

  it('rejects wrong or missing credentials', () => {
    expect(findAccount('demo', 'nope')).toBeUndefined();
    expect(findAccount(null, null)).toBeUndefined();
    expect(findAccount('demo', null)).toBeUndefined();
  });
});

describe('logo indexes', () => {
  it('points every logo at one of the 16 served logos', () => {
    for (const profile of ['small', 'large', 'compat'] as const) {
      for (const ch of buildCatalog(profile, 1).live) {
        if (ch.logo === null) continue;
        expect(
          Number.isInteger(ch.logo) && ch.logo >= 0 && ch.logo <= 15,
          `${profile} ${ch.id}`,
        ).toBe(true);
      }
    }
  });
});
