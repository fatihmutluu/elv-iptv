import {
  type AccessibilityFontFamily,
  type BufferPreset,
  type DeinterlaceMode,
  type DnsFamilyPreference,
  MAX_HOST_OVERRIDE_CHARS,
  normalizeDnsFamily,
  type SubtitleStyleConfig,
  validateHostOverride,
} from '@elv/domain';
import type {
  AttemptToken,
  DesktopAudioOutputConfig,
  DisplaySyncPolicy,
  EngineCapabilities,
  EngineEvent,
  ExternalSubtitleTrack,
  LoadCommand,
  StreamRequest,
} from '@elv/playback';
import { isManagedDownloadFileUrlShape } from './downloads-ipc.ts';
import {
  ADD_EXTERNAL_SUBTITLE_CMD_KEYS,
  hasOnlyKeys,
  isExternalSubtitleTrack,
  isSubtitleStyleConfig,
  MAX_EXTERNAL_SUBTITLES_PER_LOAD,
  SET_SUBTITLE_STYLE_CMD_KEYS,
} from './player-ipc-subtitles.ts';
import {
  hasValidWaveF7aLoadOptions,
  isDesktopAudioOutputConfig,
  isDisplaySyncPolicy,
  SET_DESKTOP_AUDIO_OUTPUT_CMD_KEYS,
  SET_DISPLAY_SYNC_CMD_KEYS,
} from './player-ipc-wave-f7a.ts';
import {
  hasValidWaveF7bLoadOptions,
  isProgramId,
  SELECT_PROGRAM_CMD_KEYS,
} from './player-ipc-wave-f7b.ts';

export type {
  AccessibilityFontFamily,
  DeinterlaceMode,
  ExternalSubtitleTrack,
  SubtitleStyleConfig,
};

/** Request payload for queueing the next VOD episode via mpv `append-play` (`#205`). */
export interface QueueNextRequest {
  readonly itemKey: string;
  readonly stream: StreamRequest;
  readonly preferHevcOverDolbyVision?: boolean;
  readonly filterSdhSubtitles?: boolean;
}

/** The player area in CSS pixels of the app window's content, and whether video should show there. */
export interface PlayerArea {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** How mpv's picture reaches the screen: in-canvas shared texture, a child window, or mpv's own window. */
export type PresenterKind = 'canvas' | 'child-window' | 'own-window';

/** Minimal WebCodecs `VideoFrame` subset exposed to the renderer for in-canvas presentation (`#95`). */
export interface VideoFrameLike {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  close(): void;
}

/**
 * What the desktop mpv engine supports: HTTP MPEG-TS and HLS playback, bounded live time-shift seek (`#28`),
 * full audio/subtitle track selection, A/V delay controls, and adaptive video rendition selection over JSON IPC.
 */
export const DESKTOP_CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: true,
  softwareAudioFallback: false,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
  audioDelay: true,
  subtitleDelay: true,
  videoQualitySelection: true,
  externalSubtitles: true,
  subtitleStyling: true,
  dualSubtitles: true,
  programSelection: true,
});

/** One desktop `libmpv` audio output device reported via `audio-device-list` (`#408`). */
export interface AudioDeviceInfo {
  readonly name: string;
  readonly description: string;
}

/** Key forwarded from mpv's native input handler to the renderer (`player:ui`). */
export type PlayerUiKey =
  | 'channel-up'
  | 'channel-down'
  | 'back'
  | 'fullscreen'
  | 'close'
  | 'play-pause'
  | 'seek-back'
  | 'seek-forward'
  | 'seek-coarse-back'
  | 'seek-coarse-forward'
  | 'mute'
  | 'tracks'
  | 'prev-channel'
  | 'info'
  | 'channel-list'
  | 'always-on-top';

/** Presentation events outside the port, main to renderer (`player:ui`). */
export type PlayerUiEvent =
  | { type: 'presenter'; kind: PresenterKind; coversArea: boolean }
  | { type: 'fullscreen-changed'; fullscreen: boolean }
  | { type: 'audio-devices'; devices: readonly AudioDeviceInfo[]; active: string }
  | { type: 'queueAdvanced'; itemKey: string; attempt?: AttemptToken }
  | { type: 'passthroughFallback' }
  | { type: 'key'; key: PlayerUiKey }
  | { type: 'closed' };

