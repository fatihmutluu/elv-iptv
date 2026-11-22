import type { MediaSessionMetadata } from '@elv/features';
import type { AttemptToken, EngineEvent, MediaKind } from '@elv/playback';
import type { DesktopEngine } from './player/desktop-engine.ts';

type MediaSessionPlaybackStateValue = 'none' | 'paused' | 'playing';

/** W3C MediaSession action names registered by {@link createDesktopMediaSession}. */
export type MediaSessionActionName =
  | 'play'
  | 'pause'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'previoustrack'
  | 'nexttrack'
  | 'stop';

/** Minimal action details delivered by `navigator.mediaSession` callbacks. */
export interface MediaSessionActionDetailsLike {
  readonly seekOffset?: number;
  readonly seekTime?: number;
  readonly fastSeek?: boolean;
}

/** Minimal position state accepted by `navigator.mediaSession.setPositionState`. */
export interface MediaSessionPositionStateLike {
  readonly duration?: number;
  readonly playbackRate?: number;
  readonly position?: number;
}

/** Minimal `MediaMetadataInit` payload passed to `MediaMetadata`. */
export interface MediaMetadataInitLike {
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly artwork?: readonly { readonly src: string }[];
}

type MediaMetadataConstructorLike = new (init: MediaMetadataInitLike) => unknown;

/** Minimal `navigator.mediaSession` surface. */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState: MediaSessionPlaybackStateValue;
  setActionHandler(
    action: MediaSessionActionName,
    handler: ((details?: MediaSessionActionDetailsLike) => void) | null,
  ): void;
  setPositionState?(state?: MediaSessionPositionStateLike): void;
}

interface MediaSessionNavigatorLike {
  readonly mediaSession?: MediaSessionLike | null;
}

interface DesktopMediaMetadataInput {
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly artworkUrl?: string;
}

interface DesktopMediaPositionState {
  readonly durationSec: number;
  readonly positionSec: number;
  readonly playbackRate?: number;
}

interface DesktopMediaSessionHandlers {
  readonly play?: () => void;
  readonly pause?: () => void;
  readonly seekBackward?: (seekOffsetSec?: number) => void;
  readonly seekForward?: (seekOffsetSec?: number) => void;
  readonly seekTo?: (seekTimeSec: number, fastSeek?: boolean) => void;
  readonly previousTrack?: () => void;
  readonly nextTrack?: () => void;
  readonly stop?: () => void;
}

/** Options for {@link createDesktopMediaSession}. */
export interface DesktopMediaSessionOptions {
  readonly navigator?: MediaSessionNavigatorLike | null;
  readonly MediaMetadata?: MediaMetadataConstructorLike | null;
}

/** Safe wrapper over desktop `navigator.mediaSession` for OS media keys and now-playing UI (#166). */
export interface DesktopMediaSession {
  setMetadata(input: DesktopMediaMetadataInput): void;
  setPlaybackState(state: MediaSessionPlaybackStateValue): void;
  setPositionState(input: DesktopMediaPositionState): void;
  clearPositionState(): void;
  setHandlers(handlers: DesktopMediaSessionHandlers): void;
  clear(): void;
  dispose(): void;
}

const ALL_ACTIONS = 'play pause seekbackward seekforward seekto previoustrack nexttrack stop'.split(
  ' ',
) as MediaSessionActionName[];

const CREDENTIAL_QUERY_KEYS = new Set(
  'username password user pass token access_token api_key apikey auth key secret sig signature'.split(
    ' ',
  ),
);

const DEFAULT_SEEK_STEP_SEC = 10;

/**
 * Validates and sanitizes an artwork URL before handing it to OS media overlays: accepts only
 * `http:` / `https:` URLs and strips embedded userinfo and credential query parameters.
 */
export function sanitizeMediaArtworkUrl(rawUrl?: string): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // Ignore browser MediaSession TypeError or unsupported-action failures.
  }
}

/**
 * Creates a safe desktop `navigator.mediaSession` adapter with credential-stripped artwork URLs,
 * finite clamped VOD position updates, and automatic teardown on `clear()` / `dispose()` (#166).
 */
