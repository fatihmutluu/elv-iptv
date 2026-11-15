import type { AttemptToken, EngineEvent, MediaKind, PlayerEngine } from '@elv/playback';
import {
  DESKTOP_CAPABILITIES,
  type PlayerArea,
  type PlayerUiEvent,
  type PresenterKind,
} from '../../shared/player-ipc.ts';
import { MpvWedgedError } from './mpv/client.ts';
import type { MpvCommand, MpvEvent, MpvReply } from './mpv/codec.ts';
import { createDeriver, type Deriver } from './mpv/derive.ts';
import { createEntryTable, type EntryTable } from './mpv/entries.ts';
import { headerFields, loadfileCommand } from './mpv/options.ts';
import type { MpvProcess } from './mpv/process.ts';
import type { VideoPresenter } from './presenter/types.ts';

/** How `load` replaces the media: mpv's `loadfile replace`, or `stop`, the old entry's `end-file`, then `loadfile`. */
export type LoadMode = 'replace' | 'stop-then-load';

/** What the engine needs from the app; tests pass a FakeMpv and their own timers. */
export interface MpvEngineDeps {
  /** Starts mpv with `args` (the transport is the spawner's) and connects; an abort kills a process still starting. */
  spawn(args: readonly string[], signal: AbortSignal): Promise<MpvProcess>;
  presenter: VideoPresenter;
  /** Launch options placed before the presenter's (`launchArgs` without presenter and transport options). */
  baseArgs: readonly string[];
  loadMode: LoadMode;
  now(): number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Presentation events outside the port (`player:ui`). */
  onUi(event: PlayerUiEvent): void;
  /**
   * Start mpv (and the presenter's surface) at `start()` instead of at creation, so the owner can subscribe first and
   * not miss the surface events that starting emits.
   */
  deferStart?: boolean;
}

/** The desktop `PlayerEngine`: one mpv process per player window, kept across zaps. */
export interface MpvEngine extends PlayerEngine {
  /** mpv processes started so far (the gate's `mpvSpawns`). */
  readonly spawns: number;
  /** The longest a load that went out waited for the previous one to open (the gate's coalescing wait), in ms. */
  readonly maxHoldMs: number;
  readonly loadMode: LoadMode;
  readonly presenterKind: PresenterKind;
  /** Starts mpv now; only needed with `deferStart` (a `load` starts it too). Idempotent. */
  start(): void;
  /** The latest player area from the renderer, for the presenter. */
  setArea(area: PlayerArea): void;
  /** The last area `setArea` received (the gate samples it). */
  readonly lastArea: PlayerArea | undefined;
  /** Toggles the presenter's fullscreen (not a port command). */
  toggleFullscreen(): void;
}

const OBSERVED = [
  'pause',
  'paused-for-cache',
  'core-idle',
  'seeking',
  'time-pos',
  'duration',
  'speed',
  'demuxer-cache-state',
  'video-params',
  'vid',
] as const;
const OBSERVED_NAMES: ReadonlySet<string> = new Set(OBSERVED);
/** mpv logs a provider notice's `Mime-type` line only at `v`; `keepLog` drops the rest of that chatter. */
const LOG_LEVEL = 'v';
const KEPT_LEVELS: ReadonlySet<string> = new Set(['fatal', 'error', 'warn', 'info']);
const QUIT_GRACE_MS = 500;
const END_TIMEOUT_MS = 3000;
/** A sent load that gets no `start-file` in this time counts as a wedged mpv, like a missing reply. */
const START_TIMEOUT_MS = 3000;
/** How long a started load may hold the next one back while its stream opens (slow providers). */
const OPEN_WAIT_MS = 1000;
const CLOCK_INTERVAL_MS = 1000;

type UiKey = Extract<PlayerUiEvent, { type: 'key' }>['key'];
const UI_KEYS: ReadonlySet<string> = new Set<UiKey>([
  'channel-up',
  'channel-down',
  'back',
  'close',
]);
const isUiKey = (key: unknown): key is UiKey => typeof key === 'string' && UI_KEYS.has(key);

/** Keeps the lines `classifyEnd` reads, so the 50-line window per media is not filled with `v` chatter. */
const keepLog = (level: string, text: string): boolean =>
  KEPT_LEVELS.has(level) || text.startsWith('Mime-type:');

