import type { SubtitleStyleConfig } from '@elv/domain';
import {
  type ExternalSubtitleTrack,
  type LoadCommand,
  type MediaKind,
  normalizeExternalSubtitleTrack,
} from '@elv/playback';
import type { QueueNextRequest } from '../../shared/player-ipc.ts';
import type { MpvCommand } from './mpv/codec.ts';
import type { MediaRequest, MediaSlot, QueuedMediaSlot } from './mpv/live-session.ts';

/** Threshold (ms) above which a VOD seek snaps via `absolute+keyframes` for snappy skips. */
const VOD_KEYFRAME_SEEK_THRESHOLD_MS = 30_000;

/** Order-independent equality check for normalized custom `http-header-fields` entries. */
export function sameHeaderFields(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Returns a copy of `request` with `startMs` replaced or omitted. */
export function withStart(request: MediaRequest, startMs: number | undefined): MediaRequest {
  const { startMs: _old, ...rest } = request;
  return startMs === undefined ? rest : { ...rest, startMs };
}

/** Builds an mpv `sub-add` command preserving optional title and language arguments. */
export function buildSubAddCommand(
  localPath: string,
  track: ExternalSubtitleTrack,
  flags: 'select' | 'auto',
): MpvCommand {
  const label = track.label ?? '';
  const lang = track.language ?? '';
  if (lang.length > 0) return ['sub-add', localPath, flags, label, lang];
  if (label.length > 0) return ['sub-add', localPath, flags, label];
  return ['sub-add', localPath, flags];
}

/** Builds a normalized {@link MediaRequest} from a {@link LoadCommand} and effective subtitle style. */
export function buildLoadMediaRequest(
  cmd: LoadCommand,
  effectiveStyle: SubtitleStyleConfig | undefined,
): MediaRequest {
  const { url, headers, kind, options } = cmd;
  const externalSubtitles =
    options?.externalSubtitles === undefined
      ? undefined
      : options.externalSubtitles
          .map((t) => normalizeExternalSubtitleTrack(t))
          .filter((t): t is ExternalSubtitleTrack => t !== null);
  // Desktop mpv inherits OS TLS with `--tls-verify=yes` (never disabled; mpv/FFmpeg has no
  // safe per-file legacy-TLS-min-version flag), while Node `legacy-tls-http.ts` handles
  // opt-in legacy TLS for catalog and XMLTV fetches (`#182`).
  const req: MediaRequest = {
    url,
    headers,
    kind,
    ...(options?.preferHevcOverDolbyVision === undefined
      ? {}
      : { preferHevcOverDolbyVision: options.preferHevcOverDolbyVision }),
    ...(options?.filterSdhSubtitles === undefined
      ? {}
      : { filterSdhSubtitles: options.filterSdhSubtitles }),
    ...(effectiveStyle === undefined ? {} : { subtitleStyle: effectiveStyle }),
    ...(externalSubtitles === undefined || externalSubtitles.length === 0
      ? {}
      : { externalSubtitles }),
    ...(options?.programId === undefined ? {} : { programId: options.programId }),
    ...(options?.bufferPreset === undefined ? {} : { bufferPreset: options.bufferPreset }),
  };
  return withStart(req, cmd.startMs);
}

/** Builds a {@link QueuedMediaSlot} inheriting the active VOD slot's token and buffer preset. */
export function buildQueuedMediaSlot(
  ownerSlot: MediaSlot,
  request: QueueNextRequest,
): QueuedMediaSlot {
  const nextReq: MediaRequest = {
    url: request.stream.url,
    headers: request.stream.headers,
    kind: 'vod',
    ...(ownerSlot.request.bufferPreset === undefined
      ? {}
      : { bufferPreset: ownerSlot.request.bufferPreset }),
    ...(request.preferHevcOverDolbyVision === undefined
      ? {}
      : { preferHevcOverDolbyVision: request.preferHevcOverDolbyVision }),
    ...(request.filterSdhSubtitles === undefined
      ? {}
      : { filterSdhSubtitles: request.filterSdhSubtitles }),
  };
  return {
    itemKey: request.itemKey,
    token: ownerSlot.token,
    request: nextReq,
  };
}

/**
 * Resolves the mpv `seek` mode flag:
 * - Live TV timeshift keeps `'absolute'`.
 * - VOD while scrubbing or jumping by `>= 30 s` snaps via `'absolute+keyframes'`.
 * - Fine `< 30 s` VOD nudges use `'absolute+exact'` so accuracy never depends on `hr-seek`.
 */
export function resolveSeekMode(
  kind: MediaKind | undefined,
  isScrubbing: boolean,
  lastPositionMs: number | undefined,
  targetMs: number,
): 'absolute' | 'absolute+exact' | 'absolute+keyframes' {
  if (kind !== 'vod') return 'absolute';
  if (
    isScrubbing ||
    (lastPositionMs !== undefined &&
      Math.abs(targetMs - lastPositionMs) >= VOD_KEYFRAME_SEEK_THRESHOLD_MS)
  ) {
    return 'absolute+keyframes';
  }
  return 'absolute+exact';
}
