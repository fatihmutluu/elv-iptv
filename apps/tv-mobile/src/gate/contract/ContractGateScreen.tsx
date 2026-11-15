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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

        const rawEngine = createEngine();
        if (rawEngine === null) {
          failed.push({ name: contractCase.name, message: 'no platform engine available' });
          continue;
        }

        let surfaceReadyResolve: (() => void) | undefined;
        const surfaceReady = new Promise<void>((resolve) => {
          surfaceReadyResolve = resolve;
        });

        let latestState: EngineState | undefined;
        let terminated = true;
        let mediaOpen = false;
        let clockSeenInPlaying = false;
        let peakConcurrent = 0;

        const offInternal = rawEngine.subscribe((event: EngineEvent) => {
          if (event.type === 'surface' && event.change === 'created') {
            surfaceReadyResolve?.();
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

        setActiveEngine(rawEngine);
        await Promise.race([surfaceReady, delay(Math.min(50, quietMs))]);

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
            await new Promise<void>((resolve) => {
              let done = false;
              let quietTimer: ReturnType<typeof setTimeout> | undefined;
              const finish = (): void => {
                if (done) return;
                done = true;
                if (quietTimer !== undefined) clearTimeout(quietTimer);
                clearTimeout(ceilingTimer);
                offSettle();
                resolve();
              };
              const canSettle = (): boolean =>
                terminated || latestState === undefined || !TRANSITIONAL_STATES.has(latestState);
              const armQuiet = (): void => {
                if (quietTimer !== undefined) clearTimeout(quietTimer);
                quietTimer = setTimeout(() => {
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
              const ceilingTimer = setTimeout(finish, maxSettleMs);
              armQuiet();
            });
            await sampleSimPeak();
          },
          maxConcurrentMedias: () => peakConcurrent,
          async dispose() {
            offInternal();
            wrappedEngine.stop(999_999);
            wrappedEngine.release();
            setActiveEngine(null);
            await delay(Math.min(100, quietMs));
          },
        };

        try {
          setStatus(contractCase.name);
          await contractCase.run(harness);
          passed += 1;
        } catch (error) {
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
