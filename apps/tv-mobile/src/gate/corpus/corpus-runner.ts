import { ok, sameLanguageCode } from '@elv/domain';
import {
  type ClockAnchor,
  createPlaybackService,
  type EngineEvent,
  type PlaybackService,
  type PlaybackState,
  type PlayerEngine,
  positionAt,
  type TrackInfo,
} from '@elv/playback';
import {
  buildCorpusItems,
  type CorpusFailure,
  type CorpusGateParams,
  type CorpusItem,
  type CorpusReport,
} from './corpus-items';

/** A seek lands when a clock anchor of the attempt sits within this much of the target, either side. */
const SEEK_TOLERANCE_MS = 5_000;

/** Dependencies of {@link createCorpusSweep}. */
export interface CorpusSweepDeps {
  engine: PlayerEngine;
  params: CorpusGateParams;
  now(): number;
  later(fn: () => void, ms: number): () => void;
  holdMs: number;
  itemTimeoutMs: number;
  onItem?(item: CorpusItem): void;
}

/** Handle to an in-flight corpus sweep over one `PlayerEngine`. */
export interface CorpusSweep {
  readonly service: PlaybackService;
  /** Runs the 29-item sweep; resolves to `undefined` when disposed mid-run. */
  start(): Promise<CorpusReport | undefined>;
  /** Resolves pending waits/sleeps, unsubscribes listeners and disposes the service; caller releases `engine`. */
  dispose(): void;
}

type TrackKind = 'audio' | 'subtitle';

function pickTrack(tracks: readonly TrackInfo[], lang: string): TrackInfo | undefined {
  return tracks.find((t) => sameLanguageCode(t.language, lang));
}

const listOf = (s: PlaybackState, kind: TrackKind): readonly TrackInfo[] =>
  kind === 'audio' ? s.tracks.audio : s.tracks.subtitles;

const selectedOf = (s: PlaybackState, kind: TrackKind): string | null =>
  kind === 'audio' ? s.tracks.selectedAudioId : s.tracks.selectedSubtitleId;

const isTerminal = (s: PlaybackState): boolean =>
  s.status.kind === 'failed' || s.status.kind === 'limited' || s.status.kind === 'ended';

function failureReason(state: PlaybackState): string {
  if (state.status.kind === 'failed') {
    return `${state.status.error.category}/${state.status.error.code}`;
  }
  return `settled on ${state.status.kind}`;
}

