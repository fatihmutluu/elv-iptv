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
  /** Overrides the Xtream client's whole-body cap; mainly useful to exercise the per-category fallback. */
  maxBodyBytes?: number;
}

/** Options of one import call. */
export interface ImportOptions {
  /** Aborting ends the run as `cancelled` with `network/aborted`; the previous catalog stays. */
  signal?: AbortSignal;
  /** Advisory; exceptions it throws are ignored and never change the outcome of a run. */
  onProgress?: (p: ImportProgress) => void;
  /** Rows per write batch (default 500); the scheduler yields after every batch. */
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
}

/** Outcome of a successful run. */
export interface ImportSummary {
  runId: number;
  counts: Record<string, number>;
  warnings: number;
  durationMs: number;
}

/** Default rows per write batch. */
export const DEFAULT_BATCH_SIZE = 500;
