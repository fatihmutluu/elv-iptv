import type {
  AttemptToken,
  ClockAnchor,
  EngineCapabilities,
  EngineEvent,
  LoadCommand,
  PlayerEngine,
} from '@elv/playback';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { type ComponentType, createElement, type ReactElement } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

/** The JS clock of React Native and Node; declared here because the package compiles without DOM types. */
declare const performance: { now(): number };

/** The `load` argument of the native engine: a flattened {@link LoadCommand}. */
interface NativeLoadCommand {
  attempt: AttemptToken;
  url: string;
  headers: Readonly<Record<string, string>>;
  kind: LoadCommand['kind'];
  startMs?: number;
  softwareAudio?: boolean;
}

/** An `onEngineEvent` payload; its `atMs` values are `SystemClock.uptimeMillis()` stamps. */
type NativeEngineEvent = EngineEvent;

/** The native `ElvEngineMedia3.Engine` shared object. */
interface NativeEngine {
  load(command: NativeLoadCommand): void;
  retry(attempt: AttemptToken): void;
  play(attempt: AttemptToken): void;
  pause(attempt: AttemptToken): void;
  seek(attempt: AttemptToken, positionMs: number): void;
  stop(attempt: AttemptToken): void;
  recreate(attempt: AttemptToken): void;
  /** SharedObject release: detaches the JS object; the native side then releases the player. */
  release(): void;
  addListener(
    eventName: 'onEngineEvent',
    listener: (event: NativeEngineEvent) => void,
  ): { remove(): void };
}

interface NativeEngineModule {
  Engine: new () => NativeEngine;
  uptimeMs(): number;
}

const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: true,
  recreate: true,
  audioTrackSelection: false,
  subtitleTrackSelection: false,
});

function toNativeLoad(cmd: LoadCommand): NativeLoadCommand {
  const { attempt, url, headers, kind, startMs, options } = cmd;
  return {
    attempt,
    url,
    headers,
    kind,
    ...(startMs === undefined ? {} : { startMs }),
    ...(options?.softwareAudio === undefined ? {} : { softwareAudio: options.softwareAudio }),
  };
}

/** Maps native uptime stamps to `performance.now()`; a stamp is never placed after the moment of receipt. */
function received(event: NativeEngineEvent, module: NativeEngineModule): EngineEvent {
  if (event.type !== 'firstFrame' && event.type !== 'stall' && event.type !== 'clock') return event;
  const now = performance.now();
  const uptime = module.uptimeMs();
  const toJs = (atMs: number): number => now - Math.max(0, uptime - atMs);
  if (event.type === 'clock') {
    const anchor: ClockAnchor = { ...event.anchor, atMs: toJs(event.anchor.atMs) };
    return { ...event, anchor };
  }
  return { ...event, atMs: toJs(event.atMs) };
}

/** The native shared object behind each live engine this module created; `Media3Surface` binds its view to it. */
const handles = new WeakMap<PlayerEngine, NativeEngine>();

function wrap(module: NativeEngineModule): PlayerEngine {
  const native = new module.Engine();
  const listeners = new Set<(event: EngineEvent) => void>();
  let released = false;
  const subscription = native.addListener('onEngineEvent', (event) => {
    if (listeners.size === 0) return;
    const mapped = received(event, module);
    for (const listener of [...listeners]) listener(mapped);
  });
  const command =
    <A extends unknown[]>(send: (...args: A) => void) =>
    (...args: A): void => {
      if (!released) send(...args);
    };

  const engine: PlayerEngine = {
    capabilities: CAPABILITIES,
    load: command((cmd: LoadCommand) => native.load(toNativeLoad(cmd))),
    retry: command((attempt: AttemptToken) => native.retry(attempt)),
    play: command((attempt: AttemptToken) => native.play(attempt)),
    pause: command((attempt: AttemptToken) => native.pause(attempt)),
    seek: command((attempt: AttemptToken, positionMs: number) => native.seek(attempt, positionMs)),
    stop: command((attempt: AttemptToken) => native.stop(attempt)),
    recreate: command((attempt: AttemptToken) => native.recreate(attempt)),
    release() {
      if (released) return;
      released = true;
      handles.delete(engine);
      listeners.clear();
      subscription.remove();
      native.release();
    },
    subscribe(listener) {
      if (released) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
  engine: NativeEngine;
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
 * The video surface of a Media3 engine (player core spec 6.1): a `SurfaceView` fixed at creation with a black zap
 * shutter above it that the engine shows from every `load` until that media's first frame, natively. The picture
 * keeps its display aspect ratio (`resizeMode`), and the screen stays on while the engine plays. The engine sends
 * `surface` `created` and `destroyed` events as the view's surface comes and goes. Renders nothing where the native
 * module is absent, or for an engine this module did not create or that was released.
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
