import type { EngineEvent, EngineState, LoadCommand, PlayerEngine } from '@elv/playback';
import { ENGINE_CONTRACT_CASES, type EngineContractHarness } from '@elv/playback/testing';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { PlayerSurface } from '../../playback/PlayerSurface';
import { createPlatformEngine } from '../../playback/platform-engine';
import type { ContractGateParams } from './contract-routes';
import { maxOpenMedias, type SimMediaEntry } from './sim-medias';

const DEFAULT_QUIET_MS = 1_000;
const DEFAULT_MAX_SETTLE_MS = 12_000;
const TRANSITIONAL_STATES: ReadonlySet<EngineState> = new Set(['opening', 'buffering', 'ready']);

type FetchLike = (
  url: string,
  init?: { method?: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Props of {@link ContractGateScreen}. */
export interface ContractGateScreenProps {
  params: ContractGateParams;
  createEngine?: () => PlayerEngine | null;
  fetchImpl?: FetchLike;
  quietMs?: number;
  maxSettleMs?: number;
}

function printContract(line: string): void {
  // biome-ignore lint/suspicious/noConsole: read by the contract gate runner from device/simulator logs
  if (Platform.OS === 'ios') console.error(line);
  // biome-ignore lint/suspicious/noConsole: read by the contract gate runner from device/simulator logs
  else console.log(line);
}

/**
 * Runs every shared `ENGINE_CONTRACT_CASES` case against a fresh `PlayerEngine` rendered through
 * `PlayerSurface` against the stream simulator, then prints one `ELV_GATE_CONTRACT {json}` line.
 */
export function ContractGateScreen({
  params,
  createEngine = createPlatformEngine,
  fetchImpl = fetch as FetchLike,
  quietMs = DEFAULT_QUIET_MS,
  maxSettleMs = DEFAULT_MAX_SETTLE_MS,
}: ContractGateScreenProps): ReactElement {
  const [activeEngine, setActiveEngine] = useState<PlayerEngine | null>(null);
  const [status, setStatus] = useState('running');

  useEffect(() => {
    let cancelled = false;
    let currentCleanup: (() => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stopListeners = new Set<() => void>();

    const schedule = (fn: () => void, ms: number): (() => void) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
      return () => {
        timers.delete(id);
        clearTimeout(id);
      };
    };

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (cancelled) return resolve();
        let cancel: (() => void) | undefined;
        const finish = (): void => {
          stopListeners.delete(finish);
          cancel?.();
          resolve();
        };
        stopListeners.add(finish);
        cancel = schedule(finish, ms);
      });

    const runAll = async (): Promise<void> => {
      let passed = 0;
      const failed: { name: string; message: string }[] = [];
      const { host, account } = params;
      const simRequestsUrl = `http://${host}/_sim/requests`;
      const urls = {
        plays: `http://${host}/live/${account}/${account}/1001.ts`,
        playsToo: `http://${host}/live/${account}/${account}/1002.ts`,
        notFound: `http://${host}/live/${account}/${account}/1003.ts?fault=status=404`,
      };

      for (const contractCase of ENGINE_CONTRACT_CASES) {
        if (cancelled) return;
        await fetchImpl(simRequestsUrl, { method: 'DELETE' }).catch(() => undefined);
        if (cancelled) return;

        const rawEngine = createEngine();
        if (rawEngine === null) {
          failed.push({ name: contractCase.name, message: 'no platform engine available' });
          continue;
        }

        let surfaceCreated = false;
        let wakeSurface: (() => void) | undefined;
        let latestState: EngineState | undefined;
        let terminated = true;
        let mediaOpen = false;
        let clockSeenInPlaying = false;
        let peakConcurrent = 0;

        const offInternal = rawEngine.subscribe((event: EngineEvent) => {
          if (event.type === 'surface' && event.change === 'created') {
            surfaceCreated = true;
            wakeSurface?.();
            return;
          }
          if (event.type === 'state') {
            latestState = event.state;
            if (event.state !== 'playing') clockSeenInPlaying = false;
            if (event.state === 'ended') {
              terminated = true;
              mediaOpen = false;
            }
          } else if (event.type === 'error') {
            terminated = true;
            mediaOpen = false;
          }
        });

        const wrappedEngine: PlayerEngine = {
          capabilities: rawEngine.capabilities,
          load(cmd: LoadCommand) {
            latestState = 'opening';
            terminated = false;
            mediaOpen = !cmd.url.includes('status=404');
            clockSeenInPlaying = false;
            rawEngine.load(cmd);
          },
          retry: (attempt) => rawEngine.retry(attempt),
          play: (attempt) => rawEngine.play(attempt),
          pause: (attempt) => rawEngine.pause(attempt),
          seek: (attempt, pos) => rawEngine.seek(attempt, pos),
          stop(attempt) {
            terminated = true;
            mediaOpen = false;
            rawEngine.stop(attempt);
          },
          recreate(attempt) {
            terminated = true;
            mediaOpen = false;
            rawEngine.recreate(attempt);
          },
          release() {
            terminated = true;
            mediaOpen = false;
            rawEngine.release();
          },
          subscribe: (listener) => rawEngine.subscribe(listener),
        };

        let released = false;
        const releaseCurrent = (): void => {
          if (released) return;
          released = true;
          currentCleanup = undefined;
          offInternal();
          wrappedEngine.stop(999_999);
          wrappedEngine.release();
        };
        currentCleanup = releaseCurrent;

        setActiveEngine(rawEngine);
        await new Promise<void>((resolve) => {
          if (cancelled || surfaceCreated) return resolve();
          let cancel: (() => void) | undefined;
          const finish = (): void => {
            wakeSurface = undefined;
            stopListeners.delete(finish);
            cancel?.();
            resolve();
          };
          wakeSurface = finish;
          stopListeners.add(finish);
          cancel = schedule(finish, Math.min(50, quietMs));
        });
        if (cancelled) {
          releaseCurrent();
          return;
        }

        const sampleSimPeak = async (): Promise<void> => {
          try {
            const res = await fetchImpl(simRequestsUrl);
            if (!res.ok) return;
            const json = await res.json();
            if (!Array.isArray(json)) return;
            const loggedPeak = maxOpenMedias(json as SimMediaEntry[], account);
            peakConcurrent = Math.max(peakConcurrent, loggedPeak, mediaOpen ? 1 : 0);
          } catch {
            if (mediaOpen) peakConcurrent = Math.max(peakConcurrent, 1);
          }
        };

        const harness: EngineContractHarness = {
          engine: wrappedEngine,
          urls,
          async settle() {
            if (cancelled) return;
            await new Promise<void>((resolve) => {
              let done = false;
              let cancelQuiet: (() => void) | undefined;
              let cancelCeiling: (() => void) | undefined;
              const finish = (): void => {
                if (done) return;
                done = true;
                cancelQuiet?.();
                cancelCeiling?.();
                stopListeners.delete(finish);
                offSettle();
                resolve();
              };
              const canSettle = (): boolean =>
                terminated || latestState === undefined || !TRANSITIONAL_STATES.has(latestState);
              const armQuiet = (): void => {
                cancelQuiet?.();
                cancelQuiet = schedule(() => {
                  if (canSettle()) finish();
                }, quietMs);
              };
              const offSettle = rawEngine.subscribe((event: EngineEvent) => {
                if (event.type === 'clock' && latestState === 'playing') {
                  if (clockSeenInPlaying) return;
                  clockSeenInPlaying = true;
                }
                armQuiet();
              });
              stopListeners.add(finish);
              cancelCeiling = schedule(finish, maxSettleMs);
              armQuiet();
            });
            if (!cancelled) await sampleSimPeak();
          },
          maxConcurrentMedias: () => peakConcurrent,
          async dispose() {
            releaseCurrent();
            if (!cancelled) {
              setActiveEngine(null);
              await sleep(Math.min(100, quietMs));
            }
          },
        };

        try {
          if (!cancelled) setStatus(contractCase.name);
          await contractCase.run(harness);
          if (cancelled) return;
          passed += 1;
        } catch (error) {
          if (cancelled) return;
          failed.push({
            name: contractCase.name,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          await harness.dispose();
        }
      }

      if (cancelled) return;
      setStatus(`done (${passed}/${passed + failed.length})`);
      printContract(`ELV_GATE_CONTRACT ${JSON.stringify({ passed, failed })}`);
    };

    void runAll();
    return () => {
      cancelled = true;
      for (const stop of [...stopListeners]) stop();
      stopListeners.clear();
      currentCleanup?.();
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
  }, [params, createEngine, fetchImpl, quietMs, maxSettleMs]);

  return (
    <View style={styles.root}>
      {activeEngine !== null && (
        <PlayerSurface
          engine={activeEngine}
          style={StyleSheet.absoluteFill}
          testID="contract-surface"
        />
      )}
      <Text style={styles.label} testID="contract-status">
        {status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  label: { position: 'absolute', left: 48, bottom: 32, color: '#ffffff', fontSize: 24 },
});