/** The IPC channel names between the renderer, the preload bridge and the main process. */
export const PLAYER_CHANNELS = Object.freeze({
  open: 'player:open',
  close: 'player:close',
  park: 'player:park',
  adopt: 'player:adopt',
  setPrimary: 'player:set-primary',
  command: 'player:command',
  event: 'player:event',
  area: 'player:area',
  ui: 'player:ui',
  remoteMediaAction: 'player:remote-media-action',
  pickSubtitleFile: 'player:pick-subtitle-file',
  gateReport: 'gate:report',
} as const);

/** Maximum concurrent mpv engines permitted per `BrowserWindow` / `WebContents` (`#34`). */
export const MAX_ENGINES_PER_WINDOW = 4;

/** Optional open behavior for `player:open` supporting concurrent Canvas Multi-View tiles (`#34`). */
export interface PlayerOpenOptions {
  readonly replaceExisting?: boolean;
  readonly primary?: boolean;
}

/** Sanitized playback metadata mirrored from renderer to OS media bridges (`#238`, `#301`). */
export interface DesktopMediaMetadata {
  readonly title: string;
  readonly subtitle?: string;
  readonly artworkUrl?: string;
  readonly kind: 'live' | 'vod';
  readonly canStepTrack: boolean;
}

/** Track-step remote media action initiated by MPRIS2 or macOS `MPRemoteCommandCenter` (`#238`, `#301`). */
export type RemoteMediaAction = 'next' | 'previous';

/** Main to renderer (`player:remote-media-action`). */
export interface PlayerRemoteMediaActionMessage {
  readonly engineId: string;
  readonly action: RemoteMediaAction;
}

/** Hardware video decoding profile for desktop `libmpv` (`#435`, `#210`). */
export type HwdecProfile = 'auto-safe' | 'auto-copy' | 'no' | 'darwin-compat';

/** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover, `stretch` fills bounds ignoring aspect, `#124`). */
export type ResizeMode = 'fit' | 'fill' | 'stretch';

/** A port command or a presenter command as it crosses the bridge (`fullscreen` is the presenter's, not the port's). */
export type BridgeCommand =
  | { name: 'load'; cmd: LoadCommand }
  | {
      name: 'retry' | 'play' | 'pause' | 'stop' | 'recreate' | 'jumpToLiveEdge';
      attempt: AttemptToken;
    }
  | { name: 'seek'; attempt: AttemptToken; positionMs: number }
  | { name: 'setSpeed'; attempt: AttemptToken; rate: number }
  | { name: 'selectAudioTrack'; attempt: AttemptToken; id: string }
  | { name: 'selectSubtitleTrack'; attempt: AttemptToken; id: string | null }
  | { name: 'selectSecondarySubtitleTrack'; attempt: AttemptToken; id: string | null }
  | { name: 'addExternalSubtitle'; attempt: AttemptToken; track: ExternalSubtitleTrack }
  | { name: 'setSubtitleStyle'; style: SubtitleStyleConfig }
  | { name: 'selectVideoQuality'; attempt: AttemptToken; id: string | null }
  | { name: 'selectProgram'; attempt: AttemptToken; id: string }
  | { name: 'setVolume'; volume: number }
  | { name: 'setAudioDelay'; attempt?: AttemptToken; delaySec: number }
  | { name: 'setSubtitleDelay'; attempt?: AttemptToken; delaySec: number }
  | { name: 'setAudioDevice'; device: string }
  | { name: 'setDeinterlace'; enabled: boolean }
  | { name: 'setDeinterlaceMode'; mode: DeinterlaceMode }
  | { name: 'setPitchLock'; locked: boolean }
  | { name: 'setAudioNormalization'; enabled: boolean }
  | { name: 'setDisplaySync'; policy: DisplaySyncPolicy }
  | { name: 'setDesktopAudioOutput'; config: DesktopAudioOutputConfig }
  | { name: 'queueNext'; request: QueueNextRequest }
  | { name: 'clearQueue' }
  | { name: 'setHwdec'; profile: HwdecProfile }
  | { name: 'setResizeMode'; mode: ResizeMode }
  | { name: 'setFilterSdh'; enabled: boolean }
  | { name: 'setSubtitleFontFamily'; family: AccessibilityFontFamily }
  | { name: 'setMediaMetadata'; metadata: DesktopMediaMetadata | null }
  | { name: 'release' }
  | { name: 'fullscreen' }
  | { name: 'mute' }
  | { name: 'setMuted'; muted: boolean };

