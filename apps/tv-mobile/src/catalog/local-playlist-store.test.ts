import { testDb } from '@elv/data/testing';
import { describe, expect, it } from 'vitest';
import { createMobileLocalPlaylistStore } from './local-playlist-store';

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe('createMobileLocalPlaylistStore (#51)', () => {
  it('writes, streams, and deletes sandboxed local M3U bytes without touching host paths', async () => {
    const handle = testDb();
    let opens = 0;
    const store = createMobileLocalPlaylistStore(async () => {
      opens += 1;
      return handle.db;
    });

    expect(opens).toBe(0);
    const payload = new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Demo\nhttp://127.0.0.1/1.ts\n');
    await store.write('src-local-1', payload);
    expect(opens).toBe(1);

    const stream = await store.openRead('src-local-1');
    expect(stream).toBeDefined();
    if (stream !== undefined) {
      const roundTripped = await readAll(stream);
      expect(new TextDecoder().decode(roundTripped)).toBe(new TextDecoder().decode(payload));
    }

    await store.remove('src-local-1');
    expect(await store.openRead('src-local-1')).toBeUndefined();
    handle.close();
  });

  it('rejects invalid source IDs and empty payloads', async () => {
    const handle = testDb();
    const store = createMobileLocalPlaylistStore(async () => handle.db);

    await expect(store.write('../escape', new Uint8Array([1]))).rejects.toThrow(
      'invalid source id',
    );
    await expect(store.write('src-1', new Uint8Array(0))).rejects.toThrow('out of bounds');
    handle.close();
  });

  it('roundtrips multi-chunk binary payloads across non-multiple-of-3 boundaries cleanly', async () => {
    const handle = testDb();
    const store = createMobileLocalPlaylistStore(async () => handle.db);

    for (const size of [36 * 1024, 36 * 1024 + 1, 36 * 1024 + 2]) {
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        payload[i] = (i * 31 + 17) & 0xff;
      }
      const id = `src-chunk-${size}`;
      await store.write(id, payload);
      const stream = await store.openRead(id);
      expect(stream).toBeDefined();
      if (stream !== undefined) {
        const roundTripped = await readAll(stream);
        expect(roundTripped.byteLength).toBe(size);
        expect(Buffer.compare(Buffer.from(roundTripped), Buffer.from(payload))).toBe(0);
      }
    }

    handle.close();
  });
});
