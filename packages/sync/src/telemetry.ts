import { redactText } from '@elv/domain';
import { utf8ByteLength } from './encoding';
import type { SyncClockPort, SyncHttpPort } from './ports';

/** Strictly allowlisted runtime telemetry event kinds (`#458`, `#70`). */
export const TELEMETRY_EVENT_KINDS = [
  'startup',
  'screen_transition',
  'frame_jank',
  'js_stall',
  'memory_pressure',
  'playback_start',
  'playback_rebuffer',
  'playback_error',
  'media_decode_failure',
  'sqlite_slow_op',
] as const;

/** Union of all allowlisted telemetry event kind discriminants. */
export type TelemetryEventKind = (typeof TELEMETRY_EVENT_KINDS)[number];

/** Allowlisted, privacy-preserving runtime telemetry event union aligned with `@elv/sync-server`. */
export type TelemetryEvent =
  | {
      readonly kind: 'startup';
      readonly ts: number;
      readonly durationMs: number;
      readonly coldStart: boolean;
      readonly phase?: string;
    }
  | {
      readonly kind: 'screen_transition';
      readonly ts: number;
      readonly screen: string;
      readonly fromScreen?: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'frame_jank';
      readonly ts: number;
      readonly screen: string;
      readonly droppedFrames: number;
      readonly durationMs: number;
      readonly jankCount?: number;
    }
  | {
      readonly kind: 'js_stall';
      readonly ts: number;
      readonly screen: string;
      readonly durationMs: number;
      readonly maxBlockMs?: number;
    }
  | {
      readonly kind: 'memory_pressure';
      readonly ts: number;
      readonly level: 'moderate' | 'critical';
      readonly screen?: string;
      readonly usedMb?: number;
    }
  | {
      readonly kind: 'playback_start';
      readonly ts: number;
      readonly engine: string;
      readonly durationMs: number;
      readonly isLive: boolean;
      readonly streamKind?: string;
    }
  | {
      readonly kind: 'playback_rebuffer';
      readonly ts: number;
      readonly engine: string;
      readonly durationMs: number;
      readonly isLive: boolean;
      readonly rebufferCount?: number;
    }
  | {
      readonly kind: 'playback_error';
      readonly ts: number;
      readonly engine: string;
      readonly errorCode: string;
      readonly isLive: boolean;
      readonly recoverable?: boolean;
    }
  | {
      readonly kind: 'media_decode_failure';
      readonly ts: number;
      readonly engine: string;
      readonly container: string;
      readonly videoCodec: string;
      readonly audioCodec: string;
      readonly errorCode: string;
      readonly hdrFormat?: string;
      readonly isLive: boolean;
    }
  | {
      readonly kind: 'sqlite_slow_op';
      readonly ts: number;
      readonly operation: string;
      readonly durationMs: number;
      readonly rowCount?: number;
    };

/** Default FIFO ring buffer entry ceiling. */
export const DEFAULT_TELEMETRY_MAX_ENTRIES = 256;

/** Default FIFO ring buffer serialized UTF-8 byte ceiling (128 KiB). */
export const DEFAULT_TELEMETRY_MAX_BYTES = 131_072;

const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IPV4_RE = /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^0-9])/;
const FORBIDDEN_PATTERNS_RE =
  /(:\/\/|@|\\|\/Users\/|\/home\/|\/data\/|\/etc\/|\/var\/|bearer\s|basic\s|authorization|cookie|passwd|password|secret|token=|api_key|apikey)/i;
const MAX_SAFE_DURATION_MS = 86_400_000;

function sanitizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (FORBIDDEN_PATTERNS_RE.test(trimmed) || IPV4_RE.test(trimmed)) return null;
  const firstRedacted = redactText(trimmed);
  const secondRedacted = redactText(firstRedacted);
  if (firstRedacted !== trimmed || secondRedacted !== trimmed) return null;
  if (!SAFE_TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}

function sanitizeOptionalToken(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return sanitizeToken(value);
}

function sanitizeNonNegNumber(value: unknown, max = MAX_SAFE_DURATION_MS): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

function sanitizeOptionalNonNegNumber(
  value: unknown,
  max = MAX_SAFE_DURATION_MS,
): number | undefined | null {
  if (value === undefined) return undefined;
  return sanitizeNonNegNumber(value, max);
}

function sanitizeTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * Strictly validates and double-redacts a candidate telemetry event against the allowlisted schema.
 * Drops unknown properties and rejects any field containing URLs, IPs, credentials, or file paths.
 */
