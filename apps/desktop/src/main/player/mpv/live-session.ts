import type { AttemptToken, EngineEvent, MediaKind } from '@elv/playback';
import type { DeinterlaceMode, PlayerUiEvent } from '../../../shared/player-ipc.ts';
import type { VideoPresenter } from '../presenter/types.ts';
import { type AudioDeviceTracker, createAudioDeviceTracker } from './audio-devices.ts';
import { type AudioHotplug, createAudioHotplug } from './audio-hotplug.ts';
import { MpvWedgedError } from './client.ts';
import type { MpvCommand, MpvEvent, MpvReply } from './codec.ts';
import { createDeriver, type Deriver, isLiveMpegTsUrl } from './derive.ts';
import { createEntryTable, type EntryTable } from './entries.ts';
import { createInputRepeatGate, type InputRepeatGate } from './input-repeat-gate.ts';
import type { OpeningGate } from './opening-gate.ts';
import {
  audioNormalizationCommand,
  deinterlaceCommands,
  headerFields,
  loadfileCommand,
  pitchLockCommand,
} from './options.ts';
import type { MpvProcess } from './process.ts';
import {
  createReadaheadController,
  type ReadaheadController,
  type ReadaheadTierStore,
} from './readahead.ts';
import {
  entryIdOf,
  isUiKey,
  keepMpvLog,
  OBSERVED_PROPERTIES,
  OBSERVED_PROPERTY_NAMES,
  replyEntryId,
  TRACK_PROPERTIES,
} from './session-constants.ts';
import type { TrackTracker } from './tracks.ts';

/** Media request bound to an attempt slot. */
export interface MediaRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  kind: MediaKind;
  startMs?: number;
  preferHevcOverDolbyVision?: boolean;
  filterSdhSubtitles?: boolean;
}

/** Active media attempt and its bound mpv playlist entry id. */
export interface MediaSlot {
  token: AttemptToken;
  request: MediaRequest;
  entryId?: number;
  lastPositionMs?: number;
}

/** Queued next VOD episode bound to an mpv `append-play` playlist entry (`#205`). */
export interface QueuedMediaSlot extends MediaSlot {
  readonly itemKey: string;
}

/** Connected mpv process and all per-process state (entry ids restart per process). */
export interface LiveSession {
  readonly proc: MpvProcess;
  readonly entries: EntryTable;
  readonly deriver: Deriver;
  readonly hotplug: AudioHotplug;
  readonly audioDevices: AudioDeviceTracker;
  readonly repeatGate: InputRepeatGate;
  readonly readahead: ReadaheadController;
  paused: boolean;
  userQuit: boolean;
  hasCustomHeaders: boolean;
  hasQueuedPlaylist: boolean;
  queuedEntryId?: number;
  appliedAudioDevice?: string;
  appliedSubtitleFont?: string;
  appliedDeinterlaceMode?: DeinterlaceMode;
  appliedPitchLock?: boolean;
  appliedAudioNormalization?: boolean;
  inFlight?: MediaSlot;
  inFlightQueued?: QueuedMediaSlot;
  readonly endWaiters: Set<{ id: number; done(ended: boolean): void }>;
}

