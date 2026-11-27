import type { FeedbackSubmissionRecord, TelemetryEventRecord } from './storage.ts';
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from './validation.ts';

/** Per-version and platform aggregated telemetry & feedback counts. */
interface VersionPlatformRow {
  readonly appVersion: string;
  readonly platform: string;
  readonly events: number;
  readonly sessions: number;
  readonly decodeFailures: number;
  readonly playbackErrors: number;
  readonly feedbackCount: number;
}

/** Percentile latency summary in milliseconds. */
interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** Per-screen transition latency statistics. */
interface ScreenLatencyRow {
  readonly screen: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/** Per-screen jank/stall hotspot breakdown. */
interface StallHotspotRow {
  readonly screen: string;
  readonly frameJankEvents: number;
  readonly jsStallEvents: number;
  readonly maxDurationMs: number;
}

/** Aggregated stall, jank, SQLite, memory, and playback startup health metrics. */
interface StallAndJankSummary {
  readonly frameJankEvents: number;
  readonly frameJankRatePerSession: number;
  readonly jsStallEvents: number;
  readonly jsStallRatePerSession: number;
  readonly maxStallMs: number | null;
  readonly slowSqliteOps: number;
  readonly slowSqliteP95Ms: number | null;
  readonly memoryPressureEvents: number;
  readonly playbackRebufferEvents: number;
  readonly playbackStartCount: number;
  readonly playbackStartP95Ms: number | null;
  readonly hotspots: readonly StallHotspotRow[];
}

/** Grouped media decode failure row used to track codec/container gaps (#70). */
interface MediaDecodeFailureRow {
  readonly platform: string;
  readonly engine: string;
  readonly container: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly errorCode: string;
  readonly hdrFormat: string | null;
  readonly isLive: boolean | null;
  readonly count: number;
}

/** Grouped crash or unhandled error signature with session impact. */
interface CrashAndErrorRow {
  readonly kind: 'app_crash' | 'unhandled_error';
  readonly errorName: string;
  readonly stackSig: string;
  readonly screen: string | null;
  readonly fatalCount: number;
  readonly count: number;
  readonly affectedSessions: number;
}

/** Aggregated catalog / EPG import performance breakdown by source kind. */
interface CatalogImportRow {
  readonly sourceKind: string;
  readonly count: number;
  readonly failureCount: number;
  readonly failureRate: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** Aggregated sanitized device technical profile row. */
interface DeviceProfileRow {
  readonly platform: string;
  readonly formFactor: string | null;
  readonly arch: string | null;
  readonly ramBucket: string | null;
  readonly resolution: string | null;
  readonly gpu: string | null;
  readonly locale: string | null;
  readonly sessions: number;
  readonly events: number;
}

/** Summarized feedback item returned in the admin digest. */
interface DigestFeedbackItem {
  readonly id: string;
  readonly receivedAt: string;
  readonly category: FeedbackCategory;
  readonly appVersion: string;
  readonly platform: string;
  readonly locale: string | null;
  readonly message: string;
  readonly hasDiagnostics: boolean;
}

/** Structured AI-analyzable digest returned by `GET /v1/admin/digest`. */
export interface TelemetryDigestReport {
  readonly generatedAt: string;
  readonly since: string | null;
  readonly totals: {
    readonly telemetryEvents: number;
    readonly uniqueSessions: number;
    readonly feedbackSubmissions: number;
  };
  readonly pendingAccountDeletionRequests: number;
  readonly versionPlatformMatrix: readonly VersionPlatformRow[];
  readonly startupLatency: LatencySummary;
  readonly screenLatencies: readonly ScreenLatencyRow[];
  readonly stallAndJank: StallAndJankSummary;
  readonly mediaDecodeFailures: readonly MediaDecodeFailureRow[];
  readonly crashesAndErrors: readonly CrashAndErrorRow[];
  readonly catalogImports: readonly CatalogImportRow[];
  readonly deviceProfiles: readonly DeviceProfileRow[];
  readonly feedbackByCategory: Readonly<Record<FeedbackCategory, number>>;
  readonly recentFeedback: readonly DigestFeedbackItem[];
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

function summarizeLatencies(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
  };
}

function roundRate(events: number, sessions: number): number {
  if (sessions <= 0) return 0;
  return Math.round((events / sessions) * 1000) / 1000;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

const MAX_RECENT_FEEDBACK = 50;

/** Aggregates stored telemetry events and user feedback into a `TelemetryDigestReport`. */
export function buildTelemetryDigest(
  events: readonly TelemetryEventRecord[],
  feedback: readonly FeedbackSubmissionRecord[],
  generatedAt: string,
  sinceIso: string | null,
  pendingAccountDeletionRequests = 0,
): TelemetryDigestReport {
  const uniqueSessions = new Set<string>();
  const matrixAcc = new Map<
    string,
    {
      appVersion: string;
      platform: string;
      events: number;
      sessions: Set<string>;
      decodeFailures: number;
      playbackErrors: number;
      feedbackCount: number;
    }
  >();

  const startupDurations: number[] = [];
  const screenDurations = new Map<string, number[]>();
  const playbackStartDurations: number[] = [];
  const slowSqliteDurations: number[] = [];

  let frameJankEvents = 0;
  let jsStallEvents = 0;
  let maxStallMs: number | null = null;
  let memoryPressureEvents = 0;
  let playbackRebufferEvents = 0;

  const hotspotAcc = new Map<
    string,
    { frameJankEvents: number; jsStallEvents: number; maxDurationMs: number }
  >();

  const decodeAcc = new Map<
    string,
    {
      platform: string;
      engine: string;
      container: string;
      videoCodec: string;
      audioCodec: string;
      errorCode: string;
      hdrFormat: string | null;
      isLive: boolean | null;
      count: number;
    }
  >();

  const crashAcc = new Map<
    string,
    {
      kind: 'app_crash' | 'unhandled_error';
      errorName: string;
      stackSig: string;
      screen: string | null;
      fatalCount: number;
      count: number;
      sessions: Set<string>;
    }
  >();

  const importAcc = new Map<
    string,
    {
      sourceKind: string;
      count: number;
      failureCount: number;
      durations: number[];
    }
  >();

  const profileAcc = new Map<
    string,
    {
      platform: string;
      formFactor: string | null;
      arch: string | null;
      ramBucket: string | null;
      resolution: string | null;
      gpu: string | null;
      locale: string | null;
      sessions: Set<string>;
      events: number;
    }
  >();

  function getMatrixBucket(appVersion: string, platform: string) {
    const key = `${appVersion}\0${platform}`;
    let entry = matrixAcc.get(key);
    if (!entry) {
      entry = {
        appVersion,
        platform,
        events: 0,
        sessions: new Set<string>(),
        decodeFailures: 0,
        playbackErrors: 0,
        feedbackCount: 0,
      };
      matrixAcc.set(key, entry);
    }
    return entry;
  }

  for (const event of events) {
    uniqueSessions.add(event.sessionId);
    const bucket = getMatrixBucket(event.appVersion, event.platform);
    bucket.events += 1;
    bucket.sessions.add(event.sessionId);

    const payload = parsePayload(event.payloadJson);
    const duration = asNumber(payload.durationMs);

    const rawProfile = event.deviceProfileJson ? parsePayload(event.deviceProfileJson) : {};
    const profileFormFactor = event.formFactor ?? asNullableString(rawProfile.formFactor);
    const profileArch = asNullableString(rawProfile.arch);
    const profileRamBucket = asNullableString(rawProfile.ramBucket);
    const profileResolution = asNullableString(rawProfile.resolution);
    const profileGpu = asNullableString(rawProfile.gpu);
    const profileLocale = asNullableString(rawProfile.locale);
    const profileKey = [
      event.platform,
      profileFormFactor ?? '',
      profileArch ?? '',
      profileRamBucket ?? '',
      profileResolution ?? '',
      profileGpu ?? '',
      profileLocale ?? '',
    ].join('\0');
    let profileEntry = profileAcc.get(profileKey);
    if (!profileEntry) {
      profileEntry = {
        platform: event.platform,
        formFactor: profileFormFactor,
        arch: profileArch,
        ramBucket: profileRamBucket,
        resolution: profileResolution,
        gpu: profileGpu,
        locale: profileLocale,
        sessions: new Set<string>(),
        events: 0,
      };
      profileAcc.set(profileKey, profileEntry);
    }
    profileEntry.sessions.add(event.sessionId);
    profileEntry.events += 1;

    switch (event.kind) {
      case 'startup':
        if (duration !== null) startupDurations.push(duration);
        break;
      case 'screen_transition': {
        const screen = asString(payload.screen, 'unknown');
        if (duration !== null) {
          const list = screenDurations.get(screen) ?? [];
          list.push(duration);
          screenDurations.set(screen, list);
        }
        break;
      }
      case 'frame_jank': {
        frameJankEvents += 1;
        const screen = asString(payload.screen, 'unknown');
        const h = hotspotAcc.get(screen) ?? {
          frameJankEvents: 0,
          jsStallEvents: 0,
          maxDurationMs: 0,
        };
        h.frameJankEvents += 1;
        if (duration !== null && duration > h.maxDurationMs) h.maxDurationMs = duration;
        hotspotAcc.set(screen, h);
        break;
      }
      case 'js_stall': {
        jsStallEvents += 1;
        const stallMs = asNumber(payload.maxBlockMs) ?? duration;
        if (stallMs !== null && (maxStallMs === null || stallMs > maxStallMs)) {
          maxStallMs = Math.round(stallMs * 100) / 100;
        }
        const screen = asString(payload.screen, 'unknown');
        const h = hotspotAcc.get(screen) ?? {
          frameJankEvents: 0,
          jsStallEvents: 0,
          maxDurationMs: 0,
        };
        h.jsStallEvents += 1;
        if (stallMs !== null && stallMs > h.maxDurationMs) h.maxDurationMs = stallMs;
        hotspotAcc.set(screen, h);
        break;
      }
      case 'memory_pressure':
        memoryPressureEvents += 1;
        break;
      case 'playback_start':
        if (duration !== null) playbackStartDurations.push(duration);
        break;
      case 'playback_rebuffer':
        playbackRebufferEvents += 1;
        break;
      case 'playback_error':
        bucket.playbackErrors += 1;
        break;
      case 'media_decode_failure': {
        bucket.decodeFailures += 1;
        const engine = asString(payload.engine, 'unknown');
        const container = asString(payload.container, 'unknown');
        const videoCodec = asString(payload.videoCodec, 'unknown');
        const audioCodec = asString(payload.audioCodec, 'unknown');
        const errorCode = asString(payload.errorCode, 'unknown');
        const hdrFormat = asNullableString(payload.hdrFormat);
        const isLive = asNullableBoolean(payload.isLive);
        const key = [
          event.platform,
          engine,
          container,
          videoCodec,
          audioCodec,
          errorCode,
          hdrFormat ?? '',
          isLive === null ? '' : String(isLive),
        ].join('\0');
        const existing = decodeAcc.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          decodeAcc.set(key, {
            platform: event.platform,
            engine,
            container,
            videoCodec,
            audioCodec,
            errorCode,
            hdrFormat,
            isLive,
            count: 1,
          });
        }
        break;
      }
      case 'sqlite_slow_op':
        if (duration !== null) slowSqliteDurations.push(duration);
        break;
      case 'app_crash':
      case 'unhandled_error': {
        const errorName = asString(payload.errorName, 'unknown');
        const stackSig = asString(payload.stackSig, 'none');
        const screen = asNullableString(payload.screen);
        const isFatal = event.kind === 'app_crash' && payload.fatal === true;
        const key = `${event.kind}\0${errorName}\0${stackSig}`;
        let entry = crashAcc.get(key);
        if (!entry) {
          entry = {
            kind: event.kind,
            errorName,
            stackSig,
            screen,
            fatalCount: 0,
            count: 0,
            sessions: new Set<string>(),
          };
          crashAcc.set(key, entry);
        } else if (entry.screen === null && screen !== null) {
          entry.screen = screen;
        }
        entry.count += 1;
        if (isFatal) entry.fatalCount += 1;
        entry.sessions.add(event.sessionId);
        break;
      }
      case 'catalog_import': {
        const sourceKind = asString(payload.sourceKind, 'unknown');
        let entry = importAcc.get(sourceKind);
        if (!entry) {
          entry = { sourceKind, count: 0, failureCount: 0, durations: [] };
          importAcc.set(sourceKind, entry);
        }
        entry.count += 1;
        if (payload.success === false) entry.failureCount += 1;
        if (duration !== null) entry.durations.push(duration);
        break;
      }
      default:
        break;
    }
  }

  const feedbackByCategory: Record<FeedbackCategory, number> = {
    playback_issue: 0,
    channel_epg: 0,
    ui_remote: 0,
    sync_account: 0,
    feature_request: 0,
    other: 0,
  };
  const validCategories = new Set<string>(FEEDBACK_CATEGORIES);

  for (const item of feedback) {
    const bucket = getMatrixBucket(item.appVersion, item.platform);
    bucket.feedbackCount += 1;
    const cat: FeedbackCategory = validCategories.has(item.category)
      ? (item.category as FeedbackCategory)
      : 'other';
    feedbackByCategory[cat] += 1;
  }

  const versionPlatformMatrix: VersionPlatformRow[] = [...matrixAcc.values()]
    .map((row) => ({
      appVersion: row.appVersion,
      platform: row.platform,
      events: row.events,
      sessions: row.sessions.size,
      decodeFailures: row.decodeFailures,
      playbackErrors: row.playbackErrors,
      feedbackCount: row.feedbackCount,
    }))
    .sort((a, b) => b.events - a.events || a.appVersion.localeCompare(b.appVersion));

  const screenLatencies: ScreenLatencyRow[] = [...screenDurations.entries()]
    .map(([screen, values]) => {
      const summary = summarizeLatencies(values);
      return {
        screen,
        count: summary.count,
        p50Ms: summary.p50Ms ?? 0,
        p95Ms: summary.p95Ms ?? 0,
        maxMs: summary.maxMs ?? 0,
      };
    })
    .sort((a, b) => b.p95Ms - a.p95Ms || a.screen.localeCompare(b.screen));

  const hotspots: StallHotspotRow[] = [...hotspotAcc.entries()]
    .map(([screen, stats]) => ({
      screen,
      frameJankEvents: stats.frameJankEvents,
      jsStallEvents: stats.jsStallEvents,
      maxDurationMs: Math.round(stats.maxDurationMs * 100) / 100,
    }))
    .sort(
      (a, b) =>
        b.jsStallEvents + b.frameJankEvents - (a.jsStallEvents + a.frameJankEvents) ||
        a.screen.localeCompare(b.screen),
    );

  const mediaDecodeFailures: MediaDecodeFailureRow[] = [...decodeAcc.values()].sort(
    (a, b) => b.count - a.count || a.platform.localeCompare(b.platform),
  );

  const crashesAndErrors: CrashAndErrorRow[] = [...crashAcc.values()]
    .map((entry) => ({
      kind: entry.kind,
      errorName: entry.errorName,
      stackSig: entry.stackSig,
      screen: entry.screen,
      fatalCount: entry.fatalCount,
      count: entry.count,
      affectedSessions: entry.sessions.size,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        b.affectedSessions - a.affectedSessions ||
        a.errorName.localeCompare(b.errorName) ||
        a.stackSig.localeCompare(b.stackSig),
    );

  const catalogImports: CatalogImportRow[] = [...importAcc.values()]
    .map((entry) => {
      const lat = summarizeLatencies(entry.durations);
      return {
        sourceKind: entry.sourceKind,
        count: entry.count,
        failureCount: entry.failureCount,
        failureRate: roundRate(entry.failureCount, entry.count),
        p50Ms: lat.p50Ms,
        p95Ms: lat.p95Ms,
        maxMs: lat.maxMs,
      };
    })
    .sort((a, b) => b.count - a.count || a.sourceKind.localeCompare(b.sourceKind));

  const deviceProfiles: DeviceProfileRow[] = [...profileAcc.values()]
    .map((entry) => ({
      platform: entry.platform,
      formFactor: entry.formFactor,
      arch: entry.arch,
      ramBucket: entry.ramBucket,
      resolution: entry.resolution,
      gpu: entry.gpu,
      locale: entry.locale,
      sessions: entry.sessions.size,
      events: entry.events,
    }))
    .sort(
      (a, b) =>
        b.sessions - a.sessions || b.events - a.events || a.platform.localeCompare(b.platform),
    );

  const recentFeedback: DigestFeedbackItem[] = [...feedback]
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    .slice(0, MAX_RECENT_FEEDBACK)
    .map((item) => ({
      id: item.id,
      receivedAt: item.receivedAt,
      category: validCategories.has(item.category) ? (item.category as FeedbackCategory) : 'other',
      appVersion: item.appVersion,
      platform: item.platform,
      locale: item.locale,
      message: item.message,
      hasDiagnostics: item.diagnosticsJson !== null,
    }));

  const slowSqliteSummary = summarizeLatencies(slowSqliteDurations);
  const playbackStartSummary = summarizeLatencies(playbackStartDurations);
  const sessionCount = uniqueSessions.size;

  return {
    generatedAt,
    since: sinceIso,
    totals: {
      telemetryEvents: events.length,
      uniqueSessions: sessionCount,
      feedbackSubmissions: feedback.length,
    },
    pendingAccountDeletionRequests,
    versionPlatformMatrix,
    startupLatency: summarizeLatencies(startupDurations),
    screenLatencies,
    stallAndJank: {
      frameJankEvents,
      frameJankRatePerSession: roundRate(frameJankEvents, sessionCount),
      jsStallEvents,
      jsStallRatePerSession: roundRate(jsStallEvents, sessionCount),
      maxStallMs,
      slowSqliteOps: slowSqliteSummary.count,
      slowSqliteP95Ms: slowSqliteSummary.p95Ms,
      memoryPressureEvents,
      playbackRebufferEvents,
      playbackStartCount: playbackStartSummary.count,
      playbackStartP95Ms: playbackStartSummary.p95Ms,
      hotspots,
    },
    mediaDecodeFailures,
    crashesAndErrors,
    catalogImports,
    deviceProfiles,
    feedbackByCategory,
    recentFeedback,
  };
}
