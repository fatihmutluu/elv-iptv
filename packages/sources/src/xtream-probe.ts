import { type HttpClient, type HttpRequestOptions, openAsyncIterator } from '@elv/domain';
import { decodeUtf8 } from './utf8';
import type { XtreamClient } from './xtream-types';

/** Live stream container format detected by {@link probeXtreamLiveFormat}. */
export type XtreamLiveFormat = 'ts' | 'm3u8';

/** Options for {@link probeXtreamLiveFormat}. */
export interface XtreamLiveFormatProbeOptions {
  http: HttpClient;
  client: Pick<XtreamClient, 'streamUrl'>;
  streamIds: readonly number[];
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  budgetMs?: number;
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 15_000;
const MAX_PROBE_STREAMS = 2;
const MAX_PROBE_BYTES = 512;
const TS_SYNC_BYTE = 0x47;
const TS_STRIDES: readonly number[] = [188, 192, 204];
const CANDIDATE_FORMATS: readonly XtreamLiveFormat[] = ['ts', 'm3u8'];
const HTML_PREFIX_RE = /^(?:<!doctype\b|<html\b|<head\b|<body\b|<title\b)/i;
const HLS_TAG_LINE_RE = /(?:^|[\r\n])\s*#EXT-X-/i;

function pickStreamIds(streamIds: readonly number[]): number[] {
  const picked: number[] = [];
  for (const id of streamIds) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (picked.includes(id)) continue;
    picked.push(id);
    if (picked.length >= MAX_PROBE_STREAMS) break;
  }
  return picked;
}

function hasBinaryControlByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
      return true;
    }
  }
  return false;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      i++;
      continue;
    }
    let need = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
    } else {
      return false;
    }
    if (i + need >= bytes.length) return false;
    i++;
    for (let k = 0; k < need; k++) {
      const c = bytes[i] as number;
      if (c < lower || c > upper) return false;
      lower = 0x80;
      upper = 0xbf;
      i++;
    }
  }
  return true;
}

function matchesTsCadence(bytes: Uint8Array, stride: number, offset: number): boolean {
  let hits = 0;
  for (let pos = offset; pos < bytes.length; pos += stride) {
    if (bytes[pos] !== TS_SYNC_BYTE) return false;
    hits++;
  }
  return hits >= 2;
}

function looksLikeMpegTs(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes.length < 188) {
    if (bytes.length < 4 || bytes[0] !== TS_SYNC_BYTE) return false;
    return hasBinaryControlByte(bytes) || !isValidUtf8(bytes);
  }
  for (const stride of TS_STRIDES) {
    if (bytes.length > stride && matchesTsCadence(bytes, stride, 0)) return true;
    if (stride === 192 && bytes.length > stride + 4 && matchesTsCadence(bytes, stride, 4)) {
      return true;
    }
  }
  for (const stride of TS_STRIDES) {
    const maxOffset = Math.min(stride - 1, bytes.length - 1 - stride * 2);
    for (let o = 1; o <= maxOffset; o++) {
      if (bytes[o] === TS_SYNC_BYTE && matchesTsCadence(bytes, stride, o)) return true;
    }
  }
  return false;
}

function classifyProbeBytes(bytes: Uint8Array): XtreamLiveFormat | undefined {
  if (bytes.length === 0) return undefined;
  const text = decodeUtf8(bytes)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (HTML_PREFIX_RE.test(text)) return undefined;
  if (text.startsWith('#EXTM3U') || HLS_TAG_LINE_RE.test(text)) {
    return 'm3u8';
  }
  if (looksLikeMpegTs(bytes)) {
    return 'ts';
  }
  return undefined;
}

async function discardProbeBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    const it = openAsyncIterator(body);
    await it.return?.();
  } catch {
    // Best-effort cleanup when discarding a non-2xx probe body.
  }
}

async function readProbeBytes(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  deadline: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  let it: AsyncIterator<Uint8Array> | undefined;
  const buf = new Uint8Array(maxBytes);
  let filled = 0;
  try {
    it = openAsyncIterator(body);
    while (filled < maxBytes) {
      if (signal?.aborted || deadline - now() <= 0) return undefined;
      const step = await it.next();
      if (step.done) break;
      const chunk = step.value;
      if (chunk.length === 0) continue;
      const take = Math.min(chunk.length, maxBytes - filled);
      buf.set(chunk.subarray(0, take), filled);
      filled += take;
    }
  } catch {
    return filled > 0 ? buf.subarray(0, filled) : undefined;
  } finally {
    try {
      await it?.return?.();
    } catch {
      // Best-effort cleanup when abandoning a probe connection early.
    }
  }
  return filled > 0 ? buf.subarray(0, filled) : undefined;
}

/**
 * Probes up to 2 live Xtream stream IDs within `budgetMs` (default 15 s) to auto-detect whether the
 * panel serves MPEG-TS (`ts`) or HLS (`m3u8`). Reads at most 512 bytes per response and closes every
 * response body immediately via `return()` so no connections linger.
 */
export async function probeXtreamLiveFormat(
  options: XtreamLiveFormatProbeOptions,
): Promise<XtreamLiveFormat | undefined> {
  const { http, client, headers, signal } = options;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  if (signal?.aborted || budgetMs <= 0) return undefined;

  const ids = pickStreamIds(options.streamIds);
  if (ids.length === 0) return undefined;

  const deadline = now() + budgetMs;
  for (const streamId of ids) {
    for (const ext of CANDIDATE_FORMATS) {
      const remaining = deadline - now();
      if (signal?.aborted || remaining <= 0) return undefined;
      const url = client.streamUrl('live', streamId, ext);
      const reqOpts: HttpRequestOptions = {
        timeoutMs: remaining,
        idleTimeoutMs: remaining,
        ...(headers === undefined ? {} : { headers }),
        ...(signal === undefined ? {} : { signal }),
      };
      let res: Awaited<ReturnType<HttpClient['get']>>;
      try {
        res = await http.get(url, reqOpts);
      } catch {
        if (signal?.aborted) return undefined;
        continue;
      }
      if (!res.ok) {
        if (signal?.aborted) return undefined;
        continue;
      }
      if (res.value.status < 200 || res.value.status >= 300) {
        await discardProbeBody(res.value.body);
        continue;
      }
      const sample = await readProbeBytes(res.value.body, MAX_PROBE_BYTES, deadline, now, signal);
      if (signal?.aborted || deadline - now() <= 0) return undefined;
      if (sample === undefined) continue;
      const detected = classifyProbeBytes(sample);
      if (detected !== undefined) return detected;
    }
  }
  return undefined;
}
