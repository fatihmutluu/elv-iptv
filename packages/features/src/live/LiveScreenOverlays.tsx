import type {
  CatalogService,
  ItemRow,
  LiveFavoriteFolderRecord,
  ProgrammeRow,
  SourceRow,
} from '@elv/data';
import type { ReactElement } from 'react';
import { ChannelManagementOverlay } from './ChannelManagementOverlay';
import { EpgProgrammeDetailModal } from './EpgProgrammeDetailModal';
import { LiveContextMenu } from './LiveContextMenu';
import {
  LiveFavoriteFolderModal,
  type LiveFavoriteFolderModalMode,
} from './LiveFavoriteFolderModal';

/** Props of {@link LiveScreenOverlays}. */
export interface LiveScreenOverlaysProps {
  readonly catalog: CatalogService;
  readonly readySources: readonly SourceRow[];
  readonly isTv: boolean;
  readonly cleanChannelTitles: boolean;
  readonly nowMs: number;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoriteCount: number;
  readonly contextMenu: {
    readonly channel: ItemRow;
    readonly index: number;
    readonly programme: ProgrammeRow | null;
  } | null;
  readonly contextFavIndex: number;
  readonly detailModal: {
    readonly channel: ItemRow;
    readonly index: number;
    readonly programme: ProgrammeRow;
  } | null;
  readonly channelManagerOpen: boolean;
  readonly folderModal: LiveFavoriteFolderModalMode | null;
  readonly folders: readonly LiveFavoriteFolderRecord[];
  readonly assignmentByItemKey: ReadonlyMap<string, string>;
  readonly onPlay: (channel: ItemRow, index: number) => void;
  readonly onOpenMultiView?: (channel: ItemRow, index: number) => void;
  readonly onOpenPopout?: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite: (channel: ItemRow) => void;
  readonly onMoveToFolder?: (channel: ItemRow) => void;
  readonly onMoveFavorite: (direction: 'up' | 'down') => void;
  readonly onShowProgrammeDetails: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow,
  ) => void;
  readonly onHideChannel?: (channel: ItemRow) => void;
  readonly onManageChannels?: () => void;
  readonly onWatchCatchup: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow,
    hasArchive?: boolean,
  ) => void;
  readonly onReminderChanged?: () => void;
  readonly onChannelsMutated: () => void;
  readonly onAssignFolder: (channel: ItemRow, folderId: string | null) => Promise<boolean>;
  readonly onCreateFolder: (name: string) => Promise<LiveFavoriteFolderRecord | null>;
  readonly onRenameFolder: (id: string, name: string) => Promise<boolean>;
  readonly onDeleteFolder: (id: string) => Promise<boolean>;
  readonly onCloseContextMenu: () => void;
  readonly onCloseDetailModal: () => void;
  readonly onCloseChannelManager: () => void;
  readonly onCloseFolderModal: () => void;
}

/** Groups in-tree Live TV overlay sheets (`LiveContextMenu`, `ChannelManagementOverlay`, `EpgProgrammeDetailModal`, `LiveFavoriteFolderModal`). */
export function LiveScreenOverlays(p: LiveScreenOverlaysProps): ReactElement {
  const currentFolderId =
    p.folderModal?.kind === 'move'
      ? (p.assignmentByItemKey.get(p.folderModal.channel.key) ?? null)
      : null;

  return (
    <>
      <LiveContextMenu
        visible={p.contextMenu !== null}
        channel={p.contextMenu?.channel ?? null}
        channelIndex={p.contextMenu?.index ?? 0}
        programme={p.contextMenu?.programme ?? null}
        isFavorite={p.contextMenu !== null && p.favoriteKeys.has(p.contextMenu.channel.key)}
        isTv={p.isTv}
        cleanChannelTitles={p.cleanChannelTitles}
        onPlay={p.onPlay}
        {...(p.onOpenMultiView !== undefined ? { onOpenMultiView: p.onOpenMultiView } : {})}
        {...(p.onOpenPopout !== undefined ? { onOpenPopout: p.onOpenPopout } : {})}
        onToggleFavorite={p.onToggleFavorite}
        {...(p.onMoveToFolder !== undefined ? { onMoveToFolder: p.onMoveToFolder } : {})}
        canMoveUp={p.contextFavIndex > 0}
        canMoveDown={p.contextFavIndex >= 0 && p.contextFavIndex < p.favoriteCount - 1}
        onMoveFavorite={p.onMoveFavorite}
        onShowProgrammeDetails={p.onShowProgrammeDetails}
        {...(p.onHideChannel !== undefined ? { onHideChannel: p.onHideChannel } : {})}
        {...(p.onManageChannels !== undefined ? { onManageChannels: p.onManageChannels } : {})}
        onClose={p.onCloseContextMenu}
      />

      <ChannelManagementOverlay
        visible={p.channelManagerOpen}
        catalog={p.catalog}
        sources={p.readySources}
        onMutated={p.onChannelsMutated}
        onClose={p.onCloseChannelManager}
      />

      <EpgProgrammeDetailModal
        visible={p.detailModal !== null}
        channel={p.detailModal?.channel ?? null}
        channelIndex={p.detailModal?.index ?? 0}
        programme={p.detailModal?.programme ?? null}
        nowMs={p.nowMs}
        isFavorite={p.detailModal !== null && p.favoriteKeys.has(p.detailModal.channel.key)}
        isTv={p.isTv}
        cleanChannelTitles={p.cleanChannelTitles}
        catalog={p.catalog}
        onTuneChannel={p.onPlay}
        onWatchCatchup={p.onWatchCatchup}
        onToggleFavorite={p.onToggleFavorite}
        {...(p.onReminderChanged !== undefined ? { onReminderChanged: p.onReminderChanged } : {})}
        onClose={p.onCloseDetailModal}
      />

      <LiveFavoriteFolderModal
        mode={p.folderModal}
        folders={p.folders}
        currentFolderId={currentFolderId}
        isTv={p.isTv}
        onAssignFolder={p.onAssignFolder}
        onCreateFolder={p.onCreateFolder}
        onRenameFolder={p.onRenameFolder}
        onDeleteFolder={p.onDeleteFolder}
        onClose={p.onCloseFolderModal}
      />
    </>
  );
}
