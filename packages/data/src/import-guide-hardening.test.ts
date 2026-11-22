import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { closeOpenProgrammes, importGuide } from './import-guide';
import {
  channelXml,
  defaultGuide,
  expectErr,
  GUIDE_URL,
  HOUR,
  NOW,
  programmeXml,
  ready,
  rows,
  run,
  SECOND_URL,
  settings,
  setupGuide,
  stream,
  titles,
  tv,
  xt,
} from './import-guide-test-helpers';
import { extinf } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { updateSourceSettings } from './sources';

const emptyBody = () =>
  (async function* () {
    yield new Uint8Array(0);
  })();

const bodyOf = (xml: string) => {
  const bytes = new TextEncoder().encode(xml);
  return (async function* () {
    yield bytes;
  })();
};

describe('EPG hardening: retries, ordering, duplicate merge & overlap normalization (#431, #121)', () => {
  it('retries transient HTTP 5xx (excluding 509), 408, and network/timeout errors up to 2 times and succeeds on recovery', async () => {
    for (const transient of [
      { label: '503', fail: () => ok({ status: 503, headers: {}, body: emptyBody() }) },
      { label: '408', fail: () => ok({ status: 408, headers: {}, body: emptyBody() }) },
      { label: 'timeout', fail: () => err(elvError('network', 'timeout')) },
      {
        label: 'thrown network error',
        fail: () => {
          throw new Error('socket reset');
        },
      },
    ]) {
      const e = await ready();
      let attempts = 0;
      const delays: number[] = [];
      const http = {
        async get() {
          attempts += 1;
          if (attempts <= 2) return transient.fail();
          return ok({ status: 200, headers: {}, body: bodyOf(defaultGuide()) });
        },
      };
      const r = await importGuide(
        e.sourceId,
        { ...e.deps, http },
        {
          now: NOW,
          retryDelayMs: (attempt) => {
            delays.push(attempt);
            return 0;
          },
        },
      );
      expect(r.ok, transient.label).toBe(true);
      expect(attempts, transient.label).toBe(3);
      expect(delays, transient.label).toEqual([0, 1]);
      e.close();
    }
  });

  it('never retries 401, 403, 404, 429, 509, or aborted errors and falls back cleanly on exhausted retries', async () => {
    for (const status of [401, 403, 404, 429, 509]) {
      const e = await ready();
      let attempts = 0;
      const http = {
        async get() {
          attempts += 1;
          return ok({ status, headers: {}, body: emptyBody() });
        },
      };
      const r = await importGuide(
        e.sourceId,
        { ...e.deps, http },
        { now: NOW, retryDelayMs: () => 0 },
      );
      expect(r.ok).toBe(false);
      expect(attempts, `status ${status}`).toBe(1);
      e.close();
    }

    // Caller abort during retry wait aborts immediately without another attempt
    const eAbort = await ready();
    const ctl = new AbortController();
    let abortAttempts = 0;
    const httpAbort = {
      async get() {
        abortAttempts += 1;
        return ok({ status: 503, headers: {}, body: emptyBody() });
      },
    };
    const rAbort = await importGuide(
      eAbort.sourceId,
      { ...eAbort.deps, http: httpAbort },
      {
        now: NOW,
        signal: ctl.signal,
        retryDelayMs: () => {
          ctl.abort();
          return 50;
        },
      },
    );
    expectErr(rAbort, 'network', 'aborted');
    expect(abortAttempts).toBe(1);
    eAbort.close();

    // Exhausted retries on override record a single fallback warning and succeed on candidate 2
    const eFb = await ready();
    await updateSourceSettings(eFb.db, eFb.sourceId, {
      ...(await settings(eFb)),
      discoveredGuideUrls: [SECOND_URL],
    });
    eFb.server.statuses.set(GUIDE_URL, 503);
    const rFb = await run(eFb);
    expect(rFb.ok).toBe(true);
    if (rFb.ok) {
      expect(rFb.value.counts.guideUrlFallbacks).toBe(1);
      expect(rFb.value.warningCodes).toEqual(['network/http-503']);
    }
    expect(eFb.server.urls).toEqual([GUIDE_URL, GUIDE_URL, GUIDE_URL, SECOND_URL]);
    eFb.close();
  });

  it('retains <programme> elements that appear before their <channel> declaration', async () => {
    const e = await ready(
      tv(
        programmeXml('haber1.tr', HOUR, 1, 'Before Channel 1'),
        programmeXml('cagri', 2 * HOUR, 1, 'Before Channel 2'),
        programmeXml('ghost', 3 * HOUR, 1, 'Still Dropped'),
        channelXml('haber1.tr', 'Haber Bir'),
        channelXml('cagri', 'ÇAĞRI TV'),
      ),
    );
    const r = await run(e, { batchSize: 1 });
    expect(r.ok).toBe(true);
    expect(await titles(e)).toEqual(['Before Channel 1', 'Before Channel 2']);
    e.close();
  });

  it('merges duplicate <channel id> blocks additively without wiping mappings or icons', async () => {
    const e = await ready(
      tv(
        '<channel id="cagri"><display-name>Alias Only</display-name></channel>',
        '<channel id="cagri"><display-name>ÇAĞRI TV</display-name><icon src="http://img.example/cagri.png"/></channel>',
        '<channel id="cagri"/>',
        '<channel id="haber1.tr"><display-name>Haber Bir</display-name><icon src="http://img.example/h1.png"/></channel>',
        '<channel id="haber1.tr"><display-name>Haber Alt</display-name><icon src="http://img.example/h2.png"/></channel>',
        programmeXml('cagri', HOUR, 1, 'Merged Cagri Show'),
        programmeXml('haber1.tr', 2 * HOUR, 1, 'Merged Haber Show'),
      ),
    );
    const r = await run(e, { batchSize: 1 });
    expect(r.ok).toBe(true);
    expect(await titles(e)).toEqual(['Merged Cagri Show', 'Merged Haber Show']);
    const gch = await rows(e, 'SELECT guide_id, name, icon FROM guide_channels ORDER BY guide_id');
    expect(gch).toEqual([
      { guide_id: 'cagri', name: 'Alias Only', icon: 'http://img.example/cagri.png' },
      { guide_id: 'haber1.tr', name: 'Haber Bir', icon: 'http://img.example/h1.png' },
    ]);
    e.close();
  });

  it('disambiguates regional @feedId feeds, matches case-insensitive guide_id, and matches decimal tvg-chno end-to-end', async () => {
    const playlist =
      '#EXTM3U\n' +
      extinf('Chan East', stream(1), 'tvg-id="Chan.us"') +
      extinf('Chan West', stream(2), 'tvg-id="Chan.us"') +
      extinf('Chan Main', stream(3), 'tvg-id="Chan.us"') +
      extinf('Upper Case', stream(4), 'tvg-id="BBC1.UK"') +
      extinf('Sub Local', stream(5), 'tvg-chno="4.1"');
    const e = await setupGuide(playlist);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    e.server.body = tv(
      channelXml('Chan.us@West', 'Chan West'),
      channelXml('Chan.us@East', 'Chan East'),
      channelXml('bbc1.uk', 'BBC One'),
      channelXml('sub.4.1', '4.1 - Sub Channel'),
      programmeXml('Chan.us@West', HOUR, 1, 'West Show'),
      programmeXml('Chan.us@East', HOUR, 1, 'East Show'),
      programmeXml('bbc1.uk', HOUR, 1, 'BBC Show'),
      programmeXml('sub.4.1', HOUR, 1, 'Sub Show'),
    );
    const r = await run(e);
    expect(r.ok).toBe(true);
    const mappings = await rows(
      e,
      'SELECT l.name, g.guide_id FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.name',
    );
    expect(mappings).toEqual([
      { name: 'Chan East', guide_id: 'Chan.us@East' },
      { name: 'Chan Main', guide_id: 'Chan.us@East' },
      { name: 'Chan West', guide_id: 'Chan.us@West' },
      { name: 'Sub Local', guide_id: 'sub.4.1' },
      { name: 'Upper Case', guide_id: 'bbc1.uk' },
    ]);
    e.close();
  });

  it('does not let an exact guide_id match on one live channel shadow CI or @feedId base matches on sibling live channels (#431, #121)', async () => {
    const playlist =
      '#EXTM3U\n' +
      extinf('BBC Exact', stream(1), 'tvg-id="BBC1.UK"') +
      extinf('BBC Lower', stream(2), 'tvg-id="bbc1.uk"') +
      extinf('Chan Exact East', stream(3), 'tvg-id="Chan.us@East"') +
      extinf('Chan East HD', stream(4), 'tvg-id="Chan.us"');
    const e = await setupGuide(playlist);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    e.server.body = tv(
      channelXml('BBC1.UK', 'BBC One'),
      channelXml('Chan.us@West', 'Chan West'),
      channelXml('Chan.us@East', 'Chan East'),
      programmeXml('BBC1.UK', HOUR, 1, 'BBC Show'),
      programmeXml('Chan.us@West', HOUR, 1, 'West Show'),
      programmeXml('Chan.us@East', HOUR, 1, 'East Show'),
    );
    const r = await run(e);
    expect(r.ok).toBe(true);
    const mappings = await rows(
      e,
      'SELECT l.name, g.guide_id FROM channel_guide g JOIN live l ON l.key = g.channel_key ORDER BY l.name',
    );
    expect(mappings).toEqual([
      { name: 'BBC Exact', guide_id: 'BBC1.UK' },
      { name: 'BBC Lower', guide_id: 'BBC1.UK' },
      { name: 'Chan East HD', guide_id: 'Chan.us@East' },
      { name: 'Chan Exact East', guide_id: 'Chan.us@East' },
    ]);
    e.close();
  });

  it('normalizes out-of-order overlapping and open programmes across batches into strictly half-open [start, stop) intervals', async () => {
    // Pure in-memory 3-programme out-of-order overlap (A [1000,5000], B [3000,6000], C [2000,4000])
    const c = { sourceId: 's1', runId: 1, warnings: 0, warningCodes: [] as string[] };
    const open = new Map();
    const inMem = closeOpenProgrammes(c, open, [
      { channel: 'ch1', start: 1000, stop: 5000, title: 'A', categories: [] },
      { channel: 'ch1', start: 3000, stop: 6000, title: 'B', categories: [] },
      { channel: 'ch1', start: 2000, stop: 4000, title: 'C', categories: [] },
    ]);
    const sortedMem = [...inMem].sort((a, b) => (a[2] as number) - (b[2] as number));
    expect(sortedMem.map((r) => [r[4], r[2], r[3]])).toEqual([
      ['A', 1000, 2000],
      ['C', 2000, 3000],
      ['B', 3000, 6000],
    ]);

    // Out-of-order duplicate (channel, start) within one batch is still clamped against nextStart
    const openDup = new Map();
    const dupMem = closeOpenProgrammes(c, openDup, [
      { channel: 'ch1', start: 1000, stop: 2000, title: 'A1', categories: [] },
      { channel: 'ch1', start: 3000, stop: 5000, title: 'B', categories: [] },
      { channel: 'ch1', start: 2000, stop: 3000, title: 'C', categories: [] },
      { channel: 'ch1', start: 1000, stop: 4500, title: 'A2Replace', categories: [] },
    ]);
    const sortedDup = [...dupMem].sort((a, b) => (a[2] as number) - (b[2] as number));
    expect(sortedDup.map((r) => [r[4], r[2], r[3]])).toEqual([
      ['A2Replace', 1000, 2000],
      ['C', 2000, 3000],
      ['B', 3000, 5000],
    ]);

    // End-to-end across batches (batchSize: 1) with heavily out-of-order closed & open programmes
    const e = await ready(
      tv(
        channelXml('haber1.tr', 'Haber Bir'),
        programmeXml('haber1.tr', 1 * HOUR, 4, 'First Long'),
        programmeXml('haber1.tr', 3 * HOUR, 3, 'Third'),
        programmeXml('haber1.tr', 2 * HOUR, 3, 'Second Arrived Late'),
        `<programme start="${xt(4 * HOUR)}" channel="haber1.tr"><title>Open Four</title></programme>`,
        `<programme start="${xt(3.5 * HOUR)}" channel="haber1.tr"><title>Open ThreeHalf</title></programme>`,
      ),
    );
    const r = await run(e, { batchSize: 1 });
    expect(r.ok).toBe(true);
    const stored = await rows(
      e,
      'SELECT title, start, stop FROM programmes WHERE guide_id = ? ORDER BY start',
      ['haber1.tr'],
    );
    expect(stored.map((p) => p.title)).toEqual([
      'First Long',
      'Second Arrived Late',
      'Third',
      'Open ThreeHalf',
      'Open Four',
    ]);
    for (let i = 0; i < stored.length; i += 1) {
      const curr = stored[i] as { start: number; stop: number };
      expect(curr.stop).toBeGreaterThan(curr.start);
      if (i > 0) {
        const prev = stored[i - 1] as { start: number; stop: number };
        expect(prev.stop).toBeLessThanOrEqual(curr.start);
      }
    }
    e.close();
  });
});
