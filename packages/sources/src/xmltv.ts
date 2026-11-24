import { ok, openAsyncIterator, type Result } from '@elv/domain';
import type { XmlEncoding } from './codepages';
import { normalizeBomChunks } from './encoding';
import { decodeMaybeGzip } from './gzip-stream';
import { createStats, MAX_WARNINGS, type ScanStats, warn } from './stats';
import { ByteBuffer } from './utf8';
import {
  BANG,
  BROKEN,
  countLf,
  createMarkupScanCache,
  type DeclResume,
  findClose,
  findGt,
  findTagEnd,
  GT,
  INCOMPLETE,
  isMarkupStart,
  LT,
  type MarkupScanCache,
  matchName,
  nameEnd,
  QUESTION,
  type Resume,
  readAttrs,
  SLASH,
  shiftMarkupCache,
  skipMarkup,
  startsWith,
  type TagResume,
} from './xml-tokens';
import { parseChildren } from './xmltv-children';
import { createLanguageScorer, type LanguageScorer, resolveXmlPrologEncoding } from './xmltv-meta';
import { type ParseXmltvTimeOptions, parseXmltvTime } from './xmltv-time';
import type { XmltvBatch, XmltvChannel, XmltvOptions, XmltvProgramme } from './xmltv-types';

export { parseXmltvTime } from './xmltv-time';
export type { XmltvBatch, XmltvChannel, XmltvOptions, XmltvProgramme } from './xmltv-types';

/** Minimum valid XMLTV programme timestamp (`1990-01-01T00:00:00Z`); earlier epoch placeholders (e.g. `19700101`) are rejected as `programme-bad-time` (`#268`). */
export const MIN_VALID_XMLTV_EPOCH_MS = Date.UTC(1990, 0, 1);

const MAX_ELEMENT = 1 << 20;
const DEFAULT_BATCH = 500;
const TAR_HEADER_BYTES = 512;
const TAR_USTAR_OFFSET = 257;
const NEED = -1;
const PROGRAMME_ATTRS = ['channel', 'start', 'stop'] as const;
const CHANNEL_ATTRS = ['id'] as const;
const ENCODING_ATTR = ['encoding'] as const;

async function* stripLeadingTarHeader(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const it = openAsyncIterator(chunks);
  let head: Uint8Array = new Uint8Array(0);
  try {
    while (head.length < TAR_HEADER_BYTES) {
      const step = await it.next();
      if (step.done) break;
      if (step.value.length === 0) continue;
      const combined = new Uint8Array(head.length + step.value.length);
      combined.set(head, 0);
      combined.set(step.value, head.length);
      head = combined;
    }
    if (head.length === 0) return;
    if (head.length >= TAR_HEADER_BYTES && startsWith(head, TAR_USTAR_OFFSET, 'ustar')) {
      const rest = head.subarray(TAR_HEADER_BYTES);
      if (rest.length > 0) yield rest;
    } else {
      yield head;
    }
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      if (step.value.length > 0) yield step.value;
    }
  } finally {
    await it.return?.();
  }
}

class XmltvScanner {
  readonly stats: ScanStats = createStats();
  readonly buf = new ByteBuffer();
  channels: XmltvChannel[] = [];
  programmes: XmltvProgramme[] = [];
  private hint = 0;
  private tagEndHint = 0;
  /** Set when a programme waits behind unreported channels, so the caller can grow `programmeChannels` first. */
  private flush = false;
  private encoding: XmlEncoding = 'utf-8';
  bomLocked = false;
  private kind = '';
  private readonly res: Resume = { at: 0 };
  private readonly tagRes: TagResume = { at: 0, quote: 0 };
  private readonly declRes: DeclResume = { at: 0, depth: 0, quote: 0 };
  private readonly markupCache: MarkupScanCache = createMarkupScanCache();
  private readonly attrs: (string | undefined)[] = [undefined, undefined, undefined];
  private readonly encodingAttr: (string | undefined)[] = [undefined];
  private readonly scoreLang: LanguageScorer | undefined;

  private readonly size: number;
  private readonly opts: XmltvOptions;
  private readonly timeOpts: ParseXmltvTimeOptions | undefined;

  constructor(size: number, opts: XmltvOptions) {
    this.size = size;
    this.opts = opts;
    this.scoreLang = createLanguageScorer(opts.preferredLanguages);
    this.timeOpts =
      opts.defaultTimeZone !== undefined ? { defaultTimeZone: opts.defaultTimeZone } : undefined;
  }

  /** Processes complete elements (all remaining input when `final`) until the batch is full or input runs out. */
  run(final: boolean): void {
    const bytes = this.buf.view;
    const len = bytes.length;
    let pos = 0;
    while (!this.full) {
      const lt = bytes.indexOf(LT, pos);
      if (lt < 0) {
        pos = len;
        break;
      }
      pos = lt;
      this.kind = '';
      const next = this.step(bytes, lt);
      if (this.flush) break;
      if (next !== NEED) {
        pos = next;
        this.resetPending();
        continue;
      }
      if (len - lt > MAX_ELEMENT) {
        this.fail(bytes, lt, 'element-too-long');
        pos = lt + 1;
        this.resetPending();
        continue;
      }
      if (final) {
        if (this.kind) this.fail(bytes, lt, `${this.kind}-truncated`);
        pos = len;
      }
      break;
    }
    this.stats.lines += countLf(bytes, pos);
    this.buf.consume(pos);
    shiftMarkupCache(this.markupCache, pos);
  }

