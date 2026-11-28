import type { ItemRow, LiveVariantOption } from '@elv/data';
import type { AndroidDecoderMode, DefaultResizeModePref } from '@elv/domain';
import { type AppI18n, resolveLanguageLabel } from '@elv/i18n';
import {
  type BufferHealth,
  type MediaTracks,
  type PlaybackClock,
  type PlaybackState,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
  type StreamVideoInfo,
  type TrackInfo,
} from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import type { MutableRefObject } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { AudioDeviceInfo, VideoResizeMode } from '../ports/video-host';
import { describePlaybackFailure } from './errors';
import type { SettingsMenuState } from './settings-menu-nav';
import type { TvOsdAction } from './tv-osd-nav';

/** Progressive 3-tier OSD visibility state (`#391`). */
export type OsdTier = 'hidden' | 'progress' | 'controls';

/** Short auto-hide timeout (`2 000 ms`) used when OSD is in the lightweight `'progress'` peek tier (`#391`). */
export const PROGRESS_OSD_AUTO_HIDE_MS = 2_000;

/** Compact telemetry badge shown in the player header/info surfaces (`#58`). */
export interface StreamBadge {
  readonly key: string;
  readonly label: string;
  readonly tone?: 'neutral' | 'accent';
}

const KNOWN_AUDIO_BADGE_CODECS: Readonly<Record<string, string>> = {
  EAC3: 'EAC3',
  EC3: 'EAC3',
  AC3: 'AC3',
  DTS: 'DTS',
  DTSHD: 'DTS',
  TRUEHD: 'TRUEHD',
  MLP: 'TRUEHD',
  FLAC: 'FLAC',
  ATMOS: 'ATMOS',
};

function finitePositive(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
}

