import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const data = new Map<string, string>();
  return {
    data,
    failOn: undefined as string | undefined,
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
  };
});
vi.mock('expo-secure-store', () => ({
  getItemAsync: mocked.getItemAsync,
  setItemAsync: mocked.setItemAsync,
  deleteItemAsync: mocked.deleteItemAsync,
}));

import { createSecureSecretStore } from './secret-store';

const bytes = (s: string) => unescape(encodeURIComponent(s)).length;

beforeEach(() => {
  mocked.data.clear();
  mocked.failOn = undefined;
  const guard = (key: string) => {
    if (mocked.failOn === key) throw new Error('keystore says SECRET-VALUE-xyz');
  };
  mocked.getItemAsync.mockReset().mockImplementation(async (key: string) => {
    guard(key);
    return mocked.data.get(key) ?? null;
  });
  mocked.setItemAsync.mockReset().mockImplementation(async (key: string, value: string) => {
    guard(key);
    mocked.data.set(key, value);
  });
  mocked.deleteItemAsync.mockReset().mockImplementation(async (key: string) => {
    guard(key);
    mocked.data.delete(key);
  });
});

describe('createSecureSecretStore', () => {
  it('round-trips a short value in one chunk', async () => {
    const store = createSecureSecretStore();
    await store.set('src.1', 'hunter2');
    expect(await store.get('src.1')).toBe('hunter2');
    expect([...mocked.data.keys()].sort()).toEqual(['src.1.0', 'src.1.n']);
  });

  it('round-trips a 5,000-byte value in chunks of at most 1,800 bytes', async () => {
    const store = createSecureSecretStore();
    const value = 'a1'.repeat(2500);
    await store.set('k', value);
    expect(await store.get('k')).toBe(value);
    expect(mocked.data.get('k.n')).toBe('3');
    for (const [key, chunk] of mocked.data)
      if (key !== 'k.n') expect(bytes(chunk)).toBeLessThanOrEqual(1800);
  });

  it('counts UTF-8 bytes and never splits a character', async () => {
    const store = createSecureSecretStore();
    const value = 'ğ😀'.repeat(900);
    await store.set('k', value);
    expect(await store.get('k')).toBe(value);
    for (const [key, chunk] of mocked.data)
      if (key !== 'k.n') expect(bytes(chunk)).toBeLessThanOrEqual(1800);
  });

  it('round-trips the empty string', async () => {
    const store = createSecureSecretStore();
    await store.set('k', '');
    expect(await store.get('k')).toBe('');
  });

  it('returns undefined for an unknown key', async () => {
    expect(await createSecureSecretStore().get('nope')).toBeUndefined();
  });

  it('deletes stale chunks when overwriting with a shorter value', async () => {
    const store = createSecureSecretStore();
    await store.set('k', 'x'.repeat(5000));
    await store.set('k', 'short');
    expect(await store.get('k')).toBe('short');
    expect([...mocked.data.keys()].sort()).toEqual(['k.0', 'k.n']);
  });

  it('deletes every chunk and the index', async () => {
    const store = createSecureSecretStore();
    await store.set('k', 'x'.repeat(5000));
    await store.delete('k');
    expect(mocked.data.size).toBe(0);
    expect(await store.get('k')).toBeUndefined();
  });

  it('deleting an unknown key is a no-op', async () => {
    await expect(createSecureSecretStore().delete('nope')).resolves.toBeUndefined();
  });

  it('a missing chunk reads as no secret', async () => {
    const store = createSecureSecretStore();
    await store.set('k', 'x'.repeat(5000));
    mocked.data.delete('k.1');
    expect(await store.get('k')).toBeUndefined();
  });

  it('an inconsistent index reads as no secret', async () => {
    const store = createSecureSecretStore();
    for (const bad of ['abc', '-1', '1.5', '']) {
      mocked.data.set('k.n', bad);
      mocked.data.set('k.0', 'v');
      expect(await store.get('k')).toBeUndefined();
    }
  });

  it('a thrown store error reads as no secret and logs no value', async () => {
    const store = createSecureSecretStore();
    await store.set('k', 'SECRET-VALUE-xyz');
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    mocked.failOn = 'k.0';
    expect(await store.get('k')).toBeUndefined();
    mocked.failOn = 'k.n';
    expect(await store.get('k')).toBeUndefined();
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET-VALUE');
      spy.mockRestore();
    }
  });

  it('a failed set leaves no half-written secret or orphan chunks behind', async () => {
    const store = createSecureSecretStore();
    await store.set('k', 'old'.repeat(1500));
    const baseSet =
      mocked.setItemAsync.getMockImplementation() ?? (async (_k: string, _v: string) => undefined);
    mocked.setItemAsync.mockImplementation(async (key: string, value: string) => {
      if (key === 'k.1') throw new Error('keystore quota exceeded');
      return baseSet(key, value);
    });
    await expect(store.set('k', 'y'.repeat(5000))).rejects.toThrow();
    mocked.setItemAsync.mockImplementation(baseSet);
    expect(await store.get('k')).toBeUndefined();
    expect([...mocked.data.keys()]).toEqual([]);
  });

  it('serializes get, set and delete per key so concurrent callers never observe torn chunks', async () => {
    const store = createSecureSecretStore();
    const valA = 'A'.repeat(4000);
    const valB = 'B'.repeat(4000);
    await store.set('k', valA);

    let releaseChunk0!: () => void;
    const chunk0Blocked = new Promise<void>((res) => {
      releaseChunk0 = res;
    });
    const baseSet =
      mocked.setItemAsync.getMockImplementation() ?? (async (_k: string, _v: string) => undefined);
    mocked.setItemAsync.mockImplementation(async (key: string, value: string) => {
      if (key === 'k.0' && value.startsWith('B')) await chunk0Blocked;
      return baseSet(key, value);
    });

    const writeB = store.set('k', valB);
    await Promise.resolve();
    const concurrentRead = store.get('k');
    const otherKeyWrite = store.set('other', 'fast');
    await expect(otherKeyWrite).resolves.toBeUndefined();

    releaseChunk0();
    await writeB;
    expect(await concurrentRead).toBe(valB);
  });

  it('deletes orphan chunks even when the .n count key or k.0 is missing', async () => {
    const store = createSecureSecretStore();
    mocked.data.set('k.1', 'chunk1');
    mocked.data.set('k.2', 'chunk2');
    await store.delete('k');
    expect([...mocked.data.keys()]).toEqual([]);
  });

  it('rejects keys outside [A-Za-z0-9._-]', async () => {
    const store = createSecureSecretStore();
    await expect(store.set('a b', 'v')).rejects.toThrow();
    await expect(store.get('a/b')).rejects.toThrow();
    await expect(store.delete('')).rejects.toThrow();
  });
});

describe('createSecureSecretStore delete retry', () => {
  it('a failed delete can be retried until the store is empty', async () => {
    const store = createSecureSecretStore();
    await store.set('k', 'x'.repeat(5000));
    mocked.failOn = 'k.1';
    await expect(store.delete('k')).rejects.toThrow();
    mocked.failOn = undefined;
    await store.delete('k');
    expect(mocked.data.size).toBe(0);
  });
});
