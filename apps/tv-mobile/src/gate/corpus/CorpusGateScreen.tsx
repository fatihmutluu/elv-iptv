import { ok } from '@elv/domain';
import {
  createPlaybackService,
  type EngineEvent,
  type PlaybackService,
  type PlaybackState,
  type PlayerEngine,
  type TrackInfo,
} from '@elv/playback';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { PlayerSurface } from '../../playback/PlayerSurface';
import { createPlatformEngine } from '../../playback/platform-engine';
import {
  buildCorpusItems,
  type CorpusFailure,
  type CorpusGateParams,
  type CorpusItem,
  type CorpusReport,
} from './corpus-items';

const DEFAULT_ITEM_TIMEOUT_MS = 15_000;
const DEFAULT_HOLD_MS = 150;
const SEEK_TOLERANCE_MS = 5_000;

/** Props of {@link CorpusGateScreen}. */
export interface CorpusGateScreenProps {
  params: CorpusGateParams;
  createEngine?: () => PlayerEngine | null;
  holdMs?: number;
  itemTimeoutMs?: number;
}

function printCorpus(line: string): void {
  // biome-ignore lint/suspicious/noConsole: read by the corpus gate runner from device/simulator logs
  if (Platform.OS === 'ios') console.error(line);
  // biome-ignore lint/suspicious/noConsole: read by the corpus gate runner from device/simulator logs
  else console.log(line);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Sweeps all 29 items of the simulator's `corpus` profile sequentially over one `PlayerEngine` and
 * `PlayerSurface`, then prints one `ELV_GATE_CORPUS {json}` line.
 */
export function CorpusGateScreen({
  params,
  createEngine = createPlatformEngine,
  holdMs = DEFAULT_HOLD_MS,
  itemTimeoutMs = DEFAULT_ITEM_TIMEOUT_MS,
}: CorpusGateScreenProps): ReactElement {
  const [activeEngine, setActiveEngine] = useState<PlayerEngine | null>(null);
  const [status, setStatus] = useState('starting');

  useEffect(() => {
    let cancelled = false;
    let rawEngine: PlayerEngine | null = null;
    let service: PlaybackService | undefined;

    const runSweep = async (): Promise<void> => {
      rawEngine = createEngine();
      const items = buildCorpusItems({
        base: `http://${params.host}`,
        account: params.account,
        burst: params.burst,
      });
      if (rawEngine === null) {
        const report: CorpusReport = {
          total: items.length,
          passed: 0,
          failed: [{ id: 'engine', label: 'PlatformEngine', reason: 'no platform engine' }],
          surfaceCreated: 0,
          staleEventsApplied: 0,
        };
        printCorpus(`ELV_GATE_CORPUS ${JSON.stringify(report)}`);
        return;
      }

      let surfaceCreated = 0;
      let staleEventsApplied = 0;
      let highestAttempt = 0;
      let latestClockPos: number | undefined;

      const engine = rawEngine;
      const tapped: PlayerEngine = {
        ...engine,
        subscribe: (listener) =>
          engine.subscribe((event: EngineEvent) => {
            if (event.type === 'surface' && event.change === 'created') {
              surfaceCreated += 1;
            } else if (event.type === 'clock' && event.attempt === service?.getState().attempt) {
              latestClockPos = event.anchor.positionMs;
            }
            listener(event);
          }),
      };

      service = createPlaybackService({
        engine: tapped,
        clock: { now: () => performance.now() },
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
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

      setActiveEngine(engine);
      await delay(Math.min(25, holdMs));

      const waitFor = (
        accept: (s: PlaybackState) => boolean,
        timeoutMs: number,
      ): Promise<boolean> =>
        new Promise((resolve) => {
          if (cancelled || service === undefined) return resolve(false);
          if (accept(service.getState())) return resolve(true);
          let off = (): void => undefined;
          const finish = (matched: boolean): void => {
            off();
            clearTimeout(timer);
            resolve(matched);
          };
          const timer = setTimeout(() => finish(false), timeoutMs);
          off = service.subscribe((s) => {
            if (accept(s)) finish(true);
          });
        });

      const applyItemChecks = async (item: CorpusItem): Promise<string | undefined> => {
        if (service === undefined) return 'disposed';
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
              (s.status.kind === 'playing' &&
                (latestClockPos ?? 0) >= targetMs - SEEK_TOLERANCE_MS) ||
              s.status.kind === 'failed' ||
              s.status.kind === 'limited',
            itemTimeoutMs,
          );
          if (!seeked || service.getState().status.kind !== 'playing') {
            return `seek to ${targetMs} ms failed (${failureReason(service.getState())})`;
          }
        }
        await delay(holdMs);
        return service.getState().status.kind === 'playing'
          ? undefined
          : failureReason(service.getState());
      };

      let passed = 0;
      const failed: CorpusFailure[] = [];

      for (const item of items) {
        if (cancelled) return;
        setStatus(`${item.id}: ${item.label}`);
        latestClockPos = undefined;
        service.tune({
          item: item.id,
          accountKey: params.account,
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
            (s.status.kind === 'playing' &&
              (item.audioOnly === true || s.firstFrameAt !== undefined)) ||
            s.status.kind === 'failed' ||
            s.status.kind === 'limited' ||
            s.status.kind === 'ended',
          itemTimeoutMs,
        );
        const stateAfterTune = service.getState();
        if (
          !settled ||
          stateAfterTune.status.kind !== 'playing' ||
          (item.audioOnly !== true && stateAfterTune.firstFrameAt === undefined)
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

      if (cancelled) return;
      offStale();
      service.stop();
      await delay(Math.min(25, holdMs));
      const report: CorpusReport = {
        total: items.length,
        passed,
        failed,
        surfaceCreated,
        staleEventsApplied,
      };
      setStatus(`done (${passed}/${items.length})`);
      printCorpus(`ELV_GATE_CORPUS ${JSON.stringify(report)}`);
    };

    void runSweep();
    return () => {
      cancelled = true;
      service?.dispose();
      rawEngine?.release();
    };
  }, [params, createEngine, holdMs, itemTimeoutMs]);

  return (
    <View style={styles.root}>
      {activeEngine !== null && (
        <PlayerSurface
          engine={activeEngine}
          style={StyleSheet.absoluteFill}
          testID="corpus-surface"
        />
      )}
      <Text style={styles.label} testID="corpus-status">
        {status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  label: { position: 'absolute', left: 48, bottom: 32, color: '#ffffff', fontSize: 24 },
});
