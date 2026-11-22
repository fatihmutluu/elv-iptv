import { type ElvError, elvError, err, ok, openAsyncIterator, type Result } from '@elv/domain';
import { normalizeBomChunks } from './encoding';
import { toElvError } from './scan-error';
import { ByteBuffer } from './utf8';
import { accountFailure, parseXtreamElementBytes } from './xtream-json';
import { isRaw, type Raw } from './xtream-records';

const DEFAULT_BATCH_SIZE = 500;
const MAX_SCALAR_BYTES = 64 * 1024;
const NUMERIC_KEY_RE = /^\d+$/;
const ONE_BYTE = new Uint8Array(1);

const invalidJson = (): ElvError => elvError('source-format', 'invalid-json');
const unexpectedShape = (): ElvError => elvError('source-format', 'unexpected-shape');

/** Options for {@link streamXtreamRecords}. */
export interface XtreamStreamParseOptions {
  /** Maximum records yielded per batch (default 500). */
  batchSize?: number;
  /** Maximum raw input bytes read from `body`; exceeding it fails with `source-format/too-large`. */
  maxBodyBytes?: number;
  /** Optional abort signal; aborting stops reading and returns `network/aborted`. */
  signal?: AbortSignal;
}

const pushByte = (buf: ByteBuffer, b: number): void => {
  ONE_BYTE[0] = b;
  buf.append(ONE_BYTE);
};

const clearBuf = (buf: ByteBuffer): void => {
  if (buf.length > 0) buf.consume(buf.length);
};

async function* meteredChunks(
  body: AsyncIterable<Uint8Array>,
  maxBodyBytes: number | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const it = openAsyncIterator(body);
  let total = 0;
  try {
    if (signal?.aborted) throw elvError('network', 'aborted');
    for (;;) {
      if (signal?.aborted) throw elvError('network', 'aborted');
      const step = await it.next();
      if (step.done) break;
      if (signal?.aborted) throw elvError('network', 'aborted');
      const chunk = step.value;
      if (maxBodyBytes !== undefined && total + chunk.length > maxBodyBytes) {
        throw elvError('source-format', 'too-large');
      }
      total += chunk.length;
      if (chunk.length > 0) yield chunk;
    }
  } finally {
    await it.return?.().catch(() => undefined);
  }
}

const S = {
  START: 0,
  ARRAY_EXPECT: 1,
  ARRAY_AFTER: 2,
  OBJ_KEY_START: 3,
  OBJ_COLON: 4,
  OBJ_VALUE: 5,
  OBJ_AFTER: 6,
  AFTER_ROOT: 7,
  SCALAR: 8,
  OBJ_KEY: 9,
  COMPOSITE: 10,
  STRING: 11,
  PRIMITIVE: 12,
} as const;

class XtreamJsonStreamParser {
  readonly batchSize: number;
  batch: Raw[] = [];
  error: ElvError | undefined;

  private state: number = S.START;
  private rootKind: 'none' | 'array' | 'object' = 'none';
  private elem = new ByteBuffer();
  private depth = 0;
  private inString = false;
  private escaped = false;
  private skippingValue = false;
  private currentKey = '';
  private completeTopObjects = 0;
  private sawNonNumericKey = false;
  private sawNonRawObjectEntry = false;
  private scalarStart = 0;

  constructor(batchSize: number) {
    this.batchSize = Math.max(1, batchSize);
  }

