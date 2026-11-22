import type { PlayerUiEvent } from '../../../shared/player-ipc.ts';
import type { MpvReply } from './codec.ts';

/** Properties observed on every live mpv session (`#110`, `#254`, `#196`). */
export const OBSERVED_PROPERTIES = [
  'pause',
  'paused-for-cache',
  'core-idle',
  'seeking',
  'playback-time',
  'time-pos',
  'duration',
  'speed',
  'demuxer-cache-state',
  'demuxer-cache-duration',
  'estimated-vf-fps',
  'video-params',
  'vid',
  'track-list',
  'aid',
  'sid',
  'audio-device',
  'audio-device-list',
  'volume',
  'mute',
] as const;

/** Properties routed to `TrackTracker`. */
export const TRACK_PROPERTIES: ReadonlySet<string> = new Set(['track-list', 'aid', 'sid']);

/** Fast membership check for all observed mpv properties. */
export const OBSERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set(OBSERVED_PROPERTIES);

const KEPT_LOG_LEVELS: ReadonlySet<string> = new Set(['fatal', 'error', 'warn', 'info']);

type UiKey = Extract<PlayerUiEvent, { type: 'key' }>['key'];

const UI_KEYS: ReadonlySet<string> = new Set<UiKey>([
  'channel-up',
  'channel-down',
  'back',
  'close',
  'play-pause',
  'seek-back',
  'seek-forward',
  'seek-coarse-back',
  'seek-coarse-forward',
  'mute',
  'tracks',
  'prev-channel',
]);

/** Type guard for `elv-key` client messages forwarded to the renderer. */
export const isUiKey = (key: unknown): key is UiKey => typeof key === 'string' && UI_KEYS.has(key);

/** Keeps error/warning/info logs plus FFmpeg `Mime-type:` probe lines for fault classification. */
export const keepMpvLog = (level: string, text: string): boolean =>
  KEPT_LOG_LEVELS.has(level) || text.startsWith('Mime-type:');

/** Extracts an integer playlist entry id if present. */
export const entryIdOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

/** Extracts `playlist_entry_id` from a `loadfile` reply payload if present. */
export const replyEntryId = (reply: MpvReply): number | undefined =>
  typeof reply.data === 'object' && reply.data !== null
    ? entryIdOf((reply.data as Record<string, unknown>)['playlist_entry_id'])
    : undefined;
