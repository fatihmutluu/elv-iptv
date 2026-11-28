import { type Decompressor, elvError, err, ok, openAsyncIterator, type Result } from '@elv/domain';
import { createGzipMemberFramer } from './gzip-member-splitter';
import { toElvError } from './scan-error';

/** Default decompressed size ceiling for gzip streams (256 MiB). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/** Options for {@link decodeMaybeGzip}. */
export interface GzipStreamOptions {
  /** Platform decompressor; `gunzip` handles gzip (`1f 8b`) and optional `unxz` handles XZ (`fd 37 7a 58 5a 00`). */
  decompressor?: Decompressor;
  /** Maximum decompressed byte count allowed across all members/streams (default 256 MiB). */
  maxDecompressedBytes?: number;
}

const GZIP_0 = 0x1f;
const GZIP_1 = 0x8b;
const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] as const;

async function closeQuietly(it: AsyncIterator<Uint8Array> | undefined): Promise<void> {
  if (!it) return;
  try {
    await it.return?.();
  } catch {
    // Stream teardown errors are ignored when aborting or failing.
  }
}

function queueBytes(queue: readonly Uint8Array[]): number {
  let n = 0;
  for (let i = 0; i < queue.length; i++) n += (queue[i] as Uint8Array).length;
  return n;
}

function peekQueueByte(queue: readonly Uint8Array[], index: number): number | undefined {
  let rem = index;
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i] as Uint8Array;
    if (rem < q.length) return q[rem];
    rem -= q.length;
  }
  return undefined;
}

function matchesXzPrefix(queue: readonly Uint8Array[], count: number): boolean {
  const limit = Math.min(count, XZ_MAGIC.length);
  for (let i = 0; i < limit; i++) {
    if (peekQueueByte(queue, i) !== XZ_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Sniffs up to the first 6 bytes of `chunks` for gzip (`1f 8b`) or XZ (`fd 37 7a 58 5a 00`) magic.
 * Non-compressed streams (including files shorter than 6 bytes) are replayed unchanged with zero extra copies.
 * Gzip streams are framed per RFC 1952 + RFC 1951 member boundary in O(1) memory; XZ streams delegate to
 * `opts.decompressor.unxz`. Both enforce `maxDecompressedBytes` (default 256 MiB) with early upstream cancel.
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

  while (heldBytes < XZ_MAGIC.length) {
    if (heldBytes >= 2 && peekQueueByte(held, 0) === GZIP_0 && peekQueueByte(held, 1) === GZIP_1) {
      break;
    }
    if (heldBytes >= 1) {
      const b0 = peekQueueByte(held, 0);
      if (b0 !== GZIP_0 && b0 !== XZ_MAGIC[0]) break;
      if (b0 === GZIP_0 && heldBytes >= 2) break;
      if (b0 === XZ_MAGIC[0] && !matchesXzPrefix(held, heldBytes)) break;
    }
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

  const isGzip =
    heldBytes >= 2 && peekQueueByte(held, 0) === GZIP_0 && peekQueueByte(held, 1) === GZIP_1;
  const isXz = !isGzip && heldBytes >= XZ_MAGIC.length && matchesXzPrefix(held, XZ_MAGIC.length);

  if (!isGzip && !isXz) {
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

  if (isXz) {
    const unxz = opts.decompressor?.unxz;
    if (!unxz) {
      if (!upstreamEnded) await closeQuietly(it);
      return err(elvError('source-format', 'xz-unsupported'));
    }
    const maxBytes = opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
    let totalDecompressed = 0;
    let activeReader: AsyncIterator<Uint8Array> | undefined;

    async function* xzInput(): AsyncGenerator<Uint8Array> {
      for (const h of held) yield h;
      while (!upstreamEnded) {
        const r = await pull();
        if (r.done) {
          upstreamEnded = true;
          return;
        }
        if (r.value.length > 0) yield r.value;
      }
    }

    try {
      let reader: AsyncIterator<Uint8Array>;
      try {
        reader = openAsyncIterator(unxz(xzInput()));
      } catch {
        const initErr = readSourceError();
        if (initErr) return err(toElvError(initErr.error));
        return err(elvError('source-format', 'xz-corrupt'));
      }
      activeReader = reader;

      for (;;) {
        let r: IteratorResult<Uint8Array>;
        try {
          r = await reader.next();
        } catch {
          activeReader = undefined;
          await closeQuietly(reader);
          const upstreamErr = readSourceError();
          if (upstreamErr) return err(toElvError(upstreamErr.error));
          return err(elvError('source-format', 'xz-corrupt'));
        }
        if (r.done) {
          activeReader = undefined;
          const upstreamErr = readSourceError();
          if (upstreamErr) return err(toElvError(upstreamErr.error));
          return ok(undefined);
        }
        const chunk = r.value;
        totalDecompressed += chunk.length;
        if (totalDecompressed > maxBytes) {
          activeReader = undefined;
          await closeQuietly(reader);
          return err(elvError('source-format', 'too-large'));
        }
        yield chunk;
      }
    } finally {
      const reader = activeReader;
      activeReader = undefined;
      await closeQuietly(reader);
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
  let totalDecompressed = 0;
  let activeReader: AsyncIterator<Uint8Array> | undefined;

  try {
    for (;;) {
      const framer = createGzipMemberFramer();
      let framerDone = false;

      async function* memberInput(): AsyncGenerator<Uint8Array> {
        for (;;) {
          let chunk = pendingQueue.shift();
          if (chunk === undefined) {
            if (upstreamEnded) return;
            const r = await pull();
            if (r.done) {
              upstreamEnded = true;
              return;
            }
            chunk = r.value;
          }
          if (chunk.length === 0) continue;
          const res = framer.feed(chunk);
          if (res.done) {
            framerDone = true;
            if (res.rest && res.rest.length > 0) pendingQueue.unshift(res.rest);
            if (res.take.length > 0) yield res.take;
            return;
          }
          if (res.take.length > 0) yield res.take;
        }
      }

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
        yield chunk;
      }

      const upstreamErr = readSourceError();
      if (upstreamErr) return err(toElvError(upstreamErr.error));
      if (memberThrew) return err(elvError('source-format', 'gzip-corrupt'));
      if (!framerDone) return ok(undefined);

      while (queueBytes(pendingQueue) < 2 && !upstreamEnded) {
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
        if (r.value.length > 0) pendingQueue.push(r.value);
      }

      const avail = queueBytes(pendingQueue);
      if (avail === 0) return ok(undefined);
      if (
        avail >= 2 &&
        peekQueueByte(pendingQueue, 0) === GZIP_0 &&
        peekQueueByte(pendingQueue, 1) === GZIP_1
      ) {
        continue;
      }
      return err(elvError('source-format', 'gzip-corrupt'));
    }
  } finally {
    const reader = activeReader;
    activeReader = undefined;
    await closeQuietly(reader);
    if (!upstreamEnded) await closeQuietly(it);
  }
}
