import type { AttemptToken, EngineEvent, PlayerEngine } from '@elv/playback';
import {
  DESKTOP_CAPABILITIES,
  type HwdecProfile,
  type PlayerArea,
  type PlayerUiEvent,
  type PresenterKind,
  type ResizeMode,
} from '../../shared/player-ipc.ts';
import { createEngineControls } from './engine-controls.ts';
import { createEngineQueue, type QueuedOp } from './engine-queue.ts';
import type { MpvCommand } from './mpv/codec.ts';
import {
  createSessionController,
  type LiveSession,
  type MediaRequest,
  type MediaSlot,
} from './mpv/live-session.ts';
import { createOpeningGate } from './mpv/opening-gate.ts';
import type { MpvProcess } from './mpv/process.ts';
import type { ReadaheadTierStore } from './mpv/readahead.ts';
import { createTrackTracker } from './mpv/tracks.ts';
import type { VideoPresenter } from './presenter/types.ts';

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
  setAudioDelay(delaySec: number): void;
  setSubtitleDelay(delaySec: number): void;
  setAudioDevice(device: string): void;
  setDeinterlace(enabled: boolean): void;
  setHwdec(profile: HwdecProfile): void;
  setResizeMode(mode: ResizeMode): void;
  setFilterSdh(enabled: boolean): void;
}

const QUIT_GRACE_MS = 500;
const CLOCK_INTERVAL_MS = 1000;

const withStart = (request: MediaRequest, startMs: number | undefined): MediaRequest => {
  const { startMs: _old, ...rest } = request;
  return startMs === undefined ? rest : { ...rest, startMs };
};

/** Drives one mpv process as a `PlayerEngine` with zap coalescing, entry-id binding and serialized IPC. */
export function createMpvEngine(deps: MpvEngineDeps): MpvEngine {
  const { presenter, timers } = deps;
  const listeners = new Set<(event: EngineEvent) => void>();
  const tracks = createTrackTracker();
  const opening = createOpeningGate<MediaSlot>({ now: deps.now, timers });
  let released = false;
  let spawns = 0;
  let lastArea: PlayerArea | undefined;
  let latestToken: AttemptToken = 0;
  let media: MediaSlot | undefined;
  let live: LiveSession | undefined;
  let spawning: Promise<LiveSession | undefined> | undefined;
  let spawnAbort: AbortController | undefined;
  let tickHandle: unknown;

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
    detach,
    emit,
    ui,
    reportWedged,
    enqueueCommand: (cmd, slot) => queue.enqueueCommand(cmd, slot),
    onAudioProperty: (name, value) => controls.onAudioProperty(name, value),
    getDesiredAudioDevice: () => controls.getDesiredAudioDevice(),
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
          if (L.hasCustomHeaders) {
            const propReply = await session.send(L, ['set_property', 'http-header-fields', []]);
            if (propReply?.error === 'success') L.hasCustomHeaders = false;
          }
          await session.send(L, ['stop']);
          opening.finish();
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
              if (
                op.command[0] === 'set_property' &&
                op.command[1] === 'audio-device' &&
                typeof op.command[2] === 'string' &&
                live === target
              ) {
                target.appliedAudioDevice = op.command[2];
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
    ...(deps.audioRampMs === undefined ? {} : { audioRampMs: deps.audioRampMs }),
  });

  const startMedia = (token: AttemptToken, request: MediaRequest): void => {
    note(token);
    controls.reset();
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
    setAudioDelay: (delaySec) => controls.setAudioDelay(delaySec),
    setSubtitleDelay: (delaySec) => controls.setSubtitleDelay(delaySec),
    setAudioDevice: (device) => controls.setAudioDevice(device),
    setDeinterlace: (enabled) => controls.setDeinterlace(enabled),
    setHwdec: (profile) => controls.setHwdec(profile),
    setResizeMode: (mode) => controls.setResizeMode(mode),
    setFilterSdh: (enabled) => controls.setFilterSdh(enabled),
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
      tracks.onLoad(cmd.options);
      const { url, headers, kind, options } = cmd;
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
      if (released) return;
      controls.onSeekQueued();
      command(attempt, ['seek', positionMs / 1000, 'absolute']);
    },
    setSpeed: (attempt, rate) => controls.setSpeed(attempt, rate),
    selectAudioTrack(attempt, id) {
      const cmd = released ? undefined : tracks.selectAudio(id);
      if (cmd) command(attempt, cmd);
    },
    selectSubtitleTrack(attempt, id) {
      const cmd = released ? undefined : tracks.selectSubtitle(id);
      if (cmd) command(attempt, cmd);
    },
    stop(attempt) {
      if (released) return;
      adopt(attempt);
      controls.reset();
      tracks.onStop();
      live?.repeatGate.reset();
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
      queue.enqueueRecreate();
    },
    release() {
      if (released) return;
      controls.cancelRamp(true, true);
      released = true;
      controls.reset();
      tracks.onStop();
      queue.clear();
      listeners.clear();
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
