import type { CatalogService, ItemRow, ProgrammeRow } from '@elv/data';
import {
  CtaButton,
  FilterChip,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_REMINDER_LEAD_MIN,
  findArchiveProgrammeMatch,
  REMINDER_LEAD_OPTIONS_MIN,
  resolveCatchupAvailability,
} from './catchup-reminder-model';
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
  readonly catalog?: CatalogService;
  readonly hasReminder?: boolean;
  readonly reminderLeadTimeMs?: number;
  readonly onTuneChannel: (channel: ItemRow, index: number) => void;
  readonly onWatchCatchup?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow,
    hasArchive?: boolean,
  ) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onReminderChanged?: () => void;
  readonly onClose: () => void;
}

type ModalActionId = 'catchup' | 'reminder' | `lead:${number}` | 'tune' | 'favorite' | 'close';

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

function leadMsToMinutes(leadMs: number | undefined): number {
  if (leadMs === undefined || !Number.isFinite(leadMs) || leadMs < 0) {
    return DEFAULT_REMINDER_LEAD_MIN;
  }
  const mins = Math.round(leadMs / 60_000);
  return (REMINDER_LEAD_OPTIONS_MIN as readonly number[]).includes(mins)
    ? mins
    : DEFAULT_REMINDER_LEAD_MIN;
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
 * In-tree Cinema Quietude Programme Detail modal (`#395`, `#396`, `#27`, `#35`) — never uses RN `<Modal>`.
 * Displays full programme metadata, catch-up CTA / retention hint for past shows, reminder toggle
 * & lead-time picker for upcoming shows, and Tune / Favorite / Close actions with TV key trapping.
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
  catalog,
  hasReminder,
  reminderLeadTimeMs,
  onTuneChannel,
  onWatchCatchup,
  onToggleFavorite,
  onReminderChanged,
  onClose,
}: EpgProgrammeDetailModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedIdxRef = useRef(0);
  focusedIdxRef.current = focusedIdx;

  const archiveCacheRef = useRef<Map<string, readonly ProgrammeRow[]>>(new Map());
  const [archiveHasArchive, setArchiveHasArchive] = useState<boolean | undefined>(undefined);
  const [localReminderActive, setLocalReminderActive] = useState(hasReminder ?? false);
  const [leadMinutes, setLeadMinutes] = useState<number>(() => leadMsToMinutes(reminderLeadTimeMs));
  const [reminderBusy, setReminderBusy] = useState(false);

  const isPast = programme !== null && programme.stop <= nowMs;
  const isUpcoming = programme !== null && programme.start > nowMs;

  const programmeIdentity =
    visible && channel !== null && programme !== null ? `${channel.key}|${programme.start}` : '';
  useEffect(() => {
    if (programmeIdentity.length === 0) return;
    setLocalReminderActive(hasReminder ?? false);
    setLeadMinutes(leadMsToMinutes(reminderLeadTimeMs));
  }, [hasReminder, reminderLeadTimeMs, programmeIdentity]);

  // Hydrate standalone reminder state if parent did not pass `hasReminder` explicitly.
  useEffect(() => {
    if (!visible || !isUpcoming || channel === null || programme === null) return;
    if (hasReminder !== undefined || catalog?.listReminders === undefined) return;
    let cancelled = false;
    void catalog
      .listReminders(undefined, { includeFired: false })
      .then((rows) => {
        if (cancelled) return;
        const match = rows.find(
          (r) => r.channelKey === channel.key && r.programmeStart === programme.start,
        );
        setLocalReminderActive(match !== undefined);
        if (match !== undefined) setLeadMinutes(leadMsToMinutes(match.leadTimeMs));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, channel, hasReminder, isUpcoming, programme, visible]);

  // On-demand Xtream `get_simple_data_table` archive check for past programmes within catchupDays.
  useEffect(() => {
    setArchiveHasArchive(undefined);
    if (!visible || !isPast || channel === null || programme === null) return;
    const days = channel.catchupDays ?? 0;
    if (days <= 0 || catalog?.fetchChannelArchiveEpg === undefined) return;
    if (resolveCatchupAvailability(channel, programme, nowMs) !== 'available') return;

    const cached = archiveCacheRef.current.get(channel.key);
    if (cached !== undefined) {
      const matched = findArchiveProgrammeMatch(cached, programme);
      setArchiveHasArchive(matched?.hasArchive);
      return;
    }

    let cancelled = false;
    void catalog
      .fetchChannelArchiveEpg(channel.key)
      .then((res) => {
        if (cancelled || !res.ok) return;
        archiveCacheRef.current.set(channel.key, res.value);
        const matched = findArchiveProgrammeMatch(res.value, programme);
        setArchiveHasArchive(matched?.hasArchive);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, channel, isPast, nowMs, programme, visible]);

  const catchupAvailability = useMemo(
    () =>
      isPast
        ? resolveCatchupAvailability(channel, programme, nowMs, archiveHasArchive)
        : ('unavailable' as const),
    [archiveHasArchive, channel, isPast, nowMs, programme],
  );
  const canWatchCatchup =
    isPast &&
    channel !== null &&
    programme !== null &&
    onWatchCatchup !== undefined &&
    catchupAvailability === 'available';
  const effectiveHasArchive = archiveHasArchive ?? programme?.hasArchive;
  const canToggleReminder =
    isUpcoming &&
    channel !== null &&
    programme !== null &&
    catalog?.upsertReminder !== undefined &&
    catalog?.removeReminder !== undefined;

  const handleToggleReminder = useCallback(
    async (overrideLeadMin?: number) => {
      if (
        !canToggleReminder ||
        channel === null ||
        programme === null ||
        catalog?.upsertReminder === undefined ||
        catalog?.removeReminder === undefined ||
        reminderBusy
      ) {
        return;
      }
      setReminderBusy(true);
      try {
        if (localReminderActive && overrideLeadMin === undefined) {
          const res = await catalog.removeReminder(channel.key, programme.start);
          if (res.ok) {
            setLocalReminderActive(false);
            onReminderChanged?.();
          }
        } else {
          const nextLeadMin = overrideLeadMin ?? leadMinutes;
          const res = await catalog.upsertReminder({
            sourceId: channel.sourceId,
            channelKey: channel.key,
            channelName: channel.name,
            programmeTitle: programme.title,
            programmeStart: programme.start,
            programmeStop: programme.stop,
            leadTimeMs: nextLeadMin * 60_000,
          });
          if (res.ok) {
            setLocalReminderActive(true);
            setLeadMinutes(nextLeadMin);
            onReminderChanged?.();
          }
        }
      } finally {
        setReminderBusy(false);
      }
    },
    [
      canToggleReminder,
      catalog,
      channel,
      leadMinutes,
      localReminderActive,
      onReminderChanged,
      programme,
      reminderBusy,
    ],
  );

  const handleSelectLeadMinutes = useCallback(
    (minutes: number) => {
      setLeadMinutes(minutes);
      if (localReminderActive) {
        void handleToggleReminder(minutes);
      }
    },
    [handleToggleReminder, localReminderActive],
  );

  const actions = useMemo<readonly ModalActionId[]>(() => {
    const out: ModalActionId[] = [];
    if (canWatchCatchup) out.push('catchup');
    if (canToggleReminder) {
      for (const mins of REMINDER_LEAD_OPTIONS_MIN) out.push(`lead:${mins}`);
      out.push('reminder');
    }
    if (channel !== null) out.push('tune');
    if (channel !== null && onToggleFavorite !== undefined) out.push('favorite');
    out.push('close');
    return out;
  }, [canToggleReminder, canWatchCatchup, channel, onToggleFavorite]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset focused action whenever opened for a programme
  useEffect(() => {
    if (visible) {
      focusedIdxRef.current = 0;
      setFocusedIdx(0);
    }
  }, [visible, programme?.start, programme?.title]);

  useEffect(() => {
    if (focusedIdxRef.current >= actions.length) {
      const clamped = Math.max(0, actions.length - 1);
      focusedIdxRef.current = clamped;
      setFocusedIdx(clamped);
    }
  }, [actions.length]);

  const activateIndex = useCallback(
    (idx: number) => {
      const action = actions[idx];
      if (action === 'catchup' && channel !== null && programme !== null && onWatchCatchup) {
        onClose();
        onWatchCatchup(channel, channelIndex, programme, effectiveHasArchive);
      } else if (action === 'reminder') {
        void handleToggleReminder();
      } else if (action?.startsWith('lead:')) {
        const mins = Number(action.slice(5));
        if (Number.isFinite(mins)) handleSelectLeadMinutes(mins);
      } else if (action === 'tune' && channel !== null) {
        onClose();
        onTuneChannel(channel, channelIndex);
      } else if (action === 'favorite' && channel !== null) {
        onToggleFavorite?.(channel);
      } else {
        onClose();
      }
    },
    [
      actions,
      channel,
      channelIndex,
      effectiveHasArchive,
      handleSelectLeadMinutes,
      handleToggleReminder,
      onClose,
      onToggleFavorite,
      onTuneChannel,
      onWatchCatchup,
      programme,
    ],
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

  const durationMin = formatDurationMinutes(programme.start, programme.stop);
  const episodeTag = formatEpisodeTag(programme);
  const badges = resolveProgrammeBadges(programme.flags);
  const genreKey = genreMessageKey(programme.genre);
  const channelName = channel ? formatChannelDisplayName(channel.name, cleanChannelTitles) : null;
  const description = programme.description?.trim() || i18n.t('epg.noDescription');
  const focusedAction = isTv ? (actions[focusedIdx] ?? null) : null;
  const pastHintKey =
    isPast && channel !== null && !canWatchCatchup
      ? catchupAvailability === 'expired'
        ? ('epg.catchupExpired' as const)
        : ('epg.catchupUnavailable' as const)
      : null;

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
          {canWatchCatchup ? (
            <MicroPill
              testID="epg-detail-catchup-pill"
              label={i18n.t('epg.catchupBadge')}
              tone="accent"
              dot
            />
          ) : null}
          {isUpcoming ? (
            <MicroPill testID="epg-detail-upcoming" label={i18n.t('epg.upcoming')} tone="accent" />
          ) : null}
          {isUpcoming && localReminderActive ? (
            <MicroPill
              testID="epg-detail-reminder-scheduled"
              label={i18n.t('epg.reminderScheduled')}
              tone="accent"
              dot
            />
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

        {pastHintKey !== null ? (
          <Text
            testID="epg-detail-catchup-hint"
            style={[theme.typography.caption, { color: theme.colors.textMuted }]}
          >
            {i18n.t(pastHintKey)}
          </Text>
        ) : null}

        {canToggleReminder ? (
          <View testID="epg-detail-reminder-lead-section" style={styles.leadSection}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('epg.reminderLeadLabel')}
            </Text>
            <View style={styles.leadRow}>
              {REMINDER_LEAD_OPTIONS_MIN.map((mins) => (
                <FilterChip
                  key={mins}
                  testID={`epg-detail-reminder-lead-${mins}`}
                  label={i18n.t('epg.durationMinutes', { minutes: mins })}
                  selected={leadMinutes === mins}
                  focusable={!isTv}
                  focused={focusedAction === `lead:${mins}`}
                  onPress={() => handleSelectLeadMinutes(mins)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.actionsRow}>
          {canWatchCatchup && channel !== null && onWatchCatchup !== undefined ? (
            <CtaButton
              testID="epg-detail-catchup"
              variant="primary"
              icon="play"
              label={i18n.t('epg.watchCatchup')}
              focusable={!isTv}
              focused={focusedAction === 'catchup'}
              onPress={() => {
                onClose();
                onWatchCatchup(channel, channelIndex, programme, effectiveHasArchive);
              }}
            />
          ) : null}
          {canToggleReminder ? (
            <CtaButton
              testID="epg-detail-reminder"
              variant={localReminderActive ? 'secondary' : 'primary'}
              icon="bell"
              disabled={reminderBusy}
              label={i18n.t(localReminderActive ? 'epg.cancelReminder' : 'epg.remindMe')}
              focusable={!isTv}
              focused={focusedAction === 'reminder'}
              onPress={() => void handleToggleReminder()}
            />
          ) : null}
          {channel !== null ? (
            <CtaButton
              testID="epg-detail-tune"
              variant={
                canWatchCatchup || (canToggleReminder && !localReminderActive)
                  ? 'secondary'
                  : 'primary'
              }
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
    maxHeight: '84%',
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  header: { gap: 4 },
  pillsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  descScroll: { maxHeight: 200 },
  leadSection: { gap: 6 },
  leadRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    paddingTop: 4,
  },
});
