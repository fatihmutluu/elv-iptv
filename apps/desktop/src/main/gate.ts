import type { EngineEvent } from '@elv/playback';
import type { PlayerArea } from '../shared/player-ipc.ts';
import { areaToScreen, type Rect } from './player/presenter/bounds.ts';

const FLAG = '--elv-gate=';
const MAX_QUERY_CHARS = 2048;
const LINE_PREFIX = 'ELV_GATE_PLAYER ';
const CORPUS_LINE_PREFIX = 'ELV_GATE_CORPUS ';

/** Line printed once when the gate engine first enters `playing`, so the orphan check knows when to kill main. */
export const GATE_PLAYING_LINE = 'ELV_GATE_PLAYING';

/** Distinct 5-bit colour buckets in the sampled area from which it counts as video (idle mpv and black stay below). */
export const GATE_VIDEO_BUCKETS = 16;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * The query of `--elv-gate=<query>` (for example `elv-gate=player&zaps=5`) from the process arguments, or `null`.
 * Packaged builds ignore the flag, as does a query that is not a player gate query, is longer than 2,048 characters or
 * holds a control character. The first flag wins.
 */
export function parseGateFlag(argv: readonly string[], isPackaged: boolean): string | null {
  if (isPackaged) return null;
  const arg = argv.find((a) => a.startsWith(FLAG));
  if (arg === undefined) return null;
  const query = arg.slice(FLAG.length);
  if (query.length > MAX_QUERY_CHARS || hasControlChar(query)) return null;
  const parts = query.split('&');
  return parts.includes('elv-gate=player') || parts.includes('elv-gate=corpus') ? query : null;
}

/** What main measures and adds to the renderer's line. */
export interface GateExtras {
  /** mpv processes started. */
  mpvSpawns: number;
  loadMode: string;
  presenter: string;
  /** The sampled area showed video; `null` when the capture returned no image. */
  videoVisible: boolean | null;
  /** Distinct colour buckets of the sample (0: no image). */
  distinct: number;
  /** The longest a load waited for the previous one to open. */
  coalesceMaxMs: number;
}

/**
 * Adds main's fields to the renderer's `ELV_GATE_PLAYER {json}` line and returns the single merged line. `null` for
 * a line that is not an object after the prefix, or that holds an `http(s)://` address: the gate line never carries
 * stream URLs or headers.
 */
export function mergeGateLine(line: string, extras: GateExtras): string | null {
  const prefix = line.startsWith(LINE_PREFIX)
    ? LINE_PREFIX
    : line.startsWith(CORPUS_LINE_PREFIX)
      ? CORPUS_LINE_PREFIX
      : null;
  if (prefix === null || /https?:\/\//i.test(line)) return null;
  let body: unknown;
  try {
    body = JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return `${prefix}${JSON.stringify({ ...body, ...extras })}`;
}

/** The middle half of a window's content bounds: the fallback when no player area is known. */
export function centerRect(bounds: Rect): Rect {
  return {
    x: bounds.x + Math.round(bounds.width / 4),
    y: bounds.y + Math.round(bounds.height / 4),
    width: Math.round(bounds.width / 2),
    height: Math.round(bounds.height / 2),
  };
}

/**
 * The screen rect (DIPs) to sample: the engine's last area mapped like the presenter does (content origin plus the area
 * scaled by the page zoom), or the middle half of the content when no usable area is known.
 */
export function sampleRect(content: Rect, area: PlayerArea | undefined, zoomFactor: number): Rect {
  if (!area?.visible || area.width <= 0 || area.height <= 0) return centerRect(content);
  return areaToScreen(content, area, zoomFactor);
}

/** What the sampler concluded about the picture. */
interface VideoSample {
  videoVisible: boolean | null;
  distinct: number;
}

/** Samples the screen once after the first frame. */
export interface VideoSampler {
  /** Resolves with the sample; waits for a pending one, and answers `false` at once when no frame ever came. */
  result(): Promise<VideoSample>;
}

/** What {@link createVideoSampler} needs. */
export interface VideoSamplerDeps {
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** Captures the player area; `distinct` 0 means no image. */
  sample(): Promise<{ distinct: number }>;
  setTimeout(fn: () => void, ms: number): unknown;
  /** Wait between the first `firstFrame` and the capture. */
  delayMs: number;
}

/** Starts watching at once; the sample is taken `delayMs` after the first `firstFrame` and never again. */
export function createVideoSampler(deps: VideoSamplerDeps): VideoSampler {
  let pending: Promise<VideoSample> | undefined;
  const off = deps.subscribe((event) => {
    if (event.type !== 'firstFrame' || pending) return;
    off();
    pending = new Promise<VideoSample>((resolve) => {
      deps.setTimeout(() => {
        deps.sample().then(
          ({ distinct }) =>
            resolve({
              videoVisible: distinct === 0 ? null : distinct >= GATE_VIDEO_BUCKETS,
              distinct,
            }),
          () => resolve({ videoVisible: null, distinct: 0 }),
        );
      }, deps.delayMs);
    });
  });
  return {
    result: () => pending ?? Promise.resolve({ videoVisible: false, distinct: 0 }),
  };
}

/** Calls `emit` once on the engine's first `playing` state and unsubscribes. */
export function onFirstPlaying(
  subscribe: (listener: (event: EngineEvent) => void) => () => void,
  emit: () => void,
): void {
  let done = false;
  const off = subscribe((event) => {
    if (done || event.type !== 'state' || event.state !== 'playing') return;
    done = true;
    off();
    emit();
  });
}
