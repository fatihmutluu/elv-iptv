import {
  type DeviceTechnicalProfile,
  redactDiagnosticText,
  sanitizeDeviceProfile,
  type TelemetryEvent,
} from '@elv/sync';
import type { TelemetryRecordRequest } from '../../shared/sync-ipc.ts';

/** Input parameters for {@link buildDesktopDeviceProfile}. */
export interface DesktopDeviceProfileInput {
  readonly platform: string;
  readonly arch: string;
  readonly totalMemBytes?: number;
  readonly osRelease?: string;
  readonly gpu?: string;
  readonly resolution?: string;
  readonly locale?: string;
}

function classifyRamBucket(totalMemBytes: number | undefined): string | undefined {
  if (totalMemBytes === undefined || !Number.isFinite(totalMemBytes) || totalMemBytes <= 0) {
    return undefined;
  }
  const gb = totalMemBytes / 1024 ** 3;
  if (gb <= 2.5) return 'lte_2gb';
  if (gb <= 5) return '4gb';
  if (gb <= 10) return '8gb';
  if (gb <= 20) return '16gb';
  return '32gb_plus';
}

/** Builds a strictly sanitized {@link DeviceTechnicalProfile} for Desktop opt-in telemetry (`#509`). */
export function buildDesktopDeviceProfile(
  input: DesktopDeviceProfileInput,
): DeviceTechnicalProfile {
  const ramBucket = classifyRamBucket(input.totalMemBytes);
  const osVersion =
    input.osRelease !== undefined && input.osRelease.trim().length > 0
      ? `${input.platform} ${input.osRelease.trim()}`
      : input.platform;
  return (
    sanitizeDeviceProfile({
      osVersion,
      formFactor: 'desktop',
      arch: input.arch,
      ...(ramBucket !== undefined ? { ramBucket } : {}),
      ...(input.gpu !== undefined ? { gpu: input.gpu } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    }) ?? { formFactor: 'desktop' }
  );
}

const SAFE_CODE_FRAME_RE = /\b([A-Za-z0-9._-]+\.(?:js|mjs|cjs|ts|tsx|jsx|bundle|hbc)):(\d+)/;

/**
 * Extracts a privacy-safe `(errorName, stackSig)` pair from an arbitrary runtime error,
 * redacting URLs, credentials, IPs, and OS paths BEFORE frame extraction and restricting
 * matched frames strictly to code-bundle filenames (`#509`).
 */
export function extractSafeErrorSignature(error: unknown): {
  readonly errorName: string;
  readonly stackSig: string;
} {
  const rawName =
    error instanceof Error
      ? error.name
      : typeof error === 'object' && error !== null && 'name' in error
        ? String((error as { name: unknown }).name)
        : 'Error';
  const safeName =
    redactDiagnosticText(rawName, 64)
      .replace(/\//g, '.')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64) || 'Error';

  const rawStack =
    error instanceof Error && typeof error.stack === 'string'
      ? error.stack
      : typeof error === 'string'
        ? error
        : safeName;

  const lines = rawStack.split(/\r?\n/);
  const scanLines = lines.length > 1 ? lines.slice(1) : lines;
  let frameToken = '';
  for (const line of scanLines) {
    // Redact raw stack line BEFORE regex extraction so provider URLs/host:ports never leak.
    const redactedLine = redactDiagnosticText(line, 512);
    const match = SAFE_CODE_FRAME_RE.exec(redactedLine);
    if (match !== null) {
      frameToken = `${match[1]}:${match[2]}`;
      break;
    }
  }
  const candidate = frameToken.length > 0 ? frameToken : safeName;
  const cleaned = redactDiagnosticText(candidate, 128)
    .replace(/[^A-Za-z0-9._:/+-]/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128);
  return {
    errorName: safeName,
    stackSig: cleaned.length > 0 ? cleaned : 'unknown:0',
  };
}

/** Maps a validated Desktop IPC {@link TelemetryRecordRequest} onto `@elv/sync`'s {@link TelemetryEvent}. */
export function mapDesktopTelemetryRequestToEvent(
  event: TelemetryRecordRequest,
  ts: number,
): TelemetryEvent {
  switch (event.kind) {
    case 'startup':
      return {
        kind: 'startup',
        ts,
        durationMs: event.durationMs,
        coldStart: event.coldStart,
      };
    case 'screen_transition':
      return {
        kind: 'screen_transition',
        ts,
        screen: event.screen,
        durationMs: event.durationMs,
      };
    case 'frame_jank':
      return {
        kind: 'frame_jank',
        ts,
        screen: event.screen,
        droppedFrames: event.droppedFrames,
        durationMs: event.maxFrameMs,
      };
    case 'js_stall':
      return {
        kind: 'js_stall',
        ts,
        screen: event.screen,
        durationMs: event.durationMs,
      };
    case 'memory_pressure':
      return {
        kind: 'memory_pressure',
        ts,
        level: event.level,
        ...(event.usedMb !== undefined ? { usedMb: event.usedMb } : {}),
      };
    case 'playback_start':
      return {
        kind: 'playback_start',
        ts,
        engine: event.engine,
        durationMs: event.ttffMs,
        isLive: event.isLive,
        streamKind: event.container ?? (event.isLive ? 'live' : 'vod'),
      };
    case 'playback_rebuffer':
      return {
        kind: 'playback_rebuffer',
        ts,
        engine: event.engine,
        durationMs: event.durationMs,
        isLive: event.isLive,
      };
    case 'playback_error':
      return {
        kind: 'playback_error',
        ts,
        engine: event.engine,
        errorCode: event.errorCode,
        isLive: event.isLive,
      };
    case 'media_decode_failure':
      return {
        kind: 'media_decode_failure',
        ts,
        engine: event.engine,
        container: event.container ?? 'unknown',
        videoCodec: event.videoCodec ?? 'unknown',
        audioCodec: event.audioCodec ?? 'unknown',
        errorCode: event.errorCode,
        ...(event.hdrFormat !== undefined ? { hdrFormat: event.hdrFormat } : {}),
        isLive: event.isLive,
      };
    case 'sqlite_slow_op':
      return {
        kind: 'sqlite_slow_op',
        ts,
        operation: event.op,
        durationMs: event.durationMs,
      };
    case 'app_crash':
      return {
        kind: 'app_crash',
        ts,
        errorName: event.errorName,
        stackSig: event.stackSig,
        ...(event.screen !== undefined ? { screen: event.screen } : {}),
        fatal: event.fatal,
        ...(event.uptimeMs !== undefined ? { uptimeMs: event.uptimeMs } : {}),
      };
    case 'unhandled_error':
      return {
        kind: 'unhandled_error',
        ts,
        errorName: event.errorName,
        stackSig: event.stackSig,
        ...(event.screen !== undefined ? { screen: event.screen } : {}),
        ...(event.source !== undefined ? { source: event.source } : {}),
      };
    case 'catalog_import':
      return {
        kind: 'catalog_import',
        ts,
        sourceKind: event.sourceKind,
        stage: event.stage,
        durationMs: event.durationMs,
        itemCount: event.itemCount,
        success: event.success,
        ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
      };
  }
}
