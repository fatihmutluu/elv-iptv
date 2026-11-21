import { elvError } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  type AccountHealthSnapshot,
  createPlaybackDiagnoser,
  DEFAULT_ACCOUNT_HEALTH_TTL_MS,
  diagnosePlaybackFailure,
  extractRedactedHost,
} from './diagnoser';

describe('extractRedactedHost', () => {
  it('extracts lowercase hostname[:port] and strips userinfo, path, query, and fragment', () => {
    const synthUser = 'alice';
    const synthPass = 's3cr3tPass';
    expect(
      extractRedactedHost(
        `https://${synthUser}:${synthPass}@CDN.Example.COM:8443/live/${synthUser}/${synthPass}/101.ts?token=abc123#frag`,
      ),
    ).toBe('cdn.example.com:8443');
    expect(extractRedactedHost('http://user:pass@stream.example.org/movie/42.mkv?key=xyz')).toBe(
      'stream.example.org',
    );
    expect(extractRedactedHost('https://cdn.example.com:443/live/1.m3u8')).toBe('cdn.example.com');
  });

  it('preserves IPv6 brackets and ports without leaking credentials or paths', () => {
    expect(extractRedactedHost('http://u:p@[2001:DB8::1]:8080/live/u/p/1.ts?tok=1')).toBe(
      '[2001:db8::1]:8080',
    );
    expect(extractRedactedHost('http://[::1]/secret/path')).toBe('[::1]');
  });

  it('returns undefined for empty, non-stream schemes, or unparseable URLs while allowing stream schemes', () => {
    expect(extractRedactedHost(undefined)).toBeUndefined();
    expect(extractRedactedHost('')).toBeUndefined();
    expect(extractRedactedHost('   ')).toBeUndefined();
    expect(extractRedactedHost('file:///Users/secret/video.mp4')).toBeUndefined();
    expect(extractRedactedHost('file://fileserver.local/share/video.mp4')).toBeUndefined();
    expect(extractRedactedHost('javascript://evil.example/%0aalert(1)')).toBeUndefined();
    expect(extractRedactedHost('data:text/plain;base64,SGVsbG8=')).toBeUndefined();
    expect(extractRedactedHost('ftp://user:pass@files.example/a.ts')).toBeUndefined();
    expect(extractRedactedHost('http://user:secret@not a valid url/path')).toBeUndefined();
    expect(extractRedactedHost('rtsp://user:pass@cam.example:554/live?token=1')).toBe(
      'cam.example:554',
    );
    expect(extractRedactedHost('rtmp://u:p@ingest.example/app/key')).toBe('ingest.example');
  });
});

