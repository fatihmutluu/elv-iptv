import { createXtreamClient } from '@elv/sources';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, COMPAT_CASES } from '../src/sim/catalog.ts';
import { programmesFor } from '../src/sim/xmltv.ts';
import {
  clientFor,
  http,
  must,
  SIM_CLOCK,
  type Sim,
  scanGuide,
  scanPlaylist,
  startTestSim,
} from './sources-sim-helpers.ts';

let sim: Sim;
beforeAll(async () => {
  sim = await startTestSim();
});
afterAll(async () => {
  await sim.close();
});

const PROFILE = { demo: 'small', large: 'large', compat: 'compat', quirks: 'small' } as const;

describe('xtream round trip', () => {
  for (const user of ['demo', 'large', 'compat', 'quirks'] as const) {
    it(`reads the ${user} account catalog`, async () => {
      const catalog = buildCatalog(PROFILE[user], 1);
      const client = clientFor(sim, user);
      expect(must(await client.account()).status).toBe('Active');
      for (const [kind, label] of [
        ['live', 'live'],
        ['movie', 'vod'],
        ['series', 'series'],
      ] as const) {
        const expected = catalog.categories.filter((c) => c.kind === label).length;
        expect(must(await client.categories(kind))).toHaveLength(expected);
      }
      const live = must(await client.liveStreams());
      const movies = must(await client.vodStreams());
      const series = must(await client.series());
      expect(series).toHaveLength(catalog.series.length);
      expect(movies).toHaveLength(catalog.movies.length);
      if (user === 'quirks') {
        expect(live).toHaveLength(catalog.live.length - 1);
        expect(movies.slice(0, 3).every((m) => m.categoryIds.length === 2)).toBe(true);
        expect(new Set(movies.map((m) => m.id)).size).toBe(movies.length);
      } else {
        expect(live).toHaveLength(catalog.live.length);
      }
    }, 60_000);
  }

  it('returns the episodes of the first series', async () => {
    const catalog = buildCatalog('small', 1);
    const client = clientFor(sim, 'demo');
    const first = must(await client.series())[0];
    const info = must(await client.seriesInfo(first?.id as number));
    const expected = (catalog.series[0]?.episodes ?? []).map((e) => e.id);
    expect(info.episodes.map((e) => e.id).sort()).toEqual([...expected].sort());
    expect(info.episodes.every((e) => e.title.startsWith('Series 0001'))).toBe(true);
  });

  it('returns short EPG titles', async () => {
    const entries = must(await clientFor(sim, 'demo').shortEpg(1001, 3));
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.title.startsWith('Programme '))).toBe(true);
    expect(entries.every((e) => e.stop > e.start)).toBe(true);
  });
});

describe('account errors', () => {
  it('reports a wrong password', async () => {
    const client = createXtreamClient({
      http,
      server: sim.url,
      username: 'demo',
      password: ['wrong', 'pw'].join('-'),
    });
    expect(await client.account()).toMatchObject({
      ok: false,
      error: { category: 'auth', code: 'invalid-credentials' },
    });
  });

  it('reports an expired account', async () => {
    expect(await clientFor(sim, 'expired').account()).toMatchObject({
      ok: false,
      error: { category: 'auth', code: 'account-expired' },
    });
  });

  it('reports a closed port as a network error', async () => {
    const closed = await startTestSim();
    const url = closed.url;
    await closed.close();
    const client = createXtreamClient({ http, server: url, username: 'demo', password: 'demo' });
    const result = await client.account();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe('network');
  });
});

