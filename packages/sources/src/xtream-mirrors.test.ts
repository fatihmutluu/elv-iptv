import { elvError, err, type HttpClient, type HttpRequestOptions, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient } from './xtream';
import {
  buildAttemptOrder,
  buildServerEntries,
  createMirrorSlotState,
  findServerIndex,
} from './xtream-mirrors';
import { resolveXtreamBaseUrl } from './xtream-scheme';
import { expectErr, PASS, USER, value } from './xtream-test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);
const hostsOf = (urls: readonly string[]) => urls.map((u) => new URL(u).host);
const okJson = (payload: string) =>
  ok({
    status: 200,
    headers: {},
    body: (async function* () {
      yield enc(payload);
    })(),
  });

describe('createMirrorSlotState (#317)', () => {
  it('handles single-server slots as a safe no-op', () => {
    let now = 1_000;
    const slot = createMirrorSlotState(1, 300_000, () => now);
    expect(slot.activeIndex()).toBe(0);
    expect(slot.attemptOrder()).toEqual({ order: [0], probePrimary: false });
    slot.reportFailure(0);
    slot.reportFailure();
    slot.markPrimaryProbeFailed();
    expect(slot.activeIndex()).toBe(0);
    expect(slot.attemptOrder()).toEqual({ order: [0], probePrimary: false });
    now += 400_000;
    expect(slot.attemptOrder()).toEqual({ order: [0], probePrimary: false });
  });

  it('tracks multi-mirror failover, primary cooldown probing, recovery, and reset', () => {
    let now = 10_000;
    const slot = createMirrorSlotState(3, 300_000, () => now);
    expect(slot.activeIndex()).toBe(0);
    expect(slot.attemptOrder()).toEqual({ order: [0, 1, 2], probePrimary: false });

    // Primary fails -> moves to backup1 (index 1) and starts cooldown
    slot.reportFailure(0);
    expect(slot.activeIndex()).toBe(1);
    expect(slot.attemptOrder()).toEqual({ order: [1, 2, 0], probePrimary: false });

    // Failure on non-active backup (index 2) or out-of-range index is ignored
    slot.reportFailure(2);
    slot.reportFailure(-1);
    slot.reportFailure(99);
    expect(slot.activeIndex()).toBe(1);

    // Before cooldown elapses, probePrimary remains false
    now += 299_999;
    expect(slot.attemptOrder()).toEqual({ order: [1, 2, 0], probePrimary: false });

    // At cooldown boundary, attemptOrder probes primary first
    now += 1;
    expect(slot.attemptOrder()).toEqual({ order: [0, 1, 2], probePrimary: true });

    // Failed primary probe refreshes cooldown and stays on backup1
    slot.markPrimaryProbeFailed();
    expect(slot.activeIndex()).toBe(1);
    expect(slot.attemptOrder()).toEqual({ order: [1, 2, 0], probePrimary: false });

    // Cooldown elapses again; omitted-index reportFailure fails the probed primary, keeping backup1
    now += 300_000;
    expect(slot.attemptOrder()).toEqual({ order: [0, 1, 2], probePrimary: true });
    slot.reportFailure();
    expect(slot.activeIndex()).toBe(1);
    expect(slot.attemptOrder()).toEqual({ order: [1, 2, 0], probePrimary: false });

    // Failing active backup1 during cooldown advances to backup2, then wraps to primary (0)
    slot.reportFailure();
    expect(slot.activeIndex()).toBe(2);
    expect(slot.attemptOrder()).toEqual({ order: [2, 1, 0], probePrimary: false });

    slot.reportFailure(2);
    expect(slot.activeIndex()).toBe(0);
    expect(slot.attemptOrder()).toEqual({ order: [0, 1, 2], probePrimary: false });

    // Direct promotion of backup2 starts cooldown; markSuccess(0) restores primary and clears cooldown
    slot.markSuccess(2);
    slot.markSuccess(99);
    expect(slot.activeIndex()).toBe(2);
    now += 300_000;
    expect(slot.attemptOrder()).toEqual({ order: [0, 2, 1], probePrimary: true });
    slot.markSuccess(0);
    expect(slot.activeIndex()).toBe(0);
    expect(slot.attemptOrder()).toEqual({ order: [0, 1, 2], probePrimary: false });

    // reset() restores index 0 and clears cooldown
    slot.reportFailure(0);
    expect(slot.activeIndex()).toBe(1);
    slot.reset();
    expect(slot.activeIndex()).toBe(0);
    expect(slot.attemptOrder()).toEqual({ order: [0, 1, 2], probePrimary: false });
  });

  it('builds attempt orders directly via buildAttemptOrder', () => {
    expect(buildAttemptOrder(1, 0, false)).toEqual([0]);
    expect(buildAttemptOrder(3, 0, false)).toEqual([0, 1, 2]);
    expect(buildAttemptOrder(3, 2, false)).toEqual([2, 1, 0]);
    expect(buildAttemptOrder(3, 2, true)).toEqual([0, 2, 1]);
  });
});

