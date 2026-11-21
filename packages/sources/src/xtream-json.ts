import { elvError, err, type HttpClient, ok, type Result } from '@elv/domain';
import type { XtreamRateLimitOptions } from './xtream-types';

const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const HEX2_RE = /^[0-9a-fA-F]{2}$/;
const DEFAULT_BURST = 20;
const DEFAULT_RATE_PER_SEC = 10;

interface HostBucket {
  tokens: number;
  lastMs: number;
  chain: Promise<void>;
}

const BUCKETS_BY_CLIENT = new WeakMap<HttpClient, Map<string, HostBucket>>();

function repairJsonStringsAndCommas(input: string): string {
  let out = '';
  let inString = false;
  const n = input.length;

  for (let i = 0; i < n; i++) {
    const ch = input[i] as string;
    const code = input.charCodeAt(i);

    if (!inString) {
      if (ch === '"') {
        inString = true;
        out += ch;
        continue;
      }
      if (ch === ',') {
        let j = i + 1;
        while (j < n && input.charCodeAt(j) <= 0x20) j++;
        const next = j < n ? input[j] : '';
        if (next === '}' || next === ']') continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }

    if (code <= 0x1f) {
      if (code === 0x0a) out += '\\n';
      else if (code === 0x0d) out += '\\r';
      else if (code === 0x09) out += '\\t';
      continue;
    }

    if (ch !== '\\') {
      out += ch;
      continue;
    }

    if (i + 1 >= n) break;
    const esc = input[i + 1] as string;
    if (
      esc === '"' ||
      esc === '\\' ||
      esc === '/' ||
      esc === 'b' ||
      esc === 'f' ||
      esc === 'n' ||
      esc === 'r' ||
      esc === 't'
    ) {
      out += `\\${esc}`;
      i++;
      continue;
    }
    if (esc === "'") {
      out += "'";
      i++;
      continue;
    }
    if (esc === 'x' && i + 3 < n) {
      const hex2 = input.slice(i + 2, i + 4);
      if (HEX2_RE.test(hex2)) {
        out += `\\u00${hex2}`;
        i += 3;
        continue;
      }
    }
    if (esc === 'u' && i + 5 < n) {
      const hex4 = input.slice(i + 2, i + 6);
      if (HEX4_RE.test(hex4)) {
        const unit = Number.parseInt(hex4, 16);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (i + 11 < n && input[i + 6] === '\\' && input[i + 7] === 'u') {
            const lowHex = input.slice(i + 8, i + 12);
            if (HEX4_RE.test(lowHex)) {
              const low = Number.parseInt(lowHex, 16);
              if (low >= 0xdc00 && low <= 0xdfff) {
                out += `\\u${hex4}\\u${lowHex}`;
                i += 11;
                continue;
              }
            }
          }
          out += '\\ufffd';
          i += 5;
          continue;
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          out += '\\ufffd';
          i += 5;
          continue;
        }
        out += `\\u${hex4}`;
        i += 5;
        continue;
      }
    }
    out += `\\\\${esc}`;
    i++;
  }

  return out;
}

function recoverTruncatedTopArray(repaired: string): string | undefined {
  if (!repaired.startsWith('[')) return undefined;
  let depth = 0;
  let inString = false;
  let lastTopObjectEnd = -1;

  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i] as string;
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1 && ch === '}') lastTopObjectEnd = i;
      if (depth <= 0) break;
    }
  }

  return lastTopObjectEnd > 0 ? `${repaired.slice(0, lastTopObjectEnd + 1)}]` : undefined;
}

/**
 * Strips leading BOM, fast-paths `JSON.parse`, and falls back to resilient PHP JSON recovery
 * (bad escapes, lone surrogates, trailing commas, and truncated array tails) (`#216`).
 */
export function parseXtreamJson(rawText: string): Result<unknown> {
  const trimmed = (rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText).trim();
  if (trimmed.length === 0 || trimmed.startsWith('<')) {
    return err(elvError('source-format', 'invalid-json'));
  }
  try {
    return ok(JSON.parse(trimmed));
  } catch {
    const first = trimmed[0];
    if (first !== '{' && first !== '[') {
      return err(elvError('source-format', 'invalid-json'));
    }
    const repaired = repairJsonStringsAndCommas(trimmed);
    try {
      return ok(JSON.parse(repaired));
    } catch {
      const salvaged = recoverTruncatedTopArray(repaired);
      if (salvaged !== undefined) {
        try {
          return ok(JSON.parse(salvaged));
        } catch {
          // Fall through to invalid-json
        }
      }
      return err(elvError('source-format', 'invalid-json'));
    }
  }
}

interface RuntimeTimers {
  performance?: { now?: () => number };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

const RUNTIME = globalThis as unknown as RuntimeTimers;
let monotonicFloor = 0;

function defaultNow(): number {
  if (typeof RUNTIME.performance?.now === 'function') return RUNTIME.performance.now();
  const wall = Date.now();
  if (wall > monotonicFloor) monotonicFloor = wall;
  return monotonicFloor;
}

/** Resolves the monotonic clock function from optional `rateLimit` settings. */
export function resolveNowFn(options: XtreamRateLimitOptions | false | undefined): () => number {
  return options !== false && options?.now !== undefined ? options.now : defaultNow;
}

function hostKeyOf(baseUrl: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(baseUrl);
  return (m?.[1] ?? baseUrl).toLowerCase();
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }
  const setTimer = RUNTIME.setTimeout;
  if (typeof setTimer !== 'function') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      RUNTIME.clearTimeout?.(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Acquires 1 token from the monotonic-clock per-host token bucket shared across clients using `http` (`#315`).
 */
export async function acquireXtreamToken(
  http: HttpClient,
  baseUrl: string,
  options: XtreamRateLimitOptions | false | undefined,
  signal?: AbortSignal,
): Promise<Result<void>> {
  if (signal?.aborted) return err(elvError('network', 'aborted'));
  if (options === false) return ok(undefined);

  const burst = Math.max(1, options?.burst ?? DEFAULT_BURST);
  const ratePerSec = Math.max(0.1, options?.ratePerSec ?? DEFAULT_RATE_PER_SEC);
  const nowFn = options?.now ?? defaultNow;
  const sleepFn = options?.sleep ?? defaultSleep;

  let map = BUCKETS_BY_CLIENT.get(http);
  if (map === undefined) {
    map = new Map<string, HostBucket>();
    BUCKETS_BY_CLIENT.set(http, map);
  }
  const key = hostKeyOf(baseUrl);
  let bucket = map.get(key);
  if (bucket === undefined) {
    bucket = { tokens: burst, lastMs: nowFn(), chain: Promise.resolve() };
    map.set(key, bucket);
  }

  const run = async (): Promise<void> => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const now = nowFn();
    const elapsed = Math.max(0, now - bucket.lastMs);
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1000) * ratePerSec);
    bucket.lastMs = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - bucket.tokens) / ratePerSec) * 1000);
    await sleepFn(waitMs, signal);
    bucket.lastMs = nowFn();
    bucket.tokens = 0;
  };

  const ticket = bucket.chain.then(run, run);
  bucket.chain = ticket.catch(() => {});
  try {
    await ticket;
    return ok(undefined);
  } catch {
    return err(elvError('network', 'aborted'));
  }
}
