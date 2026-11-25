import type {
  AetherMediaMetadata,
  AetherRemoteMediaAction,
  AppleHardwareKey,
} from '@elv/engine-aether';
import type {
  AndroidDeviceMemoryInfo,
  AndroidMediaMetadata,
  AndroidPipSourceRect,
  AndroidRemoteMediaAction,
  Media3EngineOptions,
} from '@elv/engine-media3';
import type {
  OpenVideoEngine,
  PipSourceRect,
  VideoHost,
  VideoHostOpenOptions,
  VideoSurfaceProps,
} from '@elv/features';
import type { EngineEvent, PlayerEngine } from '@elv/playback';
import type { ReactElement } from 'react';
import type { TelemetryPort } from './sync/sync-runtime';

/** Minimal tvOS Siri Remote pan-gesture source bridged from `@elv/remote-keys`. */
interface MobileTvPanGestureSource {
  setEnabled(enabled: boolean): void;
  addListener(
    listener: NonNullable<OpenVideoEngine['onTvPanGesture']> extends (cb: infer L) => () => void
      ? L
      : never,
  ): { remove(): void };
}

/** Collaborators injected into {@link createMobileVideoHost} for `tv-mobile`. */
export interface MobileVideoHostDeps {
  readonly os: string;
  readonly isTV: boolean;
  readonly createEngine: (options?: Media3EngineOptions) => PlayerEngine | null;
  readonly renderSurface: (engine: PlayerEngine, props: VideoSurfaceProps) => ReactElement | null;
  readonly getAndroidDeviceMemoryInfo: () => AndroidDeviceMemoryInfo;
  readonly configureMedia3MultiView: (engine: PlayerEngine, options: Media3EngineOptions) => void;
  readonly setOrientationLocked: (locked: boolean) => void;
  readonly requestTemporaryOrientation: (landscape: boolean) => void;
  readonly setMedia3PitchLock: (engine: PlayerEngine, locked: boolean) => void;
  readonly setMedia3MediaMetadata: (
    engine: PlayerEngine,
    metadata: AndroidMediaMetadata | null,
  ) => void;
  readonly setMedia3BackgroundAudioEnabled: (engine: PlayerEngine, enabled: boolean) => void;
  readonly subscribeMedia3RemoteMediaAction: (
    engine: PlayerEngine,
    listener: (action: AndroidRemoteMediaAction) => void,
  ) => () => void;
  readonly enterAndroidPictureInPicture: (
    aspectWidth?: number,
    aspectHeight?: number,
    sourceRect?: AndroidPipSourceRect,
  ) => boolean;
  readonly setAndroidAutoEnterPictureInPicture: (
    enabled: boolean,
    aspectWidth?: number,
    aspectHeight?: number,
    sourceRect?: AndroidPipSourceRect,
  ) => boolean;
  readonly subscribeAndroidPictureInPicture: (listener: (inPip: boolean) => void) => () => void;
  readonly setAetherMediaMetadata: (
    engine: PlayerEngine,
    metadata: AetherMediaMetadata | null,
  ) => void;
  readonly setAetherBackgroundAudioEnabled: (engine: PlayerEngine, enabled: boolean) => void;
  readonly configureAetherMultiView: (engine: PlayerEngine, handleAudioFocus: boolean) => void;
  readonly subscribeAetherRemoteMediaAction: (
    engine: PlayerEngine,
    listener: (action: AetherRemoteMediaAction) => void,
  ) => () => void;
  readonly subscribeAppleHardwareKeys: (listener: (key: AppleHardwareKey) => void) => () => void;
  readonly setAppleEngineMuted: (engine: PlayerEngine, muted: boolean) => void;
  readonly setAppleEngineVolume: (engine: PlayerEngine, volume: number) => void;
  readonly enterAetherPictureInPicture: (engine?: PlayerEngine) => boolean;
  readonly canStartAetherPictureInPicture: (engine?: PlayerEngine) => boolean;
  readonly setAetherAutoEnterPictureInPicture: (enabled: boolean, engine?: PlayerEngine) => boolean;
  readonly subscribeAetherPictureInPicture: (listener: (inPip: boolean) => void) => () => void;
  readonly panGestures: MobileTvPanGestureSource | null;
  readonly telemetry?: Pick<
    TelemetryPort,
    'isOptedIn' | 'recordMediaDecodeFailure' | 'recordPlaybackError'
  >;
}

function toMedia3EngineOptions(
  options: VideoHostOpenOptions | undefined,
): Media3EngineOptions | undefined {
  if (
    options === undefined ||
    (options.handleAudioFocus === undefined && options.multiViewTileCount === undefined)
  ) {
    return undefined;
  }
  return {
    ...(options.handleAudioFocus !== undefined
      ? { handleAudioFocus: options.handleAudioFocus }
      : {}),
    ...(options.multiViewTileCount !== undefined
      ? { multiViewTileCount: options.multiViewTileCount }
      : {}),
  };
}