describe('findServerIndex (#317)', () => {
  const entries = buildServerEntries('http://primary.example', [
    'http://backup1.example:8080',
    'https://secure.example',
  ]);
  const resolveBase = (e: (typeof entries)[number]) =>
    e.explicitScheme ? e.raw : resolveXtreamBaseUrl(e.raw);

  it('matches by normalized scheme+host+port ignoring credentials, path, case, and default ports', () => {
    expect(findServerIndex(entries, 'http://primary.example/live/u/p/1.ts', resolveBase)).toBe(0);
    expect(findServerIndex(entries, 'HTTP://PRIMARY.EXAMPLE:80/live/1.ts', resolveBase)).toBe(0);
    expect(
      findServerIndex(entries, 'http://u:p@BACKUP1.EXAMPLE:8080/movie/u/p/9.mp4?x=1', resolveBase),
    ).toBe(1);
    expect(findServerIndex(entries, 'https://secure.example:443/series/1.mkv', resolveBase)).toBe(
      2,
    );
    expect(findServerIndex(entries, 'backup1.example:8080', resolveBase)).toBe(1);
    expect(findServerIndex(entries, 'user:pass@PRIMARY.EXAMPLE/live/1.ts', resolveBase)).toBe(0);
  });

  it('returns -1 for scheme mismatches, unknown hosts, non-HTTP schemes, or blank input', () => {
    expect(findServerIndex(entries, 'https://primary.example/live/1.ts', resolveBase)).toBe(-1);
    expect(findServerIndex(entries, 'http://unknown.example/live/1.ts', resolveBase)).toBe(-1);
    expect(findServerIndex(entries, 'ftp://primary.example/live/1.ts', resolveBase)).toBe(-1);
    expect(findServerIndex(entries, '   ', resolveBase)).toBe(-1);
    expect(findServerIndex(entries, undefined, resolveBase)).toBe(-1);
  });
});

