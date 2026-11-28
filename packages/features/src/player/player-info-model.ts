import type { AppI18n } from '@elv/i18n';
import { resolveLanguageLabel } from '@elv/i18n';
import type { MediaTracks, StreamVideoInfo } from '@elv/playback';

/** Badge tone rendered inside the merged `PlayerStatsHud`. */
type StreamQualityBadgeTone = 'accent' | 'neutral';

/** Single decoded quality or active track badge derived strictly from live stream telemetry. */
export interface StreamQualityBadge {
  readonly key: string;
  readonly label: string;
  readonly tone: StreamQualityBadgeTone;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Formats a local `HH:MM–HH:MM` broadcast window for EPG display. */
export function formatProgrammeWindow(startMs: number, stopMs: number): string {
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return '';
  const s = new Date(startMs);
  const e = new Date(stopMs);
  return `${pad2(s.getHours())}:${pad2(s.getMinutes())}–${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
}

/** Computes clamped `[0, 100]` percentage progress across a live programme window. */
export function computeProgrammeProgress(startMs: number, stopMs: number, nowMs: number): number {
  const span = stopMs - startMs;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(nowMs)) return 0;
  return Math.round(Math.max(0, Math.min(1, (nowMs - startMs) / span)) * 1000) / 10;
}

function formatResolution(w?: number, h?: number): string | null {
  const height = typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.round(h) : 0;
  const width = typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.round(w) : 0;
  if (height <= 0 && width <= 0) return null;
  const tier =
    height >= 2160 || width >= 3840
      ? '4K'
      : height >= 1440 || width >= 2560
        ? '1440p'
        : height >= 1080 || width >= 1920
          ? '1080p'
          : height >= 720 || width >= 1280
            ? '720p'
            : height > 0
              ? `${height}p`
              : `${width}w`;
  return width > 0 && height > 0 ? `${tier} · ${width}×${height}` : tier;
}

function formatFps(fps?: number): string | null {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return null;
  const rounded = Math.round(fps);
  return `${Math.abs(fps - rounded) < 0.01 ? String(rounded) : fps.toFixed(2)} fps`;
}

function formatChannelLayout(channels?: number): string | undefined {
  if (channels === undefined || !Number.isFinite(channels) || channels <= 0) return undefined;
  if (channels === 1) return '1.0';
  if (channels === 2) return '2.0';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

/**
 * Derives compact stream quality badges strictly from real `StreamVideoInfo`
 * and active `MediaTracks` selections (never fabricating fallback values).
 */
export function buildStreamQualityBadges(
  videoInfo: StreamVideoInfo | undefined,
  tracks: MediaTracks,
  i18n: AppI18n,
): readonly StreamQualityBadge[] {
  const badges: StreamQualityBadge[] = [];
  const res = formatResolution(videoInfo?.width, videoInfo?.height);
  if (res !== null) {
    const uhd = (videoInfo?.height ?? 0) >= 2160 || (videoInfo?.width ?? 0) >= 3840;
    badges.push({ key: 'resolution', label: res, tone: uhd ? 'accent' : 'neutral' });
  }
  const fps = formatFps(videoInfo?.fps);
  if (fps !== null) badges.push({ key: 'fps', label: fps, tone: 'neutral' });
  const codec = videoInfo?.codec?.trim();
  if (codec) badges.push({ key: 'vcodec', label: codec.toUpperCase(), tone: 'neutral' });
  if (videoInfo?.hdr === 'hdr10') badges.push({ key: 'hdr', label: 'HDR10', tone: 'accent' });
  else if (videoInfo?.hdr === 'dv') badges.push({ key: 'hdr', label: 'DV', tone: 'accent' });
  else if (videoInfo?.hdr === 'hlg') badges.push({ key: 'hdr', label: 'HLG', tone: 'accent' });

  const audio = tracks.audio.find((t) => t.id === tracks.selectedAudioId);
  if (audio !== undefined) {
    const ac = audio.codec?.trim();
    const parts = [ac ? ac.toUpperCase() : undefined, formatChannelLayout(audio.channels)].filter(
      (p): p is string => p !== undefined,
    );
    const label =
      parts.length > 0
        ? parts.join(' ')
        : (resolveLanguageLabel(audio.language, i18n) ??
          audio.label?.trim() ??
          audio.language?.trim());
    if (label) badges.push({ key: 'audio', label, tone: 'neutral' });
  }
  const sub = tracks.subtitles.find((t) => t.id === tracks.selectedSubtitleId);
  if (sub !== undefined) {
    const lang =
      resolveLanguageLabel(sub.language, i18n) ?? sub.label?.trim() ?? sub.language?.trim();
    if (lang) {
      badges.push({
        key: 'subtitle',
        label: `${i18n.t('player.subtitleTracks')}: ${lang}`,
        tone: 'neutral',
      });
    }
  }
  return badges;
}
