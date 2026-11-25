import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Linking: {
    canOpenURL: vi.fn(async () => false),
    openURL: vi.fn(async () => undefined),
  },
  Platform: {
    OS: 'android',
    isTV: false,
  },
}));

vi.mock('@elv/engine-media3', () => ({}));

import { buildIosExternalPlayerUrl, createMobileExternalPlayerPort } from './external-player';

describe('buildIosExternalPlayerUrl (#406)', () => {
  const stream = 'https://stream.example.test/live/ch1.m3u8';

  it('builds x-callback-url handoffs for known callback schemes and generic scheme URIs', () => {
    expect(buildIosExternalPlayerUrl(stream, 'vlc-x-callback')).toBe(
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream)}&x-success=${encodeURIComponent('elviptv://external-return')}`,
    );
    expect(buildIosExternalPlayerUrl(stream, 'infuse')).toBe(
      `infuse://x-callback-url/play?url=${encodeURIComponent(stream)}&x-success=${encodeURIComponent('elviptv://external-return')}`,
    );
    expect(buildIosExternalPlayerUrl(stream, 'myplayer')).toBe(
      `myplayer://${encodeURIComponent(stream)}`,
    );
    expect(buildIosExternalPlayerUrl(stream, '')).toBe(stream);
    expect(buildIosExternalPlayerUrl(stream, 'bad scheme://injected')).toBe(stream);
  });
});

describe('createMobileExternalPlayerPort (#406)', () => {
  it('delegates Android launches to the Media3 bridge and returns progress', async () => {
    const launchExternalPlayer = vi.fn(async () => ({
      launched: true,
      positionMs: 120_000,
      durationMs: 300_000,
      completed: false,
    }));
    const port = createMobileExternalPlayerPort({
      os: 'android',
      isTV: false,
      media3Bridge: {
        isExternalPlayerSupported: () => true,
        launchExternalPlayer,
      },
    });

    expect(port.isSupported).toBe(true);
    const res = await port.launch({
      url: 'https://stream.example.test/movie.mp4',
      title: 'Test Movie',
      startPositionMs: 15_000,
    });
    expect(launchExternalPlayer).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      launched: true,
      positionMs: 120_000,
      durationMs: 300_000,
      completed: false,
    });
  });

  it('launches iOS handheld handoff via Linking and fails cleanly when cannot open', async () => {
    const linking = {
      canOpenURL: vi.fn(async () => true),
      openURL: vi.fn(async () => undefined),
    };
    const port = createMobileExternalPlayerPort({
      os: 'ios',
      isTV: false,
      linking,
    });

    expect(port.isSupported).toBe(true);
    const res = await port.launch({
      url: 'https://stream.example.test/movie.mp4',
      title: 'Test Movie',
      startPositionMs: 0,
      customScheme: 'myplayer',
    });
    expect(res).toEqual({ launched: true });
    expect(linking.openURL).toHaveBeenCalledWith(
      `myplayer://${encodeURIComponent('https://stream.example.test/movie.mp4')}`,
    );

    linking.canOpenURL.mockResolvedValueOnce(false);
    const failed = await port.launch({
      url: 'https://stream.example.test/movie.mp4',
      title: 'Test Movie',
      startPositionMs: 0,
      customScheme: 'missingplayer',
    });
    expect(failed).toEqual({ launched: false, errorCode: 'cannot_open_url' });
  });

  it('reports unsupported on tvOS', async () => {
    const port = createMobileExternalPlayerPort({ os: 'ios', isTV: true });
    expect(port.isSupported).toBe(false);
    await expect(
      port.launch({ url: 'https://stream.example.test/a.m3u8', title: 'Live', startPositionMs: 0 }),
    ).resolves.toEqual({ launched: false, errorCode: 'unsupported' });
  });
});