describe('Xtream split API vs stream failover (#317)', () => {
  function makeSplitFixture(initialNow = 10_000) {
    let monoNow = initialNow;
    const requestedHosts: string[] = [];
    let primaryApiHealthy = true;

    const http: HttpClient = {
      async get(url) {
        const host = new URL(url).host;
        requestedHosts.push(host);
        if (host === 'primary.example' && !primaryApiHealthy) {
          return ok({ status: 503, headers: {}, body: (async function* () {})() });
        }
        const payload = url.includes('action=')
          ? '[]'
          : JSON.stringify({ user_info: { auth: 1, status: 'Active' }, server_info: {} });
        return okJson(payload);
      },
    };

    const createClient = (primaryCooldownMs?: number) =>
      createXtreamClient({
        http,
        server: 'http://primary.example',
        backupServers: ['http://backup1.example', 'http://backup2.example'],
        ...(primaryCooldownMs === undefined ? {} : { primaryCooldownMs }),
        username: USER,
        password: PASS,
        rateLimit: { now: () => monoNow },
      });

    return {
      createClient,
      requestedHosts,
      advanceMs: (ms: number) => {
        monoNow += ms;
      },
      setPrimaryApiHealthy: (healthy: boolean) => {
        primaryApiHealthy = healthy;
      },
    };
  }

  it('switches activeStreamServer and streamUrl on stream failure without affecting activeApiServer or API calls', async () => {
    const fx = makeSplitFixture();
    const c = fx.createClient();

    expect(c.activeApiServer()).toBe('http://primary.example');
    expect(c.activeStreamServer()).toBe('http://primary.example');
    expect(c.streamUrls('live', 42)).toEqual([
      `http://primary.example/live/${USER}/${encodeURIComponent(PASS)}/42.ts`,
      `http://backup1.example/live/${USER}/${encodeURIComponent(PASS)}/42.ts`,
      `http://backup2.example/live/${USER}/${encodeURIComponent(PASS)}/42.ts`,
    ]);

    c.reportStreamFailure(c.streamUrl('live', 42));
    expect(c.activeStreamServer()).toBe('http://backup1.example');
    expect(c.streamUrl('live', 42)).toContain('http://backup1.example/live/');
    expect(hostsOf(c.streamUrls('live', 42))).toEqual([
      'backup1.example',
      'backup2.example',
      'primary.example',
    ]);

    // API slot remains untouched on primary
    expect(c.activeApiServer()).toBe('http://primary.example');
    expect(c.playlistUrl()).toContain('http://primary.example/get.php?');
    expect(c.guideUrl()).toContain('http://primary.example/xmltv.php?');
    expect(value(await c.account()).status).toBe('Active');
    expect(value(await c.liveStreams())).toEqual([]);
    expect(fx.requestedHosts).toEqual(['primary.example', 'primary.example']);
  });

  it('switches activeApiServer on API 503 failover while keeping activeStreamServer on primary', async () => {
    const fx = makeSplitFixture();
    const c = fx.createClient();
    fx.setPrimaryApiHealthy(false);

    expect(value(await c.liveStreams())).toEqual([]);
    expect(fx.requestedHosts).toEqual(['primary.example', 'backup1.example']);
    expect(c.activeApiServer()).toBe('http://backup1.example');
    expect(c.playlistUrl()).toContain('http://backup1.example/get.php?');
    expect(c.guideUrl()).toContain('http://backup1.example/xmltv.php?');

    // Stream slot stays on primary (index 0)
    expect(c.activeStreamServer()).toBe('http://primary.example');
    expect(c.streamUrl('live', 7)).toContain('http://primary.example/live/');
    expect(hostsOf(c.streamUrls('movie', 9, 'mkv'))).toEqual([
      'primary.example',
      'backup1.example',
      'backup2.example',
    ]);
  });

  it('probes primary stream after default 5 min cooldown, restarts cooldown on probe failure, and promotes on success', () => {
    const fx = makeSplitFixture();
    const c = fx.createClient();

    // Fail primary stream -> moves to backup1
    c.reportStreamFailure();
    expect(c.activeStreamServer()).toBe('http://backup1.example');
    expect(c.streamUrl('live', 10)).toContain('http://backup1.example/live/');

    // Unrecognized host failure/success is a safe no-op
    c.reportStreamFailure('http://unrelated.example/live/u/p/10.ts');
    c.reportStreamSuccess('http://unrelated.example/live/u/p/10.ts');
    expect(c.activeStreamServer()).toBe('http://backup1.example');

    // Before 300_000 ms default cooldown: still prefers backup1
    fx.advanceMs(299_999);
    expect(hostsOf(c.streamUrls('live', 10))).toEqual([
      'backup1.example',
      'backup2.example',
      'primary.example',
    ]);

    // At 300_000 ms: primary is placed first to probe recovery
    fx.advanceMs(1);
    const probeUrls = c.streamUrls('live', 10);
    expect(hostsOf(probeUrls)).toEqual(['primary.example', 'backup1.example', 'backup2.example']);
    expect(c.streamUrl('live', 10)).toBe(probeUrls[0]);

    // If primary probe fails again -> stays on backup1 and restarts cooldown cleanly
    c.reportStreamFailure(probeUrls[0]);
    expect(c.activeStreamServer()).toBe('http://backup1.example');
    expect(hostsOf(c.streamUrls('live', 10))).toEqual([
      'backup1.example',
      'backup2.example',
      'primary.example',
    ]);

    // Wait another 300_000 ms -> probes primary again; success promotes primary and clears cooldown
    fx.advanceMs(300_000);
    const secondProbe = c.streamUrl('live', 10);
    expect(secondProbe).toContain('http://primary.example/live/');
    c.reportStreamSuccess(secondProbe);
    expect(c.activeStreamServer()).toBe('http://primary.example');
    expect(hostsOf(c.streamUrls('live', 10))).toEqual([
      'primary.example',
      'backup1.example',
      'backup2.example',
    ]);

    // Omitted-URL reportStreamSuccess during probe also promotes primary
    c.reportStreamFailure();
    fx.advanceMs(300_000);
    expect(c.streamUrl('live', 10)).toContain('http://primary.example/live/');
    c.reportStreamSuccess();
    expect(c.activeStreamServer()).toBe('http://primary.example');
  });

  it('restores both slots to primary on resetMirrors() and always starts new sessions on primary', async () => {
    const fx = makeSplitFixture();
    const c = fx.createClient();
    fx.setPrimaryApiHealthy(false);

    expect(value(await c.liveStreams())).toEqual([]);
    c.reportStreamFailure();
    c.reportStreamFailure();
    expect(c.activeApiServer()).toBe('http://backup1.example');
    expect(c.activeStreamServer()).toBe('http://backup2.example');

    c.resetMirrors();
    expect(c.activeApiServer()).toBe('http://primary.example');
    expect(c.activeStreamServer()).toBe('http://primary.example');
    expect(c.streamUrl('live', 1)).toContain('http://primary.example/live/');

    // New client session always starts on primary (index 0)
    const fresh = fx.createClient();
    expect(fresh.activeApiServer()).toBe('http://primary.example');
    expect(fresh.activeStreamServer()).toBe('http://primary.example');
  });
});