describe('diagnosePlaybackFailure', () => {
  it('prioritizes offline over all other signals', () => {
    const diag = diagnosePlaybackFailure({
      error: elvError('playback', 'http-401'),
      online: false,
      httpStatus: 401,
      accountHealth: { status: 'Expired' },
      url: 'https://user:pass@cdn.example/live/secret.ts',
    });
    expect(diag.verdict).toBe('offline');
    expect(diag.host).toBe('cdn.example');
    expect(diag.evidence).not.toContain('user');
    expect(diag.evidence).not.toContain('pass');
    expect(diag.evidence).not.toContain('secret');
  });

  it('classifies accountHealth expired, disabled, and connection-limit ahead of HTTP errors', () => {
    const expiredByStatus = diagnosePlaybackFailure({
      error: elvError('playback', 'http-403'),
      httpStatus: 403,
      accountHealth: { status: 'Expired' },
    });
    expect(expiredByStatus.verdict).toBe('account-expired');

    const expiredByDate = diagnosePlaybackFailure({
      error: elvError('playback', 'http-403'),
      accountHealth: { status: 'Active', expiresAt: 1_700_000_000_000 },
      nowWallMs: 1_700_000_000_001,
    });
    expect(expiredByDate.verdict).toBe('account-expired');

    const disabled = diagnosePlaybackFailure({
      error: elvError('playback', 'http-403'),
      accountHealth: { status: 'Disabled' },
    });
    expect(disabled.verdict).toBe('account-disabled');

    const banned = diagnosePlaybackFailure({
      error: elvError('playback', 'http-403'),
      accountHealth: { status: 'Banned' },
    });
    expect(banned.verdict).toBe('account-disabled');

    const slotsFull = diagnosePlaybackFailure({
      error: elvError('playback', 'http-403'),
      accountHealth: { status: 'Active', activeConnections: 2, maxConnections: 2 },
    });
    expect(slotsFull.verdict).toBe('connection-limit');
  });

  it('classifies HTTP status and playback error codes into actionable verdicts', () => {
    expect(
      diagnosePlaybackFailure({ error: elvError('playback', 'http-other'), httpStatus: 401 })
        .verdict,
    ).toBe('auth-failed');
    expect(
      diagnosePlaybackFailure({ error: elvError('playback', 'http-other'), httpStatus: 403 })
        .verdict,
    ).toBe('auth-failed');
    expect(
      diagnosePlaybackFailure({ error: elvError('playback', 'http-other'), httpStatus: 404 })
        .verdict,
    ).toBe('not-found');
    expect(
      diagnosePlaybackFailure({ error: elvError('playback', 'http-other'), httpStatus: 410 })
        .verdict,
    ).toBe('not-found');

    for (const status of [429, 458, 460, 461, 462, 463, 469, 509]) {
      expect(
        diagnosePlaybackFailure({ error: elvError('playback', 'http-other'), httpStatus: status })
          .verdict,
      ).toBe('connection-limit');
    }
    expect(
      diagnosePlaybackFailure({ error: elvError('playback', 'connection-limit') }).verdict,
    ).toBe('connection-limit');

    expect(diagnosePlaybackFailure({ error: elvError('playback', 'decoder') }).verdict).toBe(
      'codec-unsupported',
    );
    expect(
      diagnosePlaybackFailure({ error: elvError('playback', 'unsupported-format') }).verdict,
    ).toBe('codec-unsupported');
    expect(diagnosePlaybackFailure({ error: elvError('auth', 'expired') }).verdict).toBe(
      'account-expired',
    );
    expect(diagnosePlaybackFailure({ error: elvError('auth', 'disabled') }).verdict).toBe(
      'account-disabled',
    );
    expect(
      diagnosePlaybackFailure({ error: elvError('auth', 'invalid-credentials') }).verdict,
    ).toBe('auth-failed');
  });

  it('distinguishes server-silent (0 bytes on network/timeout/5xx) from upstream-error and network-error', () => {
    const silent503 = diagnosePlaybackFailure({
      error: elvError('playback', 'http-other'),
      httpStatus: 503,
      bytesReceived: 0,
      url: 'https://user:pw@cdn.example/live/user/pw/1.ts?token=secret',
    });
    expect(silent503).toEqual({
      verdict: 'server-silent',
      httpStatus: 503,
      host: 'cdn.example',
      evidence: 'host=cdn.example status=503 bytes=0',
    });

    const upstream502 = diagnosePlaybackFailure({
      error: elvError('playback', 'http-other'),
      httpStatus: 502,
      bytesReceived: 1024,
      url: 'https://cdn.example/live/1.ts',
    });
    expect(upstream502.verdict).toBe('upstream-error');
    expect(upstream502.evidence).toBe('host=cdn.example status=502 bytes=1024');

    const silentTimeout = diagnosePlaybackFailure({
      error: elvError('network', 'timeout'),
      bytesReceived: 0,
    });
    expect(silentTimeout.verdict).toBe('server-silent');
    expect(silentTimeout.evidence).toBe('code=network/timeout bytes=0');

    const netDrop = diagnosePlaybackFailure({
      error: elvError('playback', 'network'),
      bytesReceived: 4096,
    });
    expect(netDrop.verdict).toBe('network-error');

    const decoder = diagnosePlaybackFailure({
      error: elvError('playback', 'decoder'),
      bytesReceived: 65536,
    });
    expect(decoder).toEqual({
      verdict: 'codec-unsupported',
      evidence: 'code=playback/decoder bytes=65536',
    });

    const unknown = diagnosePlaybackFailure({
      error: elvError('playback', 'unknown', 'secret-token-should-never-appear'),
    });
    expect(unknown.verdict).toBe('unknown');
    expect(unknown.evidence).toBe('code=playback/unknown');
    expect(unknown.evidence).not.toContain('secret-token');
  });
});