  private step(bytes: Uint8Array, lt: number): number {
    const b1 = bytes[lt + 1];
    if (b1 === undefined) return NEED;
    if (!isMarkupStart(b1)) return lt + 1;
    if (b1 === SLASH) {
      const gt = findGt(bytes, lt + 2, this.markupCache);
      return gt < 0 ? NEED : gt + 1;
    }
    if (b1 === BANG || b1 === QUESTION) {
      const e = skipMarkup(bytes, lt, this.markupCache, this.declRes);
      if (e === INCOMPLETE) return NEED;
      if (b1 === QUESTION && e > 0) this.checkProlog(bytes, lt, e);
      return e > 0 ? e : lt + 1;
    }
    const p = matchName(bytes, lt + 1, 'programme');
    if (p < 0) return NEED;
    if (p === 1) {
      if (this.opts.programmeChannels && this.channels.length > 0) {
        this.flush = true;
        return lt;
      }
      return this.element(bytes, lt, 'programme');
    }
    const c = matchName(bytes, lt + 1, 'channel');
    if (c < 0) return NEED;
    if (c === 1) return this.element(bytes, lt, 'channel');
    const end = findTagEnd(bytes, lt, this.tagRes);
    if (end === INCOMPLETE) return NEED;
    return end === BROKEN ? lt + 1 : end;
  }

  private resetPending(): void {
    this.hint = 0;
    this.tagEndHint = 0;
    this.tagRes.at = 0;
    this.tagRes.quote = 0;
    this.declRes.at = 0;
    this.declRes.depth = 0;
    this.declRes.quote = 0;
  }

  private element(bytes: Uint8Array, lt: number, kind: 'programme' | 'channel'): number {
    const tagEnd = this.tagEndHint > 0 ? lt + this.tagEndHint : findTagEnd(bytes, lt, this.tagRes);
    if (tagEnd === INCOMPLETE) {
      this.kind = kind;
      return NEED;
    }
    if (tagEnd === BROKEN) {
      this.fail(bytes, lt, `${kind}-malformed`);
      return lt + 1;
    }
    this.tagEndHint = tagEnd - lt;
    let bodyEnd = tagEnd;
    let end = tagEnd;
    if (bytes[tagEnd - 2] !== SLASH) {
      const close = findClose(
        bytes,
        Math.max(tagEnd, lt + this.hint),
        kind,
        true,
        this.res,
        this.markupCache,
        this.declRes,
      );
      if (close === INCOMPLETE) {
        this.hint = this.res.at - lt;
        this.kind = kind;
        return NEED;
      }
      if (close === BROKEN) {
        this.fail(bytes, lt, `${kind}-unclosed`);
        return lt + 1;
      }
      const gt = bytes.indexOf(GT, close);
      if (gt < 0) {
        this.hint = close - lt;
        this.kind = kind;
        return NEED;
      }
      bodyEnd = close;
      end = gt + 1;
    }
    if (end - lt > MAX_ELEMENT) {
      this.fail(bytes, lt, 'element-too-long');
      return end;
    }
    const names = kind === 'programme' ? PROGRAMME_ATTRS : CHANNEL_ATTRS;
    readAttrs(bytes, nameEnd(bytes, lt + 1), tagEnd - 1, names, this.attrs, this.encoding);
    if (kind === 'programme') this.programme(bytes, lt, tagEnd, bodyEnd);
    else this.channel(bytes, lt, tagEnd, bodyEnd);
    return end;
  }

  private checkProlog(bytes: Uint8Array, lt: number, end: number): void {
    if (this.bomLocked) return;
    if (!startsWith(bytes, lt, '<?xml') || lt + 5 >= end - 2) return;
    const after = bytes[lt + 5] as number;
    if (after !== 32 && after !== 9 && after !== 10 && after !== 13) return;
    readAttrs(bytes, lt + 5, end - 2, ENCODING_ATTR, this.encodingAttr);
    if (this.encodingAttr[0] !== undefined) {
      this.encoding = resolveXmlPrologEncoding(this.encodingAttr[0]);
    }
  }

  private channel(bytes: Uint8Array, lt: number, bodyStart: number, bodyEnd: number): void {
    const id = this.attrs[0]?.trim();
    if (!id) {
      this.fail(bytes, lt, 'channel-missing-id');
      return;
    }
    if (this.opts.channels && !this.opts.channels.has(id)) return;
    const channel: XmltvChannel = { id, names: [] };
    if (!parseChildren(bytes.subarray(bodyStart, bodyEnd), channel, false, this.encoding)) {
      this.fail(bytes, lt, 'channel-malformed');
      return;
    }
    this.channels.push(channel);
    this.stats.entries++;
  }

