import {
  bridgeNativeEngine,
  type EngineCapabilities,
  type NativeEngineHandle,
  type PlayerEngine,
} from '@elv/playback';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { type ComponentType, createElement, type ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** The JS clock of React Native and Node; declared here because the package compiles without DOM types. */
declare const performance: { now(): number };

/** Safe-area edge insets reported by Android `WindowInsetsCompat` (`max(systemBars, displayCutout)` in dp, `#255`). */
export interface AndroidSafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const ZERO_INSETS: AndroidSafeAreaInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

interface RawInsets {
  top?: unknown;
  right?: unknown;
  bottom?: unknown;
  left?: unknown;
}

interface NativeEngineModule {
  Engine: new () => NativeEngineHandle;
  uptimeMs(): number;
  setOrientationLocked?(locked: boolean): void;
  requestTemporaryOrientation?(landscape: boolean): void;
  applyShortEdgesCutoutMode?(): void;
  getSafeAreaInsets?(): RawInsets | null | undefined;
  enterPictureInPicture?(aspectWidth?: number, aspectHeight?: number): boolean;
  addListener?(
    eventName: 'onStandbyChanged' | 'onSafeAreaInsetsChanged' | 'onPictureInPictureChanged',
    listener: (payload: unknown) => void,
  ): { remove(): void };
}

function finiteNonNeg(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeInsets(raw: unknown): AndroidSafeAreaInsets {
  if (typeof raw !== 'object' || raw === null) return ZERO_INSETS;
  const r = raw as RawInsets;
  return {
    top: finiteNonNeg(r.top),
    right: finiteNonNeg(r.right),
    bottom: finiteNonNeg(r.bottom),
    left: finiteNonNeg(r.left),
  };
}

function readBooleanField(payload: unknown, key: string): boolean {
  if (typeof payload === 'boolean') return payload;
  if (typeof payload === 'object' && payload !== null && key in payload) {
    return Boolean((payload as Record<string, unknown>)[key]);
  }
  return false;
}

const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: true,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
});

/** The native shared object behind each live engine this module created; `Media3Surface` binds its view to it. */
const handles = new WeakMap<PlayerEngine, NativeEngineHandle>();

function wrap(module: NativeEngineModule): PlayerEngine {
  const native = new module.Engine();
  const bridged = bridgeNativeEngine(native, {
    capabilities: CAPABILITIES,
    uptimeMs: () => module.uptimeMs(),
    now: () => performance.now(),
  });
  const engine: PlayerEngine = {
    ...bridged,
    release() {
      handles.delete(engine);
      bridged.release();
    },
  };
  handles.set(engine, native);
  return engine;
}

const nativeModule = requireOptionalNativeModule<NativeEngineModule>('ElvEngineMedia3');

/**
 * Creates a Media3 player engine (Android) implementing the `PlayerEngine` port, or returns null where the native
 * module is absent (iOS, web). Each call creates its own native player on its own playback thread; call `release()`
 * when the player screen goes away.
 */
export function createMedia3Engine(): PlayerEngine | null {
  return nativeModule === null ? null : wrap(nativeModule);
}

/** Locks or unlocks the current Android activity orientation for player touch lock (`#440`). */
export function setOrientationLocked(locked: boolean): void {
  nativeModule?.setOrientationLocked?.(locked);
}

/**
 * Requests a temporary landscape or portrait orientation on Android mobile devices that automatically
 * releases back to sensor control once the device physically rotates into alignment (`#266`).
 */
export function requestTemporaryOrientation(landscape: boolean): void {
  nativeModule?.requestTemporaryOrientation?.(landscape);
}

/** Subscribes to debounced Android TV HDMI-CEC / display standby signals (`#143`). */
export function subscribeAndroidStandby(listener: (standby: boolean) => void): () => void {
  const sub = nativeModule?.addListener?.('onStandbyChanged', (payload) => {
    listener(readBooleanField(payload, 'standby'));
  });
  return () => {
    sub?.remove();
  };
}

/** Applies `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` on non-TV Android API >= 28 (`#255`). */
export function applyAndroidShortEdgesCutoutMode(): void {
  nativeModule?.applyShortEdgesCutoutMode?.();
}

/** Reads current Android safe-area insets (`max(systemBars, displayCutout)` in dp, `#255`). */
export function getAndroidSafeAreaInsets(): AndroidSafeAreaInsets {
  return normalizeInsets(nativeModule?.getSafeAreaInsets?.());
}

