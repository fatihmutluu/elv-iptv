import type { EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  bindDesktopMediaSession,
  createDesktopMediaSession,
  type MediaMetadataInitLike,
  type MediaSessionActionDetailsLike,
  type MediaSessionActionName,
  type MediaSessionLike,
  type MediaSessionPositionStateLike,
  sanitizeMediaArtworkUrl,
} from './media-session.ts';
import type { DesktopEngine } from './player/desktop-engine.ts';

class FakeMediaMetadata {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artwork: readonly { readonly src: string }[];

  constructor(init: MediaMetadataInitLike) {
    this.title = init.title ?? '';
    this.artist = init.artist ?? '';
    this.album = init.album ?? '';
    this.artwork = init.artwork ?? [];
  }
}

function createFakeMediaSessionEnv(opts?: {
  throwOnPosition?: boolean;
  unsupportedActions?: readonly MediaSessionActionName[];
}) {
  const handlers = new Map<
    MediaSessionActionName,
    ((details?: MediaSessionActionDetailsLike) => void) | null
  >();
  const positionCalls: Array<MediaSessionPositionStateLike | undefined> = [];
  const unsupported = new Set(opts?.unsupportedActions ?? []);

  const mediaSession: MediaSessionLike = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) {
      if (unsupported.has(action)) {
        throw new TypeError(`Unsupported action: ${action}`);
      }
      handlers.set(action, handler);
    },
    setPositionState(state) {
      if (opts?.throwOnPosition) {
        throw new TypeError('Invalid position state');
      }
      positionCalls.push(state);
    },
  };

  return {
    navigator: { mediaSession },
    mediaSession,
    handlers,
    positionCalls,
    trigger(action: MediaSessionActionName, details?: MediaSessionActionDetailsLike) {
      handlers.get(action)?.(details);
    },
  };
}

describe('sanitizeMediaArtworkUrl', () => {
  it('strips embedded userinfo and credential query params while preserving benign params and rejecting non-http(s) URLs', () => {
    expect(sanitizeMediaArtworkUrl('https://alice:s3cr3t@cdn.example.test/poster.jpg?w=320')).toBe(
      'https://cdn.example.test/poster.jpg?w=320',
    );
    expect(
      sanitizeMediaArtworkUrl(
        'https://cdn.example.test/poster.jpg?w=512&username=u&PASSWORD=p&token=t&access_token=a&api_key=k&apikey=k2&auth=x&key=y&secret=s&sig=1&signature=2&user=u2&pass=p2&quality=high',
      ),
    ).toBe('https://cdn.example.test/poster.jpg?w=512&quality=high');
    expect(sanitizeMediaArtworkUrl('http://user@cdn.example.test/logo.png')).toBe(
      'http://cdn.example.test/logo.png',
    );
    expect(sanitizeMediaArtworkUrl('file:///etc/passwd')).toBeUndefined();
    expect(sanitizeMediaArtworkUrl('data:image/png;base64,AAAA')).toBeUndefined();
    expect(sanitizeMediaArtworkUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeMediaArtworkUrl('not a url')).toBeUndefined();
    expect(sanitizeMediaArtworkUrl('')).toBeUndefined();
    expect(sanitizeMediaArtworkUrl(undefined)).toBeUndefined();
  });
});

