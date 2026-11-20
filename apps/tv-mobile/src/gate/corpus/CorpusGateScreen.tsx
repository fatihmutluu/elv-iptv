import type { PlayerEngine } from '@elv/playback';
import { type ReactElement, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { PlayerSurface } from '../../playback/PlayerSurface';
import { createPlatformEngine } from '../../playback/platform-engine';
import { buildCorpusItems, type CorpusGateParams, type CorpusReport } from './corpus-items';
import { type CorpusSweep, createCorpusSweep } from './corpus-runner';

const DEFAULT_ITEM_TIMEOUT_MS = 15_000;
const DEFAULT_HOLD_MS = 150;

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
    let sweep: CorpusSweep | undefined;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    const later = (fn: () => void, ms: number): (() => void) => {
      const id = setTimeout(() => {
        pendingTimers.delete(id);
        fn();
      }, ms);
      pendingTimers.add(id);
      return () => {
        pendingTimers.delete(id);
        clearTimeout(id);
      };
    };

    const runSweep = async (): Promise<void> => {
      rawEngine = createEngine();
      if (rawEngine === null) {
        if (cancelled) return;
        const items = buildCorpusItems({
          base: `http://${params.host}`,
          account: params.account,
          burst: params.burst,
        });
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

      sweep = createCorpusSweep({
        engine: rawEngine,
        params,
        now: () => performance.now(),
        later,
        holdMs,
        itemTimeoutMs,
        onItem: (item) => {
          if (!cancelled) setStatus(`${item.id}: ${item.label}`);
        },
      });
      setActiveEngine(rawEngine);
      const report = await sweep.start();
      if (cancelled || report === undefined) return;
      setStatus(`done (${report.passed}/${report.total})`);
      printCorpus(`ELV_GATE_CORPUS ${JSON.stringify(report)}`);
    };

    void runSweep();
    return () => {
      cancelled = true;
      sweep?.dispose();
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.clear();
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
