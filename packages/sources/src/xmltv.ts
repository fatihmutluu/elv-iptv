import { elvError, err, ok, type Result } from '@elv/domain';
import { createStats, MAX_WARNINGS, type ScanStats, warn } from './stats';
import { ByteBuffer } from './utf8';
import {
  BANG,
  BROKEN,
  countLf,
  findClose,
  findTagEnd,
  GT,
  INCOMPLETE,
  LT,
  matchName,
  nameEnd,
  QUESTION,
  type Resume,
  readAttrs,
  SLASH,
  skipMarkup,
} from './xml-tokens';
import { parseChildren } from './xmltv-children';
import { parseXmltvTime } from './xmltv-time';
import type { XmltvBatch, XmltvChannel, XmltvOptions, XmltvProgramme } from './xmltv-types';

export { parseXmltvTime } from './xmltv-time';
export type { XmltvBatch, XmltvChannel, XmltvOptions, XmltvProgramme } from './xmltv-types';

const MAX_ELEMENT = 1 << 20;
const DEFAULT_BATCH = 500;
const NEED = -1;
const PROGRAMME_ATTRS = ['channel', 'start', 'stop'] as const;
const CHANNEL_ATTRS = ['id'] as const;

class XmltvScanner {
  readonly stats: ScanStats = createStats();
  readonly buf = new ByteBuffer();
  channels: XmltvChannel[] = [];
  programmes: XmltvProgramme[] = [];
  private hint = 0;
  private kind = '';
  private readonly res: Resume = { at: 0 };
  private readonly attrs: (string | undefined)[] = [undefined, undefined, undefined];

  constructor(
    private readonly size: number,
    private readonly opts: XmltvOptions,
  ) {}