function mapRemoteMediaAction(
  action: AndroidRemoteMediaAction | AetherRemoteMediaAction,
): 'channel-up' | 'channel-down' | 'stop' {
  return action === 'next' ? 'channel-up' : action === 'previous' ? 'channel-down' : 'stop';
}

const SAFE_CODEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const KNOWN_CONTAINERS = ['mpegts', 'hls', 'mkv', 'mp4', 'dash', 'webm', 'flv'] as const;

function sanitizeCodecToken(raw: string | undefined): string {
  if (typeof raw !== 'string') return 'unknown';
  const stripped = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:video|audio)\//, '');
  return SAFE_CODEC_RE.test(stripped) ? stripped : 'unknown';
}

function inferContainerFromDetail(detail: string | undefined, isLiveTs: boolean): string {
  if (isLiveTs) return 'mpegts';
  if (typeof detail === 'string') {
    const lower = detail.toLowerCase();
    for (const token of KNOWN_CONTAINERS) {
      if (lower.includes(token)) return token;
    }
    if (lower.includes('m3u8')) return 'hls';
    if (lower.includes('matroska')) return 'mkv';
  }
  return 'unknown';
}

function attachEngineTelemetryObserver(
  engine: PlayerEngine,
  engineName: string,
  telemetry: Pick<TelemetryPort, 'isOptedIn' | 'recordMediaDecodeFailure' | 'recordPlaybackError'>,
): void {
  if (typeof engine.subscribe !== 'function') return;
  let lastAttempt = -1;
  let isLive = true;
  let isLiveTs = false;
  let videoCodec = 'unknown';
  let audioCodec = 'unknown';
  let hdrFormat: string | undefined;

  engine.subscribe((event: EngineEvent) => {
    if (event.attempt !== lastAttempt) {
      lastAttempt = event.attempt;
      isLive = true;
      isLiveTs = false;
      videoCodec = 'unknown';
      audioCodec = 'unknown';
      hdrFormat = undefined;
    }
    if (event.type === 'clock') {
      if (event.anchor.isLiveTs === true) {
        isLive = true;
        isLiveTs = true;
      } else if (event.anchor.liveEdgeMs !== undefined) {
        isLive = true;
      } else if (event.anchor.durationMs !== undefined && event.anchor.durationMs > 0) {
        isLive = false;
      }
      return;
    }
    if (event.type === 'mediaInfo') {
      if (event.info.codec !== undefined) videoCodec = sanitizeCodecToken(event.info.codec);
      if (event.info.hdr !== undefined) hdrFormat = event.info.hdr;
      return;
    }
    if (event.type === 'tracks') {
      const selected =
        event.tracks.audio.find((t) => t.id === event.tracks.selectedAudioId) ??
        event.tracks.audio[0];
      if (selected?.codec !== undefined) audioCodec = sanitizeCodecToken(selected.codec);
      return;
    }
    if (event.type === 'error') {
      if (!telemetry.isOptedIn()) return;
      const code = event.error.code;
      if (code === 'decoder' || code === 'unsupported-format') {
        telemetry.recordMediaDecodeFailure({
          engine: engineName,
          container: inferContainerFromDetail(event.error.detail, isLiveTs),
          videoCodec,
          audioCodec,
          errorCode: code,
          ...(hdrFormat !== undefined ? { hdrFormat } : {}),
          isLive,
        });
      } else {
        telemetry.recordPlaybackError({
          engine: engineName,
          errorCode: code,
          isLive,
        });
      }
    }
  });
}

/** Synchronous mobile/TV {@link VideoHost} returned by {@link createMobileVideoHost}. */
export interface MobileVideoHost extends VideoHost {
  open(options?: VideoHostOpenOptions): OpenVideoEngine | null;
}

/**
 * Creates the `tv-mobile` {@link VideoHost} with Android & Apple Picture-in-Picture,
 * Multi-View engine options (`handleAudioFocus`, `multiViewTileCount`), mute/primary routing,
 * and low-RAM Multi-View capability gating (`#34`, `#221`, `#232`).
 */
