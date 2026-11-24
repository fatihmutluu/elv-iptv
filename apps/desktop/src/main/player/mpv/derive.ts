import type { AttemptToken, ClockAnchor, EngineEvent, EngineState, MediaKind } from '@elv/playback';
import type { MpvEvent } from './codec.ts';
import { classifyEnd, type MpvLogLine } from './errors.ts';
import { createMpvTelemetry, type MpvTelemetry } from './telemetry.ts';
import { createMpvVideoInfoTracker, type MpvVideoInfoTracker } from './video-info.ts';

const MAX_LOG_LINES = 50;
/** Minimum seekable live cache span (ms) before live time-shift is advertised (`#28`). */
const MIN_LIVE_TIMESHIFT_SPAN_MS = 2_000;
/** Minimum live window shift (ms) that triggers a throttled paused clock anchor update (`#28`). */
const PAUSED_LIVE_WINDOW_DELTA_MS = 500;
/** Minimum interval (ms) between paused `demuxer-cache-state` clock anchors (`#28`). */
const PAUSED_LIVE_WINDOW_THROTTLE_MS = 500;

/** Latest seekable live cache bounds extracted from mpv `demuxer-cache-state` (`#28`). */
interface LiveCacheWindow {
  readonly startMs?: number;
  readonly endMs?: number;
}

