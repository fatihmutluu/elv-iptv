import type { SecretStore } from '@elv/domain';
import * as SecureStore from 'expo-secure-store';

const CHUNK_BYTES = 1800;
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const COUNT_PATTERN = /^(0|[1-9][0-9]{0,5})$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('secret key must match [A-Za-z0-9._-]+');
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/** Splits at code point boundaries so every chunk is at most CHUNK_BYTES of UTF-8. */
function chunkValue(value: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let size = 0;
  let index = 0;
  for (const char of value) {
    const width = utf8Length(char.codePointAt(0) ?? 0);
    if (size + width > CHUNK_BYTES) {
      chunks.push(value.slice(start, index));
      start = index;
      size = 0;
    }
    size += width;
    index += char.length;
  }
  if (index > start) chunks.push(value.slice(start, index));
  return chunks;
}

async function readCount(key: string): Promise<number | undefined> {
  const raw = await SecureStore.getItemAsync(`${key}.n`);
  return raw !== null && COUNT_PATTERN.test(raw) ? Number(raw) : undefined;
}

async function deleteChunks(key: string, from: number, to: number): Promise<void> {
  for (let i = from; i < to; i += 1) await SecureStore.deleteItemAsync(`${key}.${i}`);
}

/**
 * `SecretStore` over the platform secure store (Keychain, Keystore). Values are split into chunks of at most
 * 1,800 UTF-8 bytes under `<key>.<i>` with the count under `<key>.n`, because the stores cap one entry's size.
 * A missing chunk, a bad index or a store error reads as no secret; values are never logged.
 */
export function createSecureSecretStore(): SecretStore {
  return {
    async get(key) {
      assertKey(key);
      try {
        const count = await readCount(key);
        if (count === undefined) return undefined;
        let value = '';
        for (let i = 0; i < count; i += 1) {
          const chunk = await SecureStore.getItemAsync(`${key}.${i}`);
          if (chunk === null) return undefined;
          value += chunk;
        }
        return value;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      assertKey(key);
      const previous = (await readCount(key).catch(() => undefined)) ?? 0;
      const chunks = chunkValue(value);
      // The index goes first and last so a failure midway leaves no secret rather than a mixed one.
      await SecureStore.deleteItemAsync(`${key}.n`);
      for (const [i, chunk] of chunks.entries())
        await SecureStore.setItemAsync(`${key}.${i}`, chunk);
      await SecureStore.setItemAsync(`${key}.n`, String(chunks.length));
      await deleteChunks(key, chunks.length, previous);
    },
    async delete(key) {
      assertKey(key);
      const count = (await readCount(key).catch(() => undefined)) ?? 0;
      await SecureStore.deleteItemAsync(`${key}.n`);
      await deleteChunks(key, 0, count);
    },
  };
}
