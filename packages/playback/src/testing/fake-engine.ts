import type {
  AttemptToken,
  ClockAnchor,
  EngineCapabilities,
  EngineError,
  EngineEvent,
  EngineState,
  LoadCommand,
  MediaTracks,
  PlayerEngine,
} from '../engine';

/** One scripted engine event, `afterMs` after the script starts. */
export type FakeStep = { afterMs: number } & (
  | { emit: 'state'; state: EngineState }
  | { emit: 'firstFrame' }
  | { emit: 'clock'; positionMs: number; rate?: number }
  | { emit: 'tracks'; tracks: MediaTracks }
  | { emit: 'stall'; phase: 'start' | 'end' }
  | { emit: 'error'; error: EngineError }
);

/** Injected time and timers keep the fake free of real clocks (Vitest and Jest fake timers both work). */
export interface FakeEngineOptions {
  /** Scripts keyed by stream URL; an unknown URL plays the default script. */
  scripts?: Record<string, readonly FakeStep[]>;
  capabilities?: Partial<EngineCapabilities>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Emits an extrapolated `clock` anchor (rate 1 / 0) after `play` / `pause`, as real engines do; off by default. */
  anchorOnPlayPause?: boolean;
}

/** A command the fake received, recorded for assertions. */
export interface FakeCommand {
  name: string;
  attempt?: AttemptToken;
  url?: string;
  positionMs?: number;
  trackId?: string | null;
}

/** Scriptable engine for service and screen tests. */
export interface FakePlayerEngine extends PlayerEngine {
  readonly commands: readonly FakeCommand[];
  /** Medias loaded and not stopped or replaced. */
  openMedias(): number;
  /** High-water mark of simultaneously open medias; must stay 1. */
  maxConcurrentMedias(): number;
  /** Injects an event as is, including stale tokens. */
  emit(event: EngineEvent): void;
  surface(change: 'created' | 'destroyed'): void;
}

const DEFAULT_SCRIPT: readonly FakeStep[] = [
  { afterMs: 0, emit: 'state', state: 'opening' },
  { afterMs: 300, emit: 'firstFrame' },
  { afterMs: 300, emit: 'state', state: 'playing' },
];

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: true,
  softwareAudioFallback: false,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
};

/** Creates a fake engine honoring the PlayerEngine contract (token adoption, one media at a time). */
export function createFakePlayerEngine(opts: FakeEngineOptions): FakePlayerEngine {
  const commands: FakeCommand[] = [];
  const listeners = new Set<(event: EngineEvent) => void>();
  let handles: unknown[] = [];
  let token: AttemptToken = 0;
  let url: string | undefined;
  let open = 0;
  let maxOpen = 0;
  let released = false;
  let last: ClockAnchor = { positionMs: 0, atMs: opts.now(), rate: 0 };
  let failed = false;

  const note = (event: EngineEvent): void => {
    if (event.attempt !== token || url === undefined) return;
    if (event.type === 'clock') last = event.anchor;
    if (event.type === 'error') failed = true;
  };

  const deliver = (event: EngineEvent): void => {
    note(event);
    for (const listener of [...listeners]) listener(event);
  };

  const cancelScript = (): void => {
    for (const h of handles) opts.cancel(h);
    handles = [];
  };

  const adopt = (attempt: AttemptToken): void => {
    if (attempt > token) token = attempt;
  };

  const toEvent = (step: FakeStep): EngineEvent => {
    const attempt = token;
    const atMs = opts.now();
    switch (step.emit) {
      case 'state':
        return { attempt, type: 'state', state: step.state };
      case 'firstFrame':
        return { attempt, type: 'firstFrame', atMs };
      case 'clock':
        return {
          attempt,
          type: 'clock',
          anchor: { positionMs: step.positionMs, atMs, rate: step.rate ?? 1 },
        };
      case 'tracks':
        return { attempt, type: 'tracks', tracks: step.tracks };
      case 'stall':
        return { attempt, type: 'stall', phase: step.phase, atMs };
      case 'error':
        return { attempt, type: 'error', error: step.error };
    }
  };

  const runScript = (): void => {
    cancelScript();
    if (url === undefined) return;
    const steps = opts.scripts?.[url] ?? DEFAULT_SCRIPT;
    for (const step of steps) {
      handles.push(opts.schedule(() => deliver(toEvent(step)), step.afterMs));
    }
  };

  /** A paused or resumed media anchors where its latest anchor has moved to; a failed media is idle and anchors nothing. */
  const anchorNow = (rate: number): void => {
    if (url === undefined || failed || !opts.anchorOnPlayPause) return;
    const atMs = opts.now();
    const positionMs = last.positionMs + Math.max(0, atMs - last.atMs) * last.rate;
    last = { positionMs, atMs, rate };
    const anchor = last;
    handles.push(opts.schedule(() => deliver({ attempt: token, type: 'clock', anchor }), 0));
  };

  const closeMedia = (): void => {
    cancelScript();
    if (open > 0) open -= 1;
    url = undefined;
  };

  return {
    capabilities: { ...DEFAULT_CAPABILITIES, ...opts.capabilities },
    commands,
    openMedias: () => open,
    maxConcurrentMedias: () => maxOpen,
    emit: (event) => deliver(event),
    surface: (change) => deliver({ attempt: token, type: 'surface', change }),
    load(cmd: LoadCommand) {
      commands.push({ name: 'load', attempt: cmd.attempt, url: cmd.url });
      if (url !== undefined) closeMedia();
      token = cmd.attempt;
      url = cmd.url;
      last = { positionMs: cmd.startMs ?? 0, atMs: opts.now(), rate: 0 };
      failed = false;
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      runScript();
    },
    retry(attempt) {
      commands.push({ name: 'retry', attempt });
      adopt(attempt);
      failed = false;
      runScript();
    },
    recreate(attempt) {
      commands.push({ name: 'recreate', attempt });
      adopt(attempt);
      cancelScript();
    },
    play(attempt) {
      commands.push({ name: 'play', attempt });
      adopt(attempt);
      anchorNow(1);
    },
    pause(attempt) {
      commands.push({ name: 'pause', attempt });
      adopt(attempt);
      anchorNow(0);
    },
    seek(attempt, nextPos) {
      commands.push({ name: 'seek', attempt, positionMs: nextPos });
      adopt(attempt);
      last = { ...last, positionMs: nextPos, atMs: opts.now() };
    },
    selectAudioTrack(attempt, id) {
      commands.push({ name: 'selectAudioTrack', attempt, trackId: id });
      adopt(attempt);
    },
    selectSubtitleTrack(attempt, id) {
      commands.push({ name: 'selectSubtitleTrack', attempt, trackId: id });
      adopt(attempt);
    },
    stop(attempt) {
      commands.push({ name: 'stop', attempt });
      adopt(attempt);
      if (url !== undefined) closeMedia();
    },
    release() {
      released = true;
      if (url !== undefined) closeMedia();
      listeners.clear();
    },
    subscribe(listener) {
      if (!released) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
