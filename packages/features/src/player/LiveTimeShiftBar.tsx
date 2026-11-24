import type { AppI18n } from '@elv/i18n';
import type { ClockAnchor, PlaybackClock, PlaybackService } from '@elv/playback';
import {
  MicroPill,
  TABULAR_NUMS_STYLE,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  type LiveTimeShiftSnapshot,
  readLiveTimeShiftSnapshot,
  sameLiveTimeShiftSnapshot,
} from './live-timeshift-model';
import { usePlaybackTicker } from './usePlaybackTicker';
import { type PressGeometry, readEventRatio } from './vod-progress-helpers';

/** Reactive second-granularity live time-shift state hook (`#28`) — zero rAF overhead. */
export function useLiveTimeShiftState(
  service: PlaybackService | null,
  clock: PlaybackClock,
  active: boolean,
  isPaused: boolean,
): LiveTimeShiftSnapshot {
  const derive = useCallback(
    (anchor: ClockAnchor | undefined, nowMs: number) =>
      readLiveTimeShiftSnapshot(anchor, nowMs, isPaused),
    [isPaused],
  );
  return usePlaybackTicker({
    service: active ? service : null,
    clock,
    mode: 'second',
    active: active && service !== null,
    derive,
    isEqual: sameLiveTimeShiftSnapshot,
  });
}

/** Props of {@link LiveTimeShiftBar}. */
export interface LiveTimeShiftBarProps {
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly isPaused: boolean;
  readonly isTv: boolean;
  readonly tvFocused?: boolean;
  readonly i18n: AppI18n;
  readonly onSeekRatio: (ratio: number) => void;
}

/**
 * Cinema Quietude bounded live time-shift scrubber (`#28`).
 * Renders only when `resolveLiveTimeShiftWindow(anchor, nowMs)` returns a valid seekable window;
 * shows paused / behind-live offset / live-edge pill and interactive timeline within `[startMs, endMs]`.
 */
export function LiveTimeShiftBar({
  service,
  clock,
  isPaused,
  isTv,
  tvFocused = false,
  i18n,
  onSeekRatio,
}: LiveTimeShiftBarProps): ReactElement | null {
  const theme = useTheme();
  const isWeb = (Platform.OS as string) === 'web';
  const widthRef = useRef(0);
  const [hovered, setHovered] = useState(false);

  const snapshot = useLiveTimeShiftState(service, clock, service !== null, isPaused);

  if (!snapshot.supported) return null;

  const isActive = tvFocused || hovered;
  const statusLabel = snapshot.isPaused
    ? i18n.t('player.livePaused')
    : snapshot.isBehindLive
      ? i18n.t('player.behindLive', { offset: snapshot.offsetText })
      : i18n.t('player.liveEdge');
  const statusTone = snapshot.isPaused || snapshot.isBehindLive ? 'accent' : 'live';

  const webPointerProps =
    isWeb && !isTv
      ? ({
          onHoverIn: () => setHovered(true),
          onHoverOut: () => setHovered(false),
        } as Record<string, unknown>)
      : undefined;

  return (
    <View testID="player-live-timeshift-row" style={styles.row}>
      <MicroPill
        testID="player-live-timeshift-status"
        label={statusLabel}
        tone={statusTone}
        dot={!snapshot.isPaused && !snapshot.isBehindLive}
      />

      <Pressable
        testID="player-live-timeshift-bar"
        focusable={!isTv}
        accessibilityRole="adjustable"
        accessibilityLabel={i18n.t('player.progressLabel')}
        accessibilityState={{ selected: tvFocused }}
        accessibilityValue={{
          min: 0,
          max: Math.max(1, Math.round(snapshot.spanMs / 1_000)),
          now: Math.round((snapshot.positionMs - snapshot.startMs) / 1_000),
          text: statusLabel,
        }}
        onLayout={(event) => {
          widthRef.current = event.nativeEvent.layout.width;
        }}
        onPress={(event) => {
          const ratio = readEventRatio(event as unknown as PressGeometry, widthRef.current, true);
          if (ratio === undefined || !Number.isFinite(ratio)) return;
          onSeekRatio(ratio);
        }}
        {...webPointerProps}
        style={[styles.trackHitBox, !isTv ? webCursorPointer() : undefined]}
      >
        {tvFocused ? (
          <View
            testID="player-live-timeshift-focus-ring"
            pointerEvents="none"
            style={[
              styles.focusRing,
              {
                borderColor: theme.colors.focusRingColor,
                borderWidth: theme.focus.ringWidth,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        ) : null}
        <View
          testID="player-live-timeshift-rail"
          pointerEvents="none"
          style={[
            styles.trackRail,
            {
              height: isActive ? 5 : 3,
              backgroundColor: theme.colors.actionGlassBorder,
            },
            webTransition(theme, 'height', theme.motion.fastMs),
          ]}
        >
          <View
            testID="player-live-timeshift-fill"
            style={[
              styles.trackFill,
              { width: `${snapshot.fillPercent}%`, backgroundColor: theme.colors.accent },
            ]}
          />
        </View>
        <View
          testID="player-live-timeshift-thumb"
          pointerEvents="none"
          style={[
            styles.trackThumb,
            isActive ? styles.trackThumbActive : null,
            {
              left: `${snapshot.fillPercent}%`,
              backgroundColor: theme.colors.textPrimary,
              borderColor: theme.colors.bgCanvas,
            },
            webTransition(theme, 'transform, opacity, width, height', theme.motion.fastMs),
          ]}
        />
      </Pressable>

      <Text
        testID="player-live-timeshift-offset"
        style={[
          theme.typography.caption,
          TABULAR_NUMS_STYLE,
          styles.offsetText,
          { color: snapshot.isBehindLive ? theme.colors.textPrimary : theme.colors.liveColor },
        ]}
      >
        {snapshot.isBehindLive ? snapshot.offsetText : i18n.t('ui.liveBadge')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  trackHitBox: {
    position: 'relative',
    flex: 1,
    paddingVertical: 10,
    justifyContent: 'center',
    direction: 'ltr',
  },
  focusRing: { position: 'absolute', left: -4, right: -4, top: 3, bottom: 3 },
  trackRail: {
    height: 3,
    borderRadius: 999,
    overflow: 'hidden',
    direction: 'ltr',
  },
  trackFill: { height: '100%' },
  trackThumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    borderWidth: 1.5,
    zIndex: 3,
  },
  trackThumbActive: { width: 14, height: 14, marginLeft: -7, borderRadius: 7 },
  offsetText: { fontWeight: '700', minWidth: 46, textAlign: 'right' },
});
