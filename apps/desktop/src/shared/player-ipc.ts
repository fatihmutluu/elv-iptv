import type { AccessibilityFontFamily } from '@elv/domain';
import type { AttemptToken, EngineCapabilities, EngineEvent, LoadCommand } from '@elv/playback';

export type { AccessibilityFontFamily };

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
 * What the desktop mpv engine can do in 0.1: no live seek, no software-audio rung (FFmpeg already decodes audio in
 * software), with full audio and embedded subtitle track selection over JSON IPC.
 */
export const DESKTOP_CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: false,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
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
  | { type: 'key'; key: PlayerUiKey }
  | { type: 'closed' };

/** The IPC channel names between the renderer, the preload bridge and the main process. */
export const PLAYER_CHANNELS = Object.freeze({
  open: 'player:open',
  close: 'player:close',
  command: 'player:command',
  event: 'player:event',
  area: 'player:area',
  ui: 'player:ui',
  gateReport: 'gate:report',
} as const);

/** Hardware video decoding profile for desktop `libmpv` (`#435`, `#210`). */
export type HwdecProfile = 'auto-safe' | 'auto-copy' | 'no' | 'darwin-compat';

/** Picture scaling mode (`fit` letterboxed, `fill` cropped to cover, `stretch` fills bounds ignoring aspect, `#124`). */
export type ResizeMode = 'fit' | 'fill' | 'stretch';

/** A port command or a presenter command as it crosses the bridge (`fullscreen` is the presenter's, not the port's). */
export type BridgeCommand =
  | { name: 'load'; cmd: LoadCommand }
  | { name: 'retry' | 'play' | 'pause' | 'stop' | 'recreate'; attempt: AttemptToken }
  | { name: 'seek'; attempt: AttemptToken; positionMs: number }
  | { name: 'setSpeed'; attempt: AttemptToken; rate: number }
  | { name: 'selectAudioTrack'; attempt: AttemptToken; id: string }
  | { name: 'selectSubtitleTrack'; attempt: AttemptToken; id: string | null }
  | { name: 'setVolume'; volume: number }
  | { name: 'setAudioDelay'; delaySec: number }
  | { name: 'setSubtitleDelay'; delaySec: number }
  | { name: 'setAudioDevice'; device: string }
  | { name: 'setDeinterlace'; enabled: boolean }
  | { name: 'setHwdec'; profile: HwdecProfile }
  | { name: 'setResizeMode'; mode: ResizeMode }
  | { name: 'setFilterSdh'; enabled: boolean }
  | { name: 'setSubtitleFontFamily'; family: AccessibilityFontFamily }
  | { name: 'release' }
  | { name: 'fullscreen' }
  | { name: 'mute' };

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
  open(): Promise<PlayerOpenReply>;
  close(engineId: string): Promise<void>;
  send(message: PlayerCommandMessage): void;
  setArea(message: PlayerAreaMessage): void;
  /** Returns the unsubscribe function. */
  onEvent(listener: (message: PlayerEventMessage) => void): () => void;
  /** Returns the unsubscribe function. */
  onUi(listener: (message: PlayerUiMessage) => void): () => void;
  /** Subscribes to decoded GPU `VideoFrame` deliveries for `engineId` in `'canvas'` mode (`#95`); returns unsubscribe. */
  onFrame?(engineId: string, listener: (frame: VideoFrameLike) => void): () => void;
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
const isEngineId = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= 64;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const isStreamUrl = (x: unknown): boolean => {
  if (
    typeof x !== 'string' ||
    x.length > MAX_STREAM_URL_CHARS ||
    !/^https?:[/][/]/i.test(x) ||
    hasControlChar(x)
  ) {
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

const MIN_SPEED_RATE = 0.25;
const MAX_SPEED_RATE = 4;
const MAX_VOLUME = 100;
const MAX_DELAY_SEC = 30;
const MAX_AUDIO_DEVICE_CHARS = 160;

const isSpeedRate = (x: unknown): x is number =>
  isNumber(x) && x >= MIN_SPEED_RATE && x <= MAX_SPEED_RATE;
const isVolume = (x: unknown): x is number => isNumber(x) && x >= 0 && x <= MAX_VOLUME;
const isDelaySec = (x: unknown): x is number => isNumber(x) && Math.abs(x) <= MAX_DELAY_SEC;
const isAudioDevice = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= MAX_AUDIO_DEVICE_CHARS && !hasControlChar(x);
const isHwdecProfile = (x: unknown): x is HwdecProfile =>
  x === 'auto-safe' || x === 'auto-copy' || x === 'no' || x === 'darwin-compat';
const isResizeMode = (x: unknown): x is ResizeMode =>
  x === 'fit' || x === 'fill' || x === 'stretch';
const isSubtitleFontFamily = (x: unknown): x is AccessibilityFontFamily =>
  x === 'system' || x === 'atkinson' || x === 'opendyslexic';

function isLoadCommand(x: unknown): x is LoadCommand {
  if (!isRecord(x)) return false;
  if (!isAttempt(x['attempt']) || !isStreamUrl(x['url']) || !isHeaders(x['headers'])) return false;
  if (x['kind'] !== 'live' && x['kind'] !== 'vod') return false;
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
    (options['audioTrackId'] === undefined || isAudioTrackId(options['audioTrackId'])) &&
    (options['subtitleTrackId'] === undefined ||
      options['subtitleTrackId'] === null ||
      isSubtitleTrackId(options['subtitleTrackId']))
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
      return isAttempt(x['attempt']);
    case 'seek':
      return isAttempt(x['attempt']) && isMs(x['positionMs']);
    case 'setSpeed':
      return isAttempt(x['attempt']) && isSpeedRate(x['rate']);
    case 'selectAudioTrack':
      return isAttempt(x['attempt']) && isAudioTrackId(x['id']);
    case 'selectSubtitleTrack':
      return isAttempt(x['attempt']) && (x['id'] === null || isSubtitleTrackId(x['id']));
    case 'setVolume':
      return isVolume(x['volume']);
    case 'setAudioDelay':
    case 'setSubtitleDelay':
      return isDelaySec(x['delaySec']);
    case 'setAudioDevice':
      return isAudioDevice(x['device']);
    case 'setDeinterlace':
    case 'setFilterSdh':
      return typeof x['enabled'] === 'boolean';
    case 'setHwdec':
      return isHwdecProfile(x['profile']);
    case 'setResizeMode':
      return isResizeMode(x['mode']);
    case 'setSubtitleFontFamily':
      return isSubtitleFontFamily(x['family']);
    case 'release':
    case 'fullscreen':
    case 'mute':
      return true;
    default:
      return false;
  }
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