/** Returns whether a live stream URL is raw MPEG-TS rather than an HLS/DASH manifest (`#141`). */
export function isLiveMpegTsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith('.m3u8') || path.endsWith('.m3u') || path.endsWith('.mpd')) return false;
    const output = parsed.searchParams.get('output')?.toLowerCase();
    const type = parsed.searchParams.get('type')?.toLowerCase();
    if (output === 'm3u8' || output === 'hls' || type === 'm3u8' || type === 'hls') return false;
    return true;
  } catch {
    return !/\.m3u8?(?:[?#]|$)/i.test(url);
  }
}

/** Turns mpv property changes and file events of one media at a time into token-tagged port events. */
export interface Deriver {
  /** Starts a new media (call on its `start-file`); drops the previous media's state and logs. Returns `opening`. */
  begin(token: AttemptToken, kind: MediaKind, isLiveTs?: boolean): EngineEvent[];
  /** Tags the current media's later events with a newer token. */
  adopt(token: AttemptToken): void;
  /** Applies one observed property value; `undefined` or `null` means unavailable. */
  property(name: string, value: unknown): EngineEvent[];
  /** Handles `file-loaded`, `playback-restart` and `end-file`; other events give nothing. */
  fileEvent(e: MpvEvent): EngineEvent[];
  /** Keeps a log line for the current media (last 50) for error classification. */
  log(line: MpvLogLine): void;
  /** Periodic clock anchor while playing; call about once a second. */
  tick(): EngineEvent[];
  /** Latest seekable live cache window (ms) observed on the active live media (`#28`). */
  liveWindow(): LiveCacheWindow | undefined;
}

interface Media {
  token: AttemptToken;
  kind: MediaKind;
  isLiveTs: boolean;
  logs: MpvLogLine[];
  state: EngineState;
  loaded: boolean;
  restarted: boolean;
  firstFrameSent: boolean;
  /** `video-params` is set, or `vid` confirmed no video track after `file-loaded`. */
  frameReady: boolean;
  hasPlaybackTime: boolean;
  stalled: boolean;
  paused: boolean;
  cache: boolean;
  idle: boolean;
  seeking: boolean;
  speed: number;
  timePos: number | undefined;
  duration: number | undefined;
  cacheStart: number | undefined;
  cacheEnd: number | undefined;
  lastTimeShiftSupported: boolean;
  lastAnchorLiveStartMs: number | undefined;
  lastAnchorLiveEdgeMs: number | undefined;
  lastAnchorAt: number;
  telemetry: MpvTelemetry;
  videoInfo: MpvVideoInfoTracker;
}

type EventBody = EngineEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'attempt'>
    : never
  : never;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const nonNegSec = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

function parseLiveCacheWindow(value: unknown): { startSec?: number; endSec?: number } {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  let rangeStart: number | undefined;
  let rangeEnd: number | undefined;
  const rawRanges = record['seekable-ranges'];
  if (Array.isArray(rawRanges)) {
    for (const item of rawRanges) {
      if (typeof item !== 'object' || item === null) continue;
      const range = item as Record<string, unknown>;
      const start = nonNegSec(range['start']);
      const end = nonNegSec(range['end']);
      if (start === undefined || end === undefined || end < start) continue;
      if (rangeStart === undefined || start < rangeStart) rangeStart = start;
      if (rangeEnd === undefined || end > rangeEnd) rangeEnd = end;
    }
  }
  const cacheBegin = nonNegSec(record['cache-begin']);
  const cacheEnd = nonNegSec(record['cache-end']);
  const startSec = rangeStart ?? cacheBegin;
  const endSec = rangeEnd ?? cacheEnd;
  return {
    ...(startSec === undefined ? {} : { startSec }),
    ...(endSec === undefined ? {} : { endSec }),
  };
}

function resolveLiveWindowMs(media: Media): {
  liveSeekableStartMs?: number;
  liveEdgeMs?: number;
  timeShiftSupported: boolean;
} {
  const startMs =
    media.cacheStart !== undefined
      ? Math.max(0, Math.round(media.cacheStart * 1000)) + 0
      : undefined;
  const rawEndMs =
    media.cacheEnd !== undefined ? Math.max(0, Math.round(media.cacheEnd * 1000)) + 0 : undefined;
  const endMs =
    rawEndMs !== undefined && (startMs === undefined || rawEndMs > startMs) ? rawEndMs : undefined;
  const timeShiftSupported =
    startMs !== undefined && endMs !== undefined && endMs - startMs >= MIN_LIVE_TIMESHIFT_SPAN_MS;
  return {
    ...(startMs === undefined ? {} : { liveSeekableStartMs: startMs }),
    ...(endMs === undefined ? {} : { liveEdgeMs: endMs }),
    timeShiftSupported,
  };
}

/** Creates a deriver; `now` is the clock for event times, `clockIntervalMs` the anchor throttle. */
export function createDeriver(opts: { now(): number; clockIntervalMs: number }): Deriver {
  let m: Media | undefined;

  const ev = (media: Media, e: EventBody): EngineEvent => ({ attempt: media.token, ...e });

  const rate = (media: Media): number =>
    media.paused || media.cache || media.seeking || media.idle ? 0 : media.speed;

  const isWaiting = (media: Media): boolean =>
    !media.restarted || media.stalled || media.state === 'opening' || media.state === 'buffering';

  const anchor = (media: Media): EngineEvent[] => {
    if (media.timePos === undefined) return [];
    const atMs = opts.now();
    media.lastAnchorAt = atMs;
    const currentRate = rate(media);
    const liveBounds = media.kind === 'live' ? resolveLiveWindowMs(media) : undefined;
    media.lastAnchorLiveStartMs = liveBounds?.liveSeekableStartMs;
    media.lastAnchorLiveEdgeMs = liveBounds?.liveEdgeMs;
    const a: ClockAnchor = {
      positionMs: Math.max(0, Math.round(media.timePos * 1000)) + 0,
      atMs,
      rate: currentRate,
      ...media.telemetry.clockFields(atMs, currentRate),
      ...(media.kind === 'vod' && media.duration !== undefined
        ? { durationMs: Math.max(0, Math.round(media.duration * 1000)) + 0 }
        : {}),
      ...(liveBounds === undefined
        ? {}
        : {
            ...(liveBounds.liveSeekableStartMs === undefined
              ? {}
              : { liveSeekableStartMs: liveBounds.liveSeekableStartMs }),
            ...(liveBounds.liveEdgeMs === undefined ? {} : { liveEdgeMs: liveBounds.liveEdgeMs }),
            timeShiftSupported: liveBounds.timeShiftSupported,
          }),
      ...(media.kind === 'live' && media.isLiveTs ? { isLiveTs: true } : {}),
    };
    return [ev(media, { type: 'clock', anchor: a })];
  };

  const setState = (media: Media, state: EngineState): EngineEvent[] => {
    if (media.state === state) return [];
    media.state = state;
    return [ev(media, { type: 'state', state })];
  };

  const settle = (media: Media): EngineEvent[] => {
    if (!media.restarted) return [];
    const target = media.paused ? 'paused' : media.cache ? 'buffering' : 'playing';
    return target === 'playing' && !media.firstFrameSent ? [] : setState(media, target);
  };

  const changed = (media: Media, fn: () => boolean): EngineEvent[] =>
    fn() && media.restarted ? anchor(media) : [];

  const cacheChange = (media: Media, on: boolean): EngineEvent[] => {
    if (media.cache === on) return [];
    media.cache = on;
    if (!media.restarted) return [];
    const out: EngineEvent[] = [];
    if (on && !media.paused && !media.stalled) {
      media.stalled = true;
      out.push(ev(media, { type: 'stall', phase: 'start', atMs: opts.now() }));
    } else if (!on && media.stalled) {
      media.stalled = false;
      out.push(ev(media, { type: 'stall', phase: 'end', atMs: opts.now() }));
    }
    return [...out, ...settle(media), ...anchor(media)];
  };

  const firstFrame = (media: Media): EngineEvent[] => {
    if (media.firstFrameSent || !media.restarted || !media.frameReady) return [];
    media.firstFrameSent = true;
    return [ev(media, { type: 'firstFrame', atMs: opts.now() })];
  };

  const frameThenSettle = (media: Media): EngineEvent[] => {
    const frame = firstFrame(media);
    return frame.length === 0 ? [] : [...frame, ...settle(media)];
  };

  const restart = (media: Media): EngineEvent[] => {
    const out: EngineEvent[] = [];
    media.restarted = true;
    out.push(...firstFrame(media));
    return [...out, ...settle(media), ...anchor(media)];
  };

  const end = (media: Media, e: MpvEvent): EngineEvent[] => {
    const fileError = typeof e['file_error'] === 'string' ? e['file_error'] : undefined;
    const outcome = classifyEnd({
      reason: String(e['reason'] ?? ''),
      ...(fileError === undefined ? {} : { fileError }),
      logs: media.logs,
      mediaKind: media.kind,
      played: media.restarted,
    });
    m = undefined;
    if (outcome.kind === 'stopped') return [];
    if (outcome.kind === 'ended') return [ev(media, { type: 'state', state: 'ended' })];
    return [ev(media, { type: 'error', error: outcome.error })];
  };

  const updateTime = (media: Media, value: unknown): EngineEvent[] => {
    const next = num(value);
    if (next === undefined) return [];
    media.timePos = Math.max(0, next);
    const due = opts.now() - media.lastAnchorAt >= opts.clockIntervalMs;
    return media.restarted && due ? anchor(media) : [];
  };

  const setProperty = (media: Media, name: string, value: unknown): EngineEvent[] => {
    switch (name) {
      case 'pause': {
        const next = value === true;
        if (media.paused === next) return [];
        media.paused = next;
        return media.restarted ? [...settle(media), ...anchor(media)] : [];
      }
      case 'paused-for-cache':
        return cacheChange(media, value === true);
      case 'core-idle':
        return changed(media, () => {
          const next = value === true;
          const diff = media.idle !== next;
          media.idle = next;
          return diff;
        });
      case 'seeking':
        return changed(media, () => {
          const next = value === true;
          const diff = media.seeking !== next;
          media.seeking = next;
          return diff;
        });
      case 'speed':
        return changed(media, () => {
          const next = num(value);
          if (next === undefined || next === media.speed) return false;
          media.speed = next;
          return true;
        });
      case 'playback-time': {
        const next = num(value);
        if (next === undefined) return [];
        media.hasPlaybackTime = true;
        return updateTime(media, next);
      }
      case 'time-pos':
        return media.hasPlaybackTime ? [] : updateTime(media, value);
      case 'video-params': {
        media.telemetry.onVideoParams(value);
        const info = media.videoInfo.onVideoParams(value);
        if (typeof value !== 'object' || value === null) return [];
        media.frameReady = true;
        const settled = frameThenSettle(media);
        return info ? [...settled, ev(media, info)] : settled;
      }
      case 'video-format': {
        const info = media.videoInfo.onVideoFormat(value);
        return info ? [ev(media, info)] : [];
      }
      case 'video-codec': {
        const info = media.videoInfo.onVideoCodec(value);
        return info ? [ev(media, info)] : [];
      }
      case 'container-fps': {
        const info = media.videoInfo.onContainerFps(value);
        return info ? [ev(media, info)] : [];
      }
      case 'vid':
        media.telemetry.onVid(value, media.loaded);
        if (!media.loaded || (value !== false && value !== 'no')) return [];
        media.frameReady = true;
        return frameThenSettle(media);
      case 'track-list':
        media.telemetry.onTrackList(value);
        return [];
      case 'estimated-vf-fps': {
        media.telemetry.onEstimatedVfFps(value, opts.now());
        const info = media.videoInfo.onEstimatedVfFps(value);
        return info ? [ev(media, info)] : [];
      }
      case 'duration': {
        const raw = num(value);
        const clean = raw !== undefined && raw > 0 ? raw : undefined;
        if (media.duration === clean) return [];
        media.duration = clean;
        const out = media.kind === 'vod' && media.restarted ? anchor(media) : [];
        const ch = media.telemetry.onDurationForChapters(clean);
        if (ch) out.push(ev(media, ch));
        return out;
      }
      case 'chapter-list': {
        const ch = media.telemetry.onChapterList(value, media.duration);
        return ch ? [ev(media, ch)] : [];
      }
      case 'frame-drop-count': {
        const dropped = media.telemetry.onFrameDropCount(value);
        return dropped ? [ev(media, dropped)] : [];
      }
      case 'demuxer-cache-state': {
        const parsed = parseLiveCacheWindow(value);
        media.cacheStart = parsed.startSec;
        media.cacheEnd = parsed.endSec;
        const out: EngineEvent[] = [];
        const progress = media.telemetry.onCacheState(value, opts.now(), isWaiting(media));
        if (progress) out.push(ev(media, progress));
        if (media.kind === 'live') {
          const liveBounds = resolveLiveWindowMs(media);
          const supported = liveBounds.timeShiftSupported;
          const flipped = supported !== media.lastTimeShiftSupported;
          if (flipped) {
            media.lastTimeShiftSupported = supported;
          }
          if (media.restarted) {
            if (flipped) {
              out.push(...anchor(media));
            } else if (supported && rate(media) === 0) {
              const startChanged =
                liveBounds.liveSeekableStartMs !== media.lastAnchorLiveStartMs &&
                (liveBounds.liveSeekableStartMs === undefined ||
                  media.lastAnchorLiveStartMs === undefined ||
                  Math.abs(liveBounds.liveSeekableStartMs - media.lastAnchorLiveStartMs) >=
                    PAUSED_LIVE_WINDOW_DELTA_MS);
              const edgeChanged =
                liveBounds.liveEdgeMs !== media.lastAnchorLiveEdgeMs &&
                (liveBounds.liveEdgeMs === undefined ||
                  media.lastAnchorLiveEdgeMs === undefined ||
                  Math.abs(liveBounds.liveEdgeMs - media.lastAnchorLiveEdgeMs) >=
                    PAUSED_LIVE_WINDOW_DELTA_MS);
              const throttleMs = Math.min(PAUSED_LIVE_WINDOW_THROTTLE_MS, opts.clockIntervalMs);
              if ((startChanged || edgeChanged) && opts.now() - media.lastAnchorAt >= throttleMs) {
                out.push(...anchor(media));
              }
            }
          }
        }
        return out;
      }
      case 'demuxer-cache-duration': {
        const progress = media.telemetry.onCacheDuration(value, opts.now(), isWaiting(media));
        return progress ? [ev(media, progress)] : [];
      }
      case 'file-format': {
        if (media.kind !== 'live' || typeof value !== 'string') return [];
        const formats = value.toLowerCase().split(',');
        if (formats.some((f) => f === 'hls' || f === 'dash')) {
          media.isLiveTs = false;
        } else if (formats.includes('mpegts')) {
          media.isLiveTs = true;
        }
        return [];
      }
      default:
        return [];
    }
  };

  return {
    begin(token, kind, isLiveTs = false) {
      m = {
        token,
        kind,
        isLiveTs: kind === 'live' && isLiveTs,
        logs: [],
        state: 'opening',
        loaded: false,
        restarted: false,
        firstFrameSent: false,
        frameReady: false,
        hasPlaybackTime: false,
        stalled: false,
        paused: false,
        cache: false,
        idle: false,
        seeking: false,
        speed: 1,
        timePos: undefined,
        duration: undefined,
        cacheStart: undefined,
        cacheEnd: undefined,
        lastTimeShiftSupported: false,
        lastAnchorLiveStartMs: undefined,
        lastAnchorLiveEdgeMs: undefined,
        lastAnchorAt: Number.NEGATIVE_INFINITY,
        telemetry: createMpvTelemetry(),
        videoInfo: createMpvVideoInfoTracker(),
      };
      return [ev(m, { type: 'state', state: 'opening' })];
    },
    adopt(token) {
      if (m) m.token = token;
    },
    property: (name, value) => (m ? setProperty(m, name, value) : []),
    fileEvent(e) {
      if (!m) return [];
      switch (e.event) {
        case 'file-loaded':
          m.loaded = true;
          return m.restarted ? [] : setState(m, 'buffering');
        case 'playback-restart':
          return restart(m);
        case 'end-file':
          return end(m, e);
        default:
          return [];
      }
    },
    log(line) {
      if (!m) return;
      m.logs.push(line);
      if (m.logs.length > MAX_LOG_LINES) m.logs.shift();
    },
    tick() {
      if (!m?.restarted) return [];
      const liveTimeShift = m.kind === 'live' && resolveLiveWindowMs(m).timeShiftSupported;
      if (rate(m) === 0 && !liveTimeShift) return [];
      return opts.now() - m.lastAnchorAt >= opts.clockIntervalMs ? anchor(m) : [];
    },
    liveWindow() {
      if (m?.kind !== 'live') return undefined;
      const bounds = resolveLiveWindowMs(m);
      if (bounds.liveSeekableStartMs === undefined && bounds.liveEdgeMs === undefined) {
        return undefined;
      }
      return {
        ...(bounds.liveSeekableStartMs === undefined
          ? {}
          : { startMs: bounds.liveSeekableStartMs }),
        ...(bounds.liveEdgeMs === undefined ? {} : { endMs: bounds.liveEdgeMs }),
      };
    },
  };
}
