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
  const httpStream = 'http://stream.example.test/live/ch1.ts';

  it('builds handoff URIs for known iOS schemes and generic schemes, rejecting invalid/blocked inputs', () => {
    expect(buildIosExternalPlayerUrl(stream, 'vlc-x-callback')).toBe(
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream)}&x-success=${encodeURIComponent('elviptv://external-return')}`,
    );
    expect(buildIosExternalPlayerUrl(stream, 'infuse')).toBe(
      `infuse://x-callback-url/play?url=${encodeURIComponent(stream)}&x-success=${encodeURIComponent('elviptv://external-return')}`,
    );
    expect(buildIosExternalPlayerUrl(stream, 'outplayer')).toBe(`outplayer://${stream}`);
    expect(buildIosExternalPlayerUrl(stream, 'nplayer-https')).toBe(
      'nplayer-https://stream.example.test/live/ch1.m3u8',
    );
    expect(buildIosExternalPlayerUrl(httpStream, 'nplayer-http')).toBe(
      'nplayer-http://stream.example.test/live/ch1.ts',
    );
    expect(buildIosExternalPlayerUrl(stream, 'myplayer')).toBe(
      `myplayer://${encodeURIComponent(stream)}`,
    );
    expect(buildIosExternalPlayerUrl(stream, '')).toBeNull();
    expect(buildIosExternalPlayerUrl(stream, 'bad scheme://injected')).toBeNull();
    expect(buildIosExternalPlayerUrl(stream, 'javascript')).toBeNull();
    expect(buildIosExternalPlayerUrl(stream, 'https')).toBeNull();
    expect(buildIosExternalPlayerUrl('file:///etc/passwd', 'vlc-x-callback')).toBeNull();
    expect(buildIosExternalPlayerUrl('javascript:alert(1)', 'infuse')).toBeNull();
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

  it('returns launch_failed when Android Media3 bridge resolves null or rejects', async () => {
    const nullPort = createMobileExternalPlayerPort({
      os: 'android',
      isTV: false,
      media3Bridge: {
        isExternalPlayerSupported: () => true,
        launchExternalPlayer: vi.fn(async () => null),
      },
    });
    await expect(
      nullPort.launch({
        url: 'https://stream.example.test/movie.mp4',
        title: 'Test Movie',
        startPositionMs: 0,
      }),
    ).resolves.toEqual({ launched: false, errorCode: 'launch_failed' });

    const throwingPort = createMobileExternalPlayerPort({
      os: 'android',
      isTV: false,
      media3Bridge: {
        isExternalPlayerSupported: () => true,
        launchExternalPlayer: vi.fn(async () => {
          throw new Error('bridge failure');
        }),
      },
    });
    await expect(
      throwingPort.launch({
        url: 'https://stream.example.test/movie.mp4',
        title: 'Test Movie',
        startPositionMs: 0,
      }),
    ).resolves.toEqual({ launched: false, errorCode: 'launch_failed' });
  });

  it('rejects non-http(s) URLs and blocked custom schemes on iOS without calling Linking', async () => {
    const linking = {
      canOpenURL: vi.fn(async () => true),
      openURL: vi.fn(async () => undefined),
    };
    const port = createMobileExternalPlayerPort({ os: 'ios', isTV: false, linking });

    await expect(
      port.launch({
        url: 'file:///var/mobile/secret.m3u',
        title: 'Local',
        startPositionMs: 0,
        customScheme: 'vlc-x-callback',
      }),
    ).resolves.toEqual({ launched: false, errorCode: 'invalid_url' });

    await expect(
      port.launch({
        url: 'https://stream.example.test/movie.mp4',
        title: 'Blocked Scheme',
        startPositionMs: 0,
        customScheme: 'tel',
      }),
    ).resolves.toEqual({ launched: false, errorCode: 'invalid_scheme' });

    expect(linking.canOpenURL).not.toHaveBeenCalled();
    expect(linking.openURL).not.toHaveBeenCalled();
  });

  it('probes declared iOS player schemes in order when customScheme is empty and tolerates canOpenURL errors', async () => {
    const stream = 'https://stream.example.test/movie.mp4';
    const linking = {
      canOpenURL: vi.fn(async (url: string) => {
        if (url.startsWith('vlc-x-callback://')) throw new Error('query denied');
        if (url.startsWith('infuse://')) return false;
        if (url.startsWith('outplayer://')) return true;
        return false;
      }),
      openURL: vi.fn(async () => undefined),
    };
    const port = createMobileExternalPlayerPort({ os: 'ios', isTV: false, linking });

    const res = await port.launch({ url: stream, title: 'Movie', startPositionMs: 0 });
    expect(res).toEqual({ launched: true });
    expect(linking.canOpenURL).toHaveBeenNthCalledWith(
      1,
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream)}&x-success=${encodeURIComponent('elviptv://external-return')}`,
    );
    expect(linking.canOpenURL).toHaveBeenNthCalledWith(
      2,
      `infuse://x-callback-url/play?url=${encodeURIComponent(stream)}&x-success=${encodeURIComponent('elviptv://external-return')}`,
    );
    expect(linking.canOpenURL).toHaveBeenNthCalledWith(3, `outplayer://${stream}`);
    expect(linking.openURL).toHaveBeenCalledWith(`outplayer://${stream}`);

    const emptyLinking = {
      canOpenURL: vi.fn(async () => false),
      openURL: vi.fn(async () => undefined),
    };
    const httpStream = 'http://stream.example.test/live/ch1.ts';
    const noPlayerPort = createMobileExternalPlayerPort({
      os: 'ios',
      isTV: false,
      linking: emptyLinking,
    });
    await expect(
      noPlayerPort.launch({ url: httpStream, title: 'Live', startPositionMs: 0 }),
    ).resolves.toEqual({ launched: false, errorCode: 'no_player_available' });
    expect(emptyLinking.canOpenURL).toHaveBeenLastCalledWith(
      'nplayer-http://stream.example.test/live/ch1.ts',
    );
    expect(emptyLinking.openURL).not.toHaveBeenCalled();
  });

  it('reports unsupported on tvOS', async () => {
    const port = createMobileExternalPlayerPort({ os: 'ios', isTV: true });
    expect(port.isSupported).toBe(false);
    await expect(
      port.launch({ url: 'https://stream.example.test/a.m3u8', title: 'Live', startPositionMs: 0 }),
    ).resolves.toEqual({ launched: false, errorCode: 'unsupported' });
  });
});
