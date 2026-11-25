import type { Decompressor, HttpClient, Scheduler, SecretStore, SqlDriver } from '@elv/domain';
import type { LocalPlaylistStore } from './sources';

/** Channel metadata returned by a native off-thread XMLTV stager (`#478`). */
export interface NativeGuideChannel {
  readonly id: string;
  readonly names: readonly string[];
  readonly icon?: string;
  readonly lcn?: string;
}

/** Request forwarded to a platform {@link NativeGuideStager} (`#478`). */
export interface NativeGuideStageRequest {
  readonly jobId: string;
  readonly url: string;
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

/** Result returned by a platform {@link NativeGuideStager}; never contains URLs or response bodies. */
export type NativeGuideStageResult =
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
      readonly channels: readonly NativeGuideChannel[];
      readonly stagedCounts: Readonly<Record<string, number>>;
      readonly seenProgrammes: number;
      readonly stagedProgrammes: number;
      readonly warnings: number;
      readonly warningCodes: readonly string[];
      readonly etag?: string;
      readonly lastModified?: string;
    };

/** Optional platform port that streams HTTP(S) XMLTV directly into `programmes_next` off the JS thread (`#478`). */
export interface NativeGuideStager {
  stage(request: NativeGuideStageRequest): Promise<NativeGuideStageResult>;
  cancel?(jobId: string): void;
}

/** Collaborators of an import; every platform capability is injected so the engine stays pure. */
export interface ImportDeps {
  db: SqlDriver;
  http: HttpClient;
  secrets: SecretStore;
  scheduler: Scheduler;
  /** Epoch milliseconds. */
  clock: () => number;
  decompressor?: Decompressor;
  /** Optional native off-thread XMLTV stager used on mobile/TV for HTTP(S) guides (`#478`). */
  nativeGuideStager?: NativeGuideStager;
  /** Optional sandboxed local M3U byte store for local file imports (`#51`). */
  localPlaylistStore?: LocalPlaylistStore;
  /**
   * Largest Xtream response body the client buffers (default 128 MiB). This is the memory and jank control for small
   * devices: one list is parsed from one buffer, so a lower cap bounds both, and a list above it falls back to
   * per-category calls (`source-format/too-large`). A single category or series info still above it is fetched once
   * more without the cap.
   */
  maxBodyBytes?: number;
}

/** Options of one import call. */
export interface ImportOptions {
  /** Aborting ends the run as `cancelled` with `network/aborted`; the previous catalog stays. */
  signal?: AbortSignal;
  /** Advisory; exceptions it throws are ignored and never change the outcome of a run. */
  onProgress?: (p: ImportProgress) => void;
  /** Rows per write batch (default 200); the scheduler yields after every batch. */
  batchSize?: number;
}

/** Progress of one phase; `done` never decreases within a phase. */
export interface ImportProgress {
  phase:
    | 'categories'
    | 'live'
    | 'movies'
    | 'series'
    | 'episodes'
    | 'guide-channels'
    | 'programmes'
    | 'cleanup';
  done: number;
  total?: number;
  /** Optional overall run progress in `[0, 1]`, strictly non-decreasing across the run. */
  fraction?: number;
  /** Optional overall run progress as an integer in `[0, 100]`, strictly non-decreasing across the run (`#65`). */
  readonly percent?: number;
}

/** Outcome of a successful run. */
export interface ImportSummary {
  runId: number;
  counts: Record<string, number>;
  warnings: number;
  /** One `category/code` per warning that is not a plain count; never a URL or a credential. */
  warningCodes: string[];
  durationMs: number;
  /** True when HTTP 304 Not Modified kept all previously stored rows without downloading or rewriting. */
  unchanged?: boolean;
}

/** Default rows per write batch. */
export const DEFAULT_BATCH_SIZE = 200;
