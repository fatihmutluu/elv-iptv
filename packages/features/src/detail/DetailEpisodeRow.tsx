import type { EpisodeRow, WatchProgressRow } from '@elv/data';
import { computeDownloadProgressRatio, type DownloadRecord, isPlayableDownload } from '@elv/domain';
import {
  ArtworkImage,
  Icon,
  IconButton,
  MicroPill,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { detailProgressRatio, formatEpisodeDuration } from './detail-model';

/** Props of {@link DetailEpisodeRow}. */
export interface DetailEpisodeRowProps {
  readonly episode: EpisodeRow;
  readonly index: number;
  readonly progress: WatchProgressRow | undefined;
  readonly seriesBackdropUri: string | null;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly focused: boolean;
  readonly watchedLabel: string;
  readonly onPressEpisode: (episode: EpisodeRow, index: number) => void;
  readonly downloadsSupported?: boolean;
  readonly downloadRecord?: DownloadRecord | undefined;
  readonly onPressDownload?: (episode: EpisodeRow) => void;
}

function DetailEpisodeRowInner({
  episode,
  index,
  progress,
  seriesBackdropUri,
  isTv,
  isPortrait,
  focused,
  watchedLabel,
  onPressEpisode,
  downloadsSupported = false,
  downloadRecord,
  onPressDownload,
}: DetailEpisodeRowProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const handlePress = useCallback(() => {
    onPressEpisode(episode, index);
  }, [episode, index, onPressEpisode]);

  const handleDownloadPress = useCallback(
    (e?: { stopPropagation?: () => void }) => {
      e?.stopPropagation?.();
      onPressDownload?.(episode);
    },
    [episode, onPressDownload],
  );

  const downloadButtonMeta = (() => {
    if (!downloadsSupported || onPressDownload === undefined) return null;
    if (isPlayableDownload(downloadRecord)) {
      return {
        icon: 'check' as const,
        active: true,
        label: i18n.t('downloads.actionDownloaded'),
      };
    }
    if (downloadRecord?.status === 'downloading' || downloadRecord?.status === 'queued') {
      const pct = Math.round(
        (computeDownloadProgressRatio(downloadRecord.bytesDownloaded, downloadRecord.totalBytes) ??
          0) * 100,
      );
      return {
        icon: 'pause' as const,
        active: true,
        label: i18n.t('downloads.actionDownloading', { percent: pct }),
      };
    }
    if (downloadRecord?.status === 'paused' || downloadRecord?.status === 'failed') {
      return {
        icon: 'download' as const,
        active: false,
        label: i18n.t('downloads.actionResume'),
      };
    }
    return {
      icon: 'download' as const,
      active: false,
      label: i18n.t('downloads.actionDownload'),
    };
  })();

  const epNum = episode.episode ?? index + 1;
  const trimmedTitle = episode.title?.trim() ?? '';
  const heading =
    trimmedTitle.length > 0
      ? i18n.t('detail.episodeNumbered', { episode: epNum, title: trimmedTitle })
      : i18n.t('series.episodeUntitled', { episode: epNum });
  const durationLabel = formatEpisodeDuration(episode.durationSec, i18n.t);
  const isWatched = progress?.watched === true;
  const durationMs =
    progress && progress.durationMs > 0
      ? progress.durationMs
      : episode.durationSec && episode.durationSec > 0
        ? Math.round(episode.durationSec * 1000)
        : 0;
  const ratio =
    !isWatched && progress && progress.positionMs > 0 && durationMs > 0
      ? detailProgressRatio(progress.positionMs, durationMs)
      : undefined;

  const thumbWidth = isPortrait ? 124 : 168;
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const testID = `detail-episode-${index}`;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={durationLabel ? `${heading}, ${durationLabel}` : heading}
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.episodeRow,
        cursor,
        transition,
        {
          borderRadius: theme.radius.card,
          backgroundColor: focused
            ? theme.colors.focusFill
            : pressed
              ? theme.colors.subtleHighlight
              : theme.colors.bgCard,
          borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
          padding: isPortrait ? theme.spacing.xs : theme.spacing.sm,
          gap: isPortrait ? theme.spacing.sm : theme.spacing.md,
          transform: [
            {
              scale: pressed
                ? theme.reduceMotion
                  ? 1
                  : 0.98
                : focused
                  ? theme.focus.buttonScale
                  : 1,
            },
          ],
        },
      ]}
    >
      <View
        style={[
          styles.thumbWrap,
          {
            width: thumbWidth,
            borderRadius: theme.radius.card,
            backgroundColor: theme.colors.bgSurface,
          },
        ]}
      >
        <ArtworkImage
          uri={seriesBackdropUri}
          label={heading}
          aspectRatio={16 / 9}
          maxDecodePx={320}
          borderRadius={theme.radius.card}
        />
        <View
          pointerEvents="none"
          style={[
            styles.playOverlay,
            { backgroundColor: theme.colors.scrimSoft, borderRadius: theme.radius.card },
          ]}
        >
          <View
            style={[
              styles.playCircle,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.scrimStrong,
                borderColor: theme.colors.glassBorder,
              },
            ]}
          >
            <Icon name="play" size={14} color={theme.colors.textPrimary} />
          </View>
        </View>
        {isWatched ? (
          <View pointerEvents="none" style={styles.watchedPillSlot}>
            <MicroPill label={watchedLabel} tone="success" testID={`${testID}-watched`} />
          </View>
        ) : null}
        {ratio !== undefined ? (
          <View
            pointerEvents="none"
            testID={`${testID}-progress`}
            style={[styles.epProgressTrack, { backgroundColor: theme.colors.actionGlassHoverBg }]}
          >
            <View
              testID={`${testID}-progress-fill`}
              style={[
                styles.epProgressFill,
                {
                  width: `${Math.round(ratio * 1000) / 10}%`,
                  backgroundColor: theme.colors.accent,
                },
              ]}
            />
          </View>
        ) : null}
      </View>

      <View style={styles.epMeta}>
        <Text
          numberOfLines={2}
          style={[theme.typography.title, styles.epTitle, { color: theme.colors.textPrimary }]}
        >
          {heading}
        </Text>
        {durationLabel ? (
          <Text
            testID={`${testID}-duration`}
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textMuted, flexShrink: 0 },
            ]}
          >
            {durationLabel}
          </Text>
        ) : null}
      </View>

      {downloadButtonMeta !== null ? (
        <IconButton
          testID={`${testID}-download`}
          icon={downloadButtonMeta.icon}
          active={downloadButtonMeta.active}
          accessibilityLabel={downloadButtonMeta.label}
          focusable={!isTv}
          onPress={handleDownloadPress as () => void}
        />
      ) : null}

      {focused ? (
        <View
          pointerEvents="none"
          testID={`${testID}-focus-ring`}
          style={[
            styles.epFocusRing,
            {
              borderRadius: theme.radius.card + 3,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
}

/** Memoized Cinema Quietude `16:9` episode list row with progress bar, watched pill, and TV focus. */
export const DetailEpisodeRow = memo(DetailEpisodeRowInner);
DetailEpisodeRow.displayName = 'DetailEpisodeRow';

const SKELETON_ROWS = [0, 1, 2];

/** Zero-CLS tonal skeleton placeholder for loading series episodes. */
export function EpisodeSkeletonRows({
  isPortrait,
  padX,
}: {
  readonly isPortrait: boolean;
  readonly padX: number;
}): ReactElement {
  const theme = useTheme();
  const thumbWidth = isPortrait ? 124 : 168;
  return (
    <View
      testID="detail-episodes-loading"
      style={[styles.skeletonList, { paddingHorizontal: padX, gap: theme.spacing.sm }]}
    >
      {SKELETON_ROWS.map((row) => (
        <View
          key={row}
          style={[
            styles.skeletonRow,
            {
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.bgSurface,
              padding: isPortrait ? theme.spacing.xs : theme.spacing.sm,
              gap: isPortrait ? theme.spacing.sm : theme.spacing.md,
            },
          ]}
        >
          <SkeletonBox width={thumbWidth} aspectRatio={16 / 9} />
          <View style={styles.skeletonTextCol}>
            <SkeletonBox width="65%" height={18} />
            <SkeletonBox width="30%" height={14} style={{ marginTop: theme.spacing.xs }} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  episodeRow: { position: 'relative', flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  thumbWrap: { position: 'relative', overflow: 'hidden', flexShrink: 0 },
  playOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  watchedPillSlot: { position: 'absolute', top: 6, left: 6 },
  epProgressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  epProgressFill: { height: '100%' },
  epMeta: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minWidth: 0,
  },
  epTitle: { flex: 1, minWidth: 0 },
  epFocusRing: { position: 'absolute', top: -3, bottom: -3, left: -3, right: -3 },
  skeletonList: { width: '100%' },
  skeletonRow: { flexDirection: 'row', alignItems: 'center' },
  skeletonTextCol: { flex: 1 },
});
