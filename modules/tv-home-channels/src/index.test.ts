import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TvHomeChannelInput, TvHomeProgramInput } from './index';

const platformState = { OS: 'android' };
const requireOptionalNativeModule = vi.fn();

vi.mock('expo-modules-core', () => ({
  Platform: platformState,
  requireOptionalNativeModule,
}));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

function fakeNative(options?: {
  supported?: boolean;
  syncResult?: unknown;
  isSupportedThrows?: boolean;
}) {
  const isSupported = vi.fn(() => {
    if (options?.isSupportedThrows) throw new Error('native boom');
    return options?.supported ?? true;
  });
  const syncChannels = vi.fn(
    async (_channels: readonly TvHomeChannelInput[]) =>
      options?.syncResult ?? {
        supported: true,
        syncedChannels: 1,
        syncedPrograms: 2,
      },
  );
  const clearChannels = vi.fn(async () => undefined);
  requireOptionalNativeModule.mockReturnValue({
    isSupported,
    syncChannels,
    clearChannels,
  });
  return { isSupported, syncChannels, clearChannels };
}

afterEach(() => {
  platformState.OS = 'android';
  requireOptionalNativeModule.mockReset();
});

describe('buildTvPlayDeepLink', () => {
  it('builds canonical elviptv://play deep links for live, movie, and episode kinds', async () => {
    const { buildTvPlayDeepLink } = await loadModule();
    expect(buildTvPlayDeepLink('live:src1:ch-42', 'live')).toBe(
      'elviptv://play?key=live%3Asrc1%3Ach-42&kind=live',
    );
    expect(buildTvPlayDeepLink('vod:src1:movie/99', 'movie')).toBe(
      'elviptv://play?key=vod%3Asrc1%3Amovie%2F99&kind=movie',
    );
    expect(buildTvPlayDeepLink('ep:src2:s01e02?a=1&b=2#x', 'episode')).toBe(
      'elviptv://play?key=ep%3Asrc2%3As01e02%3Fa%3D1%26b%3D2%23x&kind=episode',
    );
  });

  it('rejects empty, blank, control-character keys and invalid kinds', async () => {
    const { buildTvPlayDeepLink } = await loadModule();
    expect(() => buildTvPlayDeepLink('', 'live')).toThrow();
    expect(() => buildTvPlayDeepLink('   ', 'movie')).toThrow();
    expect(() => buildTvPlayDeepLink('ch\n1', 'live')).toThrow();
    expect(() => buildTvPlayDeepLink('ch\r1', 'live')).toThrow();
    expect(() => buildTvPlayDeepLink('ch\u00001', 'live')).toThrow();
    expect(() => buildTvPlayDeepLink('ch\u007f1', 'live')).toThrow();
    expect(() => buildTvPlayDeepLink('ch-1', 'series' as unknown as 'live')).toThrow();
  });
});

describe('isTvHomeChannelsSupported', () => {
  it('returns false on non-Android platforms without querying native module', async () => {
    const native = fakeNative({ supported: true });
    for (const os of ['web', 'ios', 'macos', 'windows']) {
      platformState.OS = os;
      const mod = await loadModule();
      expect(mod.isTvHomeChannelsSupported()).toBe(false);
    }
    expect(native.isSupported).not.toHaveBeenCalled();
  });

  it('returns false when native module is absent on Android', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const mod = await loadModule();
    expect(mod.isTvHomeChannelsSupported()).toBe(false);
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvTvHomeChannels');
  });

  it('delegates to native isSupported() on Android and catches native errors', async () => {
    fakeNative({ supported: true });
    expect((await loadModule()).isTvHomeChannelsSupported()).toBe(true);

    fakeNative({ supported: false });
    expect((await loadModule()).isTvHomeChannelsSupported()).toBe(false);

    fakeNative({ isSupportedThrows: true });
    expect((await loadModule()).isTvHomeChannelsSupported()).toBe(false);
  });
});

