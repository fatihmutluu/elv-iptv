import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scheduler, SecretStore, SqlDriver } from '@elv/domain';
import Database from 'better-sqlite3';
import { createSyncSqlDriver } from './driver';

/** Opens an in-memory (or file) better-sqlite3 database wrapped as a {@link SqlDriver}. Test helper. */
export function testDb(file = ':memory:'): {
  db: SqlDriver;
  raw: Database.Database;
  close(): void;
} {
  const raw = new Database(file);
  return { db: createSyncSqlDriver(raw), raw, close: () => raw.close() };
}

/** Like {@link testDb} on a throwaway file database (needed for WAL); `close` also deletes the files. Test helper. */
export function tempFileDb(): ReturnType<typeof testDb> {
  const dir = mkdtempSync(join(tmpdir(), 'elv-data-'));
  const t = testDb(join(dir, 'catalog.db'));
  return {
    ...t,
    close: () => {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Size in bytes of a file, 0 when it does not exist. Test helper. */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** In-memory {@link SecretStore} that can dump its content for assertions. Test helper. */
export function memorySecrets(): SecretStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

/** {@link Scheduler} that counts how often it was asked to yield. Test helper. */
export function countingScheduler(): Scheduler & { readonly count: number } {
  let count = 0;
  return {
    get count() {
      return count;
    },
    yieldNow: async () => {
      count += 1;
    },
  };
}