export function createMobileVideoHost(deps: MobileVideoHostDeps): MobileVideoHost {
  const isAndroid = deps.os === 'android';
  const isApple = deps.os === 'ios';
  const isAndroidMobile = isAndroid && !deps.isTV;
  const isAppleMobile = isApple && !deps.isTV;
  const supportsMultiView = isAndroid ? !deps.getAndroidDeviceMemoryInfo().lowRam : isApple;

  return {
    supportsMultiView,
    open(options?: VideoHostOpenOptions): OpenVideoEngine | null {
      const engine = deps.createEngine(toMedia3EngineOptions(options));
      if (engine === null) return null;

      if (deps.telemetry !== undefined) {
        attachEngineTelemetryObserver(
          engine,
          isAndroid ? 'media3' : isApple ? 'aether' : deps.os,
          deps.telemetry,
        );
      }

      let appleMuted = options?.handleAudioFocus === false;
      const tileCount = options?.multiViewTileCount ?? 1;
      const isMultiView =
        options?.replaceExisting === false ||
        options?.handleAudioFocus !== undefined ||
        tileCount > 1;

      return {
        engine,
        renderSurface: (props) => deps.renderSurface(engine, props),
        ...(isApple
          ? {
              setMediaMetadata: (metadata) => deps.setAetherMediaMetadata(engine, metadata),
              setBackgroundAudioEnabled: (enabled) =>
                deps.setAetherBackgroundAudioEnabled(engine, enabled),
              onHostKey: (listener) => {
                const unsubRemote = deps.subscribeAetherRemoteMediaAction(engine, (action) =>
                  listener(mapRemoteMediaAction(action)),
                );
                const unsubKeyboard = isAppleMobile
                  ? deps.subscribeAppleHardwareKeys(listener)
                  : undefined;
                return () => {
                  unsubRemote();
                  unsubKeyboard?.();
                };
              },
              toggleMute: () => {
                appleMuted = !appleMuted;
                deps.setAppleEngineMuted(engine, appleMuted);
              },
              setMuted: (muted: boolean) => {
                appleMuted = muted;
                deps.setAppleEngineMuted(engine, muted);
                if (isMultiView && muted) {
                  deps.configureAetherMultiView(engine, false);
                }
              },
              setPrimary: () => {
                appleMuted = false;
                deps.setAppleEngineMuted(engine, false);
                deps.configureAetherMultiView(engine, true);
              },
              setVolume: (volume: number) => deps.setAppleEngineVolume(engine, volume),
              enterPictureInPicture: () => deps.enterAetherPictureInPicture(engine),
              canStartPictureInPicture: () => deps.canStartAetherPictureInPicture(engine),
              setAutoEnterPictureInPicture: (enabled: boolean) =>
                deps.setAetherAutoEnterPictureInPicture(enabled, engine),
              onPictureInPictureChange: deps.subscribeAetherPictureInPicture,
              setDisplaySync: (policy) => engine.setDisplaySync?.(policy),
            }
          : {}),
        ...(deps.panGestures !== null
          ? {
              setTvPanGestureEnabled: (enabled) => deps.panGestures?.setEnabled(enabled),
              onTvPanGesture: (listener) => {
                const sub = deps.panGestures?.addListener(listener);
                return () => {
                  sub?.remove();
                };
              },
            }
          : {}),
        ...(isAndroid
          ? {
              setOrientationLocked: deps.setOrientationLocked,
              setPitchLock: (locked) => deps.setMedia3PitchLock(engine, locked),
              setMediaMetadata: (metadata) => deps.setMedia3MediaMetadata(engine, metadata),
              setBackgroundAudioEnabled: (enabled) =>
                deps.setMedia3BackgroundAudioEnabled(engine, enabled),
              setMuted: (muted: boolean) =>
                deps.configureMedia3MultiView(engine, {
                  handleAudioFocus: !muted,
                  multiViewTileCount: tileCount,
                }),
              setPrimary: () =>
                deps.configureMedia3MultiView(engine, {
                  handleAudioFocus: true,
                  multiViewTileCount: tileCount,
                }),
              onHostKey: (listener) =>
                deps.subscribeMedia3RemoteMediaAction(engine, (action) =>
                  listener(mapRemoteMediaAction(action)),
                ),
              setNightModeDrc: (preset) => engine.setNightModeDrc?.(preset),
              setDisplaySync: (policy) => engine.setDisplaySync?.(policy),
            }
          : {}),
        ...(isAndroidMobile
          ? {
              requestTemporaryOrientation: deps.requestTemporaryOrientation,
              enterPictureInPicture: (
                aspectWidth?: number,
                aspectHeight?: number,
                sourceRect?: PipSourceRect,
              ) => deps.enterAndroidPictureInPicture(aspectWidth, aspectHeight, sourceRect),
              setAutoEnterPictureInPicture: (
                enabled: boolean,
                aspectWidth?: number,
                aspectHeight?: number,
                sourceRect?: PipSourceRect,
              ) =>
                deps.setAndroidAutoEnterPictureInPicture(
                  enabled,
                  aspectWidth,
                  aspectHeight,
                  sourceRect,
                ),
              onPictureInPictureChange: deps.subscribeAndroidPictureInPicture,
            }
          : {}),
      };
    },
  };
}