export function sanitizeTelemetryEvent(raw: unknown): TelemetryEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const ts = sanitizeTimestamp(rec.ts);
  if (ts === null) return null;

  switch (rec.kind) {
    case 'startup': {
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      const phase = sanitizeOptionalToken(rec.phase);
      if (durationMs === null || typeof rec.coldStart !== 'boolean' || phase === null) return null;
      return {
        kind: 'startup',
        ts,
        durationMs,
        coldStart: rec.coldStart,
        ...(phase !== undefined ? { phase } : {}),
      };
    }
    case 'screen_transition': {
      const screen = sanitizeToken(rec.screen);
      const fromScreen = sanitizeOptionalToken(rec.fromScreen);
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      if (screen === null || fromScreen === null || durationMs === null) return null;
      return {
        kind: 'screen_transition',
        ts,
        screen,
        durationMs,
        ...(fromScreen !== undefined ? { fromScreen } : {}),
      };
    }
    case 'frame_jank': {
      const screen = sanitizeToken(rec.screen);
      const droppedFrames = sanitizeNonNegNumber(rec.droppedFrames, 100_000);
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      const jankCount = sanitizeOptionalNonNegNumber(rec.jankCount, 100_000);
      if (screen === null || droppedFrames === null || durationMs === null || jankCount === null) {
        return null;
      }
      return {
        kind: 'frame_jank',
        ts,
        screen,
        droppedFrames: Math.trunc(droppedFrames),
        durationMs,
        ...(jankCount !== undefined ? { jankCount: Math.trunc(jankCount) } : {}),
      };
    }
    case 'js_stall': {
      const screen = sanitizeToken(rec.screen);
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      const maxBlockMs = sanitizeOptionalNonNegNumber(rec.maxBlockMs);
      if (screen === null || durationMs === null || maxBlockMs === null) return null;
      return {
        kind: 'js_stall',
        ts,
        screen,
        durationMs,
        ...(maxBlockMs !== undefined ? { maxBlockMs } : {}),
      };
    }
    case 'memory_pressure': {
      if (rec.level !== 'moderate' && rec.level !== 'critical') return null;
      const screen = sanitizeOptionalToken(rec.screen);
      const usedMb = sanitizeOptionalNonNegNumber(rec.usedMb, 1_048_576);
      if (screen === null || usedMb === null) return null;
      return {
        kind: 'memory_pressure',
        ts,
        level: rec.level,
        ...(screen !== undefined ? { screen } : {}),
        ...(usedMb !== undefined ? { usedMb } : {}),
      };
    }
    case 'playback_start': {
      const engine = sanitizeToken(rec.engine);
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      const streamKind = sanitizeOptionalToken(rec.streamKind);
      if (
        engine === null ||
        durationMs === null ||
        typeof rec.isLive !== 'boolean' ||
        streamKind === null
      ) {
        return null;
      }
      return {
        kind: 'playback_start',
        ts,
        engine,
        durationMs,
        isLive: rec.isLive,
        ...(streamKind !== undefined ? { streamKind } : {}),
      };
    }
    case 'playback_rebuffer': {
      const engine = sanitizeToken(rec.engine);
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      const rebufferCount = sanitizeOptionalNonNegNumber(rec.rebufferCount, 100_000);
      if (
        engine === null ||
        durationMs === null ||
        typeof rec.isLive !== 'boolean' ||
        rebufferCount === null
      ) {
        return null;
      }
      return {
        kind: 'playback_rebuffer',
        ts,
        engine,
        durationMs,
        isLive: rec.isLive,
        ...(rebufferCount !== undefined ? { rebufferCount: Math.trunc(rebufferCount) } : {}),
      };
    }
    case 'playback_error': {
      const engine = sanitizeToken(rec.engine);
      const errorCode = sanitizeToken(rec.errorCode);
      if (
        engine === null ||
        errorCode === null ||
        typeof rec.isLive !== 'boolean' ||
        (rec.recoverable !== undefined && typeof rec.recoverable !== 'boolean')
      ) {
        return null;
      }
      return {
        kind: 'playback_error',
        ts,
        engine,
        errorCode,
        isLive: rec.isLive,
        ...(rec.recoverable !== undefined ? { recoverable: rec.recoverable } : {}),
      };
    }
    case 'media_decode_failure': {
      const engine = sanitizeToken(rec.engine);
      const container = sanitizeToken(rec.container);
      const videoCodec = sanitizeToken(rec.videoCodec);
      const audioCodec = sanitizeToken(rec.audioCodec);
      const errorCode = sanitizeToken(rec.errorCode);
      const hdrFormat = sanitizeOptionalToken(rec.hdrFormat);
      if (
        engine === null ||
        container === null ||
        videoCodec === null ||
        audioCodec === null ||
        errorCode === null ||
        hdrFormat === null ||
        typeof rec.isLive !== 'boolean'
      ) {
        return null;
      }
      return {
        kind: 'media_decode_failure',
        ts,
        engine,
        container,
        videoCodec,
        audioCodec,
        errorCode,
        isLive: rec.isLive,
        ...(hdrFormat !== undefined ? { hdrFormat } : {}),
      };
    }
    case 'sqlite_slow_op': {
      const operation = sanitizeToken(rec.operation);
      const durationMs = sanitizeNonNegNumber(rec.durationMs);
      const rowCount = sanitizeOptionalNonNegNumber(rec.rowCount, 10_000_000);
      if (operation === null || durationMs === null || rowCount === null) return null;
      return {
        kind: 'sqlite_slow_op',
        ts,
        operation,
        durationMs,
        ...(rowCount !== undefined ? { rowCount: Math.trunc(rowCount) } : {}),
      };
    }
    default:
      return null;
  }
}