interface MediaRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  kind: MediaKind;
  startMs?: number;
}

/** The newest `load` (or `retry`) and the mpv entry it created. */
interface Slot {
  token: AttemptToken;
  request: MediaRequest;
  entryId?: number;
  lastPositionMs?: number;
}

type Op =
  | { type: 'load'; slot: Slot }
  | { type: 'command'; command: MpvCommand }
  | { type: 'stop' }
  | { type: 'recreate' };

interface Opening {
  slot: Slot;
  started: boolean;
  timer?: unknown;
  done: Promise<void>;
  finish(): void;
}

/** One connected mpv process and the state that dies with it (entry ids restart per process). */
interface Live {
  proc: MpvProcess;
  entries: EntryTable;
  deriver: Deriver;
  paused: boolean;
  userQuit: boolean;
  hasCustomHeaders: boolean;
  /** The load whose `loadfile` is sent but not bound yet. */
  inFlight?: Slot;
  /** The last sent load until its stream opened (`file-loaded`) or failed; a newer load waits for it. */
  opening?: Opening;
  endWaiters: Set<{ id: number; done(ended: boolean): void }>;
}

const entryIdOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

const replyEntryId = (reply: MpvReply): number | undefined =>
  typeof reply.data === 'object' && reply.data !== null
    ? entryIdOf((reply.data as Record<string, unknown>)['playlist_entry_id'])
    : undefined;

const withStart = (request: MediaRequest, startMs: number | undefined): MediaRequest => {
  const { startMs: _old, ...rest } = request;
  return startMs === undefined ? rest : { ...rest, startMs };
};

/**
 * Drives one mpv process as a `PlayerEngine`. Commands queue in order and return at once; one `loadfile` is in
 * flight at a time and its entry id is bound to its token before the next goes out, so mpv events map to exactly one
 * token. Only the newest media's events are emitted; a stopped or replaced media is silent.
 */
