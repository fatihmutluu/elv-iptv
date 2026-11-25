import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatTelemetryDigestMarkdown,
  loadTelemetryDigest,
  parseTelemetryDigestArgs,
  runTelemetryDigestCli,
  type TelemetryDigestReport,
} from '../src/telemetry-digest.ts';

const SAMPLE_REPORT: TelemetryDigestReport = {
  generatedAt: '2026-11-25T15:00:00.000Z',
  since: '2026-11-24T15:00:00.000Z',
  totals: {
    telemetryEvents: 42,
    uniqueSessions: 6,
    feedbackSubmissions: 2,
  },
  pendingAccountDeletionRequests: 3,
  versionPlatformMatrix: [
    {
      appVersion: '1.3.0',
      platform: 'android-tv',
      events: 30,
      sessions: 4,
      decodeFailures: 5,
      playbackErrors: 2,
      feedbackCount: 1,
    },
    {
      appVersion: '1.3.0',
      platform: 'windows',
      events: 12,
      sessions: 2,
      decodeFailures: 0,
      playbackErrors: 1,
      feedbackCount: 1,
    },
  ],
  startupLatency: {
    count: 6,
    p50Ms: 390,
    p95Ms: 820,
    maxMs: 910,
  },
  screenLatencies: [
    { screen: 'epg-grid', count: 14, p50Ms: 145, p95Ms: 410, maxMs: 530 },
    { screen: 'live-tv', count: 22, p50Ms: 70, p95Ms: 190, maxMs: 240 },
  ],
  stallAndJank: {
    frameJankEvents: 9,
    frameJankRatePerSession: 1.5,
    jsStallEvents: 3,
    jsStallRatePerSession: 0.5,
    maxStallMs: 640,
    slowSqliteOps: 2,
    slowSqliteP95Ms: 215,
    memoryPressureEvents: 1,
    playbackRebufferEvents: 4,
    playbackStartCount: 12,
    playbackStartP95Ms: 780,
    hotspots: [
      { screen: 'epg-grid', frameJankEvents: 7, jsStallEvents: 2, maxDurationMs: 640 },
      { screen: 'movies', frameJankEvents: 2, jsStallEvents: 1, maxDurationMs: 290 },
    ],
  },
  mediaDecodeFailures: [
    {
      platform: 'android-tv',
      engine: 'media3',
      container: 'mpegts',
      videoCodec: 'hevc',
      audioCodec: 'ac3',
      errorCode: 'DECODER_INIT_FAILED',
      hdrFormat: 'hdr10',
      isLive: true,
      count: 4,
    },
    {
      platform: 'android-tv',
      engine: 'media3',
      container: 'mkv',
      videoCodec: 'vc1',
      audioCodec: 'dts',
      errorCode: 'NO_DECODER',
      hdrFormat: null,
      isLive: false,
      count: 1,
    },
  ],
  feedbackByCategory: {
    playback_issue: 1,
    channel_epg: 0,
    ui_remote: 1,
    sync_account: 0,
    feature_request: 0,
    other: 0,
  },
  recentFeedback: [
    {
      id: 'fb-2',
      receivedAt: '2026-11-25T14:30:00.000Z',
      category: 'playback_issue',
      appVersion: '1.3.0',
      platform: 'android-tv',
      locale: 'tr',
      message: 'HEVC AC3 live stream dropped audio | stuttered',
      hasDiagnostics: true,
    },
    {
      id: 'fb-1',
      receivedAt: '2026-11-25T10:00:00.000Z',
      category: 'ui_remote',
      appVersion: '1.3.0',
      platform: 'windows',
      locale: 'en',
      message: 'Keyboard search shortcut feels super snappy',
      hasDiagnostics: false,
    },
  ],
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elv-telemetry-digest-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('telemetry-digest CLI', () => {
  it('parses CLI arguments and validates mutual exclusion, format, and ISO --since', () => {
    const parsedInput = parseTelemetryDigestArgs(
      ['--input', 'digest.json', '--format', 'json', '--since', '2026-11-25T00:00:00Z'],
      {},
    );
    expect(parsedInput).toEqual({
      input: 'digest.json',
      url: null,
      format: 'json',
      out: null,
      since: '2026-11-25T00:00:00.000Z',
      help: false,
    });

    const parsedEnvUrl = parseTelemetryDigestArgs([], {
      ELV_SYNC_URL: 'https://sync.example.test',
    });
    expect(parsedEnvUrl.url).toBe('https://sync.example.test');
    expect(parsedEnvUrl.format).toBe('md');

    expect(() =>
      parseTelemetryDigestArgs(['--input', 'a.json', '--url', 'https://sync.example.test'], {}),
    ).toThrow(/not both/i);
    expect(() => parseTelemetryDigestArgs([], {})).toThrow(/missing data source/i);
    expect(() => parseTelemetryDigestArgs(['--input', 'a.json', '--format', 'yaml'], {})).toThrow(
      /invalid --format/i,
    );
    expect(() => parseTelemetryDigestArgs(['--input', 'a.json', '--since', 'nope'], {})).toThrow(
      /invalid --since/i,
    );
  });

  it('formats an AI-ready Markdown digest with all required sections including #70 decode failure matrix', () => {
    const md = formatTelemetryDigestMarkdown(SAMPLE_REPORT);
    expect(md).toContain('# ELV IPTV Telemetry & Feedback Digest');
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('- **Pending Account Deletion Requests:** 3');
    expect(md).toContain('## Version & Platform Matrix');
    expect(md).toContain('## Startup & Screen Latency (p50 / p95)');
    expect(md).toContain('## Stall & Jank Hotspots');
    expect(md).toContain(
      '## Media Decode Failure Matrix (Container / Video Codec / Audio Codec / Engine — #70 Signal)',
    );
    expect(md).toContain('## Categorized User Feedback');
    expect(md).toContain(
      '| android-tv | media3 | mpegts | hevc | ac3 | hdr10 | Live | DECODER_INIT_FAILED | 4 |',
    );
    expect(md).toContain('| android-tv | media3 | mkv | vc1 | dts | sdr | VOD | NO_DECODER | 1 |');
    expect(md).toContain('[diagnostics attached]');
    expect(md).toContain('HEVC AC3 live stream dropped audio \\| stuttered');
  });

  it('formats an empty report cleanly without throwing', () => {
    const empty: TelemetryDigestReport = {
      generatedAt: '2026-11-25T15:00:00.000Z',
      since: null,
      totals: { telemetryEvents: 0, uniqueSessions: 0, feedbackSubmissions: 0 },
      pendingAccountDeletionRequests: 0,
      versionPlatformMatrix: [],
      startupLatency: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
      screenLatencies: [],
      stallAndJank: {
        frameJankEvents: 0,
        frameJankRatePerSession: 0,
        jsStallEvents: 0,
        jsStallRatePerSession: 0,
        maxStallMs: null,
        slowSqliteOps: 0,
        slowSqliteP95Ms: null,
        memoryPressureEvents: 0,
        playbackRebufferEvents: 0,
        playbackStartCount: 0,
        playbackStartP95Ms: null,
        hotspots: [],
      },
      mediaDecodeFailures: [],
      feedbackByCategory: {
        playback_issue: 0,
        channel_epg: 0,
        ui_remote: 0,
        sync_account: 0,
        feature_request: 0,
        other: 0,
      },
      recentFeedback: [],
    };
    const md = formatTelemetryDigestMarkdown(empty);
    expect(md).toContain('- **Pending Account Deletion Requests:** 0');
    expect(md).toContain('_No media decode failures recorded in this window._');
    expect(md).toContain('_No recent user feedback submissions._');
  });

  it('defaults legacy reports without pendingAccountDeletionRequests to 0 and rejects invalid types', async () => {
    const dir = makeTempDir();
    const legacyPath = join(dir, 'legacy.json');
    const { pendingAccountDeletionRequests: _omit, ...legacy } = SAMPLE_REPORT;
    writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8');

    const loaded = await loadTelemetryDigest(
      { input: legacyPath, url: null, format: 'md', out: null, since: null, help: false },
      {},
    );
    expect(loaded.pendingAccountDeletionRequests).toBe(0);

    const invalidPath = join(dir, 'invalid.json');
    writeFileSync(
      invalidPath,
      JSON.stringify({ ...SAMPLE_REPORT, pendingAccountDeletionRequests: 'bad' }),
      'utf8',
    );
    await expect(
      loadTelemetryDigest(
        { input: invalidPath, url: null, format: 'md', out: null, since: null, help: false },
        {},
      ),
    ).rejects.toThrow(/TelemetryDigestReport schema/);
  });

  it('loads from --input JSON, filters --since, and writes --out via runTelemetryDigestCli', async () => {
    const dir = makeTempDir();
    const inputPath = join(dir, 'report.json');
    const outPath = join(dir, 'nested', 'digest.md');
    writeFileSync(inputPath, JSON.stringify(SAMPLE_REPORT), 'utf8');

    let outLog = '';
    let errLog = '';
    const code = await runTelemetryDigestCli(
      ['--input', inputPath, '--since', '2026-11-25T12:00:00.000Z', '--out', outPath],
      {
        env: {},
        stdout: (s) => {
          outLog += s;
        },
        stderr: (s) => {
          errLog += s;
        },
      },
    );
    expect(code).toBe(0);
    expect(errLog).toBe('');
    expect(outLog).toContain(outPath);

    const written = readFileSync(outPath, 'utf8');
    expect(written).toContain('HEVC AC3 live stream dropped audio');
    expect(written).not.toContain('Keyboard search shortcut');
  });

  it('fetches from --url using ELV_ADMIN_TOKEN without leaking the token on HTTP error', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get('authorization') ?? '';
      return new Response(JSON.stringify(SAMPLE_REPORT), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const opts = parseTelemetryDigestArgs(
      [
        '--url',
        'https://sync.example.test/',
        '--since',
        '2026-11-24T15:00:00.000Z',
        '--format',
        'json',
      ],
      {},
    );
    const loaded = await loadTelemetryDigest(
      opts,
      { ELV_ADMIN_TOKEN: 'super-secret-admin-token' },
      mockFetch,
    );
    expect(capturedUrl).toBe(
      'https://sync.example.test/v1/admin/digest?since=2026-11-24T15%3A00%3A00.000Z',
    );
    expect(capturedAuth).toBe('Bearer super-secret-admin-token');
    expect(loaded.totals.telemetryEvents).toBe(42);

    // Missing token fails cleanly
    await expect(loadTelemetryDigest(opts, {}, mockFetch)).rejects.toThrow(/ELV_ADMIN_TOKEN/);

    // HTTP 401 fails without leaking token in stderr
    let stderrText = '';
    const failCode = await runTelemetryDigestCli(['--url', 'https://sync.example.test'], {
      env: { ELV_ADMIN_TOKEN: 'do-not-leak-token-xyz' },
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
      stdout: () => {},
      stderr: (s) => {
        stderrText += s;
      },
    });
    expect(failCode).toBe(1);
    expect(stderrText).toContain('HTTP 401');
    expect(stderrText).not.toContain('do-not-leak-token-xyz');
  });

  it('prints JSON directly to stdout when --format json and handles --help', async () => {
    const dir = makeTempDir();
    const inputPath = join(dir, 'report.json');
    writeFileSync(inputPath, JSON.stringify(SAMPLE_REPORT), 'utf8');

    let jsonOut = '';
    const jsonCode = await runTelemetryDigestCli(['--input', inputPath, '--format', 'json'], {
      env: {},
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    expect(jsonCode).toBe(0);
    expect((JSON.parse(jsonOut) as TelemetryDigestReport).totals.uniqueSessions).toBe(6);

    let helpOut = '';
    const helpCode = await runTelemetryDigestCli(['--help'], {
      env: {},
      stdout: (s) => {
        helpOut += s;
      },
      stderr: () => {},
    });
    expect(helpCode).toBe(0);
    expect(helpOut).toContain('usage: pnpm telemetry:digest');
  });
});
