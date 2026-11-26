import {
  computeDownloadProgressRatio,
  type DownloadRecord,
  formatDownloadBytes,
} from '@elv/domain';
import {
  ArtworkImage,
  type ContextMenuAnchor,
  Icon,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  Tooltip,
  useI18n,
  useTheme,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LibraryRailSection } from './LibraryRailSection';
import {
  type DownloadedSeriesGroup,
  formatDownloadedSeriesSubtitle,
  formatLibraryDownloadProgressMeta,
  type LibraryCardItem,
  resolveLibraryDownloadStatusKey,
} from './library-model';

/** Props of {@link LibraryDownloadsTab}. */
export interface LibraryDownloadsTabProps {
  readonly supported: boolean;
  readonly active: readonly DownloadRecord[];
  readonly completedMovieCards: readonly LibraryCardItem[];
  readonly seriesGroups: readonly DownloadedSeriesGroup[];
  readonly totalCompletedBytes: number;
  readonly cardWidth: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedActiveIndex?: number | null;
  readonly focusedMovieIndex?: number | null;
  readonly focusedSeriesIndex?: number | null;
  readonly onTogglePauseResume: (record: DownloadRecord) => void;
  readonly onCancelActive: (record: DownloadRecord) => void;
  readonly onContextMenuActive: (record: DownloadRecord, anchor?: ContextMenuAnchor) => void;
  readonly onPressMovie: (item: LibraryCardItem) => void;
  readonly onContextMenuMovie: (item: LibraryCardItem, anchor?: ContextMenuAnchor) => void;
  readonly onPressSeriesGroup: (group: DownloadedSeriesGroup) => void;
  readonly onSeeAllMovies: () => void;
  readonly onSeeAllSeries: () => void;
}

