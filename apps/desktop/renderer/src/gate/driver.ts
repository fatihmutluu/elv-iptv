import {
  createPlaybackService,
  type EngineEvent,
  type PlaybackService,
  type PlaybackState,
  type PlayerEngine,
} from '@elv/playback';
import { createPlayerRecorder, type PlayerMetrics, type VodResult } from './metrics.ts';
import { type GateParams, streamUrl, vodUrl } from './params.ts';

/** Options of {@link createZapDriver}. */
export interface ZapDriverOptions {
  /** Number of channels to cycle through. */
  channels: number;
  /** Zaps after the first tune. */
  zaps: number;
  /** Zaps per second. */
  rate: number;
  /** Runs `fn` once after about `ms` milliseconds. */
  schedule: (fn: () => void, ms: number) => void;
}

/** Zaps through a channel list on a timer. */
export interface ZapDriver {
  /** Tunes channel 0 at once, then zaps; resolves after the last zap is dispatched, or when stopped. */
  start(): Promise<void>;
  /** Dispatches nothing more and resolves `start()`. */
  stop(): void;
}

/**
 * Creates a driver that dispatches the first tune (`zap` false) and then `zaps` zaps at `rate` per second, cycling
 * through the channels in order (zap `i` goes to channel `i mod channels`). Nothing is dispatched after `stop()`.
 */
export function createZapDriver(
  dispatch: (index: number, zap: boolean) => void,
  opts: ZapDriverOptions,
): ZapDriver {
  const interval = 1000 / opts.rate;
  let stopped = false;
  let finish: (() => void) | undefined;
  return {
    start() {
      return new Promise<void>((resolve) => {
        finish = resolve;
        let zap = 0;
        dispatch(0, false);
        const step = (): void => {
          if (stopped) return;
          zap += 1;
          dispatch(zap % opts.channels, true);
          if (zap >= opts.zaps) {
            stopped = true;
            resolve();
            return;
          }
          opts.schedule(step, interval);
        };
        opts.schedule(step, interval);
      });
    },
    stop() {
      stopped = true;
      finish?.();
    },
  };
}

/** The run ends this long after its last zap if that tune neither shows a frame nor fails nor hits a limit. */
const SETTLE_TIMEOUT_MS = 15_000;
/** The VOD part waits this long for `playing`, and again for the seek to land. */
const VOD_STEP_TIMEOUT_MS = 15_000;
const VOD_PAUSE_MS = 1000;
const VOD_SEEK_MS = 60_000;
/** A seek lands when playing resumes with the anchor within this much of the target. */
const SEEK_TOLERANCE_MS = 1000;

/** What {@link createGateRun} needs. */
export interface GateRunDeps {
  engine: PlayerEngine;
  params: GateParams;
  now(): number;
  /** Runs `fn` once after about `ms` milliseconds and returns the function that cancels it. */
  later(fn: () => void, ms: number): () => void;
}

/** One gate run: the playback service over the engine, the zap driver and the metrics. */
export interface GateRun {
  readonly service: PlaybackService;
  /** Runs the whole gate and resolves once with the run's metrics (also after `stop()`). */
  start(): Promise<PlayerMetrics>;
  /** Tunes the channel `delta` away from the current one; counts as a zap (remote channel keys). */
  zapBy(delta: number): void;
  /** Dispatches nothing more and ends the run with what was measured. */
  stop(): void;
  /** Stops the run and disposes the service; the engine is the caller's to release. */
  dispose(): void;
}

const isSettled = (state: PlaybackState): boolean =>
  state.firstFrameAt !== undefined ||
  state.status.kind === 'failed' ||
  state.status.kind === 'limited' ||
  state.status.kind === 'ended';

/**
 * Builds a gate run over `engine`: zaps the channels as the driver does, waits for the last tune to settle, then runs
 * the VOD part when `params.vod` is set (tune, wait playing, pause 1 s, play, seek to 60 s, wait playing at the new
 * position). The recorder sees only the live part, so the VOD tune is neither a warm tune nor a stale event.
 */