export function createMpvEngine(deps: MpvEngineDeps): MpvEngine {
  const { presenter, timers } = deps;
  const listeners = new Set<(event: EngineEvent) => void>();
  const queue: Op[] = [];
  let pumping = false;
  let released = false;
  let spawns = 0;
  let maxHoldMs = 0;
  let lastArea: PlayerArea | undefined;
  let latestToken: AttemptToken = 0;
  let media: Slot | undefined;
  let live: Live | undefined;
  let spawning: Promise<Live | undefined> | undefined;
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
          // a listener bug must not stop the others or the engine
        }
      }
    }
  };

  const ui = (event: PlayerUiEvent): void => {
    if (released) return;
    try {
      deps.onUi(event);
    } catch {
      // same isolation as engine listeners
    }
  };

  const isActive = (L: Live, entryId: number | undefined): boolean =>
    live === L && media !== undefined && entryId !== undefined && media.entryId === entryId;

  const fromCurrent = (L: Live, events: EngineEvent[]): void => {
    if (isActive(L, L.entries.current()?.entryId)) emit(events);
  };

  const reportWedged = (detail: string): void => {
    if (media)
      emit([{ attempt: media.token, type: 'error', error: { code: 'engine-wedged', detail } }]);
  };

  const finishOpening = (L: Live): void => {
    const opening = L.opening;
    if (!opening) return;
    L.opening = undefined;
    timers.clearTimeout(opening.timer);
    opening.finish();
  };

  const beginOpening = (L: Live, slot: Slot): void => {
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    L.opening = { slot, started: false, done, finish };
  };

  const armOpening = (L: Live, ms: number, onTimeout: () => void): void => {
    const opening = L.opening;
    if (!opening) return;
    timers.clearTimeout(opening.timer);
    opening.timer = timers.setTimeout(() => {
      if (L.opening === opening) onTimeout();
    }, ms);
  };

  /** Wakes a load waiting for the previous one to open, so it can see that it was superseded. */
  let wakePending: (() => void) | undefined;
  const superseded = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wakePending = resolve;
    });
  const wake = (): void => {
    const resolve = wakePending;
    wakePending = undefined;
    resolve?.();
  };

  const detach = (L: Live): void => {
    if (live !== L) return;
    live = undefined;
    if (media) media.entryId = undefined;
    finishOpening(L);
    for (const waiter of [...L.endWaiters]) waiter.done(false);
  };

  const wedged = (L: Live, detail: string): void => {
    if (live !== L) return;
    detach(L);
    L.proc.kill();
    reportWedged(detail);
  };

  const send = async (L: Live, command: MpvCommand): Promise<MpvReply | undefined> => {
    if (live !== L) return undefined;
    try {
      return await L.proc.client.command(command);
    } catch (error) {
      if (error instanceof MpvWedgedError) wedged(L, 'mpv did not reply in time');
      return undefined;
    }
  };

  const bind = (L: Live, slot: Slot, entryId: number): void => {
    L.entries.bind(entryId, slot.token, slot.request.kind);
    slot.entryId = entryId;
  };

  const onStartFile = (L: Live, entryId: number): void => {
    // mpv can announce the new entry before the engine has read the loadfile reply; only that load can own it.
    if (L.entries.tokenOf(entryId) === undefined && L.inFlight) bind(L, L.inFlight, entryId);
    if (L.opening?.slot.entryId === entryId) {
      L.opening.started = true;
      armOpening(L, OPEN_WAIT_MS, () => finishOpening(L));
    }
    L.entries.started(entryId);
    const current = L.entries.current();
    if (current?.entryId !== entryId) return;
    const events = L.deriver.begin(current.token, current.kind);
    // mpv keeps `pause` across files and reports no change for the new one.
    if (L.paused) events.push(...L.deriver.property('pause', true));
    if (isActive(L, entryId)) emit(events);
  };

  const onEndFile = (L: Live, e: MpvEvent): void => {
    const entryId = entryIdOf(e['playlist_entry_id']);
    if (e['reason'] === 'quit') L.userQuit = true;
    const active = isActive(L, entryId);
    const isCurrent = entryId !== undefined && L.entries.current()?.entryId === entryId;
    const events = isCurrent ? L.deriver.fileEvent(e) : [];
    if (entryId !== undefined) L.entries.ended(entryId);
    if (entryId !== undefined && L.opening?.slot.entryId === entryId) finishOpening(L);
    for (const waiter of [...L.endWaiters]) if (waiter.id === entryId) waiter.done(true);
    if (active) emit(events);
  };

  const onClientMessage = (args: unknown): void => {
    if (!Array.isArray(args) || args[0] !== 'elv-key') return;
    if (args[1] === 'fullscreen') presenter.toggleFullscreen();
    else if (isUiKey(args[1])) ui({ type: 'key', key: args[1] });
  };

  const onMpvEvent = (L: Live, e: MpvEvent): void => {
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
        if (L.opening?.started && L.entries.current()?.entryId === L.opening.slot.entryId)
          finishOpening(L);
        fromCurrent(L, L.deriver.fileEvent(e));
        return;
      case 'playback-restart':
        fromCurrent(L, L.deriver.fileEvent(e));
        return;
      case 'property-change': {
        const name = String(e['name']);
        if (name === 'pause') L.paused = e['data'] === true;
        if (OBSERVED_NAMES.has(name)) fromCurrent(L, L.deriver.property(name, e['data']));
        return;
      }
      case 'log-message': {
        const level = String(e['level']);
        const text = String(e['text'] ?? '').trimEnd();
        if (keepLog(level, text)) L.deriver.log({ prefix: String(e['prefix']), level, text });
        return;
      }
      case 'client-message':
        onClientMessage(e['args']);
    }
  };

  const waitCleanExit = async (proc: MpvProcess): Promise<boolean> => {
    let timer: unknown;
    const timedOut = new Promise<false>((resolve) => {
      timer = timers.setTimeout(() => resolve(false), QUIT_GRACE_MS);
    });
    const clean = await Promise.race([
      proc.exited.then((info) => info.code === 0 && info.signal === null),
      timedOut,
    ]);
    timers.clearTimeout(timer);
    return clean;
  };

  const onClosed = (L: Live): void => {
    if (live !== L) return;
    const noCurrentFile = L.entries.current() === undefined;
    const tokenAtClose = media?.token;
    detach(L);
    if (presenter.kind === 'own-window' && L.userQuit) {
      L.proc.kill();
      ui({ type: 'closed' });
      return;
    }
    if (presenter.kind === 'own-window' && noCurrentFile) {
      void waitCleanExit(L.proc).then((clean) => {
        L.proc.kill();
        if (clean) ui({ type: 'closed' });
        else if (tokenAtClose !== undefined && media?.token === tokenAtClose)
          reportWedged('mpv exited');
      });
      return;
    }
    L.proc.kill();
    reportWedged('mpv exited');
  };

  const connect = (proc: MpvProcess): Live => {
    const L: Live = {
      proc,
      entries: createEntryTable(),
      deriver: createDeriver({ now: deps.now, clockIntervalMs: CLOCK_INTERVAL_MS }),
      paused: false,
      userQuit: false,
      hasCustomHeaders: false,
      endWaiters: new Set(),
    };
    live = L;
    proc.client.onEvent((e) => {
      if (live === L) onMpvEvent(L, e);
    });
    proc.client.onClose(() => onClosed(L));
    presenter.attach(proc.client);
    for (const name of OBSERVED) proc.client.observe(name);
    void send(L, ['request_log_messages', LOG_LEVEL]);
    return L;
  };

  const startProcess = async (): Promise<Live | undefined> => {
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
      return connect(proc);
    } catch {
      if (!released) reportWedged('mpv could not start');
      return undefined;
    }
  };

  const ensureProcess = (): Promise<Live | undefined> => {
    if (released) return Promise.resolve(undefined);
    if (live) return Promise.resolve(live);
    spawning ??= startProcess().finally(() => {
      spawning = undefined;
    });
    return spawning;
  };

  /** `stop-then-load`: stops the current entry and waits for its `end-file`; false when mpv was given up on. */
  const stopCurrent = async (L: Live): Promise<boolean> => {
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

  const runLoad = async (slot: Slot): Promise<void> => {
    const L = await ensureProcess();
    if (!L || slot !== media) return;
    // Zap coalescing: wait until the last sent load opened or failed; a newer load replaces this one meanwhile.
    const heldAt = deps.now();
    while (L.opening && slot === media && live === L)
      await Promise.race([L.opening.done, superseded()]);
    if (slot !== media || live !== L) return;
    maxHoldMs = Math.max(maxHoldMs, deps.now() - heldAt);
    if (deps.loadMode === 'stop-then-load' && !(await stopCurrent(L))) return;
    if (slot !== media || live !== L) return;
    const fields = headerFields(slot.request.headers);
    if (fields.length > 0 || L.hasCustomHeaders) {
      if (fields.length > 0) L.hasCustomHeaders = true;
      const propReply = await send(L, ['set_property', 'http-header-fields', fields]);
      if (!propReply || live !== L) return;
      if (propReply.error !== 'success') {
        if (slot === media)
          emit([
            {
              attempt: slot.token,
              type: 'error',
              error: { code: 'unknown', detail: `http-header-fields: ${propReply.error}` },
            },
          ]);
        return;
      }
      if (fields.length === 0) L.hasCustomHeaders = false;
      if (slot !== media) return;
    }
    L.inFlight = slot;
    beginOpening(L, slot);
    const reply = await send(L, loadfileCommand(slot.request));
    if (!reply || live !== L) return;
    if (reply.error !== 'success') {
      L.inFlight = undefined;
      finishOpening(L);
      if (slot === media)
        emit([
          {
            attempt: slot.token,
            type: 'error',
            error: { code: 'unknown', detail: `loadfile: ${reply.error}` },
          },
        ]);
      return;
    }
    const entryId =
      slot.entryId ??
      replyEntryId(reply) ??
      entryIdOf((await send(L, ['get_property', 'playlist/0/id']))?.data);
    L.inFlight = undefined;
    if (live !== L) return;
    if (entryId !== undefined && slot.entryId === undefined) bind(L, slot, entryId);
    if (L.opening?.slot === slot && !L.opening.started)
      armOpening(L, START_TIMEOUT_MS, () => wedged(L, 'mpv did not start the media'));
    // mpv keeps `pause` across files; a load means play, as on the other engines.
    if (L.paused && slot === media) await send(L, ['set', 'pause', 'no']);
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

  const run = async (op: Op): Promise<void> => {
    switch (op.type) {
      case 'load':
        return runLoad(op.slot);
      case 'recreate':
        return runRecreate();
      case 'stop': {
        const L = live;
        if (!L) return;
        if (L.hasCustomHeaders) {
          const propReply = await send(L, ['set_property', 'http-header-fields', []]);
          if (propReply?.error === 'success') L.hasCustomHeaders = false;
        }
        await send(L, ['stop']);
        finishOpening(L);
        return;
      }
      case 'command':
        if (live) await send(live, op.command);
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (let op = queue.shift(); op && !released; op = queue.shift()) {
        try {
          await run(op);
        } catch {
          // every step maps its own failures to events; nothing may stop the queue
        }
      }
    } finally {
      pumping = false;
    }
  };

  const enqueue = (op: Op): void => {
    if (op.type === 'load' || op.type === 'stop') {
      for (let i = queue.length - 1; i >= 0; i -= 1)
        if (queue[i]?.type === 'load') queue.splice(i, 1);
    }
    queue.push(op);
    void pump();
  };

  const note = (token: AttemptToken): void => {
    if (token > latestToken) latestToken = token;
  };

  /** Port contract: a newer token tags the current media's later events, wherever its entry is. */
  const adopt = (token: AttemptToken): void => {
    note(token);
    if (!media || token <= media.token) return;
    media.token = token;
    const L = live;
    if (!L || media.entryId === undefined) return;
    if (L.entries.current()?.entryId === media.entryId) {
      L.entries.adopt(token);
      L.deriver.adopt(token);
    } else if (L.entries.tokenOf(media.entryId) !== undefined)
      L.entries.bind(media.entryId, token, media.request.kind);
  };

  const startMedia = (token: AttemptToken, request: MediaRequest): void => {
    note(token);
    media = { token, request };
    enqueue({ type: 'load', slot: media });
    wake();
  };

  const command = (token: AttemptToken, cmd: MpvCommand): void => {
    if (released) return;
    adopt(token);
    enqueue({ type: 'command', command: cmd });
  };

  const offSurface = presenter.onEvent((e) =>
    emit([{ attempt: latestToken, type: 'surface', change: e.change }]),
  );

  const tick = (): void => {
    if (released) return;
    if (live) fromCurrent(live, live.deriver.tick());
    tickHandle = timers.setTimeout(tick, CLOCK_INTERVAL_MS);
  };
  tickHandle = timers.setTimeout(tick, CLOCK_INTERVAL_MS);
  if (!deps.deferStart) void ensureProcess();

  return {
    capabilities: DESKTOP_CAPABILITIES,
    loadMode: deps.loadMode,
    presenterKind: presenter.kind,
    start() {
      if (!released) void ensureProcess();
    },
    setArea(area) {
      if (released) return;
      lastArea = area;
      presenter.setArea(area);
    },
    toggleFullscreen() {
      if (!released) presenter.toggleFullscreen();
    },
    get spawns() {
      return spawns;
    },
    get lastArea() {
      return lastArea;
    },
    get maxHoldMs() {
      return maxHoldMs;
    },
    load(cmd) {
      if (released) return;
      const { url, headers, kind } = cmd;
      startMedia(cmd.attempt, withStart({ url, headers, kind }, cmd.startMs));
    },
    retry(attempt) {
      if (released || !media) return;
      const { request, lastPositionMs } = media;
      // live reconnects at the edge; VOD resumes where the last anchor saw it
      const startMs = request.kind === 'vod' ? (lastPositionMs ?? request.startMs) : undefined;
      startMedia(attempt, withStart(request, startMs));
    },
    play: (attempt) => command(attempt, ['set', 'pause', 'no']),
    pause: (attempt) => command(attempt, ['set', 'pause', 'yes']),
    seek: (attempt, positionMs) => command(attempt, ['seek', positionMs / 1000, 'absolute']),
    stop(attempt) {
      if (released) return;
      adopt(attempt);
      media = undefined;
      enqueue({ type: 'stop' });
      wake();
    },
    recreate(attempt) {
      if (released) return;
      adopt(attempt);
      enqueue({ type: 'recreate' });
    },
    release() {
      if (released) return;
      released = true;
      queue.length = 0;
      listeners.clear();
      timers.clearTimeout(tickHandle);
      spawnAbort?.abort();
      wake();
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
