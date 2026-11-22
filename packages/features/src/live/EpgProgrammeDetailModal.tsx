import type { ItemRow, ProgrammeRow } from '@elv/data';
import {
  CtaButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatClockTime } from './live-model';
import {
  formatChannelDisplayName,
  type ProgrammeBadgeKind,
  resolveProgrammeBadges,
} from './source-badge';

/** Props of {@link EpgProgrammeDetailModal}. */
export interface EpgProgrammeDetailModalProps {
  readonly visible: boolean;
  readonly channel: ItemRow | null;
  readonly channelIndex: number;
  readonly programme: ProgrammeRow | null;
  readonly nowMs: number;
  readonly isFavorite: boolean;
  readonly isTv: boolean;
  readonly cleanChannelTitles?: boolean;
  readonly onTuneChannel: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onClose: () => void;
}

type ModalActionId = 'tune' | 'favorite' | 'close';

function badgeMessageKey(kind: ProgrammeBadgeKind) {
  if (kind === 'live') return 'epg.badge.live' as const;
  if (kind === 'premiere') return 'epg.badge.premiere' as const;
  return 'epg.badge.new' as const;
}

function genreMessageKey(genre: ProgrammeRow['genre']) {
  if (genre === 'sports') return 'epg.genre.sports' as const;
  if (genre === 'movie') return 'epg.genre.movie' as const;
  if (genre === 'news') return 'epg.genre.news' as const;
  if (genre === 'kids') return 'epg.genre.kids' as const;
  if (genre === 'series') return 'epg.genre.series' as const;
  return null;
}

function badgeTone(kind: ProgrammeBadgeKind): 'live' | 'accent' | 'neutral' {
  if (kind === 'live') return 'live';
  if (kind === 'premiere') return 'accent';
  return 'neutral';
}

function formatDurationMinutes(startMs: number, stopMs: number): number | null {
  const diff = stopMs - startMs;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  return Math.max(1, Math.round(diff / 60_000));
}

