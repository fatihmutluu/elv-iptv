import type {
  AttemptToken,
  ClockAnchor,
  EngineCapabilities,
  EngineEvent,
  LoadCommand,
  PlayerEngine,
} from '@elv/playback';
import { requireOptionalNativeModule } from 'expo-modules-core';

/** The JS clock of React Native and Node; declared here because this package has no DOM or React Native types. */
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

  return {
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