  /** Processes complete elements (all remaining input when `final`) until the batch is full or input runs out. */
  run(final: boolean): void {
    const bytes = this.buf.view;
    const len = bytes.length;
    let pos = 0;
    while (this.programmes.length < this.size) {
      const lt = bytes.indexOf(LT, pos);
      if (lt < 0) {
        pos = len;
        break;
      }
      pos = lt;
      this.kind = '';
      const next = this.step(bytes, lt);
      if (next !== NEED) {
        pos = next;
        this.hint = 0;
        continue;
      }
      if (len - lt > MAX_ELEMENT) {
        this.fail(bytes, lt, 'element-too-long');
        pos = lt + 1;
        this.hint = 0;
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
  }

  private step(bytes: Uint8Array, lt: number): number {
    const b1 = bytes[lt + 1];
    if (b1 === undefined) return NEED;
    if (b1 === SLASH) {
      const gt = bytes.indexOf(GT, lt + 2);
      return gt < 0 ? NEED : gt + 1;
    }
    if (b1 === BANG || b1 === QUESTION) {
      const e = skipMarkup(bytes, lt);
      return e === INCOMPLETE ? NEED : e > 0 ? e : lt + 1;
    }
    const p = matchName(bytes, lt + 1, 'programme');
    if (p < 0) return NEED;
    if (p === 1) return this.element(bytes, lt, 'programme');
    const c = matchName(bytes, lt + 1, 'channel');
    if (c < 0) return NEED;
    if (c === 1) return this.element(bytes, lt, 'channel');
    const end = findTagEnd(bytes, lt);
    if (end === INCOMPLETE) return NEED;
    return end === BROKEN ? lt + 1 : end;
  }

  private element(bytes: Uint8Array, lt: number, kind: 'programme' | 'channel'): number {
    const tagEnd = findTagEnd(bytes, lt);
    if (tagEnd === INCOMPLETE) {
      this.kind = kind;
      return NEED;
    }
    if (tagEnd === BROKEN) {
      this.fail(bytes, lt, `${kind}-malformed`);
      return lt + 1;
    }
    let bodyEnd = tagEnd;
    let end = tagEnd;
    if (bytes[tagEnd - 2] !== SLASH) {
      const close = findClose(bytes, Math.max(tagEnd, lt + this.hint), kind, true, this.res);
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
    readAttrs(bytes, nameEnd(bytes, lt + 1), tagEnd - 1, names, this.attrs);
    if (kind === 'programme') this.programme(bytes, lt, tagEnd, bodyEnd);
    else this.channel(bytes, lt, tagEnd, bodyEnd);
    return end;
  }

  private channel(bytes: Uint8Array, lt: number, bodyStart: number, bodyEnd: number): void {
    const id = this.attrs[0];
    if (!id) {
      this.fail(bytes, lt, 'channel-missing-id');
      return;
    }
    if (this.opts.channels && !this.opts.channels.has(id)) return;
    const channel: XmltvChannel = { id, names: [] };
    if (!parseChildren(bytes.subarray(bodyStart, bodyEnd), channel, false)) {
      this.fail(bytes, lt, 'channel-malformed');
      return;
    }
    this.channels.push(channel);
    this.stats.entries++;
  }

  private programme(bytes: Uint8Array, lt: number, bodyStart: number, bodyEnd: number): void {
    const [channel, startText, stopText] = this.attrs;
    if (channel === undefined) {
      this.fail(bytes, lt, 'programme-missing-channel');
      return;
    }
    if (this.opts.channels && !this.opts.channels.has(channel)) return;
    if (startText === undefined) {
      this.fail(bytes, lt, 'programme-missing-start');
      return;
    }
    const start = parseXmltvTime(startText);
    const stop = stopText === undefined ? undefined : parseXmltvTime(stopText);
    if (start === undefined || (stopText !== undefined && stop === undefined)) {
      this.fail(bytes, lt, 'programme-bad-time');
      return;
    }
    const { from, to } = this.opts;
    if (to !== undefined && start >= to) return;
    if (from !== undefined && (stop === undefined ? start < from : stop <= from)) return;
    const programme: XmltvProgramme = { channel, start, title: '', categories: [] };
    if (stop !== undefined) programme.stop = stop;
    if (!parseChildren(bytes.subarray(bodyStart, bodyEnd), programme, true)) {
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
    return out;
  }

  get full(): boolean {
    return this.programmes.length >= this.size;
  }
}

const GZIP_0 = 0x1f;
const GZIP_1 = 0x8b;

/**
 * Streams an XMLTV guide from byte chunks into channels and programmes in bounded memory. Never throws on
 * bad content: a programme or channel that cannot be read is skipped with a warning and scanning resumes at
 * the next `<programme` or `<channel`. A batch is yielded as soon as it holds `batchSize` programmes
 * (default 500); the last has `done: true` and the statistics. Gzip input (magic `1f 8b`) goes through
 * `opts.decompressor`; without one the generator yields nothing and returns a `source-format` /
 * `gzip-unsupported` error. A failing decompressor ends the input with a `gzip-corrupt` warning.
 */
export async function* scanXmltv(
  chunks: AsyncIterable<Uint8Array>,
  opts: XmltvOptions = {},
): AsyncGenerator<XmltvBatch, Result<void>> {
  const size = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const it = chunks[Symbol.asyncIterator]();
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let ended = false;
  while (heldBytes < 2) {
    const r = await it.next();
    if (r.done) {
      ended = true;
      break;
    }
    if (r.value.length > 0) {
      held.push(r.value);
      heldBytes += r.value.length;
    }
  }
  const first = held[0];
  const second = (first && first.length > 1 ? first[1] : held[1]?.[0]) as number | undefined;
  const gzip = first?.[0] === GZIP_0 && second === GZIP_1;

  async function* replay(): AsyncGenerator<Uint8Array> {
    let finished = ended;
    try {
      yield* held;
      while (!finished) {
        const r = await it.next();
        if (r.done) finished = true;
        else yield r.value;
      }
    } finally {
      if (!finished) await it.return?.();
    }
  }

  if (gzip && !opts.decompressor) {
    await it.return?.();
    return err(elvError('source-format', 'gzip-unsupported'));
  }
  const input = gzip && opts.decompressor ? opts.decompressor.gunzip(replay()) : replay();

  const scanner = new XmltvScanner(size, opts);
  try {
    for await (const chunk of input) {
      scanner.buf.append(chunk);
      do {
        scanner.run(false);
        if (scanner.full) yield { ...scanner.take(), done: false };
      } while (scanner.full);
    }
  } catch (e) {
    if (!gzip) throw e;
    warn(scanner.stats, 'gzip-corrupt', scanner.stats.lines + 1);
  }
  for (;;) {
    scanner.run(true);
    if (!scanner.full) break;
    yield { ...scanner.take(), done: false };
  }
  yield { ...scanner.take(), stats: scanner.stats, done: true };
  return ok(undefined);
}