function formatAudioBadgeLabel(track: TrackInfo | undefined): string | undefined {
  if (track === undefined) return undefined;
  if (track.channels === 8) return '7.1';
  if (track.channels === 6) return '5.1';
  const raw = track.codec?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const normalized = raw
    .replace(/^audio\//i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase();
  return KNOWN_AUDIO_BADGE_CODECS[normalized];
}

/**
 * Derives up to 4 concise stream badges (resolution, high frame rate, HDR, audio format)
 * strictly from real decoded {@link StreamVideoInfo} and active {@link MediaTracks} (`#58`).
 */
export function formatStreamBadges(
  videoInfo: StreamVideoInfo | undefined,
  tracks: MediaTracks,
): readonly StreamBadge[] {
  const badges: StreamBadge[] = [];
  const h = finitePositive(videoInfo?.height);
  const w = finitePositive(videoInfo?.width);

  if (h >= 2160 || w >= 3840) badges.push({ key: 'res', label: '4K', tone: 'accent' });
  else if (h >= 1440 || w >= 2560) badges.push({ key: 'res', label: '1440p', tone: 'neutral' });
  else if (h >= 1080 || w >= 1920) badges.push({ key: 'res', label: '1080p', tone: 'neutral' });
  else if (h >= 720 || w >= 1280) badges.push({ key: 'res', label: '720p', tone: 'neutral' });
  else if (h >= 480 || w >= 854) badges.push({ key: 'res', label: '480p', tone: 'neutral' });

  if (videoInfo?.fps !== undefined && Number.isFinite(videoInfo.fps) && videoInfo.fps >= 45) {
    badges.push({ key: 'fps', label: `${Math.round(videoInfo.fps)} fps`, tone: 'neutral' });
  }

  if (videoInfo?.hdr === 'dv') badges.push({ key: 'hdr', label: 'DV', tone: 'accent' });
  else if (videoInfo?.hdr === 'hdr10') badges.push({ key: 'hdr', label: 'HDR10', tone: 'accent' });
  else if (videoInfo?.hdr === 'hlg') badges.push({ key: 'hdr', label: 'HLG', tone: 'accent' });

  const activeAudio = tracks.audio.find((t) => t.id === tracks.selectedAudioId);
  const audioLabel = formatAudioBadgeLabel(activeAudio);
  if (audioLabel !== undefined) badges.push({ key: 'audio', label: audioLabel, tone: 'neutral' });

  return badges.slice(0, 4);
}

/** Clamps a volume percentage to an integer in `[0, 100]` (`#394`). */
export function clampVolume(v: number): number {
  if (Number.isNaN(v) || v <= 0) return 0;
  if (v >= 100) return 100;
  return Math.round(v);
}

/** Adjusts `current` volume by `delta` (default `5`), clamped to `[0, 100]` (`#394`). */
export function stepVolume(current: number, delta = 5): number {
  const base = clampVolume(current);
  if (!Number.isFinite(delta)) return base;
  return clampVolume(base + delta);
}

/** Live mutable snapshot shared with synchronous key handlers in `usePlayerControls`. */
export interface PlayerOverlayLive {
  settingsOpen: boolean;
  settingsMenu: SettingsMenuState;
  windowModeOpen: boolean;
  channelListOpen: boolean;
  canOpenChannelList: boolean;
  locked: boolean;
  osdTier: OsdTier;
  osdHidden: boolean;
  tvOsdFocused: boolean;
  tvScrubberFocused: boolean;
  tvOsdAction: TvOsdAction;
  availableOsd: TvOsdAction[];
  tracks: MediaTracks;
  hasTracks: boolean;
  hasService: boolean;
  isVod: boolean;
  playbackSpeed: number;
}

/** Parameters of {@link usePlayerOverlayState}. */
export interface PlayerOverlayStateParams {
  formFactor: FormFactor;
  itemKey: string;
  /** Target identity key distinguishing catch-up archive from live playback on the same channel (`#27`). */
  resetKey?: string;
  isVod: boolean;
  playbackSpeed?: number;
  statusKind: PlaybackStatus['kind'];
  tracks: MediaTracks;
  hasTracks: boolean;
  hasService: boolean;
  showRetry: boolean;
  hasSettings: boolean;
  hasChannelList?: boolean | undefined;
  hasPitchLock?: boolean | undefined;
  hasAudioNormalization?: boolean | undefined;
  hasAutoPlayNextEpisode?: boolean | undefined;
  hasAudioDevice?: boolean | undefined;
  audioDevices?: readonly AudioDeviceInfo[] | undefined;
  activeAudioDevice?: string | undefined;
  hasAudioDelay?: boolean | undefined;
  audioDelayMs?: number | undefined;
  hasSubtitleDelay?: boolean | undefined;
  subtitleDelayMs?: number | undefined;
  hasSubtitleStyle?: boolean | undefined;
  hasDualSubtitles?: boolean | undefined;
  canPickSubtitleFile?: boolean | undefined;
  canLoadSubtitleUrl?: boolean | undefined;
  hasVideoQuality?: boolean | undefined;
  selectedVideoQualityId?: string | null | undefined;
  qualityVariants?: readonly LiveVariantOption[] | undefined;
  hasVideoDecoder?: boolean | undefined;
  androidDecoderMode?: AndroidDecoderMode | undefined;
  hasSleepTimer?: boolean | undefined;
  sleepTimerMinutes?: number | undefined;
  hasPip?: boolean | undefined;
  hasMultiView?: boolean | undefined;
  hasWindowModeMenu?: boolean | undefined;
  hasNextEpisode: boolean;
  hasPreviousChannel: boolean;
  hasBackToLive?: boolean;
  liveTimeShiftSupported?: boolean;
  hasJumpToLive?: boolean;
  initialOsdHidden?: boolean | undefined;
  autoHideOsdMs?: number | undefined;
  defaultResizeMode?: DefaultResizeModePref | undefined;
  isScrubbing: boolean;
  clockRef: MutableRefObject<PlaybackClock>;
  timersRef: MutableRefObject<PlaybackTimers>;
  cancelScrub: () => void;
  onResizeModeChange?: ((mode: VideoResizeMode) => void) | undefined;
  onSetOrientationLocked?: ((locked: boolean) => void) | undefined;
  onSetDeinterlace?: ((enabled: boolean) => void) | undefined;
}

/** Progress ratio threshold (`>= 90%`) at which the Next Episode banner appears. */
export const NEXT_EPISODE_RATIO_THRESHOLD = 0.9;

/** Remaining time threshold (`<= 45s`) for showing Next Episode on longer episodes. */
export const NEXT_EPISODE_REMAINING_MS = 45_000;

/** Minimum episode duration (`2m`) required before the 45-second remaining rule applies. */
export const NEXT_EPISODE_MIN_DURATION_MS = 120_000;

/** Input evaluated by {@link shouldShowNextEpisodePrompt}. */
export interface NextEpisodePromptInput {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly statusKind: PlaybackStatus['kind'];
  readonly hasNextEpisode: boolean;
  readonly dismissed: boolean;
}

/**
 * Pure gate for the floating Next Episode prompt (`#353`).
 * Returns `true` when another episode is queued, not dismissed, and playback has ended or reached
 * either `>= 90%` progress or the final 45 seconds of an episode at least 2 minutes long.
 */
export function shouldShowNextEpisodePrompt(input: NextEpisodePromptInput): boolean {
  if (!input.hasNextEpisode || input.dismissed) return false;
  if (input.statusKind === 'ended') return true;
  const { positionMs, durationMs } = input;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  if (!Number.isFinite(positionMs) || positionMs < 0) return false;
  if (positionMs / durationMs >= NEXT_EPISODE_RATIO_THRESHOLD) return true;
  return (
    durationMs >= NEXT_EPISODE_MIN_DURATION_MS &&
    durationMs - positionMs <= NEXT_EPISODE_REMAINING_MS
  );
}

/** Pops the next queued episode as a fresh {@link PlayTarget} starting at `0 ms`. */
export function buildNextEpisodeTarget(current: PlayTarget): PlayTarget | null {
  const queue = current.nextEpisodes;
  if (queue === undefined || queue.length === 0) return null;
  const [next, ...rest] = queue;
  if (next === undefined) return null;
  return {
    ...next,
    startPositionMs: 0,
    ...(rest.length > 0 ? { nextEpisodes: rest } : {}),
  };
}

/** Whether OSD auto-hide may arm based on playback status and active modal/focus state. */
export function canAutoHideOsd(
  statusKind: PlaybackStatus['kind'],
  live: Pick<
    PlayerOverlayLive,
    'osdHidden' | 'settingsOpen' | 'locked' | 'tvOsdFocused' | 'tvScrubberFocused'
  > &
    Partial<Pick<PlayerOverlayLive, 'osdTier' | 'windowModeOpen' | 'channelListOpen'>>,
  isScrubbing: boolean,
): boolean {
  const isHidden = live.osdTier !== undefined ? live.osdTier === 'hidden' : live.osdHidden;
  return (
    statusKind === 'playing' &&
    !isHidden &&
    !isScrubbing &&
    !live.settingsOpen &&
    live.windowModeOpen !== true &&
    live.channelListOpen !== true &&
    !live.locked &&
    !live.tvOsdFocused &&
    !live.tvScrubberFocused
  );
}

/** Whether `value` is a thenable / Promise. */
export function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Whether any non-`itemKey` metadata field on {@link PlayTarget} changed across renders. */
export function hasTargetMetaChanged(prev: PlayTarget, next: PlayTarget): boolean {
  return (
    prev.playlist !== next.playlist ||
    prev.title !== next.title ||
    prev.sourceId !== next.sourceId ||
    prev.accountKey !== next.accountKey ||
    prev.logo !== next.logo ||
    prev.subtitle !== next.subtitle ||
    prev.seriesKey !== next.seriesKey ||
    prev.season !== next.season ||
    prev.episode !== next.episode ||
    prev.itemKind !== next.itemKind ||
    prev.nextEpisodes !== next.nextEpisodes ||
    prev.previousChannel !== next.previousChannel ||
    prev.previousChannelIndex !== next.previousChannelIndex ||
    prev.catchup !== next.catchup
  );
}

/** Copies the flat {@link PlayableEntry} fields of a {@link PlayTarget} without nested history. */
export function toPlayableEntry(target: PlayTarget): PlayableEntry {
  return {
    itemKey: target.itemKey,
    sourceId: target.sourceId,
    ...(target.accountKey !== undefined ? { accountKey: target.accountKey } : {}),
    title: target.title,
    kind: target.kind,
    ...(target.startPositionMs !== undefined ? { startPositionMs: target.startPositionMs } : {}),
    ...(target.logo !== undefined ? { logo: target.logo } : {}),
    ...(target.subtitle !== undefined ? { subtitle: target.subtitle } : {}),
    ...(target.seriesKey !== undefined ? { seriesKey: target.seriesKey } : {}),
    ...(target.season !== undefined ? { season: target.season } : {}),
    ...(target.episode !== undefined ? { episode: target.episode } : {}),
    ...(target.itemKind !== undefined ? { itemKind: target.itemKind } : {}),
  };
}

/** Converts a live catalog {@link ItemRow} to a {@link PlayableEntry}, preserving same-source pool key. */
export function itemRowToPlayableEntry(row: ItemRow, current: PlayTarget): PlayableEntry {
  return {
    itemKey: row.key,
    sourceId: row.sourceId,
    ...(current.accountKey !== undefined && row.sourceId === current.sourceId
      ? { accountKey: current.accountKey }
      : {}),
    title: row.name,
    kind: 'live',
    itemKind: 'live',
    ...(row.logo !== null ? { logo: row.logo } : {}),
  };
}

/** Builds the next live {@link PlayTarget} for direct channel number entry, preserving previous-channel history. */
export function buildChannelJumpTarget(
  current: PlayTarget,
  entry: PlayableEntry,
  nextIndex?: number,
): PlayTarget | null {
  if (entry.itemKey === current.itemKey) return null;
  const playlist = current.playlist;
  const hasValidIdx =
    playlist !== undefined &&
    nextIndex !== undefined &&
    Number.isInteger(nextIndex) &&
    nextIndex >= 0 &&
    nextIndex < playlist.count;
  const nextPlaylist =
    playlist !== undefined
      ? hasValidIdx
        ? { ...playlist, currentIndex: nextIndex }
        : playlist
      : undefined;
  const prevIndex = playlist !== undefined ? playlist.currentIndex : undefined;
  return {
    ...entry,
    ...(nextPlaylist !== undefined ? { playlist: nextPlaylist } : {}),
    previousChannel: toPlayableEntry(current),
    ...(prevIndex !== undefined ? { previousChannelIndex: prevIndex } : {}),
  };
}

/**
 * Swaps `current.previousChannel` into the active {@link PlayTarget}, updating `playlist.currentIndex`
 * from `previousChannelIndex` when valid and storing a flat {@link PlayableEntry} copy of `current`
 * (plus its old playlist index) as the new previous channel.
 */
export function buildPreviousChannelTarget(current: PlayTarget): PlayTarget | null {
  const prev = current.previousChannel;
  if (prev === undefined || prev.itemKey === current.itemKey) return null;
  const playlist = current.playlist;
  const prevIdx = current.previousChannelIndex;
  const hasValidPrevIdx =
    playlist !== undefined &&
    prevIdx !== undefined &&
    Number.isInteger(prevIdx) &&
    prevIdx >= 0 &&
    prevIdx < playlist.count;
  const nextPlaylist =
    playlist !== undefined
      ? hasValidPrevIdx
        ? { ...playlist, currentIndex: prevIdx }
        : playlist
      : undefined;
  const nextPreviousIndex = playlist !== undefined ? playlist.currentIndex : undefined;
  return {
    ...prev,
    ...(nextPlaylist !== undefined ? { playlist: nextPlaylist } : {}),
    previousChannel: toPlayableEntry(current),
    ...(nextPreviousIndex !== undefined ? { previousChannelIndex: nextPreviousIndex } : {}),
  };
}

function formatClockPosition(ms: number): string {
  if (!Number.isFinite(ms)) return '0:00';
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(clamped % 60).padStart(2, '0');
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

function formatStatusText(status: PlaybackStatus, i18n: Pick<AppI18n, 't'>): string {
  switch (status.kind) {
    case 'idle':
      return i18n.t('player.status.idle');
    case 'tuning':
      return i18n.t('player.status.tuning');
    case 'playing':
      return i18n.t('player.status.playing');
    case 'paused':
      return i18n.t('player.status.paused');
    case 'ended':
      return i18n.t('player.status.ended');
    case 'recovering':
      return i18n.t('player.status.recovering', { rung: status.rung });
    case 'limited':
      return i18n.t('player.status.limited');
    case 'failed':
      return i18n.t(describePlaybackFailure(status.error).messageId);
  }
}

function formatChannelLayout(channels: number | undefined): string | undefined {
  if (channels === undefined || !Number.isFinite(channels) || channels <= 0) return undefined;
  if (channels === 1) return '1.0';
  if (channels === 2) return '2.0';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

function formatActiveAudio(track: TrackInfo | undefined, i18n: Pick<AppI18n, 't'>): string {
  if (track === undefined) return i18n.t('player.stats.audioNone');
  const codec = track.codec?.trim();
  const codecPart = codec !== undefined && codec.length > 0 ? codec.toUpperCase() : undefined;
  const channelPart = formatChannelLayout(track.channels);
  const langPart =
    resolveLanguageLabel(track.language, i18n) ??
    (track.label?.trim() || undefined) ??
    (track.language?.trim() || undefined);
  const parts = [codecPart, channelPart, langPart].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(' ') : track.id;
}

function formatActiveSubtitle(track: TrackInfo | undefined, i18n: Pick<AppI18n, 't'>): string {
  if (track === undefined) return i18n.t('player.subtitlesOff');
  return (
    resolveLanguageLabel(track.language, i18n) ??
    (track.label?.trim() || undefined) ??
    (track.language?.trim() || undefined) ??
    track.id
  );
}

/** Optional extended diagnostic counters surfaced in {@link formatStatsHudLines} (`#160`). */
export interface StatsHudExtras {
  readonly cacheHitRatePct?: number | null | undefined;
  readonly uiStalls?: number | undefined;
}

function formatBufferHealthLine(
  health: BufferHealth | undefined,
  i18n: Pick<AppI18n, 't'>,
): string | undefined {
  if (health === undefined) return undefined;
  const { bufferedAheadMs, bufferedBehindMs, diskCacheBytes, throttled } = health;
  if (
    !Number.isFinite(bufferedAheadMs) ||
    bufferedAheadMs < 0 ||
    !Number.isFinite(bufferedBehindMs) ||
    bufferedBehindMs < 0
  ) {
    return undefined;
  }
  const aheadSec = Math.round(bufferedAheadMs / 1000);
  const behindSec = Math.round(bufferedBehindMs / 1000);
  let line = `${i18n.t('player.stats.buffer')}: +${aheadSec}s / -${behindSec}s`;
  if (diskCacheBytes !== undefined && Number.isFinite(diskCacheBytes) && diskCacheBytes > 0) {
    const rawMb = diskCacheBytes / (1024 * 1024);
    const diskMb = rawMb < 10 ? Math.round(rawMb * 10) / 10 : Math.round(rawMb);
    line += ` (${diskMb} MB)`;
  }
  if (throttled === true) {
    line += ` [${i18n.t('player.stats.throttled')}]`;
  }
  return line;
}

/**
 * Formats concise monospace Stats HUD lines directly from live {@link PlaybackState} telemetry
 * (status & clock, active audio/subtitle tracks, first-frame latency, attempt, stale events,
 * dropped frames, UI cache hit rate, UI stalls, and VOD buffer health `#160`, `#350`).
 */
export function formatStatsHudLines(
  state: PlaybackState,
  nowMs: number,
  i18n: Pick<AppI18n, 't'>,
  extras?: StatsHudExtras,
): readonly string[] {
  const statusText = formatStatusText(state.status, i18n);
  let clockPart = '--:--';
  if (state.anchor !== undefined) {
    const pos = Math.max(0, positionAt(state.anchor, nowMs));
    const dur = state.anchor.durationMs;
    if (dur !== undefined && Number.isFinite(dur) && dur > 0) {
      clockPart = `${formatClockPosition(Math.min(pos, dur))} / ${formatClockPosition(dur)}`;
    } else {
      clockPart = formatClockPosition(pos);
    }
  }
  const line1 = `${statusText} · ${clockPart}`;

  const activeAudio = state.tracks.audio.find((t) => t.id === state.tracks.selectedAudioId);
  const activeSubtitle = state.tracks.subtitles.find(
    (t) => t.id === state.tracks.selectedSubtitleId,
  );
  const line2 = `${i18n.t('player.audioTracks')}: ${formatActiveAudio(activeAudio, i18n)} · ${i18n.t('player.subtitleTracks')}: ${formatActiveSubtitle(activeSubtitle, i18n)}`;

  const line3Parts: string[] = [];
  if (state.firstFrameAt !== undefined && state.tuneAt !== undefined) {
    const delta = state.firstFrameAt - state.tuneAt;
    if (Number.isFinite(delta)) {
      line3Parts.push(i18n.t('player.stats.latencyMs', { ms: Math.max(0, Math.round(delta)) }));
    }
  }
  line3Parts.push(`#${state.attempt}`);
  line3Parts.push(`stale ${state.staleEventsDropped}`);

  const line4Parts: string[] = [];
  const dropped = state.droppedFrames ?? state.videoInfo?.droppedFrames;
  if (dropped !== undefined && Number.isFinite(dropped) && dropped >= 0) {
    line4Parts.push(`${i18n.t('player.stats.droppedFrames')}: ${Math.round(dropped)}`);
  }
  if (
    extras?.cacheHitRatePct !== undefined &&
    extras.cacheHitRatePct !== null &&
    Number.isFinite(extras.cacheHitRatePct)
  ) {
    line4Parts.push(
      `${i18n.t('player.stats.cacheHitRate')}: ${Math.round(extras.cacheHitRatePct)}%`,
    );
  }
  if (extras?.uiStalls !== undefined && Number.isFinite(extras.uiStalls) && extras.uiStalls >= 0) {
    line4Parts.push(`${i18n.t('player.stats.longTasks')}: ${Math.round(extras.uiStalls)}`);
  }

  const lines: string[] = [line1, line2, line3Parts.join(' · ')];
  if (line4Parts.length > 0) lines.push(line4Parts.join(' · '));
  const bufferLine = formatBufferHealthLine(state.anchor?.bufferHealth, i18n);
  if (bufferLine !== undefined) lines.push(bufferLine);
  return lines;
}