describe('createDesktopMediaSession', () => {
  it('updates metadata with sanitized artwork, playback state, and clamped VOD position state', () => {
    const env = createFakeMediaSessionEnv();
    const session = createDesktopMediaSession({
      navigator: env.navigator,
      MediaMetadata: FakeMediaMetadata,
    });

    session.setMetadata({
      title: 'Channel One',
      artist: 'Live News',
      album: 'ELV IPTV',
      artworkUrl: 'https://demo:pass123@art.example.test/ch1.png',
    });

    const meta = env.mediaSession.metadata as FakeMediaMetadata | null;
    expect(meta).toBeInstanceOf(FakeMediaMetadata);
    expect(meta?.title).toBe('Channel One');
    expect(meta?.artist).toBe('Live News');
    expect(meta?.album).toBe('ELV IPTV');
    expect(meta?.artwork).toEqual([{ src: 'https://art.example.test/ch1.png' }]);

    session.setPlaybackState('playing');
    expect(env.mediaSession.playbackState).toBe('playing');

    session.setPlaybackState('paused');
    expect(env.mediaSession.playbackState).toBe('paused');

    // Clamps position into [0, durationSec]
    session.setPositionState({ durationSec: 120, positionSec: 180, playbackRate: 1.25 });
    session.setPositionState({ durationSec: 120, positionSec: -5 });
    // Ignores live / non-finite / zero durations
    session.setPositionState({ durationSec: 0, positionSec: 10 });
    session.setPositionState({ durationSec: -10, positionSec: 5 });
    session.setPositionState({ durationSec: Number.POSITIVE_INFINITY, positionSec: 5 });
    session.setPositionState({ durationSec: 120, positionSec: Number.NaN });

    expect(env.positionCalls).toEqual([
      { duration: 120, position: 120, playbackRate: 1.25 },
      { duration: 120, position: 0, playbackRate: 1 },
    ]);

    session.dispose();
  });

  it('catches browser TypeError from setPositionState and unsupported action names', () => {
    const env = createFakeMediaSessionEnv({
      throwOnPosition: true,
      unsupportedActions: ['seekto'],
    });
    const session = createDesktopMediaSession({
      navigator: env.navigator,
      MediaMetadata: FakeMediaMetadata,
    });

    expect(() => session.setPositionState({ durationSec: 60, positionSec: 15 })).not.toThrow();

    const play = vi.fn();
    const seekTo = vi.fn();
    expect(() => session.setHandlers({ play, seekTo })).not.toThrow();
    env.trigger('play');
    expect(play).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  it('wires all 7 action handlers, clears omitted handlers, and cleans up on clear/dispose', () => {
    const env = createFakeMediaSessionEnv();
    const session = createDesktopMediaSession({
      navigator: env.navigator,
      MediaMetadata: FakeMediaMetadata,
    });

    const play = vi.fn();
    const pause = vi.fn();
    const seekBackward = vi.fn();
    const seekForward = vi.fn();
    const seekTo = vi.fn();
    const previousTrack = vi.fn();
    const nextTrack = vi.fn();
    const stop = vi.fn();

    session.setHandlers({
      play,
      pause,
      seekBackward,
      seekForward,
      seekTo,
      previousTrack,
      nextTrack,
      stop,
    });

    env.trigger('play');
    env.trigger('pause');
    env.trigger('seekbackward', { seekOffset: 15 });
    env.trigger('seekforward', { seekOffset: 30 });
    env.trigger('seekto', { seekTime: 42, fastSeek: true });
    env.trigger('seekto', { seekTime: Number.NaN });
    env.trigger('previoustrack');
    env.trigger('nexttrack');
    env.trigger('stop');

    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(seekBackward).toHaveBeenCalledWith(15);
    expect(seekForward).toHaveBeenCalledWith(30);
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(42, true);
    expect(previousTrack).toHaveBeenCalledTimes(1);
    expect(nextTrack).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    // Replacing handlers clears omitted ones to null
    session.setHandlers({ play });
    expect(env.handlers.get('pause')).toBeNull();
    expect(env.handlers.get('nexttrack')).toBeNull();
    expect(env.handlers.get('stop')).toBeNull();

    // clear() resets state and unregisters all handlers
    session.setMetadata({ title: 'Movie' });
    session.setPlaybackState('playing');
    session.clear();
    expect(env.mediaSession.metadata).toBeNull();
    expect(env.mediaSession.playbackState).toBe('none');
    expect(env.handlers.get('play')).toBeNull();

    // dispose() makes subsequent calls no-ops
    session.dispose();
    session.setPlaybackState('playing');
    session.setMetadata({ title: 'After Dispose' });
    expect(env.mediaSession.playbackState).toBe('none');
    expect(env.mediaSession.metadata).toBeNull();
  });

  it('is a safe no-op when navigator.mediaSession or MediaMetadata is unavailable', () => {
    const session = createDesktopMediaSession({ navigator: null, MediaMetadata: null });
    expect(() => {
      session.setMetadata({ title: 'No MediaSession' });
      session.setPlaybackState('playing');
      session.setPositionState({ durationSec: 100, positionSec: 20 });
      session.setHandlers({ play: vi.fn() });
      session.clear();
      session.dispose();
    }).not.toThrow();
  });
});

describe('bindDesktopMediaSession', () => {
  function createFakeEngine() {
    const listeners = new Set<(event: EngineEvent) => void>();
    const subscribeSpy = vi.fn((listener: (event: EngineEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
    const engine: DesktopEngine = {
      engineId: 'eng-1',
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: false,
        softwareAudioFallback: false,
        recreate: true,
        audioTrackSelection: true,
        subtitleTrackSelection: true,
      },
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      setSpeed: vi.fn(),
      stop: vi.fn(),
      recreate: vi.fn(),
      setArea: vi.fn(),
      toggleFullscreen: vi.fn(),
      isFullscreen: vi.fn(() => false),
      toggleMute: vi.fn(),
      setVolume: vi.fn(),
      setAudioDelay: vi.fn(),
      setSubtitleDelay: vi.fn(),
      setAudioDevice: vi.fn(),
      getAudioDevices: vi.fn(() => []),
      getActiveAudioDevice: vi.fn(() => 'auto'),
      onAudioDevicesChange: vi.fn(() => () => undefined),
      setDeinterlace: vi.fn(),
      setDeinterlaceMode: vi.fn(),
      setPitchLock: vi.fn(),
      setAudioNormalization: vi.fn(),
      queueNext: vi.fn(),
      clearQueue: vi.fn(),
      onQueueAdvanced: vi.fn(() => () => undefined),
      setHwdec: vi.fn(),
      setResizeMode: vi.fn(),
      setFilterSdh: vi.fn(),
      setSubtitleFontFamily: vi.fn(),
      onUi: vi.fn(() => () => undefined),
      release: vi.fn(),
      subscribe: subscribeSpy,
    };
    const emit = (ev: EngineEvent) => {
      for (const l of listeners) l(ev);
    };
    return { engine, subscribeSpy, emit };
  }

  it('drives metadata from typed MediaSessionMetadata, gates standalone VOD track actions, and preserves heldEvents ordering (#435)', () => {
    const env = createFakeMediaSessionEnv();
    const session = createDesktopMediaSession({
      navigator: env.navigator,
      MediaMetadata: FakeMediaMetadata,
    });
    const { engine, subscribeSpy, emit } = createFakeEngine();
    const onTrackStep = vi.fn();
    const wrapped = bindDesktopMediaSession(engine, session, { onTrackStep });

    // Does NOT eagerly call engine.subscribe before PlaybackService subscribes (preserves heldEvents!)
    expect(subscribeSpy).not.toHaveBeenCalled();

    const received: EngineEvent[] = [];
    const unsub = wrapped.subscribe((ev) => received.push(ev));
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    // Typed metadata pushed before load() is preserved across load() and sanitizes artwork URL
    wrapped.setMediaMetadata({
      title: 'Synthetic Movie',
      subtitle: '2026 · Sci-Fi',
      artworkUrl: 'https://demo:secret@cdn.example.test/poster.jpg?token=abc&w=512',
      kind: 'vod',
      canStepTrack: false,
    });

    wrapped.load({
      attempt: 7,
      kind: 'vod',
      url: 'http://sim.example.test/vod.mp4',
      headers: {},
    });

    emit({ attempt: 7, type: 'state', state: 'playing' });
    emit({
      attempt: 7,
      type: 'clock',
      anchor: { positionMs: 30_000, atMs: 1000, rate: 1, durationMs: 120_000 },
    });

    expect(received).toHaveLength(2);
    expect(env.mediaSession.playbackState).toBe('playing');
    const movieMeta = env.mediaSession.metadata as FakeMediaMetadata | null;
    expect(movieMeta?.title).toBe('Synthetic Movie');
    expect(movieMeta?.artist).toBe('2026 · Sci-Fi');
    expect(movieMeta?.artwork).toEqual([{ src: 'https://cdn.example.test/poster.jpg?w=512' }]);
    expect(env.positionCalls.at(-1)).toEqual({ duration: 120, position: 30, playbackRate: 1 });

    // Standalone single-movie VOD MUST omit previoustrack & nexttrack while keeping seek actions
    expect(env.handlers.get('previoustrack')).toBeNull();
    expect(env.handlers.get('nexttrack')).toBeNull();
    env.trigger('nexttrack');
    env.trigger('previoustrack');
    expect(onTrackStep).not.toHaveBeenCalled();

    wrapped.pause(8);
    emit({ attempt: 8, type: 'state', state: 'paused' });
    expect(env.mediaSession.playbackState).toBe('paused');
    // Stale event from attempt 7 is ignored!
    emit({ attempt: 7, type: 'state', state: 'playing' });
    expect(env.mediaSession.playbackState).toBe('paused');

    wrapped.play(9);
    emit({ attempt: 9, type: 'state', state: 'playing' });
    expect((env.mediaSession.metadata as FakeMediaMetadata | null)?.title).toBe('Synthetic Movie');

    // setSpeed forwards cleanly and updates activeAttempt for subsequent OS media key callbacks
    wrapped.setSpeed(15, 1.5);
    expect(engine.setSpeed).toHaveBeenCalledWith(15, 1.5);
    env.trigger('pause');
    expect(engine.pause).toHaveBeenCalledWith(15);

    // Non-attempt desktop IPC methods pass through unchanged
    wrapped.setDeinterlace(true);
    expect(engine.setDeinterlace).toHaveBeenCalledWith(true);
    wrapped.setHwdec('auto-copy');
    expect(engine.setHwdec).toHaveBeenCalledWith('auto-copy');

    wrapped.play(9);
    env.trigger('pause');
    expect(engine.pause).toHaveBeenCalledWith(9);
    env.trigger('play');
    expect(engine.play).toHaveBeenCalledWith(9);
    env.trigger('seekforward', { seekOffset: 10 });
    expect(engine.seek).toHaveBeenCalledWith(9, 40_000);
    env.trigger('seekbackward', { seekOffset: 5 });
    expect(engine.seek).toHaveBeenCalledWith(9, 25_000);
    env.trigger('seekto', { seekTime: 90 });
    expect(engine.seek).toHaveBeenCalledWith(9, 90_000);
    env.trigger('stop');
    expect(engine.stop).toHaveBeenCalledWith(9);

    // Episodic VOD (canStepTrack: true) registers previoustrack & nexttrack and defaults artist to ELV IPTV
    wrapped.setMediaMetadata({
      title: 'Episode 1',
      artworkUrl: 'file:///etc/passwd',
      kind: 'vod',
      canStepTrack: true,
    });
    const epMeta = env.mediaSession.metadata as FakeMediaMetadata | null;
    expect(epMeta?.title).toBe('Episode 1');
    expect(epMeta?.artist).toBe('ELV IPTV');
    expect(epMeta?.artwork).toEqual([]);
    env.trigger('nexttrack');
    env.trigger('previoustrack');
    expect(onTrackStep).toHaveBeenNthCalledWith(1, 'next');
    expect(onTrackStep).toHaveBeenNthCalledWith(2, 'previous');

    // Switching VOD -> multi-channel Live clears stale VOD position state, omits seek handlers, and keeps track step
    env.positionCalls.length = 0;
    wrapped.load({
      attempt: 10,
      kind: 'live',
      url: 'http://sim.example.test/live.ts',
      headers: {},
    });
    wrapped.setMediaMetadata({
      title: 'Channel One',
      subtitle: 'Evening News',
      kind: 'live',
      canStepTrack: true,
    });
    expect(env.positionCalls).toEqual([undefined]);
    expect(env.handlers.get('seekforward')).toBeNull();
    expect(env.handlers.get('seekbackward')).toBeNull();
    expect(env.handlers.get('seekto')).toBeNull();
    expect(env.handlers.get('nexttrack')).toBeTypeOf('function');
    expect(env.handlers.get('previoustrack')).toBeTypeOf('function');
    // Live clock events never push VOD position state
    emit({
      attempt: 10,
      type: 'clock',
      anchor: { positionMs: 5_000, atMs: 2000, rate: 1, durationMs: 60_000 },
    });
    expect(env.positionCalls).toEqual([undefined]);

    // Ended clears position state and sets playbackState to 'none'
    wrapped.seek(11, 5_000);
    wrapped.recreate(12);
    emit({ attempt: 12, type: 'state', state: 'ended' });
    expect(env.mediaSession.playbackState).toBe('none');
    expect(env.positionCalls.at(-1)).toBeUndefined();

    // setMediaMetadata(null) clears metadata and handlers cleanly
    wrapped.setMediaMetadata(null);
    expect(env.mediaSession.metadata).toBeNull();
    expect(env.mediaSession.playbackState).toBe('none');
    expect(env.handlers.get('nexttrack')).toBeNull();
    expect(env.handlers.get('previoustrack')).toBeNull();

    // Release disposes mediaSession cleanly
    unsub();
    wrapped.release();
    expect(engine.release).toHaveBeenCalledTimes(1);
    expect(env.mediaSession.playbackState).toBe('none');
    expect(env.mediaSession.metadata).toBeNull();
  });

  it('forwards onFrame to the underlying DesktopEngine and returns a no-op when absent', () => {
    const env = createFakeMediaSessionEnv();
    const session = createDesktopMediaSession({
      navigator: env.navigator,
      MediaMetadata: FakeMediaMetadata,
    });
    const { engine } = createFakeEngine();
    const offFrame = vi.fn();
    engine.onFrame = vi.fn(() => offFrame);

    const wrapped = bindDesktopMediaSession(engine, session);
    const frameListener = vi.fn();
    const off = wrapped.onFrame?.(frameListener);
    expect(engine.onFrame).toHaveBeenCalledWith(frameListener);
    off?.();
    expect(offFrame).toHaveBeenCalledTimes(1);

    // When underlying engine omits onFrame, wrapper still returns a safe no-op unsubscribe.
    const { engine: legacyEngine } = createFakeEngine();
    const wrappedLegacy = bindDesktopMediaSession(legacyEngine, session);
    const noop = wrappedLegacy.onFrame?.(vi.fn());
    expect(noop).toBeTypeOf('function');
    expect(() => noop?.()).not.toThrow();
  });
});