describe('Xtream transport dnsFamily and hostOverride propagation (#172)', () => {
  it('forwards dnsFamily and hostOverride to http.get options on JSON and streaming calls', async () => {
    const seenOptions: Array<HttpRequestOptions | undefined> = [];
    const http: HttpClient = {
      async get(_url, options) {
        seenOptions.push(options);
        return okJson('[{"stream_id":1,"name":"Ch 1"}]');
      },
    };

    const c = createXtreamClient({
      http,
      server: 'https://panel.example:8443',
      username: USER,
      password: PASS,
      transport: {
        dnsFamily: 'ipv4',
        hostOverride: '203.0.113.10',
        allowLegacyTls: true,
      },
    });

    expect(value(await c.liveStreams())).toHaveLength(1);
    const gen = c.streamLiveStreams();
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
    }

    expect(seenOptions).toHaveLength(2);
    for (const opt of seenOptions) {
      expect(opt?.dnsFamily).toBe('ipv4');
      expect(opt?.hostOverride).toBe('203.0.113.10');
      expect(opt?.allowLegacyTls).toBe(true);
    }
  });

  it('omits dnsFamily and hostOverride when undefined and never leaks credentials on failure', async () => {
    const seenOptions: Array<HttpRequestOptions | undefined> = [];
    let shouldFail = false;
    const http: HttpClient = {
      async get(url, options) {
        seenOptions.push(options);
        if (shouldFail) return err(elvError('network', 'connect-failed', `failed ${url}`));
        return okJson('[]');
      },
    };

    const plain = createXtreamClient({
      http,
      server: 'http://panel.example',
      username: USER,
      password: PASS,
    });
    expect(value(await plain.liveStreams())).toEqual([]);
    expect(seenOptions[0]).not.toHaveProperty('dnsFamily');
    expect(seenOptions[0]).not.toHaveProperty('hostOverride');

    shouldFail = true;
    const overridden = createXtreamClient({
      http,
      server: 'https://panel.example',
      username: USER,
      password: PASS,
      transport: { dnsFamily: 'ipv6', hostOverride: '2001:db8::1' },
    });
    const failed = await overridden.liveStreams();
    const e = expectErr(failed, 'network', 'connect-failed');
    expect(e.detail).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain(PASS);
    expect(JSON.stringify(failed)).not.toContain(encodeURIComponent(PASS));
    expect(seenOptions[1]?.dnsFamily).toBe('ipv6');
    expect(seenOptions[1]?.hostOverride).toBe('2001:db8::1');
  });

  it('scopes hostOverride strictly to the primary server host and omits it on backup mirror failovers (#172, #317)', async () => {
    const calls: Array<{ host: string; options: HttpRequestOptions | undefined }> = [];
    const http: HttpClient = {
      async get(url, options) {
        const host = new URL(url).hostname;
        calls.push({ host, options });
        if (host === 'primary.example') {
          return ok({ status: 503, headers: {}, body: (async function* () {})() });
        }
        return okJson('[{"stream_id":1,"name":"Ch 1"}]');
      },
    };

    const c = createXtreamClient({
      http,
      server: 'https://primary.example:8443',
      backupServers: ['https://backup1.example:8443', 'https://primary.example:9443'],
      username: USER,
      password: PASS,
      transport: {
        dnsFamily: 'ipv4',
        hostOverride: '203.0.113.10',
        allowLegacyTls: true,
      },
    });

    expect(value(await c.liveStreams())).toHaveLength(1);
    expect(calls).toHaveLength(2);
    // Primary host receives hostOverride + dnsFamily + allowLegacyTls
    expect(calls[0]?.host).toBe('primary.example');
    expect(calls[0]?.options?.hostOverride).toBe('203.0.113.10');
    expect(calls[0]?.options?.dnsFamily).toBe('ipv4');
    expect(calls[0]?.options?.allowLegacyTls).toBe(true);
    // Backup mirror on distinct domain MUST NOT receive primary's hostOverride IP (keeps dnsFamily)
    expect(calls[1]?.host).toBe('backup1.example');
    expect(calls[1]?.options?.hostOverride).toBeUndefined();
    expect(calls[1]?.options?.dnsFamily).toBe('ipv4');
  });
});