describe('syncTvHomeChannels', () => {
  it('is a safe no-op on non-Android platforms and when native module is missing', async () => {
    platformState.OS = 'ios';
    fakeNative({ supported: true });
    const iosMod = await loadModule();
    await expect(iosMod.syncTvHomeChannels([])).resolves.toEqual({
      supported: false,
      syncedChannels: 0,
      syncedPrograms: 0,
    });

    platformState.OS = 'android';
    requireOptionalNativeModule.mockReturnValue(null);
    const missingMod = await loadModule();
    await expect(missingMod.syncTvHomeChannels([])).resolves.toEqual({
      supported: false,
      syncedChannels: 0,
      syncedPrograms: 0,
    });
  });

  it('bounds channels to 2 and programs to 20 per channel and strips invalid items', async () => {
    const native = fakeNative({
      syncResult: { supported: true, syncedChannels: 2, syncedPrograms: 21 },
    });
    const mod = await loadModule();

    const manyPrograms: TvHomeProgramInput[] = Array.from({ length: 25 }, (_, i) => ({
      itemKey: `live:src1:ch-${i}`,
      title: `Channel ${i}`,
      subtitle: i === 0 ? 'Live News' : undefined,
      kind: 'live',
      logoUrl: `https://cdn.example.org/logo-${i}.png`,
      isLive: true,
    }));

    const channels: TvHomeChannelInput[] = [
      {
        internalId: 'continue_watching',
        displayName: 'Continue Watching',
        isDefaultBrowsable: true,
        programs: [
          { itemKey: '', title: 'Invalid empty key', kind: 'movie' },
          { itemKey: 'bad\nkey', title: 'Invalid control key', kind: 'movie' },
          { itemKey: 'vod:src1:1', title: '   ', kind: 'movie' },
          {
            itemKey: 'vod:src1:movie-1',
            title: 'Documentary',
            subtitle: 'Episode 1',
            kind: 'movie',
            logoUrl: 'https://cdn.example.org/doc.jpg',
            durationMs: 3_600_000,
            lastPlaybackPositionMs: 900_000,
            isLive: false,
          },
        ],
      },
      {
        internalId: 'favorites',
        displayName: 'Favorites',
        isDefaultBrowsable: false,
        programs: manyPrograms,
      },
      {
        internalId: 'favorites',
        displayName: 'Duplicate Favorites',
        programs: [{ itemKey: 'live:src1:dup', title: 'Dup', kind: 'live' }],
      },
    ];

    const result = await mod.syncTvHomeChannels(channels);
    expect(result).toEqual({ supported: true, syncedChannels: 2, syncedPrograms: 21 });
    expect(native.syncChannels).toHaveBeenCalledTimes(1);

    const passed = native.syncChannels.mock.calls[0]?.[0] ?? [];
    expect(passed).toHaveLength(2);
    expect(passed[0]?.internalId).toBe('continue_watching');
    expect(passed[0]?.programs).toHaveLength(1);
    expect(passed[0]?.programs[0]).toEqual({
      itemKey: 'vod:src1:movie-1',
      title: 'Documentary',
      subtitle: 'Episode 1',
      kind: 'movie',
      logoUrl: 'https://cdn.example.org/doc.jpg',
      durationMs: 3_600_000,
      lastPlaybackPositionMs: 900_000,
      isLive: false,
    });
    expect(passed[1]?.internalId).toBe('favorites');
    expect(passed[1]?.programs).toHaveLength(20);
  });

  it('normalizes malformed native sync results safely', async () => {
    fakeNative({ syncResult: { supported: true, syncedChannels: -3, syncedPrograms: Number.NaN } });
    const mod = await loadModule();
    await expect(mod.syncTvHomeChannels([])).resolves.toEqual({
      supported: true,
      syncedChannels: 0,
      syncedPrograms: 0,
    });
  });
});

describe('clearTvHomeChannels', () => {
  it('is a safe no-op on non-Android platforms and when native module is absent', async () => {
    platformState.OS = 'web';
    const webNative = fakeNative();
    const webMod = await loadModule();
    await expect(webMod.clearTvHomeChannels()).resolves.toBeUndefined();
    expect(webNative.clearChannels).not.toHaveBeenCalled();

    platformState.OS = 'android';
    requireOptionalNativeModule.mockReturnValue(null);
    const missingMod = await loadModule();
    await expect(missingMod.clearTvHomeChannels()).resolves.toBeUndefined();
  });

  it('calls native clearChannels() on Android', async () => {
    const native = fakeNative();
    const mod = await loadModule();
    await expect(mod.clearTvHomeChannels()).resolves.toBeUndefined();
    expect(native.clearChannels).toHaveBeenCalledTimes(1);
  });
});
