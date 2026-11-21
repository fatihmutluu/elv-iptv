import { elvError, err, type Result, type SqlDriver } from '@elv/domain';
import type { ImportSummary } from './import-types';

interface AbortBindable {
  setAbortSignal?: (signal: AbortSignal | undefined) => void;
}

interface ActiveImport {
  readonly sourceId: string;
  readonly abort: () => void;
  readonly settled: Promise<void>;
}

function turnOrAbort(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) return previous.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    });
  });
}

/** @internal Serializes catalog & guide imports per service with abort, `removeSource`, and `close()` safety. */
export interface SerializedImportQueue {
  run(
    sourceId: string,
    kind: 'catalog' | 'guide',
    signal: AbortSignal | undefined,
    task: (runSignal: AbortSignal) => Promise<Result<ImportSummary>>,
    hooks?: {
      onStart?: () => void;
      onFinally?: () => void;
      onSettled?: () => Promise<void> | void;
    },
  ): Promise<Result<ImportSummary>>;
  markRemoving(sourceId: string): void;
  unmarkRemoving(sourceId: string): void;
  abortForSource(sourceId: string): Promise<void>;
  close(): Promise<void>;
}

/** @internal Builds a serialized import queue shared by `importSource` and `importGuide`. */
export function createSerializedImportQueue(db: SqlDriver): SerializedImportQueue {
  const abortable = db as SqlDriver & AbortBindable;
  const activeImports = new Map<string, ActiveImport>();
  const removing = new Set<string>();
  let lastImport: Promise<void> = Promise.resolve();
  let closed = false;

  return {
    async run(sourceId, kind, callerSignal, task, hooks) {
      if (closed) return err(elvError('network', 'aborted'));
      if (removing.has(sourceId)) return err(elvError('storage', 'source-not-found'));
      const key = `${kind}:${sourceId}`;
      if (activeImports.has(key)) return err(elvError('storage', 'import-in-progress'));

      const runCtl = new AbortController();
      const onCallerAbort = () => runCtl.abort();
      if (callerSignal?.aborted) runCtl.abort();
      else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

      let running = false;
      let started = false;
      const previous = lastImport;
      let finished!: () => void;
      const mine = new Promise<void>((resolve) => {
        finished = resolve;
      });
      lastImport = previous.then(() => mine);

      let internallyAborted = false;
      activeImports.set(key, {
        sourceId,
        abort: () => {
          if (internallyAborted) return;
          internallyAborted = true;
          runCtl.abort();
          if (running) abortable.setAbortSignal?.(runCtl.signal);
        },
        settled: mine,
      });

      try {
        if (!(await turnOrAbort(previous, runCtl.signal))) {
          return err(elvError('network', 'aborted'));
        }
        started = true;
        hooks?.onStart?.();
        running = true;
        abortable.setAbortSignal?.(internallyAborted ? runCtl.signal : callerSignal);
        try {
          return await task(runCtl.signal);
        } finally {
          running = false;
          hooks?.onFinally?.();
          abortable.setAbortSignal?.(undefined);
        }
      } finally {
        callerSignal?.removeEventListener('abort', onCallerAbort);
        activeImports.delete(key);
        try {
          if (started && !closed) await hooks?.onSettled?.();
        } finally {
          finished();
        }
      }
    },

    markRemoving(sourceId) {
      removing.add(sourceId);
    },

    unmarkRemoving(sourceId) {
      removing.delete(sourceId);
    },

    async abortForSource(sourceId) {
      const matching = [...activeImports.values()].filter((a) => a.sourceId === sourceId);
      for (const active of matching) active.abort();
      await Promise.all(matching.map((a) => a.settled));
    },

    async close() {
      closed = true;
      for (const active of activeImports.values()) active.abort();
      await lastImport;
    },
  };
}
