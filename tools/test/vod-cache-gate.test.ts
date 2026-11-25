import { describe, expect, it } from 'vitest';
import type { SimLogEntry } from '../src/gates/sim-log.ts';
import {
  evaluateVodCacheGate,
  hasSuspiciousCacheEntryName,
  runVodCacheSelfCheck,
  type VodCacheDirAudit,
  type VodCacheGateOptions,
  type VodCacheGateReport,
  type VodCacheGateSummary,
  type VodCacheGateVerdict,
  type VodSeekStep,
  type VodThrottleProbe,
} from '../src/gates/vod-cache-gate.ts';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const SHA256_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SESSION_ID = 's-550e8400-e29b-41d4-a716-446655440000';

function simEntry(over: Partial<SimLogEntry> & { start?: number } = {}): SimLogEntry {
  const { start = 0, ...rest } = over;
  const ms = rest.ms ?? 1_000;
  return {
    t: new Date(T0 + start + ms).toISOString(),
    path: '/movie/demo/demo/200001.mp4',
    query: {},
    status: 200,
    bytes: 2_000_000,
    ms,
    account: 'demo',
    streamId: 200001,
    ...rest,
  };
}

function makeStep(over: Partial<VodSeekStep> = {}): VodSeekStep {
  return {
    label: 'seek-forward-60s',
    fromMs: 0,
    targetMs: 60_000,
    expectedCacheHit: false,
    settledPositionMs: 60_120,
    audioDriftMs: 18,
    subtitleDriftMs: -24,
    decodedFramesBefore: 120,
    decodedFramesAfter: 240,
    upstreamRequestsDuringSeek: 1,
    bufferedAheadMs: 45_000,
    bufferedBehindMs: 20_000,
    ...over,
  };
}

function makeAudit(over: Partial<VodCacheDirAudit> = {}): VodCacheDirAudit {
  return {
    activeEntries: [SESSION_ID, SHA256_A],
    entriesAfterStop: [],
    leakedUrlFragments: ['demo', '200001.mp4', '127.0.0.1'],
    maxObservedBytes: 64 * 1024 * 1024,
    budgetBytes: 128 * 1024 * 1024,
    ...over,
  };
}

function makeReport(over: Partial<VodCacheGateReport> = {}): VodCacheGateReport {
  return {
    account: 'demo',
    simEntries: [simEntry({ start: 0, ms: 2_000 }), simEntry({ start: 3_000, ms: 1_500 })],
    seekSteps: [
      makeStep(),
      makeStep({
        label: 'return-seek-back-buffer',
        fromMs: 60_000,
        targetMs: 48_000,
        expectedCacheHit: true,
        settledPositionMs: 48_050,
        audioDriftMs: -12,
        subtitleDriftMs: 10,
        decodedFramesBefore: 240,
        decodedFramesAfter: 360,
        upstreamRequestsDuringSeek: 0,
        bufferedAheadMs: 57_000,
        bufferedBehindMs: 8_000,
      }),
    ],
    cacheAudit: makeAudit(),
    throttleProbe: {
      injectedStatus: 429,
      backoffBefore: 0,
      backoffAfter: 1,
      playbackStalledToError: false,
    },
    ...over,
  };
}

