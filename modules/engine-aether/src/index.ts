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

interface NativeEngineModule {
  Engine: new () => NativeEngineHandle;
  uptimeMs(): number;
  engineVersion(): string;
  deviceModel?(): string;
}

/** Hardware rendering tier derived from the Apple machine identifier (`#186`). */
export type AppleHardwareTier = 'standard' | 'mid-power';

const MID_POWER_APPLE_TV_PATTERN = /^AppleTV(?:5|6),/;

const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: true,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
});

/** The native shared object behind each live engine this module created; `AetherSurface` binds its view to it. */
const handles = new WeakMap<PlayerEngine, NativeEngineHandle>();

const nativeModule = requireOptionalNativeModule<NativeEngineModule>('ElvEngineAether');

/**
 * Returns the linked AetherEngine library version on Apple platforms (iOS, iPadOS, tvOS),
 * or `null` where the native module is absent (Android, web, headless tests).
 */
export function aetherEngineVersion(): string | null {
  return nativeModule === null ? null : nativeModule.engineVersion();
}

/**
 * Classifies constrained Apple TV hardware (`AppleTV5,*` 2 GB HD and `AppleTV6,*` 3 GB 4K 1st gen)
 * as `'mid-power'` so heavy blur/compositor effects can be bypassed (`#186`).
 */
export function resolveAppleHardwareTier(model: string | null | undefined): AppleHardwareTier {
  if (typeof model !== 'string') return 'standard';
  const trimmed = model.trim();
  if (trimmed.length === 0) return 'standard';
  return MID_POWER_APPLE_TV_PATTERN.test(trimmed) ? 'mid-power' : 'standard';
}

/**
 * Returns the Apple hardware machine identifier (e.g. `'AppleTV6,2'`, `'iPhone16,1'`) from the
 * native module, or `null` when unavailable or empty (`#186`).
 */
export function getAppleDeviceModel(): string | null {
  const raw = nativeModule?.deviceModel?.();
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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

/**
 * Creates an AetherEngine player engine (tvOS, iOS, iPadOS) implementing the `PlayerEngine` port,
 * or returns `null` where the native module is absent. Call `release()` when the player screen unmounts.
 */
export function createAetherEngine(): PlayerEngine | null {
  return nativeModule === null ? null : wrap(nativeModule);
}

/** Props of {@link AetherSurface}. */
export interface AetherSurfaceProps {
  /** An engine from {@link createAetherEngine}; one surface per engine. */
  engine: PlayerEngine;
  /** Layout only: nothing is painted over the video, so overlays compose above it. */
  style?: StyleProp<ViewStyle>;
  /**
   * How the picture meets the view: `fit` (default) shows all of it with black bars beside it,
   * `fill` covers the view and crops the overflow, `stretch` fills the view ignoring aspect ratio.
   */
  resizeMode?: 'fit' | 'fill' | 'stretch';
  /** Extra bottom inset in pt to lift native subtitle cues above a visible OSD (`#136`). */
  subtitleBottomInsetPx?: number;
  /** Whether the player OSD is currently visible so native can throttle hidden-OSD clock ticks (`#442`). */
  osdVisible?: boolean;
  testID?: string;
}

interface NativeSurfaceProps {
  engine: NativeEngineHandle;
  style?: StyleProp<ViewStyle>;
  resizeMode?: 'fit' | 'fill' | 'stretch';
  subtitleBottomInsetPx?: number;
  osdVisible?: boolean;
  testID?: string;
}

/** One component type for the app's lifetime so renders never remount the native surface view. */
const NativeSurfaceView: ComponentType<NativeSurfaceProps> | null =
  nativeModule === null
    ? null
    : requireNativeViewManager<NativeSurfaceProps>('ElvEngineAether', 'AetherSurfaceView');

/**
 * The video surface of an AetherEngine instance (player core spec 6.2): an `AetherPlayerView` under
 * a native black zap shutter shown from each `load` until that media's first frame, keeping the screen
 * awake while playing and reporting `surface` `created`/`destroyed` across window and background changes.
 * Renders nothing without the native module, or for a foreign or released engine.
 */
export function AetherSurface({
  engine,
  style,
  resizeMode,
  subtitleBottomInsetPx,
  osdVisible,
  testID,
}: AetherSurfaceProps): ReactElement | null {
  const native = handles.get(engine);
  if (NativeSurfaceView === null || native === undefined) return null;
  return createElement(NativeSurfaceView, {
    engine: native,
    style,
    resizeMode,
    subtitleBottomInsetPx,
    ...(osdVisible !== undefined ? { osdVisible } : {}),
    testID,
  });
}
