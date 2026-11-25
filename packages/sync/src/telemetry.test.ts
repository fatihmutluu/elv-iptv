import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SyncHttpPort, SyncHttpRequest } from './ports';
import {
  buildTelemetryPayloadPreview,
  createTelemetryQueue,
  createTelemetryUploader,
  sanitizeTelemetryEvent,
  TELEMETRY_EVENT_KINDS,
} from './telemetry';

describe('telemetry strict allowlist, redaction, queue, and opt-in uploader', () => {
  it('accepts all 10 allowlisted event kinds and strips unknown extra fields', () => {
    expect(TELEMETRY_EVENT_KINDS).toHaveLength(10);

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
});
