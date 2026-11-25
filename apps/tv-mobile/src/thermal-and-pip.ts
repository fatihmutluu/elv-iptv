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
import type { PlayerEngine } from '@elv/playback';
import type { ReactElement } from 'react';

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
