import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerBridge, PlayerCommandMessage } from '../../../src/shared/player-ipc.ts';
import type { WindowBridge } from '../../../src/shared/window-ipc.ts';
import type {
  MediaMetadataInitLike,
  MediaSessionActionDetailsLike,
  MediaSessionActionName,
  MediaSessionLike,
} from '../media-session.ts';
import { createDesktopVideoHost } from './desktop-video-host.tsx';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: <T>(s: T): T => s },
}));

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

function stubGlobalMediaSession() {
  const handlers = new Map<
    MediaSessionActionName,
    ((details?: MediaSessionActionDetailsLike) => void) | null
  >();
  const mediaSession: MediaSessionLike = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) {
      handlers.set(action, handler);
    },
    setPositionState() {
      // no-op
    },
  };
  vi.stubGlobal('navigator', { mediaSession });
  vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
  return {
    mediaSession,
    handlers,
    trigger(action: MediaSessionActionName, details?: MediaSessionActionDetailsLike) {
      handlers.get(action)?.(details);
    },
  };
}

function fakePlayerBridge() {
  let seq = 0;
  const sent: PlayerCommandMessage[] = [];
  const eventListeners = new Set<(message: { engineId: string; event: EngineEvent }) => void>();
  const open = vi.fn(async () => ({ engineId: `engine-${++seq}`, mainNowMs: 100 }));
  const close = vi.fn(async () => undefined);
  const setPrimary = vi.fn(async () => undefined);
  const bridge: PlayerBridge = {
    open,
    close,
    setPrimary,
    send: (m) => void sent.push(m),
    setArea: () => undefined,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onUi: () => () => undefined,
    onRemoteMediaAction: () => () => undefined,
    reportGate: () => undefined,
  };
  const emitEvent = (engineId: string, event: EngineEvent) => {
    for (const listener of [...eventListeners]) listener({ engineId, event });
  };
  return { bridge, sent, open, close, setPrimary, emitEvent };
}

function fakeWindowBridge(): WindowBridge {
  return {
    setAlwaysOnTop: vi.fn(async (flag: boolean) => flag),
    getAlwaysOnTop: vi.fn(async () => false),
    onAlwaysOnTopChanged: () => () => undefined,
    setAspectRatioLock: vi.fn(async (flag: boolean) => flag),
    setMinimizeToTray: vi.fn(async (flag: boolean) => flag),
    openPopout: vi.fn(async () => true),
    closePopout: vi.fn(async () => undefined),
    getPopoutPayload: vi.fn(async () => null),
    onPopoutPayload: () => () => undefined,
    dockPopout: vi.fn(async () => undefined),
    onPopoutDocked: () => () => undefined,
    onWindowRestored: () => () => undefined,
    onHiddenToTray: () => () => undefined,
  };
}