/** Renderer to main (`player:command`). */
export interface PlayerCommandMessage {
  engineId: string;
  command: BridgeCommand;
}

/** Main to renderer (`player:event`); `atMs` fields are on the main clock and the proxy maps them. */
export interface PlayerEventMessage {
  engineId: string;
  event: EngineEvent;
}

/** Renderer to main (`player:area`). */
export interface PlayerAreaMessage {
  engineId: string;
  area: PlayerArea;
}

/** Main to renderer (`player:ui`). */
export interface PlayerUiMessage {
  engineId: string;
  ui: PlayerUiEvent;
}

/** The reply to `player:open`: the new engine and the main clock at the time of the reply. */
export interface PlayerOpenReply {
  engineId: string;
  mainNowMs: number;
}

/** What the preload exposes as `window.elv.player`; nothing else of Electron reaches the renderer. */
export interface PlayerBridge {
  open(options?: PlayerOpenOptions): Promise<PlayerOpenReply>;
  close(engineId: string): Promise<void>;
  /** Parks a live retargetable engine for zero-reload cross-window handoff without stopping mpv. */
  park?(engineId: string): Promise<boolean>;
  /** Adopts a parked live engine into the calling window without reloading. */
  adopt?(engineId: string): Promise<PlayerOpenReply | null>;
  /** Promotes an existing Multi-View engine to primary (OS media, taskbar, aspect lock, `#34`). */
  setPrimary?(engineId: string): Promise<void>;
  send(message: PlayerCommandMessage): void;
  setArea(message: PlayerAreaMessage): void;
  /** Returns the unsubscribe function. */
  onEvent(listener: (message: PlayerEventMessage) => void): () => void;
  /** Returns the unsubscribe function. */
  onUi(listener: (message: PlayerUiMessage) => void): () => void;
  /** Subscribes to OS remote track-step actions (`next` / `previous`) from MPRIS2 or macOS MediaPlayer; returns unsubscribe. */
  onRemoteMediaAction?(listener: (message: PlayerRemoteMediaActionMessage) => void): () => void;
  /** Subscribes to decoded GPU `VideoFrame` deliveries for `engineId` in `'canvas'` mode (`#95`); returns unsubscribe. */
  onFrame?(engineId: string, listener: (frame: VideoFrameLike) => void): () => void;
  /** Opens a sandboxed OS subtitle file picker and returns a validated track, or `null` when canceled (`#32`). */
  pickSubtitleFile?(): Promise<ExternalSubtitleTrack | null>;
  /** Dev gate only: one `ELV_GATE_PLAYER {...}` line for main to print. */
  reportGate(line: string): void;
}

const MAX_AREA_VALUE = 1_000_000;
const MAX_DURATION_MS = 86_400_000_000;
const MAX_STREAM_URL_CHARS = 8 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_CHARS = 256;
const MAX_HEADER_VALUE_CHARS = 8 * 1024;
const MAX_HEADERS_TOTAL_CHARS = 32 * 1024;
const MAX_MPV_TRACK_ID = 0x7fffffff;

