import {
  createTelemetryQueue,
  createTelemetryUploader,
  type SyncClockPort,
  type SyncHttpPort,
  submitFeedback,
  type TelemetryEvent,
  type TelemetryUploader,
} from '@elv/sync';
import {
  buildMobileDeviceProfile,
  type CreateTvMobileSyncPortsOptions,
  DEFAULT_FLUSH_INTERVAL_MS,
  errorCodeFrom,
  FEEDBACK_LOG_TAIL_LINES,
  type FeedbackPort,
  type FeedbackSubmitInput,
  generateSessionId,
  redactDiagnosticsLine,
  type TelemetryMediaDecodeFailure,
  type TelemetryPort,
} from './sync-helpers';

/** Options for {@link createMobileTelemetryAndFeedback}. */
export interface CreateMobileTelemetryAndFeedbackOptions {
  readonly resolveBaseUrl: () => string;
  readonly http: SyncHttpPort;
  readonly clock: SyncClockPort;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly options: CreateTvMobileSyncPortsOptions;
}

/** Return value of {@link createMobileTelemetryAndFeedback}. */
export interface MobileTelemetryAndFeedbackHandle {
  readonly telemetry: TelemetryPort;
  readonly feedback: FeedbackPort;
  flushIfOptedIn(): void;
  dispose(): void;
}

/**
 * Builds the `tv-mobile` 13-kind {@link TelemetryPort} (with sanitized `DeviceTechnicalProfile`
 * and periodic flush timer) and redacted {@link FeedbackPort} (`#458`, `#509`).
 */
