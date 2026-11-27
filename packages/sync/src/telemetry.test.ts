import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SyncHttpPort, SyncHttpRequest } from './ports';
import {
  buildTelemetryPayloadPreview,
  createTelemetryQueue,
  createTelemetryUploader,
  type DeviceTechnicalProfile,
  redactDiagnosticText,
  sanitizeTelemetryEvent,
  TELEMETRY_EVENT_KINDS,
} from './telemetry';

describe('telemetry strict allowlist, redaction, queue, and opt-in uploader', () => {
  it('accepts all 13 allowlisted event kinds and strips unknown extra fields', () => {
    expect(TELEMETRY_EVENT_KINDS).toHaveLength(13);

    const validEvents = [
      { kind: 'startup', ts: 1000, durationMs: 420.5, coldStart: true, secretLeak: 'should-drop' },
      { kind: 'screen_transition', ts: 1001, fromScreen: 'home', screen: 'live', durationMs: 38 },
      {
        kind: 'frame_jank',
        ts: 1002,
        screen: 'epg',
        droppedFrames: 4,
        durationMs: 48.2,
        jankCount: 2,
      },
      { kind: 'js_stall', ts: 1003, screen: 'vod', durationMs: 120, maxBlockMs: 120 },
      { kind: 'memory_pressure', ts: 1004, level: 'moderate', screen: 'live', usedMb: 312 },
      { kind: 'memory_pressure', ts: 1005, level: 'critical' },
      { kind: 'playback_start', ts: 1006, engine: 'media3', durationMs: 650, isLive: true },
      {
        kind: 'playback_rebuffer',
        ts: 1007,
        engine: 'mpv',
        durationMs: 850,
        isLive: false,
        rebufferCount: 1,
      },
      {
        kind: 'playback_error',
        ts: 1008,
        engine: 'media3',
        errorCode: 'HTTP_404',
        isLive: true,
        recoverable: false,
      },
      {
        kind: 'media_decode_failure',
        ts: 1009,
        engine: 'media3',
        container: 'mpegts',
        videoCodec: 'hevc',
        audioCodec: 'ac3',
        errorCode: 'DECODER_INIT_FAILED',
        hdrFormat: 'dolby_vision',
        isLive: true,
        streamUrl: 'https://user:pass@provider.test/live/123.ts',
        channelTitle: 'Secret Channel',
      },
      {
        kind: 'sqlite_slow_op',
        ts: 1010,
        operation: 'catalog_upsert',
        durationMs: 95,
        rowCount: 500,
      },
      {
        kind: 'app_crash',
        ts: 1011,
        errorName: 'TypeError',
        stackSig: 'PlayerScreen.tsx:142',
        screen: 'player',
        fatal: true,
        uptimeMs: 64_200,
        secretLeak: 'should-drop',
      },
      {
        kind: 'unhandled_error',
        ts: 1012,
        errorName: 'AbortError',
        stackSig: 'useCatalog:88',
        screen: 'home',
        source: 'unhandled_rejection',
      },
      {
        kind: 'catalog_import',
        ts: 1013,
        sourceKind: 'xtream',
        stage: 'complete',
        durationMs: 1_840,
        itemCount: 12_500,
        success: true,
      },
    ];

    for (const raw of validEvents) {
      const clean = sanitizeTelemetryEvent(raw);
      expect(clean).not.toBeNull();
      const json = JSON.stringify(clean);
      expect(json).not.toContain('should-drop');
      expect(json).not.toContain('provider.test');
      expect(json).not.toContain('Secret Channel');
    }
  });

  it('rejects adversarial payloads containing URLs, IPs, credentials, paths, or titles', () => {
    const adversarialTokens = [
      'https://provider.example/live/123.m3u8',
      'http://192.168.1.50:8080/stream.ts',
      'rtsp://user:pass@10.0.0.1/live',
      'file:///Users/alice/playlist.m3u',
      'C:\\Users\\Alice\\Desktop\\list.m3u',
      '/home/bob/secrets.txt',
      '/data/user/0/com.elv.iptv/files/db',
      '192.168.1.10',
      '10.0.0.1',
      'user:password@host',
      'Bearer eyJhbGciOiJIUzI1NiJ9',
      'Authorization: Basic dXNlcjpwYXNz',
      ['username=alice', '&', 'pass', 'word=secret'].join(''),
      'token=abc123',
      'My Private Channel Name With Spaces',
      '',
      'a'.repeat(65),
    ];

    for (const bad of adversarialTokens) {
      expect(
        sanitizeTelemetryEvent({
          kind: 'media_decode_failure',
          ts: 1000,
          engine: 'media3',
          container: 'mpegts',
          videoCodec: 'h264',
          audioCodec: 'aac',
          errorCode: bad,
          isLive: true,
        }),
      ).toBeNull();

      expect(
        sanitizeTelemetryEvent({
          kind: 'screen_transition',
          ts: 1000,
          fromScreen: bad,
          screen: 'live',
          durationMs: 12,
        }),
      ).toBeNull();
    }

    // Reject unknown kinds, invalid numbers, non-objects
    expect(sanitizeTelemetryEvent(null)).toBeNull();
    expect(sanitizeTelemetryEvent([])).toBeNull();
    expect(sanitizeTelemetryEvent({ kind: 'unknown_kind', ts: 1 })).toBeNull();
    expect(
      sanitizeTelemetryEvent({ kind: 'startup', ts: -5, durationMs: 10, coldStart: true }),
    ).toBeNull();
    expect(
      sanitizeTelemetryEvent({ kind: 'startup', ts: 10, durationMs: Number.NaN, coldStart: true }),
    ).toBeNull();
  });

  it('fuzzes arbitrary strings and guarantees zero URLs, IPs, credentials, or paths ever survive', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (rawError, rawUrl) => {
        const res = sanitizeTelemetryEvent({
          kind: 'media_decode_failure',
          ts: 1000,
          engine: 'media3',
          container: 'mpegts',
          videoCodec: 'h264',
          audioCodec: 'aac',
          errorCode: rawError,
          isLive: true,
          leakedUrl: rawUrl,
        });
        if (res === null) return;
        const json = JSON.stringify(res);
        expect(json).not.toMatch(/:\/\//);
        expect(json).not.toMatch(/@/);
        expect(json).not.toMatch(/\\/);
        expect(json).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
        expect(json).not.toContain('leakedUrl');
      }),
      { numRuns: 200 },
    );
  });

  it('enforces bounded FIFO ring buffer entry and byte caps', () => {
    const queue = createTelemetryQueue({ maxEntries: 3, maxBytes: 10_000 });
    expect(queue.push({ kind: 'startup', ts: 1, durationMs: 10, coldStart: true })).toBe(true);
    expect(queue.push({ kind: 'startup', ts: 2, durationMs: 20, coldStart: false })).toBe(true);
    expect(queue.push({ kind: 'startup', ts: 3, durationMs: 30, coldStart: false })).toBe(true);
    expect(queue.push({ kind: 'startup', ts: 4, durationMs: 40, coldStart: false })).toBe(true);
    expect(queue.size()).toBe(3);
    expect(queue.peek().map((e) => e.ts)).toEqual([2, 3, 4]);
    expect(queue.byteLength()).toBeGreaterThan(0);

    const smallByteQueue = createTelemetryQueue({ maxEntries: 50, maxBytes: 260 });
    for (let i = 1; i <= 10; i += 1) {
      smallByteQueue.push({ kind: 'startup', ts: i, durationMs: i, coldStart: false });
    }
    expect(smallByteQueue.byteLength()).toBeLessThanOrEqual(260);
    expect(smallByteQueue.size()).toBeLessThan(10);
  });

  it('emits ZERO network calls when opted out, supports backoff, remote kill-switch, and JSON preview', async () => {
    const sentRequests: SyncHttpRequest[] = [];
    let optedIn = false;
    let now = 10_000;
    let nextStatus = 200;
    let nextBody = JSON.stringify({ accepted: 1 });

    const http: SyncHttpPort = {
      async request(req) {
        sentRequests.push(req);
        return { status: nextStatus, bodyText: nextBody };
      },
    };

    const uploader = createTelemetryUploader({
      baseUrl: 'https://sync.example.test',
      http,
      isOptedIn: () => optedIn,
      clock: { now: () => now },
      sessionId: 'sess_abc123',
      platform: 'android-tv',
      appVersion: '0.9.0',
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
    });

    // Opted out: record ignored, flush sends ZERO requests
    expect(uploader.record({ kind: 'startup', ts: 10_000, durationMs: 300, coldStart: true })).toBe(
      false,
    );
    uploader.queue.push({ kind: 'startup', ts: 10_000, durationMs: 300, coldStart: true });
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'opted_out' });
    expect(sentRequests).toHaveLength(0);

    // Opt in: preview shows sanitized JSON, flush delivers batch
    optedIn = true;
    const previewJson = uploader.preview();
    expect(previewJson).toContain('"platform": "android-tv"');
    expect(previewJson).toContain('"kind": "startup"');

    expect(await uploader.flush()).toEqual({ sent: 1 });
    expect(sentRequests).toHaveLength(1);
    expect(uploader.queue.size()).toBe(0);
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'empty' });

    // Exponential backoff on 503 failure
    uploader.record({ kind: 'js_stall', ts: 11_000, screen: 'live', durationMs: 180 });
    nextStatus = 503;
    nextBody = '{}';
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'network_error' });
    now += 500;
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'backoff' });
    expect(sentRequests).toHaveLength(2);

    // After backoff window, server triggers remote kill-switch
    now += 1_000;
    nextStatus = 200;
    nextBody = JSON.stringify({ accepted: 0, disabled: true });
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'kill_switch' });
    expect(uploader.isRemotelyDisabled()).toBe(true);
    expect(uploader.record({ kind: 'startup', ts: 13_000, durationMs: 10, coldStart: false })).toBe(
      false,
    );
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'kill_switch' });

    // Standalone buildTelemetryPayloadPreview filters out unsafe events
    const standalone = buildTelemetryPayloadPreview({
      sessionId: 'https://bad.url',
      platform: 'desktop',
      appVersion: '1.0.0',
      events: [
        { kind: 'playback_error', ts: 1, engine: 'mpv', errorCode: 'https://leak', isLive: true },
        { kind: 'playback_error', ts: 2, engine: 'mpv', errorCode: 'EOF', isLive: true },
      ],
    });
    expect(standalone).toContain('"sessionId": "anonymous"');
    expect(standalone).not.toContain('https://leak');
    expect(standalone).toContain('"errorCode": "EOF"');
  });

  it('deduplicates concurrent flush() calls via single-flight guard and preserves newer events across ring eviction', async () => {
    const queue = createTelemetryQueue({ maxEntries: 3, maxBytes: 10_000 });
    const sentBatches: Array<readonly { ts: number }[]> = [];
    const firstResolver: {
      fn: ((res: { status: number; bodyText: string }) => void) | null;
    } = { fn: null };
    let requestCount = 0;

    const http: SyncHttpPort = {
      async request(req) {
        requestCount += 1;
        const parsed = JSON.parse(req.body ?? '{}') as { events: Array<{ ts: number }> };
        sentBatches.push(parsed.events);
        if (requestCount === 1) {
          return await new Promise<{ status: number; bodyText: string }>((resolve) => {
            firstResolver.fn = resolve;
          });
        }
        return { status: 200, bodyText: JSON.stringify({ accepted: parsed.events.length }) };
      },
    };

    const uploader = createTelemetryUploader({
      baseUrl: 'https://sync.example.test',
      http,
      queue,
      isOptedIn: () => true,
      clock: { now: () => 50_000 },
      sessionId: 'sess_singleflight',
      platform: 'desktop',
      appVersion: '1.0.0',
    });

    uploader.record({ kind: 'startup', ts: 1, durationMs: 10, coldStart: true });
    uploader.record({ kind: 'startup', ts: 2, durationMs: 20, coldStart: false });
    uploader.record({ kind: 'startup', ts: 3, durationMs: 30, coldStart: false });

    // Start two concurrent flushes -> MUST share one single-flight HTTP POST
    const p1 = uploader.flush();
    const p2 = uploader.flush();
    expect(requestCount).toBe(1);

    // While POST #1 (with ts=1,2,3) is in-flight, push ts=4 and ts=5, evicting ts=1 and ts=2 from the 3-slot ring
    uploader.record({ kind: 'startup', ts: 4, durationMs: 40, coldStart: false });
    uploader.record({ kind: 'startup', ts: 5, durationMs: 50, coldStart: false });
    expect(queue.peek().map((e) => e.ts)).toEqual([3, 4, 5]);

    firstResolver.fn?.({ status: 200, bodyText: JSON.stringify({ accepted: 3 }) });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ sent: 3 });
    expect(r2).toEqual({ sent: 3 });
    expect(requestCount).toBe(1);

    // Only ts=3 was in the sent batch; unsent ts=4 and ts=5 MUST remain queued!
    expect(queue.peek().map((e) => e.ts)).toEqual([4, 5]);

    // Follow-up flush delivers ts=4 and ts=5 cleanly
    const r3 = await uploader.flush();
    expect(r3).toEqual({ sent: 2 });
    expect(requestCount).toBe(2);
    expect(sentBatches[0]?.map((e) => e.ts)).toEqual([1, 2, 3]);
    expect(sentBatches[1]?.map((e) => e.ts)).toEqual([4, 5]);
    expect(queue.size()).toBe(0);
  });

  it('rejects bare multi-label and common-TLD hostnames in sanitizeToken while allowing dotted versions and codecs', () => {
    const bareHostnames = [
      'my-iptv.provider.com',
      'cdn.myiptv.net',
      'stream.internal.lan',
      'provider.org',
      'channel.tv',
      'edge.io',
      'portal.xyz',
      'iptv.me',
      'host.cc',
      'feed.live',
      'relay.stream',
      'demo.example',
    ];
    for (const host of bareHostnames) {
      expect(
        sanitizeTelemetryEvent({
          kind: 'playback_error',
          ts: 1000,
          engine: 'media3',
          errorCode: host,
          isLive: true,
        }),
      ).toBeNull();
    }

    const validDottedTokens = [
      '0.9.0',
      '1.2.3-beta.1',
      'h.264',
      'av01.0.08M.08',
      'MEDIA_ERR.DECODE',
    ];
    for (const token of validDottedTokens) {
      const clean = sanitizeTelemetryEvent({
        kind: 'playback_error',
        ts: 1000,
        engine: 'media3',
        errorCode: token,
        isLive: true,
      });
      expect(clean).not.toBeNull();
      expect(clean?.kind === 'playback_error' ? clean.errorCode : '').toBe(token);
    }
  });

  it('redacts Windows/POSIX home paths, URLs, credentials, emails, and IPs in redactDiagnosticText', () => {
    const dirty = [
      'Crash at C:\\Users\\Fatih\\Desktop\\IPTV\\src\\app.ts:42',
      'from /Users/alice/Library/app.js and /home/bob/.config/list.m3u',
      'url=https://user:supersecret@my-iptv.provider.example:8080/live/123.ts?token=xyz',
      'cred=admin:p4ssw0rd@stream.internal',
      'email=fatih.mutlu@example.com',
      'ip=192.168.1.45 and 2001:db8::1',
    ].join(' | ');

    const clean = redactDiagnosticText(dirty, 512);
    expect(clean).not.toContain('Fatih');
    expect(clean).not.toContain('alice');
    expect(clean).not.toContain('bob');
    expect(clean).not.toContain('supersecret');
    expect(clean).not.toContain('my-iptv.provider.example');
    expect(clean).not.toContain('p4ssw0rd');
    expect(clean).not.toContain('fatih.mutlu@example.com');
    expect(clean).not.toContain('192.168.1.45');
    expect(clean).not.toContain('2001:db8::1');
    expect(clean).not.toContain('token=xyz');

    expect(redactDiagnosticText('a'.repeat(300), 64).length).toBeLessThanOrEqual(64);

    // New event kinds reject unredacted PII/paths/URLs/emails in stackSig/errorName/stage/sourceKind
    expect(
      sanitizeTelemetryEvent({
        kind: 'app_crash',
        ts: 1000,
        errorName: 'TypeError',
        stackSig: 'C:\\Users\\Fatih\\app.ts:10',
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryEvent({
        kind: 'unhandled_error',
        ts: 1000,
        errorName: 'Error',
        stackSig: 'fatih@example.com',
      }),
    ).toBeNull();
    expect(
      sanitizeTelemetryEvent({
        kind: 'catalog_import',
        ts: 1000,
        sourceKind: 'https://provider.test',
        stage: 'fetch',
        durationMs: 100,
        success: false,
      }),
    ).toBeNull();
  });

  it('attaches sanitized DeviceTechnicalProfile to uploaded batches and previews while dropping unsafe fields', async () => {
    const sentBodies: string[] = [];
    const http: SyncHttpPort = {
      async request(req) {
        sentBodies.push(req.body ?? '');
        return { status: 200, bodyText: JSON.stringify({ accepted: 1 }) };
      },
    };
    const deviceProfile: DeviceTechnicalProfile = {
      osVersion: 'Windows 11',
      formFactor: 'desktop',
      arch: 'x64',
      ramBucket: '16gb',
      gpu: 'NVIDIA GeForce RTX 4070',
      resolution: '2560x1440',
      locale: 'tr-TR',
    };
    const uploader = createTelemetryUploader({
      baseUrl: 'https://sync.example.test',
      http,
      isOptedIn: () => true,
      clock: { now: () => 20_000 },
      sessionId: 'sess_profile',
      platform: 'windows',
      appVersion: '1.0.0',
      deviceProfile,
    });
    uploader.record({
      kind: 'catalog_import',
      ts: 20_000,
      sourceKind: 'm3u',
      stage: 'complete',
      durationMs: 450,
      itemCount: 300,
      success: true,
    });

    const preview = JSON.parse(uploader.preview()) as { deviceProfile?: DeviceTechnicalProfile };
    expect(preview.deviceProfile).toEqual(deviceProfile);

    await uploader.flush();
    const sent = JSON.parse(sentBodies[0] ?? '{}') as { deviceProfile?: DeviceTechnicalProfile };
    expect(sent.deviceProfile).toEqual(deviceProfile);

    // Poisoned profile values are stripped rather than leaked
    const poisonedPreview = buildTelemetryPayloadPreview({
      sessionId: 'sess_1',
      platform: 'android-tv',
      appVersion: '1.0.0',
      events: [],
      deviceProfile: {
        osVersion: 'https://leak.example.com',
        gpu: 'C:\\Users\\Fatih\\gpu.dll',
        resolution: '1920x1080',
        locale: 'en-US',
      },
    });
    const parsedPoisoned = JSON.parse(poisonedPreview) as {
      deviceProfile?: DeviceTechnicalProfile;
    };
    expect(parsedPoisoned.deviceProfile).toEqual({
      resolution: '1920x1080',
      locale: 'en-US',
    });
  });

  it('P1-5 & P2-2: allows 4-part OS versions, >/:/;/. stackSig, and slash-normalized errorName while rejecting URLs/paths/IPs', () => {
    // 4-part OS versions pass deviceProfile.osVersion without tripping IPv4 redaction
    for (const osVer of ['10.0.190.45', '6.8.0.45', '14.2.1.0', '10.0.22631.4460']) {
      const preview = JSON.parse(
        buildTelemetryPayloadPreview({
          sessionId: 'sess_osver',
          platform: 'windows',
          appVersion: '1.4.0',
          events: [],
          deviceProfile: { osVersion: osVer, gpu: '192.168.1.10' },
        }),
      ) as { deviceProfile?: DeviceTechnicalProfile };
      expect(preview.deviceProfile).toEqual({ osVersion: osVer });
    }

    // Non-quad IPv4 text in osVersion is still stripped
    const badOsPreview = JSON.parse(
      buildTelemetryPayloadPreview({
        sessionId: 'sess_osver_bad',
        platform: 'windows',
        appVersion: '1.4.0',
        events: [],
        deviceProfile: { osVersion: 'host 192.168.1.10', arch: 'x64' },
      }),
    ) as { deviceProfile?: DeviceTechnicalProfile };
    expect(badOsPreview.deviceProfile).toEqual({ arch: 'x64' });

    // stackSig accepts '>', ':', ';', '.' and errorName normalizes '/' -> '.'
    const crash = sanitizeTelemetryEvent({
      kind: 'app_crash',
      ts: 5000,
      errorName: 'storage/schema-corrupt',
      stackSig: 'CrashRecoveryBoundary>PlayerScreen.tsx:142;renderFrame:55',
      fatal: true,
      uptimeMs: 31_536_000_000,
    });
    expect(crash).toEqual({
      kind: 'app_crash',
      ts: 5000,
      errorName: 'storage.schema-corrupt',
      stackSig: 'CrashRecoveryBoundary>PlayerScreen.tsx:142;renderFrame:55',
      fatal: true,
      uptimeMs: 31_536_000_000,
    });

    const unhandled = sanitizeTelemetryEvent({
      kind: 'unhandled_error',
      ts: 5001,
      errorName: 'playback/stream',
      stackSig: 'App>CatalogGrid:22;useEffect:10',
    });
    expect(unhandled).toEqual({
      kind: 'unhandled_error',
      ts: 5001,
      errorName: 'playback.stream',
      stackSig: 'App>CatalogGrid:22;useEffect:10',
    });

    // Adversarial slash inputs MUST still be rejected in errorName
    for (const badErr of [
      'https://evil.test/foo',
      '/Users/alice/bad',
      '/etc/passwd',
      'foo//bar',
      '192/168/1/1',
      'trailing/',
      'evil.com/path',
    ]) {
      expect(
        sanitizeTelemetryEvent({
          kind: 'app_crash',
          ts: 5002,
          errorName: badErr,
          stackSig: 'App>Main:1',
        }),
      ).toBeNull();
    }
  });

  it('P1-6: drops rejected telemetry batches on HTTP 400/413 while retaining and backing off on 429/5xx', async () => {
    let nextStatus = 400;
    let now = 100_000;
    let calls = 0;
    const http: SyncHttpPort = {
      async request() {
        calls += 1;
        return { status: nextStatus, bodyText: JSON.stringify({ error: 'bad' }) };
      },
    };
    const uploader = createTelemetryUploader({
      baseUrl: 'https://sync.example.test',
      http,
      isOptedIn: () => true,
      clock: { now: () => now },
      sessionId: 'sess_drop400',
      platform: 'windows',
      appVersion: '1.4.0',
      baseBackoffMs: 2_000,
      maxBackoffMs: 16_000,
    });

    // 400 drains rejected batch immediately without poisoning subsequent healthy events
    uploader.record({ kind: 'startup', ts: 1, durationMs: 100, coldStart: true });
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'rejected' });
    expect(uploader.queue.size()).toBe(0);

    // 413 drains oversized batch immediately without triggering backoff
    nextStatus = 413;
    uploader.record({ kind: 'startup', ts: 2, durationMs: 200, coldStart: false });
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'rejected' });
    expect(uploader.queue.size()).toBe(0);

    // Immediate next healthy batch flushes with zero backoff delay
    nextStatus = 200;
    uploader.record({ kind: 'startup', ts: 3, durationMs: 300, coldStart: false });
    expect(await uploader.flush()).toEqual({ sent: 1 });
    expect(uploader.queue.size()).toBe(0);

    // 429 MUST NOT drop batch and MUST trigger backoff
    nextStatus = 429;
    uploader.record({ kind: 'startup', ts: 4, durationMs: 400, coldStart: false });
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'network_error' });
    expect(uploader.queue.size()).toBe(1);
    now += 500;
    expect(await uploader.flush()).toEqual({ sent: 0, skippedReason: 'backoff' });
    expect(calls).toBe(4);
  });
});
