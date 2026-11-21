import type { AttemptToken, EngineEvent, PlayerEngine } from '@elv/playback';
import {
  DESKTOP_CAPABILITIES,
  type PlayerArea,
  type PlayerUiEvent,
  type PresenterKind,
} from '../../shared/player-ipc.ts';
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
    if (media) {
      emit([{ attempt: media.token, type: 'error', error: { code: 'engine-wedged', detail } }]);
    }
  };

  const detach = (L: LiveSession): void => {
    if (live !== L) return;
    live = undefined;
    if (media) media.entryId = undefined;
    L.hotplug.reset();
    L.repeatGate.reset();
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
        case 'command':
          if (
            live &&
            op.generation === queue.generation &&
            (op.slot === undefined || op.slot === media)
          ) {
            await session.send(live, op.command);
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

  const startMedia = (token: AttemptToken, request: MediaRequest): void => {
    note(token);
    media = { token, request };
    queue.enqueueLoad(media);
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
    toggleFullscreen: () => {
      if (!released) presenter.toggleFullscreen();
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
      tracks.onLoad(cmd.options);
      const { url, headers, kind } = cmd;
      startMedia(cmd.attempt, withStart({ url, headers, kind }, cmd.startMs));
    },
    retry(attempt) {
      if (released || !media) return;
      tracks.onRetryOrRecreate();
      const { request, lastPositionMs } = media;
      const startMs = request.kind === 'vod' ? (lastPositionMs ?? request.startMs) : undefined;
      startMedia(attempt, withStart(request, startMs));
    },
    play: (attempt) => command(attempt, ['set', 'pause', 'no']),
    pause: (attempt) => command(attempt, ['set', 'pause', 'yes']),
    seek: (attempt, positionMs) => command(attempt, ['seek', positionMs / 1000, 'absolute']),
    selectAudioTrack(attempt, id) {
      if (released) return;
      const cmd = tracks.selectAudio(id);
      if (!cmd) return;
      adopt(attempt);
      queue.enqueueCommand(cmd, media);
    },
    selectSubtitleTrack(attempt, id) {
      if (released) return;
      const cmd = tracks.selectSubtitle(id);
      if (!cmd) return;
      adopt(attempt);
      queue.enqueueCommand(cmd, media);
    },
    stop(attempt) {
      if (released) return;
      adopt(attempt);
      tracks.onStop();
      live?.repeatGate.reset();
      media = undefined;
      queue.enqueueStop();
      opening.wake();
    },
    recreate(attempt) {
      if (released) return;
      adopt(attempt);
      tracks.onRetryOrRecreate();
      queue.enqueueRecreate();
    },
    release() {
      if (released) return;
      released = true;
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
