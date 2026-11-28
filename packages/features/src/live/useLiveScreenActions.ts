import type { CatalogService, ItemRow, ProgrammeRow } from '@elv/data';
import { useCallback, useEffect, useMemo } from 'react';
import type { PlayTarget } from '../ports/play-target';
import { useCatalogUiCache, useProfile } from '../shared';
import { buildCatchupPlayTarget } from './catchup-reminder-model';
import type { LiveMode } from './live-model';
import type { LiveCatalogState } from './useLiveCatalog';

/** Options for {@link useLiveScreenActions}. */
export interface UseLiveScreenActionsOptions {
  readonly catalog: CatalogService;
  readonly live: LiveCatalogState;
  readonly mode: LiveMode;
  readonly contextFavIndex: number;
  readonly channelManagerOpen: boolean;
  readonly setChannelManagerOpen: (open: boolean) => void;
  readonly setContextMenu: (v: null) => void;
  readonly setDetailModal: (v: null) => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenMultiView?: (target: PlayTarget) => void;
  readonly onOpenPopout?: (target: PlayTarget) => void;
  readonly handleWatchAndPlay: (channel: ItemRow, index: number) => void;
  readonly handleMultiViewFromFavorites: (channel: ItemRow, index: number) => void;
  readonly handlePopoutFromFavorites: (channel: ItemRow, index: number) => void;
  readonly releasePreviewAndDispatch: (fn: () => void) => void;
  readonly handleChannelsMutated: () => void;
}

/** Encapsulates channel hide/manage, catchup, last-channel jump, and context-menu dispatch handlers for {@link LiveScreen}. */
export function useLiveScreenActions(opts: UseLiveScreenActionsOptions) {
  const {
    catalog,
    live,
    mode,
    contextFavIndex,
    channelManagerOpen,
    setChannelManagerOpen,
    setContextMenu,
    setDetailModal,
    onPlay,
    onOpenMultiView,
    onOpenPopout,
    handleWatchAndPlay,
    handleMultiViewFromFavorites,
    handlePopoutFromFavorites,
    releasePreviewAndDispatch,
    handleChannelsMutated,
  } = opts;
  const uiCache = useCatalogUiCache();
  const profile = useProfile();

  const handleWatchCatchup = useCallback(
    (channel: ItemRow, index: number, programme: ProgrammeRow, hasArchive?: boolean) => {
      const liveTarget = live.buildPlayTarget(
        channel,
        index,
        mode === 'favorites' ? 'favorites' : 'category',
      );
      const target = buildCatchupPlayTarget({
        channel,
        programme,
        liveTarget,
        ...(hasArchive !== undefined ? { hasArchive } : {}),
      });
      releasePreviewAndDispatch(() => onPlay(target));
    },
    [live, mode, onPlay, releasePreviewAndDispatch],
  );

  const previousChannel = live.previousChannel;
  const handleJumpPreviousChannel = useCallback(() => {
    if (mode === 'favorites' || previousChannel === null) return;
    let idx = 0;
    const src = live.channelSource;
    if (src !== null) {
      const n = src.count();
      for (let i = 0; i < n; i++) {
        if (src.get(i)?.key === previousChannel.key) {
          idx = i;
          break;
        }
      }
    }
    handleWatchAndPlay(previousChannel, idx);
  }, [handleWatchAndPlay, live.channelSource, mode, previousChannel]);

  const handleMoveContextFavorite = useCallback(
    (dir: 'up' | 'down') => {
      if (contextFavIndex >= 0) {
        void live.reorderFavorite(contextFavIndex, contextFavIndex + (dir === 'up' ? -1 : 1));
      }
    },
    [contextFavIndex, live.reorderFavorite],
  );

  const targetScope = mode === 'favorites' ? 'favorites' : 'category';
  const handleContextMultiView = useCallback(
    (ch: ItemRow, idx: number) => {
      if (mode === 'favorites') return handleMultiViewFromFavorites(ch, idx);
      if (onOpenMultiView === undefined) return;
      const target = live.buildPlayTarget(ch, idx, targetScope);
      releasePreviewAndDispatch(() => onOpenMultiView(target));
    },
    [
      handleMultiViewFromFavorites,
      live,
      mode,
      onOpenMultiView,
      releasePreviewAndDispatch,
      targetScope,
    ],
  );

  const handleContextPopout = useCallback(
    (ch: ItemRow, idx: number) => {
      if (mode === 'favorites') return handlePopoutFromFavorites(ch, idx);
      if (onOpenPopout === undefined) return;
      const target = live.buildPlayTarget(ch, idx, targetScope);
      releasePreviewAndDispatch(() => onOpenPopout(target));
    },
    [handlePopoutFromFavorites, live, mode, onOpenPopout, releasePreviewAndDispatch, targetScope],
  );

  const performHideChannel = useCallback(
    (channel: ItemRow) => {
      if (!catalog.setChannelOverride) return;
      void catalog
        .setChannelOverride({
          itemKey: channel.key,
          sourceId: channel.sourceId,
          isHidden: true,
        })
        .then((res) => {
          if (!res.ok) return;
          uiCache?.invalidateSource(channel.sourceId);
          handleChannelsMutated();
        });
    },
    [catalog, handleChannelsMutated, uiCache],
  );

  const handleHideChannel = useCallback(
    (channel: ItemRow) => {
      if (profile.hasGuardPin && !profile.parentalUnlocked) {
        profile.requestParentalUnlock(() => performHideChannel(channel));
        return;
      }
      performHideChannel(channel);
    },
    [performHideChannel, profile],
  );

  const handleOpenChannelManager = useCallback(() => {
    setContextMenu(null);
    setDetailModal(null);
    if (profile.hasGuardPin && !profile.parentalUnlocked) {
      profile.requestParentalUnlock(() => setChannelManagerOpen(true));
      return;
    }
    setChannelManagerOpen(true);
  }, [profile, setChannelManagerOpen, setContextMenu, setDetailModal]);

  useEffect(() => {
    if (channelManagerOpen && profile.hasGuardPin && !profile.parentalUnlocked) {
      setChannelManagerOpen(false);
    }
  }, [channelManagerOpen, profile.hasGuardPin, profile.parentalUnlocked, setChannelManagerOpen]);

  const hideChannelProps = useMemo(
    () =>
      catalog.setChannelOverride !== undefined
        ? { onHideChannel: handleHideChannel, onManageChannels: handleOpenChannelManager }
        : {},
    [catalog.setChannelOverride, handleHideChannel, handleOpenChannelManager],
  );

  return {
    handleWatchCatchup,
    handleJumpPreviousChannel,
    handleMoveContextFavorite,
    handleContextMultiView,
    handleContextPopout,
    hideChannelProps,
  };
}