export function createGateRun(deps: GateRunDeps): GateRun {
  const { engine, params, now, later } = deps;
  const recorder = createPlayerRecorder({
    fault: params.fault,
    faultItem: params.channels[0] ?? '',
  });
  const tapped: PlayerEngine = {
    ...engine,
    subscribe: (listener) =>
      engine.subscribe((event: EngineEvent) => {
        if (event.type === 'surface') recorder.surface(event.change);
        else if (event.type === 'error') recorder.engineError(event.error.code);
        else if (event.type === 'stall' && event.attempt === service.getState().attempt)
          recorder.stall(event.phase);
        listener(event);
      }),
  };
  const service = createPlaybackService({
    engine: tapped,
    clock: { now },
    timers: {
      setTimeout: (fn, ms) => later(fn, ms),
      clearTimeout: (handle) => (handle as () => void)(),
    },
  });
  const cancels = new Set<() => void>();
  const stopListeners = new Set<() => void>();
  let stopped = false;
  let index = 0;
  let driver: ZapDriver | undefined;

  const schedule = (fn: () => void, ms: number): void => {
    const cancel = later(() => {
      cancels.delete(cancel);
      if (!stopped) fn();
    }, ms);
    cancels.add(cancel);
  };

  const waitFor = (
    accept: (state: PlaybackState) => boolean,
    timeoutMs: number,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      if (stopped) return resolve(false);
      if (accept(service.getState())) return resolve(true);
      let off = (): void => undefined;
      const finish = (ok: boolean): void => {
        off();
        stopListeners.delete(onStop);
        cancelTimer();
        resolve(ok);
      };
      const onStop = (): void => finish(false);
      const cancelTimer = later(() => finish(false), timeoutMs);
      stopListeners.add(onStop);
      off = service.subscribe((state) => {
        if (accept(state)) finish(true);
      });
    });

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const cancel = later(resolve, ms);
      stopListeners.add(() => {
        cancel();
        resolve();
      });
    });

  const tuneTo = (next: number, zapAt?: number): void => {
    const count = params.channels.length;
    const wrapped = ((next % count) + count) % count;
    index = wrapped;
    const item = params.channels[wrapped] ?? '';
    recorder.dispatch(item, zapAt);
    service.tune({
      item,
      accountKey: params.account,
      kind: 'live',
      resolve: async () => ({ ok: true, value: { url: streamUrl(params, wrapped), headers: {} } }),
    });
  };

  const runVod = async (): Promise<VodResult> => {
    service.tune({
      item: params.vod ?? '',
      accountKey: params.account,
      kind: 'vod',
      resolve: async () => ({ ok: true, value: { url: vodUrl(params), headers: {} } }),
    });
    const playing = await waitFor((s) => s.status.kind === 'playing', VOD_STEP_TIMEOUT_MS);
    if (!playing) return { playing: false, seeked: false };
    service.pause();
    await sleep(VOD_PAUSE_MS);
    service.play();
    service.seek(VOD_SEEK_MS);
    const seeked = await waitFor(
      (s) =>
        s.status.kind === 'playing' &&
        (s.anchor?.positionMs ?? 0) >= VOD_SEEK_MS - SEEK_TOLERANCE_MS,
      VOD_STEP_TIMEOUT_MS,
    );
    return { playing: true, seeked };
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    driver?.stop();
    for (const cancel of [...cancels]) cancel();
    cancels.clear();
    for (const listener of [...stopListeners]) listener();
    stopListeners.clear();
  };

  return {
    service,
    zapBy(delta) {
      if (!stopped) tuneTo(index + delta, now());
    },
    stop,
    dispose() {
      stop();
      service.dispose();
    },
    async start() {
      const offRecorder = service.subscribe((state) => recorder.observe(state));
      driver = createZapDriver((next, zap) => tuneTo(next, zap ? now() : undefined), {
        channels: params.channels.length,
        zaps: params.zaps,
        rate: params.rate,
        schedule,
      });
      await driver.start();
      await waitFor(isSettled, SETTLE_TIMEOUT_MS);
      const final = service.getState();
      offRecorder();
      const vod = params.vod === null || stopped ? undefined : await runVod();
      return recorder.finish(final, vod);
    },
  };
}