export function createMobileTelemetryAndFeedback(
  deps: CreateMobileTelemetryAndFeedbackOptions,
): MobileTelemetryAndFeedbackHandle {
  const { resolveBaseUrl, http, clock, randomBytes, options } = deps;

  let telemetryOptIn = Boolean(options.getPreferences?.()?.telemetryOptIn);
  let hasExplicitOptIn = false;
  let sessionId = generateSessionId(randomBytes);
  const telemetryQueue = createTelemetryQueue();
  let cachedUploader: { baseUrl: string; sid: string; uploader: TelemetryUploader } | null = null;

  const isOptedIn = (): boolean => {
    if (hasExplicitOptIn) return telemetryOptIn;
    const pref = options.getPreferences?.()?.telemetryOptIn;
    return typeof pref === 'boolean' ? pref : telemetryOptIn;
  };

  const getUploader = (): TelemetryUploader => {
    const baseUrl = resolveBaseUrl();
    const meta = options.getDeviceMeta();
    const deviceProfile = buildMobileDeviceProfile(meta);
    if (
      cachedUploader === null ||
      cachedUploader.baseUrl !== baseUrl ||
      cachedUploader.sid !== sessionId
    ) {
      cachedUploader = {
        baseUrl,
        sid: sessionId,
        uploader: createTelemetryUploader({
          baseUrl: baseUrl.length > 0 ? baseUrl : 'https://invalid.local',
          http,
          isOptedIn,
          clock,
          sessionId,
          platform: meta.platform,
          appVersion: meta.appVersion,
          ...(deviceProfile !== undefined ? { deviceProfile } : {}),
          queue: telemetryQueue,
        }),
      };
    }
    return cachedUploader.uploader;
  };

  const recordEvent = (ev: TelemetryEvent): void => {
    if (!isOptedIn()) return;
    getUploader().record(ev);
  };

  const telemetry: TelemetryPort = {
    isOptedIn,
    setOptIn(enabled: boolean): void {
      const next = Boolean(enabled);
      const prev = isOptedIn();
      hasExplicitOptIn = true;
      if (next && !prev) sessionId = generateSessionId(randomBytes);
      telemetryOptIn = next;
      if (!next) telemetryQueue.clear();
      if (next !== prev) options.onTelemetryOptInChange?.(next);
    },
    queuedCount: () => telemetryQueue.size(),
    getPayloadPreviewJson: () => getUploader().preview(),
    recordStartup: (durationMs, coldStart) =>
      recordEvent({ kind: 'startup', ts: clock.now(), durationMs, coldStart }),
    recordScreenTransition: (screen, durationMs) =>
      recordEvent({ kind: 'screen_transition', ts: clock.now(), screen, durationMs }),
    recordFrameJank: (meta) =>
      recordEvent({
        kind: 'frame_jank',
        ts: clock.now(),
        screen: meta.screen,
        droppedFrames: meta.droppedFrames,
        durationMs: meta.maxFrameMs,
      }),
    recordJsStall: (meta) =>
      recordEvent({
        kind: 'js_stall',
        ts: clock.now(),
        screen: meta.screen,
        durationMs: meta.durationMs,
      }),
    recordMemoryPressure: (meta) =>
      recordEvent({
        kind: 'memory_pressure',
        ts: clock.now(),
        level: meta.level,
        ...(meta.usedMb !== undefined ? { usedMb: meta.usedMb } : {}),
      }),
    recordPlaybackStart: (meta) =>
      recordEvent({
        kind: 'playback_start',
        ts: clock.now(),
        engine: meta.engine,
        durationMs: meta.ttffMs,
        isLive: Boolean(meta.isLive),
        streamKind: meta.container ?? (meta.isLive ? 'live' : 'vod'),
      }),
    recordPlaybackRebuffer: (meta) =>
      recordEvent({
        kind: 'playback_rebuffer',
        ts: clock.now(),
        engine: meta.engine,
        durationMs: meta.durationMs,
        isLive: Boolean(meta.isLive),
      }),
    recordPlaybackError: (meta) =>
      recordEvent({
        kind: 'playback_error',
        ts: clock.now(),
        engine: meta.engine,
        errorCode: meta.errorCode,
        isLive: Boolean(meta.isLive),
      }),
    recordMediaDecodeFailure: (meta: TelemetryMediaDecodeFailure) =>
      recordEvent({
        kind: 'media_decode_failure',
        ts: clock.now(),
        engine: meta.engine,
        container: meta.container ?? 'unknown',
        videoCodec: meta.videoCodec ?? 'unknown',
        audioCodec: meta.audioCodec ?? 'unknown',
        errorCode: meta.errorCode,
        ...(meta.hdrFormat !== undefined ? { hdrFormat: meta.hdrFormat } : {}),
        isLive: Boolean(meta.isLive),
      }),
    recordSqliteSlowOp: (meta) =>
      recordEvent({
        kind: 'sqlite_slow_op',
        ts: clock.now(),
        operation: meta.op,
        durationMs: meta.durationMs,
      }),
    recordAppCrash: (meta) =>
      recordEvent({
        kind: 'app_crash',
        ts: clock.now(),
        errorName: meta.errorName,
        stackSig: meta.stackSig,
        ...(meta.screen !== undefined ? { screen: meta.screen } : {}),
        fatal: meta.fatal,
        ...(meta.uptimeMs !== undefined ? { uptimeMs: meta.uptimeMs } : {}),
      }),
    recordUnhandledError: (meta) =>
      recordEvent({
        kind: 'unhandled_error',
        ts: clock.now(),
        errorName: meta.errorName,
        stackSig: meta.stackSig,
        ...(meta.screen !== undefined ? { screen: meta.screen } : {}),
        ...(meta.source !== undefined ? { source: meta.source } : {}),
      }),
    recordCatalogImport: (meta) =>
      recordEvent({
        kind: 'catalog_import',
        ts: clock.now(),
        sourceKind: meta.sourceKind,
        stage: meta.stage,
        durationMs: meta.durationMs,
        itemCount: meta.itemCount,
        success: meta.success,
        ...(meta.errorCode !== undefined ? { errorCode: meta.errorCode } : {}),
      }),
    async flush(): Promise<void> {
      if (!isOptedIn() || resolveBaseUrl().length === 0) return;
      await getUploader().flush();
    },
  };

  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const intervalHandle =
    flushIntervalMs > 0
      ? setInterval(() => {
          if (isOptedIn() && telemetryQueue.size() > 0) void telemetry.flush();
        }, flushIntervalMs)
      : undefined;
  if (
    intervalHandle !== undefined &&
    typeof (intervalHandle as { unref?: () => void }).unref === 'function'
  ) {
    (intervalHandle as { unref: () => void }).unref();
  }

  const feedback: FeedbackPort = {
    async submit(input: FeedbackSubmitInput) {
      const baseUrl = resolveBaseUrl();
      if (baseUrl.length === 0) return { ok: false, errorCode: 'server_not_configured' };
      const meta = options.getDeviceMeta();
      let diagnostics: Record<string, string | number | boolean> | undefined;
      if (input.includeDiagnostics) {
        const rawLogs = options.getRecentLogs
          ? await Promise.resolve(options.getRecentLogs(FEEDBACK_LOG_TAIL_LINES)).catch(
              () => [] as readonly string[],
            )
          : [];
        const logTail = rawLogs
          .slice(-FEEDBACK_LOG_TAIL_LINES)
          .map((line) => redactDiagnosticsLine(line))
          .join('\n');
        diagnostics = {
          platform: meta.platform,
          appVersion: meta.appVersion,
          ...(meta.osVersion !== undefined ? { osVersion: meta.osVersion } : {}),
          ...(logTail.length > 0 ? { logTail } : {}),
        };
      }
      const res = await submitFeedback({
        baseUrl,
        http,
        submission: {
          category: input.category,
          message: input.message,
          platform: meta.platform,
          appVersion: meta.appVersion,
          ...(meta.locale !== undefined ? { locale: meta.locale } : {}),
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        },
      });
      return res.ok
        ? { ok: true, id: res.value.id }
        : { ok: false, errorCode: errorCodeFrom(res.error) };
    },
  };

  return {
    telemetry,
    feedback,
    flushIfOptedIn(): void {
      if (isOptedIn()) void telemetry.flush();
    },
    dispose(): void {
      if (intervalHandle !== undefined) clearInterval(intervalHandle);
    },
  };
}