export function createDesktopMediaSession(
  options?: DesktopMediaSessionOptions,
): DesktopMediaSession {
  const nav =
    options && 'navigator' in options
      ? options.navigator
      : typeof navigator !== 'undefined'
        ? (navigator as unknown as MediaSessionNavigatorLike)
        : null;
  const mediaSession = nav?.mediaSession ?? null;
  const MetadataCtor =
    options && 'MediaMetadata' in options
      ? options.MediaMetadata
      : typeof MediaMetadata !== 'undefined'
        ? (MediaMetadata as unknown as MediaMetadataConstructorLike)
        : null;

  let disposed = false;

  const setAction = (
    action: MediaSessionActionName,
    handler: ((details?: MediaSessionActionDetailsLike) => void) | null,
  ): void => {
    if (mediaSession) safeCall(() => mediaSession.setActionHandler(action, handler));
  };

  const clearPosition = (): void => {
    if (mediaSession) safeCall(() => mediaSession.setPositionState?.());
  };

  const setPlayback = (state: MediaSessionPlaybackStateValue): void => {
    if (!mediaSession) return;
    safeCall(() => {
      mediaSession.playbackState = state;
    });
  };

  const clearSession = (): void => {
    if (!mediaSession) return;
    safeCall(() => {
      mediaSession.metadata = null;
    });
    setPlayback('none');
    clearPosition();
    for (const action of ALL_ACTIONS) setAction(action, null);
  };

  return {
    setMetadata(input) {
      if (disposed || !mediaSession || !MetadataCtor) return;
      const safeArtwork = sanitizeMediaArtworkUrl(input.artworkUrl);
      safeCall(() => {
        mediaSession.metadata = new MetadataCtor({
          title: input.title,
          artist: input.artist ?? '',
          album: input.album ?? '',
          artwork: safeArtwork ? [{ src: safeArtwork }] : [],
        });
      });
    },
    setPlaybackState(state) {
      if (!disposed) setPlayback(state);
    },
    setPositionState(input) {
      if (disposed || !mediaSession?.setPositionState) return;
      if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) return;
      if (!Number.isFinite(input.positionSec)) return;
      const position = Math.min(input.durationSec, Math.max(0, input.positionSec));
      const rate = input.playbackRate;
      const playbackRate = rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : 1;
      safeCall(() =>
        mediaSession.setPositionState?.({ duration: input.durationSec, position, playbackRate }),
      );
    },
    clearPositionState() {
      if (!disposed) clearPosition();
    },
    setHandlers(h) {
      if (disposed || !mediaSession) return;
      setAction('play', h.play ? () => h.play?.() : null);
      setAction('pause', h.pause ? () => h.pause?.() : null);
      setAction('seekbackward', h.seekBackward ? (d) => h.seekBackward?.(d?.seekOffset) : null);
      setAction('seekforward', h.seekForward ? (d) => h.seekForward?.(d?.seekOffset) : null);
      setAction(
        'seekto',
        h.seekTo
          ? (d) => {
              if (typeof d?.seekTime === 'number' && Number.isFinite(d.seekTime)) {
                h.seekTo?.(d.seekTime, d.fastSeek);
              }
            }
          : null,
      );
      setAction('previoustrack', h.previousTrack ? () => h.previousTrack?.() : null);
      setAction('nexttrack', h.nextTrack ? () => h.nextTrack?.() : null);
      setAction('stop', h.stop ? () => h.stop?.() : null);
    },
    clear() {
      if (!disposed) clearSession();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSession();
    },
  };
}

/** Hooks for {@link bindDesktopMediaSession}. */
export interface BindDesktopMediaSessionHooks {
  readonly onTrackStep?: (direction: 'next' | 'previous') => void;
}

/** A {@link DesktopEngine} wrapped with typed OS `MediaSession` synchronization (`#166`, `#435`). */
export interface MediaSessionBoundDesktopEngine extends DesktopEngine {
  /** Updates OS media metadata from typed playback metadata, or clears it when `null`. */
  setMediaMetadata(meta: MediaSessionMetadata | null): void;
}

/**
 * Wraps a {@link DesktopEngine} so live desktop playback mirrors state, typed metadata, and VOD
 * timeline progress to `navigator.mediaSession` and routes OS hardware media keys without eagerly
 * draining `DesktopEngine`'s initial `heldEvents` buffer before `PlaybackService` subscribes.
 */