  private programme(bytes: Uint8Array, lt: number, bodyStart: number, bodyEnd: number): void {
    const [rawChannel, startText, stopText] = this.attrs;
    const channel = rawChannel?.trim();
    if (!channel) {
      this.fail(bytes, lt, 'programme-missing-channel');
      return;
    }
    if (this.opts.channels && !this.opts.channels.has(channel)) return;
    if (this.opts.programmeChannels && !this.opts.programmeChannels.has(channel)) return;
    if (startText === undefined) {
      this.fail(bytes, lt, 'programme-missing-start');
      return;
    }
    const start = parseXmltvTime(startText, this.timeOpts);
    const stop = stopText === undefined ? undefined : parseXmltvTime(stopText, this.timeOpts);
    if (
      start === undefined ||
      start < MIN_VALID_XMLTV_EPOCH_MS ||
      (stopText !== undefined && stop === undefined) ||
      (stop !== undefined && (stop < MIN_VALID_XMLTV_EPOCH_MS || stop <= start))
    ) {
      this.fail(bytes, lt, 'programme-bad-time');
      return;
    }
    const { from, to } = this.opts;
    if (to !== undefined && start >= to) return;
    if (from !== undefined && (stop === undefined ? start < from : stop <= from)) return;
    const programme: XmltvProgramme = { channel, start, title: '', categories: [] };
    if (stop !== undefined) programme.stop = stop;
    if (
      !parseChildren(
        bytes.subarray(bodyStart, bodyEnd),
        programme,
        true,
        this.encoding,
        this.scoreLang,
      )
    ) {
      this.fail(bytes, lt, 'programme-malformed');
      return;
    }
    this.programmes.push(programme);
    this.stats.entries++;
  }

  private fail(bytes: Uint8Array, at: number, code: string): void {
    this.stats.skipped++;
    if (this.stats.warnings.length < MAX_WARNINGS) {
      warn(this.stats, code, this.stats.lines + countLf(bytes, at) + 1);
    }
  }

  take(): { channels: XmltvChannel[]; programmes: XmltvProgramme[] } {
    const out = { channels: this.channels, programmes: this.programmes };
    this.channels = [];
    this.programmes = [];
    this.flush = false;
    return out;
  }

  get full(): boolean {
    return this.flush || this.channels.length + this.programmes.length >= this.size;
  }
}

/**
 * Streams an XMLTV guide from byte chunks into channels and programmes in bounded memory. Never throws on
 * bad content: a programme or channel that cannot be read is skipped with a warning and scanning resumes at
 * the next `<programme` or `<channel`. A batch is yielded as soon as it holds `batchSize` items
 * (channels plus programmes, default 500); the last has `done: true` and the statistics. Gzip input (magic `1f 8b`) goes through
 * `opts.decompressor` (with multi-member `.gz` support and a default 256 MiB decompressed ceiling); without one
 * the generator yields nothing and returns a `source-format` / `gzip-unsupported` error.
 *
 * Callers must treat the run as failed when the return value is `err`: the final `done: true` batch is
 * then never yielded (batches already yielded stay yielded). A decompressor failure returns
 * `source-format` / `gzip-corrupt`, and exceeding `maxDecompressedBytes` returns `source-format` / `too-large`.
 * An error thrown by the input iterable is never swallowed and never rethrown: it is returned as `err`, keeping
 * its `category` and `code` when it has that shape and otherwise as `network` / `stream-failed`.
 */
export async function* scanXmltv(
  chunks: AsyncIterable<Uint8Array>,
  opts: XmltvOptions = {},
): AsyncGenerator<XmltvBatch, Result<void>> {
  const size = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const decoded = decodeMaybeGzip(chunks, {
    ...(opts.decompressor === undefined ? {} : { decompressor: opts.decompressor }),
    ...(opts.maxDecompressedBytes === undefined
      ? {}
      : { maxDecompressedBytes: opts.maxDecompressedBytes }),
  });

  const scanner = new XmltvScanner(size, opts);
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

  const normalized = openAsyncIterator(
    normalizeBomChunks(stripLeadingTarHeader(decodedChunks()), () => {
      scanner.bomLocked = true;
    }),
  );
  try {
    for (;;) {
      const r = await normalized.next();
      if (!decodeResult.ok) return decodeResult;
      if (r.done) break;
      scanner.buf.append(r.value);
      for (;;) {
        scanner.run(false);
        if (!scanner.full) break;
        yield { ...scanner.take(), done: false };
      }
    }
  } finally {
    await normalized.return?.();
  }
  if (!decodeResult.ok) return decodeResult;
  for (;;) {
    scanner.run(true);
    if (!scanner.full) break;
    yield { ...scanner.take(), done: false };
  }
  yield { ...scanner.take(), stats: scanner.stats, done: true };
  return ok(undefined);
}
