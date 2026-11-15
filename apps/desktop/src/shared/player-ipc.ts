import type { AttemptToken, EngineCapabilities, EngineEvent, LoadCommand } from '@elv/playback';

/** The player area in CSS pixels of the app window's content, and whether video should show there. */
export interface PlayerArea {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** How mpv's picture reaches the screen: a child window kept on the player area, or mpv's own window. */
export type PresenterKind = 'child-window' | 'own-window';

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

/** Presentation events outside the port, main to renderer (`player:ui`). */
export type PlayerUiEvent =
  | { type: 'presenter'; kind: PresenterKind; coversArea: boolean }
  | { type: 'key'; key: 'channel-up' | 'channel-down' | 'back' | 'fullscreen' | 'close' }
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

/** A port command or a presenter command as it crosses the bridge (`fullscreen` is the presenter's, not the port's). */
export type BridgeCommand =
  | { name: 'load'; cmd: LoadCommand }
  | { name: 'retry' | 'play' | 'pause' | 'stop' | 'recreate'; attempt: AttemptToken }
  | { name: 'seek'; attempt: AttemptToken; positionMs: number }
  | { name: 'selectAudioTrack'; attempt: AttemptToken; id: string }
  | { name: 'selectSubtitleTrack'; attempt: AttemptToken; id: string | null }
  | { name: 'release' }
  | { name: 'fullscreen' };

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
  /** Dev gate only: one `ELV_GATE_PLAYER {...}` line for main to print. */
  reportGate(line: string): void;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isAttempt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const MAX_AREA_VALUE = 1_000_000;
const isCoordinate = (x: unknown): x is number => isNumber(x) && Math.abs(x) <= MAX_AREA_VALUE;
const isExtent = (x: unknown): x is number => isCoordinate(x) && x >= 0;
const isMs = (x: unknown): x is number => isNumber(x) && x >= 0;
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
  // `new URL` accepts `http:x/a.ts`, which mpv would open as a path
  if (typeof x !== 'string' || !/^https?:[/][/]/i.test(x) || hasControlChar(x)) return false;
  try {
    const { protocol } = new URL(x);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isHeaders = (x: unknown): boolean =>
  isRecord(x) &&
  Object.entries(x).every(
    ([name, value]) =>
      HEADER_TOKEN.test(name) && typeof value === 'string' && !hasControlChar(value),
  );

const isTrackId = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= 64 && !hasControlChar(x);

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
    (options['audioTrackId'] === undefined || isTrackId(options['audioTrackId'])) &&
    (options['subtitleTrackId'] === undefined ||
      options['subtitleTrackId'] === null ||
      isTrackId(options['subtitleTrackId']))
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
    case 'selectAudioTrack':
      return isAttempt(x['attempt']) && isTrackId(x['id']);
    case 'selectSubtitleTrack':
      return isAttempt(x['attempt']) && (x['id'] === null || isTrackId(x['id']));
    case 'release':
    case 'fullscreen':
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
const GATE_MAX_CHARS = 64 * 1024;

/** Main-side check of a `gate:report` line: the gate prefix, at most 64 KiB, one line without control characters. */
export function isGateReport(x: unknown): x is string {
  return (
    typeof x === 'string' &&
    x.startsWith(GATE_PREFIX) &&
    x.length <= GATE_MAX_CHARS &&
    !hasControlChar(x)
  );
}