function formatEpisodeTag(programme: ProgrammeRow): string | null {
  const raw = programme.episodeNum?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function EpgDetailTvKeyTrap({
  onInput,
}: {
  readonly onInput: Parameters<typeof useTvKeyInterceptor>[0];
}): null {
  useTvKeyInterceptor(onInput);
  return null;
}

/**
 * In-tree Cinema Quietude Programme Detail modal (`#395`, `#396`) — never uses RN `<Modal>`.
 * Displays full programme metadata, badges, episode info, description, and Tune / Favorite / Close
 * actions while trapping 10-ft TV remote keys (`useTvKeyInterceptor`) and desktop `Escape`.
 */
export function EpgProgrammeDetailModal({
  visible,
  channel,
  channelIndex,
  programme,
  nowMs,
  isFavorite,
  isTv,
  cleanChannelTitles = false,
  onTuneChannel,
  onToggleFavorite,
  onClose,
}: EpgProgrammeDetailModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedIdxRef = useRef(0);
  focusedIdxRef.current = focusedIdx;

  const actions = useMemo<readonly ModalActionId[]>(() => {
    const out: ModalActionId[] = [];
    if (channel !== null) out.push('tune');
    if (channel !== null && onToggleFavorite !== undefined) out.push('favorite');
    out.push('close');
    return out;
  }, [channel, onToggleFavorite]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset focused action whenever opened for a programme
  useEffect(() => {
    if (visible) {
      focusedIdxRef.current = 0;
      setFocusedIdx(0);
    }
  }, [visible, programme?.start, programme?.title]);

  const activateIndex = useCallback(
    (idx: number) => {
      const action = actions[idx];
      if (action === 'tune' && channel !== null) {
        onClose();
        onTuneChannel(channel, channelIndex);
      } else if (action === 'favorite' && channel !== null) {
        onToggleFavorite?.(channel);
      } else {
        onClose();
      }
    },
    [actions, channel, channelIndex, onClose, onToggleFavorite, onTuneChannel],
  );

  const handleTvTrap = useCallback(
    (input: Parameters<Parameters<typeof useTvKeyInterceptor>[0]>[0]): boolean => {
      if (input.action !== 'down' && input.action !== 'press') return true;
      if (input.key === 'back') {
        onClose();
        return true;
      }
      if (input.key === 'left' || input.key === 'up') {
        const next = Math.max(0, focusedIdxRef.current - 1);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        return true;
      }
      if (input.key === 'right' || input.key === 'down') {
        const next = Math.min(actions.length - 1, focusedIdxRef.current + 1);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        return true;
      }
      if (input.key === 'select') {
        activateIndex(focusedIdxRef.current);
        return true;
      }
      return true;
    },
    [actions.length, activateIndex, onClose],
  );

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        onClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [onClose, visible]);

  if (!visible || programme === null) return null;

  const isUpcoming = programme.start > nowMs;
  const durationMin = formatDurationMinutes(programme.start, programme.stop);
  const episodeTag = formatEpisodeTag(programme);
  const badges = resolveProgrammeBadges(programme.flags);
  const genreKey = genreMessageKey(programme.genre);
  const channelName = channel ? formatChannelDisplayName(channel.name, cleanChannelTitles) : null;
  const description = programme.description?.trim() || i18n.t('epg.noDescription');
  const focusedAction = isTv ? (actions[focusedIdx] ?? null) : null;

  return (
    <View testID="epg-programme-detail-modal" style={styles.root}>
      {isTv ? <EpgDetailTvKeyTrap onInput={handleTvTrap} /> : null}
      <Pressable
        testID="epg-programme-detail-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        accessibilityRole="summary"
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.header}>
          {channelName !== null ? (
            <Text
              testID="epg-detail-channel"
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {channelName}
            </Text>
          ) : null}
          <Text
            testID="epg-detail-title"
            style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
          >
            {programme.title}
          </Text>
          {programme.subTitle ? (
            <Text
              testID="epg-detail-subtitle"
              style={[theme.typography.title, { color: theme.colors.textSecondary }]}
            >
              {programme.subTitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.pillsRow}>
          <MicroPill
            testID="epg-detail-time"
            label={`${formatClockTime(programme.start)} – ${formatClockTime(programme.stop)}`}
            tone="neutral"
          />
          {durationMin !== null ? (
            <MicroPill
              testID="epg-detail-duration"
              label={i18n.t('epg.durationMinutes', { minutes: durationMin })}
              tone="neutral"
            />
          ) : null}
          {isUpcoming ? (
            <MicroPill testID="epg-detail-upcoming" label={i18n.t('epg.upcoming')} tone="accent" />
          ) : null}
          {episodeTag !== null ? (
            <MicroPill testID="epg-detail-episode" label={episodeTag} tone="neutral" />
          ) : null}
          {genreKey !== null ? (
            <MicroPill testID="epg-detail-genre" label={i18n.t(genreKey)} tone="neutral" />
          ) : null}
          {badges.map((b) => (
            <MicroPill
              key={b}
              testID={`epg-detail-badge-${b}`}
              label={i18n.t(badgeMessageKey(b))}
              tone={badgeTone(b)}
            />
          ))}
        </View>

        <ScrollView style={styles.descScroll} showsVerticalScrollIndicator={false}>
          <Text
            testID="epg-detail-description"
            style={[
              theme.typography.body,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {description}
          </Text>
        </ScrollView>

        <View style={styles.actionsRow}>
          {channel !== null ? (
            <CtaButton
              testID="epg-detail-tune"
              variant="primary"
              icon="play"
              label={i18n.t('epg.tuneChannel')}
              focusable={!isTv}
              focused={focusedAction === 'tune'}
              onPress={() => {
                onClose();
                onTuneChannel(channel, channelIndex);
              }}
            />
          ) : null}
          {channel !== null && onToggleFavorite !== undefined ? (
            <CtaButton
              testID="epg-detail-favorite"
              variant="secondary"
              icon={isFavorite ? 'starFilled' : 'star'}
              label={i18n.t(
                isFavorite ? 'live.context.removeFavorite' : 'live.context.addFavorite',
              )}
              focusable={!isTv}
              focused={focusedAction === 'favorite'}
              onPress={() => onToggleFavorite(channel)}
            />
          ) : null}
          <CtaButton
            testID="epg-detail-close"
            variant="secondary"
            label={i18n.t('player.close')}
            focusable={!isTv}
            focused={focusedAction === 'close'}
            onPress={onClose}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '82%',
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  header: { gap: 4 },
  pillsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  descScroll: { maxHeight: 220 },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingTop: 4,
  },
});
