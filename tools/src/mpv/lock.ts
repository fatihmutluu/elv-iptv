/** One pinned mpv runtime: an upstream libmpv archive or a CI workflow artifact. */
export type LockEntry =
  | { kind: 'upstream-libmpv'; mpv: string; url: string; sha256: string }
  | {
      kind: 'workflow-artifact';
      mpv: string;
      repo: string;
      runId: number;
      artifact: string;
      file: string;
      sha256: string;
    };

/** Pinned runtimes by `<platform>-<arch>` key. */
export type RuntimeLock = Readonly<Record<string, LockEntry>>;

/** Thrown for a malformed lock file; the message starts with the field path. */
export class LockError extends Error {
  constructor(path: string, problem: string) {
    super(`mpv-runtime.lock.json: ${path} ${problem}`);
    this.name = 'LockError';
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LockError(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v === '')
    throw new LockError(`${path}.${key}`, 'must be a non-empty string');
  return v;
}

function sha(obj: Record<string, unknown>, path: string): string {
  const v = str(obj, 'sha256', path);
  if (!/^[0-9a-f]{64}$/.test(v))
    throw new LockError(`${path}.sha256`, 'must be 64 lowercase hex characters');
  return v;
}

function parseEntry(value: unknown, path: string): LockEntry {
  const o = record(value, path);
  const mpv = str(o, 'mpv', path);
  const kind = o.kind;
  if (kind === 'upstream-libmpv') {
    const url = str(o, 'url', path);
    if (!url.startsWith('https://')) throw new LockError(`${path}.url`, 'must start with https://');
    return { kind, mpv, url, sha256: sha(o, path) };
  }
  if (kind === 'workflow-artifact') {
    const runId = o.runId;
    if (typeof runId !== 'number' || !Number.isInteger(runId) || runId <= 0) {
      throw new LockError(`${path}.runId`, 'must be a positive integer');
    }
    return {
      kind,
      mpv,
      repo: str(o, 'repo', path),
      runId,
      artifact: str(o, 'artifact', path),
      file: str(o, 'file', path),
      sha256: sha(o, path),
    };
  }
  throw new LockError(`${path}.kind`, 'must be upstream-libmpv or workflow-artifact');
}

/** Validates the lock file content; throws {@link LockError} naming the offending field path. */
export function parseLock(json: unknown): RuntimeLock {
  const root = record(json, '$');
  const out: Record<string, LockEntry> = {};
  for (const key of Object.keys(root)) out[key] = parseEntry(root[key], key);
  return out;
}

/** The lock key for a Node platform and architecture, for example `win32-x64`. */
export function runtimeKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
