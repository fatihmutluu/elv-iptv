import { type Decompressor, elvError, err, ok, openAsyncIterator, type Result } from '@elv/domain';
import { toElvError } from './scan-error';

/** Default decompressed size ceiling for gzip streams (256 MiB). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/** Options for {@link decodeMaybeGzip}. */
export interface GzipStreamOptions {
  /** Platform gzip decompressor; required when the stream starts with gzip magic bytes `1f 8b`. */
  decompressor?: Decompressor;
  /** Maximum decompressed byte count allowed across all gzip members (default 256 MiB). */
  maxDecompressedBytes?: number;
}

const GZIP_0 = 0x1f;
const GZIP_1 = 0x8b;
const GZIP_DEFLATE = 0x08;
/** Minimum offset of the 8-byte trailer within one member (10-byte header + 2-byte minimum deflate block). */
const GZIP_MIN_TRAILER_OFFSET = 12;
/** Minimum total byte length of a valid gzip member (10-byte header + 2-byte deflate + 8-byte trailer). */
const GZIP_MIN_MEMBER_BYTES = 20;
const MAX_WINDOW_BYTES = 64 * 1024;
const FEED_CHUNK_BYTES = 16 * 1024;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

function updateCrc32(crc: number, chunk: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i++) {
    c = (CRC32_TABLE[(c ^ (chunk[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed-cap (`<= 64 KiB`) sliding window of the most recent compressed bytes fed to one gzip member. */
class SlidingWindow {
  private data = new Uint8Array(0);
  private len = 0;
  totalFed = 0;

  reset(): void {
    this.len = 0;
    this.totalFed = 0;
  }

  push(chunk: Uint8Array): void {
    const n = chunk.length;
    if (n === 0) return;
    this.totalFed += n;
    if (n >= MAX_WINDOW_BYTES) {
      if (this.data.length !== MAX_WINDOW_BYTES) this.data = new Uint8Array(MAX_WINDOW_BYTES);
      this.data.set(chunk.subarray(n - MAX_WINDOW_BYTES), 0);
      this.len = MAX_WINDOW_BYTES;
      return;
    }
    const needed = this.len + n;
    if (needed <= MAX_WINDOW_BYTES) {
      if (needed > this.data.length) {
        const nextCap = Math.min(MAX_WINDOW_BYTES, Math.max(needed, this.data.length * 2, 1024));
        const next = new Uint8Array(nextCap);
        next.set(this.data.subarray(0, this.len), 0);
        this.data = next;
      }
      this.data.set(chunk, this.len);
      this.len = needed;
      return;
    }
    if (this.data.length !== MAX_WINDOW_BYTES) {
      const next = new Uint8Array(MAX_WINDOW_BYTES);
      next.set(this.data.subarray(0, this.len), 0);
      this.data = next;
    }
    const keep = MAX_WINDOW_BYTES - n;
    this.data.copyWithin(0, this.len - keep, this.len);
    this.data.set(chunk, keep);
    this.len = MAX_WINDOW_BYTES;
  }

  view(): Uint8Array {
    return this.data.subarray(0, this.len);
  }

  baseOffset(): number {
    return this.totalFed - this.len;
  }
}

async function closeQuietly(it: AsyncIterator<Uint8Array> | undefined): Promise<void> {
  if (!it) return;
  try {
    await it.return?.();
  } catch {
    // Stream teardown errors are ignored when aborting or failing.
  }
}

function peekCombinedByte(
  tail: Uint8Array,
  queue: readonly Uint8Array[],
  index: number,
): number | undefined {
  if (index < tail.length) return tail[index];
  let rem = index - tail.length;
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i] as Uint8Array;
    if (rem < q.length) return q[rem];
    rem -= q.length;
  }
  return undefined;
}

function isValidGzipHeaderStart(tail: Uint8Array, queue: readonly Uint8Array[]): boolean {
  const b0 = peekCombinedByte(tail, queue, 0);
  const b1 = peekCombinedByte(tail, queue, 1);
  if (b0 !== GZIP_0 || b1 !== GZIP_1) return false;
  const b2 = peekCombinedByte(tail, queue, 2);
  if (b2 !== undefined && b2 !== GZIP_DEFLATE) return false;
  const b3 = peekCombinedByte(tail, queue, 3);
  if (b3 !== undefined && (b3 & 0xe0) !== 0) return false;
  return true;
}

function queueBytes(queue: readonly Uint8Array[]): number {
  let n = 0;
  for (let i = 0; i < queue.length; i++) n += (queue[i] as Uint8Array).length;
  return n;
}

/**
 * Sniffs the first two bytes of `chunks` for gzip magic (`1f 8b`). Non-gzip streams are replayed unchanged
 * with zero extra copies. Gzip streams are decoded via `opts.decompressor` with a streaming decompressed
 * byte ceiling (`maxDecompressedBytes`, default 256 MiB) and O(1)-memory multi-member `.gz` continuation
 * (`<= 64 KiB` compressed sliding window + streaming IEEE CRC32 & ISIZE) so both native multi-member
 * decompressors and single-member `DecompressionStream('gzip')` decode concatenated members completely.
 */
export async function* decodeMaybeGzip(
  chunks: AsyncIterable<Uint8Array>,
  opts: GzipStreamOptions = {},
): AsyncGenerator<Uint8Array, Result<void>> {
  const it = openAsyncIterator(chunks);
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let upstreamEnded = false;
  let sourceError: { error: unknown } | undefined;
  const readSourceError = (): { error: unknown } | undefined => sourceError;

  const pull = async (): Promise<IteratorResult<Uint8Array>> => {
    try {
      return await it.next();
    } catch (e) {
      upstreamEnded = true;
      sourceError = { error: e };
      throw e;
    }
  };

  while (heldBytes < 2) {
    let r: IteratorResult<Uint8Array>;
    try {
      r = await pull();
    } catch (e) {
      return err(toElvError(e));
    }
    if (r.done) {
      upstreamEnded = true;
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

  if (!gzip) {
    try {
      for (const h of held) yield h;
      while (!upstreamEnded) {
        let r: IteratorResult<Uint8Array>;
        try {
          r = await pull();
        } catch (e) {
          return err(toElvError(e));
        }
        if (r.done) {
          upstreamEnded = true;
          break;
        }
        yield r.value;
      }
      return ok(undefined);
    } finally {
      if (!upstreamEnded) await closeQuietly(it);
    }
  }

  if (!opts.decompressor) {
    if (!upstreamEnded) await closeQuietly(it);
    return err(elvError('source-format', 'gzip-unsupported'));
  }

  const decompressor = opts.decompressor;
  const maxBytes = opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  const pendingQueue: Uint8Array[] = [...held];
  const window = new SlidingWindow();
  let totalDecompressed = 0;
  let activeReader: AsyncIterator<Uint8Array> | undefined;

  const nextCompressedSlice = async (): Promise<Uint8Array | undefined> => {
    for (;;) {
      let chunk = pendingQueue.shift();
      if (chunk === undefined) {
        if (upstreamEnded) return undefined;
        const r = await pull();
        if (r.done) {
          upstreamEnded = true;
          return undefined;
        }
        chunk = r.value;
      }
      if (chunk.length === 0) continue;
      if (chunk.length > FEED_CHUNK_BYTES) {
        pendingQueue.unshift(chunk.subarray(FEED_CHUNK_BYTES));
        chunk = chunk.subarray(0, FEED_CHUNK_BYTES);
      }
      window.push(chunk);
      return chunk;
    }
  };

  async function* memberInput(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const slice = await nextCompressedSlice();
      if (slice === undefined) return;
      yield slice;
    }
  }

  const findNextMember = async (crc: number, isize: number): Promise<boolean> => {
    const w = window.view();
    if (w.length < 8) return false;
    const t0 = crc & 0xff;
    const t1 = (crc >>> 8) & 0xff;
    const t2 = (crc >>> 16) & 0xff;
    const t3 = (crc >>> 24) & 0xff;
    const t4 = isize & 0xff;
    const t5 = (isize >>> 8) & 0xff;
    const t6 = (isize >>> 16) & 0xff;
    const t7 = (isize >>> 24) & 0xff;
    const minPos = Math.max(0, GZIP_MIN_TRAILER_OFFSET - window.baseOffset());
    const limit = w.length - 8;

    for (let pos = minPos; pos <= limit; pos++) {
      if (
        w[pos] !== t0 ||
        w[pos + 1] !== t1 ||
        w[pos + 2] !== t2 ||
        w[pos + 3] !== t3 ||
        w[pos + 4] !== t4 ||
        w[pos + 5] !== t5 ||
        w[pos + 6] !== t6 ||
        w[pos + 7] !== t7
      ) {
        continue;
      }
      const tail = w.subarray(pos + 8);
      if (tail.length === 1 && tail[0] !== GZIP_0) continue;
      if (tail.length < 2) {
        while (tail.length + queueBytes(pendingQueue) < 2 && !upstreamEnded) {
          let r: IteratorResult<Uint8Array>;
          try {
            r = await pull();
          } catch {
            return false;
          }
          if (r.done) {
            upstreamEnded = true;
            break;
          }
          if (r.value.length > 0) pendingQueue.push(r.value);
        }
      }
      if (isValidGzipHeaderStart(tail, pendingQueue)) {
        if (tail.length > 0) pendingQueue.unshift(tail.slice());
        return true;
      }
    }
    return false;
  };

  try {
    for (;;) {
      window.reset();
      let memberCrc = 0;
      let memberSize = 0;
      let memberThrew = false;
      let reader: AsyncIterator<Uint8Array>;
      try {
        reader = openAsyncIterator(decompressor.gunzip(memberInput()));
      } catch {
        const initErr = readSourceError();
        if (initErr) return err(toElvError(initErr.error));
        return err(elvError('source-format', 'gzip-corrupt'));
      }
      activeReader = reader;

      for (;;) {
        let r: IteratorResult<Uint8Array>;
        try {
          r = await reader.next();
        } catch {
          memberThrew = true;
          activeReader = undefined;
          await closeQuietly(reader);
          break;
        }
        if (r.done) {
          activeReader = undefined;
          break;
        }
        const chunk = r.value;
        totalDecompressed += chunk.length;
        if (totalDecompressed > maxBytes) {
          activeReader = undefined;
          await closeQuietly(reader);
          return err(elvError('source-format', 'too-large'));
        }
        memberCrc = updateCrc32(memberCrc, chunk);
        memberSize = (memberSize + chunk.length) >>> 0;
        yield chunk;
      }

      const upstreamErr = readSourceError();
      if (upstreamErr) return err(toElvError(upstreamErr.error));

      if (memberThrew) {
        const hasNext = await findNextMember(memberCrc, memberSize);
        const peekErr = readSourceError();
        if (peekErr) return err(toElvError(peekErr.error));
        if (hasNext) continue;
        return err(elvError('source-format', 'gzip-corrupt'));
      }

      if (window.totalFed >= GZIP_MIN_MEMBER_BYTES) {
        const hasNext = await findNextMember(memberCrc, memberSize);
        const peekErr = readSourceError();
        if (peekErr) return err(toElvError(peekErr.error));
        if (hasNext) continue;
      }
      return ok(undefined);
    }
  } finally {
    const reader = activeReader;
    activeReader = undefined;
    await closeQuietly(reader);
    if (!upstreamEnded) await closeQuietly(it);
  }
}