  feed(chunk: Uint8Array, startOffset: number): number {
    let i = startOffset;
    const len = chunk.length;

    while (i < len && this.error === undefined && this.batch.length < this.batchSize) {
      const b = chunk[i] as number;
      if (b <= 0x20 && this.state <= S.AFTER_ROOT) {
        i++;
        continue;
      }

      switch (this.state) {
        case S.START:
          if (b === 0x3c) return this.fail(invalidJson(), i);
          if (b === 0x5b) {
            this.rootKind = 'array';
            this.state = S.ARRAY_EXPECT;
          } else if (b === 0x7b) {
            this.rootKind = 'object';
            this.state = S.OBJ_KEY_START;
          } else {
            this.scalarStart = b;
            this.state = S.SCALAR;
            clearBuf(this.elem);
            pushByte(this.elem, b);
          }
          i++;
          break;
        case S.SCALAR:
          if (this.elem.length + (len - i) > MAX_SCALAR_BYTES) {
            return this.fail(this.scalarStart === 0x22 ? unexpectedShape() : invalidJson(), i);
          }
          this.elem.append(chunk.subarray(i, len));
          i = len;
          break;
        case S.ARRAY_EXPECT:
          if (b === 0x5d) {
            this.state = S.AFTER_ROOT;
            i++;
          } else if (this.beginValue(b, false)) {
            i++;
          }
          break;
        case S.ARRAY_AFTER:
          if (b === 0x2c) this.state = S.ARRAY_EXPECT;
          else if (b === 0x5d) this.state = S.AFTER_ROOT;
          else return this.fail(invalidJson(), i);
          i++;
          break;
        case S.OBJ_KEY_START:
          if (b === 0x7d) {
            this.state = S.AFTER_ROOT;
          } else if (b === 0x22) {
            clearBuf(this.elem);
            pushByte(this.elem, b);
            this.escaped = false;
            this.state = S.OBJ_KEY;
          } else {
            return this.fail(invalidJson(), i);
          }
          i++;
          break;
        case S.OBJ_KEY: {
          const [next, closed] = this.scanString(chunk, i, false);
          i = next;
          if (closed) {
            const parsed = parseXtreamElementBytes(this.elem.view);
            clearBuf(this.elem);
            if (!parsed.ok || typeof parsed.value !== 'string') return this.fail(invalidJson(), i);
            this.currentKey = parsed.value;
            this.state = S.OBJ_COLON;
          }
          break;
        }
        case S.OBJ_COLON:
          if (b !== 0x3a) return this.fail(invalidJson(), i);
          this.state = S.OBJ_VALUE;
          i++;
          break;
        case S.OBJ_VALUE: {
          const isUserInfo = this.currentKey === 'user_info';
          if (!isUserInfo && !NUMERIC_KEY_RE.test(this.currentKey)) {
            this.sawNonNumericKey = true;
            this.batch.length = 0;
          }
          const skip = !isUserInfo && (this.sawNonNumericKey || this.sawNonRawObjectEntry);
          if (this.beginValue(b, skip)) i++;
          break;
        }
        case S.OBJ_AFTER:
          if (b === 0x2c) this.state = S.OBJ_KEY_START;
          else if (b === 0x7d) this.state = S.AFTER_ROOT;
          else return this.fail(invalidJson(), i);
          i++;
          break;
        case S.COMPOSITE:
          i = this.scanComposite(chunk, i);
          break;
        case S.STRING: {
          const [next, closed] = this.scanString(chunk, i, this.skippingValue);
          i = next;
          if (closed) this.finishValue();
          break;
        }
        case S.PRIMITIVE:
          i = this.scanPrimitive(chunk, i);
          break;
        case S.AFTER_ROOT:
          return this.fail(invalidJson(), i);
      }
    }

    return i;
  }

  finish(): ElvError | undefined {
    if (this.error !== undefined) return this.error;
    if (this.state === S.START) return invalidJson();
    if (this.state === S.SCALAR) {
      const parsed = parseXtreamElementBytes(this.elem.view);
      clearBuf(this.elem);
      if (!parsed.ok) return invalidJson();
      return parsed.value === null || parsed.value === false ? undefined : unexpectedShape();
    }
    if (this.state === S.AFTER_ROOT) {
      return this.rootKind === 'object' && (this.sawNonNumericKey || this.sawNonRawObjectEntry)
        ? unexpectedShape()
        : undefined;
    }
    return this.rootKind === 'array' && this.completeTopObjects > 0 ? undefined : invalidJson();
  }

  private fail(error: ElvError, offset: number): number {
    this.error = error;
    return offset;
  }

  private scanPrimitive(chunk: Uint8Array, start: number): number {
    let i = start;
    let ended = false;
    while (i < chunk.length) {
      const c = chunk[i] as number;
      if (c <= 0x20 || c === 0x2c || c === 0x5d || c === 0x7d) {
        ended = true;
        break;
      }
      i++;
    }
    if (!this.skippingValue && i > start) this.elem.append(chunk.subarray(start, i));
    if (ended) this.finishValue();
    return i;
  }

