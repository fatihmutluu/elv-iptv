import { type AppI18n, resolveLanguageLabel } from '@elv/i18n';
import {
  type MediaTracks,
  type PlaybackState,
  type PlaybackStatus,
  positionAt,
  type TrackInfo,
} from '@elv/playback';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import { describePlaybackFailure } from './errors';
import type { SettingsMenuState } from './settings-menu-nav';
import type { TrackPickerCursor } from './track-picker-nav';
import type { TvOsdAction } from './tv-osd-nav';

/** Live mutable snapshot shared with synchronous key handlers in `usePlayerControls`. */
export interface PlayerOverlayLive {
  tracksOpen: boolean;
  pickerCursor: TrackPickerCursor;
  settingsOpen: boolean;
  settingsMenu: SettingsMenuState;
  locked: boolean;
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

function toPlayableEntry(target: PlayTarget): PlayableEntry {
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

/**
 * Formats 3 concise monospace Stats HUD lines directly from live {@link PlaybackState} telemetry
 * (status & clock, active audio/subtitle tracks, first-frame latency, attempt, and dropped events).
 */
export function formatStatsHudLines(
  state: PlaybackState,
  nowMs: number,
  i18n: Pick<AppI18n, 't'>,
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

  return [line1, line2, line3Parts.join(' · ')];
}
