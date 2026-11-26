import {
  computeDownloadProgressRatio,
  type DownloadRecord,
  formatDownloadBytes,
} from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
  ArtworkImage,
  type ContextMenuAnchor,
  Icon,
  IconButton,
  MicroPill,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useContextMenu,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { computeCatalogLayout, type DetailTarget, useDownloads, useRouteActive } from '../shared';
import {
  buildActiveDownloadContextMenuItems,
  buildDownloadContextMenuItems,
  buildOfflinePlayTarget,
  formatDownloadProgressMeta,
  formatDownloadSubtitle,
  partitionDownloads,
  resolveDownloadStatusKey,
} from './downloads-model';

/** Props of {@link DownloadsScreen}. */
export interface DownloadsScreenProps {
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenMultiView?: (target: PlayTarget) => void;
  readonly onOpenDetail?: (target: DetailTarget) => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
}

type TvKeyHandler = Parameters<typeof useKeyInterpreter>[0];

function DownloadsTvKeyBridge({ onEvent }: { readonly onEvent: TvKeyHandler }): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="downloads-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/**
 * Cinema Quietude offline VOD Movies & Series Episodes Downloads screen.
 * Displays active progress queue (Pause / Resume / Cancel), completed offline items
 * (1-click Play offline, Multi-View, Delete, right-click/long-press Context Menu),
 * constructive empty/unsupported states, and full 10-ft TV D-pad navigation.
 */