const AUDIO_TRACK_ID = /^a:([1-9]\d{0,5})$/;
const SUBTITLE_TRACK_ID = /^s:([1-9]\d{0,5})$/;
const VIDEO_QUALITY_ID = /^([1-9]\d{0,5})$/;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');
const isAttempt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isCoordinate = (x: unknown): x is number => isNumber(x) && Math.abs(x) <= MAX_AREA_VALUE;
const isExtent = (x: unknown): x is number => isCoordinate(x) && x >= 0;
const isMs = (x: unknown): x is number => isNumber(x) && x >= 0 && x <= MAX_DURATION_MS;
const PLAYER_OPEN_OPTIONS_KEYS: ReadonlySet<string> = new Set(['replaceExisting', 'primary']);
const SET_MUTED_CMD_KEYS: ReadonlySet<string> = new Set(['name', 'muted']);

/** Main-side check of a player engine identifier string. */
export const isEngineId = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= 64;

/** Main-side check of optional `player:open` options (`#34`). */
export function isPlayerOpenOptions(x: unknown): x is PlayerOpenOptions {
  if (!isRecord(x) || !hasOnlyKeys(x, PLAYER_OPEN_OPTIONS_KEYS)) return false;
  return (
    (x['replaceExisting'] === undefined || typeof x['replaceExisting'] === 'boolean') &&
    (x['primary'] === undefined || typeof x['primary'] === 'boolean')
  );
}

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const isStreamUrl = (x: unknown): boolean => {
  if (typeof x !== 'string' || x.length > MAX_STREAM_URL_CHARS || hasControlChar(x)) {
    return false;
  }
  if (/^file:[/][/]/i.test(x)) {
    return isManagedDownloadFileUrlShape(x);
  }
  if (!/^https?:[/][/]/i.test(x)) {
    return false;
  }
  try {
    const { protocol } = new URL(x);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const isHeaders = (x: unknown): boolean => {
  if (!isRecord(x)) return false;
  const entries = Object.entries(x);
  if (entries.length > MAX_HEADER_COUNT) return false;
  let totalChars = 0;
  for (const [name, value] of entries) {
    if (
      name.length === 0 ||
      name.length > MAX_HEADER_NAME_CHARS ||
      !HEADER_TOKEN.test(name) ||
      typeof value !== 'string' ||
      value.length > MAX_HEADER_VALUE_CHARS ||
      hasControlChar(value)
    ) {
      return false;
    }
    totalChars += name.length + value.length;
    if (totalChars > MAX_HEADERS_TOTAL_CHARS) return false;
  }
  return true;
};

const isAudioTrackId = (x: unknown): x is string => {
  if (typeof x !== 'string') return false;
  const match = AUDIO_TRACK_ID.exec(x);
  return match !== null && Number(match[1]) <= MAX_MPV_TRACK_ID;
};

const isSubtitleTrackId = (x: unknown): x is string => {
  if (typeof x !== 'string') return false;
  const match = SUBTITLE_TRACK_ID.exec(x);
  return match !== null && Number(match[1]) <= MAX_MPV_TRACK_ID;
};

const isVideoQualityId = (x: unknown): x is string => {
  if (typeof x !== 'string') return false;
  const match = VIDEO_QUALITY_ID.exec(x);
  return match !== null && Number(match[1]) <= MAX_MPV_TRACK_ID;
};

const MIN_SPEED_RATE = 0.25;
const MAX_SPEED_RATE = 4;
const MAX_VOLUME = 100;
const MAX_DELAY_SEC = 30;
const MAX_AUDIO_DEVICE_CHARS = 160;
const MAX_ITEM_KEY_CHARS = 512;
const MAX_MEDIA_TEXT_CHARS = 512;

const ARTWORK_CREDENTIAL_QUERY_KEYS = new Set(
  'username password user pass token access_token api_key apikey auth key secret sig signature'.split(
    ' ',
  ),
);

/**
 * Validates and sanitizes an artwork URL before handing it to OS media overlays (MPRIS2 / macOS
 * Now Playing): accepts only `http:` / `https:` URLs without control chars and strips embedded
 * userinfo and credential query parameters.
 */
export function sanitizeDesktopArtworkUrl(rawUrl?: string): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed || trimmed.length > MAX_STREAM_URL_CHARS || hasControlChar(trimmed)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (ARTWORK_CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

/** Returns a credential-safe copy of `metadata` suitable for OS media integrations. */
export function sanitizeDesktopMediaMetadata(
  metadata: DesktopMediaMetadata | null,
): DesktopMediaMetadata | null {
  if (metadata === null) return null;
  const safeArtwork = sanitizeDesktopArtworkUrl(metadata.artworkUrl);
  return {
    title: metadata.title.trim(),
    ...(metadata.subtitle !== undefined && metadata.subtitle.trim().length > 0
      ? { subtitle: metadata.subtitle.trim() }
      : {}),
    ...(safeArtwork !== undefined ? { artworkUrl: safeArtwork } : {}),
    kind: metadata.kind,
    canStepTrack: metadata.canStepTrack,
  };
}

function isDesktopMediaMetadata(x: unknown): x is DesktopMediaMetadata {
  if (!isRecord(x)) return false;
  if (
    typeof x['title'] !== 'string' ||
    x['title'].length > MAX_MEDIA_TEXT_CHARS ||
    hasControlChar(x['title'])
  ) {
    return false;
  }
  if (
    x['subtitle'] !== undefined &&
    (typeof x['subtitle'] !== 'string' ||
      x['subtitle'].length > MAX_MEDIA_TEXT_CHARS ||
      hasControlChar(x['subtitle']))
  ) {
    return false;
  }
  if (
    x['artworkUrl'] !== undefined &&
    (typeof x['artworkUrl'] !== 'string' ||
      x['artworkUrl'].length > MAX_STREAM_URL_CHARS ||
      hasControlChar(x['artworkUrl']))
  ) {
    return false;
  }
  if (x['kind'] !== 'live' && x['kind'] !== 'vod') return false;
  return typeof x['canStepTrack'] === 'boolean';
}

const isSpeedRate = (x: unknown): x is number =>
  isNumber(x) && x >= MIN_SPEED_RATE && x <= MAX_SPEED_RATE;
const isVolume = (x: unknown): x is number => isNumber(x) && x >= 0 && x <= MAX_VOLUME;
const isDelaySec = (x: unknown): x is number => isNumber(x) && Math.abs(x) <= MAX_DELAY_SEC;
const isAudioDevice = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= MAX_AUDIO_DEVICE_CHARS && !hasControlChar(x);
const isDeinterlaceMode = (x: unknown): x is DeinterlaceMode =>
  x === 'off' || x === 'auto' || x === 'bwdif';
const isHwdecProfile = (x: unknown): x is HwdecProfile =>
  x === 'auto-safe' || x === 'auto-copy' || x === 'no' || x === 'darwin-compat';
const isResizeMode = (x: unknown): x is ResizeMode =>
  x === 'fit' || x === 'fill' || x === 'stretch';
const isBufferPreset = (x: unknown): x is BufferPreset =>
  x === 'auto' || x === 'balanced' || x === 'large';
const isSubtitleFontFamily = (x: unknown): x is AccessibilityFontFamily =>
  x === 'system' || x === 'atkinson' || x === 'opendyslexic';
const isDnsFamilyPreference = (x: unknown): x is DnsFamilyPreference =>
  typeof x === 'string' && normalizeDnsFamily(x) === x;
const isHostOverrideLiteral = (x: unknown): x is string => {
  if (typeof x !== 'string' || x.length > MAX_HOST_OVERRIDE_CHARS) return false;
  const validated = validateHostOverride(x);
  return validated.ok && validated.value !== undefined;
};

function isQueueNextRequest(x: unknown): x is QueueNextRequest {
  if (!isRecord(x)) return false;
  const itemKey = x['itemKey'];
  if (
    typeof itemKey !== 'string' ||
    itemKey.trim().length === 0 ||
    itemKey.length > MAX_ITEM_KEY_CHARS ||
    hasControlChar(itemKey)
  ) {
    return false;
  }
  if (x['kind'] !== undefined && x['kind'] !== 'vod') return false;
  const stream = x['stream'];
  if (!isRecord(stream) || !isStreamUrl(stream['url']) || !isHeaders(stream['headers'])) {
    return false;
  }
  if (stream['kind'] !== undefined && stream['kind'] !== 'vod') return false;
  if (stream['dnsFamily'] !== undefined && !isDnsFamilyPreference(stream['dnsFamily'])) {
    return false;
  }
  if (stream['hostOverride'] !== undefined && !isHostOverrideLiteral(stream['hostOverride'])) {
    return false;
  }
  return (
    (x['preferHevcOverDolbyVision'] === undefined ||
      typeof x['preferHevcOverDolbyVision'] === 'boolean') &&
    (x['filterSdhSubtitles'] === undefined || typeof x['filterSdhSubtitles'] === 'boolean')
  );
}

function isLoadCommand(x: unknown): x is LoadCommand {
  if (!isRecord(x)) return false;
  if (!isAttempt(x['attempt']) || !isStreamUrl(x['url']) || !isHeaders(x['headers'])) return false;
  if (x['kind'] !== 'live' && x['kind'] !== 'vod') return false;
  if (typeof x['url'] === 'string' && /^file:/i.test(x['url']) && x['kind'] !== 'vod') {
    return false;
  }
  if (x['drm'] !== undefined) return false;
  if (x['startMs'] !== undefined && !isMs(x['startMs'])) return false;
  const options = x['options'];
  if (options === undefined) return true;
  return (
    isRecord(options) &&
    (options['softwareAudio'] === undefined || typeof options['softwareAudio'] === 'boolean') &&
    (options['preferHevcOverDolbyVision'] === undefined ||
      typeof options['preferHevcOverDolbyVision'] === 'boolean') &&
    (options['filterSdhSubtitles'] === undefined ||
      typeof options['filterSdhSubtitles'] === 'boolean') &&
    (options['allowLegacyTls'] === undefined || typeof options['allowLegacyTls'] === 'boolean') &&
    (options['bufferPreset'] === undefined || isBufferPreset(options['bufferPreset'])) &&
    (options['dnsFamily'] === undefined || isDnsFamilyPreference(options['dnsFamily'])) &&
    (options['hostOverride'] === undefined || isHostOverrideLiteral(options['hostOverride'])) &&
    (options['audioTrackId'] === undefined || isAudioTrackId(options['audioTrackId'])) &&
    (options['subtitleTrackId'] === undefined ||
      options['subtitleTrackId'] === null ||
      isSubtitleTrackId(options['subtitleTrackId'])) &&
    (options['secondarySubtitleTrackId'] === undefined ||
      options['secondarySubtitleTrackId'] === null ||
      isSubtitleTrackId(options['secondarySubtitleTrackId'])) &&
    (options['externalSubtitles'] === undefined ||
      (Array.isArray(options['externalSubtitles']) &&
        options['externalSubtitles'].length <= MAX_EXTERNAL_SUBTITLES_PER_LOAD &&
        options['externalSubtitles'].every((t) => isExternalSubtitleTrack(t, isHeaders)))) &&
    (options['subtitleStyle'] === undefined || isSubtitleStyleConfig(options['subtitleStyle'])) &&
    hasValidWaveF7aLoadOptions(options) &&
    hasValidWaveF7bLoadOptions(options)
  );
}

function isBridgeCommand(x: unknown): x is BridgeCommand {
  if (!isRecord(x)) return false;
  switch (x['name']) {
    case 'load':
      return isLoadCommand(x['cmd']);
    case 'retry':
    case 'play':
    case 'pause':
    case 'stop':
    case 'recreate':
    case 'jumpToLiveEdge':
      return isAttempt(x['attempt']);
    case 'seek':
      return isAttempt(x['attempt']) && isMs(x['positionMs']);
    case 'setSpeed':
      return isAttempt(x['attempt']) && isSpeedRate(x['rate']);
    case 'selectAudioTrack':
      return isAttempt(x['attempt']) && isAudioTrackId(x['id']);
    case 'selectSubtitleTrack':
    case 'selectSecondarySubtitleTrack':
      return isAttempt(x['attempt']) && (x['id'] === null || isSubtitleTrackId(x['id']));
    case 'addExternalSubtitle':
      return (
        hasOnlyKeys(x, ADD_EXTERNAL_SUBTITLE_CMD_KEYS) &&
        isAttempt(x['attempt']) &&
        isExternalSubtitleTrack(x['track'], isHeaders)
      );
    case 'setSubtitleStyle':
      return hasOnlyKeys(x, SET_SUBTITLE_STYLE_CMD_KEYS) && isSubtitleStyleConfig(x['style']);
    case 'selectVideoQuality':
      return isAttempt(x['attempt']) && (x['id'] === null || isVideoQualityId(x['id']));
    case 'selectProgram':
      return (
        hasOnlyKeys(x, SELECT_PROGRAM_CMD_KEYS) && isAttempt(x['attempt']) && isProgramId(x['id'])
      );
    case 'setVolume':
      return isVolume(x['volume']);
    case 'setAudioDelay':
    case 'setSubtitleDelay':
      return (x['attempt'] === undefined || isAttempt(x['attempt'])) && isDelaySec(x['delaySec']);
    case 'setAudioDevice':
      return isAudioDevice(x['device']);
    case 'setDeinterlace':
    case 'setFilterSdh':
    case 'setAudioNormalization':
      return typeof x['enabled'] === 'boolean';
    case 'setDeinterlaceMode':
      return isDeinterlaceMode(x['mode']);
    case 'setPitchLock':
      return typeof x['locked'] === 'boolean';
    case 'setDisplaySync':
      return hasOnlyKeys(x, SET_DISPLAY_SYNC_CMD_KEYS) && isDisplaySyncPolicy(x['policy']);
    case 'setDesktopAudioOutput':
      return (
        hasOnlyKeys(x, SET_DESKTOP_AUDIO_OUTPUT_CMD_KEYS) && isDesktopAudioOutputConfig(x['config'])
      );
    case 'queueNext':
      return isQueueNextRequest(x['request']);
    case 'clearQueue':
      return true;
    case 'setHwdec':
      return isHwdecProfile(x['profile']);
    case 'setResizeMode':
      return isResizeMode(x['mode']);
    case 'setSubtitleFontFamily':
      return isSubtitleFontFamily(x['family']);
    case 'setMediaMetadata':
      return x['metadata'] === null || isDesktopMediaMetadata(x['metadata']);
    case 'release':
    case 'fullscreen':
    case 'mute':
      return true;
    case 'setMuted':
      return hasOnlyKeys(x, SET_MUTED_CMD_KEYS) && typeof x['muted'] === 'boolean';
    default:
      return false;
  }
}

/** Preload/main validation for a picked external subtitle track payload (`#32`). */
export function isPickedSubtitleTrack(x: unknown): x is ExternalSubtitleTrack {
  return isExternalSubtitleTrack(x, isHeaders);
}

/** Main-side check of a `player:command` payload: shape, `http(s)` URL, header names and values without control characters. */
export function isPlayerCommandMessage(x: unknown): x is PlayerCommandMessage {
  return isRecord(x) && isEngineId(x['engineId']) && isBridgeCommand(x['command']);
}

/** Main-side check of a `player:area` payload. */
export function isPlayerAreaMessage(x: unknown): x is PlayerAreaMessage {
  if (!isRecord(x) || !isEngineId(x['engineId'])) return false;
  const area = x['area'];
  return (
    isRecord(area) &&
    isCoordinate(area['x']) &&
    isCoordinate(area['y']) &&
    isExtent(area['width']) &&
    isExtent(area['height']) &&
    typeof area['visible'] === 'boolean'
  );
}

const GATE_PREFIX = 'ELV_GATE_PLAYER {';
const CORPUS_GATE_PREFIX = 'ELV_GATE_CORPUS {';
const GATE_MAX_CHARS = 64 * 1024;

/** Main-side check of a `gate:report` line: the gate prefix, at most 64 KiB, one line without control characters. */
export function isGateReport(x: unknown): x is string {
  return (
    typeof x === 'string' &&
    (x.startsWith(GATE_PREFIX) || x.startsWith(CORPUS_GATE_PREFIX)) &&
    x.length <= GATE_MAX_CHARS &&
    !hasControlChar(x)
  );
}
