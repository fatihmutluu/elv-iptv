import { appendFileSync } from 'node:fs';

/** One served request as the simulator records it. */
export interface LogEntry {
  t: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  status: number;
  bytes: number;
  ms: number;
  account: string | null;
  streamId: number | null;
  recipe: string | null;
  fault: string | null;
  faultRule: string | null;
  openConnections: number;
}

const MASK = '***';
const PASSWORD_PARAM = /(password=)[^&#\s]*/gi;
const USERINFO = /(\/\/[^/:@\s]+:)[^@/\s]+@/g;

const STREAM_PATH = /(\/(?:live|movie|series|timeshift)\/[^/\s?#]+\/)[^/\s?#]+(?=\/)/g;
const SHORT_PATH = /(\/[^/\s?#:]+\/)[^/\s?#]+(?=\/\d+(?:$|[\s?#&]))/g;

function clean(text: string): string {
  return text
    .replace(USERINFO, `$1${MASK}@`)
    .replace(PASSWORD_PARAM, `$1${MASK}`)
    .replace(STREAM_PATH, `$1${MASK}`)
    .replace(SHORT_PATH, `$1${MASK}`);
}

/**
 * Returns a copy with secrets masked: `password` query values, `password=` values in any string, the password
 * segment of Xtream stream paths (`/live|movie|series|timeshift/<user>/<secret>/` and the short `/<user>/<secret>/<id>`,
 * whatever the username), `user:pass@` userinfo anywhere (referer included) and the whole `authorization`
 * header. Usernames stay visible.
 */
export function redact(entry: LogEntry): LogEntry {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.query)) {
    query[k] = k.toLowerCase() === 'password' ? MASK : clean(v);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.headers)) {
    headers[k] = k.toLowerCase() === 'authorization' ? MASK : clean(v);
  }
  return { ...entry, path: clean(entry.path), query, headers };
}

const MAX_ENTRIES = 10_000;

/** In-memory ring of the last 10,000 entries; also appends JSONL to a file when given one. */
export class RequestLog {
  readonly #entries: LogEntry[] = [];
  #file: string | undefined;

  /** Throws an error naming the path when the log file cannot be opened for appending. */
  constructor(file?: string) {
    this.#file = file;
    if (file === undefined) return;
    try {
      appendFileSync(file, '');
    } catch (error) {
      throw new Error(`sim: cannot write log file "${file}": ${(error as Error).message}`);
    }
  }

  /** Records an entry; callers pass it already redacted. */
  add(e: LogEntry): void {
    this.#entries.push(e);
    if (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
    if (!this.#file) return;
    try {
      appendFileSync(this.#file, `${JSON.stringify(e)}\n`);
    } catch (error) {
      this.#file = undefined;
      process.stderr.write(`sim: log file disabled: ${(error as Error).message}\n`);
    }
  }

  /** A copy of the retained entries, oldest first. */
  list(): LogEntry[] {
    return [...this.#entries];
  }

  /** Forgets the in-memory entries; the file is left alone. */
  clear(): void {
    this.#entries.length = 0;
  }
}
