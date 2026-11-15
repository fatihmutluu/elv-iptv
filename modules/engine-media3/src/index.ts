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

/** Props of {@link Media3Surface}. */
export interface Media3SurfaceProps {
  /** An engine from {@link createMedia3Engine}; one surface per engine. */
  engine: PlayerEngine;
  /** Layout only: nothing is painted over the video, so whatever is drawn above the view composes over it. */
  style?: StyleProp<ViewStyle>;
  /**
   * How the picture meets the view at its display aspect ratio, centred: `fit` (the default) shows all of it with
   * black bars beside it, `fill` covers the view and crops the overflow.
   */
  resizeMode?: 'fit' | 'fill';
  testID?: string;
}

interface NativeSurfaceProps {
  /** The shared object; expo-modules-core passes it to native as its registry id. */
  engine: NativeEngineHandle;
  style?: StyleProp<ViewStyle>;
  resizeMode?: 'fit' | 'fill';
  testID?: string;
}

/** One component type for the app's lifetime: a new type per render would remount the view and its surface. */
const NativeSurfaceView: ComponentType<NativeSurfaceProps> | null =
  nativeModule === null
    ? null
    : requireNativeViewManager<NativeSurfaceProps>('ElvEngineMedia3', 'Media3SurfaceView');

/**
 * The video surface of a Media3 engine (player core spec 6.1): a `SurfaceView` fixed at creation and a `SubtitleView`
 * above it, both under a black zap shutter that the engine shows from every `load` until that media's first frame,
 * natively. The picture keeps its display aspect ratio (`resizeMode`), and the screen stays on while the engine plays.
 * The engine sends `surface` `created` and `destroyed` events as the view's surface comes and goes. Renders nothing
 * where the native module is absent, or for an engine this module did not create or that was released.
 */
export function Media3Surface({
  engine,
  style,
  resizeMode,
  testID,
}: Media3SurfaceProps): ReactElement | null {
  const native = handles.get(engine);
  if (NativeSurfaceView === null || native === undefined) return null;
  return createElement(NativeSurfaceView, { engine: native, style, resizeMode, testID });
}
