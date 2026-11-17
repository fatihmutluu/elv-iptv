import { ok } from '@elv/domain';
import {
  createPlaybackService,
  type EngineEvent,
  type MediaKind,
  type PlaybackService,
  type PlaybackState,
  type PlayerEngine,
  type TrackInfo,
} from '@elv/playback';

const DEFAULT_ITEM_TIMEOUT_MS = 15_000;
const DEFAULT_HOLD_MS = 150;
const SEEK_TOLERANCE_MS = 5_000;

/** One item in the 29-item desktop format corpus sweep. */
export interface DesktopCorpusItem {
  id: string;
  label: string;
  kind: MediaKind;
  url: string;
  expect: 'playing' | 'failed';
  selectAudioLang?: string;
  selectSubtitleLang?: string;
  seekMs?: number;
}

/** One item that failed its expected corpus outcome. */
interface DesktopCorpusFailure {
  id: string;
  label: string;
  reason: string;
}

/** Payload printed after `ELV_GATE_CORPUS `. */
export interface DesktopCorpusReport {
  total: number;
  passed: number;
  failed: DesktopCorpusFailure[];
  surfaceCreated: number;
  staleEventsApplied: number;
}

/** Dependencies of {@link createCorpusRun}. */
export interface CorpusRunDeps {
  engine: PlayerEngine;
  base: string;
  account: string;
  burst?: number;
  now(): number;
  later(fn: () => void, ms: number): () => void;
  holdMs?: number;
  itemTimeoutMs?: number;
}

/** Handle to a desktop corpus gate run. */
export interface CorpusRun {
  readonly service: PlaybackService;
  start(): Promise<DesktopCorpusReport>;
  dispose(): void;
}

const LIVE_ENTRIES: readonly (readonly [number, string, string | null, boolean])[] = [
  [1001, 'H.264 720p25 AAC', null, false],
  [1002, 'HEVC 1080p25 8-bit', null, false],
  [1003, 'HEVC 1080p25 10-bit', null, false],
  [1004, 'MPEG-2 576i25 AC-3', null, false],
  [1005, 'H.264 576p25 MP2', null, false],
  [1006, 'AAC radio', null, false],
  [1007, 'H.264 1080i25', null, false],
  [1008, 'H.264 720p50 E-AC-3 5.1', null, false],
  [1009, 'H.264 720p29.97 MP3', null, false],
  [1010, 'Two audio tracks and subtitles', null, true],
  [1011, 'Resolution switch 720p and 1080p', null, false],
  [1012, 'Stream labelled as a web page', 'type=text/html', false],
  [1013, 'Redirect to HLS', 'redirect=hls', false],
  [1014, 'Stream labelled as a playlist', 'type=application/vnd.apple.mpegurl', false],
];

const VOD_ENTRIES: readonly (readonly [number, string, 'mp4' | 'mkv', boolean])[] = [
  [200001, 'H.264 720p25 AAC (MP4)', 'mp4', false],
  [200002, 'HEVC 1080p25 8-bit (MKV)', 'mkv', false],
  [200003, 'HEVC 1080p25 10-bit (MP4)', 'mp4', false],
  [200004, 'MPEG-2 576i25 AC-3 (MKV)', 'mkv', false],
  [200005, 'H.264 576p25 MP2 (MKV)', 'mkv', false],
  [200006, 'AAC radio (MP4)', 'mp4', false],
  [200007, 'H.264 1080i25 (MKV)', 'mkv', false],
  [200008, 'H.264 720p50 E-AC-3 5.1 (MP4)', 'mp4', false],
  [200009, 'H.264 720p29.97 MP3 (MP4)', 'mp4', false],
  [200010, 'Two audio tracks and subtitles (MP4)', 'mp4', true],
  [200011, 'Two audio tracks and subtitles (MKV)', 'mkv', true],
  [200012, 'Resolution switch 720p and 1080p (MKV)', 'mkv', false],
];