describe('createPlaybackDiagnoser', () => {
  it('exports DEFAULT_ACCOUNT_HEALTH_TTL_MS = 60_000 and caches account health on a monotonic clock', async () => {
    expect(DEFAULT_ACCOUNT_HEALTH_TTL_MS).toBe(60_000);
    let now = 10_000;
    const probe = vi.fn(
      async (_key: string): Promise<AccountHealthSnapshot | undefined> => ({
        status: 'Expired',
      }),
    );
    const diagnoser = createPlaybackDiagnoser({
      clock: { now: () => now },
      checkAccountHealth: probe,
    });

    const first = await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(first.verdict).toBe('account-expired');
    expect(probe).toHaveBeenCalledTimes(1);

    now += 59_999;
    const cached = await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(cached.verdict).toBe('account-expired');
    expect(probe).toHaveBeenCalledTimes(1);

    now += 1;
    await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent in-flight account health probes per accountKey', async () => {
    let resolveProbe!: (v: AccountHealthSnapshot | undefined) => void;
    const probe = vi.fn(
      () =>
        new Promise<AccountHealthSnapshot | undefined>((res) => {
          resolveProbe = res;
        }),
    );
    const diagnoser = createPlaybackDiagnoser({
      clock: { now: () => 1000 },
      checkAccountHealth: probe,
    });

    const p1 = diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    const p2 = diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe({ status: 'Active', activeConnections: 1, maxConnections: 1 });
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.verdict).toBe('connection-limit');
    expect(d2.verdict).toBe('connection-limit');
  });

  it('swallows health probe errors gracefully, skips probe when offline, and supports invalidate/clear', async () => {
    let now = 5000;
    const probe = vi
      .fn<(key: string) => Promise<AccountHealthSnapshot | undefined>>()
      .mockRejectedValueOnce(new Error('probe network failure'))
      .mockResolvedValueOnce({ status: 'Disabled' })
      .mockResolvedValueOnce({ status: 'Active' });

    const diagnoser = createPlaybackDiagnoser({
      clock: { now: () => now },
      checkAccountHealth: probe,
    });

    // Offline skips probe completely
    const offline = await diagnoser.diagnose({
      error: elvError('playback', 'network'),
      online: false,
      accountKey: 'acc-1',
    });
    expect(offline.verdict).toBe('offline');
    expect(probe).not.toHaveBeenCalled();

    // Failed probe is swallowed and falls back to HTTP/error diagnosis without poisoning cache
    const fallback = await diagnoser.diagnose({
      error: elvError('playback', 'http-401'),
      accountKey: 'acc-1',
    });
    expect(fallback.verdict).toBe('auth-failed');
    expect(probe).toHaveBeenCalledTimes(1);

    // Next call retries probe and caches result
    const disabled = await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(disabled.verdict).toBe('account-disabled');
    expect(probe).toHaveBeenCalledTimes(2);

    // invalidate(key) evicts cached entry
    diagnoser.invalidate('acc-1');
    const active = await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(active.verdict).toBe('auth-failed');
    expect(probe).toHaveBeenCalledTimes(3);

    // invalidate() with no key clears all entries
    now += 10;
    diagnoser.invalidate();
    probe.mockResolvedValueOnce({ status: 'Expired' });
    const afterClear = await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(afterClear.verdict).toBe('account-expired');
    expect(probe).toHaveBeenCalledTimes(4);

    diagnoser.clear();
    probe.mockResolvedValueOnce({ status: 'Active' });
    const afterExplicitClear = await diagnoser.diagnose({
      error: elvError('playback', 'http-403'),
      accountKey: 'acc-1',
    });
    expect(afterExplicitClear.verdict).toBe('auth-failed');
    expect(probe).toHaveBeenCalledTimes(5);
  });
});
