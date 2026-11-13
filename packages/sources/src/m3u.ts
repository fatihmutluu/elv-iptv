import {
  applyExtHttp,
  applyKodiProp,
  applyVlcOpt,
  finishEntry,
  newEntry,
  parseAttrs,
  parseExtinf,
} from './m3u-attrs';
import type { M3uBatch, M3uEntry, M3uHeader } from './m3u-types';
import { createStats, type ScanStats, warn } from './stats';
import { ByteBuffer, decodeUtf8 } from './utf8';

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
  '#EXTHTTP:',
  '#KODIPROP:',
] as const;

/** Index of the directive in DIRECTIVES that the line starts with (case-insensitive), or -1. */
function directiveAt(bytes: Uint8Array, start: number, end: number): number {
  for (let d = 0; d < DIRECTIVES.length; d++) {
    const name = DIRECTIVES[d] as string;
    if (end - start < name.length) continue;
    let ok = true;
    for (let k = 1; k < name.length; k++) {
      let b = bytes[start + k] as number;
      if (b >= 97 && b <= 122) b -= 32;
      if (b !== name.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) return d;
  }
  return -1;
}

class M3uScanner {
  readonly stats: ScanStats = createStats();
  readonly buf = new ByteBuffer();
  batch: M3uEntry[] = [];
  header: M3uHeader | undefined;
  private pending: M3uEntry | undefined;
  private pendingLine = 0;
  private scanned = 0;
  private skipLf = false;
  private discarding = false;
  private first = true;

  private readonly batchSize: number;
  private readonly baseUrl: string | undefined;

  constructor(batchSize: number, baseUrl: string | undefined) {
    this.batchSize = batchSize;
    this.baseUrl = baseUrl;
  }

  /** Processes complete lines (all remaining ones when `final`) until the batch is full or input runs out. */
  run(final: boolean): void {
    const bytes = this.buf.view;
    const len = bytes.length;
    let pos = 0;
    while (this.batch.length < this.batchSize) {
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
    if (bytes[start] !== 0x23) {
      this.url(decodeUtf8(bytes, start, end));
      return;
    }
    const d = directiveAt(bytes, start, end);
    if (d < 0) return;
    const text = decodeUtf8(bytes, start, end);
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
    } else if (d === 3) applyVlcOpt(e, payload);
    else if (d === 4) {
      if (!applyExtHttp(e, payload)) warn(this.stats, 'exthttp-malformed', this.stats.lines);
    } else applyKodiProp(e, payload);
  }

  private parseHeader(payload: string): M3uHeader {
    const header: M3uHeader = { guideUrls: [], attrs: {} };
    parseAttrs(payload, 0, (key, value) => {
      if (key === 'url-tvg' || key === 'x-tvg-url') {
        for (const u of value.split(',')) {
          const t = u.trim();
          if (t) header.guideUrls.push(t);
        }
      } else header.attrs[key] = value;
    });
    return header;
  }

  private url(raw: string): void {
    const e = this.pending ?? newEntry();
    if (!this.pending) e.name = raw;
    this.pending = undefined;
    finishEntry(e, raw, this.baseUrl);
    this.stats.entries++;
    this.batch.push(e);
  }
}

/**
 * Streams an M3U/M3U8 playlist from byte chunks into typed entries in bounded memory. Never throws on bad
 * content: problems become warnings in the final batch's statistics. A batch is yielded as soon as it holds
 * `batchSize` entries (default 500); the last batch has `done: true`, the header (empty when the playlist has
 * no `#EXTM3U` line) and the statistics. Relative URLs are resolved against `baseUrl` when given.
 */
export async function* scanM3u(
  chunks: AsyncIterable<Uint8Array>,
  opts?: { batchSize?: number; baseUrl?: string | undefined },
): AsyncGenerator<M3uBatch> {
  const size = Math.max(1, opts?.batchSize ?? DEFAULT_BATCH);
  const scanner = new M3uScanner(size, opts?.baseUrl);
  for await (const chunk of chunks) {
    scanner.buf.append(chunk);
    do {
      scanner.run(false);
      if (scanner.batch.length >= size) {
        const entries = scanner.batch;
        scanner.batch = [];
        yield { entries, done: false };
      }
    } while (scanner.batch.length >= size);
  }
  for (;;) {
    scanner.run(true);
    if (scanner.batch.length < size) break;
    const entries = scanner.batch;
    scanner.batch = [];
    yield { entries, done: false };
  }
  scanner.finish();
  yield {
    entries: scanner.batch,
    header: scanner.header ?? { guideUrls: [], attrs: {} },
    stats: scanner.stats,
    done: true,
  };
}