/** Bounded FIFO ring buffer storing sanitized telemetry events. */
export interface TelemetryQueue {
  push(rawEvent: unknown): boolean;
  peek(limit?: number): readonly TelemetryEvent[];
  drain(count: number): readonly TelemetryEvent[];
  size(): number;
  byteLength(): number;
  clear(): void;
}

/** Options for {@link createTelemetryQueue}. */
export interface TelemetryQueueOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

/** Creates a bounded FIFO telemetry ring buffer enforcing both entry and UTF-8 byte caps. */
export function createTelemetryQueue(options?: TelemetryQueueOptions): TelemetryQueue {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_TELEMETRY_MAX_ENTRIES);
  const maxBytes = Math.max(256, options?.maxBytes ?? DEFAULT_TELEMETRY_MAX_BYTES);

  const items: Array<{ readonly event: TelemetryEvent; readonly bytes: number }> = [];
  let totalBytes = 0;

  return {
    push(rawEvent: unknown): boolean {
      const clean = sanitizeTelemetryEvent(rawEvent);
      if (clean === null) return false;
      const bytes = utf8ByteLength(JSON.stringify(clean));
      if (bytes > maxBytes) return false;

      while (items.length >= maxEntries || totalBytes + bytes > maxBytes) {
        const dropped = items.shift();
        if (dropped === undefined) break;
        totalBytes -= dropped.bytes;
      }
      items.push({ event: clean, bytes });
      totalBytes += bytes;
      return true;
    },

    peek(limit?: number): readonly TelemetryEvent[] {
      const slice = limit !== undefined ? items.slice(0, Math.max(0, limit)) : items;
      return slice.map((item) => item.event);
    },

    drain(count: number): readonly TelemetryEvent[] {
      const n = Math.min(items.length, Math.max(0, Math.trunc(count)));
      const removed = items.splice(0, n);
      for (const item of removed) totalBytes -= item.bytes;
      return removed.map((item) => item.event);
    },

    size(): number {
      return items.length;
    },

    byteLength(): number {
      return totalBytes;
    },

    clear(): void {
      items.length = 0;
      totalBytes = 0;
    },
  };
}

/** Batch envelope uploaded to `POST /v1/telemetry` and shown in the Settings JSON preview. */
export interface TelemetryBatchPayload {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly sentAt: number;
  readonly events: readonly TelemetryEvent[];
}

/** Input to {@link buildTelemetryPayloadPreview}. */
export interface TelemetryPreviewInput {
  readonly sessionId: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly events: readonly unknown[];
  readonly sentAt?: number;
}

/** Builds a human-readable, strictly sanitized JSON preview of the exact telemetry payload. */
export function buildTelemetryPayloadPreview(input: TelemetryPreviewInput): string {
  const sanitizedEvents: TelemetryEvent[] = [];
  for (const raw of input.events) {
    const clean = sanitizeTelemetryEvent(raw);
    if (clean !== null) sanitizedEvents.push(clean);
  }
  const payload: TelemetryBatchPayload = {
    schemaVersion: 1,
    sessionId: sanitizeToken(input.sessionId) ?? 'anonymous',
    platform: sanitizeToken(input.platform) ?? 'unknown',
    appVersion: sanitizeToken(input.appVersion) ?? '0.0.0',
    sentAt: sanitizeTimestamp(input.sentAt) ?? 0,
    events: sanitizedEvents,
  };
  return JSON.stringify(payload, null, 2);
}

