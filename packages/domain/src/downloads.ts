import type { Result } from './result';

/** Strictly allowlisted container file extensions for managed offline VOD downloads. */
export const ALLOWED_DOWNLOAD_EXTENSIONS = Object.freeze([
  '.mp4',
  '.mkv',
  '.ts',
  '.m4v',
  '.webm',
  '.mov',
] as const);

/** Media kinds eligible for offline downloads (strictly VOD Movies and Series Episodes). */
export type DownloadMediaKind = 'movie' | 'episode';

/** Lifecycle state of a managed offline download. */
export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Persisted and runtime snapshot of a managed offline VOD download. */
export interface DownloadRecord {
  readonly id: string;
  readonly profileId: string;
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: DownloadMediaKind;
  readonly title: string;
  readonly seriesTitle?: string | null;
  readonly season?: number | null;
  readonly episodeNum?: number | null;
  readonly poster?: string | null;
  readonly localFileName: string;
  readonly localUri: string | null;
  readonly bytesDownloaded: number;
  readonly totalBytes: number | null;
  readonly status: DownloadStatus;
  readonly pausedForPlayback?: boolean;
  readonly errorCode?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | null;
}

/** Input payload for enqueueing a new offline Movie or Series Episode download. */
export interface DownloadEnqueueInput {
  readonly profileId?: string;
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: DownloadMediaKind;
  readonly title: string;
  readonly seriesTitle?: string | null;
  readonly season?: number | null;
  readonly episodeNum?: number | null;
  readonly poster?: string | null;
  readonly streamUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly containerExtension?: string | null;
}

/** Incremental progress or status patch for an existing managed download. */
export interface DownloadProgressUpdate {
  readonly bytesDownloaded: number;
  readonly totalBytes?: number | null;
  readonly status?: DownloadStatus;
  readonly localUri?: string | null;
  readonly pausedForPlayback?: boolean;
  readonly errorCode?: string | null;
  readonly completedAt?: number | null;
}

/** Cross-platform port for managing offline VOD downloads. */
export interface DownloadManagerPort {
  readonly supported: boolean;
  list(profileId?: string): Promise<readonly DownloadRecord[]>;
  get(itemKey: string, profileId?: string): Promise<DownloadRecord | null>;
  enqueue(input: DownloadEnqueueInput): Promise<Result<DownloadRecord>>;
  pause(itemKey: string, profileId?: string): Promise<Result<void>>;
  resume(itemKey: string, profileId?: string): Promise<Result<void>>;
  cancel(itemKey: string, profileId?: string): Promise<Result<void>>;
  remove(itemKey: string, profileId?: string): Promise<Result<void>>;
  notifyOnlinePlaybackActive?(active: boolean): Promise<void> | void;
  subscribe(listener: (records: readonly DownloadRecord[]) => void): () => void;
}

const VALID_DOWNLOAD_STATUSES: ReadonlySet<string> = new Set<DownloadStatus>([
  'queued',
  'downloading',
  'paused',
  'completed',
  'failed',
  'canceled',
]);

const MAX_MANAGED_FILE_NAME_LENGTH = 200;

/** Type guard returning `true` only for allowed offline VOD media kinds (`'movie' | 'episode'`). */
export function isDownloadMediaKind(v: unknown): v is DownloadMediaKind {
  return v === 'movie' || v === 'episode';
}

/** Type guard returning `true` for a recognized {@link DownloadStatus}. */
export function isDownloadStatus(v: unknown): v is DownloadStatus {
  return typeof v === 'string' && VALID_DOWNLOAD_STATUSES.has(v);
}

/**
 * Validates that `name` is a single safe basename inside the managed downloads directory:
 * rejects path separators (`/`, `\`), traversal (`..`), control characters, leading dots or
 * surrounding whitespace, and requires an extension from {@link ALLOWED_DOWNLOAD_EXTENSIONS}.
 */
export function isValidManagedDownloadFileName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_MANAGED_FILE_NAME_LENGTH) {
    return false;
  }
  if (name !== name.trim() || name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  const lower = name.toLowerCase();
  const matchedExt = ALLOWED_DOWNLOAD_EXTENSIONS.find((ext) => lower.endsWith(ext));
  if (matchedExt === undefined) return false;
  const stem = name.slice(0, name.length - matchedExt.length);
  return stem.length > 0 && !stem.endsWith('.');
}

/**
 * Computes a clamped `[0, 1]` download progress ratio, or `null` when `totalBytes` is unknown
 * or non-positive.
 */
export function computeDownloadProgressRatio(
  bytesDownloaded: number,
  totalBytes: number | null | undefined,
): number | null {
  if (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return null;
  }
  if (!Number.isFinite(bytesDownloaded) || bytesDownloaded <= 0) return 0;
  return Math.min(1, bytesDownloaded / totalBytes);
}

/** Formats a non-negative byte count into a compact human-readable label (`B`, `KB`, `MB`, `GB`). */
export function formatDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes < kb) return `${Math.floor(bytes)} B`;
  if (bytes < mb) return `${(bytes / kb).toFixed(1)} KB`;
  if (bytes < gb) return `${(bytes / mb).toFixed(1)} MB`;
  return `${(bytes / gb).toFixed(2)} GB`;
}

/** Returns `true` when `record` is a completed VOD download with a non-empty local URI. */
export function isPlayableDownload(
  record: Pick<DownloadRecord, 'status' | 'localUri' | 'kind'> | null | undefined,
): boolean {
  if (record === null || record === undefined) return false;
  return (
    isDownloadMediaKind(record.kind) &&
    record.status === 'completed' &&
    typeof record.localUri === 'string' &&
    record.localUri.trim().length > 0
  );
}

/** Returns `true` when `status` represents an in-flight download (`queued`, `downloading`, `paused`). */
export function isActiveDownloadStatus(status: DownloadStatus): boolean {
  return status === 'queued' || status === 'downloading' || status === 'paused';
}
