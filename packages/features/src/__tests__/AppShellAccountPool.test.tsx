import {
  createCatalogService,
  fingerprintXtreamCredentials,
  openCatalog,
  type SourceRow,
} from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import {
  createMemoryPreferencesStore,
  elvError,
  err,
  type HttpClient,
  type HttpResponse,
  ok,
} from '@elv/domain';
import { createPlaybackService } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { enrichPlayTargetAccountKey } from '../app-shell-state';
import { AppProviders, AppShell } from '../index';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { VideoHost } from '../ports/video-host';

const SYNTH_HOST = 'pool.example.test';
const SYNTH_USER = 'pooluser';
const SYNTH_PASS = 'poolpass';

function textBody(text: string, contentType: string): HttpResponse {
  const bytes = new TextEncoder().encode(text);
  return {
    status: 200,
    headers: { 'content-type': contentType },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function createCrossSourceHttpClient(): HttpClient {
  const streamA = `http://${SYNTH_HOST}/live/${SYNTH_USER}/${SYNTH_PASS}/501.ts`;
  const streamB = `http://${SYNTH_HOST}/live/${SYNTH_USER}/${SYNTH_PASS}/502.ts`;
  const m3uBody = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="M3U Pool",M3U Channel A',
    streamA,
    '#EXTINF:-1 group-title="M3U Pool",M3U Channel B',
    streamB,
  ].join('\n');

  return {
    async get(rawUrl) {
      const url = new URL(rawUrl);
      if (url.pathname === '/playlist.m3u') {
        return ok(textBody(m3uBody, 'audio/x-mpegurl'));
      }
      if (url.pathname !== '/player_api.php') {
        return err(elvError('network', 'http-404'));
      }
      const action = url.searchParams.get('action');
      if (!action) {
        return ok(
          textBody(
            JSON.stringify({
              user_info: { auth: 1, status: 'Active', allowed_output_formats: ['ts'] },
              server_info: { timezone: 'UTC' },
            }),
            'application/json',
          ),
        );
      }
      if (action === 'get_live_categories') {
        return ok(
          textBody(
            JSON.stringify([{ category_id: '1', category_name: 'Xtream Pool' }]),
            'application/json',
          ),
        );
      }
      if (action === 'get_live_streams') {
        return ok(
          textBody(
            JSON.stringify([
              { stream_id: 501, name: 'Xtream Channel A', category_id: '1', num: 1 },
              { stream_id: 502, name: 'Xtream Channel B', category_id: '1', num: 2 },
            ]),
            'application/json',
          ),
        );
      }
      return ok(textBody(JSON.stringify([]), 'application/json'));
    },
  };
}

describe('enrichPlayTargetAccountKey & AppShell cross-source accountKey pooling (#265)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enriches target, previousChannel, nextEpisodes, and lazy playlist.getAt without nesting wrappers', async () => {
    const sharedFp = fingerprintXtreamCredentials(`http://${SYNTH_HOST}`, SYNTH_USER, SYNTH_PASS);
    expect(sharedFp).toMatch(/^fp:[0-9a-f]{64}$/);
    if (sharedFp === undefined) throw new Error('expected fingerprint');

    const sources: readonly SourceRow[] = [
      {
        id: 'src-xtream',
        kind: 'xtream',
        name: 'Xtream',
        createdAt: 1,
        needsImport: false,
        credentialFingerprint: sharedFp,
      },
      {
        id: 'src-m3u',
        kind: 'm3u',
        name: 'M3U',
        createdAt: 2,
        needsImport: false,
        credentialFingerprint: sharedFp,
      },
      {
        id: 'src-plain',
        kind: 'm3u',
        name: 'Plain M3U',
        createdAt: 3,
        needsImport: false,
      },
    ];

    let rawGetAtCalls = 0;
    const rawEntries: readonly PlayableEntry[] = [
      { itemKey: 'ch:0', sourceId: 'src-xtream', title: 'Ch 0', kind: 'live' },
      { itemKey: 'ch:1', sourceId: 'src-m3u', title: 'Ch 1', kind: 'live' },
      { itemKey: 'ch:2', sourceId: 'src-plain', title: 'Ch 2', kind: 'live' },
    ];
    const target: PlayTarget = {
      itemKey: 'ch:0',
      sourceId: 'src-xtream',
      title: 'Ch 0',
      kind: 'live',
      previousChannel: { itemKey: 'ch:1', sourceId: 'src-m3u', title: 'Ch 1', kind: 'live' },
      nextEpisodes: [
        { itemKey: 'ep:1', sourceId: 'src-m3u', title: 'Ep 1', kind: 'vod' },
        {
          itemKey: 'ep:2',
          sourceId: 'src-xtream',
          accountKey: 'fp:explicit-override',
          title: 'Ep 2',
          kind: 'vod',
        },
      ],
      playlist: {
        count: rawEntries.length,
        currentIndex: 0,
        onChangeIndex: jest.fn(),
        getAt: async (index) => {
          rawGetAtCalls += 1;
          return rawEntries[index];
        },
      },
    };

    const enrichedOnce = enrichPlayTargetAccountKey(target, sources);
    expect(enrichedOnce.accountKey).toBe(sharedFp);
    expect(enrichedOnce.previousChannel?.accountKey).toBe(sharedFp);
    expect(enrichedOnce.nextEpisodes?.[0]?.accountKey).toBe(sharedFp);
    expect(enrichedOnce.nextEpisodes?.[1]?.accountKey).toBe('fp:explicit-override');

    const p0 = await enrichedOnce.playlist?.getAt(0);
    const p1 = await enrichedOnce.playlist?.getAt(1);
    const p2 = await enrichedOnce.playlist?.getAt(2);
    const pMissing = await enrichedOnce.playlist?.getAt(99);
    expect(p0?.accountKey).toBe(sharedFp);
    expect(p1?.accountKey).toBe(sharedFp);
    expect(p2?.accountKey).toBe('src-plain');
    expect(pMissing).toBeUndefined();

    // Repeated enrichment across zaps re-uses the raw playlist instead of nesting async wrappers
    const { accountKey: _drop, ...withoutKey } = enrichedOnce;
    const enrichedTwice = enrichPlayTargetAccountKey(
      { ...withoutKey, itemKey: 'ch:1', sourceId: 'src-m3u' },
      sources,
    );
    expect(enrichedTwice.accountKey).toBe(sharedFp);
    const callsBefore = rawGetAtCalls;
    expect((await enrichedTwice.playlist?.getAt(1))?.accountKey).toBe(sharedFp);
    expect(rawGetAtCalls).toBe(callsBefore + 1);
  });

  it('pools Xtream and M3U sources with identical credentials under the same PlaybackService accountKey through AppShell -> PlayerScreen', async () => {
    const handle = testDb();
    const migrated = await openCatalog(handle.db);
    if (!migrated.ok) throw new Error('openCatalog failed');
    let nextId = 1;
    let now = 1_700_000_000_000;
    const catalog = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: createCrossSourceHttpClient(),
      clock: () => {
        now += 10;
        return now;
      },
      newId: () => `src-${nextId++}`,
    });

    try {
      const xtreamAdded = await catalog.addSource({
        kind: 'xtream',
        name: 'Xtream Same Creds',
        server: `http://${SYNTH_HOST}`,
        username: SYNTH_USER,
        password: SYNTH_PASS,
      });
      if (!xtreamAdded.ok) throw new Error('addSource xtream failed');
      const xtreamImported = await catalog.importSource(xtreamAdded.value.id);
      if (!xtreamImported.ok) throw new Error('importSource xtream failed');

      const m3uAdded = await catalog.addSource({
        kind: 'm3u',
        name: 'M3U Same Creds',
        playlistUrl: `http://${SYNTH_HOST}/playlist.m3u`,
      });
      if (!m3uAdded.ok) throw new Error('addSource m3u failed');
      const m3uImported = await catalog.importSource(m3uAdded.value.id);
      if (!m3uImported.ok) throw new Error('importSource m3u failed');

      const sources = await catalog.listSources();
      const xtreamRow = sources.find((s) => s.id === xtreamAdded.value.id);
      const m3uRow = sources.find((s) => s.id === m3uAdded.value.id);
      expect(xtreamRow?.credentialFingerprint).toMatch(/^fp:[0-9a-f]{64}$/);
      expect(m3uRow?.credentialFingerprint).toBe(xtreamRow?.credentialFingerprint);
      const expectedFp = xtreamRow?.credentialFingerprint;

      const xtreamCats = await catalog.categories(xtreamAdded.value.id, 'live');
      const m3uCats = await catalog.categories(m3uAdded.value.id, 'live');
      const xtreamItems = await catalog.items(xtreamCats[0]?.id ?? '', 0, 10);
      const m3uItems = await catalog.items(m3uCats[0]?.id ?? '', 0, 10);
      const xtreamResolved = await catalog.resolveStream(xtreamItems[0]?.key ?? '');
      const m3uResolved = await catalog.resolveStream(m3uItems[0]?.key ?? '');
      expect(xtreamResolved.ok && xtreamResolved.value.accountKey).toBe(expectedFp);
      expect(m3uResolved.ok && m3uResolved.value.accountKey).toBe(expectedFp);

      const engine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const videoHost: VideoHost = {
        open: () => ({
          engine,
          renderSurface: () => <View testID="pool-video-surface" />,
        }),
      };

      const view = await render(
        <AppProviders
          preferencesStore={createMemoryPreferencesStore()}
          systemLocale="en"
          viewport={{ formFactor: 'desktop' }}
        >
          <AppShell catalog={catalog} videoHost={videoHost} />
        </AppProviders>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('nav-tab-live')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('nav-tab-live'));
      await waitFor(() => {
        expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
      });

      // Play Xtream channel 0 via AppShell -> handlePlay enriches target.accountKey with expectedFp
      await fireEvent.press(screen.getByTestId('live-channel-card-0'));
      await waitFor(() => {
        expect(screen.getByTestId('player-osd')).toBeTruthy();
        expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
      });

      // Trigger connection-limit on Xtream channel -> PlaybackService holds accountKey === expectedFp
      const firstAttempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
      await act(async () => {
        engine.emit({
          attempt: firstAttempt,
          type: 'error',
          error: { code: 'http-429' },
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId('osd-status')).toHaveTextContent(
          'Waiting for active connection slot…',
        );
      });

      const loadsBeforeZap = engine.commands.filter((c) => c.name === 'load').length;

      // Zap inside Xtream playlist -> enriched playlist.getAt keeps PlaybackService held in 'limited'
      await fireEvent.press(screen.getByTestId('player-next'));
      await waitFor(() => {
        expect(screen.getByTestId('osd-title')).toHaveTextContent(/Xtream Channel B/);
      });
      expect(screen.getByTestId('osd-status')).toHaveTextContent(
        'Waiting for active connection slot…',
      );
      expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(loadsBeforeZap);

      // Exit to LiveScreen, switch to the M3U source category, and verify AppShell launches M3U Channel A
      await fireEvent.press(screen.getByTestId('player-back'));
      await waitFor(() => {
        expect(screen.getByTestId('live-cat-chip-1')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('live-cat-chip-1'));
      await waitFor(() => {
        expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('live-channel-card-0'));
      await waitFor(() => {
        expect(screen.getByTestId('osd-title')).toHaveTextContent(/M3U Channel A/);
      });

      // Prove directly on a real PlaybackService that Xtream + M3U PlayTargets enriched from real catalog sources
      // share the exact same credentialFingerprint accountKey and cross-source connection-limit hold
      const sharedEngine = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      const sharedService = createPlaybackService({
        engine: sharedEngine,
        clock: { now: () => performance.now() },
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      });
      const xtreamEnriched = enrichPlayTargetAccountKey(
        {
          itemKey: xtreamItems[0]?.key ?? '',
          sourceId: xtreamAdded.value.id,
          title: 'Xtream Channel A',
          kind: 'live',
        },
        sources,
      );
      const m3uEnriched = enrichPlayTargetAccountKey(
        {
          itemKey: m3uItems[0]?.key ?? '',
          sourceId: m3uAdded.value.id,
          title: 'M3U Channel A',
          kind: 'live',
        },
        sources,
      );
      expect(xtreamEnriched.accountKey).toBe(expectedFp);
      expect(m3uEnriched.accountKey).toBe(expectedFp);

      sharedService.tune({
        item: xtreamEnriched.itemKey,
        accountKey: xtreamEnriched.accountKey ?? xtreamEnriched.sourceId,
        kind: 'live',
        resolve: () => catalog.resolveStream(xtreamEnriched.itemKey),
      });
      await waitFor(() => {
        expect(sharedEngine.commands.some((c) => c.name === 'load')).toBe(true);
      });
      const xtAttempt = sharedEngine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
      sharedEngine.emit({ attempt: xtAttempt, type: 'error', error: { code: 'http-429' } });
      expect(sharedService.getState().status.kind).toBe('limited');
      const loadsAfterLimit = sharedEngine.commands.filter((c) => c.name === 'load').length;

      // Tuning M3U (different sourceId, same enriched accountKey) stays held in 'limited' with 0 extra loads
      sharedService.tune({
        item: m3uEnriched.itemKey,
        accountKey: m3uEnriched.accountKey ?? m3uEnriched.sourceId,
        kind: 'live',
        resolve: () => catalog.resolveStream(m3uEnriched.itemKey),
      });
      expect(sharedService.getState().status.kind).toBe('limited');
      expect(sharedService.getState().accountKey).toBe(expectedFp);
      expect(sharedEngine.commands.filter((c) => c.name === 'load')).toHaveLength(loadsAfterLimit);
      sharedService.dispose();

      await view.unmount();
    } finally {
      await catalog.close();
      handle.close();
    }
  });
});
