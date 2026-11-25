import { connectionStats, type SimLogEntry } from './sim-log.ts';

const DEFAULT_MAX_AUDIO_DRIFT_MS = 150;
const DEFAULT_MAX_SUBTITLE_DRIFT_MS = 150;
const DEFAULT_MAX_POSITION_ERROR_MS = 5_000;

const FORBIDDEN_CACHE_ENTRY_SUBSTRINGS: readonly string[] = [
  'http',
  '://',
  'username',
  'password',
  'token=',
  '.m3u',
  '.ts',
  '.mp4',
  '.mkv',
];

const OPAQUE_CACHE_ENTRY_RE =
  /^(?:[0-9a-f]{64}(?:\.(?:cache|dat|exo|idx|tmp|v\d+\.exo))?|(?:s-|session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|s-[0-9a-f]{16,64}|mpv-cache-[0-9a-zA-Z_-]+\.dat|[0-9a-f]+\.uid|index\.db(?:-(?:wal|shm|journal))?|cached_content_index\.exi|\d+\.\d+\.\d+\.v\d+\.exo)$/i;

/** Telemetry captured across a single VOD seek operation. */
export interface VodSeekStep {
  readonly label: string;
  readonly fromMs: number;
  readonly targetMs: number;
  readonly expectedCacheHit: boolean;
  readonly settledPositionMs: number;
  readonly audioDriftMs: number;
  readonly subtitleDriftMs: number;
  readonly decodedFramesBefore: number;
  readonly decodedFramesAfter: number;
  readonly upstreamRequestsDuringSeek: number;
  readonly bufferedAheadMs: number;
  readonly bufferedBehindMs: number;
}

/** Snapshot of ephemeral VOD disk-cache directory hygiene before and after playback stops. */
export interface VodCacheDirAudit {
  readonly activeEntries: readonly string[];
  readonly entriesAfterStop: readonly string[];
  readonly leakedUrlFragments?: readonly string[];
  readonly maxObservedBytes: number;
  readonly budgetBytes: number;
}

/** Observation from injecting an HTTP 429 or 509 server throttle during VOD read-ahead. */
export interface VodThrottleProbe {
  readonly injectedStatus: 429 | 509;
  readonly backoffBefore: number;
  readonly backoffAfter: number;
  readonly playbackStalledToError: boolean;
  readonly diskCacheDisabledAfterRepeatedThrottle?: boolean;
}

/** Complete VOD rapid-seek, back-buffer cache-hit, and connection-discipline gate input. */
export interface VodCacheGateReport {
  readonly account: string;
  readonly simEntries: readonly SimLogEntry[];
  readonly seekSteps: readonly VodSeekStep[];
  readonly cacheAudit: VodCacheDirAudit;
  readonly throttleProbe?: VodThrottleProbe;
}

/** Optional tolerance overrides for evaluating a VOD cache gate report. */
export interface VodCacheGateOptions {
  readonly maxAudioDriftMs?: number;
  readonly maxSubtitleDriftMs?: number;
  readonly maxPositionErrorMs?: number;
}

/** Aggregated numerical metrics emitted alongside a VOD cache gate verdict. */
export interface VodCacheGateSummary {
  readonly overlapMs: number;
  readonly limitResponses: number;
  readonly seekCount: number;
  readonly cacheHitSeeks: number;
  readonly maxAudioDriftMs: number;
  readonly maxSubtitleDriftMs: number;
  readonly maxPositionErrorMs: number;
}

/** Pass/fail outcome, diagnostic messages, and summary metrics from the VOD cache proof gate. */
export interface VodCacheGateVerdict {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly summary: VodCacheGateSummary;
}

/**
 * Returns `true` if a cache entry filename leaks URLs, credentials, media extensions,
 * caller-supplied sensitive fragments, or fails to match an opaque SHA-256 / session ID format.
 */
export function hasSuspiciousCacheEntryName(
  name: string,
  leakedUrlFragments?: readonly string[],
): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  for (const token of FORBIDDEN_CACHE_ENTRY_SUBSTRINGS) {
    if (lower.includes(token)) return true;
  }
  if (leakedUrlFragments !== undefined) {
    for (const fragment of leakedUrlFragments) {
      const needle = fragment.trim().toLowerCase();
      if (needle.length > 0 && lower.includes(needle)) return true;
    }
  }
  return !OPAQUE_CACHE_ENTRY_RE.test(trimmed);
}

