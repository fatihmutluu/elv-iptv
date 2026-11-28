import { type Decompressor, elvError, err, ok, type Result } from '@elv/domain';
import { detectAndDecodeText, normalizeBomChunks } from './encoding';
import { decodeMaybeGzip } from './gzip-stream';
import { dict, newEntry, parseAttrs, parseExtinf } from './m3u-attrs';
import { M3uLineAccumulator } from './m3u-logo-filter';
import type { M3uBatch, M3uEntry, M3uHeader } from './m3u-types';
import {
  applyExtHttp,
  applyKodiProp,
  applyVlcOpt,
  finishEntry,
  looksLikeUrl,
  splitGuideUrls,
} from './m3u-url';
import { toElvError } from './scan-error';
import { createStats, type ScanStats, warn } from './stats';

export type { KindHint, M3uBatch, M3uCatchup, M3uEntry, M3uHeader } from './m3u-types';

const SPACE = 32;
const TAB = 9;
const DEFAULT_BATCH = 500;
const MAX_PRE_DIRECTIVES = 64;
const HTTP_GUIDE_URL_RE = /^https?:\/\/[^/\s?#]+/i;

interface QueuedDirective {
  readonly d: number;
  readonly payload: string;
  readonly line: number;
}

const DIRECTIVES = [
  '#EXTINF:',
  '#EXTM3U',
  '#EXTGRP:',
  '#EXTVLCOPT:',
  '#EXTVLCOPT--',
  '#EXTHTTP:',
  '#KODIPROP:',
] as const;

const HLS_MANIFEST_TAGS = [
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-STREAM-INF',
] as const;

const CAPTIVE_HTML_RE = /^(?:<!doctype\s+html|<html\b|<head\b|<script\b|<body\b)/i;

function startsWithAsciiCaseInsensitive(
  bytes: Uint8Array,
  start: number,
  end: number,
  prefix: string,
): boolean {
  if (end - start < prefix.length) return false;
  for (let k = 0; k < prefix.length; k++) {
    let b = bytes[start + k] as number;
    if (b >= 97 && b <= 122) b -= 32;
    if (b !== prefix.charCodeAt(k)) return false;
  }
  return true;
}

function directiveAt(bytes: Uint8Array, start: number, end: number): number {
  for (let d = 0; d < DIRECTIVES.length; d++) {
    if (startsWithAsciiCaseInsensitive(bytes, start, end, DIRECTIVES[d] as string)) return d;
  }
  return -1;
}

function isHlsManifestTag(bytes: Uint8Array, start: number, end: number): boolean {
  for (const tag of HLS_MANIFEST_TAGS) {
    if (startsWithAsciiCaseInsensitive(bytes, start, end, tag)) {
      const next = start + tag.length < end ? (bytes[start + tag.length] as number) : 58;
      if (next === 58 || next <= SPACE) return true;
    }
  }
  return false;
}

class M3uScanner {
  readonly stats: ScanStats = createStats();
  batch: M3uEntry[] = [];
  header: M3uHeader | undefined;
  hlsDetected = false;
  private readonly lines = new M3uLineAccumulator();
  private pending: M3uEntry | undefined;
  private pendingLine = 0;
  private readonly preDirectives: QueuedDirective[] = [];
  private first = true;
  private sawFirstNonEmpty = false;
  private captiveHtml = false;

  private readonly batchSize: number;
  private readonly baseUrl: string | undefined;

  private readonly onLine = (
    bytes: Uint8Array,
    start: number,
    end: number,
    inlineLogoStripped: boolean,
  ): void => {
    this.line(bytes, start, end, inlineLogoStripped);
  };

  private readonly onTooLong = (): void => {
    this.tooLong();
  };

  private readonly canContinue = (): boolean =>
    this.batch.length < this.batchSize && !this.hlsDetected;

  constructor(batchSize: number, baseUrl: string | undefined) {
    this.batchSize = batchSize;
    this.baseUrl = baseUrl;
  }

  feed(chunk: Uint8Array, offset: number): number {
    return this.lines.feed(chunk, offset, this.onLine, this.onTooLong, this.canContinue);
  }

  flush(): void {
    this.lines.flush(this.onLine, this.onTooLong);
  }

  private tooLong(): void {
    this.stats.lines++;
    this.stats.skipped++;
    this.pending = undefined;
    this.preDirectives.length = 0;
    warn(this.stats, 'line-too-long', this.stats.lines);
  }

  finish(): void {
    this.preDirectives.length = 0;
    if (this.pending) {
      this.stats.skipped++;
      warn(this.stats, 'extinf-without-url', this.pendingLine);
      this.pending = undefined;
    }
  }

  private line(
    bytes: Uint8Array,
    rawStart: number,
    rawEnd: number,
    inlineLogoStripped: boolean,
  ): void {
    let start = rawStart;
    let end = rawEnd;
    if (this.first) {
      this.first = false;
      if (
        end - start >= 3 &&
        bytes[start] === 0xef &&
        bytes[start + 1] === 0xbb &&
        bytes[start + 2] === 0xbf
      ) {
        start += 3;
      }
    }
    this.stats.lines++;
    while (start < end && ((bytes[start] as number) === SPACE || bytes[start] === TAB)) start++;
    while (end > start && ((bytes[end - 1] as number) === SPACE || bytes[end - 1] === TAB)) end--;
    if (start >= end) return;

    if (this.captiveHtml) {
      this.stats.skipped++;
      warn(this.stats, 'not-a-url', this.stats.lines);
      return;
    }

    if (bytes[start] !== 0x23) {
      const raw = detectAndDecodeText(bytes, start, end);
      if (!this.sawFirstNonEmpty) {
        this.sawFirstNonEmpty = true;
        if (CAPTIVE_HTML_RE.test(raw)) {
          this.captiveHtml = true;
          this.preDirectives.length = 0;
          this.stats.skipped++;
          warn(this.stats, 'not-a-url', this.stats.lines);
          return;
        }
      }
      if (looksLikeUrl(raw, this.baseUrl)) this.url(raw);
      else {
        this.preDirectives.length = 0;
        this.stats.skipped++;
        warn(this.stats, 'not-a-url', this.stats.lines);
      }
      return;
    }

    this.sawFirstNonEmpty = true;
    if (isHlsManifestTag(bytes, start, end)) {
      this.preDirectives.length = 0;
      this.hlsDetected = true;
      return;
    }
    const d = directiveAt(bytes, start, end);
    if (d < 0) return;
    const text = detectAndDecodeText(bytes, start, end);
    const payload = text.slice((DIRECTIVES[d] as string).length);
    if (d === 0) {
      if (this.pending) {
        this.stats.skipped++;
        warn(this.stats, 'extinf-without-url', this.pendingLine);
      }
      const issues = { rawQuote: false, inlineLogoStripped: false };
      this.pending = parseExtinf(payload, issues);
      this.pendingLine = this.stats.lines;
      if (issues.rawQuote) warn(this.stats, 'attr-quote', this.pendingLine);
      if (inlineLogoStripped || issues.inlineLogoStripped) {
        warn(this.stats, 'inline-logo-stripped', this.pendingLine);
      }
      this.flushPreDirectives(this.pending);
    } else if (d === 1) {
      this.preDirectives.length = 0;
      this.header ??= this.parseHeader(payload);
    } else if (this.pending) {
      this.directive(this.pending, d, payload, this.stats.lines);
    } else if (this.preDirectives.length < MAX_PRE_DIRECTIVES) {
      this.preDirectives.push({ d, payload, line: this.stats.lines });
    }
  }

  private flushPreDirectives(e: M3uEntry): void {
    if (this.preDirectives.length === 0) return;
    for (const queued of this.preDirectives) {
      this.directive(e, queued.d, queued.payload, queued.line);
    }
    this.preDirectives.length = 0;
  }

  private directive(e: M3uEntry, d: number, payload: string, line: number): void {
    if (d === 2) {
      if (e.groups.length === 0 && payload.trim()) e.groups.push(payload.trim());
    } else if (d === 3 || d === 4) {
      applyVlcOpt(e, payload);
    } else if (d === 5) {
      if (!applyExtHttp(e, payload)) warn(this.stats, 'exthttp-malformed', line);
    } else {
      applyKodiProp(e, payload);
    }
  }

  private parseHeader(payload: string): M3uHeader {
    const header: M3uHeader = { present: true, guideUrls: [], attrs: dict() };
    parseAttrs(payload, 0, (key, value) => {
      if (key === 'url-tvg' || key === 'x-tvg-url' || key === 'tvg-url') {
        for (const candidate of splitGuideUrls(value)) {
          if (HTTP_GUIDE_URL_RE.test(candidate)) header.guideUrls.push(candidate);
        }
      } else header.attrs[key] = value;
    });
    return header;
  }

  private url(raw: string): void {
    const e = this.pending ?? newEntry();
    if (!this.pending) {
      e.name = raw;
      this.flushPreDirectives(e);
    }
    this.pending = undefined;
    finishEntry(e, raw, this.baseUrl);
    if (e.name === raw) e.name = e.url;
    this.stats.entries++;
    this.batch.push(e);
  }
}

/**
 * Streams an M3U/M3U8 playlist from byte chunks into typed entries in bounded memory.
 * Transparently decompresses gzip (`1f 8b`, including multi-member `.gz`) and xz (`fd 37 7a 58 5a 00`,
 * `.xz`) streams when `decompressor` is provided and rejects HLS media/master manifests with
 * `source-format` / `hls-manifest`.
 */
export async function* scanM3u(
  chunks: AsyncIterable<Uint8Array>,
  opts?: {
    batchSize?: number;
    baseUrl?: string | undefined;
    decompressor?: Decompressor;
    maxDecompressedBytes?: number;
  },
): AsyncGenerator<M3uBatch, Result<void>> {
  const size = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH);
  const scanner = new M3uScanner(size, opts?.baseUrl);
  const decoded = decodeMaybeGzip(chunks, {
    ...(opts?.decompressor === undefined ? {} : { decompressor: opts.decompressor }),
    ...(opts?.maxDecompressedBytes === undefined
      ? {}
      : { maxDecompressedBytes: opts.maxDecompressedBytes }),
  });
  let decodeResult: Result<void> = ok(undefined);
  let decodedExhausted = false;
  async function* decodedChunks(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const step = await decoded.next();
        if (step.done) {
          decodedExhausted = true;
          decodeResult = step.value;
          return;
        }
        yield step.value;
      }
    } finally {
      if (!decodedExhausted) await decoded.return(ok(undefined));
    }
  }
  try {
    for await (const chunk of normalizeBomChunks(decodedChunks())) {
      if (!decodeResult.ok) return decodeResult;
      let offset = 0;
      while (offset < chunk.length) {
        offset = scanner.feed(chunk, offset);
        if (scanner.hlsDetected) return err(elvError('source-format', 'hls-manifest'));
        if (scanner.batch.length < size) continue;
        const entries = scanner.batch;
        scanner.batch = [];
        yield { entries, done: false };
      }
    }
  } catch (e) {
    return err(toElvError(e));
  }
  if (!decodeResult.ok) return decodeResult;
  scanner.flush();
  if (scanner.hlsDetected) return err(elvError('source-format', 'hls-manifest'));
  if (scanner.batch.length >= size) {
    const entries = scanner.batch;
    scanner.batch = [];
    yield { entries, done: false };
  }
  scanner.finish();
  yield {
    entries: scanner.batch,
    header: scanner.header ?? { present: false, guideUrls: [], attrs: dict() },
    stats: scanner.stats,
    done: true,
  };
  return ok(undefined);
}
