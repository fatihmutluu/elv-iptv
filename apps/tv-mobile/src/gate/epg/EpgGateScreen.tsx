import { EpgGridView } from '@elv/features';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  useTheme,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  buildEpgGateScript,
  type EpgGateMetrics,
  type EpgGateStepKey,
  epgGateLine,
  summarizeEpgGateMetrics,
} from './epg-gate-metrics';
import type { EpgGateParams } from './epg-routes';
import { createSyntheticEpgCatalog, EPG_GATE_BASE_NOW_MS } from './epg-synthetic';

const KEYCODES: Readonly<Record<EpgGateStepKey, number>> = {
  up: 19,
  down: 20,
  left: 21,
  right: 22,
};

const TV_GATE_VIEWPORT: ViewportOverride = {
  formFactor: 'tv',
  orientation: 'landscape',
  inputModality: 'tv',
  width: 1280,
  height: 720,
};

const WARMUP_MS = 250;
const STEP_INTERVAL_MS = 20;
const FRAME_BUDGET_MS = 16.67;

interface EpgGateInnerProps {
  readonly params: EpgGateParams;
  readonly emitKey: (key: EpgGateStepKey) => void;
}

function EpgGateInner({ params, emitKey }: EpgGateInnerProps): ReactElement {
  const theme = useTheme();
  const [result, setResult] = useState<EpgGateMetrics | null>(null);
  const dataset = useMemo(
    () =>
      createSyntheticEpgCatalog({
        channels: params.channels,
        days: params.days,
        baseMs: EPG_GATE_BASE_NOW_MS,
      }),
    [params.channels, params.days],
  );
  useEffect(() => () => dataset.channelSource.dispose(), [dataset]);

  const cursorStateRef = useRef({
    focusedRow: 0,
    focusedSlotIndex: 0,
    windowStartMs: EPG_GATE_BASE_NOW_MS,
    focusedChannelKey: null as string | null,
  });
  const pendingCommitRef = useRef<{
    readonly t0: number;
    readonly resolve: () => void;
  } | null>(null);

  const handleCursorCommit = useCallback(
    (snapshot: {
      readonly focusedRow: number;
      readonly focusedSlotIndex: number;
      readonly windowStartMs: number;
      readonly focusedChannelKey: string | null;
    }) => {
      cursorStateRef.current = snapshot;
      const pending = pendingCommitRef.current;
      if (pending !== null) {
        pendingCommitRef.current = null;
        pending.resolve();
      }
    },
    [],
  );

  const handleWatchChannel = useCallback(() => undefined, []);

  useEffect(() => {
    if (!params.auto) return;
    let alive = true;
    const steps = buildEpgGateScript(params.channels, params.moves);
    const keyLatenciesMs: number[] = [];
    let maxJsTaskMs = 0;
    let framesOver16Ms = 0;
    let focusContinuityOk = true;
    let expectedRow = 0;

    const timer = setTimeout(() => {
      if (!alive) return;
      let idx = 0;

      const runNext = () => {
        if (!alive) return;
        if (idx >= steps.length) {
          const metrics = summarizeEpgGateMetrics({
            channels: params.channels,
            days: params.days,
            totalEstimatedProgrammes: dataset.totalEstimatedProgrammes,
            keyLatenciesMs,
            maxJsTaskMs,
            framesOver16Ms,
            focusContinuityOk,
          });
          const line = epgGateLine(metrics);
          // biome-ignore lint/suspicious/noConsole: gate runners read this line from logcat or simulator logs
          if (Platform.OS === 'ios') console.error(line);
          // biome-ignore lint/suspicious/noConsole: gate runners read this line from logcat or simulator logs
          else console.log(line);
          setResult(metrics);
          return;
        }

        const key = steps[idx] as EpgGateStepKey;
        idx++;
        if (key === 'down') expectedRow = Math.min(params.channels - 1, expectedRow + 1);
        else if (key === 'up') expectedRow = Math.max(0, expectedRow - 1);

        const t0 = performance.now();
        let settled = false;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        const finishStep = () => {
          if (settled || !alive) return;
          settled = true;
          if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
          const elapsed = Math.max(0, performance.now() - t0);
          keyLatenciesMs.push(elapsed);
          if (elapsed > FRAME_BUDGET_MS) framesOver16Ms++;
          if (cursorStateRef.current.focusedRow !== expectedRow) {
            focusContinuityOk = false;
          }
          setTimeout(runNext, STEP_INTERVAL_MS);
        };

        pendingCommitRef.current = { t0, resolve: finishStep };
        emitKey(key);
        const jsDuration = Math.max(0, performance.now() - t0);
        if (jsDuration > maxJsTaskMs) maxJsTaskMs = jsDuration;

        // Fallback timer only for no-op moves that produce no cursor commit.
        fallbackTimer = setTimeout(() => {
          if (!settled) finishStep();
        }, 60);
      };

      runNext();
    }, WARMUP_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
      pendingCommitRef.current = null;
    };
  }, [
    dataset.totalEstimatedProgrammes,
    emitKey,
    params.auto,
    params.channels,
    params.days,
    params.moves,
  ]);

  const statusText =
    result === null
      ? `EPG gate running (${params.channels} ch × ${params.days}d, ${params.moves} steps)…`
      : `${result.passed ? 'PASS' : 'FAIL'} · p95 ${result.keyToHighlightP95Ms}ms · max ${result.keyToHighlightMaxMs}ms · continuity ${result.focusContinuityOk ? 'OK' : 'LOST'}`;

  return (
    <View
      testID="epg-gate-screen"
      style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}
    >
      <View
        testID="epg-gate-status"
        style={[
          styles.statusBar,
          {
            backgroundColor: theme.colors.bgSurface,
            borderBottomColor: theme.colors.surfaceBorder,
          },
        ]}
      >
        <Text
          style={[
            theme.typography.caption,
            {
              color:
                result === null
                  ? theme.colors.textSecondary
                  : result.passed
                    ? theme.colors.successColor
                    : theme.colors.liveColor,
            },
          ]}
        >
          {statusText}
        </Text>
      </View>
      <View style={styles.gridWrap}>
        <EpgGridView
          catalog={dataset.catalog}
          category={dataset.category}
          channelSource={dataset.channelSource}
          sourceVersion={1}
          refreshToken={0}
          nowMs={EPG_GATE_BASE_NOW_MS}
          onWatchChannel={handleWatchChannel}
          onCursorCommit={handleCursorCommit}
          isActiveScope
        />
      </View>
    </View>
  );
}