export function bindDesktopMediaSession(
  engine: DesktopEngine,
  session: DesktopMediaSession,
  hooks?: BindDesktopMediaSessionHooks,
): MediaSessionBoundDesktopEngine {
  let activeAttempt: AttemptToken | null = null;
  let activeKind: MediaKind = 'live';
  let activeMeta: MediaSessionMetadata | null = null;
  let lastPositionMs = 0;
  let lastDurationMs: number | undefined;

  const syncMetadata = (): void => {
    session.setMetadata({
      title: activeMeta?.title.trim() || 'ELV IPTV',
      artist: activeMeta?.subtitle?.trim() || 'ELV IPTV',
      ...(activeMeta?.artworkUrl ? { artworkUrl: activeMeta.artworkUrl } : {}),
    });
  };

  const seekBy = (deltaSec: number): void => {
    if (activeAttempt === null || !lastDurationMs) return;
    const targetMs = Math.max(0, Math.min(lastDurationMs, lastPositionMs + deltaSec * 1000));
    engine.seek(activeAttempt, targetMs);
  };

  const syncHandlers = (): void => {
    session.setHandlers({
      play: () => activeAttempt !== null && engine.play(activeAttempt),
      pause: () => activeAttempt !== null && engine.pause(activeAttempt),
      stop: () => activeAttempt !== null && engine.stop(activeAttempt),
      ...(activeKind === 'vod'
        ? {
            seekBackward: (offsetSec) => seekBy(-(offsetSec ?? DEFAULT_SEEK_STEP_SEC)),
            seekForward: (offsetSec) => seekBy(offsetSec ?? DEFAULT_SEEK_STEP_SEC),
            seekTo: (seekTimeSec) => {
              if (activeAttempt === null || !lastDurationMs) return;
              engine.seek(activeAttempt, Math.max(0, Math.min(lastDurationMs, seekTimeSec * 1000)));
            },
          }
        : {}),
      ...(activeMeta?.canStepTrack === true && hooks?.onTrackStep
        ? {
            previousTrack: () => hooks.onTrackStep?.('previous'),
            nextTrack: () => hooks.onTrackStep?.('next'),
          }
        : {}),
    });
  };

  const observeEvent = (event: EngineEvent): void => {
    if (activeAttempt !== null && event.attempt !== activeAttempt) return;
    if (event.type === 'state') {
      if (event.state === 'playing') {
        syncMetadata();
        session.setPlaybackState('playing');
      } else if (event.state === 'paused') {
        session.setPlaybackState('paused');
      } else if (event.state === 'ended') {
        session.setPlaybackState('none');
        session.clearPositionState();
      }
      return;
    }
    if (event.type === 'clock') {
      lastPositionMs = event.anchor.positionMs;
      lastDurationMs = event.anchor.durationMs;
      if (activeKind === 'vod' && lastDurationMs !== undefined && lastDurationMs > 0) {
        session.setPositionState({
          durationSec: lastDurationMs / 1000,
          positionSec: lastPositionMs / 1000,
          playbackRate: event.anchor.rate,
        });
      }
    }
  };

  const track =
    <A extends unknown[]>(fn: (attempt: AttemptToken, ...args: A) => void) =>
    (attempt: AttemptToken, ...args: A): void => {
      activeAttempt = attempt;
      fn(attempt, ...args);
    };

  return {
    ...engine,
    setMediaMetadata(meta) {
      activeMeta = meta;
      if (meta === null) {
        session.clear();
        return;
      }
      if (meta.kind === 'live' && activeKind !== 'live') session.clearPositionState();
      activeKind = meta.kind;
      syncMetadata();
      syncHandlers();
    },
    load(cmd) {
      activeAttempt = cmd.attempt;
      activeKind = cmd.kind;
      lastPositionMs = cmd.startMs ?? 0;
      lastDurationMs = undefined;
      if (cmd.kind === 'live') session.clearPositionState();
      syncMetadata();
      syncHandlers();
      engine.load(cmd);
    },
    retry: track((a) => engine.retry(a)),
    play: track((a) => engine.play(a)),
    pause: track((a) => engine.pause(a)),
    seek: track((a, positionMs: number) => engine.seek(a, positionMs)),
    setSpeed: track((a, rate: number) => engine.setSpeed(a, rate)),
    recreate: track((a) => engine.recreate(a)),
    stop(attempt) {
      activeAttempt = attempt;
      session.setPlaybackState('none');
      session.clearPositionState();
      engine.stop(attempt);
    },
    release() {
      activeMeta = null;
      session.dispose();
      engine.release();
    },
    subscribe(listener) {
      return engine.subscribe((event) => {
        observeEvent(event);
        listener(event);
      });
    },
    onFrame: (listener) => engine.onFrame?.(listener) ?? (() => undefined),
  };
}
