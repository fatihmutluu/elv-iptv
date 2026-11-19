import { elvError, err, ok, type Result } from '@elv/domain';
import { detectAndDecodeText, normalizeBomChunks } from './encoding';
import { dict, newEntry, parseAttrs, parseExtinf } from './m3u-attrs';
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
import { ByteBuffer } from './utf8';

export type { KindHint, M3uBatch, M3uCatchup, M3uEntry, M3uHeader } from './m3u-types';

const LF = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const MAX_LINE = 1 << 20;
const DEFAULT_BATCH = 500;

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
  readonly buf = new ByteBuffer();
  batch: M3uEntry[] = [];
  header: M3uHeader | undefined;
  hlsDetected = false;
  private pending: M3uEntry | undefined;
  private pendingLine = 0;
  private scanned = 0;
  private skipLf = false;
  private discarding = false;
  private first = true;
  private sawFirstNonEmpty = false;
  private captiveHtml = false;

  private readonly batchSize: number;
  private readonly baseUrl: string | undefined;

  constructor(batchSize: number, baseUrl: string | undefined) {
    this.batchSize = batchSize;
    this.baseUrl = baseUrl;
  }

  run(final: boolean): void {
    const bytes = this.buf.view;
    const len = bytes.length;
    let pos = 0;
    while (this.batch.length < this.batchSize && !this.hlsDetected) {
      if (this.skipLf && pos < len) {
        if (bytes[pos] === LF) pos++;
        this.skipLf = false;
      }
      let i = pos + this.scanned;
      while (i < len) {
        const b = bytes[i] as number;
        if (b === LF || b === CR) break;
        i++;
      }
      if (i >= len) {
        if (this.discarding) {
          pos = len;
          this.scanned = 0;
        } else if (len - pos > MAX_LINE) {
          this.tooLong();
          this.discarding = true;
          pos = len;
          this.scanned = 0;
        } else if (final && pos < len) {
          this.line(bytes, pos, len);
          pos = len;
          this.scanned = 0;
        } else {
          this.scanned = len - pos;
        }
        break;
      }
      if (this.discarding) this.discarding = false;
      else if (i - pos > MAX_LINE) this.tooLong();
      else this.line(bytes, pos, i);
      this.scanned = 0;
      pos = i + 1;
      if (bytes[i] === CR) {
        if (pos < len) {
          if (bytes[pos] === LF) pos++;
        } else this.skipLf = true;
      }
    }
    this.buf.consume(pos);
  }

  private tooLong(): void {
    this.stats.lines++;
    this.stats.skipped++;
    this.pending = undefined;
    warn(this.stats, 'line-too-long', this.stats.lines);
  }

  finish(): void {
    if (this.pending) {
      this.stats.skipped++;
      warn(this.stats, 'extinf-without-url', this.pendingLine);
      this.pending = undefined;
    }
  }

  private line(bytes: Uint8Array, rawStart: number, rawEnd: number): void {
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
          this.stats.skipped++;
          warn(this.stats, 'not-a-url', this.stats.lines);
          return;
        }
      }
      if (looksLikeUrl(raw, this.baseUrl)) this.url(raw);
      else {
        this.stats.skipped++;
        warn(this.stats, 'not-a-url', this.stats.lines);
      }
      return;
    }

    this.sawFirstNonEmpty = true;
    if (isHlsManifestTag(bytes, start, end)) {
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
      const issues = { rawQuote: false };
      this.pending = parseExtinf(payload, issues);
      this.pendingLine = this.stats.lines;
      if (issues.rawQuote) warn(this.stats, 'attr-quote', this.pendingLine);
    } else if (d === 1) {
      this.header ??= this.parseHeader(payload);
    } else if (this.pending) {
      this.directive(this.pending, d, payload);
    }
  }

  private directive(e: M3uEntry, d: number, payload: string): void {
    if (d === 2) {
      if (e.groups.length === 0 && payload.trim()) e.groups.push(payload.trim());
    } else if (d === 3 || d === 4) {
      applyVlcOpt(e, payload);
    } else if (d === 5) {
      if (!applyExtHttp(e, payload)) warn(this.stats, 'exthttp-malformed', this.stats.lines);
    } else {
      applyKodiProp(e, payload);
    }
  }

  private parseHeader(payload: string): M3uHeader {
    const header: M3uHeader = { present: true, guideUrls: [], attrs: dict() };
    parseAttrs(payload, 0, (key, value) => {
      if (key === 'url-tvg' || key === 'x-tvg-url') {
        header.guideUrls.push(...splitGuideUrls(value));
      } else header.attrs[key] = value;
    });
    return header;
  }

  private url(raw: string): void {
    const e = this.pending ?? newEntry();
    if (!this.pending) e.name = raw;
    this.pending = undefined;
    finishEntry(e, raw, this.baseUrl);
    if (e.name === raw) e.name = e.url;
    this.stats.entries++;
    this.batch.push(e);
  }
}

/**
 * Streams an M3U/M3U8 playlist from byte chunks into typed entries in bounded memory.
 * Rejects HLS media/master manifests (`#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE`,
 * `#EXT-X-STREAM-INF`) with `source-format` / `hls-manifest`.
 */
export async function* scanM3u(
  chunks: AsyncIterable<Uint8Array>,
  opts?: { batchSize?: number; baseUrl?: string | undefined },
): AsyncGenerator<M3uBatch, Result<void>> {
  const size = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH);
  const scanner = new M3uScanner(size, opts?.baseUrl);
  try {
    for await (const chunk of normalizeBomChunks(chunks)) {
      scanner.buf.append(chunk);
      for (;;) {
        scanner.run(false);
        if (scanner.hlsDetected) return err(elvError('source-format', 'hls-manifest'));
        if (scanner.batch.length < size) break;
        const entries = scanner.batch;
        scanner.batch = [];
        yield { entries, done: false };
      }
    }
  } catch (e) {
    return err(toElvError(e));
  }
  for (;;) {
    scanner.run(true);
    if (scanner.hlsDetected) return err(elvError('source-format', 'hls-manifest'));
    if (scanner.batch.length < size) break;
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
