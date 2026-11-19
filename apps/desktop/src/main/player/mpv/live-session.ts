import type { AttemptToken, EngineEvent, MediaKind } from '@elv/playback';
import type { PlayerUiEvent } from '../../../shared/player-ipc.ts';
import type { VideoPresenter } from '../presenter/types.ts';
import { type AudioHotplug, createAudioHotplug } from './audio-hotplug.ts';
import { MpvWedgedError } from './client.ts';
import type { MpvCommand, MpvEvent, MpvReply } from './codec.ts';
import { createDeriver, type Deriver } from './derive.ts';
import { createEntryTable, type EntryTable } from './entries.ts';
import type { OpeningGate } from './opening-gate.ts';
import { headerFields, loadfileCommand } from './options.ts';
import type { MpvProcess } from './process.ts';
import type { TrackTracker } from './tracks.ts';

/** Media request bound to an attempt slot. */
export interface MediaRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  kind: MediaKind;
  startMs?: number;
}

/** Active media attempt and its bound mpv playlist entry id. */
export interface MediaSlot {
  token: AttemptToken;
  request: MediaRequest;
  entryId?: number;
  lastPositionMs?: number;
}

/** Connected mpv process and all per-process state (entry ids restart per process). */
export interface LiveSession {
  readonly proc: MpvProcess;
  readonly entries: EntryTable;
  readonly deriver: Deriver;
  readonly hotplug: AudioHotplug;
  paused: boolean;
  userQuit: boolean;
  hasCustomHeaders: boolean;
  inFlight?: MediaSlot;
  readonly endWaiters: Set<{ id: number; done(ended: boolean): void }>;
}

const OBSERVED = [
  'pause',
  'paused-for-cache',
  'core-idle',
  'seeking',
  'playback-time',
  'time-pos',
  'duration',
  'speed',
  'demuxer-cache-state',
  'video-params',
  'vid',
  'track-list',
  'aid',
  'sid',
  'audio-device-list',
] as const;

const TRACK_PROPS: ReadonlySet<string> = new Set(['track-list', 'aid', 'sid']);
const OBSERVED_NAMES: ReadonlySet<string> = new Set(OBSERVED);
const LOG_LEVEL = 'v';
const KEPT_LEVELS: ReadonlySet<string> = new Set(['fatal', 'error', 'warn', 'info']);
const OPEN_WAIT_MS = 1000;
const START_TIMEOUT_MS = 3000;
const END_TIMEOUT_MS = 3000;
const CLOCK_INTERVAL_MS = 1000;

type UiKey = Extract<PlayerUiEvent, { type: 'key' }>['key'];
const UI_KEYS: ReadonlySet<string> = new Set<UiKey>([
  'channel-up',
  'channel-down',
  'back',
  'close',
]);
const isUiKey = (key: unknown): key is UiKey => typeof key === 'string' && UI_KEYS.has(key);
const keepLog = (level: string, text: string): boolean =>
  KEPT_LEVELS.has(level) || text.startsWith('Mime-type:');

const entryIdOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

const replyEntryId = (reply: MpvReply): number | undefined =>
  typeof reply.data === 'object' && reply.data !== null
    ? entryIdOf((reply.data as Record<string, unknown>)['playlist_entry_id'])
    : undefined;

/** Hooks connecting one `LiveSession` to `createMpvEngine`. */
export interface LiveSessionHooks {
  presenter: VideoPresenter;
  tracks: TrackTracker;
  opening: OpeningGate<MediaSlot>;
  now(): number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  quitGraceMs: number;
  getLive(): LiveSession | undefined;
  setLive(session: LiveSession): void;
  getMedia(): MediaSlot | undefined;
  detach(session: LiveSession): void;
  emit(events: readonly EngineEvent[]): void;
  ui(event: PlayerUiEvent): void;
  reportWedged(detail: string): void;
  enqueueCommand(cmd: MpvCommand, slot?: MediaSlot): void;
}

