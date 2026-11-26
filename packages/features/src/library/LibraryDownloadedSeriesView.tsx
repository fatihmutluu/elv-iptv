import { type DownloadRecord, formatDownloadBytes } from '@elv/domain';
import {
  ArtworkImage,
  type ContextMenuAnchor,
  Icon,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  type DownloadedSeriesGroup,
  formatDownloadedSeriesSubtitle,
  formatEpisodeCode,
} from './library-model';

/** Props of {@link LibraryDownloadedSeriesView}. */
export interface LibraryDownloadedSeriesViewProps {
  readonly group: DownloadedSeriesGroup;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex?: number | null;
  readonly onBack: () => void;
  readonly onOpenSeriesDetail?: (() => void) | undefined;
  readonly onPlayOffline: (record: DownloadRecord) => void;
  readonly onOpenMultiView?: ((record: DownloadRecord) => void) | undefined;
  readonly onDelete: (record: DownloadRecord) => void;
  readonly onContextMenu: (record: DownloadRecord, anchor?: ContextMenuAnchor) => void;
}

/** Drill-down view listing all completed offline episodes for a grouped downloaded series. */
export function LibraryDownloadedSeriesView({
  group,
  padX,
  isTv,
  focusedIndex = null,
  onBack,
  onOpenSeriesDetail,
  onPlayOffline,
  onOpenMultiView,
  onDelete,
  onContextMenu,
}: LibraryDownloadedSeriesViewProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'opacity, background-color, border-color');

  const countLabel = formatDownloadedSeriesSubtitle(group, i18n.t);

  return (
    <View
      testID={`library-downloaded-series-view-${group.groupId}`}
      style={[styles.root, { paddingHorizontal: padX }]}
    >
      <View style={styles.headerRow}>
        <Pressable
          testID="library-series-downloads-back"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('library.backToTab')}
          focusable={!isTv}
          onPress={onBack}
          style={({ pressed }) => [
            styles.headerBtn,
            cursor,
            transition,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: pressed ? theme.colors.actionGlassHoverBg : theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
            },
          ]}
        >
          <Icon name="chevronLeft" size={16} color={theme.colors.textPrimary} />
          <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
            {i18n.t('library.backToTab')}
          </Text>
        </Pressable>

        <View style={styles.headerMeta}>
          <Text
            numberOfLines={1}
            style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
          >
            {group.seriesTitle}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {countLabel} · {formatDownloadBytes(group.totalBytes)}
          </Text>
        </View>

        {onOpenSeriesDetail !== undefined ? (
          <Pressable
            testID="library-series-downloads-detail"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('context.goToDetails')}
            focusable={!isTv}
            onPress={onOpenSeriesDetail}
            style={({ pressed }) => [
              styles.headerBtn,
              cursor,
              transition,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: pressed ? theme.colors.actionGlassHoverBg : theme.colors.bgCard,
                borderColor: theme.colors.surfaceBorder,
              },
            ]}
          >
            <Icon name="info" size={16} color={theme.colors.textPrimary} />
            <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
              {i18n.t('context.goToDetails')}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.list}>
        {group.episodes.map((record, idx) => {
          const isFocused = isTv && focusedIndex === idx;
          const code = formatEpisodeCode(record.season, record.episodeNum);
          const sizeBytes =
            record.totalBytes !== null && record.totalBytes > 0
              ? record.totalBytes
              : record.bytesDownloaded;
          return (
            <View
              key={record.id}
              testID={`library-downloaded-episode-row-${record.itemKey}`}
              {...({
                onContextMenu: (e: {
                  preventDefault?: () => void;
                  nativeEvent?: { pageX?: number; pageY?: number };
                }) => {
                  e.preventDefault?.();
                  const x = e.nativeEvent?.pageX;
                  const y = e.nativeEvent?.pageY;
                  onContextMenu(
                    record,
                    typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined,
                  );
                },
              } as object)}
              style={[
                styles.row,
                transition,
                {
                  borderRadius: theme.radius.card,
                  backgroundColor: isFocused ? theme.colors.focusFill : theme.colors.bgCard,
                  borderColor: isFocused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
                  padding: theme.spacing.sm,
                  gap: theme.spacing.md,
                },
              ]}
            >
              <Pressable
                testID={`library-downloaded-episode-body-${record.itemKey}`}
                accessibilityRole="button"
                accessibilityLabel={`${record.title} — ${i18n.t('downloads.actionPlayOffline')}`}
                focusable={!isTv}
                onPress={() => onPlayOffline(record)}
                onLongPress={() => onContextMenu(record)}
                style={({ pressed }) => [
                  styles.bodyTrigger,
                  cursor,
                  transition,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: pressed ? theme.colors.subtleHighlight : 'transparent',
                    gap: theme.spacing.md,
                  },
                ]}
              >
                <ArtworkImage
                  uri={record.poster ?? group.posterUri}
                  label={record.title}
                  aspectRatio={16 / 9}
                  maxDecodePx={200}
                  borderRadius={theme.radius.card}
                  style={styles.thumb}
                />
                <View style={styles.rowBody}>
                  <View style={styles.titleLine}>
                    {code !== null ? (
                      <Text
                        style={[
                          theme.typography.caption,
                          TABULAR_NUMS_STYLE,
                          { color: theme.colors.accent },
                        ]}
                      >
                        {code}
                      </Text>
                    ) : null}
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.title,
                        styles.flexTitle,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {record.title}
                    </Text>
                    <MicroPill tone="success" label={i18n.t('downloads.offlineBadge')} />
                  </View>
                  <Text
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {formatDownloadBytes(sizeBytes)}
                  </Text>
                </View>
              </Pressable>

              <View style={styles.rowActions}>
                <IconButton
                  testID={`library-downloaded-episode-play-${record.itemKey}`}
                  icon="play"
                  active
                  accessibilityLabel={i18n.t('downloads.actionPlayOffline')}
                  focusable={!isTv}
                  onPress={() => onPlayOffline(record)}
                />
                {onOpenMultiView !== undefined ? (
                  <IconButton
                    testID={`library-downloaded-episode-multiview-${record.itemKey}`}
                    icon="multiview"
                    accessibilityLabel={i18n.t('context.openMultiView')}
                    focusable={!isTv}
                    onPress={() => onOpenMultiView(record)}
                  />
                ) : null}
                <IconButton
                  testID={`library-downloaded-episode-delete-${record.itemKey}`}
                  icon="trash"
                  accessibilityLabel={i18n.t('downloads.actionDelete')}
                  focusable={!isTv}
                  onPress={() => onDelete(record)}
                />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
  },
  headerMeta: {
    flex: 1,
    minWidth: 160,
    gap: 2,
  },
  list: {
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  bodyTrigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumb: {
    width: 96,
    height: 54,
    flexShrink: 0,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  flexTitle: {
    flexShrink: 1,
    minWidth: 0,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
});