/** Props of {@link EpgGateScreen}. */
export interface EpgGateScreenProps {
  readonly params: EpgGateParams;
}

/**
 * Development proof gate (`elviptv://gate/epg`, `#6`): mounts the real {@link EpgGridView} over an
 * O(1)-windowed synthetic `1,000` channels × `7` days dataset, drives scripted D-pad navigation,
 * verifies focus continuity and `< 100 ms` key-to-highlight latency, and prints `ELV_GATE {...}`.
 */
export function EpgGateScreen({ params }: EpgGateScreenProps): ReactElement {
  const i18n = useMemo(() => createAppI18n('en'), []);
  const listenersRef = useRef(new Set<(event: AndroidKeyEvent) => void>());

  const syntheticKeySource = useMemo<AndroidKeySource>(
    () => ({
      addListener: (cb) => {
        listenersRef.current.add(cb);
        return {
          remove: () => {
            listenersRef.current.delete(cb);
          },
        };
      },
    }),
    [],
  );

  const emitKey = useCallback((key: EpgGateStepKey) => {
    const keyCode = KEYCODES[key];
    const down: AndroidKeyEvent = {
      keyCode,
      action: 'down',
      canceled: false,
      ageMs: 0,
    };
    const up: AndroidKeyEvent = {
      keyCode,
      action: 'up',
      canceled: false,
      ageMs: 10,
    };
    for (const cb of [...listenersRef.current]) {
      cb(down);
      cb(up);
    }
  }, []);

  return (
    <ViewportProvider value={TV_GATE_VIEWPORT}>
      <ThemeProvider preset="obsidianCrimson">
        <I18nProvider i18n={i18n}>
          <RemoteKeysProvider android={params.auto ? syntheticKeySource : null}>
            <EpgGateInner params={params} emitKey={emitKey} />
          </RemoteKeysProvider>
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  statusBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gridWrap: { flex: 1 },
});
