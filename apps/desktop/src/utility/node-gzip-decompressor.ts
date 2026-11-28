import { createGunzip } from 'node:zlib';
import { type Decompressor, openAsyncIterator } from '@elv/domain';
import { unxzStream } from './xz-stream.ts';

/**
 * Streaming desktop implementation of {@link Decompressor}: Node `zlib.createGunzip()` with write
 * backpressure for gzip and clean-room streaming XZ/LZMA2 (`unxzStream`) for `.xz`, both with
 * immediate upstream cancellation on early consumer `.return()`.
 */
export function createNodeGzipDecompressor(): Decompressor {
  return {
    unxz(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      return unxzStream(chunks);
    },
    async *gunzip(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      const gunzip = createGunzip();
      const it = openAsyncIterator(chunks);
      let cancelled = false;
      let upstreamDone = false;
      let upstreamClosed = false;

      const closeUpstream = async (): Promise<void> => {
        if (upstreamClosed || upstreamDone) return;
        upstreamClosed = true;
        try {
          await it.return?.();
        } catch {
          // Upstream teardown errors are ignored when aborting or failing.
        }
      };

      const pump = (async () => {
        try {
          for (;;) {
            if (cancelled || gunzip.destroyed) break;
            const step = await it.next();
            if (step.done) {
              upstreamDone = true;
              break;
            }
            if (cancelled || gunzip.destroyed) break;
            if (!gunzip.write(step.value)) {
              await new Promise<void>((resolve) => {
                if (
                  cancelled ||
                  gunzip.destroyed ||
                  gunzip.closed ||
                  gunzip.errored ||
                  gunzip.writableEnded
                ) {
                  resolve();
                  return;
                }
                const done = () => {
                  gunzip.off('drain', done);
                  gunzip.off('close', done);
                  gunzip.off('error', done);
                  resolve();
                };
                gunzip.once('drain', done);
                gunzip.once('close', done);
                gunzip.once('error', done);
              });
            }
          }
          if (!cancelled && !gunzip.destroyed) gunzip.end();
        } catch (error) {
          upstreamDone = true;
          if (!gunzip.destroyed) {
            gunzip.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        } finally {
          await closeUpstream();
        }
      })();
      pump.catch(() => undefined);

      try {
        for await (const chunk of gunzip) {
          yield chunk instanceof Uint8Array
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : new Uint8Array(chunk as ArrayBufferLike);
        }
      } finally {
        cancelled = true;
        if (!gunzip.destroyed) gunzip.destroy();
        await closeUpstream();
        await pump;
      }
    },
  };
}
