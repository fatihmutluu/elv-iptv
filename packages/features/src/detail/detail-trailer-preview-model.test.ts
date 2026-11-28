import { describe, expect, it } from 'vitest';
import {
  buildYoutubeCommand,
  buildYoutubeListeningHandshake,
  buildYoutubeMuteCommand,
  DETAIL_TRAILER_AUTOPLAY_DELAY_MS,
  DETAIL_TRAILER_PRELOAD_DELAY_MS,
  parseYoutubePlayerMessageEvent,
  resolveHeroTrailerSource,
} from './detail-trailer-preview-model';

describe('detail-trailer-preview-model', () => {
  it('exports the expected settle and idle auto-play delay constants', () => {
    expect(DETAIL_TRAILER_PRELOAD_DELAY_MS).toBe(400);
    expect(DETAIL_TRAILER_AUTOPLAY_DELAY_MS).toBe(2500);
  });

  it('returns none when reduceMotion is true, on TV, on non-web platforms, or when no valid source exists', () => {
    expect(
      resolveHeroTrailerSource({
        trailerStreamUrl: 'https://cdn.example.com/trailer.mp4',
        trailerYoutubeId: '8g18jFHCLXk',
        platformOs: 'web',
        isTv: false,
        reduceMotion: true,
      }),
    ).toEqual({ kind: 'none' });

    expect(
      resolveHeroTrailerSource({
        trailerStreamUrl: 'https://cdn.example.com/trailer.mp4',
        trailerYoutubeId: '8g18jFHCLXk',
        platformOs: 'web',
        isTv: true,
        reduceMotion: false,
      }),
    ).toEqual({ kind: 'none' });

    for (const platformOs of ['android', 'ios']) {
      expect(
        resolveHeroTrailerSource({
          trailerStreamUrl: 'https://cdn.example.com/trailer.mp4',
          trailerYoutubeId: '8g18jFHCLXk',
          platformOs,
          isTv: false,
          reduceMotion: false,
        }),
      ).toEqual({ kind: 'none' });
    }

    expect(
      resolveHeroTrailerSource({
        trailerStreamUrl: 'http://insecure.example.com/trailer.mp4',
        trailerYoutubeId: 'invalid',
        platformOs: 'web',
        isTv: false,
        reduceMotion: false,
      }),
    ).toEqual({ kind: 'none' });

    expect(
      resolveHeroTrailerSource({
        trailerStreamUrl: 'https://127.0.0.1/trailer.mp4',
        trailerYoutubeId: null,
        platformOs: 'web',
        isTv: false,
        reduceMotion: false,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('prioritizes valid HTTPS direct stream over YouTube ID on web', () => {
    expect(
      resolveHeroTrailerSource({
        trailerStreamUrl: 'https://cdn.example.com/trailers/dune.mp4',
        trailerYoutubeId: '8g18jFHCLXk',
        platformOs: 'web',
        isTv: false,
        reduceMotion: false,
      }),
    ).toEqual({
      kind: 'html-video',
      url: 'https://cdn.example.com/trailers/dune.mp4',
    });
  });

  it('falls back to canonical youtube-nocookie embed URL with enablejsapi=1 when direct stream is missing or invalid', () => {
    expect(
      resolveHeroTrailerSource({
        trailerStreamUrl: 'javascript:alert(1)',
        trailerYoutubeId: ' 8g18jFHCLXk ',
        platformOs: 'web',
        isTv: false,
        reduceMotion: false,
      }),
    ).toEqual({
      kind: 'youtube-iframe',
      youtubeId: '8g18jFHCLXk',
      embedUrl:
        'https://www.youtube-nocookie.com/embed/8g18jFHCLXk?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&modestbranding=1&iv_load_policy=3&disablekb=1&fs=0&loop=1&playlist=8g18jFHCLXk&enablejsapi=1',
    });
  });

  it('builds YouTube iframe API postMessage JSON payloads and listening handshake', () => {
    expect(buildYoutubeListeningHandshake()).toBe('{"event":"listening"}');
    expect(buildYoutubeMuteCommand(true)).toBe('{"event":"command","func":"mute","args":[]}');
    expect(buildYoutubeMuteCommand(false)).toBe('{"event":"command","func":"unMute","args":[]}');
    expect(buildYoutubeCommand('playVideo')).toBe(
      '{"event":"command","func":"playVideo","args":[]}',
    );
    expect(buildYoutubeCommand('pauseVideo')).toBe(
      '{"event":"command","func":"pauseVideo","args":[]}',
    );
  });

  it('safely parses YouTube postMessage events (onReady / infoDelivery) and ignores malformed payloads', () => {
    expect(parseYoutubePlayerMessageEvent(JSON.stringify({ event: 'onReady' }))).toBe('onReady');
    expect(parseYoutubePlayerMessageEvent({ event: 'infoDelivery', info: {} })).toBe(
      'infoDelivery',
    );
    expect(parseYoutubePlayerMessageEvent(JSON.stringify({ event: 'stateChange' }))).toBeNull();
    expect(parseYoutubePlayerMessageEvent('{not-json')).toBeNull();
    expect(parseYoutubePlayerMessageEvent('')).toBeNull();
    expect(parseYoutubePlayerMessageEvent(null)).toBeNull();
    expect(parseYoutubePlayerMessageEvent([])).toBeNull();
  });
});
