import type { Decompressor, HttpClient, Scheduler, SecretStore, SqlDriver } from '@elv/domain';

/** Collaborators of an import; every platform capability is injected so the engine stays pure. */
export interface ImportDeps {
  db: SqlDriver;
  http: HttpClient;
  secrets: SecretStore;
  scheduler: Scheduler;
  /** Epoch milliseconds. */
  clock: () => number;
  decompressor?: Decompressor;
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
