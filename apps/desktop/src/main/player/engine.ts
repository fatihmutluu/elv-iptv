import {
  type AttemptToken,
  type EngineEvent,
  type ExternalSubtitleTrack,
  normalizeExternalSubtitleTrack,
  type PlayerEngine,
} from '@elv/playback';
import {
  type AccessibilityFontFamily,
  DESKTOP_CAPABILITIES,
  type DeinterlaceMode,
  type HwdecProfile,
  type PlayerArea,
  type PlayerUiEvent,
  type PresenterKind,
  type QueueNextRequest,
  type ResizeMode,
} from '../../shared/player-ipc.ts';
import { createEngineControls, isSpdifPassthroughValue } from './engine-controls.ts';
import { createEngineQueue, type QueuedOp } from './engine-queue.ts';
import type { MpvCommand } from './mpv/codec.ts';
import {
  createSessionController,
  type LiveSession,
  type MediaRequest,
  type MediaSlot,
  type QueuedMediaSlot,
} from './mpv/live-session.ts';
import { createOpeningGate } from './mpv/opening-gate.ts';
import { headerFields } from './mpv/options.ts';
import type { MpvProcess } from './mpv/process.ts';
import type { ReadaheadTierStore } from './mpv/readahead.ts';
import { createTrackTracker } from './mpv/tracks.ts';
import type { VideoPresenter } from './presenter/types.ts';
import { createSubtitleFetchSession } from './subtitle-fetch.ts';

/** How `load` replaces the media: mpv's `loadfile replace`, or `stop`, the old entry's `end-file`, then `loadfile`. */
export type LoadMode = 'replace' | 'stop-then-load';

/** What the engine needs from the app; tests pass a FakeMpv and their own timers. */
export interface MpvEngineDeps {
  spawn(args: readonly string[], signal: AbortSignal): Promise<MpvProcess>;
  presenter: VideoPresenter;
  baseArgs: readonly string[];
  loadMode: LoadMode;
  now(): number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  onUi(event: PlayerUiEvent): void;
  deferStart?: boolean;
  platform?: NodeJS.Platform;
  audioRampMs?: number;
  readaheadStore?: ReadaheadTierStore;
}

/** The desktop `PlayerEngine`: one mpv process per player window, kept across zaps. */
export interface MpvEngine extends PlayerEngine {
  readonly spawns: number;
  readonly maxHoldMs: number;
  readonly loadMode: LoadMode;
  readonly presenterKind: PresenterKind;
  start(): void;
  setArea(area: PlayerArea): void;
  readonly lastArea: PlayerArea | undefined;
  toggleFullscreen(): void;
  toggleMute(): void;
  setVolume(volume: number): void;
  setAudioDelay(attempt: AttemptToken, delayMs: number): void;
  setAudioDelay(delaySec: number): void;
  setSubtitleDelay(attempt: AttemptToken, delayMs: number): void;
  setSubtitleDelay(delaySec: number): void;
  setAudioDevice(device: string): void;
  setDeinterlace(enabled: boolean): void;
  setDeinterlaceMode(mode: DeinterlaceMode): void;
  setPitchLock(lockedOrAttempt: boolean | AttemptToken, maybeLocked?: boolean): void;
  setAudioNormalization(enabled: boolean): void;
  queueNext(request: QueueNextRequest): void;
  clearQueue(): void;
  onQueueAdvanced(listener: (itemKey: string) => void): () => void;
  setHwdec(profile: HwdecProfile): void;
  setResizeMode(mode: ResizeMode): void;
  setFilterSdh(enabled: boolean): void;
  setSubtitleFontFamily(family: AccessibilityFontFamily): void;
}

const QUIT_GRACE_MS = 500;
const CLOCK_INTERVAL_MS = 1000;

const sameHeaderFields = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
};

const withStart = (request: MediaRequest, startMs: number | undefined): MediaRequest => {
  const { startMs: _old, ...rest } = request;
  return startMs === undefined ? rest : { ...rest, startMs };
};

const buildSubAddCommand = (
  localPath: string,
  track: ExternalSubtitleTrack,
  flags: 'select' | 'auto',
): MpvCommand => {
  const label = track.label ?? '';
  const lang = track.language ?? '';
  if (lang.length > 0) return ['sub-add', localPath, flags, label, lang];
  if (label.length > 0) return ['sub-add', localPath, flags, label];
  return ['sub-add', localPath, flags];
};