describe('createDesktopVideoHost (#34)', () => {
  it('sets supportsMultiView true only when presenterKind is canvas', () => {
    const pb = fakePlayerBridge().bridge;
    expect(
      createDesktopVideoHost({ playerBridge: pb, presenterKind: 'canvas' }).supportsMultiView,
    ).toBe(true);
    expect(
      createDesktopVideoHost({ playerBridge: pb, presenterKind: 'child-window' }).supportsMultiView,
    ).toBe(false);
    expect(
      createDesktopVideoHost({ playerBridge: pb, presenterKind: 'own-window' }).supportsMultiView,
    ).toBe(false);
    expect(createDesktopVideoHost({ playerBridge: pb }).supportsMultiView).toBe(false);
  });

  it('forwards replaceExisting/primary open options and exposes setMuted & setPrimary on OpenVideoEngine', async () => {
    const fake = fakePlayerBridge();
    const wb = fakeWindowBridge();
    const host = createDesktopVideoHost({
      playerBridge: fake.bridge,
      windowBridge: wb,
      presenterKind: 'canvas',
    });

    const opened = await host.open({ replaceExisting: false, primary: false });
    expect(opened).not.toBeNull();
    expect(fake.open).toHaveBeenCalledWith({ replaceExisting: false, primary: false });

    opened?.setMuted?.(true);
    opened?.setMuted?.(false);
    opened?.setPrimary?.();

    expect(fake.sent).toContainEqual({
      engineId: 'engine-1',
      command: { name: 'setMuted', muted: true },
    });
    expect(fake.sent).toContainEqual({
      engineId: 'engine-1',
      command: { name: 'setMuted', muted: false },
    });
    expect(fake.setPrimary).toHaveBeenCalledWith('engine-1');

    opened?.engine.release();
  });

  it('returns null when no playerBridge is available', async () => {
    const host = createDesktopVideoHost({ playerBridge: undefined });
    await expect(host.open()).resolves.toBeNull();
  });

  describe('Multi-View navigator.mediaSession ownership (HIGH #1)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('keeps primary mediaSession intact when a secondary tile opens and plays, and when secondary tile releases', async () => {
      const env = stubGlobalMediaSession();
      const fake = fakePlayerBridge();
      const host = createDesktopVideoHost({
        playerBridge: fake.bridge,
        windowBridge: fakeWindowBridge(),
        presenterKind: 'canvas',
      });

      const tile1 = await host.open({ replaceExisting: true, primary: true });
      expect(tile1).not.toBeNull();
      const off1 = tile1?.engine.subscribe(() => undefined);
      tile1?.setMediaMetadata?.({
        title: 'Primary Channel',
        subtitle: 'Live 1',
        kind: 'live',
        canStepTrack: false,
      });
      tile1?.engine.load({
        attempt: 1,
        kind: 'live',
        url: 'http://sim.example.test/1.ts',
        headers: {},
      });
      fake.emitEvent('engine-1', { attempt: 1, type: 'state', state: 'playing' });

      expect((env.mediaSession.metadata as FakeMediaMetadata | null)?.title).toBe(
        'Primary Channel',
      );
      expect(env.mediaSession.playbackState).toBe('playing');

      // Open secondary tile (primary: false)
      const tile2 = await host.open({ replaceExisting: false, primary: false });
      expect(tile2).not.toBeNull();
      const off2 = tile2?.engine.subscribe(() => undefined);
      tile2?.setMediaMetadata?.({
        title: 'Secondary Muted Channel',
        subtitle: 'Live 2',
        kind: 'live',
        canStepTrack: false,
      });
      tile2?.engine.load({
        attempt: 2,
        kind: 'live',
        url: 'http://sim.example.test/2.ts',
        headers: {},
      });
      fake.emitEvent('engine-2', { attempt: 2, type: 'state', state: 'playing' });

      // (a) Secondary tile MUST NOT overwrite navigator.mediaSession metadata or handlers
      expect((env.mediaSession.metadata as FakeMediaMetadata | null)?.title).toBe(
        'Primary Channel',
      );
      expect(env.mediaSession.playbackState).toBe('playing');
      env.trigger('pause');
      expect(fake.sent).toContainEqual({
        engineId: 'engine-1',
        command: { name: 'pause', attempt: 1 },
      });
      expect(fake.sent).not.toContainEqual({
        engineId: 'engine-2',
        command: { name: 'pause', attempt: 2 },
      });

      // (b) Releasing secondary tile MUST NOT clear navigator.mediaSession while primary is playing
      off2?.();
      tile2?.engine.release();
      expect((env.mediaSession.metadata as FakeMediaMetadata | null)?.title).toBe(
        'Primary Channel',
      );
      expect(env.mediaSession.playbackState).toBe('playing');
      expect(env.handlers.get('pause')).toBeTypeOf('function');

      off1?.();
      tile1?.engine.release();
      expect(env.mediaSession.metadata).toBeNull();
      expect(env.mediaSession.playbackState).toBe('none');
    });

    it('transfers navigator.mediaSession ownership cleanly on setPrimary() and skips clear on demoted release', async () => {
      const env = stubGlobalMediaSession();
      const fake = fakePlayerBridge();
      const host = createDesktopVideoHost({
        playerBridge: fake.bridge,
        windowBridge: fakeWindowBridge(),
        presenterKind: 'canvas',
      });

      const tile1 = await host.open({ replaceExisting: true, primary: true });
      const tile2 = await host.open({ replaceExisting: false, primary: false });
      const off1 = tile1?.engine.subscribe(() => undefined);
      const off2 = tile2?.engine.subscribe(() => undefined);

      tile1?.setMediaMetadata?.({
        title: 'Channel One',
        subtitle: 'News',
        kind: 'live',
        canStepTrack: false,
      });
      tile1?.engine.load({
        attempt: 1,
        kind: 'live',
        url: 'http://sim.example.test/1.ts',
        headers: {},
      });
      fake.emitEvent('engine-1', { attempt: 1, type: 'state', state: 'playing' });

      tile2?.setMediaMetadata?.({
        title: 'Channel Two',
        subtitle: 'Sports',
        kind: 'live',
        canStepTrack: false,
      });
      tile2?.engine.load({
        attempt: 2,
        kind: 'live',
        url: 'http://sim.example.test/2.ts',
        headers: {},
      });
      fake.emitEvent('engine-2', { attempt: 2, type: 'state', state: 'playing' });

      // (c) Calling setPrimary() on tile 2 promotes mediaSession ownership cleanly
      tile2?.setPrimary?.();
      expect((env.mediaSession.metadata as FakeMediaMetadata | null)?.title).toBe('Channel Two');
      expect(env.mediaSession.playbackState).toBe('playing');
      env.trigger('pause');
      expect(fake.sent).toContainEqual({
        engineId: 'engine-2',
        command: { name: 'pause', attempt: 2 },
      });

      // Subsequent events or release from demoted tile 1 MUST NOT overwrite or clear tile 2's mediaSession
      fake.emitEvent('engine-1', { attempt: 1, type: 'state', state: 'paused' });
      expect(env.mediaSession.playbackState).toBe('playing');
      off1?.();
      tile1?.engine.release();
      expect((env.mediaSession.metadata as FakeMediaMetadata | null)?.title).toBe('Channel Two');
      expect(env.mediaSession.playbackState).toBe('playing');

      off2?.();
      tile2?.engine.release();
      expect(env.mediaSession.metadata).toBeNull();
      expect(env.mediaSession.playbackState).toBe('none');
    });
  });

  describe('opt-in desktop playback telemetry (MEDIUM #15)', () => {
    it('emits ZERO telemetry when opted out, records media_decode_failure and playback_error when opted in, and unsubscribes on release', async () => {
      const fake = fakePlayerBridge();
      let optedIn = false;
      const telemetry = {
        isOptedIn: vi.fn(() => optedIn),
        recordMediaDecodeFailure: vi.fn(),
        recordPlaybackError: vi.fn(),
      };
      const host = createDesktopVideoHost({
        playerBridge: fake.bridge,
        windowBridge: fakeWindowBridge(),
        presenterKind: 'canvas',
        telemetry,
      });

      const opened = await host.open();
      expect(opened).not.toBeNull();

      // Opted out -> zero calls on playback errors
      fake.emitEvent('engine-1', {
        attempt: 1,
        type: 'error',
        error: { code: 'decoder', detail: 'hevc mpegts decode failed' },
      });
      expect(telemetry.recordMediaDecodeFailure).not.toHaveBeenCalled();
      expect(telemetry.recordPlaybackError).not.toHaveBeenCalled();

      // Opt in -> mediaInfo + tracks + clock + decoder error emits structured media_decode_failure
      optedIn = true;
      fake.emitEvent('engine-1', {
        attempt: 2,
        type: 'clock',
        anchor: { positionMs: 0, atMs: 100, rate: 1, isLiveTs: true },
      });
      fake.emitEvent('engine-1', {
        attempt: 2,
        type: 'mediaInfo',
        info: { codec: 'video/HEVC', hdr: 'hdr10' },
      });
      fake.emitEvent('engine-1', {
        attempt: 2,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a1', label: 'English', codec: 'audio/ac3' }],
          subtitles: [],
          selectedAudioId: 'a1',
          selectedSubtitleId: null,
        },
      });
      fake.emitEvent('engine-1', {
        attempt: 2,
        type: 'error',
        error: { code: 'decoder', detail: 'hwdec failed' },
      });
      expect(telemetry.recordMediaDecodeFailure).toHaveBeenCalledWith({
        engine: 'mpv',
        container: 'mpegts',
        videoCodec: 'hevc',
        audioCodec: 'ac3',
        errorCode: 'decoder',
        hdrFormat: 'hdr10',
        isLive: true,
      });

      // VOD network error emits playback_error with isLive: false
      fake.emitEvent('engine-1', {
        attempt: 3,
        type: 'clock',
        anchor: { positionMs: 5000, durationMs: 3_600_000, atMs: 200, rate: 1 },
      });
      fake.emitEvent('engine-1', {
        attempt: 3,
        type: 'error',
        error: { code: 'http-other', httpStatus: 503 },
      });
      expect(telemetry.recordPlaybackError).toHaveBeenCalledWith({
        engine: 'mpv',
        errorCode: 'http-other',
        isLive: false,
      });

      // After release, subsequent events do not record telemetry
      opened?.engine.release();
      fake.emitEvent('engine-1', {
        attempt: 3,
        type: 'error',
        error: { code: 'network' },
      });
      expect(telemetry.recordPlaybackError).toHaveBeenCalledTimes(1);
    });
  });
});
