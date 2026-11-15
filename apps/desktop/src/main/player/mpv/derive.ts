import type { AttemptToken, ClockAnchor, EngineEvent, EngineState, MediaKind } from '@elv/playback';
import type { MpvEvent } from './codec.ts';
import { classifyEnd, type MpvLogLine } from './errors.ts';

const MAX_LOG_LINES = 50;

/** Turns mpv property changes and file events of one media at a time into token-tagged port events. */
export interface Deriver {
  /** Starts a new media (call on its `start-file`); drops the previous media's state and logs. Returns `opening`. */
  begin(token: AttemptToken, kind: MediaKind): EngineEvent[];
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
}

interface Media {
  token: AttemptToken;
  kind: MediaKind;
  logs: MpvLogLine[];
  state: EngineState;
  restarted: boolean;
  firstFrameSent: boolean;
  /** `video-params` is set, or `vid` says there is no video track. */
  frameReady: boolean;
  stalled: boolean;
  paused: boolean;
  cache: boolean;
  idle: boolean;
  seeking: boolean;
  speed: number;
  timePos: number | undefined;
  duration: number | undefined;
  cacheEnd: number | undefined;
  lastAnchorAt: number;
}

type EventBody = EngineEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'attempt'>
    : never
  : never;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Creates a deriver; `now` is the clock for event times, `clockIntervalMs` the anchor throttle. */
export function createDeriver(opts: { now(): number; clockIntervalMs: number }): Deriver {
  let m: Media | undefined;

  const ev = (media: Media, e: EventBody): EngineEvent => ({ attempt: media.token, ...e });

  const rate = (media: Media): number =>
    media.paused || media.cache || media.seeking || media.idle ? 0 : media.speed;

  const anchor = (media: Media): EngineEvent[] => {
    if (media.timePos === undefined) return [];
    const atMs = opts.now();
    media.lastAnchorAt = atMs;
    const a: ClockAnchor = {
      positionMs: Math.round(media.timePos * 1000),
      atMs,
      rate: rate(media),
    };
    if (media.kind === 'vod' && media.duration !== undefined)
      a.durationMs = Math.round(media.duration * 1000);
    if (media.kind === 'live' && media.cacheEnd !== undefined)
      a.liveEdgeMs = Math.round(media.cacheEnd * 1000);
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
    });
    m = undefined;
    if (outcome.kind === 'stopped') return [];
    if (outcome.kind === 'ended') return [ev(media, { type: 'state', state: 'ended' })];
    return [ev(media, { type: 'error', error: outcome.error })];
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
      case 'time-pos': {
        const next = num(value);
        if (next === undefined) return [];
        media.timePos = next;
        const due = opts.now() - media.lastAnchorAt >= opts.clockIntervalMs;
        return media.restarted && due ? anchor(media) : [];
      }
      case 'video-params':
        if (typeof value !== 'object' || value === null) return [];
        media.frameReady = true;
        return frameThenSettle(media);
      case 'vid':
        if (value !== false && value !== 'no') return [];
        media.frameReady = true;
        return frameThenSettle(media);
      case 'duration':
        media.duration = num(value);
        return [];
      case 'demuxer-cache-state':
        media.cacheEnd =
          typeof value === 'object' && value !== null
            ? num((value as Record<string, unknown>)['cache-end'])
            : undefined;
        return [];
      default:
        return [];
    }
  };

  return {
    begin(token, kind) {
      m = {
        token,
        kind,
        logs: [],
        state: 'opening',
        restarted: false,
        firstFrameSent: false,
        frameReady: false,
        stalled: false,
        paused: false,
        cache: false,
        idle: false,
        seeking: false,
        speed: 1,
        timePos: undefined,
        duration: undefined,
        cacheEnd: undefined,
        lastAnchorAt: Number.NEGATIVE_INFINITY,
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
      if (!m?.restarted || rate(m) === 0) return [];
      return opts.now() - m.lastAnchorAt >= opts.clockIntervalMs ? anchor(m) : [];
    },
  };
}
