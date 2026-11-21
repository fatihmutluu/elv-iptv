import type { AppI18n } from '@elv/i18n';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  positionAt,
} from '@elv/playback';
import { CtaButton, IconButton, useTheme, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlayableEntry } from '../ports/play-target';
import { shouldShowNextEpisodePrompt } from './player-overlay-model';
import { usePlaybackTicker } from './usePlaybackTicker';

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
  onPlayNext,
  onDismiss,
  onVisibilityChange,
}: Omit<NextEpisodeBannerProps, 'nextEpisode' | 'dismissed'> & {
  readonly nextEpisode: PlayableEntry;
}): ReactElement | null {
  const theme = useTheme();
  const onVisibilityRef = useRef(onVisibilityChange);
  onVisibilityRef.current = onVisibilityChange;

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

  if (!visible) return null;

  return (
    <View
      testID="player-next-episode-banner"
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
      <CtaButton
        testID="player-next-episode"
        variant="primary"
        icon="play"
        label={formatNextEpisodeLabel(nextEpisode, i18n)}
        focusable={!isTv}
        focused={tvFocused}
        onPress={() => onPlayNext(nextEpisode.itemKey)}
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
  );
}

/**
 * Leaf Up-Next / Next Episode CTA card anchored bottom-right (`#353`, `UI_UX_PHILOSOPHY.md` §2.2).
 * Subscribes to `usePlaybackTicker` only when a next episode is queued and not dismissed,
 * re-rendering strictly on boolean visibility transitions.
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    padding: 8,
  },
});
