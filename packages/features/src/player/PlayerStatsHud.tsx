import type { AppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackState,
  positionAt,
} from '@elv/playback';
import { TABULAR_NUMS_STYLE, useTheme, useViewport, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { formatStatsHudLines } from './player-overlay-model';
import { usePlaybackTicker } from './usePlaybackTicker';

const FONT_FAMILY_MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  web: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  default: 'monospace',
});
const ROW_KEYS = ['status', 'tracks', 'telemetry'] as const;

/** Props of {@link PlayerStatsHud}. */
export interface PlayerStatsHudProps {
  readonly visible: boolean;
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly i18n: AppI18n;
  readonly isDesktop: boolean;
}

const sameBucket = (a: number, b: number): boolean => a === b;
const readSecondBucket = (anchor: ClockAnchor | undefined, nowMs: number): number =>
  anchor === undefined ? -1 : Math.floor(Math.max(0, positionAt(anchor, nowMs)) / 1000);

const sameMeta = (a: PlaybackState | undefined, b: PlaybackState): boolean =>
  a !== undefined &&
  a.status === b.status &&
  a.tracks === b.tracks &&
  a.attempt === b.attempt &&
  a.firstFrameAt === b.firstFrameAt &&
  a.tuneAt === b.tuneAt &&
  a.staleEventsDropped === b.staleEventsDropped;

function PlayerStatsHudBody(props: Omit<PlayerStatsHudProps, 'visible'>): ReactElement | null {
  const { service, clock, i18n, isDesktop } = props;
  const theme = useTheme();
  const viewport = useViewport();
  const [meta, setMeta] = useState<PlaybackState | undefined>(() => service?.getState());

  useEffect(() => {
    setMeta(service?.getState());
    if (service === null) return;
    return service.subscribe((next) => setMeta((prev) => (sameMeta(prev, next) ? prev : next)));
  }, [service]);

  const secondBucket = usePlaybackTicker({
    service,
    clock,
    mode: 'second',
    derive: readSecondBucket,
    isEqual: sameBucket,
  });

  const live = service?.getState() ?? meta;
  // biome-ignore lint/correctness/useExhaustiveDependencies: secondBucket triggers 1Hz formatting once per tick
  const lines = useMemo(
    () => (live !== undefined ? formatStatsHudLines(live, clock.now(), i18n) : []),
    [clock, i18n, live, secondBucket],
  );
  if (lines.length === 0) return null;

  const boxStyle = {
    backgroundColor: theme.colors.glassBg,
    borderColor: theme.colors.glassBorder,
    borderRadius: isDesktop ? 0 : theme.radius.card,
  };
  const overlayStyle = isDesktop
    ? styles.desktopDock
    : {
        position: 'absolute' as const,
        top: 64 + viewport.safeArea.top + viewport.overscan.y,
        left: 16 + viewport.safeArea.left + viewport.overscan.x,
        zIndex: 25,
        maxWidth: 440,
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
 * Opt-in monospace playback telemetry HUD (`UI_UX_PHILOSOPHY.md` §4.2).
 * Mounts its leaf `usePlaybackTicker` only while `visible` is `true` and docks in flex flow on Desktop.
 */
export function PlayerStatsHud(props: PlayerStatsHudProps): ReactElement | null {
  return props.visible ? <PlayerStatsHudBody {...props} /> : null;
}

const styles = StyleSheet.create({
  pill: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  desktopDock: { borderWidth: 0, borderTopWidth: 1, paddingHorizontal: 16 },
  line: { fontSize: 11.5, lineHeight: 16 },
});