/** Creates a 29-item corpus sweep over `engine` for `CorpusGateScreen`. */
export function createCorpusSweep(deps: CorpusSweepDeps): CorpusSweep {
  const { engine, params, now, later, holdMs, itemTimeoutMs, onItem } = deps;
  let surfaceCreated = 0;
  let staleEventsApplied = 0;
  let highestAttempt = 0;
  let latestClock: ClockAnchor | undefined;
  let disposed = false;
  const stopListeners = new Set<() => void>();
  const wakers = new Set<() => void>();

  const tapped: PlayerEngine = {
    ...engine,
    subscribe: (listener) =>
      engine.subscribe((event: EngineEvent) => {
        if (event.type === 'surface' && event.change === 'created') {
          surfaceCreated += 1;
        } else if (event.type === 'clock' && event.attempt === service.getState().attempt) {
          latestClock = event.anchor;
        }
        listener(event);
        for (const wake of [...wakers]) wake();
      }),
  };

  const service = createPlaybackService({
    engine: tapped,
    clock: { now },
    timers: {
      setTimeout: (fn, ms) => later(fn, ms),
      clearTimeout: (h) => (h as () => void)(),
    },
    config: {
      liveStartTimeoutMs: itemTimeoutMs,
      startTimeoutMs: itemTimeoutMs,
      vodReconnectWindowMs: 0,
      limitBackoffMs: [],
      limitTotalMs: 0,
    },
  });

  const offStale = service.subscribe((s) => {
    if (s.attempt < highestAttempt) staleEventsApplied += 1;
    else highestAttempt = s.attempt;
  });

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (disposed) return resolve();
      let cancel: (() => void) | undefined;
      const finish = (): void => {
        stopListeners.delete(finish);
        cancel?.();
        resolve();
      };
      stopListeners.add(finish);
      cancel = later(finish, ms);
    });

  const waitFor = (accept: (s: PlaybackState) => boolean, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (disposed) return resolve(false);
      if (accept(service.getState())) return resolve(true);
      let done = false;
      let off: (() => void) | undefined;
      let cancelTimer: (() => void) | undefined;
      const finish = (matched: boolean): void => {
        if (done) return;
        done = true;
        off?.();
        wakers.delete(check);
        stopListeners.delete(onStop);
        cancelTimer?.();
        resolve(matched);
      };
      const check = (): void => {
        if (accept(service.getState())) finish(true);
      };
      const onStop = (): void => finish(false);
      stopListeners.add(onStop);
      wakers.add(check);
      off = service.subscribe(check);
      cancelTimer = later(() => finish(false), timeoutMs);
    });

  const selectTrack = async (kind: TrackKind, lang: string): Promise<string | undefined> => {
    const capable =
      kind === 'audio'
        ? engine.capabilities.audioTrackSelection
        : engine.capabilities.subtitleTrackSelection;
    if (!capable) return `${kind} track selection unsupported`;
    await waitFor(
      (s) => pickTrack(listOf(s, kind), lang) !== undefined || isTerminal(s),
      itemTimeoutMs,
    );
    if (disposed) return undefined;
    const state = service.getState();
    if (isTerminal(state)) return failureReason(state);
    if (listOf(state, kind).length === 0) return `no ${kind} tracks`;
    const picked = pickTrack(listOf(state, kind), lang);
    if (picked === undefined) return `no ${kind} track for ${lang}`;
    if (kind === 'audio') service.selectAudioTrack(picked.id);
    else service.selectSubtitleTrack(picked.id);
    await waitFor((s) => selectedOf(s, kind) === picked.id || isTerminal(s), itemTimeoutMs);
    if (disposed) return undefined;
    const after = service.getState();
    if (isTerminal(after)) return failureReason(after);
    return selectedOf(after, kind) === picked.id
      ? undefined
      : `${kind} track ${picked.id} not selected`;
  };

  const readClock = (): ClockAnchor | undefined => latestClock;

  const seekTo = async (targetMs: number): Promise<string | undefined> => {
    latestClock = undefined;
    service.seek(targetMs);
    const landed = (): boolean => {
      const clock = readClock();
      return (
        clock !== undefined &&
        clock.rate > 0 &&
        Math.abs(clock.positionMs - targetMs) <= SEEK_TOLERANCE_MS
      );
    };
    await waitFor((s) => (s.status.kind === 'playing' && landed()) || isTerminal(s), itemTimeoutMs);
    if (disposed) return undefined;
    const state = service.getState();
    if (state.status.kind !== 'playing') {
      return `seek to ${targetMs} ms failed (${failureReason(state)})`;
    }
    if (!landed()) {
      const clock = readClock();
      const at = clock === undefined ? 'none' : `${clock.positionMs} ms, rate ${clock.rate}`;
      return `seek to ${targetMs} ms not confirmed (clock at ${at})`;
    }
    return undefined;
  };

  const applyItemChecks = async (item: CorpusItem): Promise<string | undefined> => {
    await waitFor((s) => latestClock !== undefined || isTerminal(s), itemTimeoutMs);
    if (disposed) return undefined;
    if (isTerminal(service.getState())) return failureReason(service.getState());
    if (latestClock === undefined) return 'no clock anchor';
    if (item.selectAudioLang !== undefined) {
      const error = await selectTrack('audio', item.selectAudioLang);
      if (error !== undefined || disposed) return error;
    }
    if (item.selectSubtitleLang !== undefined) {
      const error = await selectTrack('subtitle', item.selectSubtitleLang);
      if (error !== undefined || disposed) return error;
    }
    if (item.seekMs !== undefined) {
      const error = await seekTo(item.seekMs);
      if (error !== undefined || disposed) return error;
    }
    const before = latestClock === undefined ? undefined : positionAt(latestClock, now());
    await sleep(holdMs);
    if (disposed) return undefined;
    const state = service.getState();
    if (state.status.kind !== 'playing') return failureReason(state);
    const advanced =
      before !== undefined &&
      latestClock !== undefined &&
      latestClock.rate > 0 &&
      positionAt(latestClock, now()) > before;
    return advanced ? undefined : 'clock not advancing';
  };

  const runItem = async (item: CorpusItem): Promise<string | undefined> => {
    latestClock = undefined;
    service.tune({
      item: item.id,
      accountKey: params.account,
      kind: item.kind,
      resolve: async () => ok({ url: item.url, headers: {} }),
    });

    if (item.expect === 'failed') {
      await waitFor(
        (s) => isTerminal(s) || (s.status.kind === 'playing' && s.firstFrameAt !== undefined),
        itemTimeoutMs,
      );
      if (disposed) return undefined;
      const state = service.getState();
      if (state.status.kind !== 'failed') return `expected failed, settled on ${state.status.kind}`;
      const reason = failureReason(state);
      if (item.expectErrors !== undefined && !item.expectErrors.includes(reason)) {
        return `expected ${item.expectErrors.join(' or ')}, got ${reason}`;
      }
      return undefined;
    }

    const settled = await waitFor(
      (s) =>
        (s.status.kind === 'playing' &&
          (item.audioOnly === true || s.firstFrameAt !== undefined)) ||
        isTerminal(s),
      itemTimeoutMs,
    );
    if (disposed) return undefined;
    const state = service.getState();
    if (
      !settled ||
      state.status.kind !== 'playing' ||
      (item.audioOnly !== true && state.firstFrameAt === undefined)
    ) {
      return settled ? failureReason(state) : 'timeout waiting for playing';
    }
    return applyItemChecks(item);
  };

  return {
    service,
    async start(): Promise<CorpusReport | undefined> {
      const items = buildCorpusItems({
        base: `http://${params.host}`,
        account: params.account,
        burst: params.burst,
      });
      await sleep(Math.min(25, holdMs));
      if (disposed) return undefined;

      let passed = 0;
      const failed: CorpusFailure[] = [];
      for (const item of items) {
        if (disposed) return undefined;
        onItem?.(item);
        const reason = await runItem(item);
        if (disposed) return undefined;
        if (reason === undefined) passed += 1;
        else failed.push({ id: item.id, label: item.label, reason });
      }

      service.stop();
      await sleep(Math.min(25, holdMs));
      if (disposed) return undefined;
      return {
        total: items.length,
        passed,
        failed,
        surfaceCreated,
        staleEventsApplied,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offStale();
      for (const stop of [...stopListeners]) stop();
      stopListeners.clear();
      wakers.clear();
      service.dispose();
    },
  };
}