describe('playlist', () => {
  it('scans the demo playlist with kind hints that match the URL paths', async () => {
    const catalog = buildCatalog('small', 1);
    const episodes = catalog.series.reduce((n, s) => n + s.episodes.length, 0);
    const scan = await scanPlaylist(clientFor(sim, 'demo').playlistUrl());
    expect(scan.entries).toHaveLength(catalog.live.length + catalog.movies.length + episodes);
    expect(scan.stats?.warnings).toEqual([]);
    for (const e of scan.entries) {
      const kind = /\/(live|movie|series)\//.exec(e.url)?.[1];
      expect(e.kindHint).toBe(kind === 'series' ? 'episode' : kind);
    }
  });

  describe('compat', () => {
    type Entries = Awaited<ReturnType<typeof scanPlaylist>>['entries'];
    const at = (entries: Entries, c: string): Entries[number] => {
      const entry = entries[COMPAT_CASES.indexOf(c as (typeof COMPAT_CASES)[number])];
      if (!entry) throw new Error(`no entry for ${c}`);
      return entry;
    };

    it('keeps every edge case field', async () => {
      const { entries, header, stats } = await scanPlaylist(`${sim.url}/playlists/compat.m3u`);
      expect(entries).toHaveLength(COMPAT_CASES.length);
      expect(stats?.warnings).toEqual([]);
      expect(header?.guideUrls[0]).toBe(`${sim.url}/guides/compat.xml`);
      expect(at(entries, 'tvg-shift').shiftHours).toBe(-2);
      expect(at(entries, 'tvg-rec').recordDays).toBe(3);
      expect(at(entries, 'radio').radio).toBe(true);
      expect(at(entries, 'extgrp').groups).toEqual(['Live Group 01']);
      expect(at(entries, 'no-tvg-id').tvgId).toBeUndefined();
      expect(at(entries, 'duplicate-id-a').tvgId).toBe('dup');
      expect(at(entries, 'duplicate-id-b').tvgId).toBe('dup');
      expect(at(entries, 'empty-name').name).toBe('');
      expect(at(entries, 'long-name').name).toHaveLength(300);
      const quoted = at(entries, 'quotes-commas');
      expect(quoted.name).toBe('Channel "Quoted", With, Commas');
      expect(quoted.tvgName).toBe("Channel 'Quoted', With, Commas");
      expect(quoted.chno).toBe(10);
      expect(at(entries, 'turkish-name').name).toBe('Kanal İğüşöçı');
      expect(at(entries, 'rtl-name').name).toBe('قناة ٤٢');
      expect(at(entries, 'catchup-default').catchup).toMatchObject({ type: 'default', days: 3 });
      expect(at(entries, 'catchup-default').catchup?.source).toContain('/catchup/1013.ts');
      expect(at(entries, 'catchup-append').catchup).toMatchObject({ type: 'append' });
      for (const t of ['shift', 'flussonic', 'flussonic-hls', 'xc', 'fs']) {
        expect(at(entries, `catchup-${t}`).catchup).toEqual({ type: t, days: 3 });
      }
      expect(at(entries, 'vlcopt-user-agent').headers.userAgent).toBe('ELV-Compat-UA/1.0');
      expect(at(entries, 'vlcopt-referrer').headers.referer).toBe(`${sim.url}/referrer-check`);
      expect(at(entries, 'exthttp').headers.userAgent).toBe('ELV-Compat-UA/2.0');
      expect(Object.keys(at(entries, 'kodiprop-clearkey').kodiProps)).toEqual([
        'inputstream.adaptive.manifest_type',
        'inputstream.adaptive.license_type',
        'inputstream.adaptive.license_key',
      ]);
      expect(at(entries, 'relative-url').url).toBe('relative/1024.ts');
      expect(at(entries, 'credentials-in-url').url).toContain('@');
      for (const c of ['udp-url', 'rtp-url', 'rtmp-url']) expect(at(entries, c).nonHttp).toBe(true);
      expect(entries.filter((e) => e.nonHttp)).toHaveLength(3);
    });

    it('reads the BOM and CRLF variant like the plain one', async () => {
      const plain = await scanPlaylist(`${sim.url}/playlists/compat.m3u`);
      const crlf = await scanPlaylist(`${sim.url}/playlists/compat-crlf-bom.m3u`);
      expect(crlf.entries).toEqual(plain.entries);
      expect(crlf.header).toEqual(plain.header);
    });

    it('loses only the cut last entry of the truncated variant', async () => {
      const plain = await scanPlaylist(`${sim.url}/playlists/compat.m3u`);
      const cut = await scanPlaylist(`${sim.url}/playlists/compat-truncated.m3u`);
      expect(cut.entries).toEqual(plain.entries.slice(0, -1));
      expect(cut.stats?.warnings.map((w) => w.code)).toEqual(['extinf-without-url']);
    });
  });

  it('reads the quirks playlist as a real panel writes it', async () => {
    const catalog = buildCatalog('small', 1);
    const scan = await scanPlaylist(clientFor(sim, 'quirks').playlistUrl());
    expect(scan.entries.length).toBeGreaterThan(catalog.live.length);
    expect(scan.entries.every((e) => e.extra['xui-id'] !== undefined)).toBe(true);
    expect(scan.entries[0]?.extra['xui-id']).toBe('1001');
    const shifted = scan.entries.filter((e) => e.timeshiftDays !== undefined);
    expect(shifted).toHaveLength(catalog.live.length / 5);
    expect(shifted.every((e) => e.timeshiftDays === 3)).toBe(true);
    expect(scan.stats?.warnings).toEqual([]);
  });
});