/** Builds the 29-item format corpus manifest for the desktop gate driver. */
export function buildDesktopCorpusItems(opts: {
  base: string;
  account: string;
  burst?: number;
}): DesktopCorpusItem[] {
  const { base, account, burst = 0 } = opts;
  const pair = `${account}/${account}`;
  const items: DesktopCorpusItem[] = [];

  for (const [id, label, fault, tracks] of LIVE_ENTRIES) {
    if (fault === 'redirect=hls') {
      items.push({
        id: `live-${id}`,
        label,
        kind: 'live',
        url: `${base}/${pair}/${id}`,
        expect: 'playing',
      });
      continue;
    }
    const queryParts = [
      fault !== null && burst > 0 ? fault : undefined,
      burst > 0 ? `burst=${burst}` : undefined,
    ].filter((part): part is string => part !== undefined);
    const suffix = queryParts.length === 0 ? '' : `?fault=${queryParts.join(',')}`;
    items.push({
      id: `live-${id}`,
      label,
      kind: 'live',
      url: `${base}/live/${pair}/${id}.ts${suffix}`,
      expect: 'playing',
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'live-1010-hls',
    label: 'Two audio tracks and subtitles (Live HLS WebVTT)',
    kind: 'live',
    url: `${base}/live/${pair}/1010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
  });

  for (const [id, label, ext, tracks] of VOD_ENTRIES) {
    items.push({
      id: `vod-${id}`,
      label,
      kind: 'vod',
      url: `${base}/movie/${pair}/${id}.${ext}`,
      expect: 'playing',
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'vod-200010-hls',
    label: 'Two audio tracks and subtitles (VOD HLS WebVTT)',
    kind: 'vod',
    url: `${base}/movie/${pair}/200010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
    seekMs: 30_000,
  });

  items.push({
    id: 'vod-200001-empty',
    label: 'Empty 200 VOD response',
    kind: 'vod',
    url: `${base}/movie/${pair}/200001.mp4?fault=empty`,
    expect: 'failed',
  });

  return items;
}

/** Formats the corpus report line that main prints and the gate CLI parses. */
export function corpusLine(report: DesktopCorpusReport): string {
  return `ELV_GATE_CORPUS ${JSON.stringify(report)}`;
}

function pickTrack(tracks: readonly TrackInfo[], lang: string): TrackInfo | undefined {
  const target = lang.toLowerCase();
  return tracks.find((t) => t.language?.toLowerCase().startsWith(target)) ?? tracks[0];
}

function failureReason(state: PlaybackState): string {
  if (state.status.kind === 'failed') {
    return `${state.status.error.category}/${state.status.error.code}`;
  }
  return `settled on ${state.status.kind}`;
}

/** Creates a desktop corpus gate run over `engine`. */
export function createCorpusRun(deps: CorpusRunDeps): CorpusRun {
  const {
    engine,
    base,
    account,
    burst = 0,
    now,
    later,
    holdMs = DEFAULT_HOLD_MS,
    itemTimeoutMs = DEFAULT_ITEM_TIMEOUT_MS,
  } = deps;
  let surfaceCreated = 0;
  let staleEventsApplied = 0;
  let highestAttempt = 0;
  let latestClockPos: number | undefined;
  let disposed = false;
  const cancels = new Set<() => void>();

  const tapped: PlayerEngine = {
    ...engine,
    subscribe: (listener) =>
      engine.subscribe((event: EngineEvent) => {
        if (event.type === 'surface' && event.change === 'created') {
          surfaceCreated += 1;
        } else if (event.type === 'clock' && event.attempt === service.getState().attempt) {
          latestClockPos = event.anchor.positionMs;
        }
        listener(event);
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
      const cancel = later(() => {
        cancels.delete(cancel);
        resolve();
      }, ms);
      cancels.add(cancel);
    });

  const waitFor = (accept: (s: PlaybackState) => boolean, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (disposed) return resolve(false);
      if (accept(service.getState())) return resolve(true);
      let off = (): void => undefined;
      const finish = (matched: boolean): void => {
        off();
        cancelTimer();
        cancels.delete(cancelTimer);
        resolve(matched);
      };
      const cancelTimer = later(() => finish(false), timeoutMs);
      cancels.add(cancelTimer);
      off = service.subscribe((s) => {
        if (accept(s)) finish(true);
      });
    });

  const applyItemChecks = async (item: DesktopCorpusItem): Promise<string | undefined> => {
    const state = service.getState();
    if (item.selectAudioLang !== undefined && engine.capabilities.audioTrackSelection) {
      const picked = pickTrack(state.tracks.audio, item.selectAudioLang);
      if (picked !== undefined) service.selectAudioTrack(picked.id);
    }
    if (item.selectSubtitleLang !== undefined && engine.capabilities.subtitleTrackSelection) {
      const picked = pickTrack(state.tracks.subtitles, item.selectSubtitleLang);
      if (picked !== undefined) service.selectSubtitleTrack(picked.id);
    }
    if (item.seekMs !== undefined) {
      const targetMs = item.seekMs;
      latestClockPos = undefined;
      service.seek(targetMs);
      const seeked = await waitFor(
        (s) =>
          (s.status.kind === 'playing' && (latestClockPos ?? 0) >= targetMs - SEEK_TOLERANCE_MS) ||
          s.status.kind === 'failed' ||
          s.status.kind === 'limited',
        itemTimeoutMs,
      );
      if (!seeked || service.getState().status.kind !== 'playing') {
        return `seek to ${targetMs} ms failed (${failureReason(service.getState())})`;
      }
    }
    await sleep(holdMs);
    return service.getState().status.kind === 'playing'
      ? undefined
      : failureReason(service.getState());
  };

  return {
    service,
    async start(): Promise<DesktopCorpusReport> {
      const items = buildDesktopCorpusItems({ base, account, burst });
      let passed = 0;
      const failed: DesktopCorpusFailure[] = [];

      for (const item of items) {
        if (disposed) break;
        latestClockPos = undefined;
        service.tune({
          item: item.id,
          accountKey: account,
          kind: item.kind,
          resolve: async () => ok({ url: item.url, headers: {} }),
        });

        if (item.expect === 'failed') {
          await waitFor(
            (s) =>
              s.status.kind === 'failed' ||
              s.status.kind === 'ended' ||
              s.status.kind === 'limited' ||
              (s.status.kind === 'playing' && s.firstFrameAt !== undefined),
            itemTimeoutMs,
          );
          const finalKind = service.getState().status.kind;
          if (finalKind === 'failed') {
            passed += 1;
          } else {
            failed.push({
              id: item.id,
              label: item.label,
              reason: `expected failed, settled on ${finalKind}`,
            });
          }
          continue;
        }

        const settled = await waitFor(
          (s) =>
            (s.status.kind === 'playing' && s.firstFrameAt !== undefined) ||
            s.status.kind === 'failed' ||
            s.status.kind === 'limited' ||
            s.status.kind === 'ended',
          itemTimeoutMs,
        );
        const stateAfterTune = service.getState();
        if (
          !settled ||
          stateAfterTune.status.kind !== 'playing' ||
          stateAfterTune.firstFrameAt === undefined
        ) {
          failed.push({
            id: item.id,
            label: item.label,
            reason: settled ? failureReason(stateAfterTune) : 'timeout waiting for playing',
          });
          continue;
        }

        const postError = await applyItemChecks(item);
        if (postError !== undefined) {
          failed.push({ id: item.id, label: item.label, reason: postError });
        } else {
          passed += 1;
        }
      }

      if (!disposed) {
        service.stop();
        await sleep(Math.min(25, holdMs));
      }
      return {
        total: items.length,
        passed,
        failed,
        surfaceCreated,
        staleEventsApplied,
      };
    },
    dispose() {
      disposed = true;
      offStale();
      for (const cancel of [...cancels]) cancel();
      cancels.clear();
      service.dispose();
    },
  };
}
