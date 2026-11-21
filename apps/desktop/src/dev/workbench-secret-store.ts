import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SecretStore } from '@elv/domain';

const SECRET_KEY_RE = /^[A-Za-z0-9:._-]{1,160}$/;

function assertKey(key: string): void {
  if (!SECRET_KEY_RE.test(key)) {
    throw new Error('invalid workbench secret key');
  }
}

function readEntries(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string') {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeEntriesAtomic(filePath: string, entries: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = `${JSON.stringify(entries, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Best-effort permission tightening (Windows ignores POSIX modes).
    }
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors when atomic write fails.
    }
    throw error;
  }
}

/**
 * Dev-only local file-backed {@link SecretStore} persisting entries to `<dataDir>/secrets.json`.
 * Never stored in `catalog.db`, never committed to git, and never shipped in production bundles.
 */
export function createWorkbenchSecretStore(dataDir: string): SecretStore {
  const filePath = join(dataDir, 'secrets.json');
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(job: () => T): Promise<T> => {
    const next = queue.then(job);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    async get(key) {
      assertKey(key);
      return serialize(() => {
        const entries = readEntries(filePath);
        return Object.hasOwn(entries, key) ? entries[key] : undefined;
      });
    },

    async set(key, value) {
      assertKey(key);
      return serialize(() => {
        const entries = readEntries(filePath);
        entries[key] = value;
        writeEntriesAtomic(filePath, entries);
      });
    },

    async delete(key) {
      assertKey(key);
      return serialize(() => {
        const entries = readEntries(filePath);
        if (!Object.hasOwn(entries, key)) return;
        delete entries[key];
        writeEntriesAtomic(filePath, entries);
      });
    },
  };
}