  private scanString(chunk: Uint8Array, start: number, skip: boolean): [number, boolean] {
    let i = start;
    let closed = false;
    while (i < chunk.length) {
      const c = chunk[i++] as number;
      if (this.escaped) this.escaped = false;
      else if (c === 0x5c) this.escaped = true;
      else if (c === 0x22) {
        closed = true;
        break;
      }
    }
    if (!skip && i > start) this.elem.append(chunk.subarray(start, i));
    return [i, closed];
  }

  private scanComposite(chunk: Uint8Array, start: number): number {
    let i = start;
    let closed = false;
    while (i < chunk.length) {
      const c = chunk[i++] as number;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === 0x5c) this.escaped = true;
        else if (c === 0x22) this.inString = false;
      } else if (c === 0x22) {
        this.inString = true;
      } else if (c === 0x7b || c === 0x5b) {
        this.depth++;
      } else if (c === 0x7d || c === 0x5d) {
        if (--this.depth === 0) {
          closed = true;
          break;
        }
      }
    }
    if (!this.skippingValue && i > start) this.elem.append(chunk.subarray(start, i));
    if (closed) this.finishValue();
    return i;
  }

  private beginValue(firstByte: number, skip: boolean): boolean {
    if (firstByte === 0x2c || firstByte === 0x3a || firstByte === 0x5d || firstByte === 0x7d) {
      this.error = invalidJson();
      return false;
    }
    this.skippingValue = skip;
    clearBuf(this.elem);
    if (!skip) pushByte(this.elem, firstByte);
    if (firstByte === 0x7b || firstByte === 0x5b) {
      this.depth = 1;
      this.inString = false;
      this.escaped = false;
      this.state = S.COMPOSITE;
    } else if (firstByte === 0x22) {
      this.escaped = false;
      this.state = S.STRING;
    } else {
      this.state = S.PRIMITIVE;
    }
    return true;
  }

  private finishValue(): void {
    const nextState = this.rootKind === 'array' ? S.ARRAY_AFTER : S.OBJ_AFTER;
    if (this.skippingValue) {
      clearBuf(this.elem);
      this.state = nextState;
      return;
    }
    const parsed = parseXtreamElementBytes(this.elem.view);
    clearBuf(this.elem);
    if (!parsed.ok) {
      this.error = parsed.error;
      return;
    }
    const val = parsed.value;
    if (this.rootKind === 'array') {
      if (isRaw(val)) {
        this.completeTopObjects++;
        this.batch.push(val);
      }
    } else if (this.currentKey === 'user_info') {
      const failure = isRaw(val) ? accountFailure(val) : undefined;
      if (failure !== undefined) {
        this.error = failure;
        return;
      }
      this.sawNonNumericKey = true;
      this.batch.length = 0;
    } else if (!isRaw(val)) {
      this.sawNonRawObjectEntry = true;
      this.batch.length = 0;
    } else if (!this.sawNonNumericKey && !this.sawNonRawObjectEntry) {
      this.batch.push(val);
    }
    this.state = nextState;
  }
}

/**
 * Incrementally parses a streaming Xtream JSON list response (`[ {...}, ... ]` or PHP numeric-keyed
 * `{ "0": {...}, "1": {...} }`) into bounded `Raw[]` batches in `O(batchSize)` memory.
 */
export async function* streamXtreamRecords(
  body: AsyncIterable<Uint8Array>,
  opts?: XtreamStreamParseOptions,
): AsyncGenerator<Raw[], Result<void>> {
  const parser = new XtreamJsonStreamParser(opts?.batchSize ?? DEFAULT_BATCH_SIZE);
  let firstChunk = true;

  try {
    for await (const chunk of normalizeBomChunks(
      meteredChunks(body, opts?.maxBodyBytes, opts?.signal),
    )) {
      let offset = 0;
      if (firstChunk) {
        firstChunk = false;
        if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
          offset = 3;
        }
      }
      while (offset < chunk.length) {
        offset = parser.feed(chunk, offset);
        if (parser.error !== undefined) return err(parser.error);
        if (parser.batch.length >= parser.batchSize) {
          const out = parser.batch;
          parser.batch = [];
          yield out;
        }
      }
    }
  } catch (e) {
    return err(toElvError(e));
  }

  const endError = parser.finish();
  if (endError !== undefined) return err(endError);
  if (parser.batch.length > 0) {
    const out = parser.batch;
    parser.batch = [];
    yield out;
  }
  return ok(undefined);
}
