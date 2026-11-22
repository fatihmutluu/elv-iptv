import type { AppI18n } from '@elv/i18n';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  positionAt,
} from '@elv/playback';
import {
  CtaButton,
  IconButton,
  TABULAR_NUMS_STYLE,
  useTheme,
  webBackdropBlur,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { PlayableEntry } from '../ports/play-target';
import { shouldShowNextEpisodePrompt } from './player-overlay-model';
import { usePlaybackTicker } from './usePlaybackTicker';

const DEFAULT_COUNTDOWN_SECONDS = 10;

const DEFAULT_BANNER_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Props of {@link NextEpisodeBanner}. */
export interface NextEpisodeBannerProps {
  readonly nextEpisode: PlayableEntry | undefined;
  readonly statusKind: PlaybackStatus['kind'];
  readonly dismissed: boolean;
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly isTv: boolean;
  readonly tvFocused?: boolean;
  readonly i18n: AppI18n;
  readonly autoPlayNextEpisode?: boolean;
  readonly countdownSeconds?: number;
  readonly reduceMotion?: boolean;
  readonly timers?: PlaybackTimers;
  readonly onPlayNext: (expectedNextKey?: string) => void;
  readonly onDismiss: () => void;
  readonly onVisibilityChange?: (visible: boolean) => void;
}

function formatNextEpisodeLabel(ep: PlayableEntry, i18n: AppI18n): string {
  const subtitle = ep.subtitle?.trim();
  if (subtitle !== undefined && subtitle.length > 0) {
    return i18n.t('player.nextEpisodeWithLabel', { label: subtitle });
  }
  if (ep.season != null && ep.episode != null) {
    return i18n.t('player.nextEpisodeWithLabel', { label: `S${ep.season} E${ep.episode}` });
  }
  return i18n.t('player.nextEpisode');
}

function NextEpisodeBannerBody({
  nextEpisode,
  statusKind,
  service,
  clock,
  isTv,
  tvFocused = false,
  i18n,
  autoPlayNextEpisode = true,
  countdownSeconds = DEFAULT_COUNTDOWN_SECONDS,
  reduceMotion = false,
  timers = DEFAULT_BANNER_TIMERS,
  onPlayNext,
  onDismiss,
  onVisibilityChange,
}: Omit<NextEpisodeBannerProps, 'nextEpisode' | 'dismissed'> & {
  readonly nextEpisode: PlayableEntry;
}): ReactElement | null {
  const theme = useTheme();
  const isWeb = (Platform.OS as string) === 'web';
  const totalSeconds = Math.max(1, Math.round(countdownSeconds));

  const onVisibilityRef = useRef(onVisibilityChange);
  onVisibilityRef.current = onVisibilityChange;
  const onPlayNextRef = useRef(onPlayNext);
  onPlayNextRef.current = onPlayNext;
  const timersRef = useRef(timers);
  timersRef.current = timers;

  const [hovered, setHovered] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(totalSeconds);
  const remainingRef = useRef(totalSeconds);
  const autoFiredRef = useRef(false);

  const tickerVisible = usePlaybackTicker({
    service,
    clock,
    mode: 'second',
    active: statusKind !== 'ended',
    derive: (anchor, nowMs) =>
      shouldShowNextEpisodePrompt({
        positionMs: anchor !== undefined ? positionAt(anchor, nowMs) : 0,
        durationMs: anchor?.durationMs ?? 0,
        statusKind,
        hasNextEpisode: true,
        dismissed: false,
      }),
    isEqual: (a, b) => a === b,
  });

  const visible = statusKind === 'ended' || tickerVisible;
  const lastReportedRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (lastReportedRef.current === visible) return;
    if (lastReportedRef.current === null && !visible) {
      lastReportedRef.current = false;
      return;
    }
    lastReportedRef.current = visible;
    onVisibilityRef.current?.(visible);
  }, [visible]);

  useEffect(
    () => () => {
      if (lastReportedRef.current === true) {
        lastReportedRef.current = false;
        onVisibilityRef.current?.(false);
      }
    },
    [],
  );

  const resetKey = `${nextEpisode.itemKey}:${totalSeconds}:${visible ? '1' : '0'}`;
  const lastResetKeyRef = useRef(resetKey);
  const countdownRunning =
    visible &&
    autoPlayNextEpisode &&
    !tvFocused &&
    !hovered &&
    (statusKind === 'playing' || statusKind === 'ended');

  useEffect(() => {
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      autoFiredRef.current = false;
      remainingRef.current = totalSeconds;
      setRemainingSeconds(totalSeconds);
    }
    if (!countdownRunning || autoFiredRef.current) return;
    const activeTimers = timersRef.current;
    const itemKey = nextEpisode.itemKey;
    let handle: unknown = null;
    let cancelled = false;

    const scheduleTick = (): void => {
      if (cancelled || autoFiredRef.current) return;
      if (remainingRef.current <= 0) {
        autoFiredRef.current = true;
        onPlayNextRef.current(itemKey);
        return;
      }
      handle = activeTimers.setTimeout(() => {
        handle = null;
        if (cancelled || autoFiredRef.current) return;
        const next = Math.max(0, remainingRef.current - 1);
        remainingRef.current = next;
        setRemainingSeconds(next);
        if (next <= 0) {
          autoFiredRef.current = true;
          onPlayNextRef.current(itemKey);
          return;
        }
        scheduleTick();
      }, 1_000);
    };

    scheduleTick();
    return () => {
      cancelled = true;
      if (handle !== null) activeTimers.clearTimeout(handle);
    };
  }, [countdownRunning, nextEpisode.itemKey, resetKey, totalSeconds]);

  if (!visible) return null;

  const progressPct = Math.max(
    0,
    Math.min(100, Math.round(((totalSeconds - remainingSeconds) / totalSeconds) * 1000) / 10),
  );
  const effectiveReduceMotion = reduceMotion || theme.reduceMotion;
  const webHoverProps = isWeb
    ? ({
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => setHovered(false),
      } as Record<string, unknown>)
    : undefined;

  return (
    <View
      testID="player-next-episode-banner"
      {...webHoverProps}
      style={[
        styles.banner,
        {
          backgroundColor: theme.colors.glassBg,
          borderColor: theme.colors.glassBorder,
          borderRadius: theme.radius.modal,
        },
        webBackdropBlur(20),
      ]}
    >
      <View style={styles.content}>
        <View style={styles.metaRow}>
          <Text style={[theme.typography.micro, { color: theme.colors.textMuted }]}>
            {i18n.t('player.upNext')}
          </Text>
          {autoPlayNextEpisode ? (
            <Text
              testID="player-next-episode-countdown"
              style={[
                theme.typography.caption,
                TABULAR_NUMS_STYLE,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t('player.nextUpCountdown', { seconds: remainingSeconds })}
            </Text>
          ) : null}
        </View>
        {nextEpisode.title.trim().length > 0 ? (
          <Text
            testID="player-next-episode-title"
            numberOfLines={1}
            style={[theme.typography.title, { color: theme.colors.textPrimary }]}
          >
            {nextEpisode.title}
          </Text>
        ) : null}
        <View style={styles.actionRow}>
          <CtaButton
            testID="player-next-episode"
            variant="primary"
            icon="play"
            label={formatNextEpisodeLabel(nextEpisode, i18n)}
            focusable={!isTv}
            focused={tvFocused}
            onPress={() => {
              autoFiredRef.current = true;
              onPlayNext(nextEpisode.itemKey);
            }}
          />
          <IconButton
            testID="player-next-episode-dismiss"
            icon="close"
            size={40}
            accessibilityLabel={i18n.t('player.dismissNextEpisode')}
            focusable={!isTv}
            onPress={onDismiss}
          />
        </View>
      </View>
      {autoPlayNextEpisode ? (
        <View
          testID="player-next-episode-progress"
          style={[styles.progressTrack, { backgroundColor: theme.colors.surfaceBorder }]}
        >
          <View
            testID="player-next-episode-progress-fill"
            style={[
              styles.progressFill,
              {
                width: `${progressPct}%`,
                backgroundColor: theme.colors.accent,
              },
              effectiveReduceMotion ? undefined : webTransition(theme, 'width', 900),
            ]}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Leaf Cinema Quietude v2 Up-Next / Next Episode countdown card anchored bottom-right (`#353`, `#392`).
 * Subscribes to `usePlaybackTicker` only when a next episode is queued and not dismissed,
 * auto-advancing cleanly after `countdownSeconds` when `autoPlayNextEpisode` is enabled.
 */
export function NextEpisodeBanner({
  nextEpisode,
  dismissed,
  ...rest
}: NextEpisodeBannerProps): ReactElement | null {
  if (nextEpisode === undefined || dismissed) return null;
  return <NextEpisodeBannerBody nextEpisode={nextEpisode} {...rest} />;
}

const styles = StyleSheet.create({
  banner: {
    alignSelf: 'flex-end',
    maxWidth: 340,
    borderWidth: 1,
    overflow: 'hidden',
  },
  content: {
    padding: 10,
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressTrack: {
    height: 3,
    width: '100%',
  },
  progressFill: {
    height: '100%',
  },
});