describe('guide', () => {
  it('scans the demo guide', async () => {
    const catalog = buildCatalog('small', 1);
    const scan = await scanGuide(clientFor(sim, 'demo').guideUrl());
    expect(scan.failed).toBe(false);
    expect(scan.channels).toHaveLength(catalog.guideChannels);
    expect(scan.programmes.length).toBeGreaterThan(0);
    const last = new Map<string, number>();
    for (const p of scan.programmes) {
      expect(p.start).toBeGreaterThanOrEqual(last.get(p.channel) ?? 0);
      last.set(p.channel, p.start);
    }
  });

  it('scans the gzip route with a DecompressionStream adapter', async () => {
    const plain = await scanGuide(`${sim.url}/guides/small.xml`);
    const gz = await scanGuide(`${sim.url}/guides/small.xml.gz`, { gzip: true });
    expect(gz.failed).toBe(false);
    expect(gz.channels).toEqual(plain.channels);
    expect(gz.programmes).toEqual(plain.programmes);
  });

  it('keeps the compat specials and skips the malformed programmes', async () => {
    const scan = await scanGuide(`${sim.url}/guides/compat.xml`);
    expect(scan.failed).toBe(false);
    expect(scan.channels.find((c) => c.id === 'name-only')?.names).toEqual(['Channel 0005']);
    const titles = scan.programmes.filter((p) => p.channel === 'dup').map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Overlap A',
        'Overlap B',
        'Salt & Pepper',
        'Raw Text',
        'Midnight Show',
      ]),
    );
    const a = scan.programmes.find((p) => p.title === 'Overlap A');
    const b = scan.programmes.find((p) => p.title === 'Overlap B');
    expect((a?.stop ?? 0) > (b?.start ?? 0)).toBe(true);
    expect(scan.programmes.find((p) => p.title === 'No Stop')?.stop).toBeUndefined();
    expect(scan.programmes.some((p) => p.title.startsWith('Unclosed'))).toBe(false);
    expect(scan.stats?.warnings.map((w) => w.code)).toEqual(['programme-malformed']);
    expect(scan.stats?.skipped).toBe(1);
    expect(scan.programmes.filter((p) => p.channel === 'ch1001').length).toBeGreaterThan(50);
  });

  it('parses the +0100 times of the quirks guide to the right instants', async () => {
    const catalog = buildCatalog('small', 1);
    const scan = await scanGuide(clientFor(sim, 'quirks').guideUrl());
    expect(scan.failed).toBe(false);
    const expected = [...programmesFor(catalog, 0, SIM_CLOCK)].map((p) => [
      p.start.getTime(),
      p.stop.getTime(),
    ]);
    const windowEnd = SIM_CLOCK.getTime() + 7 * 86_400_000;
    const got = scan.programmes
      .filter((p) => p.channel === 'ch1001' && p.start < windowEnd)
      .map((p) => [p.start, p.stop]);
    expect(got.length).toBeGreaterThan(0);
    expect(got).toEqual(expected);
  });
});

describe('transport headers reach the server', () => {
  it('sends the user agent and referer on every request', async () => {
    const transport = { userAgent: 'ELV-Test/1', referer: 'http://ref.test/' };
    const client = clientFor(sim, 'demo', transport);
    sim.clear();
    must(await client.account());
    must(await client.categories('live'));
    must(await client.liveStreams());
    must(await client.shortEpg(1001));
    await scanPlaylist(client.playlistUrl(), { transport });
    await scanGuide(client.guideUrl(), { transport });
    const seen = sim.requests();
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const r of seen) {
      expect(r.headers['user-agent']).toBe('ELV-Test/1');
      expect(r.headers.referer).toBe('http://ref.test/');
    }
  });
});
