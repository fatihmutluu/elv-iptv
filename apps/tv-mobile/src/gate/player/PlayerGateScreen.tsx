import { createKeyInterpreter, type KeyInput } from '@elv/focus-core';
import {
  createPlaybackService,
  type PlaybackService,
  type PlaybackState,
  type PlayerEngine,
  positionAt,
} from '@elv/playback';
import { useTvKeySource } from '@elv/ui-kit';
import {
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { PlayerSurface } from '../../playback/PlayerSurface';
import { createPlatformEngine } from '../../playback/platform-engine';
import { createZapDriver } from './player-driver';
import { createPlayerRecorder, playerLine } from './player-metrics';
import { type PlayerGateParams, streamUrl } from './player-routes';

/** The run ends this long after its last zap if that tune neither shows a frame nor fails nor hits a limit. */
const SETTLE_TIMEOUT_MS = 15_000;

/** Props of {@link PlayerGateScreen}. */
export interface PlayerGateScreenProps {
  params: PlayerGateParams;
  /** Creates the engine; the platform engine by default, a fake in tests. Returns null where none exists. */
  createEngine?: () => PlayerEngine | null;
}

const clock = { now: () => performance.now() };
const timers = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One line of OSD text for a service status. */
function statusText(status: PlaybackState['status']): string {
  switch (status.kind) {
    case 'recovering':
      return `recovering (rung ${status.rung})`;
    case 'failed':
      return `error: ${status.error.category}/${status.error.code}`;
    default:
      return status.kind;
  }
}

function formatPosition(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** Reads `positionAt` of the service's anchor in its own animation frame and re-renders only when the text changes. */
function OsdClock({ service }: { service: PlaybackService }): ReactElement {
  const [text, setText] = useState('--:--');
  useEffect(() => {
    let frame = 0;
    const tick = (): void => {
      const { anchor } = service.getState();
      setText(
        anchor === undefined ? '--:--' : formatPosition(positionAt(anchor, performance.now())),
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [service]);
  return (
    <Text style={styles.clock} testID="osd-clock">
      {text}
    </Text>
  );
}

/**
 * The on-screen display over the video: channel, status line and clock. It is mounted once and never unmounted by a
 * zap; the service state changes its text.
 */
const Osd = memo(function Osd({ service }: { service: PlaybackService }): ReactElement {
  const state = useSyncExternalStore(service.subscribe, service.getState);
  return (
    <View style={styles.osd} testID="player-osd" pointerEvents="none">
      <Text style={styles.channel} testID="osd-channel">
        {state.item === undefined ? 'No channel' : `Channel ${state.item}`}
      </Text>
      <Text style={styles.status} testID="osd-status">
        {statusText(state.status)}
      </Text>
      <OsdClock service={service} />
    </View>
  );
});

function print(line: string): void {
  // Release builds on iOS drop info-level JS logs before they reach the system log; errors still get through.
  // biome-ignore lint/suspicious/noConsole: the gate runner reads this line from logcat or the simulator log
  if (Platform.OS === 'ios') console.error(line);
  // biome-ignore lint/suspicious/noConsole: the gate runner reads this line from logcat or the simulator log
  else console.log(line);
}

const settled = (state: PlaybackState): boolean =>
  state.firstFrameAt !== undefined ||
  state.status.kind === 'ended' ||
  state.status.kind === 'failed' ||
  state.status.kind === 'limited';

interface Session {
  engine: PlayerEngine;
  service: PlaybackService;
  recorder: ReturnType<typeof createPlayerRecorder>;
}

function useSession(params: PlayerGateParams, createEngine: () => PlayerEngine | null) {
  return useMemo((): Session | null => {
    const engine = createEngine();
    if (engine === null) return null;
    const service = createPlaybackService({ engine, clock, timers });
    const faultItem = params.channels[0] ?? '';
    return { engine, service, recorder: createPlayerRecorder({ fault: params.fault, faultItem }) };
    // The engine is created once per screen instance; `App` re-keys the screen when the route changes.
  }, []);
}

/**
 * Development gate for playback: zaps between simulator channels over the real engine and measures time to first
 * frame, zap time, surface creations, stale events, failures and recovery rungs. One `ELV_GATE_PLAYER {json}` line
 * is printed (`console.log` on Android, `console.error` on iOS) when the last zap has settled. Remote channel keys
 * zap too, and count as zaps. The OSD stays mounted after the run.
 */
export function PlayerGateScreen({
  params,
  createEngine = createPlatformEngine,
}: PlayerGateScreenProps): ReactElement {
  const session = useSession(params, createEngine);
  const index = useRef(0);
  const interpreter = useMemo(() => createKeyInterpreter(), []);

  const tuneTo = useCallback(
    (next: number, zapAt?: number): void => {
      if (session === null) return;
      const count = params.channels.length;
      const wrapped = ((next % count) + count) % count;
      index.current = wrapped;
      const item = params.channels[wrapped] ?? '';
      session.recorder.dispatch(item, zapAt);
      session.service.tune({
        item,
        accountKey: params.account,
        kind: params.stream === 'vod' ? 'vod' : 'live',
        resolve: async () => ({
          ok: true,
          value: { url: streamUrl(params, wrapped), headers: {} },
        }),
      });
    },
    [session, params],
  );

  const onInput = useCallback(
    (input: KeyInput): void => {
      for (const event of interpreter.input(input)) {
        if (event.kind !== 'press') continue;
        if (event.key === 'channelUp') tuneTo(index.current + 1, performance.now());
        else if (event.key === 'channelDown') tuneTo(index.current - 1, performance.now());
      }
    },
    [interpreter, tuneTo],
  );
  useTvKeySource(onInput);

  useLayoutEffect(() => {
    if (session === null) return;
    const offEngine = session.engine.subscribe((event) => {
      if (event.type === 'surface') session.recorder.surface(event.change);
      else if (event.type === 'stall' && event.attempt === session.service.getState().attempt) {
        session.recorder.stall(event.phase);
      }
    });
    const offService = session.service.subscribe((state) => session.recorder.observe(state));
    return () => {
      offService();
      offEngine();
    };
  }, [session]);

  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    let printed = false;
    const pending = new Set<ReturnType<typeof setTimeout>>();
    let stopWaiting: (() => void) | undefined;
    const later = (fn: () => void, ms: number): void => {
      const id = setTimeout(() => {
        pending.delete(id);
        if (!cancelled) fn();
      }, ms);
      pending.add(id);
    };
    const emit = (): void => {
      if (printed || cancelled) return;
      printed = true;
      print(playerLine(session.recorder.finish(session.service.getState())));
    };
    const driver = createZapDriver(
      (next, zap) => tuneTo(next, zap ? performance.now() : undefined),
      { channels: params.channels.length, zaps: params.zaps, rate: params.rate, schedule: later },
    );
    void driver.start().then(() => {
      if (cancelled) return;
      if (settled(session.service.getState())) {
        emit();
        return;
      }
      const off = session.service.subscribe((state) => {
        if (settled(state)) emit();
      });
      stopWaiting = off;
      later(emit, SETTLE_TIMEOUT_MS);
    });
    return () => {
      cancelled = true;
      driver.stop();
      stopWaiting?.();
      for (const id of pending) clearTimeout(id);
    };
  }, [session, params, tuneTo]);

  useEffect(
    () => () => {
      session?.service.dispose();
      session?.engine.release();
    },
    [session],
  );

  if (session === null) {
    return (
      <View style={styles.root}>
        <Text style={styles.channel}>No player engine on this platform</Text>
      </View>
    );
  }
  return (
    <View style={styles.root} focusable hasTVPreferredFocus>
      <PlayerSurface
        engine={session.engine}
        style={StyleSheet.absoluteFill}
        testID="player-surface"
      />
      <Osd service={session.service} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  osd: { position: 'absolute', left: 48, right: 48, bottom: 32 },
  channel: { color: '#ffffff', fontSize: 32, fontWeight: '600' },
  status: { color: '#9aa4b2', fontSize: 24 },
  clock: { color: '#ffffff', fontSize: 24 },
});