/** Creates per-process mpv session helpers (`connect`, `send`, `stopCurrent`, `loadSlot`). */
export function createSessionController(hooks: LiveSessionHooks) {
  const { presenter, tracks, opening, timers } = hooks;

  const isActive = (L: LiveSession, entryId: number | undefined): boolean => {
    const media = hooks.getMedia();
    return (
      hooks.getLive() === L &&
      media !== undefined &&
      entryId !== undefined &&
      media.entryId === entryId
    );
  };

  const fromCurrent = (L: LiveSession, events: EngineEvent[]): void => {
    if (isActive(L, L.entries.current()?.entryId)) hooks.emit(events);
  };

  const bind = (L: LiveSession, slot: MediaSlot, entryId: number): void => {
    L.entries.bind(entryId, slot.token, slot.request.kind);
    slot.entryId = entryId;
  };

  const wedged = (L: LiveSession, detail: string): void => {
    if (hooks.getLive() !== L) return;
    hooks.detach(L);
    L.proc.kill();
    hooks.reportWedged(detail);
  };

  const send = async (L: LiveSession, cmd: MpvCommand): Promise<MpvReply | undefined> => {
    if (hooks.getLive() !== L) return undefined;
    try {
      return await L.proc.client.command(cmd);
    } catch (error) {
      if (error instanceof MpvWedgedError) wedged(L, 'mpv did not reply in time');
      return undefined;
    }
  };

  const queueReconcile = (L: LiveSession): void => {
    if (!isActive(L, L.entries.current()?.entryId)) return;
    const media = hooks.getMedia();
    for (const cmd of tracks.reconcileCommands()) hooks.enqueueCommand(cmd, media);
  };

  const onStartFile = (L: LiveSession, entryId: number): void => {
    if (L.entries.tokenOf(entryId) === undefined && L.inFlight) bind(L, L.inFlight, entryId);
    opening.onStarted(entryId, OPEN_WAIT_MS);
    L.entries.started(entryId);
    const current = L.entries.current();
    if (current?.entryId !== entryId) return;
    tracks.beginMedia(current.token);
    const events = L.deriver.begin(current.token, current.kind);
    if (L.paused) events.push(...L.deriver.property('pause', true));
    if (isActive(L, entryId)) hooks.emit(events);
  };

  const onEndFile = (L: LiveSession, e: MpvEvent): void => {
    const entryId = entryIdOf(e['playlist_entry_id']);
    if (e['reason'] === 'quit') L.userQuit = true;
    const active = isActive(L, entryId);
    const isCurrent = entryId !== undefined && L.entries.current()?.entryId === entryId;
    const events = isCurrent ? L.deriver.fileEvent(e) : [];
    if (isCurrent) tracks.onRetryOrRecreate();
    if (entryId !== undefined) {
      L.entries.ended(entryId);
      opening.onEnded(entryId);
    }
    for (const waiter of [...L.endWaiters]) if (waiter.id === entryId) waiter.done(true);
    if (active) hooks.emit(events);
  };

  const onMpvEvent = (L: LiveSession, e: MpvEvent): void => {
    switch (e.event) {
      case 'start-file': {
        const entryId = entryIdOf(e['playlist_entry_id']);
        if (entryId !== undefined) onStartFile(L, entryId);
        return;
      }
      case 'end-file':
        onEndFile(L, e);
        return;
      case 'file-loaded':
        opening.onFileLoaded(L.entries.current()?.entryId);
        fromCurrent(L, L.deriver.fileEvent(e));
        if (isActive(L, L.entries.current()?.entryId)) {
          tracks.onFileLoaded();
          queueReconcile(L);
        }
        return;
      case 'playback-restart':
        fromCurrent(L, L.deriver.fileEvent(e));
        return;
      case 'property-change': {
        const name = String(e['name']);
        if (name === 'pause') L.paused = e['data'] === true;
        if (name === 'audio-device-list') {
          L.hotplug.onDeviceList(e['data']);
          return;
        }
        if (TRACK_PROPS.has(name)) {
          fromCurrent(L, tracks.property(name, e['data']));
          if (!opening.isOpening()) queueReconcile(L);
          return;
        }
        if (OBSERVED_NAMES.has(name)) fromCurrent(L, L.deriver.property(name, e['data']));
        return;
      }
      case 'log-message': {
        const level = String(e['level']);
        const text = String(e['text'] ?? '').trimEnd();
        if (keepLog(level, text)) L.deriver.log({ prefix: String(e['prefix']), level, text });
        return;
      }
      case 'client-message': {
        const args = e['args'];
        if (!Array.isArray(args) || args[0] !== 'elv-key') return;
        if (args[1] === 'fullscreen') presenter.toggleFullscreen();
        else if (isUiKey(args[1])) hooks.ui({ type: 'key', key: args[1] });
      }
    }
  };

  const waitCleanExit = async (proc: MpvProcess): Promise<boolean> => {
    let timer: unknown;
    const clean = await Promise.race([
      proc.exited.then((info) => info.code === 0 && info.signal === null),
      new Promise<false>((resolve) => {
        timer = timers.setTimeout(() => resolve(false), hooks.quitGraceMs);
      }),
    ]);
    timers.clearTimeout(timer);
    return clean;
  };

  const onClosed = (L: LiveSession): void => {
    if (hooks.getLive() !== L) return;
    const noCurrentFile = L.entries.current() === undefined;
    const tokenAtClose = hooks.getMedia()?.token;
    hooks.detach(L);
    if (presenter.kind === 'own-window' && L.userQuit) {
      L.proc.kill();
      hooks.ui({ type: 'closed' });
      return;
    }
    if (presenter.kind === 'own-window' && noCurrentFile) {
      void waitCleanExit(L.proc).then((clean) => {
        L.proc.kill();
        if (clean) hooks.ui({ type: 'closed' });
        else if (tokenAtClose !== undefined && hooks.getMedia()?.token === tokenAtClose) {
          hooks.reportWedged('mpv exited');
        }
      });
      return;
    }
    L.proc.kill();
    hooks.reportWedged('mpv exited');
  };

  const stopCurrent = async (L: LiveSession): Promise<boolean> => {
    const current = L.entries.current();
    if (!current) return true;
    let handle: unknown;
    const ended = new Promise<boolean>((resolve) => {
      const waiter = {
        id: current.entryId,
        done: (ok: boolean) => {
          timers.clearTimeout(handle);
          L.endWaiters.delete(waiter);
          resolve(ok);
        },
      };
      handle = timers.setTimeout(() => waiter.done(false), END_TIMEOUT_MS);
      L.endWaiters.add(waiter);
    });
    await send(L, ['stop']);
    if (await ended) return true;
    wedged(L, 'mpv did not end the media');
    return false;
  };

  return {
    fromCurrent,
    send,
    stopCurrent,
    connect(proc: MpvProcess): LiveSession {
      const L: LiveSession = {
        proc,
        entries: createEntryTable(),
        deriver: createDeriver({ now: hooks.now, clockIntervalMs: CLOCK_INTERVAL_MS }),
        hotplug: createAudioHotplug({
          timers,
          onReinit: () => {
            if (hooks.getLive() === L && isActive(L, L.entries.current()?.entryId)) {
              hooks.enqueueCommand(['ao-reload'], hooks.getMedia());
            }
          },
        }),
        paused: false,
        userQuit: false,
        hasCustomHeaders: false,
        endWaiters: new Set(),
      };
      hooks.setLive(L);
      proc.client.onEvent((e) => {
        if (hooks.getLive() === L) onMpvEvent(L, e);
      });
      proc.client.onClose(() => onClosed(L));
      presenter.attach(proc.client);
      for (const name of OBSERVED) proc.client.observe(name);
      void send(L, ['request_log_messages', LOG_LEVEL]);
      return L;
    },
    async loadSlot(L: LiveSession, slot: MediaSlot, stopFirst: boolean): Promise<void> {
      if (stopFirst && !(await stopCurrent(L))) return;
      if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
      const fields = headerFields(slot.request.headers);
      if (fields.length > 0 || L.hasCustomHeaders) {
        if (fields.length > 0) L.hasCustomHeaders = true;
        const propReply = await send(L, ['set_property', 'http-header-fields', fields]);
        if (!propReply || hooks.getLive() !== L) return;
        if (propReply.error !== 'success') {
          if (slot === hooks.getMedia()) {
            hooks.emit([
              {
                attempt: slot.token,
                type: 'error',
                error: { code: 'unknown', detail: `http-header-fields: ${propReply.error}` },
              },
            ]);
          }
          return;
        }
        if (fields.length === 0) L.hasCustomHeaders = false;
        if (slot !== hooks.getMedia()) return;
      }
      L.inFlight = slot;
      opening.begin(slot);
      const reply = await send(L, loadfileCommand(slot.request));
      if (!reply || hooks.getLive() !== L) return;
      if (reply.error !== 'success') {
        L.inFlight = undefined;
        opening.finish();
        if (slot === hooks.getMedia()) {
          hooks.emit([
            {
              attempt: slot.token,
              type: 'error',
              error: { code: 'unknown', detail: `loadfile: ${reply.error}` },
            },
          ]);
        }
        return;
      }
      const entryId =
        slot.entryId ??
        replyEntryId(reply) ??
        entryIdOf((await send(L, ['get_property', 'playlist/0/id']))?.data);
      L.inFlight = undefined;
      if (hooks.getLive() !== L) return;
      if (entryId !== undefined && slot.entryId === undefined) bind(L, slot, entryId);
      if (opening.needsStartTimeout(slot)) {
        opening.arm(START_TIMEOUT_MS, () => wedged(L, 'mpv did not start the media'));
      }
      if (L.paused && slot === hooks.getMedia()) await send(L, ['set', 'pause', 'no']);
    },
  };
}