/** Subscribes to live Android `WindowInsetsCompat` safe-area inset updates (`#255`). */
export function subscribeAndroidSafeAreaInsets(
  listener: (insets: AndroidSafeAreaInsets) => void,
): () => void {
  const sub = nativeModule?.addListener?.('onSafeAreaInsetsChanged', (payload) => {
    listener(normalizeInsets(payload));
  });
  return () => {
    sub?.remove();
  };
}

/** Requests Android Picture-in-Picture with aspect ratio clamped to Android's safe bounds (`#266`). */
export function enterAndroidPictureInPicture(aspectWidth?: number, aspectHeight?: number): boolean {
  return Boolean(nativeModule?.enterPictureInPicture?.(aspectWidth, aspectHeight));
}

/** Subscribes to Android Picture-in-Picture mode transitions (`#266`). */
export function subscribeAndroidPictureInPicture(listener: (inPip: boolean) => void): () => void {
  const sub = nativeModule?.addListener?.('onPictureInPictureChanged', (payload) => {
    listener(readBooleanField(payload, 'inPip'));
  });
  return () => {
    sub?.remove();
  };
}

/** Props of {@link Media3Surface}. */
export interface Media3SurfaceProps {
  /** An engine from {@link createMedia3Engine}; one surface per engine. */
  engine: PlayerEngine;
  /** Layout only: nothing is painted over the video, so whatever is drawn above the view composes over it. */
  style?: StyleProp<ViewStyle>;
  /**
   * How the picture meets the view: `fit` (the default) shows all of it with black bars beside it,
   * `fill` covers the view and crops the overflow, `stretch` fills the view ignoring aspect ratio.
   */
  resizeMode?: 'fit' | 'fill' | 'stretch';
  /** Extra bottom inset in dp to lift native `SubtitleView` cues above a visible OSD (`#136`). */
  subtitleBottomInsetPx?: number;
  /** Monotonic token incremented on Rung 3 decoder reset to swap in a fresh `SurfaceView` (`#144`). */
  surfaceRecreationToken?: number;
  /** Opt-in `TextureView` rendering fallback for devices with broken `SurfaceView` compositing (`#262`). */
  useTextureView?: boolean;
  testID?: string;
}

interface NativeSurfaceProps {
  /** The shared object; expo-modules-core passes it to native as its registry id. */
  engine: NativeEngineHandle;
  style?: StyleProp<ViewStyle>;
  resizeMode?: 'fit' | 'fill' | 'stretch';
  subtitleBottomInsetPx?: number;
  surfaceRecreationToken?: number;
  useTextureView?: boolean;
  testID?: string;
}

/** One component type for the app's lifetime: a new type per render would remount the view and its surface. */
const NativeSurfaceView: ComponentType<NativeSurfaceProps> | null =
  nativeModule === null
    ? null
    : requireNativeViewManager<NativeSurfaceProps>('ElvEngineMedia3', 'Media3SurfaceView');

/**
 * The video surface of a Media3 engine (player core spec 6.1): a `SurfaceView` (or opt-in `TextureView`) under a
 * black zap shutter (shown from every `load` until that video media's first frame), with a `SubtitleView` above it,
 * natively. The picture keeps its display aspect ratio (`resizeMode`), and the screen stays on while the engine plays.
 * The engine sends `surface` `created` and `destroyed` events as the view's surface comes and goes. Renders nothing
 * where the native module is absent, or for an engine this module did not create or that was released.
 */
export function Media3Surface({
  engine,
  style,
  resizeMode,
  subtitleBottomInsetPx,
  surfaceRecreationToken,
  useTextureView,
  testID,
}: Media3SurfaceProps): ReactElement | null {
  const native = handles.get(engine);
  if (NativeSurfaceView === null || native === undefined) return null;
  return createElement(NativeSurfaceView, {
    engine: native,
    ...(style !== undefined ? { style } : {}),
    ...(resizeMode !== undefined ? { resizeMode } : {}),
    ...(subtitleBottomInsetPx !== undefined ? { subtitleBottomInsetPx } : {}),
    ...(surfaceRecreationToken !== undefined ? { surfaceRecreationToken } : {}),
    ...(useTextureView !== undefined ? { useTextureView } : {}),
    ...(testID !== undefined ? { testID } : {}),
  });
}
