import { type HttpClient, type HttpResponse, ok, type Result, type SecretStore } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import type { PlayableRow } from './queries';
import { type SourceRecord, secretKey } from './sources';
import { saveStalkerCmdMap, stalkerStaticFlagKey } from './stalker-cmds-store';
import {
  loadStalkerSecret,
  sanitizeStalkerImageUrl,
  saveStalkerDiscovery,
  stalkerCmdKey,
} from './stalker-secret';
import { createStalkerResolverState } from './stream-resolver-stalker';
import type { SourceStreamMeta } from './stream-resolver-types';

const utf8 = (s: string) => new TextEncoder().encode(s);

function jsonBody(data: unknown): AsyncIterable<Uint8Array> {
  const bytes = utf8(JSON.stringify(data));
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function makeSource(transport?: SourceRecord['settings']['transport']): SourceRecord {
  return {
    id: 'st1',
    kind: 'stalker',
    name: 'Portal',
    createdAt: 1_700_000_000_000,
    settings: {
      serverTimezone: 'Europe/Istanbul',
      ...(transport !== undefined ? { transport } : {}),
    },
  };
}

function makePlay(
  streamKind: PlayableRow['streamKind'],
  providerId: string,
  episodeNumber?: number,
): PlayableRow {
  return {
    sourceId: 'st1',
    streamKind,
    providerId,
    extension: null,
    urlTemplate: null,
    headersJson: null,
    backupUrlsJson: null,
    episodeNumber: episodeNumber ?? null,
  };
}

const allowHttp = (raw: string) => /^https?:\/\//i.test(raw);
const identityUrl = (url: string) => url;

describe('STK-2: stream-resolver-stalker static link semantics & safe portal playback headers', () => {
  it('skips create_link ONLY when both static flags are false on non-local remote http(s) live/movie URLs', async () => {
    const secrets = memorySecrets();
    secrets.data.set(
      secretKey('st1', 'stalker'),
      JSON.stringify({
        portalUrl: 'https://portal.example.test/stalker_portal/server/load.php',
        mac: '00:1A:79:11:22:33',
        serialNumber: 'SN-777',
        discoveredEndpoint: 'https://portal.example.test/stalker_portal/server/load.php',
        portalMode: 'full',
      }),
    );

    const cmds: Record<string, string> = {
      [stalkerCmdKey('live', 'static-portal')]: 'ffmpeg https://portal.example.test/live/10.ts',
      [stalkerStaticFlagKey('live', 'static-portal')]: '1',
      [stalkerCmdKey('movie', 'static-cdn')]: 'ffrt http://cdn.thirdparty.test/movie.mp4',
      [stalkerStaticFlagKey('movie', 'static-cdn')]: '1',
      [stalkerCmdKey('live', 'static-downgrade')]: 'http://portal.example.test/live/downgrade.ts',
      [stalkerStaticFlagKey('live', 'static-downgrade')]: '1',
      [stalkerCmdKey('live', 'loopback-localhost')]: 'ffrt3 http://localhost/ch/1_',
      [stalkerStaticFlagKey('live', 'loopback-localhost')]: '1',
      [stalkerCmdKey('live', 'loopback-127')]: 'http://127.0.0.2:8080/ch/2',
      [stalkerStaticFlagKey('live', 'loopback-127')]: '1',
      [stalkerCmdKey('live', 'loopback-v6')]: 'http://[::1]/ch/3',
      [stalkerStaticFlagKey('live', 'loopback-v6')]: '1',
      [stalkerCmdKey('live', 'loopback-sub')]: 'http://edge.localhost/ch/4',
      [stalkerStaticFlagKey('live', 'loopback-sub')]: '1',
      [stalkerCmdKey('movie', 'relative-cmd')]: '/media/file_10.mpg',
      [stalkerStaticFlagKey('movie', 'relative-cmd')]: '1',
      [stalkerCmdKey('live', 'unflagged')]: 'https://portal.example.test/live/unflagged.ts',
      [stalkerCmdKey('series', 'ep1')]: 'https://portal.example.test/series/ep1.mp4',
    };
    await saveStalkerCmdMap(secrets, 'st1', cmds);

    const createLinkCmds: string[] = [];
    const http: HttpClient = {
      async get(url: string): Promise<Result<HttpResponse>> {
        const parsed = new URL(url);
        const action = parsed.searchParams.get('action');
        if (action === 'handshake') {
          return ok({
            status: 200,
            headers: {},
            body: jsonBody({ js: { token: 'LIVE-TOK' } }),
            finalUrl: url,
          });
        }
        if (action === 'create_link') {
          const cmd = parsed.searchParams.get('cmd') ?? '';
          createLinkCmds.push(cmd);
          return ok({
            status: 200,
            headers: {},
            body: jsonBody({
              js: { cmd: `https://portal.example.test/minted/${createLinkCmds.length}.ts` },
            }),
            finalUrl: url,
          });
        }
        return ok({ status: 200, headers: {}, body: jsonBody({ js: [] }), finalUrl: url });
      },
    };

    const source = makeSource({
      userAgent: 'FeedUA/1.0',
      streamUserAgent: 'PlayerUA/2.0',
      referer: 'https://portal.example.test/c/',
    });
    const resolver = createStalkerResolverState({ secrets, http });
    const connMeta: SourceStreamMeta['connectionMeta'] = { maxConnections: 1 };

    // 1. Static portal-owned HTTPS live URL: skips create_link AND attaches safe portal playback headers + streamUserAgent
    const staticPortal = await resolver.resolvePrimaryUrl(
      source,
      makePlay('live', 'static-portal'),
      connMeta,
      allowHttp,
      identityUrl,
    );
    expect(staticPortal.ok).toBe(true);
    if (staticPortal.ok) {
      expect(staticPortal.value.url).toBe('https://portal.example.test/live/10.ts');
      expect(staticPortal.value.headers?.['user-agent']).toBe('PlayerUA/2.0');
      expect(staticPortal.value.headers?.referer).toBe('https://portal.example.test/c/');
      expect(staticPortal.value.headers?.cookie).toContain('mac=00%3A1A%3A79%3A11%3A22%3A33');
      expect(staticPortal.value.headers?.['x-user-agent']).toBe('Model: MAG250; Link: WiFi');
      expect(staticPortal.value.headers?.sn).toBe('SN-777');
    }
    expect(createLinkCmds).toHaveLength(0);

    // 2. Static third-party CDN VOD URL: skips create_link AND strips portal session headers (keeps streamTransportHeaders)
    const staticCdn = await resolver.resolvePrimaryUrl(
      source,
      makePlay('movie', 'static-cdn'),
      connMeta,
      allowHttp,
      identityUrl,
    );
    expect(staticCdn.ok).toBe(true);
    if (staticCdn.ok) {
      expect(staticCdn.value.url).toBe('http://cdn.thirdparty.test/movie.mp4');
      expect(staticCdn.value.headers?.['user-agent']).toBe('PlayerUA/2.0');
      expect(staticCdn.value.headers?.referer).toBe('https://portal.example.test/c/');
      expect(staticCdn.value.headers?.cookie).toBeUndefined();
      expect(staticCdn.value.headers?.authorization).toBeUndefined();
      expect(staticCdn.value.headers?.sn).toBeUndefined();
    }
    expect(createLinkCmds).toHaveLength(0);

    // 3. Static same-host HTTPS -> HTTP downgrade: skips create_link, MUST strip portal session headers
    const staticDowngrade = await resolver.resolvePrimaryUrl(
      source,
      makePlay('live', 'static-downgrade'),
      connMeta,
      allowHttp,
      identityUrl,
    );
    expect(staticDowngrade.ok).toBe(true);
    if (staticDowngrade.ok) {
      expect(staticDowngrade.value.url).toBe('http://portal.example.test/live/downgrade.ts');
      expect(staticDowngrade.value.headers?.cookie).toBeUndefined();
      expect(staticDowngrade.value.headers?.sn).toBeUndefined();
    }
    expect(createLinkCmds).toHaveLength(0);

    // 4. Loopback hosts, relative paths, missing flags, and series MUST still invoke create_link!
    for (const [kind, id] of [
      ['live', 'loopback-localhost'],
      ['live', 'loopback-127'],
      ['live', 'loopback-v6'],
      ['live', 'loopback-sub'],
      ['movie', 'relative-cmd'],
      ['live', 'unflagged'],
      ['series', 'ep1'],
    ] as const) {
      const r = await resolver.resolvePrimaryUrl(
        source,
        makePlay(kind, id, kind === 'series' ? 1 : undefined),
        connMeta,
        allowHttp,
        identityUrl,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        // After full handshake, minted same-host HTTPS URL carries Authorization + Cookie + SN
        expect(r.value.headers?.authorization).toBe('Bearer LIVE-TOK');
        expect(r.value.headers?.cookie).toContain('mac=00%3A1A%3A79%3A11%3A22%3A33');
      }
    }
    expect(createLinkCmds).toHaveLength(7);

    // 5. Catch-up resolution also attaches safe portal headers + streamUserAgent
    const catchup = await resolver.resolveCatchup(
      source,
      's:st1:live:unflagged',
      'unflagged',
      3,
      { startMs: 1_700_000_000_000 - 3_600_000, stopMs: 1_700_000_000_000 },
      1_700_000_000_000,
      { headers: { 'user-agent': 'FeedUA/1.0' }, accountKey: 'acc', connectionMeta: connMeta },
      allowHttp,
      identityUrl,
    );
    expect(catchup.ok).toBe(true);
    if (catchup.ok) {
      expect(catchup.value.headers['user-agent']).toBe('PlayerUA/2.0');
      expect(catchup.value.headers.authorization).toBe('Bearer LIVE-TOK');
      expect(catchup.value.headers.cookie).toContain('mac=00%3A1A%3A79%3A11%3A22%3A33');
      expect(catchup.value.headers.sn).toBe('SN-777');
    }

    // 6. Static catch-up URL skips create_link
    const beforeCount = createLinkCmds.length;
    const staticCatchup = await resolver.resolveCatchup(
      source,
      's:st1:live:static-portal',
      'static-portal',
      3,
      { startMs: 1_700_000_000_000 - 3_600_000, stopMs: 1_700_000_000_000 },
      1_700_000_000_000,
      { headers: {}, accountKey: 'acc', connectionMeta: connMeta },
      allowHttp,
      identityUrl,
    );
    expect(staticCatchup.ok).toBe(true);
    expect(createLinkCmds).toHaveLength(beforeCount);

    // 7. Missing providerId, evict/clear, and missing secret error paths
    const noId = await resolver.resolvePrimaryUrl(
      source,
      makePlay('live', '   '),
      connMeta,
      allowHttp,
      identityUrl,
    );
    expect(noId.ok).toBe(false);
    resolver.evict('st1');
    resolver.clear();
    secrets.data.delete(secretKey('st1', 'stalker'));
    const noSecret = await resolver.resolvePrimaryUrl(
      source,
      makePlay('live', 'static-portal'),
      connMeta,
      allowHttp,
      identityUrl,
    );
    expect(noSecret.ok).toBe(false);
    if (!noSecret.ok) expect(noSecret.error.code).toBe('secret-missing');
  });

  it('persists newly discovered endpoint during play-time create_link and guards corrupt metadata', async () => {
    const secrets = memorySecrets();
    secrets.data.set(
      secretKey('st2', 'stalker'),
      JSON.stringify({
        portalUrl: 'http://discover.example.test',
        mac: '00:1A:79:55:66:77',
        deviceId: 'D1',
        deviceId2: 'D2',
        signature: 'SIG',
        login: 'u',
        password: 'p',
      }),
    );
    await saveStalkerCmdMap(secrets, 'st2', {
      [stalkerCmdKey('live', '1')]: 'ffmpeg http://localhost/ch/1',
      'epmeta:bad': '{not-json',
      'vodseries:bad': '{"t":"invalid"}',
    });

    const http: HttpClient = {
      async get(url: string): Promise<Result<HttpResponse>> {
        const parsed = new URL(url);
        if (parsed.pathname !== '/server/load.php') {
          return ok({ status: 404, headers: {}, body: jsonBody('nope'), finalUrl: url });
        }
        const action = parsed.searchParams.get('action');
        if (action === 'get_genres') {
          return ok({
            status: 200,
            headers: {},
            body: jsonBody({ js: [{ id: '1', title: 'Live' }] }),
            finalUrl: url,
          });
        }
        return ok({
          status: 200,
          headers: {},
          body: jsonBody({ js: { cmd: 'http://discover.example.test/stream/1.ts' } }),
          finalUrl: url,
        });
      },
    };

    const source: SourceRecord = { ...makeSource(), id: 'st2' };
    const resolver = createStalkerResolverState({ secrets, http });
    const res = await resolver.resolvePrimaryUrl(
      source,
      { ...makePlay('live', '1'), sourceId: 'st2' },
      { maxConnections: 1 },
      allowHttp,
      identityUrl,
    );
    expect(res.ok).toBe(true);
    const saved = JSON.parse(secrets.data.get(secretKey('st2', 'stalker')) ?? '{}');
    expect(saved.discoveredEndpoint).toBe('http://discover.example.test/server/load.php');
    expect(saved.portalMode).toBe('simple');

    // Secret loading, deleted-source discovery guard, and image URL sanitization
    secrets.data.set(secretKey('badjson', 'stalker'), '{broken');
    expect(await loadStalkerSecret(secrets, 'badjson')).toBeUndefined();
    secrets.data.set(
      secretKey('badmac', 'stalker'),
      JSON.stringify({ portalUrl: 'http://ok.test', mac: 'invalid' }),
    );
    expect(await loadStalkerSecret(secrets, 'badmac')).toBeUndefined();
    const loadedSt2 = await loadStalkerSecret(secrets, 'st2');
    expect(loadedSt2?.deviceId).toBe('D1');
    if (loadedSt2 !== undefined) {
      secrets.data.delete(secretKey('st2', 'stalker'));
      const unchanged = await saveStalkerDiscovery(secrets, 'st2', loadedSt2, {
        endpoint: 'http://discover.example.test/portal.php',
        mode: 'full',
      });
      expect(unchanged).toBe(loadedSt2);
      expect(secrets.data.has(secretKey('st2', 'stalker'))).toBe(false);
    }
    expect(
      sanitizeStalkerImageUrl(
        'https://portal.example.test/img.png',
        'portal.example.test',
        '00:1A:79:11:22:33',
      ),
    ).toBeUndefined();
    expect(
      sanitizeStalkerImageUrl(
        'https://cdn.example.test/img.png?mac=00:1A:79:11:22:33',
        'portal.example.test',
        '00:1A:79:11:22:33',
      ),
    ).toBeUndefined();
    expect(
      sanitizeStalkerImageUrl(
        'https://cdn.example.test/00-1a-79-11-22-33.png',
        'portal.example.test',
        '00:1A:79:11:22:33',
      ),
    ).toBeUndefined();
    expect(
      sanitizeStalkerImageUrl(
        'https://cdn.example.test/001a79112233.png',
        'portal.example.test',
        '00:1A:79:11:22:33',
      ),
    ).toBeUndefined();
    expect(
      sanitizeStalkerImageUrl(
        'https://cdn.example.test/safe.png',
        'portal.example.test',
        '00:1A:79:11:22:33',
      ),
    ).toBe('https://cdn.example.test/safe.png');
  });
});
