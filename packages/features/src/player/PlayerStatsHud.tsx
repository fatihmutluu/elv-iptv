import type { AppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackState,
  positionAt,
} from '@elv/playback';
import { TABULAR_NUMS_STYLE, useTheme, useViewport, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useCatalogUiCache } from '../shared/CatalogUiCacheProvider';
import { formatStatsHudLines } from './player-overlay-model';
import { usePlaybackTicker } from './usePlaybackTicker';

const FONT_FAMILY_MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  web: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  default: 'monospace',
});
const ROW_KEYS = ['status', 'tracks', 'telemetry', 'diagnostics'] as const;
const UI_STALL_FRAME_MS = 50;

/** Props of {@link PlayerStatsHud}. */
export interface PlayerStatsHudProps {
  readonly visible: boolean;
  /** Whether the player OSD top bar is currently visible so the HUD offsets cleanly below it. */
  readonly osdVisible?: boolean;
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly i18n: AppI18n;
  readonly isDesktop: boolean;
  readonly docked?: boolean;
}

const sameBucket = (a: number, b: number): boolean => a === b;
const readSecondBucket = (anchor: ClockAnchor | undefined, nowMs: number): number =>
  anchor === undefined ? -1 : Math.floor(Math.max(0, positionAt(anchor, nowMs)) / 1000);

const sameMeta = (a: PlaybackState | undefined, b: PlaybackState): boolean =>
  a !== undefined &&
  a.status === b.status &&
  a.tracks === b.tracks &&
  a.videoInfo === b.videoInfo &&
  a.droppedFrames === b.droppedFrames &&
  a.attempt === b.attempt &&
  a.firstFrameAt === b.firstFrameAt &&
  a.tuneAt === b.tuneAt &&
  a.staleEventsDropped === b.staleEventsDropped;

function PlayerStatsHudBody(props: Omit<PlayerStatsHudProps, 'visible'>): ReactElement | null {
  const { service, clock, i18n, isDesktop, docked = isDesktop } = props;
  const theme = useTheme();
  const viewport = useViewport();
  const uiCache = useCatalogUiCache();
  const [meta, setMeta] = useState<PlaybackState | undefined>(() => service?.getState());
  const [uiStalls, setUiStalls] = useState(0);
  const lastFrameRef = useRef<number | null>(null);

  useEffect(() => {
    setMeta(service?.getState());
    if (service === null) return;
    return service.subscribe((next) => setMeta((prev) => (sameMeta(prev, next) ? prev : next)));
  }, [service]);

  // Lightweight rAF stall counter active strictly while Stats HUD is visible (#160)
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function' || typeof cancelAnimationFrame !== 'function') {
      return;
    }
    let handle = 0;
    let cancelled = false;
    lastFrameRef.current = null;
    const step = (ts: number): void => {
      if (cancelled) return;
      if (lastFrameRef.current !== null && ts - lastFrameRef.current > UI_STALL_FRAME_MS) {
        setUiStalls((n) => n + 1);
      }
      lastFrameRef.current = ts;
      handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  const secondBucket = usePlaybackTicker({
    service,
    clock,
    mode: 'second',
    derive: readSecondBucket,
    isEqual: sameBucket,
  });

  const live = service?.getState() ?? meta;
  const cacheHitRatePct = uiCache?.getMetrics?.().hitRatePct;
  // biome-ignore lint/correctness/useExhaustiveDependencies: secondBucket triggers 1Hz formatting once per tick
  const lines = useMemo(
    () =>
      live !== undefined
        ? formatStatsHudLines(live, clock.now(), i18n, {
            cacheHitRatePct,
            uiStalls,
          })
        : [],
    [cacheHitRatePct, clock, i18n, live, secondBucket, uiStalls],
  );
  if (lines.length === 0) return null;

  const isDockedBar = isDesktop && docked;
  const boxStyle = {
    backgroundColor: theme.colors.glassBg,
    borderColor: theme.colors.glassBorder,
    borderRadius: isDockedBar ? 0 : theme.radius.card,
  };
  const topOffset = props.osdVisible === true ? 96 : 16;
  const overlayStyle = isDockedBar
    ? styles.desktopDock
    : {
        position: 'absolute' as const,
        top: topOffset + viewport.safeArea.top + viewport.overscan.y,
        left: 16 + viewport.safeArea.left + viewport.overscan.x,
        zIndex: 25,
        maxWidth: 480,
      };
  return (
    <View
      testID="player-stats-hud"
      pointerEvents="none"
      style={[styles.pill, overlayStyle, boxStyle, webBackdropBlur(16)]}
    >
      {lines.map((line, idx) => (
        <Text
          key={ROW_KEYS[idx] ?? line}
          numberOfLines={1}
          style={[
            TABULAR_NUMS_STYLE,
            styles.line,
            {
              fontFamily: FONT_FAMILY_MONO,
              color: idx === 0 ? theme.colors.textPrimary : theme.colors.textSecondary,
            },
          ]}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

/**
 * Opt-in monospace playback telemetry HUD (`UI_UX_PHILOSOPHY.md` §4.2, `#160`).
 * Mounts its leaf `usePlaybackTicker` and frame-stall meter strictly while `visible` is `true`
 * and docks in flex flow only when `docked` desktop child-HWND mode is active.
 */
export function PlayerStatsHud(props: PlayerStatsHudProps): ReactElement | null {
  return props.visible ? <PlayerStatsHudBody {...props} /> : null;
}

const styles = StyleSheet.create({
  pill: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  desktopDock: { borderWidth: 0, borderTopWidth: 1, paddingHorizontal: 16 },
  line: { fontSize: 11.5, lineHeight: 16 },
});