/** Result returned by {@link TelemetryUploader.flush}. */
export interface TelemetryFlushResult {
  readonly sent: number;
  readonly skippedReason?: 'opted_out' | 'kill_switch' | 'backoff' | 'empty' | 'network_error';
}

/** Options for {@link createTelemetryUploader}. */
export interface TelemetryUploaderOptions {
  readonly baseUrl: string;
  readonly http: SyncHttpPort;
  readonly isOptedIn: () => boolean;
  readonly clock: SyncClockPort;
  readonly sessionId: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly queue?: TelemetryQueue;
  readonly maxBatchSize?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/** Opt-in telemetry uploader with strict zero-traffic opt-out, backoff, and remote kill-switch. */
export interface TelemetryUploader {
  readonly queue: TelemetryQueue;
  record(rawEvent: unknown): boolean;
  flush(signal?: AbortSignal): Promise<TelemetryFlushResult>;
  isRemotelyDisabled(): boolean;
  preview(): string;
}

/** Creates an opt-in {@link TelemetryUploader} that emits zero network calls unless opted in. */
export function createTelemetryUploader(options: TelemetryUploaderOptions): TelemetryUploader {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const queue = options.queue ?? createTelemetryQueue();
  const maxBatchSize = Math.max(1, options.maxBatchSize ?? 64);
  const baseBackoffMs = Math.max(100, options.baseBackoffMs ?? 5_000);
  const maxBackoffMs = Math.max(baseBackoffMs, options.maxBackoffMs ?? 300_000);

  const safeSessionId = sanitizeToken(options.sessionId) ?? 'anonymous';
  const safePlatform = sanitizeToken(options.platform) ?? 'unknown';
  const safeAppVersion = sanitizeToken(options.appVersion) ?? '0.0.0';

  let disabled = false;
  let consecutiveFailures = 0;
  let nextAllowedAt = 0;

  const scheduleBackoff = (now: number): void => {
    consecutiveFailures += 1;
    const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (consecutiveFailures - 1));
    nextAllowedAt = now + delay;
  };

  return {
    queue,

    record(rawEvent: unknown): boolean {
      if (!options.isOptedIn() || disabled) return false;
      return queue.push(rawEvent);
    },

    async flush(signal?: AbortSignal): Promise<TelemetryFlushResult> {
      if (!options.isOptedIn()) {
        return { sent: 0, skippedReason: 'opted_out' };
      }
      if (disabled) {
        return { sent: 0, skippedReason: 'kill_switch' };
      }
      const now = options.clock.now();
      if (now < nextAllowedAt) {
        return { sent: 0, skippedReason: 'backoff' };
      }
      const batch = queue.peek(maxBatchSize);
      if (batch.length === 0) {
        return { sent: 0, skippedReason: 'empty' };
      }

      const payload: TelemetryBatchPayload = {
        schemaVersion: 1,
        sessionId: safeSessionId,
        platform: safePlatform,
        appVersion: safeAppVersion,
        sentAt: now,
        events: batch,
      };

      try {
        const res = await options.http.request({
          method: 'POST',
          url: `${baseUrl}/v1/telemetry`,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          ...(signal !== undefined ? { signal } : {}),
        });
        if (res.status >= 200 && res.status < 300) {
          let parsed: Record<string, unknown> | null = null;
          try {
            const obj: unknown = JSON.parse(res.bodyText);
            if (typeof obj === 'object' && obj !== null) parsed = obj as Record<string, unknown>;
          } catch {
            // Non-JSON 2xx response still counts as accepted.
          }
          if (parsed?.disabled === true) {
            disabled = true;
            queue.clear();
            return { sent: 0, skippedReason: 'kill_switch' };
          }
          queue.drain(batch.length);
          consecutiveFailures = 0;
          nextAllowedAt = 0;
          return { sent: batch.length };
        }
        scheduleBackoff(now);
        return { sent: 0, skippedReason: 'network_error' };
      } catch {
        scheduleBackoff(now);
        return { sent: 0, skippedReason: 'network_error' };
      }
    },

    isRemotelyDisabled(): boolean {
      return disabled;
    },

    preview(): string {
      return buildTelemetryPayloadPreview({
        sessionId: safeSessionId,
        platform: safePlatform,
        appVersion: safeAppVersion,
        events: queue.peek(maxBatchSize),
        sentAt: options.clock.now(),
      });
    },
  };
}
