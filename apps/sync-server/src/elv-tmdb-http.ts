import type { ElvFetchFn, ElvSubrequestBudget } from './elv-types.ts';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT_MS = 4_500;

/** Default Web Standard `fetch` implementation used by TMDB helpers. */
export function defaultTmdbFetchFn(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/** Narrows an unknown JSON value into a plain key-value record. */
export function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

async function readBoundedResponsePrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Issues one timeout- and byte-bounded TMDB v3 JSON GET request while charging the shared budget. */
export async function fetchTmdbJson(
  path: string,
  params: Record<string, string>,
  tmdbApiKey: string,
  fetchFn: ElvFetchFn,
  maxBytes: number,
  budget?: ElvSubrequestBudget,
  counter?: { count: number; budgetExhausted?: boolean },
): Promise<unknown> {
  const key = tmdbApiKey.trim();
  if (!key) return null;
  if (budget && !budget.tryConsume(1)) {
    if (counter) counter.budgetExhausted = true;
    return null;
  }
  if (counter) counter.count += 1;

  const isBearerToken = key.includes('.') || key.length > 40;
  const search = new URLSearchParams(params);
  if (!isBearerToken) {
    search.set('api_key', key);
  }
  const url = `${TMDB_API_BASE}${path}?${search.toString()}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isBearerToken) {
    headers.Authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return null;
    const body = await readBoundedResponsePrefix(res, maxBytes);
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
