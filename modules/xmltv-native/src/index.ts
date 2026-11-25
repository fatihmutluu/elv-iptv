import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

/** Channel metadata extracted by the native XMLTV stager. */
export interface NativeXmltvChannel {
  readonly id: string;
  readonly names: readonly string[];
  readonly icon?: string;
  readonly lcn?: string;
}

/** Request payload passed to the native streaming XMLTV stager (`#478`). */
export interface NativeXmltvStageRequest {
  readonly jobId: string;
  readonly url: string;
  readonly dbPath: string;
  readonly sourceId: string;
  readonly runId: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
  readonly defaultTimeZone?: string;
  readonly timeoutMs?: number;
}

/** Outcome returned by the native XMLTV stager; never carries URLs, headers, or response bodies. */
export type NativeXmltvStageResult =
  | {
      readonly kind: 'not-modified';
      readonly etag?: string;
      readonly lastModified?: string;
    }
  | {
      readonly kind: 'http-error';
      readonly status: number;
      readonly retryable: boolean;
      readonly code: string;
    }
  | {
      readonly kind: 'staged';
      readonly stageDbPath?: string;
      readonly channels: readonly NativeXmltvChannel[];
      readonly stagedCounts: Readonly<Record<string, number>>;
      readonly seenProgrammes: number;
      readonly stagedProgrammes: number;
      readonly warnings: number;
      readonly warningCodes: readonly string[];
      readonly etag?: string;
      readonly lastModified?: string;
    };

interface NativeXmltvModule {
  stageXmltv(request: Record<string, unknown>): Promise<unknown>;
  cancelXmltvStage(jobId: string): void;
  cleanupStageFile?(path: string): void;
}

const STAGE_FILE_NAME_RE = /\.xmltv-stage-[A-Za-z0-9_-]+\.db$/;

const native: NativeXmltvModule | null =
  Platform.OS === 'web' ? null : requireOptionalNativeModule<NativeXmltvModule>('ElvXmltvNative');

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeChannel(raw: unknown): NativeXmltvChannel | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  const names: string[] = [];
  if (Array.isArray(obj.names)) {
    for (const n of obj.names) {
      if (typeof n === 'string' && n.length > 0) names.push(n);
    }
  }
  const icon = optionalNonEmptyString(obj.icon);
  const lcn = optionalNonEmptyString(obj.lcn);
  return {
    id: obj.id,
    names,
    ...(icon === undefined ? {} : { icon }),
    ...(lcn === undefined ? {} : { lcn }),
  };
}

function normalizeStageResult(raw: unknown): NativeXmltvStageResult {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'http-error', status: 0, retryable: false, code: 'native-invalid-result' };
  }
  const obj = raw as Record<string, unknown>;
  const etag = optionalNonEmptyString(obj.etag);
  const lastModified = optionalNonEmptyString(obj.lastModified);
  if (obj.kind === 'not-modified') {
    return {
      kind: 'not-modified',
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    };
  }
  if (obj.kind === 'http-error') {
    const status = typeof obj.status === 'number' && Number.isFinite(obj.status) ? obj.status : 0;
    const retryable = obj.retryable === true;
    const code = typeof obj.code === 'string' && obj.code.length > 0 ? obj.code : 'request-failed';
    return { kind: 'http-error', status, retryable, code };
  }
  if (obj.kind === 'staged') {
    const channels: NativeXmltvChannel[] = [];
    if (Array.isArray(obj.channels)) {
      for (const ch of obj.channels) {
        const normalized = normalizeChannel(ch);
        if (normalized !== null) channels.push(normalized);
      }
    }
    const stagedCounts: Record<string, number> = {};
    if (typeof obj.stagedCounts === 'object' && obj.stagedCounts !== null) {
      for (const [k, v] of Object.entries(obj.stagedCounts as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          stagedCounts[k] = v;
        }
      }
    }
    const warningCodes: string[] = [];
    if (Array.isArray(obj.warningCodes)) {
      for (const code of obj.warningCodes) {
        if (typeof code === 'string' && code.length > 0) warningCodes.push(code);
      }
    }
    const seenProgrammes =
      typeof obj.seenProgrammes === 'number' && Number.isFinite(obj.seenProgrammes)
        ? obj.seenProgrammes
        : 0;
    const stagedProgrammes =
      typeof obj.stagedProgrammes === 'number' && Number.isFinite(obj.stagedProgrammes)
        ? obj.stagedProgrammes
        : 0;
    const warnings =
      typeof obj.warnings === 'number' && Number.isFinite(obj.warnings) ? obj.warnings : 0;
    const stageDbPath = optionalNonEmptyString(obj.stageDbPath);
    return {
      kind: 'staged',
      ...(stageDbPath === undefined ? {} : { stageDbPath }),
      channels,
      stagedCounts,
      seenProgrammes,
      stagedProgrammes,
      warnings,
      warningCodes,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    };
  }
  return { kind: 'http-error', status: 0, retryable: false, code: 'native-invalid-result' };
}

/** Returns `true` when the native `ElvXmltvNative` Expo module is linked on this platform. */
export function isNativeXmltvStagerAvailable(): boolean {
  return native !== null;
}

/**
 * Streams an HTTP(S) XMLTV feed off the JS thread and stages programmes directly into SQLite
 * `programmes_next`. Returns `null` cleanly on web, Node, or builds without the native module.
 */
export async function stageXmltv(
  request: NativeXmltvStageRequest,
): Promise<NativeXmltvStageResult | null> {
  if (native === null) return null;
  const payload: Record<string, unknown> = {
    jobId: request.jobId,
    url: request.url,
    dbPath: request.dbPath,
    sourceId: request.sourceId,
    runId: request.runId,
    fromMs: request.fromMs,
    toMs: request.toMs,
  };
  if (request.headers !== undefined) payload.headers = request.headers;
  if (request.ifNoneMatch !== undefined) payload.ifNoneMatch = request.ifNoneMatch;
  if (request.ifModifiedSince !== undefined) payload.ifModifiedSince = request.ifModifiedSince;
  if (request.defaultTimeZone !== undefined) payload.defaultTimeZone = request.defaultTimeZone;
  if (request.timeoutMs !== undefined) payload.timeoutMs = request.timeoutMs;
  const raw = await native.stageXmltv(payload);
  return normalizeStageResult(raw);
}

/** Cooperatively cancels an active native XMLTV staging job; safe no-op when unavailable. */
export function cancelXmltvStage(jobId: string): void {
  if (native === null || jobId.length === 0) return;
  native.cancelXmltvStage(jobId);
}

/**
 * Deletes a temporary XMLTV stage SQLite file (and any `-wal`/`-shm`/`-journal` sidecars) created
 * by {@link stageXmltv}. Strictly ignores paths whose basename does not match
 * `\.xmltv-stage-[A-Za-z0-9_-]+\.db$`. Safe no-op when unavailable.
 */
export function cleanupStageFile(path: string): void {
  if (native === null || path.length === 0) return;
  const base = path.split(/[\\/]/).pop() ?? '';
  if (!STAGE_FILE_NAME_RE.test(base)) return;
  native.cleanupStageFile?.(path);
}