export function DownloadsScreen({
  onPlay,
  onOpenMultiView,
  onFocusTopNav,
  isActiveScope = true,
}: DownloadsScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const downloads = useDownloads();
  const contextMenu = useContextMenu();
  const { isTv, isPortrait, padX } = computeCatalogLayout(viewport, theme);
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');

  const { active, completed, totalCompletedBytes } = useMemo(
    () => partitionDownloads(downloads.records),
    [downloads.records],
  );

  const flatRows = useMemo(
    () => [
      ...active.map((record) => ({ section: 'active' as const, record })),
      ...completed.map((record) => ({ section: 'completed' as const, record })),
    ],
    [active, completed],
  );

  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const clampedFocusIndex =
    flatRows.length === 0 ? -1 : Math.min(Math.max(0, focusedRowIndex), flatRows.length - 1);

  const handlePlayOffline = useCallback(
    (record: DownloadRecord) => {
      onPlay(buildOfflinePlayTarget(record));
    },
    [onPlay],
  );

  const handleOpenMultiView = useCallback(
    (record: DownloadRecord) => {
      onOpenMultiView?.(buildOfflinePlayTarget(record));
    },
    [onOpenMultiView],
  );

  const handleDelete = useCallback(
    (record: DownloadRecord) => {
      void downloads.remove(record.itemKey);
    },
    [downloads],
  );

  const handleTogglePauseResume = useCallback(
    (record: DownloadRecord) => {
      if (record.status === 'paused' || record.status === 'failed') {
        void downloads.resume(record.itemKey);
      } else {
        void downloads.pause(record.itemKey);
      }
    },
    [downloads],
  );

  const handleCancel = useCallback(
    (record: DownloadRecord) => {
      void downloads.cancel(record.itemKey);
    },
    [downloads],
  );

  const openActiveContextMenu = useCallback(
    (record: DownloadRecord, anchor?: ContextMenuAnchor) => {
      contextMenu.openContextMenu({
        title: record.title,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildActiveDownloadContextMenuItems({
          record,
          t: i18n.t,
          onTogglePauseResume: handleTogglePauseResume,
          onCancel: handleCancel,
        }),
      });
    },
    [contextMenu, handleCancel, handleTogglePauseResume, i18n.t],
  );

  const openCompletedContextMenu = useCallback(
    (record: DownloadRecord, anchor?: ContextMenuAnchor) => {
      contextMenu.openContextMenu({
        title: record.title,
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildDownloadContextMenuItems({
          record,
          t: i18n.t,
          onPlayOffline: handlePlayOffline,
          ...(onOpenMultiView !== undefined ? { onOpenMultiView: handleOpenMultiView } : {}),
          onDelete: handleDelete,
        }),
      });
    },
    [contextMenu, handleDelete, handleOpenMultiView, handlePlayOffline, i18n.t, onOpenMultiView],
  );

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      const isMenuTrigger =
        (event.kind === 'press' && (event.key === 'menu' || event.key === 'info')) ||
        (event.kind === 'long' && event.key === 'select');
      if (isMenuTrigger) {
        const entry = flatRows[clampedFocusIndex];
        if (!entry) return false;
        if (entry.section === 'completed') {
          openCompletedContextMenu(entry.record);
        } else {
          openActiveContextMenu(entry.record);
        }
        return true;
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      if (event.key === 'back') {
        onFocusTopNav?.();
        return true;
      }
      if (flatRows.length === 0) {
        if (event.key === 'up') {
          onFocusTopNav?.();
          return true;
        }
        return false;
      }
      if (event.key === 'up') {
        if (clampedFocusIndex <= 0) {
          onFocusTopNav?.();
          return true;
        }
        setFocusedRowIndex(clampedFocusIndex - 1);
        return true;
      }
      if (event.key === 'down') {
        if (clampedFocusIndex < flatRows.length - 1) {
          setFocusedRowIndex(clampedFocusIndex + 1);
        }
        return true;
      }
      if (event.key === 'select') {
        const entry = flatRows[clampedFocusIndex];
        if (!entry) return false;
        if (entry.section === 'completed') {
          handlePlayOffline(entry.record);
        } else {
          handleTogglePauseResume(entry.record);
        }
        return true;
      }
      return false;
    },
    [
      clampedFocusIndex,
      flatRows,
      handlePlayOffline,
      handleTogglePauseResume,
      onFocusTopNav,
      openActiveContextMenu,
      openCompletedContextMenu,
    ],
  );

  const hasAnyRecords = active.length > 0 || completed.length > 0;
  const topPad = isTv ? 16 : 12;

  return (
    <View
      testID="downloads-screen"
      style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}
    >
      {isTv && isActiveScope && !contextMenu.isOpen ? (
        <DownloadsTvKeyBridge onEvent={handleTvKey} />
      ) : null}

      <ScrollView
        testID="downloads-scroll"
        {...(isTv ? { focusable: false } : {})}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: topPad,
          paddingHorizontal: padX,
          paddingBottom: theme.spacing.xl + viewport.safeArea.bottom + 24,
          gap: theme.spacing.lg,
        }}
      >
        <View style={styles.headerRow}>
          <Text style={[theme.typography.h1, { color: theme.colors.textPrimary }]}>
            {i18n.t('downloads.title')}
          </Text>
          {completed.length > 0 ? (
            <MicroPill
              testID="downloads-storage-badge"
              tone="accent"
              label={i18n.t('downloads.storageUsed', {
                size: formatDownloadBytes(totalCompletedBytes),
              })}
            />
          ) : null}
        </View>

        {!downloads.supported && !hasAnyRecords ? (
          <View
            testID="downloads-unsupported-state"
            style={[
              styles.noticeBox,
              {
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
        ) : !hasAnyRecords ? (
          <View
            testID="downloads-empty-state"
            style={[
              styles.noticeBox,
              {
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
        ) : null}

        {active.length > 0 ? (
          <View testID="downloads-active-section" style={{ gap: theme.spacing.sm }}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('downloads.activeSection')}
            </Text>
            {active.map((record, idx) => {
              const focused = isTv && isActiveScope && clampedFocusIndex === idx;
              const ratio =
                computeDownloadProgressRatio(record.bytesDownloaded, record.totalBytes) ?? 0;
              const subtitle = formatDownloadSubtitle(record);
              const isPausedOrFailed = record.status === 'paused' || record.status === 'failed';
              return (
                <View
                  key={record.id}
                  testID={`download-active-row-${record.itemKey}`}
                  {...({
                    onContextMenu: (e: {
                      preventDefault?: () => void;
                      nativeEvent?: { pageX?: number; pageY?: number };
                    }) => {
                      e.preventDefault?.();
                      const x = e.nativeEvent?.pageX;
                      const y = e.nativeEvent?.pageY;
                      openActiveContextMenu(
                        record,
                        typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined,
                      );
                    },
                  } as object)}
                  style={[
                    styles.itemRow,
                    transition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgCard,
                      borderColor: focused
                        ? theme.colors.focusRingColor
                        : theme.colors.surfaceBorder,
                      padding: isPortrait ? theme.spacing.sm : theme.spacing.md,
                      gap: theme.spacing.md,
                    },
                  ]}
                >
                  <ArtworkImage
                    uri={record.poster ?? null}
                    label={record.title}
                    aspectRatio={2 / 3}
                    maxDecodePx={160}
                    borderRadius={theme.radius.card}
                    style={styles.posterThumb}
                  />
                  <View style={styles.rowBody}>
                    <Text
                      numberOfLines={1}
                      style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                    >
                      {record.title}
                    </Text>
                    {subtitle ? (
                      <Text
                        numberOfLines={1}
                        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                      >
                        {subtitle}
                      </Text>
                    ) : null}
                    <View
                      testID={`download-progress-track-${record.itemKey}`}
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
                      <Text
                        testID={`download-status-${record.itemKey}`}
                        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                      >
                        {i18n.t(resolveDownloadStatusKey(record))}
                      </Text>
                      <Text
                        style={[
                          theme.typography.caption,
                          TABULAR_NUMS_STYLE,
                          { color: theme.colors.textMuted },
                        ]}
                      >
                        {formatDownloadProgressMeta(record)}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.rowActions}>
                    <IconButton
                      testID={`download-toggle-${record.itemKey}`}
                      icon={isPausedOrFailed ? 'play' : 'pause'}
                      accessibilityLabel={
                        isPausedOrFailed
                          ? i18n.t('downloads.actionResume')
                          : i18n.t('downloads.actionPause')
                      }
                      focusable={!isTv}
                      onPress={() => handleTogglePauseResume(record)}
                    />
                    <IconButton
                      testID={`download-cancel-${record.itemKey}`}
                      icon="close"
                      accessibilityLabel={i18n.t('downloads.actionCancel')}
                      focusable={!isTv}
                      onPress={() => handleCancel(record)}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {completed.length > 0 ? (
          <View testID="downloads-completed-section" style={{ gap: theme.spacing.sm }}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('downloads.completedSection')}
            </Text>
            {completed.map((record, idx) => {
              const flatIdx = active.length + idx;
              const focused = isTv && isActiveScope && clampedFocusIndex === flatIdx;
              const subtitle = formatDownloadSubtitle(record);
              const sizeBytes =
                record.totalBytes !== null && record.totalBytes > 0
                  ? record.totalBytes
                  : record.bytesDownloaded;
              return (
                <View
                  key={record.id}
                  testID={`download-completed-row-${record.itemKey}`}
                  {...({
                    onContextMenu: (e: {
                      preventDefault?: () => void;
                      nativeEvent?: { pageX?: number; pageY?: number };
                    }) => {
                      e.preventDefault?.();
                      const x = e.nativeEvent?.pageX;
                      const y = e.nativeEvent?.pageY;
                      openCompletedContextMenu(
                        record,
                        typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined,
                      );
                    },
                  } as object)}
                  style={[
                    styles.itemRow,
                    transition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgCard,
                      borderColor: focused
                        ? theme.colors.focusRingColor
                        : theme.colors.surfaceBorder,
                      padding: isPortrait ? theme.spacing.sm : theme.spacing.md,
                      gap: theme.spacing.md,
                    },
                  ]}
                >
                  <Pressable
                    testID={`download-completed-body-${record.itemKey}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${record.title} — ${i18n.t('downloads.actionPlayOffline')}`}
                    focusable={!isTv}
                    onPress={() => handlePlayOffline(record)}
                    onLongPress={() => openCompletedContextMenu(record)}
                    style={({ pressed }) => [
                      styles.completedBodyTrigger,
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
                      uri={record.poster ?? null}
                      label={record.title}
                      aspectRatio={2 / 3}
                      maxDecodePx={160}
                      borderRadius={theme.radius.card}
                      style={styles.posterThumb}
                    />
                    <View style={styles.rowBody}>
                      <View style={styles.titleLine}>
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
                        <MicroPill
                          testID={`download-offline-badge-${record.itemKey}`}
                          tone="success"
                          label={i18n.t('downloads.offlineBadge')}
                        />
                      </View>
                      {subtitle ? (
                        <Text
                          numberOfLines={1}
                          style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                        >
                          {subtitle}
                        </Text>
                      ) : null}
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
                      testID={`download-play-${record.itemKey}`}
                      icon="play"
                      active
                      accessibilityLabel={i18n.t('downloads.actionPlayOffline')}
                      focusable={!isTv}
                      onPress={() => handlePlayOffline(record)}
                    />
                    {onOpenMultiView !== undefined ? (
                      <IconButton
                        testID={`download-multiview-${record.itemKey}`}
                        icon="multiview"
                        accessibilityLabel={i18n.t('context.openMultiView')}
                        focusable={!isTv}
                        onPress={() => handleOpenMultiView(record)}
                      />
                    ) : null}
                    <IconButton
                      testID={`download-delete-${record.itemKey}`}
                      icon="trash"
                      accessibilityLabel={i18n.t('downloads.actionDelete')}
                      focusable={!isTv}
                      onPress={() => handleDelete(record)}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
  },
  noticeBox: {
    borderWidth: 1,
    alignItems: 'flex-start',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
  },
  completedBodyTrigger: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  posterThumb: {
    width: 52,
    height: 78,
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
  progressTrack: {
    height: 4,
    width: '100%',
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: {
    height: '100%',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 2,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
});