const LOG_LEVEL = 'v';
const OPEN_WAIT_MS = 1000;
const START_TIMEOUT_MS = 3000;
const END_TIMEOUT_MS = 3000;
const CLOCK_INTERVAL_MS = 1000;

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
  getQueued?(): QueuedMediaSlot | undefined;
  setQueued?(slot: QueuedMediaSlot | undefined): void;
  promoteQueued?(slot: QueuedMediaSlot): void;
  detach(session: LiveSession): void;
  emit(events: readonly EngineEvent[]): void;
  ui(event: PlayerUiEvent): void;
  reportWedged(detail: string): void;
  enqueueCommand(cmd: MpvCommand, slot?: MediaSlot): void;
  onAudioProperty?(name: 'volume' | 'mute', value: unknown): void;
  onAudioSpdifProperty?(value: unknown): void;
  getDesiredAudioDevice?(): string | undefined;
  getDesiredSubtitleFont?(): string | undefined;
  getDesiredDeinterlaceMode?(): DeinterlaceMode | undefined;
  getDesiredPitchLock?(): boolean | undefined;
  getDesiredAudioNormalization?(): boolean | undefined;
  isSpdifPassthroughActive?(): boolean;
  readaheadStore?: ReadaheadTierStore;
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
    if (!isActive(L, L.entries.current()?.entryId)) return;
    if (events.some((ev) => ev.type === 'firstFrame')) L.readahead.onFirstFrame();
    hooks.emit(events);
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
    const queued = hooks.getQueued?.();
    const isQueuedAdvance =
      queued !== undefined &&
      (queued.entryId === entryId || (queued.entryId === undefined && L.inFlightQueued === queued));
    if (isQueuedAdvance && queued) {
      const prevMedia = hooks.getMedia();
      if (prevMedia) queued.token = prevMedia.token;
      bind(L, queued, entryId);
      L.hasQueuedPlaylist = false;
      L.queuedEntryId = undefined;
      L.inFlightQueued = undefined;
      hooks.promoteQueued?.(queued);
      opening.onStarted(entryId, OPEN_WAIT_MS);
      L.entries.started(entryId);
      const current = L.entries.current();
      if (current?.entryId !== entryId) return;
      tracks.beginMedia(current.token);
      const events = L.deriver.begin(current.token, current.kind, false);
      if (L.paused) events.push(...L.deriver.property('pause', true));
      L.readahead.beginMedia(queued.request.url);
      if (L.paused) L.readahead.property('pause', true);
      if (hooks.getDesiredDeinterlaceMode?.() === 'auto') {
        hooks.enqueueCommand(['set_property', 'deinterlace', 'auto'], queued);
      }
      hooks.ui({ type: 'queueAdvanced', itemKey: queued.itemKey, attempt: current.token });
      hooks.emit(events);
      return;
    }
    if (L.entries.tokenOf(entryId) === undefined && L.inFlight) bind(L, L.inFlight, entryId);
    opening.onStarted(entryId, OPEN_WAIT_MS);
    L.entries.started(entryId);
    const current = L.entries.current();
    if (current?.entryId !== entryId) return;
    tracks.beginMedia(current.token);
    const activeMedia = hooks.getMedia();
    const slotUrl =
      activeMedia?.entryId === entryId
        ? activeMedia.request.url
        : L.inFlight?.entryId === entryId
          ? L.inFlight.request.url
          : undefined;
    const isLiveTs = current.kind === 'live' && slotUrl !== undefined && isLiveMpegTsUrl(slotUrl);
    const events = L.deriver.begin(current.token, current.kind, isLiveTs);
    if (L.paused) events.push(...L.deriver.property('pause', true));
    if (isActive(L, entryId)) {
      const media = hooks.getMedia();
      if (media) L.readahead.beginMedia(media.request.url);
      if (L.paused) L.readahead.property('pause', true);
      if (hooks.getDesiredDeinterlaceMode?.() === 'auto') {
        hooks.enqueueCommand(['set_property', 'deinterlace', 'auto'], media);
      }
      hooks.emit(events);
    }
  };

  const onEndFile = (L: LiveSession, e: MpvEvent): void => {
    const entryId = entryIdOf(e['playlist_entry_id']);
    if (e['reason'] === 'quit') L.userQuit = true;
    const active = isActive(L, entryId);
    const isCurrent = entryId !== undefined && L.entries.current()?.entryId === entryId;
    const rawEvents = isCurrent ? L.deriver.fileEvent(e) : [];
    const suppressEnded = active && e['reason'] === 'eof' && hooks.getQueued?.() !== undefined;
    const events = suppressEnded
      ? rawEvents.filter((ev) => !(ev.type === 'state' && ev.state === 'ended'))
      : rawEvents;
    if (isCurrent) tracks.onRetryOrRecreate();
    if (entryId !== undefined) {
      L.entries.ended(entryId);
      opening.onEnded(entryId);
    }
    for (const waiter of [...L.endWaiters]) if (waiter.id === entryId) waiter.done(true);
    if (active && events.length > 0) hooks.emit(events);
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
        if (isActive(L, L.entries.current()?.entryId)) L.readahead.onPlaybackRestart();
        fromCurrent(L, L.deriver.fileEvent(e));
        return;
      case 'property-change': {
        const name = String(e['name']);
        if (name === 'pause') L.paused = e['data'] === true;
        if (name === 'volume' || name === 'mute') {
          hooks.onAudioProperty?.(name, e['data']);
          return;
        }
        if (name === 'audio-spdif') {
          hooks.onAudioSpdifProperty?.(e['data']);
          return;
        }
        if (name === 'audio-device') {
          L.hotplug.onActiveDevice(e['data']);
          L.audioDevices.onActiveDevice(e['data']);
          return;
        }
        if (name === 'audio-device-list') {
          L.hotplug.onDeviceList(e['data']);
          L.audioDevices.onDeviceList(e['data']);
          return;
        }
        if (TRACK_PROPERTIES.has(name)) {
          fromCurrent(L, tracks.property(name, e['data']));
          if (name === 'track-list') fromCurrent(L, L.deriver.property(name, e['data']));
          if (!opening.isOpening()) queueReconcile(L);
          return;
        }
        if (OBSERVED_PROPERTY_NAMES.has(name)) {
          fromCurrent(L, L.deriver.property(name, e['data']));
          if (isActive(L, L.entries.current()?.entryId)) L.readahead.property(name, e['data']);
        }
        return;
      }
      case 'log-message': {
        const level = String(e['level']);
        const text = String(e['text'] ?? '').trimEnd();
        if (keepMpvLog(level, text)) L.deriver.log({ prefix: String(e['prefix']), level, text });
        return;
      }
      case 'client-message': {
        const args = e['args'];
        if (!Array.isArray(args) || args[0] !== 'elv-key') return;
        if (args[1] === 'fullscreen') {
          L.repeatGate.allow('fullscreen');
          presenter.toggleFullscreen();
        } else if (isUiKey(args[1]) && L.repeatGate.allow(args[1])) {
          hooks.ui({ type: 'key', key: args[1] });
        }
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
    L.repeatGate.reset();
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
        audioDevices: createAudioDeviceTracker((devices, active) => {
          if (hooks.getLive() === L) hooks.ui({ type: 'audio-devices', devices, active });
        }),
        repeatGate: createInputRepeatGate({ now: hooks.now }),
        readahead: createReadaheadController({
          now: hooks.now,
          ...(hooks.readaheadStore === undefined ? {} : { store: hooks.readaheadStore }),
          onApply: (secs) => {
            if (hooks.getLive() === L) {
              hooks.enqueueCommand(
                ['set_property', 'demuxer-readahead-secs', secs],
                hooks.getMedia(),
              );
            }
          },
        }),
        paused: false,
        userQuit: false,
        hasCustomHeaders: false,
        hasQueuedPlaylist: false,
        endWaiters: new Set(),
      };
      hooks.setLive(L);
      proc.client.onEvent((e) => {
        if (hooks.getLive() === L) onMpvEvent(L, e);
      });
      proc.client.onClose(() => onClosed(L));
      presenter.attach(proc.client);
      for (const name of OBSERVED_PROPERTIES) proc.client.observe(name);
      void send(L, ['request_log_messages', LOG_LEVEL]);
      const desiredAudio = hooks.getDesiredAudioDevice?.();
      if (desiredAudio !== undefined) {
        L.appliedAudioDevice = desiredAudio;
        void send(L, ['set_property', 'audio-device', desiredAudio]);
      }
      const desiredSubFont = hooks.getDesiredSubtitleFont?.();
      if (desiredSubFont !== undefined) {
        L.appliedSubtitleFont = desiredSubFont;
        void send(L, ['set_property', 'sub-font', desiredSubFont]);
      }
      const desiredDeinterlace = hooks.getDesiredDeinterlaceMode?.();
      if (desiredDeinterlace !== undefined) {
        L.appliedDeinterlaceMode = desiredDeinterlace;
        for (const cmd of deinterlaceCommands(desiredDeinterlace)) void send(L, cmd);
      }
      const desiredPitchLock = hooks.getDesiredPitchLock?.();
      if (desiredPitchLock !== undefined) {
        L.appliedPitchLock = desiredPitchLock;
        void send(L, pitchLockCommand(desiredPitchLock));
      }
      const desiredNorm = hooks.getDesiredAudioNormalization?.();
      if (desiredNorm !== undefined) {
        const effectiveNorm = desiredNorm && !hooks.isSpdifPassthroughActive?.();
        L.appliedAudioNormalization = effectiveNorm;
        if (effectiveNorm || !desiredNorm) {
          void send(L, audioNormalizationCommand(effectiveNorm));
        }
      }
      return L;
    },
    async clearQueuedPlaylist(L: LiveSession): Promise<void> {
      if (hooks.getLive() !== L) return;
      if (L.queuedEntryId !== undefined) {
        L.entries.unbind(L.queuedEntryId);
        L.queuedEntryId = undefined;
      }
      L.inFlightQueued = undefined;
      L.hasQueuedPlaylist = false;
      await send(L, ['playlist-clear']);
    },
    async queueSlot(L: LiveSession, ownerSlot: MediaSlot, queued: QueuedMediaSlot): Promise<void> {
      if (
        hooks.getLive() !== L ||
        hooks.getMedia() !== ownerSlot ||
        hooks.getQueued?.() !== queued
      ) {
        return;
      }
      if (L.hasQueuedPlaylist) {
        if (L.queuedEntryId !== undefined) {
          L.entries.unbind(L.queuedEntryId);
          L.queuedEntryId = undefined;
        }
        await send(L, ['playlist-clear']);
        L.hasQueuedPlaylist = false;
        if (
          hooks.getLive() !== L ||
          hooks.getMedia() !== ownerSlot ||
          hooks.getQueued?.() !== queued
        ) {
          return;
        }
      }
      L.inFlightQueued = queued;
      L.hasQueuedPlaylist = true;
      const reply = await send(L, loadfileCommand(queued.request, 'append-play'));
      L.inFlightQueued = undefined;
      if (!reply || hooks.getLive() !== L) return;
      if (reply.error !== 'success') {
        L.hasQueuedPlaylist = false;
        if (hooks.getQueued?.() === queued) hooks.setQueued?.(undefined);
        return;
      }
      const entryId =
        queued.entryId ??
        replyEntryId(reply) ??
        entryIdOf((await send(L, ['get_property', 'playlist/1/id']))?.data);
      if (hooks.getLive() !== L) return;
      if (hooks.getMedia() === queued) return;
      if (hooks.getQueued?.() !== queued) {
        if (entryId !== undefined) L.entries.unbind(entryId);
        return;
      }
      if (entryId !== undefined) {
        if (queued.entryId === undefined) bind(L, queued, entryId);
        L.queuedEntryId = entryId;
      }
    },
    async loadSlot(L: LiveSession, slot: MediaSlot, stopFirst: boolean): Promise<void> {
      if (L.hasQueuedPlaylist) {
        if (L.queuedEntryId !== undefined) {
          L.entries.unbind(L.queuedEntryId);
          L.queuedEntryId = undefined;
        }
        await send(L, ['playlist-clear']);
        L.hasQueuedPlaylist = false;
        if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
      }
      if (stopFirst && !(await stopCurrent(L))) return;
      if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
      const desiredAudio = hooks.getDesiredAudioDevice?.();
      if (desiredAudio !== undefined && L.appliedAudioDevice !== desiredAudio) {
        L.appliedAudioDevice = desiredAudio;
        await send(L, ['set_property', 'audio-device', desiredAudio]);
        if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
      }
      const desiredSubFont = hooks.getDesiredSubtitleFont?.();
      if (desiredSubFont !== undefined && L.appliedSubtitleFont !== desiredSubFont) {
        L.appliedSubtitleFont = desiredSubFont;
        await send(L, ['set_property', 'sub-font', desiredSubFont]);
        if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
      }
      const desiredDeinterlace = hooks.getDesiredDeinterlaceMode?.();
      if (
        desiredDeinterlace !== undefined &&
        (L.appliedDeinterlaceMode !== desiredDeinterlace || desiredDeinterlace !== 'off')
      ) {
        L.appliedDeinterlaceMode = desiredDeinterlace;
        for (const cmd of deinterlaceCommands(desiredDeinterlace)) {
          await send(L, cmd);
          if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
        }
      }
      const desiredPitchLock = hooks.getDesiredPitchLock?.();
      if (desiredPitchLock !== undefined && L.appliedPitchLock !== desiredPitchLock) {
        L.appliedPitchLock = desiredPitchLock;
        await send(L, pitchLockCommand(desiredPitchLock));
        if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
      }
      const desiredNorm = hooks.getDesiredAudioNormalization?.();
      if (desiredNorm !== undefined) {
        const effectiveNorm = desiredNorm && !hooks.isSpdifPassthroughActive?.();
        if (L.appliedAudioNormalization !== effectiveNorm) {
          L.appliedAudioNormalization = effectiveNorm;
          await send(L, audioNormalizationCommand(effectiveNorm));
          if (slot !== hooks.getMedia() || hooks.getLive() !== L) return;
        }
      }
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