/**
 * Evaluates a VOD rapid-seek and back-buffer cache report against single-connection discipline,
 * cached return-seek invariants, A/V & subtitle drift ceilings, ephemeral cache privacy/cleanup,
 * and optional 429/509 throttle backoff behavior.
 */
export function evaluateVodCacheGate(
  report: VodCacheGateReport,
  options?: VodCacheGateOptions,
): VodCacheGateVerdict {
  const maxAudioDriftMs = options?.maxAudioDriftMs ?? DEFAULT_MAX_AUDIO_DRIFT_MS;
  const maxSubtitleDriftMs = options?.maxSubtitleDriftMs ?? DEFAULT_MAX_SUBTITLE_DRIFT_MS;
  const maxPositionErrorMs = options?.maxPositionErrorMs ?? DEFAULT_MAX_POSITION_ERROR_MS;

  const failures: string[] = [];
  const warnings: string[] = [];

  const { limitResponses, overlapMs } = connectionStats(report.simEntries, report.account);
  if (limitResponses > 0) {
    failures.push(
      `connection limit responses > 0 (${limitResponses} on account ${report.account})`,
    );
  }
  if (overlapMs > 0) {
    failures.push(
      `concurrent stream overlap > 0 ms (${overlapMs} ms on account ${report.account})`,
    );
  }

  let cacheHitSeeks = 0;
  let observedMaxAudioDriftMs = 0;
  let observedMaxSubtitleDriftMs = 0;
  let observedMaxPositionErrorMs = 0;

  if (report.seekSteps.length === 0) {
    failures.push('no VOD seek steps recorded');
  }

  for (const step of report.seekSteps) {
    if (!Number.isFinite(step.bufferedAheadMs) || step.bufferedAheadMs < 0) {
      failures.push(`${step.label}: bufferedAheadMs must be non-negative finite`);
    }
    if (!Number.isFinite(step.bufferedBehindMs) || step.bufferedBehindMs < 0) {
      failures.push(`${step.label}: bufferedBehindMs must be non-negative finite`);
    }

    const positionErrorMs = Math.abs(step.settledPositionMs - step.targetMs);
    if (!Number.isFinite(positionErrorMs) || positionErrorMs > maxPositionErrorMs) {
      failures.push(
        `${step.label}: position error ${positionErrorMs} ms exceeds limit ${maxPositionErrorMs} ms`,
      );
    } else if (positionErrorMs > observedMaxPositionErrorMs) {
      observedMaxPositionErrorMs = positionErrorMs;
    }

    const audioDriftMs = Math.abs(step.audioDriftMs);
    if (!Number.isFinite(audioDriftMs) || audioDriftMs > maxAudioDriftMs) {
      failures.push(
        `${step.label}: audio drift ${audioDriftMs} ms exceeds limit ${maxAudioDriftMs} ms`,
      );
    } else if (audioDriftMs > observedMaxAudioDriftMs) {
      observedMaxAudioDriftMs = audioDriftMs;
    }

    const subtitleDriftMs = Math.abs(step.subtitleDriftMs);
    if (!Number.isFinite(subtitleDriftMs) || subtitleDriftMs > maxSubtitleDriftMs) {
      failures.push(
        `${step.label}: subtitle drift ${subtitleDriftMs} ms exceeds limit ${maxSubtitleDriftMs} ms`,
      );
    } else if (subtitleDriftMs > observedMaxSubtitleDriftMs) {
      observedMaxSubtitleDriftMs = subtitleDriftMs;
    }

    if (
      !Number.isFinite(step.decodedFramesBefore) ||
      !Number.isFinite(step.decodedFramesAfter) ||
      step.decodedFramesAfter <= step.decodedFramesBefore
    ) {
      failures.push(
        `${step.label}: decoded video frames stalled after seek (${step.decodedFramesBefore} -> ${step.decodedFramesAfter})`,
      );
    }

    if (step.expectedCacheHit) {
      if (step.upstreamRequestsDuringSeek > 0) {
        failures.push(
          `${step.label}: expected cached return-seek hit with 0 upstream HTTP requests (saw ${step.upstreamRequestsDuringSeek})`,
        );
      } else {
        cacheHitSeeks += 1;
      }
    }
  }

  const { cacheAudit } = report;
  if (cacheAudit.entriesAfterStop.length > 0) {
    failures.push(
      `ephemeral VOD cache not purged after stop/dispose (${cacheAudit.entriesAfterStop.length} entries left)`,
    );
  }
  if (
    !Number.isFinite(cacheAudit.budgetBytes) ||
    cacheAudit.budgetBytes < 0 ||
    !Number.isFinite(cacheAudit.maxObservedBytes) ||
    cacheAudit.maxObservedBytes < 0
  ) {
    failures.push(
      `ephemeral VOD cache byte telemetry is invalid (observed=${cacheAudit.maxObservedBytes}, budget=${cacheAudit.budgetBytes})`,
    );
  } else if (cacheAudit.maxObservedBytes > cacheAudit.budgetBytes) {
    failures.push(
      `ephemeral VOD cache exceeded byte budget (${cacheAudit.maxObservedBytes} > ${cacheAudit.budgetBytes} bytes)`,
    );
  }
  for (const entry of cacheAudit.activeEntries) {
    if (hasSuspiciousCacheEntryName(entry, cacheAudit.leakedUrlFragments)) {
      failures.push(`suspicious ephemeral VOD cache entry name: ${entry}`);
    }
  }

  const { throttleProbe } = report;
  if (throttleProbe !== undefined) {
    if (throttleProbe.backoffAfter <= throttleProbe.backoffBefore) {
      failures.push(
        `${throttleProbe.injectedStatus} did not escalate read-ahead throttle backoff (${throttleProbe.backoffBefore} -> ${throttleProbe.backoffAfter})`,
      );
    }
    if (throttleProbe.playbackStalledToError) {
      failures.push(`${throttleProbe.injectedStatus} throttle aborted VOD playback`);
    }
    if (
      throttleProbe.backoffAfter >= 2 &&
      throttleProbe.diskCacheDisabledAfterRepeatedThrottle === false
    ) {
      failures.push(
        `${throttleProbe.injectedStatus} repeated throttle (level ${throttleProbe.backoffAfter}) did not disable disk cache`,
      );
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    warnings,
    summary: {
      overlapMs,
      limitResponses,
      seekCount: report.seekSteps.length,
      cacheHitSeeks,
      maxAudioDriftMs: observedMaxAudioDriftMs,
      maxSubtitleDriftMs: observedMaxSubtitleDriftMs,
      maxPositionErrorMs: observedMaxPositionErrorMs,
    },
  };
}

/**
 * Runs a synthetic end-to-end self-verification fixture exercising forward read-ahead,
 * back-buffer cached return seeks (0 upstream requests), rapid +/-10s scrubbing,
 * SHA-256 ephemeral cache hygiene, and HTTP 429 throttle backoff.
 */
export function runVodCacheSelfCheck(): VodCacheGateVerdict {
  const baseMs = Date.parse('2026-11-25T15:00:00.000Z');
  const simEntries: readonly SimLogEntry[] = [
    {
      t: new Date(baseMs + 2_500).toISOString(),
      path: '/movie/demo/demo/200001.mp4',
      query: {},
      status: 200,
      bytes: 4_500_000,
      ms: 2_500,
      account: 'demo',
      streamId: 200001,
    },
    {
      t: new Date(baseMs + 5_000).toISOString(),
      path: '/movie/demo/demo/200001.mp4',
      query: {},
      status: 200,
      bytes: 3_200_000,
      ms: 2_000,
      account: 'demo',
      streamId: 200001,
    },
    {
      t: new Date(baseMs + 6_000).toISOString(),
      path: '/movie/demo/demo/200001.mp4',
      query: { fault: 'status=429' },
      status: 429,
      bytes: 0,
      ms: 15,
      account: 'demo',
      streamId: 200001,
      fault: 'status=429',
    },
    {
      t: new Date(baseMs + 8_500).toISOString(),
      path: '/movie/demo/demo/200001.mp4',
      query: {},
      status: 200,
      bytes: 2_800_000,
      ms: 2_000,
      account: 'demo',
      streamId: 200001,
    },
  ];

  const report: VodCacheGateReport = {
    account: 'demo',
    simEntries,
    seekSteps: [
      {
        label: 'forward-readahead-60s',
        fromMs: 0,
        targetMs: 60_000,
        expectedCacheHit: false,
        settledPositionMs: 60_140,
        audioDriftMs: 22,
        subtitleDriftMs: -18,
        decodedFramesBefore: 150,
        decodedFramesAfter: 300,
        upstreamRequestsDuringSeek: 1,
        bufferedAheadMs: 45_000,
        bufferedBehindMs: 25_000,
      },
      {
        label: 'back-buffer-return-seek-15s',
        fromMs: 60_000,
        targetMs: 45_000,
        expectedCacheHit: true,
        settledPositionMs: 45_040,
        audioDriftMs: -14,
        subtitleDriftMs: 12,
        decodedFramesBefore: 300,
        decodedFramesAfter: 420,
        upstreamRequestsDuringSeek: 0,
        bufferedAheadMs: 60_000,
        bufferedBehindMs: 10_000,
      },
      {
        label: 'rapid-scrub-plus-10s',
        fromMs: 45_000,
        targetMs: 55_000,
        expectedCacheHit: true,
        settledPositionMs: 55_060,
        audioDriftMs: 11,
        subtitleDriftMs: 9,
        decodedFramesBefore: 420,
        decodedFramesAfter: 540,
        upstreamRequestsDuringSeek: 0,
        bufferedAheadMs: 50_000,
        bufferedBehindMs: 20_000,
      },
      {
        label: 'rapid-scrub-minus-10s',
        fromMs: 55_000,
        targetMs: 45_000,
        expectedCacheHit: true,
        settledPositionMs: 45_030,
        audioDriftMs: -8,
        subtitleDriftMs: -11,
        decodedFramesBefore: 540,
        decodedFramesAfter: 660,
        upstreamRequestsDuringSeek: 0,
        bufferedAheadMs: 60_000,
        bufferedBehindMs: 10_000,
      },
      {
        label: 'far-forward-seek-300s',
        fromMs: 45_000,
        targetMs: 300_000,
        expectedCacheHit: false,
        settledPositionMs: 300_210,
        audioDriftMs: 28,
        subtitleDriftMs: 24,
        decodedFramesBefore: 660,
        decodedFramesAfter: 810,
        upstreamRequestsDuringSeek: 1,
        bufferedAheadMs: 35_000,
        bufferedBehindMs: 15_000,
      },
    ],
    cacheAudit: {
      activeEntries: [
        's-550e8400-e29b-41d4-a716-446655440000',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ],
      entriesAfterStop: [],
      leakedUrlFragments: ['demo', '200001.mp4', '127.0.0.1'],
      maxObservedBytes: 48 * 1024 * 1024,
      budgetBytes: 128 * 1024 * 1024,
    },
    throttleProbe: {
      injectedStatus: 429,
      backoffBefore: 0,
      backoffAfter: 1,
      playbackStalledToError: false,
    },
  };

  return evaluateVodCacheGate(report);
}