describe('hasSuspiciousCacheEntryName', () => {
  it('accepts SHA-256 hex digests, opaque session UUIDs, and Media3 SimpleCache opaque files', () => {
    expect(hasSuspiciousCacheEntryName(SHA256_A)).toBe(false);
    expect(hasSuspiciousCacheEntryName(`${SHA256_A}.cache`)).toBe(false);
    expect(hasSuspiciousCacheEntryName(SESSION_ID)).toBe(false);
    expect(hasSuspiciousCacheEntryName('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(hasSuspiciousCacheEntryName('cached_content_index.exi')).toBe(false);
    expect(hasSuspiciousCacheEntryName('1.0.1732540000000.v3.exo')).toBe(false);
  });

  it('flags raw URLs, credentials, media extensions, leaked fragments, and non-opaque names', () => {
    const suspicious = [
      '',
      '   ',
      'http-stream-cache',
      'https://provider.example/movie/1.mp4',
      'username-cache',
      'password-cache',
      'abc_token=secret123',
      'playlist.m3u8',
      'segment.ts',
      'movie.mp4',
      'episode.mkv',
      'my-unhashed-movie-name.bin',
    ];
    for (const name of suspicious) {
      expect(hasSuspiciousCacheEntryName(name), `expected ${name} to be suspicious`).toBe(true);
    }
    expect(hasSuspiciousCacheEntryName(SHA256_A, ['a1b2c3d4'])).toBe(true);
    expect(hasSuspiciousCacheEntryName(SHA256_A, ['', 'unrelated'])).toBe(false);
  });
});

describe('evaluateVodCacheGate', () => {
  it('passes a healthy VOD rapid-seek, back-buffer cache-hit, and throttle-backoff report', () => {
    const verdict: VodCacheGateVerdict = evaluateVodCacheGate(makeReport());
    const expectedSummary: VodCacheGateSummary = {
      overlapMs: 0,
      limitResponses: 0,
      seekCount: 2,
      cacheHitSeeks: 1,
      maxAudioDriftMs: 18,
      maxSubtitleDriftMs: 24,
      maxPositionErrorMs: 120,
    };
    expect(verdict).toEqual({
      pass: true,
      failures: [],
      warnings: [],
      summary: expectedSummary,
    });
  });

  it('respects custom drift and position tolerances', () => {
    const options: VodCacheGateOptions = {
      maxAudioDriftMs: 10,
      maxSubtitleDriftMs: 15,
      maxPositionErrorMs: 100,
    };
    const verdict = evaluateVodCacheGate(makeReport(), options);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toHaveLength(4);
    expect(verdict.failures.some((f) => f.includes('position error'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('audio drift'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('subtitle drift'))).toBe(true);
  });

  it('fails when connection limit responses or concurrent stream overlap occur', () => {
    const verdict = evaluateVodCacheGate(
      makeReport({
        simEntries: [
          simEntry({ start: 0, ms: 2_000 }),
          simEntry({ start: 1_500, ms: 1_000, status: 509, bytes: 0 }),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.summary.limitResponses).toBe(1);
    expect(verdict.summary.overlapMs).toBe(500);
    expect(verdict.failures.some((f) => f.includes('connection limit responses > 0'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('concurrent stream overlap > 0 ms'))).toBe(true);
  });

  it('fails when no seek steps are recorded', () => {
    const verdict = evaluateVodCacheGate(makeReport({ seekSteps: [] }));
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.some((f) => f.includes('no VOD seek steps'))).toBe(true);
  });

  it('fails on position inaccuracy, A/V drift, subtitle drift, stalled frames, cache miss, and bad buffer health', () => {
    const verdict = evaluateVodCacheGate(
      makeReport({
        seekSteps: [
          makeStep({
            label: 'broken-return-seek',
            targetMs: 30_000,
            settledPositionMs: 40_000,
            audioDriftMs: 250,
            subtitleDriftMs: -300,
            decodedFramesBefore: 500,
            decodedFramesAfter: 500,
            expectedCacheHit: true,
            upstreamRequestsDuringSeek: 2,
            bufferedAheadMs: -1,
            bufferedBehindMs: Number.NaN,
          }),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.summary.cacheHitSeeks).toBe(0);
    expect(verdict.failures.some((f) => f.includes('position error'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('audio drift'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('subtitle drift'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('decoded video frames stalled'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('expected cached return-seek hit'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('bufferedAheadMs'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('bufferedBehindMs'))).toBe(true);
  });

  it('fails on non-finite drift or position measurements', () => {
    const verdict = evaluateVodCacheGate(
      makeReport({
        seekSteps: [
          makeStep({
            settledPositionMs: Number.NaN,
            audioDriftMs: Number.POSITIVE_INFINITY,
            subtitleDriftMs: Number.NaN,
          }),
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.some((f) => f.includes('position error'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('audio drift'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('subtitle drift'))).toBe(true);
  });

  it('fails on leftover cache entries after stop, byte budget overrun, and suspicious entry names', () => {
    const verdict = evaluateVodCacheGate(
      makeReport({
        cacheAudit: makeAudit({
          activeEntries: ['http://demo:demo@127.0.0.1/movie/200001.mp4'],
          entriesAfterStop: [SESSION_ID],
          maxObservedBytes: 256 * 1024 * 1024,
          budgetBytes: 128 * 1024 * 1024,
        }),
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.some((f) => f.includes('not purged after stop/dispose'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('exceeded byte budget'))).toBe(true);
    expect(verdict.failures.some((f) => f.includes('suspicious'))).toBe(true);
  });

  it('enforces budgetBytes === 0 when disk cache is disabled and accepts opaque mpv/Media3 cache files', () => {
    const allowedEmpty = evaluateVodCacheGate(
      makeReport({
        cacheAudit: makeAudit({
          activeEntries: ['mpv-cache-a1b2c3.dat', '4a8f12c0.uid', 'index.db', 'index.db-wal'],
          entriesAfterStop: [],
          maxObservedBytes: 0,
          budgetBytes: 0,
        }),
      }),
    );
    expect(allowedEmpty.pass).toBe(true);

    const leakedWhenDisabled = evaluateVodCacheGate(
      makeReport({
        cacheAudit: makeAudit({
          activeEntries: ['mpv-cache-a1b2c3.dat'],
          entriesAfterStop: [],
          maxObservedBytes: 1024,
          budgetBytes: 0,
        }),
      }),
    );
    expect(leakedWhenDisabled.pass).toBe(false);
    expect(leakedWhenDisabled.failures.some((f) => f.includes('exceeded byte budget'))).toBe(true);

    const invalidTelemetry = evaluateVodCacheGate(
      makeReport({
        cacheAudit: makeAudit({
          activeEntries: [],
          entriesAfterStop: [],
          maxObservedBytes: -1,
          budgetBytes: 0,
        }),
      }),
    );
    expect(invalidTelemetry.pass).toBe(false);
    expect(invalidTelemetry.failures.some((f) => f.includes('byte telemetry is invalid'))).toBe(
      true,
    );
  });

  it('evaluates optional throttle probe backoff, playback continuity, and repeated-throttle failure', () => {
    const { throttleProbe: _omit, ...withoutProbe } = makeReport();
    const noProbe = evaluateVodCacheGate(withoutProbe);
    expect(noProbe.pass).toBe(true);

    const badProbe: VodThrottleProbe = {
      injectedStatus: 509,
      backoffBefore: 1,
      backoffAfter: 1,
      playbackStalledToError: true,
    };
    const failed = evaluateVodCacheGate(makeReport({ throttleProbe: badProbe }));
    expect(failed.pass).toBe(false);
    expect(
      failed.failures.some((f) => f.includes('did not escalate read-ahead throttle backoff')),
    ).toBe(true);
    expect(failed.failures.some((f) => f.includes('aborted VOD playback'))).toBe(true);

    const repeatedFail = evaluateVodCacheGate(
      makeReport({
        throttleProbe: {
          injectedStatus: 429,
          backoffBefore: 1,
          backoffAfter: 2,
          playbackStalledToError: false,
          diskCacheDisabledAfterRepeatedThrottle: false,
        },
      }),
    );
    expect(repeatedFail.pass).toBe(false);
    expect(repeatedFail.failures.some((f) => f.includes('did not disable disk cache'))).toBe(true);
  });
});

describe('runVodCacheSelfCheck', () => {
  it('passes end-to-end against its synthetic rapid-seek, back-buffer, and 429 probe fixture', () => {
    const verdict = runVodCacheSelfCheck();
    expect(verdict.pass).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.summary.overlapMs).toBe(0);
    expect(verdict.summary.limitResponses).toBe(0);
    expect(verdict.summary.seekCount).toBeGreaterThanOrEqual(4);
    expect(verdict.summary.cacheHitSeeks).toBeGreaterThanOrEqual(2);
    expect(verdict.summary.maxAudioDriftMs).toBeLessThanOrEqual(150);
    expect(verdict.summary.maxSubtitleDriftMs).toBeLessThanOrEqual(150);
    expect(verdict.summary.maxPositionErrorMs).toBeLessThanOrEqual(5_000);
  });
});
