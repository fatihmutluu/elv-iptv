import type { AndroidDecoderMode, BufferPreset, SubtitleStyleConfig } from '@elv/domain';
import type {
  AttemptToken,
  ClockAnchor,
  EngineCapabilities,
  EngineEvent,
  ExternalSubtitleTrack,
  LoadCommand,
  MediaKind,
  MediaTracks,
  PlayerEngine,
  VideoQualityOption,
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
  readonly secondarySubtitleTrackId?: string | null;
  readonly externalSubtitles?: readonly ExternalSubtitleTrack[];
  readonly subtitleStyle?: SubtitleStyleConfig;
}

/** Handle to a native engine shared object (`ElvEngineMedia3.Engine` or `ElvEngineAether.Engine`). */
export interface NativeEngineHandle {
  load(command: NativeLoadCommand): void;
  retry(attempt: AttemptToken): void;
  play(attempt: AttemptToken): void;
  pause(attempt: AttemptToken): void;
  seek(attempt: AttemptToken, positionMs: number): void;
  jumpToLiveEdge?(attempt: AttemptToken): void;
  setScrubbing?(attempt: AttemptToken, scrubbing: boolean): void;
  setSpeed?(attempt: AttemptToken, rate: number): void;
  selectAudioTrack?(attempt: AttemptToken, id: string): void;
  selectSubtitleTrack?(attempt: AttemptToken, id: string | null): void;
  selectSecondarySubtitleTrack?(attempt: AttemptToken, id: string | null): void;
  addExternalSubtitle?(attempt: AttemptToken, track: ExternalSubtitleTrack): void;
  setSubtitleStyle?(style: SubtitleStyleConfig): void;
  setAudioDelay?(attempt: AttemptToken, delayMs: number): void;
  setSubtitleDelay?(attempt: AttemptToken, delayMs: number): void;
  selectVideoQuality?(attempt: AttemptToken, id: string | null): void;
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
    ...(options?.secondarySubtitleTrackId === undefined
      ? {}
      : { secondarySubtitleTrackId: options.secondarySubtitleTrackId }),
    ...(options?.externalSubtitles === undefined
      ? {}
      : { externalSubtitles: options.externalSubtitles }),
    ...(options?.subtitleStyle === undefined ? {} : { subtitleStyle: options.subtitleStyle }),
  };
}

const positiveFinite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const nonEmptyStringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

function normalizeVideoQualities(raw: unknown): readonly VideoQualityOption[] {
  if (!Array.isArray(raw)) return [];
  const out: VideoQualityOption[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    if (id.length === 0 || label.length === 0) continue;
    const width = positiveFinite(candidate.width);
    const height = positiveFinite(candidate.height);
    const bitrateBps = positiveFinite(candidate.bitrateBps);
    const fps = positiveFinite(candidate.fps);
    out.push({
      id,
      label,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(bitrateBps === undefined ? {} : { bitrateBps }),
      ...(fps === undefined ? {} : { fps }),
    });
  }
  return out;
}

function normalizeTracksEvent(event: EngineEvent): EngineEvent {
  if (event.type !== 'tracks') return event;
  const raw = event.tracks;
  if (
    raw.videoQualities === undefined &&
    raw.selectedVideoQualityId === undefined &&
    raw.selectedSecondarySubtitleId === undefined
  ) {
    return event;
  }
  const normalizedSecondary =
    raw.selectedSecondarySubtitleId === undefined
      ? undefined
      : nonEmptyStringOrNull(raw.selectedSecondarySubtitleId);
  const safeSecondary =
    normalizedSecondary !== undefined &&
    normalizedSecondary !== null &&
    normalizedSecondary === raw.selectedSubtitleId
      ? null
      : normalizedSecondary;
  const normalized: MediaTracks = {
    audio: raw.audio,
    subtitles: raw.subtitles,
    selectedAudioId: raw.selectedAudioId,
    selectedSubtitleId: raw.selectedSubtitleId,
    ...(safeSecondary === undefined ? {} : { selectedSecondarySubtitleId: safeSecondary }),
    ...(raw.videoQualities === undefined
      ? {}
      : { videoQualities: normalizeVideoQualities(raw.videoQualities) }),
    ...(raw.selectedVideoQualityId === undefined
      ? {}
      : { selectedVideoQualityId: nonEmptyStringOrNull(raw.selectedVideoQualityId) }),
  };
  return { ...event, tracks: normalized };
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
    const raw = event.anchor;
    const { liveSeekableStartMs: rawStart, timeShiftSupported: rawSupported, ...rest } = raw;
    const liveSeekableStartMs =
      typeof rawStart === 'number' && Number.isFinite(rawStart) && rawStart >= 0
        ? rawStart
        : undefined;
    const timeShiftSupported = typeof rawSupported === 'boolean' ? rawSupported : undefined;
    const anchor: ClockAnchor = {
      ...rest,
      atMs: toJs(raw.atMs),
      ...(liveSeekableStartMs === undefined ? {} : { liveSeekableStartMs }),
      ...(timeShiftSupported === undefined ? {} : { timeShiftSupported }),
    };
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
    const mapped = normalizeTracksEvent(mapEventClock(event, opts.uptimeMs, opts.now));
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
    ...(native.jumpToLiveEdge === undefined
      ? {}
      : {
          jumpToLiveEdge: command((attempt: AttemptToken) => {
            adoptAttempt(attempt);
            native.jumpToLiveEdge?.(attempt);
          }),
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
    ...(native.selectSecondarySubtitleTrack === undefined
      ? {}
      : {
          selectSecondarySubtitleTrack: command((attempt: AttemptToken, id: string | null) => {
            adoptAttempt(attempt);
            native.selectSecondarySubtitleTrack?.(attempt, id);
          }),
        }),
    ...(native.addExternalSubtitle === undefined
      ? {}
      : {
          addExternalSubtitle: command((attempt: AttemptToken, track: ExternalSubtitleTrack) => {
            adoptAttempt(attempt);
            native.addExternalSubtitle?.(attempt, track);
          }),
        }),
    ...(native.setSubtitleStyle === undefined
      ? {}
      : {
          setSubtitleStyle: command((style: SubtitleStyleConfig) => {
            native.setSubtitleStyle?.(style);
          }),
        }),
    ...(native.setAudioDelay === undefined
      ? {}
      : {
          setAudioDelay: command((attempt: AttemptToken, delayMs: number) => {
            adoptAttempt(attempt);
            native.setAudioDelay?.(attempt, delayMs);
          }),
        }),
    ...(native.setSubtitleDelay === undefined
      ? {}
      : {
          setSubtitleDelay: command((attempt: AttemptToken, delayMs: number) => {
            adoptAttempt(attempt);
            native.setSubtitleDelay?.(attempt, delayMs);
          }),
        }),
    ...(native.selectVideoQuality === undefined
      ? {}
      : {
          selectVideoQuality: command((attempt: AttemptToken, id: string | null) => {
            adoptAttempt(attempt);
            native.selectVideoQuality?.(attempt, id);
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