/** `Downloads` sub-tab inside {@link LibraryScreen} with active strip, movies rail, and grouped series rail. */
export function LibraryDownloadsTab({
  supported,
  active,
  completedMovieCards,
  seriesGroups,
  totalCompletedBytes,
  cardWidth,
  padX,
  isTv,
  focusedActiveIndex = null,
  focusedMovieIndex = null,
  focusedSeriesIndex = null,
  onTogglePauseResume,
  onCancelActive,
  onContextMenuActive,
  onPressMovie,
  onContextMenuMovie,
  onPressSeriesGroup,
  onSeeAllMovies,
  onSeeAllSeries,
}: LibraryDownloadsTabProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  const hasCompleted = completedMovieCards.length > 0 || seriesGroups.length > 0;
  const hasAny = active.length > 0 || hasCompleted;

  const seriesGroupById = new Map<string, DownloadedSeriesGroup>();
  const seriesCards: LibraryCardItem[] = seriesGroups.map((group) => {
    seriesGroupById.set(group.groupId, group);
    return {
      id: group.groupId,
      itemKey: group.seriesKey ?? group.groupId,
      sourceId: group.sourceId,
      kind: 'series',
      title: group.seriesTitle,
      imageUri: group.posterUri,
      subtitle: formatDownloadedSeriesSubtitle(group, i18n.t),
      ...(group.hasNewEpisodes ? { badge: 'NEW' } : {}),
    };
  });

  if (!supported && !hasAny) {
    return (
      <View
        testID="library-downloads-unsupported"
        style={[
          styles.noticeBox,
          {
            marginHorizontal: padX,
            borderRadius: theme.radius.card,
            backgroundColor: theme.colors.bgCard,
            borderColor: theme.colors.surfaceBorder,
            padding: theme.spacing.lg,
            gap: theme.spacing.xs,
          },
        ]}
      >
        <Icon name="download" size={28} color={theme.colors.textMuted} />
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
          {i18n.t('downloads.unsupportedTitle')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('downloads.unsupportedBody')}
        </Text>
      </View>
    );
  }

  if (!hasAny) {
    return (
      <View
        testID="library-downloads-empty"
        style={[
          styles.noticeBox,
          {
            marginHorizontal: padX,
            borderRadius: theme.radius.card,
            backgroundColor: theme.colors.bgCard,
            borderColor: theme.colors.surfaceBorder,
            padding: theme.spacing.lg,
            gap: theme.spacing.xs,
          },
        ]}
      >
        <Icon name="download" size={28} color={theme.colors.textMuted} />
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
          {i18n.t('downloads.emptyTitle')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('downloads.emptyBody')}
        </Text>
      </View>
    );
  }

  return (
    <View testID="library-downloads-tab" style={styles.root}>
      {hasCompleted ? (
        <View style={[styles.storageRow, { paddingHorizontal: padX }]}>
          <MicroPill
            testID="library-downloads-storage-badge"
            tone="accent"
            label={i18n.t('downloads.storageUsed', {
              size: formatDownloadBytes(totalCompletedBytes),
            })}
          />
        </View>
      ) : null}

      {active.length > 0 ? (
        <View
          testID="library-downloads-active-strip"
          style={[styles.activeSection, { paddingHorizontal: padX }]}
        >
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {i18n.t('downloads.activeSection')}
          </Text>
          {active.map((record, idx) => {
            const focused = isTv && focusedActiveIndex === idx;
            const ratio =
              computeDownloadProgressRatio(record.bytesDownloaded, record.totalBytes) ?? 0;
            const isPausedOrFailed = record.status === 'paused' || record.status === 'failed';
            const toggleLabel = isPausedOrFailed
              ? i18n.t('downloads.actionResume')
              : i18n.t('downloads.actionPause');
            const cancelLabel = i18n.t('downloads.actionCancel');
            return (
              <View
                key={record.id}
                testID={`library-download-active-row-${record.itemKey}`}
                {...({
                  onContextMenu: (e: {
                    preventDefault?: () => void;
                    nativeEvent?: { pageX?: number; pageY?: number };
                  }) => {
                    e.preventDefault?.();
                    const x = e.nativeEvent?.pageX;
                    const y = e.nativeEvent?.pageY;
                    onContextMenuActive(
                      record,
                      typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined,
                    );
                  },
                } as object)}
                style={[
                  styles.activeRow,
                  transition,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgCard,
                    borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
                    padding: theme.spacing.sm,
                    gap: theme.spacing.md,
                  },
                ]}
              >
                <ArtworkImage
                  uri={record.poster ?? null}
                  label={record.title}
                  aspectRatio={2 / 3}
                  maxDecodePx={120}
                  borderRadius={theme.radius.card}
                  style={styles.activeThumb}
                />
                <View style={styles.activeBody}>
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                  >
                    {record.title}
                  </Text>
                  <View
                    style={[
                      styles.progressTrack,
                      {
                        borderRadius: theme.radius.pill,
                        backgroundColor: theme.colors.actionGlassHoverBg,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${Math.round(ratio * 1000) / 10}%`,
                          backgroundColor:
                            record.status === 'failed'
                              ? theme.colors.liveColor
                              : theme.colors.accent,
                        },
                      ]}
                    />
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                      {i18n.t(resolveLibraryDownloadStatusKey(record))}
                    </Text>
                    <Text
                      style={[
                        theme.typography.caption,
                        TABULAR_NUMS_STYLE,
                        { color: theme.colors.textMuted },
                      ]}
                    >
                      {formatLibraryDownloadProgressMeta(record)}
                    </Text>
                  </View>
                </View>
                <View style={styles.activeActions}>
                  <Tooltip content={toggleLabel}>
                    <IconButton
                      testID={`library-download-toggle-${record.itemKey}`}
                      icon={isPausedOrFailed ? 'play' : 'pause'}
                      accessibilityLabel={toggleLabel}
                      focusable={!isTv}
                      onPress={() => onTogglePauseResume(record)}
                    />
                  </Tooltip>
                  <Tooltip content={cancelLabel}>
                    <IconButton
                      testID={`library-download-cancel-${record.itemKey}`}
                      icon="close"
                      accessibilityLabel={cancelLabel}
                      focusable={!isTv}
                      onPress={() => onCancelActive(record)}
                    />
                  </Tooltip>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      <LibraryRailSection
        railId="downloaded-movies"
        title={i18n.t('library.railDownloadedMovies')}
        items={completedMovieCards}
        variant="poster"
        cardWidth={cardWidth}
        padX={padX}
        isTv={isTv}
        focusedCardIndex={focusedMovieIndex}
        onPressItem={onPressMovie}
        onContextMenuItem={onContextMenuMovie}
        onSeeAll={onSeeAllMovies}
      />

      <LibraryRailSection
        railId="downloaded-series"
        title={i18n.t('library.railDownloadedSeries')}
        items={seriesCards}
        variant="poster"
        cardWidth={cardWidth}
        padX={padX}
        isTv={isTv}
        focusedCardIndex={focusedSeriesIndex}
        onPressItem={(item) => {
          const group = seriesGroupById.get(item.id);
          if (group) onPressSeriesGroup(group);
        }}
        onSeeAll={onSeeAllSeries}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 20,
  },
  storageRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  noticeBox: {
    borderWidth: 1,
    alignItems: 'flex-start',
  },
  activeSection: {
    gap: 10,
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  activeThumb: {
    width: 44,
    height: 66,
    flexShrink: 0,
  },
  activeBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  progressTrack: {
    height: 4,
    width: '100%',
    overflow: 'hidden',
    marginTop: 2,
  },
  progressFill: {
    height: '100%',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  activeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
});
