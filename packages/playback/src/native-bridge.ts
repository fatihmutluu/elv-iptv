import type { AndroidDecoderMode, BufferPreset } from '@elv/domain';
import type {
  AttemptToken,
  ClockAnchor,
  EngineCapabilities,
  EngineEvent,
  LoadCommand,
  MediaKind,
  PlayerEngine,
} from './engine';

/** The `load` argument of a native engine shared object: a flattened {@link LoadCommand}. */
export interface NativeLoadCommand {
  attempt: AttemptToken;
  url: string;
  headers: Readonly<Record<string, string>>;
  kind: MediaKind;
  startMs?: number;
  softwareAudio?: boolean;
  preferHevcOverDolbyVision?: boolean;
  filterSdhSubtitles?: boolean;
  readonly allowLegacyTls?: boolean;
  bufferPreset?: BufferPreset;
  decoderMode?: AndroidDecoderMode;
  audioTrackId?: string;
  subtitleTrackId?: string | null;
}

/** Handle to a native engine shared object (`ElvEngineMedia3.Engine` or `ElvEngineAether.Engine`). */
export interface NativeEngineHandle {
  load(command: NativeLoadCommand): void;
  retry(attempt: AttemptToken): void;
  play(attempt: AttemptToken): void;
  pause(attempt: AttemptToken): void;
  seek(attempt: AttemptToken, positionMs: number): void;
  setScrubbing?(attempt: AttemptToken, scrubbing: boolean): void;
  setSpeed?(attempt: AttemptToken, rate: number): void;
  selectAudioTrack?(attempt: AttemptToken, id: string): void;
  selectSubtitleTrack?(attempt: AttemptToken, id: string | null): void;
  stop(attempt: AttemptToken): void;
  recreate(attempt: AttemptToken): void;
  release(): void;
  addListener(
    eventName: 'onEngineEvent',
    listener: (event: EngineEvent) => void,
  ): { remove(): void };
}

function toNativeLoad(cmd: LoadCommand): NativeLoadCommand {
  const { attempt, url, headers, kind, startMs, options } = cmd;
  return {
    attempt,
    url,
    headers,
    kind,
    ...(startMs === undefined ? {} : { startMs }),
    ...(options?.softwareAudio === undefined ? {} : { softwareAudio: options.softwareAudio }),
    ...(options?.preferHevcOverDolbyVision === undefined
      ? {}
      : { preferHevcOverDolbyVision: options.preferHevcOverDolbyVision }),
    ...(options?.filterSdhSubtitles === undefined
      ? {}
      : { filterSdhSubtitles: options.filterSdhSubtitles }),
    ...(options?.allowLegacyTls === undefined ? {} : { allowLegacyTls: options.allowLegacyTls }),
    ...(options?.bufferPreset === undefined ? {} : { bufferPreset: options.bufferPreset }),
    ...(options?.decoderMode === undefined ? {} : { decoderMode: options.decoderMode }),
    ...(options?.audioTrackId === undefined ? {} : { audioTrackId: options.audioTrackId }),
    ...(options?.subtitleTrackId === undefined ? {} : { subtitleTrackId: options.subtitleTrackId }),
  };
}

function mapEventClock(event: EngineEvent, uptimeMs: () => number, now: () => number): EngineEvent {
  if (
    event.type !== 'firstFrame' &&
    event.type !== 'stall' &&
    event.type !== 'clock' &&
    event.type !== 'progress'
  ) {
    return event;
  }
  const jsNow = now();
  const uptime = uptimeMs();
  const toJs = (atMs: number): number => jsNow - Math.max(0, uptime - atMs);
  if (event.type === 'clock') {
    const anchor: ClockAnchor = { ...event.anchor, atMs: toJs(event.anchor.atMs) };
    return { ...event, anchor };
  }
  return { ...event, atMs: toJs(event.atMs) };
}

/**
 * Wraps a native engine shared object behind the {@link PlayerEngine} port: flattens `LoadCommand`,
 * maps native monotonic `atMs` stamps onto `now()` without placing any stamp into the future,
 * snapshots subscribers per event, and turns commands after `release()` into no-ops.
 */
export function bridgeNativeEngine(
  native: NativeEngineHandle,
  opts: { capabilities: EngineCapabilities; uptimeMs: () => number; now: () => number },
): PlayerEngine {
  const listeners = new Set<(event: EngineEvent) => void>();
  let released = false;
  let hasCommand = false;
  let activeAttempt: AttemptToken = 0;
  let silenced = false;
  const subscription = native.addListener('onEngineEvent', (event) => {
    if (listeners.size === 0) return;
    if (event.type !== 'surface') {
      if (silenced) return;
      if (hasCommand && event.attempt !== activeAttempt) return;
    }
    const mapped = mapEventClock(event, opts.uptimeMs, opts.now);
    for (const listener of [...listeners]) {
      try {
        listener(mapped);
      } catch {
        // Subscriber errors must never block peer listeners or crash the native event callback.
      }
    }
  });
  const command =
    <A extends unknown[]>(send: (...args: A) => void) =>
    (...args: A): void => {
      if (!released) send(...args);
    };
  const adoptAttempt = (attempt: AttemptToken): void => {
    hasCommand = true;
    if (attempt > activeAttempt) activeAttempt = attempt;
  };

  return {
    capabilities: opts.capabilities,
    load: command((cmd: LoadCommand) => {
      hasCommand = true;
      activeAttempt = cmd.attempt;
      silenced = false;
      native.load(toNativeLoad(cmd));
    }),
    retry: command((attempt: AttemptToken) => {
      adoptAttempt(attempt);
      silenced = false;
      native.retry(attempt);
    }),
    play: command((attempt: AttemptToken) => {
      adoptAttempt(attempt);
      native.play(attempt);
    }),
    pause: command((attempt: AttemptToken) => {
      adoptAttempt(attempt);
      native.pause(attempt);
    }),
    seek: command((attempt: AttemptToken, positionMs: number) => {
      adoptAttempt(attempt);
      native.seek(attempt, positionMs);
    }),
    ...(native.setScrubbing === undefined
      ? {}
      : {
          setScrubbing: command((attempt: AttemptToken, scrubbing: boolean) => {
            native.setScrubbing?.(hasCommand ? activeAttempt : attempt, scrubbing);
          }),
        }),
    ...(native.setSpeed === undefined
      ? {}
      : {
          setSpeed: command((attempt: AttemptToken, rate: number) => {
            adoptAttempt(attempt);
            native.setSpeed?.(attempt, rate);
          }),
        }),
    ...(native.selectAudioTrack === undefined
      ? {}
      : {
          selectAudioTrack: command((attempt: AttemptToken, id: string) => {
            adoptAttempt(attempt);
            native.selectAudioTrack?.(attempt, id);
          }),
        }),
    ...(native.selectSubtitleTrack === undefined
      ? {}
      : {
          selectSubtitleTrack: command((attempt: AttemptToken, id: string | null) => {
            adoptAttempt(attempt);
            native.selectSubtitleTrack?.(attempt, id);
          }),
        }),
    stop: command((attempt: AttemptToken) => {
      adoptAttempt(attempt);
      silenced = true;
      native.stop(attempt);
    }),
    recreate: command((attempt: AttemptToken) => {
      adoptAttempt(attempt);
      silenced = false;
      native.recreate(attempt);
    }),
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