/** Drives one mpv process as a `PlayerEngine` with zap coalescing, entry-id binding and serialized IPC. */
export function createMpvEngine(deps: MpvEngineDeps): MpvEngine {
  const { presenter, timers } = deps;
  const listeners = new Set<(event: EngineEvent) => void>();
  const queueAdvancedListeners = new Set<(itemKey: string) => void>();
  const tracks = createTrackTracker();
  const opening = createOpeningGate<MediaSlot>({ now: deps.now, timers });
  const subtitleFetcher = createSubtitleFetchSession();
  let released = false;
  let spawns = 0;
  let lastArea: PlayerArea | undefined;
  let latestToken: AttemptToken = 0;
  let media: MediaSlot | undefined;
  let queuedSlot: QueuedMediaSlot | undefined;
  let live: LiveSession | undefined;
  let spawning: Promise<LiveSession | undefined> | undefined;
  let spawnAbort: AbortController | undefined;
  let tickHandle: unknown;
  let desiredAudioDelayMs = 0;
  let desiredSubtitleDelayMs = 0;
  let desiredVideoQualityId: string | null = null;

  const resetPerMediaOverrides = (): void => {
    desiredAudioDelayMs = 0;
    desiredSubtitleDelayMs = 0;
    desiredVideoQualityId = null;
  };

  const emit = (events: readonly EngineEvent[]): void => {
    for (const event of events) {
      if (released) return;
      if (event.type === 'clock' && media) media.lastPositionMs = event.anchor.positionMs;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // isolate faulty subscribers
        }
      }
    }
  };

  const ui = (event: PlayerUiEvent): void => {
    if (released) return;
    if (event.type === 'queueAdvanced') {
      for (const listener of [...queueAdvancedListeners]) {
        try {
          listener(event.itemKey);
        } catch {
          // isolate faulty queueAdvanced listeners
        }
      }
    }
    try {
      deps.onUi(event);
    } catch {
      // isolate faulty UI listeners
    }
  };

  const reportWedged = (detail: string): void => {
    if (media)
      emit([{ attempt: media.token, type: 'error', error: { code: 'engine-wedged', detail } }]);
  };

  const detach = (L: LiveSession): void => {
    if (live !== L) return;
    live = undefined;
    controls.cancelRamp(false);
    controls.reset();
    if (media) media.entryId = undefined;
    queuedSlot = undefined;
    L.hasQueuedPlaylist = false;
    L.queuedEntryId = undefined;
    L.inFlightQueued = undefined;
    L.hotplug.reset();
    L.audioDevices.reset();
    L.repeatGate.reset();
    L.readahead.reset();
    opening.finish();
    for (const waiter of [...L.endWaiters]) waiter.done(false);
  };

  const session = createSessionController({
    presenter,
    tracks,
    opening,
    now: deps.now,
    timers,
    quitGraceMs: QUIT_GRACE_MS,
    getLive: () => live,
    setLive: (next) => {
      live = next;
    },
    getMedia: () => media,
    getQueued: () => queuedSlot,
    setQueued: (next) => {
      queuedSlot = next;
    },
    promoteQueued: (slot) => {
      resetPerMediaOverrides();
      media = slot;
      queuedSlot = undefined;
    },
    detach,
    emit,
    ui,
    reportWedged,
    enqueueCommand: (cmd, slot) => queue.enqueueCommand(cmd, slot),
    onAudioProperty: (name, value) => controls.onAudioProperty(name, value),
    onAudioSpdifProperty: (value) => controls.onAudioSpdifProperty(value),
    getDesiredAudioDevice: () => controls.getDesiredAudioDevice(),
    getDesiredSubtitleFont: () => controls.getDesiredSubtitleFont(),
    getDesiredSubtitleStyle: () => controls.getDesiredSubtitleStyle(),
    isSecondarySubtitleActive: () => tracks.hasActiveSecondarySubtitle(),
    onSecondarySubtitlePositionSync: (active) => controls.syncSubtitlePosition(active),
    onFileLoadedExternalSubtitles: (slot) => {
      const list = slot.request.externalSubtitles;
      if (!list || list.length === 0) return;
      for (const track of list) attachExternalSubtitle(slot, track, 'auto');
    },
    getDesiredDeinterlaceMode: () => controls.getDesiredDeinterlaceMode(),
    getDesiredPitchLock: () => controls.getDesiredPitchLock(),
    getDesiredAudioNormalization: () => controls.getDesiredAudioNormalization(),
    getDesiredAudioDelayMs: () => desiredAudioDelayMs,
    getDesiredSubtitleDelayMs: () => desiredSubtitleDelayMs,
    getDesiredVideoQualityId: () => desiredVideoQualityId,
    isSpdifPassthroughActive: () => controls.isSpdifPassthroughActive(),
    ...(deps.readaheadStore === undefined ? {} : { readaheadStore: deps.readaheadStore }),
  });

  const startProcess = async (): Promise<LiveSession | undefined> => {
    spawns += 1;
    const controller = new AbortController();
    spawnAbort = controller;
    try {
      const presenterArgs = await presenter.prepare();
      if (released) return undefined;
      const proc = await deps.spawn([...deps.baseArgs, ...presenterArgs], controller.signal);
      if (released) {
        proc.kill();
        return undefined;
      }
      return session.connect(proc);
    } catch {
      if (!released) reportWedged('mpv could not start');
      return undefined;
    }
  };

  const ensureProcess = (): Promise<LiveSession | undefined> => {
    if (released) return Promise.resolve(undefined);
    if (live) return Promise.resolve(live);
    spawning ??= startProcess().finally(() => {
      spawning = undefined;
    });
    return spawning;
  };

  const runLoad = async (slot: MediaSlot): Promise<void> => {
    const L = await ensureProcess();
    if (!L || slot !== media) return;
    await opening.waitUntilClear(() => slot === media && live === L);
    if (slot !== media || live !== L) return;
    await session.loadSlot(L, slot, deps.loadMode === 'stop-then-load');
  };

  const runRecreate = async (): Promise<void> => {
    if (spawning) {
      await spawning;
      return;
    }
    const L = live;
    if (L) {
      if (L.hasQueuedPlaylist) await session.clearQueuedPlaylist(L);
      detach(L);
      await L.proc.quit(QUIT_GRACE_MS).catch(() => undefined);
    }
    await ensureProcess();
  };

  const queue = createEngineQueue<MediaSlot>({
    isReleased: () => released,
    async run(op: QueuedOp<MediaSlot>): Promise<void> {
      switch (op.type) {
        case 'load':
          return runLoad(op.slot);
        case 'recreate':
          return runRecreate();
        case 'stop': {
          const L = live;
          if (!L) return;
          if (L.hasQueuedPlaylist) await session.clearQueuedPlaylist(L);
          if (L.hasCustomHeaders) {
            const propReply = await session.send(L, ['set_property', 'http-header-fields', []]);
            if (propReply?.error === 'success') L.hasCustomHeaders = false;
          }
          await session.send(L, ['stop']);
          opening.finish();
          return;
        }
        case 'task': {
          if (
            live &&
            op.generation === queue.generation &&
            (op.slot === undefined || op.slot === media)
          ) {
            await op.task();
          }
          return;
        }
        case 'command': {
          try {
            if (
              live &&
              op.generation === queue.generation &&
              (op.slot === undefined || op.slot === media)
            ) {
              const target = live;
              await session.send(target, op.command);
              if (live === target) {
                if (
                  op.command[0] === 'set_property' &&
                  op.command[1] === 'audio-device' &&
                  typeof op.command[2] === 'string'
                ) {
                  target.appliedAudioDevice = op.command[2];
                } else if (
                  op.command[0] === 'set_property' &&
                  op.command[1] === 'sub-font' &&
                  typeof op.command[2] === 'string'
                ) {
                  target.appliedSubtitleFont = op.command[2];
                } else if (
                  op.command[0] === 'set_property' &&
                  op.command[1] === 'audio-pitch-correction' &&
                  typeof op.command[2] === 'string'
                ) {
                  target.appliedPitchLock = op.command[2] === 'yes';
                } else if (
                  op.command[0] === 'set_property' &&
                  op.command[1] === 'deinterlace' &&
                  op.command[2] === 'auto'
                ) {
                  target.appliedDeinterlaceMode = 'auto';
                } else if (
                  op.command[0] === 'vf' &&
                  op.command[1] === 'add' &&
                  typeof op.command[2] === 'string' &&
                  op.command[2].startsWith('@elv_deint:')
                ) {
                  target.appliedDeinterlaceMode = 'bwdif';
                } else if (
                  op.command[0] === 'vf' &&
                  op.command[1] === 'remove' &&
                  op.command[2] === '@elv_deint' &&
                  controls.getDesiredDeinterlaceMode() === 'off'
                ) {
                  target.appliedDeinterlaceMode = 'off';
                } else if (
                  op.command[0] === 'af' &&
                  op.command[1] === 'add' &&
                  typeof op.command[2] === 'string' &&
                  op.command[2].startsWith('@elv_loudnorm:')
                ) {
                  target.appliedAudioNormalization = true;
                } else if (
                  op.command[0] === 'af' &&
                  op.command[1] === 'remove' &&
                  op.command[2] === '@elv_loudnorm'
                ) {
                  target.appliedAudioNormalization = false;
                }
              }
            }
          } finally {
            if (op.generation === queue.generation) controls.onCommandSettled(op.command);
          }
          return;
        }
      }
    },
  });

  const note = (token: AttemptToken): void => {
    if (token > latestToken) latestToken = token;
  };

  const adopt = (token: AttemptToken): void => {
    note(token);
    tracks.adopt(token);
    if (!media || token <= media.token) return;
    media.token = token;
    const L = live;
    if (!L || media.entryId === undefined) return;
    if (L.entries.current()?.entryId === media.entryId) {
      L.entries.adopt(token);
      L.deriver.adopt(token);
    } else if (L.entries.tokenOf(media.entryId) !== undefined) {
      L.entries.bind(media.entryId, token, media.request.kind);
    }
    if (queuedSlot && token > queuedSlot.token) {
      queuedSlot.token = token;
      if (queuedSlot.entryId !== undefined && L.entries.tokenOf(queuedSlot.entryId) !== undefined) {
        L.entries.bind(queuedSlot.entryId, token, queuedSlot.request.kind);
      }
    }
  };

  const controls = createEngineControls({
    isReleased: () => released,
    getLive: () => live,
    getMedia: () => media,
    adopt,
    enqueueCommand: (cmd, slot) => queue.enqueueCommand(cmd, slot),
    now: deps.now,
    timers,
    platform: deps.platform ?? process.platform,
    initialDarwinCompat: deps.baseArgs.includes('--hwdec-image-format=uyvy422'),
    initialSpdifPassthrough: deps.baseArgs.some(
      (arg) =>
        arg.startsWith('--audio-spdif=') &&
        isSpdifPassthroughValue(arg.slice('--audio-spdif='.length)),
    ),
    ...(deps.audioRampMs === undefined ? {} : { audioRampMs: deps.audioRampMs }),
    isSecondarySubtitleActive: () => tracks.hasActiveSecondarySubtitle(),
  });

  const clearQueue = (): void => {
    if (released) return;
    queuedSlot = undefined;
    queue.enqueueTask(async () => {
      const L = live;
      if (L) await session.clearQueuedPlaylist(L);
    });
  };

  const startMedia = (token: AttemptToken, request: MediaRequest): void => {
    note(token);
    controls.reset();
    queuedSlot = undefined;
    media = { token, request };
    queue.enqueueLoad(media);
    controls.cancelRamp(true, true);
    opening.wake();
  };

  const command = (token: AttemptToken, cmd: MpvCommand): void => {
    if (released) return;
    adopt(token);
    queue.enqueueCommand(cmd, media);
  };

  const attachExternalSubtitle = (
    slot: MediaSlot,
    track: ExternalSubtitleTrack,
    flags: 'select' | 'auto',
  ): void => {
    void subtitleFetcher
      .resolveTrack(track)
      .then((localPath) => {
        if (released || media !== slot) return;
        queue.enqueueCommand(buildSubAddCommand(localPath, track, flags), slot);
      })
      .catch(() => undefined);
  };

  const offSurface = presenter.onEvent((e) =>
    emit([{ attempt: latestToken, type: 'surface', change: e.change }]),
  );

  const tick = (): void => {
    if (released) return;
    if (live) session.fromCurrent(live, live.deriver.tick());
    tickHandle = timers.setTimeout(tick, CLOCK_INTERVAL_MS);
  };
  tickHandle = timers.setTimeout(tick, CLOCK_INTERVAL_MS);
  if (!deps.deferStart) void ensureProcess();

  return {
    capabilities: DESKTOP_CAPABILITIES,
    loadMode: deps.loadMode,
    presenterKind: presenter.kind,
    start: () => {
      if (!released) void ensureProcess();
    },
    setArea(area) {
      if (released) return;
      lastArea = area;
      presenter.setArea(area);
    },
    toggleFullscreen: () => !released && presenter.toggleFullscreen(),
    toggleMute: () => controls.toggleMute(),
    setVolume: (volume) => controls.setVolume(volume),
    setAudioDelay(attemptOrDelaySec: AttemptToken | number, maybeDelayMs?: number) {
      if (maybeDelayMs !== undefined) {
        if (Number.isFinite(maybeDelayMs)) {
          desiredAudioDelayMs = Math.max(-30_000, Math.min(30_000, maybeDelayMs));
        }
        controls.setAudioDelay(attemptOrDelaySec, maybeDelayMs);
      } else {
        if (Number.isFinite(attemptOrDelaySec)) {
          desiredAudioDelayMs = Math.max(-30, Math.min(30, attemptOrDelaySec)) * 1000;
        }
        controls.setAudioDelay(attemptOrDelaySec);
      }
    },
    setSubtitleDelay(attemptOrDelaySec: AttemptToken | number, maybeDelayMs?: number) {
      if (maybeDelayMs !== undefined) {
        if (Number.isFinite(maybeDelayMs)) {
          desiredSubtitleDelayMs = Math.max(-30_000, Math.min(30_000, maybeDelayMs));
        }
        controls.setSubtitleDelay(attemptOrDelaySec, maybeDelayMs);
      } else {
        if (Number.isFinite(attemptOrDelaySec)) {
          desiredSubtitleDelayMs = Math.max(-30, Math.min(30, attemptOrDelaySec)) * 1000;
        }
        controls.setSubtitleDelay(attemptOrDelaySec);
      }
    },
    setAudioDevice: (device) => controls.setAudioDevice(device),
    setDeinterlace: (enabled) => controls.setDeinterlace(enabled),
    setDeinterlaceMode: (mode) => controls.setDeinterlaceMode(mode),
    setPitchLock: (lockedOrAttempt, maybeLocked) =>
      controls.setPitchLock(lockedOrAttempt, maybeLocked),
    setAudioNormalization: (enabled) => controls.setAudioNormalization(enabled),
    queueNext(request) {
      if (released || !media || media.request.kind !== 'vod') return;
      const activeCustom = headerFields(media.request.headers);
      const nextCustom = headerFields(request.stream.headers);
      if (!sameHeaderFields(activeCustom, nextCustom)) {
        if (queuedSlot !== undefined || live?.hasQueuedPlaylist) clearQueue();
        return;
      }
      const nextReq: MediaRequest = {
        url: request.stream.url,
        headers: request.stream.headers,
        kind: 'vod',
        ...(request.preferHevcOverDolbyVision === undefined
          ? {}
          : { preferHevcOverDolbyVision: request.preferHevcOverDolbyVision }),
        ...(request.filterSdhSubtitles === undefined
          ? {}
          : { filterSdhSubtitles: request.filterSdhSubtitles }),
      };
      const nextSlot: QueuedMediaSlot = {
        itemKey: request.itemKey,
        token: media.token,
        request: nextReq,
      };
      const ownerSlot = media;
      queuedSlot = nextSlot;
      queue.enqueueTask(async () => {
        const L = live;
        if (L) await session.queueSlot(L, ownerSlot, nextSlot);
      }, ownerSlot);
    },
    clearQueue,
    onQueueAdvanced(listener) {
      if (released) return () => undefined;
      queueAdvancedListeners.add(listener);
      return () => {
        queueAdvancedListeners.delete(listener);
      };
    },
    setHwdec: (profile) => controls.setHwdec(profile),
    setResizeMode: (mode) => controls.setResizeMode(mode),
    setFilterSdh: (enabled) => controls.setFilterSdh(enabled),
    setSubtitleFontFamily: (family) => controls.setSubtitleFontFamily(family),
    setSubtitleStyle: (style) => controls.setSubtitleStyle(style),
    addExternalSubtitle(attempt, track) {
      if (released || !media || attempt < media.token) return;
      const clean = normalizeExternalSubtitleTrack(track);
      if (clean === null) return;
      adopt(attempt);
      const existing = media.request.externalSubtitles ?? [];
      const deduped = existing.filter((item) => item.id !== clean.id && item.uri !== clean.uri);
      media.request = { ...media.request, externalSubtitles: [...deduped, clean] };
      attachExternalSubtitle(media, clean, 'select');
    },
    get spawns() {
      return spawns;
    },
    get lastArea() {
      return lastArea;
    },
    get maxHoldMs() {
      return opening.maxHoldMs;
    },
    load(cmd) {
      if (released) return;
      subtitleFetcher.cleanup();
      resetPerMediaOverrides();
      tracks.onLoad(cmd.options);
      const { url, headers, kind, options } = cmd;
      const effectiveStyle =
        options?.subtitleStyle !== undefined
          ? controls.rememberSubtitleStyle(options.subtitleStyle)
          : controls.getDesiredSubtitleStyle();
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
      };
      startMedia(cmd.attempt, withStart(req, cmd.startMs));
    },
    retry(attempt) {
      if (released || !media) return;
      tracks.onRetryOrRecreate();
      const { request, lastPositionMs } = media;
      const startMs = request.kind === 'vod' ? (lastPositionMs ?? request.startMs) : undefined;
      startMedia(attempt, withStart(request, startMs));
    },
    play: (attempt) => controls.play(attempt),
    pause: (attempt) => controls.pause(attempt),
    seek(attempt, positionMs) {
      if (released || !Number.isFinite(positionMs)) return;
      let targetMs = Math.max(0, positionMs);
      if (media?.request.kind === 'live') {
        const win = live?.deriver.liveWindow();
        if (win?.startMs !== undefined && win.endMs !== undefined && win.endMs > win.startMs) {
          targetMs = Math.min(win.endMs, Math.max(win.startMs, targetMs));
        }
      }
      controls.onSeekQueued();
      command(attempt, ['seek', targetMs / 1000, 'absolute']);
    },
    jumpToLiveEdge(attempt) {
      if (released || !media || media.request.kind !== 'live') return;
      if (attempt < media.token) return;
      const win = live?.deriver.liveWindow();
      controls.onSeekQueued();
      if (win?.endMs !== undefined && Number.isFinite(win.endMs) && win.endMs > 0) {
        command(attempt, ['seek', win.endMs / 1000, 'absolute']);
      } else {
        command(attempt, ['seek', 100, 'absolute-percent']);
      }
    },
    setSpeed: (attempt, rate) => controls.setSpeed(attempt, rate),
    selectAudioTrack(attempt, id) {
      const cmd = released ? undefined : tracks.selectAudio(id);
      if (cmd) command(attempt, cmd);
    },
    selectSubtitleTrack(attempt, id) {
      if (released) return;
      const cmd = tracks.selectSubtitle(id);
      if (!cmd) return;
      const clearSecondary = tracks.clearSecondaryIfCollides(id);
      if (clearSecondary) command(attempt, clearSecondary);
      command(attempt, cmd);
      if (clearSecondary) controls.syncSubtitlePosition(false);
    },
    selectSecondarySubtitleTrack(attempt, id) {
      const cmd = released ? undefined : tracks.selectSecondarySubtitle(id);
      if (!cmd) return;
      command(attempt, cmd);
      controls.syncSubtitlePosition(tracks.hasActiveSecondarySubtitle());
    },
    selectVideoQuality(attempt, id) {
      if (released) return;
      const cmd = tracks.selectVideoQuality(id);
      if (!cmd) return;
      desiredVideoQualityId = id;
      command(attempt, cmd);
      const events = tracks.sync();
      if (events.length > 0) emit(events);
    },
    stop(attempt) {
      if (released) return;
      adopt(attempt);
      subtitleFetcher.cleanup();
      resetPerMediaOverrides();
      controls.reset();
      tracks.onStop();
      live?.repeatGate.reset();
      queuedSlot = undefined;
      media = undefined;
      queue.enqueueStop();
      controls.cancelRamp(true, true);
      opening.wake();
    },
    recreate(attempt) {
      if (released) return;
      adopt(attempt);
      controls.cancelRamp(false);
      controls.reset();
      tracks.onRetryOrRecreate();
      queuedSlot = undefined;
      queue.enqueueRecreate();
    },
    release() {
      if (released) return;
      controls.cancelRamp(true, true);
      released = true;
      subtitleFetcher.cleanup();
      resetPerMediaOverrides();
      controls.reset();
      tracks.onStop();
      queuedSlot = undefined;
      queue.clear();
      listeners.clear();
      queueAdvancedListeners.clear();
      timers.clearTimeout(tickHandle);
      spawnAbort?.abort();
      opening.wake();
      offSurface();
      const L = live;
      if (L) {
        detach(L);
        void L.proc.quit(QUIT_GRACE_MS).catch(() => undefined);
      }
      presenter.dispose();
    },
    subscribe(listener) {
      if (released) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
