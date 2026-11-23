import type { StreamHdrKind, StreamVideoInfo } from '@elv/playback';

interface MediaInfoBody {
  readonly type: 'mediaInfo';
  readonly info: StreamVideoInfo;
}

/** Per-media mpv decoded video metadata tracker (`#58`). */
export interface MpvVideoInfoTracker {
  onVideoParams(value: unknown): MediaInfoBody | undefined;
  onVideoFormat(value: unknown): MediaInfoBody | undefined;
  onVideoCodec(value: unknown): MediaInfoBody | undefined;
  onContainerFps(value: unknown): MediaInfoBody | undefined;
  onEstimatedVfFps(value: unknown): MediaInfoBody | undefined;
}

const FPS_JITTER_TOLERANCE = 0.5;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

const posFloat = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

const posFps = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined;

function extractAspectRatio(params: Record<string, unknown>, w: number, h: number): number {
  const aspect = posFloat(params['aspect']);
  if (aspect !== undefined) return aspect;
  const dw = posFloat(params['dw']);
  const dh = posFloat(params['dh']);
  if (dw !== undefined && dh !== undefined) return dw / dh;
  return w / h;
}

const lowerStr = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Normalizes mpv `video-format` / `video-codec` strings into canonical short codec identifiers. */
function normalizeMpvVideoCodec(raw: unknown): string | undefined {
  const s = lowerStr(raw);
  if (s === undefined) return undefined;
  if (/\b(hevc|h\.?265|x265|hev1|hvc1|dvhe|dvh1)\b/.test(s)) return 'hevc';
  if (/\b(h\.?264|avc1?|x264|dvav|dva1)\b/.test(s)) return 'h264';
  if (/\b(av0?1|dav1)\b/.test(s)) return 'av1';
  if (/\b(vp0?9)\b/.test(s)) return 'vp9';
  if (/\b(vp0?8)\b/.test(s)) return 'vp8';
  if (/\b(mpeg2video|mpeg2|mp2v)\b/.test(s)) return 'mpeg2';
  if (/\b(vc1|wvc1)\b/.test(s)) return 'vc1';
  if (/\b(mpeg4|mp4v)\b/.test(s)) return 'mpeg4';
  const token = s.split(/[\s/(,]+/)[0];
  return token && token.length > 0 ? token : undefined;
}

function containsDolbyVision(raw: string | undefined): boolean {
  return raw !== undefined && /(dolby|dovi|dvhe|dvh1|dvav|dva1|dav1)/.test(raw);
}

function classifyMpvHdr(
  params: Record<string, unknown>,
  rawCodecHint: string | undefined,
): StreamHdrKind {
  const gamma = lowerStr(params['gamma']);
  const primaries = lowerStr(params['primaries']);
  const colormatrix = lowerStr(params['colormatrix']);
  if (
    params['dolbyvision'] === true ||
    containsDolbyVision(gamma) ||
    containsDolbyVision(primaries) ||
    containsDolbyVision(colormatrix) ||
    containsDolbyVision(rawCodecHint)
  ) {
    return 'dv';
  }
  if (gamma === 'pq' || gamma === 'st2084' || gamma === 'smpte2084') return 'hdr10';
  if (gamma === 'hlg' || gamma === 'arib-std-b67') return 'hlg';
  return 'sdr';
}

function sameInfo(a: StreamVideoInfo | undefined, b: StreamVideoInfo): boolean {
  return (
    a !== undefined &&
    a.width === b.width &&
    a.height === b.height &&
    a.aspectRatio === b.aspectRatio &&
    a.fps === b.fps &&
    a.codec === b.codec &&
    a.hdr === b.hdr
  );
}

/** Creates a per-media tracker deriving deduplicated `StreamVideoInfo` events from mpv properties. */
export function createMpvVideoInfoTracker(): MpvVideoInfoTracker {
  let width: number | undefined;
  let height: number | undefined;
  let aspectRatio: number | undefined;
  let containerFps: number | undefined;
  let estimatedFps: number | undefined;
  let formatCodec: string | undefined;
  let fallbackCodec: string | undefined;
  let rawCodecHint: string | undefined;
  let lastParams: Record<string, unknown> | undefined;
  let lastEmitted: StreamVideoInfo | undefined;

  const commit = (): MediaInfoBody | undefined => {
    const codec = formatCodec ?? fallbackCodec;
    const fps = estimatedFps ?? containerFps;
    const hdr = lastParams !== undefined ? classifyMpvHdr(lastParams, rawCodecHint) : undefined;
    if (
      width === undefined &&
      height === undefined &&
      aspectRatio === undefined &&
      fps === undefined &&
      codec === undefined &&
      hdr === undefined
    ) {
      return undefined;
    }
    const next: StreamVideoInfo = {
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(aspectRatio === undefined ? {} : { aspectRatio }),
      ...(fps === undefined ? {} : { fps }),
      ...(codec === undefined ? {} : { codec }),
      ...(hdr === undefined ? {} : { hdr }),
    };
    if (sameInfo(lastEmitted, next)) return undefined;
    lastEmitted = next;
    return { type: 'mediaInfo', info: next };
  };

  return {
    onVideoParams(value) {
      if (!isRecord(value)) return undefined;
      const w = posInt(value['w']);
      const h = posInt(value['h']);
      if (w === undefined || h === undefined) return undefined;
      width = w;
      height = h;
      aspectRatio = extractAspectRatio(value, w, h);
      lastParams = value;
      return commit();
    },

    onVideoFormat(value) {
      const raw = lowerStr(value);
      if (raw !== undefined) rawCodecHint = raw;
      const normalized = normalizeMpvVideoCodec(value);
      if (normalized === undefined) return undefined;
      formatCodec = normalized;
      return commit();
    },

    onVideoCodec(value) {
      const raw = lowerStr(value);
      if (raw !== undefined && rawCodecHint === undefined) rawCodecHint = raw;
      const normalized = normalizeMpvVideoCodec(value);
      if (normalized === undefined) return undefined;
      fallbackCodec = normalized;
      return commit();
    },

    onContainerFps(value) {
      const fps = posFps(value);
      if (fps === undefined) return undefined;
      containerFps = fps;
      return commit();
    },

    onEstimatedVfFps(value) {
      const fps = posFps(value);
      if (fps === undefined) return undefined;
      const baseline = estimatedFps ?? lastEmitted?.fps;
      if (baseline !== undefined && Math.abs(fps - baseline) < FPS_JITTER_TOLERANCE) {
        return undefined;
      }
      estimatedFps = fps;
      return commit();
    },
  };
}
