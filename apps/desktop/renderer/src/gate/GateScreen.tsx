import type { PlaybackState } from '@elv/playback';
import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { createDesktopEngine, type DesktopEngine } from '../player/desktop-engine.ts';
import { PlayerView } from '../player/PlayerView.tsx';
import { type CorpusRun, corpusLine, createCorpusRun } from './corpus-driver.ts';
import { createGateRun, type GateRun } from './driver.ts';
import { playerLine } from './metrics.ts';
import type { GateParams } from './params.ts';

/** Plain status codes: the gate is a development screen and carries no translated strings. */
function statusCode(status: PlaybackState['status']): string {
  switch (status.kind) {
    case 'recovering':
      return `recovering (rung ${status.rung})`;
    case 'failed':
      return `failed ${status.error.category}/${status.error.code}`;
    default:
      return status.kind;
  }
}

interface Session {
  engine: DesktopEngine;
  run: GateRun | CorpusRun;
}

function Player({ session }: { session: Session }): ReactElement {
  const { service } = session.run;
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const item = state.item === undefined ? 'none' : state.item;
  return (
    <PlayerView
      engine={session.engine}
      status={`channel ${item}: ${statusCode(state.status)}`}
      failed={state.status.kind === 'failed'}
    />
  );
}

/**
 * Development gate for playback (`?elv-gate=player&...`): zaps between simulator channels over the real mpv engine and
 * hands the single `ELV_GATE_PLAYER` line to main, which adds its own measurements and prints it. Channel keys from the
 * player window zap too. Main quits the app once it has printed the line.
 */
export function GateScreen({ params }: { params: GateParams }): ReactElement {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.elv?.player;
    if (!bridge) {
      setError('No player bridge: run inside the desktop app');
      return;
    }
    let cancelled = false;
    let current: Session | undefined;
    createDesktopEngine(bridge, () => performance.now()).then(
      (engine) => {
        if (cancelled) {
          engine.release();
          return;
        }
        const later = (fn: () => void, ms: number) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        };
        if (params.corpus === true) {
          const corpus = createCorpusRun({
            engine,
            base: params.base,
            account: params.account,
            burst: params.burst ?? 0,
            now: () => performance.now(),
            later,
          });
          current = { engine, run: corpus };
          setSession(current);
          void corpus.start().then((report) => {
            if (!cancelled) bridge.reportGate(corpusLine(report));
          });
          return;
        }
        const run = createGateRun({
          engine,
          params,
          now: () => performance.now(),
          later,
        });
        current = { engine, run };
        engine.onUi((event) => {
          if (event.type !== 'key') return;
          if (event.key === 'channel-up') run.zapBy(1);
          else if (event.key === 'channel-down') run.zapBy(-1);
        });
        setSession(current);
        void run.start().then((metrics) => {
          if (!cancelled) bridge.reportGate(playerLine(metrics));
        });
      },
      () => setError('The player could not start'),
    );
    return () => {
      cancelled = true;
      current?.run.dispose();
      current?.engine.release();
    };
  }, [params]);

  if (session === null) {
    return (
      <View style={styles.root}>
        <Text style={styles.text}>{error ?? 'Starting the player'}</Text>
      </View>
    );
  }
  return <Player session={session} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000000' },
  text: { color: '#ffffff', fontSize: 20 },
});
