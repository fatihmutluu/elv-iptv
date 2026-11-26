import {
  computeDownloadProgressRatio,
  type DownloadRecord,
  formatDownloadBytes,
  isPlayableDownload,
} from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { ContextMenuItem } from '@elv/ui-kit';
import type { PlayTarget } from '../ports/play-target';

/** Partitioned download lists and total completed offline storage bytes. */
export interface PartitionedDownloads {
  readonly active: readonly DownloadRecord[];
  readonly completed: readonly DownloadRecord[];
  readonly totalCompletedBytes: number;
}

/** Splits download records into active/failed queue items vs playable completed items. */
export function partitionDownloads(records: readonly DownloadRecord[]): PartitionedDownloads {
  const active: DownloadRecord[] = [];
  const completed: DownloadRecord[] = [];
  let totalCompletedBytes = 0;

  for (const record of records) {
    if (isPlayableDownload(record)) {
      completed.push(record);
      totalCompletedBytes +=
        record.totalBytes !== null && record.totalBytes > 0
          ? record.totalBytes
          : Math.max(0, record.bytesDownloaded);
    } else if (record.status !== 'canceled') {
      active.push(record);
    }
  }

  return { active, completed, totalCompletedBytes };
}

/** Formats an episode's `Series · SxEy` subtitle, or returns `null` for standalone movies. */
export function formatDownloadSubtitle(record: DownloadRecord): string | null {
  if (record.kind !== 'episode') return null;
  const parts: string[] = [];
  const series = record.seriesTitle?.trim();
  if (series) parts.push(series);
  if (record.season != null && record.episodeNum != null) {
    parts.push(`S${record.season}E${record.episodeNum}`);
  } else if (record.episodeNum != null) {
    parts.push(`E${record.episodeNum}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Localized status message key returned by {@link resolveDownloadStatusKey}. */
export type DownloadStatusMessageId =
  | 'downloads.statusPausedForPlayback'
  | 'downloads.statusQueued'
  | 'downloads.statusDownloading'
  | 'downloads.statusPaused'
  | 'downloads.statusFailed'
  | 'downloads.statusCompleted';

/** Resolves the localized status message key for an active or completed download record. */
export function resolveDownloadStatusKey(record: DownloadRecord): DownloadStatusMessageId {
  if (record.pausedForPlayback === true) return 'downloads.statusPausedForPlayback';
  switch (record.status) {
    case 'queued':
      return 'downloads.statusQueued';
    case 'downloading':
      return 'downloads.statusDownloading';
    case 'paused':
      return 'downloads.statusPaused';
    case 'failed':
      return 'downloads.statusFailed';
    case 'completed':
      return 'downloads.statusCompleted';
    default:
      return 'downloads.statusQueued';
  }
}

/** Formats `bytesDownloaded / totalBytes` (and percentage when total is known) for active rows. */
export function formatDownloadProgressMeta(record: DownloadRecord): string {
  const downloaded = formatDownloadBytes(record.bytesDownloaded);
  if (record.totalBytes !== null && record.totalBytes > 0) {
    const ratio = computeDownloadProgressRatio(record.bytesDownloaded, record.totalBytes) ?? 0;
    const pct = Math.round(ratio * 100);
    return `${downloaded} / ${formatDownloadBytes(record.totalBytes)} · ${pct}%`;
  }
  return downloaded;
}

/** Builds a zero-connection offline {@link PlayTarget} from a completed {@link DownloadRecord}. */
export function buildOfflinePlayTarget(record: DownloadRecord): PlayTarget {
  const subtitle = formatDownloadSubtitle(record);
  return {
    itemKey: record.itemKey,
    sourceId: record.sourceId,
    title: record.title,
    kind: 'vod',
    itemKind: record.kind,
    isLocalOffline: true,
    localFileUri: record.localUri,
    ...(record.poster != null ? { logo: record.poster } : {}),
    ...(subtitle !== null ? { subtitle } : {}),
    ...(record.season != null ? { season: record.season } : {}),
    ...(record.episodeNum != null ? { episode: record.episodeNum } : {}),
  };
}

/** Builds context menu actions (Pause/Resume, Cancel) for an active or failed download row. */
export function buildActiveDownloadContextMenuItems(params: {
  readonly record: DownloadRecord;
  readonly t: AppI18n['t'];
  readonly onTogglePauseResume: (record: DownloadRecord) => void;
  readonly onCancel: (record: DownloadRecord) => void;
}): ContextMenuItem[] {
  const { record, t, onTogglePauseResume, onCancel } = params;
  const isPausedOrFailed = record.status === 'paused' || record.status === 'failed';
  return [
    {
      id: isPausedOrFailed ? 'resume-download' : 'pause-download',
      label: isPausedOrFailed ? t('downloads.actionResume') : t('downloads.actionPause'),
      icon: isPausedOrFailed ? 'play' : 'pause',
      testID: 'downloads-context-toggle',
      onSelect: () => onTogglePauseResume(record),
    },
    {
      id: 'cancel-download',
      label: t('downloads.actionCancel'),
      icon: 'close',
      destructive: true,
      testID: 'downloads-context-cancel',
      onSelect: () => onCancel(record),
    },
  ];
}

/** Builds right-click / long-press context menu actions for a completed offline download card. */
export function buildDownloadContextMenuItems(params: {
  readonly record: DownloadRecord;
  readonly t: AppI18n['t'];
  readonly onPlayOffline: (record: DownloadRecord) => void;
  readonly onOpenMultiView?: ((record: DownloadRecord) => void) | undefined;
  readonly onDelete: (record: DownloadRecord) => void;
}): ContextMenuItem[] {
  const { record, t, onPlayOffline, onOpenMultiView, onDelete } = params;
  const items: ContextMenuItem[] = [
    {
      id: 'play-offline',
      label: t('downloads.actionPlayOffline'),
      icon: 'play',
      testID: 'downloads-context-play',
      onSelect: () => onPlayOffline(record),
    },
  ];
  if (onOpenMultiView !== undefined) {
    items.push({
      id: 'open-multiview',
      label: t('context.openMultiView'),
      icon: 'multiview',
      testID: 'downloads-context-multiview',
      onSelect: () => onOpenMultiView(record),
    });
  }
  items.push({
    id: 'delete-download',
    label: t('downloads.actionDelete'),
    icon: 'trash',
    destructive: true,
    testID: 'downloads-context-delete',
    onSelect: () => onDelete(record),
  });
  return items;
}
