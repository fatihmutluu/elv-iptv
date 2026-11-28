import type { CatalogService, ItemRow, ProgrammeRow, SourceRow } from '@elv/data';
import type {
  DefaultLiveModePref,
  EpgRowDensity,
  EpgTimeSpanHoursPref,
  LogoBackdropModePref,
} from '@elv/domain';
import { IconButton, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
import { computeCatalogLayout, useKeymap, useStreamHealth } from '../shared';
import { EpgGridView } from './EpgGridView';
import { LiveChannelsGrid } from './LiveChannelsGrid';
import {
  LiveCategoryBar,
  LiveCategoryFallback,
  LiveEmptyState,
  LiveLoadingSkeleton,
  LiveModeSwitcher,
  LiveNumberPad,
  LiveTvKeyBridge,
} from './LiveChrome';
import type { LiveFavoriteFolderModalMode } from './LiveFavoriteFolderModal';
import { buildLiveFavoriteFolderSlots, LiveFavoriteFolderStrip } from './LiveFavoriteFolderStrip';
import { LivePreviewBanner } from './LivePreviewBanner';
import { LiveScreenOverlays } from './LiveScreenOverlays';
import type { LiveSplitOverlayKind } from './LiveSplitPlayerControls';
import { LiveWatchStage } from './LiveWatchStage';
import type { LiveMode, LiveTabMemory } from './live-model';
import { buildSourceBadgeMap } from './source-badge';
import { useLiveCatalog } from './useLiveCatalog';
import { useLiveFavoriteFolders } from './useLiveFavoriteFolders';
import { useLiveLastChannelKey } from './useLiveLastChannelKey';
import { useLiveNumpadOverlay } from './useLiveNumberJump';
import { useLiveScreenActions } from './useLiveScreenActions';
import { useLiveTwoStepPreview } from './useLiveTwoStepPreview';
import {
  type LiveWatchControl,
  useLiveTabMemory,
  useTvLiveNavigation,
} from './useTvLiveNavigation';

/** Props of {@link LiveScreen}. */
export interface LiveScreenProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly refreshToken: number;
  readonly userStateVersion?: number;
  readonly memory?: LiveTabMemory;
  readonly onMemoryChange?: (next: LiveTabMemory) => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenMultiView?: (target: PlayTarget) => void;
  readonly onOpenPopout?: (target: PlayTarget) => void;
  readonly onOpenSources: () => void;
  readonly onOpenSearch?: () => void;
  readonly onOpenHome?: () => void;
  readonly onChannelsMutated?: () => void;
  readonly onFavoritesMutated?: () => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
  readonly videoHost?: VideoHost;
  readonly playbackGuard?: PlaybackGuard;
  /** Optional fixed epoch timestamp in milliseconds for deterministic EPG/progress rendering. */
  readonly nowMs?: number;
  readonly defaultLiveMode?: DefaultLiveModePref;
  readonly epgTimeSpanHours?: EpgTimeSpanHoursPref;
  readonly epgRowDensity?: EpgRowDensity;
  readonly epgGenreTints?: boolean;
  readonly epgShowClock?: boolean;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly showSourceBadges?: boolean;
  readonly liveOkTwoStepPreview?: boolean;
  readonly cleanChannelTitles?: boolean;
  readonly collapseVariants?: boolean;
  readonly reminderVersion?: number;
  readonly onReminderChanged?: () => void;
  /** Called when embedded live preview playback (Favorites stage or two-step preview) starts or stops (`#160`). */
  readonly onEmbeddedPlaybackActiveChange?: (active: boolean) => void;
  /** Registers an async teardown hook allowing `AppShell` to release embedded previews before tuning another target (`#35`). */
  readonly onRegisterStopPreview?: (stop: (() => Promise<void>) | null) => void;
  /** Suppresses embedded live previews while another active stream (e.g. Floating Mini-Player) is playing (`#233`). */
  readonly suppressEmbeddedPreview?: boolean;
}

/**
 * Unified Cinema Quietude Live TV Hub (`UI_UX_PHILOSOPHY.md` §2.1 & §3): `Favorites` | `Channels` |
 * `TV Guide`, editorial category bar, `0–9` channel number pad (`Channels`), virtualized channels
 * grid, 1,000-channel × 7-day EPG grid, and real embedded-preview Favorites stage.
 */
export function LiveScreen(props: LiveScreenProps): ReactElement {
  const { catalog, sources, refreshToken, userStateVersion = 0, memory, onMemoryChange } = props;
  const { onPlay, onOpenMultiView, onOpenPopout, onOpenSources, onOpenSearch, onOpenHome } = props;
  const { onChannelsMutated, onFavoritesMutated, onFocusTopNav, isActiveScope = true } = props;
  const { videoHost, playbackGuard, nowMs, defaultLiveMode, epgTimeSpanHours } = props;
  const { epgRowDensity, epgGenreTints = true, epgShowClock = true } = props;
  const {
    logoBackdropMode = 'plate',
    showSourceBadges = true,
    liveOkTwoStepPreview = false,
  } = props;
  const { cleanChannelTitles = false, collapseVariants = false, reminderVersion = 0 } = props;
  const {
    onReminderChanged,
    onEmbeddedPlaybackActiveChange,
    onRegisterStopPreview,
    suppressEmbeddedPreview = false,
  } = props;
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const keymap = useKeymap();
  const { idleProbeController } = useStreamHealth();
  useEffect(() => () => idleProbeController.abortAll('navigation'), [idleProbeController]);
  const layout = useMemo(() => computeCatalogLayout(viewport, theme), [theme, viewport]);
  const tabMem = useLiveTabMemory(memory, onMemoryChange, defaultLiveMode);
  const { memory: activeMemory, memoryRef, updateMemory } = tabMem;
  const [guideRefreshTick, setGuideRefreshTick] = useState(0);
  const [localFavoritesTick, setLocalFavoritesTick] = useState(0);
  const [channelManagerOpen, setChannelManagerOpen] = useState(false);
  const [folderModal, setFolderModal] = useState<LiveFavoriteFolderModalMode | null>(null);
  const [splitOverlay, setSplitOverlay] = useState<LiveSplitOverlayKind>(null);
  const [contextMenu, setContextMenu] = useState<{
    readonly channel: ItemRow;
    readonly index: number;
    readonly programme: ProgrammeRow | null;
  } | null>(null);
  const [detailModal, setDetailModal] = useState<{
    readonly channel: ItemRow;
    readonly index: number;
    readonly programme: ProgrammeRow;
  } | null>(null);
  const numpadResolvedRef = useRef<() => void>(() => undefined);
  const clearPreviewRef = useRef<() => void>(() => undefined);
  const readySources = useMemo(() => sources.filter((s) => !s.needsImport), [sources]);
  const sourceBadges = useMemo(
    () => buildSourceBadgeMap(readySources, theme, showSourceBadges),
    [readySources, showSourceBadges, theme],
  );
  const clockFn = useMemo(() => (nowMs !== undefined ? () => nowMs : undefined), [nowMs]);
  const mode = activeMemory.mode;
  const sortBy = activeMemory.sortBy ?? 'default';
  const handleToggleSort = useCallback(() => {
    clearPreviewRef.current();
    updateMemory({
      sortBy: (memoryRef.current.sortBy ?? 'default') === 'alpha' ? 'default' : 'alpha',
    });
  }, [memoryRef, updateMemory]);
  const handleSelectCategory = useCallback(
    (categoryId: string | null) => {
      idleProbeController.abortAll('navigation');
      clearPreviewRef.current();
      updateMemory({ categoryId });
    },
    [idleProbeController, updateMemory],
  );
  const handleChannelHistoryChange = useCallback(
    (next: Pick<LiveTabMemory, 'activeChannelKey' | 'previousChannelKey'>) => {
      numpadResolvedRef.current();
      updateMemory(next);
    },
    [updateMemory],
  );

  const live = useLiveCatalog({
    catalog,
    sources: readySources,
    refreshToken: refreshToken + guideRefreshTick,
    userStateVersion: userStateVersion + localFavoritesTick,
    ...(onFavoritesMutated !== undefined ? { onFavoritesMutated } : {}),
    mode,
    selectedCategoryId: activeMemory.categoryId,
    activeChannelKey: activeMemory.activeChannelKey,
    previousChannelKey: activeMemory.previousChannelKey,
    sortBy,
    onSelectCategoryId: handleSelectCategory,
    onChannelHistoryChange: handleChannelHistoryChange,
    collapseVariants,
    ...(clockFn !== undefined ? { now: clockFn } : {}),
  });

  const handleFolderFavoritesMutated = useCallback(() => {
    setLocalFavoritesTick((n) => n + 1);
    onFavoritesMutated?.();
  }, [onFavoritesMutated]);

  const favFolders = useLiveFavoriteFolders({
    catalog,
    favoriteChannels: live.favoriteChannels,
    refreshToken: refreshToken + guideRefreshTick,
    userStateVersion: userStateVersion + localFavoritesTick,
    hasReadySources: readySources.length > 0,
    onFavoritesMutated: handleFolderFavoritesMutated,
  });

  const stageFavoriteChannels = favFolders.supported
    ? favFolders.filteredFavoriteChannels
    : live.favoriteChannels;
  const stageFavoriteSource = favFolders.supported
    ? favFolders.filteredFavoriteSource
    : live.favoriteSource;
  const stageFavoritesVersion = favFolders.supported
    ? live.favoritesVersion + favFolders.filteredVersion
    : live.favoritesVersion;

  const numpad = useLiveNumpadOverlay(live);
  numpadResolvedRef.current = numpad.notifyChannelResolved;

  const activeFavoriteIdx = useMemo(() => {
    if (stageFavoriteChannels.length === 0) return -1;
    const key = live.activeChannel?.key ?? activeMemory.activeChannelKey;
    const found = key ? stageFavoriteChannels.findIndex((c) => c.key === key) : -1;
    return Math.max(found, 0);
  }, [activeMemory.activeChannelKey, live.activeChannel?.key, stageFavoriteChannels]);
  const activeFavoriteChannel =
    activeFavoriteIdx >= 0
      ? (stageFavoriteChannels[activeFavoriteIdx] ?? null)
      : live.favoriteChannels.length > 0
        ? (live.favoriteChannels.find((c) => c.key === live.activeChannel?.key) ??
          live.favoriteChannels[0] ??
          null)
        : null;

  const {
    preview,
    previewedChannel,
    twoStepPreviewActive,
    clearTwoStepPreview,
    releasePreviewAndDispatch,
    handleWatchAndPlay,
    handleWatchFromFavorites,
    handleMultiViewFromFavorites,
    handlePopoutFromFavorites,
  } = useLiveTwoStepPreview({
    mode,
    liveOkTwoStepPreview,
    activeFavoriteChannel,
    readySources,
    catalog,
    live,
    memoryRef,
    onPlay,
    ...(onOpenMultiView !== undefined ? { onOpenMultiView } : {}),
    ...(onOpenPopout !== undefined ? { onOpenPopout } : {}),
    defaultOverlayMode: viewport.formFactor === 'desktop' ? 'docked' : 'floating',
    suppressEmbeddedPreview,
    ...(videoHost !== undefined ? { videoHost } : {}),
    ...(playbackGuard !== undefined ? { playbackGuard } : {}),
  });
  clearPreviewRef.current = clearTwoStepPreview;

  const embeddedPlaybackActive = preview.opened !== null && !preview.failed;
  const onEmbeddedPlaybackActiveChangeRef = useRef(onEmbeddedPlaybackActiveChange);
  onEmbeddedPlaybackActiveChangeRef.current = onEmbeddedPlaybackActiveChange;
  useEffect(() => {
    onEmbeddedPlaybackActiveChangeRef.current?.(embeddedPlaybackActive);
  }, [embeddedPlaybackActive]);
  useEffect(() => {
    return () => {
      onEmbeddedPlaybackActiveChangeRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    if (onRegisterStopPreview === undefined) return;
    onRegisterStopPreview(async () => {
      clearTwoStepPreview();
      await preview.stopAndRelease();
    });
    return () => onRegisterStopPreview(null);
  }, [clearTwoStepPreview, onRegisterStopPreview, preview.stopAndRelease]);

  const handleSelectMode = useCallback(
    (nextMode: LiveMode) => {
      idleProbeController.abortAll('navigation');
      numpad.close();
      clearTwoStepPreview();
      setSplitOverlay(null);
      setContextMenu(null);
      setDetailModal(null);
      setFolderModal(null);
      updateMemory({ mode: nextMode });
    },
    [clearTwoStepPreview, idleProbeController, numpad.close, updateMemory],
  );
  const handleOpenContextMenu = useCallback(
    (channel: ItemRow, index: number, programme: ProgrammeRow | null) => {
      setDetailModal(null);
      setContextMenu({ channel, index, programme });
    },
    [],
  );
  const handleShowProgrammeDetails = useCallback(
    (channel: ItemRow, index: number, programme: ProgrammeRow) => {
      setContextMenu(null);
      setDetailModal({ channel, index, programme });
    },
    [],
  );
  const previousChannel = live.previousChannel;
  const handleBrowseChannels = useCallback(() => handleSelectMode('channels'), [handleSelectMode]);
  const handleReorderFavorite = useCallback(
    (fromIdx: number, toIdx: number) => void live.reorderFavorite(fromIdx, toIdx),
    [live.reorderFavorite],
  );
  const contextFavIndex = contextMenu
    ? live.favoriteChannels.findIndex((c) => c.key === contextMenu.channel.key)
    : -1;
  const handleToggleFavorite = useCallback(
    (ch: ItemRow) => void live.toggleFavorite(ch),
    [live.toggleFavorite],
  );
  const handleChannelsMutated = useCallback(() => {
    setGuideRefreshTick((n) => n + 1);
    onChannelsMutated?.();
  }, [onChannelsMutated]);
  const {
    handleWatchCatchup,
    handleJumpPreviousChannel,
    handleMoveContextFavorite,
    handleContextMultiView,
    handleContextPopout,
    hideChannelProps,
  } = useLiveScreenActions({
    catalog,
    live,
    mode,
    contextFavIndex,
    channelManagerOpen,
    setChannelManagerOpen,
    setContextMenu,
    setDetailModal,
    onPlay,
    ...(onOpenMultiView !== undefined ? { onOpenMultiView } : {}),
    ...(onOpenPopout !== undefined ? { onOpenPopout } : {}),
    handleWatchAndPlay,
    handleMultiViewFromFavorites,
    handlePopoutFromFavorites,
    releasePreviewAndDispatch,
    handleChannelsMutated,
  });

  useLiveLastChannelKey({
    enabled:
      mode !== 'favorites' &&
      previousChannel !== null &&
      contextMenu === null &&
      detailModal === null &&
      folderModal === null &&
      !channelManagerOpen &&
      !numpad.open,
    keymapOverrides: keymap.overrides,
    onJumpPreviousChannel: handleJumpPreviousChannel,
  });
  const handleToggleActiveFavorite = useCallback(() => {
    const ch =
      mode === 'favorites'
        ? (activeFavoriteChannel ?? live.activeChannel)
        : (live.activeChannel ?? activeFavoriteChannel);
    if (ch !== null) handleToggleFavorite(ch);
  }, [activeFavoriteChannel, handleToggleFavorite, live.activeChannel, mode]);
  const handleGuideRefreshed = useCallback(() => setGuideRefreshTick((n) => n + 1), []);
  const handleSelectCategoryIndex = useCallback(
    (idx: number) => {
      const cat = live.categories[idx];
      if (cat) handleSelectCategory(cat.row.id);
    },
    [handleSelectCategory, live.categories],
  );
  const handleActivateWatchControl = useCallback(
    (ctrl: LiveWatchControl) => {
      if (ctrl === 'browse') return handleBrowseChannels();
      if (!activeFavoriteChannel) return;
      if (ctrl === 'play-pause') preview.togglePlayPause();
      else if (ctrl === 'tracks') setSplitOverlay((cur) => (cur === 'tracks' ? null : 'tracks'));
      else if (ctrl === 'overflow')
        setSplitOverlay((cur) => (cur === 'overflow' ? null : 'overflow'));
      else if (ctrl === 'fullscreen') {
        handleWatchFromFavorites(activeFavoriteChannel, Math.max(0, activeFavoriteIdx));
      }
    },
    [
      activeFavoriteChannel,
      activeFavoriteIdx,
      handleBrowseChannels,
      handleWatchFromFavorites,
      preview.togglePlayPause,
    ],
  );
  const handleSelectZapIndex = useCallback(
    (idx: number) => {
      const ch = stageFavoriteSource.get(idx);
      if (ch) live.tuneChannel(ch, idx);
    },
    [live.tuneChannel, stageFavoriteSource],
  );
  const handleOpenZapContextMenu = useCallback(
    (idx: number) => {
      const ch = stageFavoriteSource.get(idx);
      if (ch) handleOpenContextMenu(ch, idx, live.nowNextByKey.get(ch.key)?.now ?? null);
    },
    [handleOpenContextMenu, live.nowNextByKey, stageFavoriteSource],
  );
  const handleOpenMoveToFolder = useCallback((channel: ItemRow) => {
    setFolderModal({ kind: 'move', channel });
  }, []);
  const folderSlots = useMemo(
    () =>
      favFolders.supported
        ? buildLiveFavoriteFolderSlots(favFolders.folders, favFolders.activeFolderFilter)
        : [],
    [favFolders.activeFolderFilter, favFolders.folders, favFolders.supported],
  );
  const handleActivateFolderSlot = useCallback(
    (idx: number) => {
      const slot = folderSlots[idx];
      if (!slot) return;
      if (slot.kind === 'filter') favFolders.setActiveFolderFilter(slot.filter);
      else if (slot.kind === 'manage') setFolderModal({ kind: 'manage', folder: slot.folder });
      else setFolderModal({ kind: 'create' });
    },
    [favFolders.setActiveFolderFilter, folderSlots],
  );

  const hasReadySources = readySources.length > 0;
  const isInitialLoading =
    hasReadySources && live.loadingCategories && live.categories.length === 0;
  const hasCategories = live.categories.length > 0;
  const isEmpty = !isInitialLoading && (!hasReadySources || !hasCategories);
  const hasBody =
    mode === 'favorites'
      ? hasCategories
      : live.channelSource !== null && live.activeCategory !== null;

  const tvNav = useTvLiveNavigation({
    isTv: layout.isTv,
    isActiveScope,
    isEmpty,
    hasOpenSourcesCta: !hasReadySources,
    mode,
    categoryCount: live.categories.length,
    channelCount: mode === 'favorites' ? stageFavoriteChannels.length : live.channelCount,
    hasBody,
    zapDrawerOpen: activeMemory.zapDrawerOpen,
    numpadOpen: numpad.open,
    folderSlotCount: folderSlots.length,
    hasAnyFavorites: live.favoriteChannels.length > 0,
    onActivateFolderSlot: handleActivateFolderSlot,
    onSelectMode: handleSelectMode,
    onSelectCategoryIndex: handleSelectCategoryIndex,
    onToggleSort: handleToggleSort,
    onToggleNumpad: numpad.toggle,
    onCloseNumpad: numpad.close,
    onPressNumpadKey: numpad.pressKey,
    onActivateWatchControl: handleActivateWatchControl,
    onSelectZapIndex: handleSelectZapIndex,
    onOpenZapContextMenu: handleOpenZapContextMenu,
    onJumpPreviousChannel: handleJumpPreviousChannel,
    onToggleActiveFavorite: handleToggleActiveFavorite,
    ...(onOpenSearch !== undefined ? { onOpenSearch } : {}),
    ...(onOpenHome !== undefined ? { onOpenHome } : {}),
    onOpenSources,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const anyOverlayOpen =
    contextMenu !== null || detailModal !== null || channelManagerOpen || folderModal !== null;
  const childOwnsTvKeys =
    !numpad.open &&
    !anyOverlayOpen &&
    !isEmpty &&
    !isInitialLoading &&
    tvNav.tvZone === 'body' &&
    mode !== 'favorites' &&
    hasBody;
  const bodyActiveScope =
    isActiveScope && tvNav.tvZone === 'body' && !numpad.open && !anyOverlayOpen;
  const fallback = (
    <LiveCategoryFallback
      layout={layout}
      hasPendingItems={(live.activeCategory?.row.itemCount ?? 0) > 0}
      onOpenSources={onOpenSources}
    />
  );

  return (
    <View testID="live-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {layout.isTv && isActiveScope && !childOwnsTvKeys && !anyOverlayOpen ? (
        <LiveTvKeyBridge onEvent={tvNav.handleTvKey} />
      ) : null}

      {isInitialLoading ? (
        <LiveLoadingSkeleton layout={layout} />
      ) : isEmpty ? (
        <LiveEmptyState
          layout={layout}
          showOpenSources={!hasReadySources}
          ctaFocused={tvNav.focusedEmptyCta}
          onOpenSources={onOpenSources}
        />
      ) : (
        <View style={styles.root}>
          <View
            style={[
              styles.chromeHeader,
              { paddingHorizontal: layout.padX, paddingTop: theme.spacing.sm },
            ]}
          >
            <LiveModeSwitcher
              mode={mode}
              onSelectMode={handleSelectMode}
              isTv={layout.isTv}
              isTouch={layout.isTouch}
              focusedIndex={tvNav.focusedModeIndex}
            />
            <View style={styles.headerActions}>
              {(mode === 'channels' || mode === 'epg') && previousChannel !== null ? (
                <IconButton
                  testID="live-previous-channel-btn"
                  icon="prevChannel"
                  accessibilityLabel={i18n.t('live.previousChannel')}
                  focusable={!layout.isTv}
                  onPress={handleJumpPreviousChannel}
                />
              ) : null}
              {mode === 'channels' ? (
                <IconButton
                  testID="live-channels-numpad-toggle"
                  icon="keypad"
                  accessibilityLabel={i18n.t('live.numberPad')}
                  active={numpad.open}
                  focusable={!layout.isTv}
                  focused={tvNav.focusedNumpadToggle}
                  onPress={numpad.toggle}
                />
              ) : null}
            </View>
          </View>

          {mode === 'channels' || mode === 'epg' ? (
            <LiveCategoryBar
              categories={live.categories}
              activeCategoryId={live.activeCategory?.row.id ?? null}
              channelCount={live.channelCount}
              layout={layout}
              focusedChipIndex={tvNav.focusedCategoryIndex}
              onSelectCategory={handleSelectCategory}
            />
          ) : null}

          <View style={styles.body}>
            {twoStepPreviewActive && previewedChannel !== null ? (
              <LivePreviewBanner
                channel={previewedChannel.channel}
                index={previewedChannel.index}
                preview={preview}
                padX={layout.padX}
                isTv={layout.isTv}
                logoBackdropMode={logoBackdropMode}
                sourceBadge={sourceBadges.get(previewedChannel.channel.sourceId) ?? null}
                cleanChannelTitles={cleanChannelTitles}
                onOpenFullscreen={handleWatchAndPlay}
              />
            ) : null}

            {mode === 'channels' && numpad.open ? (
              <View style={[styles.numpadAnchor, { right: layout.padX }]}>
                <LiveNumberPad
                  visible
                  buffer={live.numberBuffer}
                  feedback={live.numberFeedback}
                  isTv={layout.isTv}
                  isTouch={layout.isTouch}
                  focusedKey={tvNav.focusedNumpadKey}
                  onDigit={numpad.pressDigit}
                  onClear={numpad.clear}
                  onSubmit={numpad.submit}
                  onClose={numpad.close}
                />
              </View>
            ) : null}

            {mode === 'channels' ? (
              live.channelSource ? (
                <LiveChannelsGrid
                  channelSource={live.channelSource}
                  sourceVersion={live.sourceVersion}
                  nowNextByKey={live.nowNextByKey}
                  nowNextVersion={live.nowNextVersion}
                  activeChannelKey={live.activeChannel?.key ?? activeMemory.activeChannelKey}
                  favoriteKeys={live.favoriteKeys}
                  layout={layout}
                  logoBackdropMode={logoBackdropMode}
                  sourceBadges={sourceBadges}
                  cleanChannelTitles={cleanChannelTitles}
                  sortBy={live.sortBy}
                  onToggleSort={handleToggleSort}
                  sortFocused={tvNav.focusedSortToggle}
                  alphabetBuckets={live.alphabetBuckets}
                  catalog={catalog}
                  {...(live.activeCategory !== null
                    ? {
                        categoryId: live.activeCategory.row.id,
                        ...(live.activeCategory.row.sourceId.length > 0
                          ? { sourceId: live.activeCategory.row.sourceId }
                          : {}),
                      }
                    : {})}
                  collapseVariants={collapseVariants}
                  hydrateNowNext={live.hydrateNowNext}
                  onWatchChannel={handleWatchAndPlay}
                  onToggleFavorite={handleToggleFavorite}
                  onOpenContextMenu={handleOpenContextMenu}
                  onJumpPreviousChannel={handleJumpPreviousChannel}
                  onEdgeTop={tvNav.handleChildEdgeTop}
                  isActiveScope={bodyActiveScope}
                  {...(clockFn !== undefined ? { now: clockFn } : {})}
                />
              ) : (
                fallback
              )
            ) : mode === 'epg' ? (
              live.activeCategory && live.channelSource ? (
                <EpgGridView
                  catalog={catalog}
                  category={live.activeCategory}
                  channelSource={live.channelSource}
                  sourceVersion={live.sourceVersion}
                  refreshToken={refreshToken + guideRefreshTick}
                  favoriteKeys={live.favoriteKeys}
                  activeChannelKey={
                    live.activeChannel?.key ?? activeMemory.activeChannelKey ?? null
                  }
                  {...(nowMs !== undefined ? { nowMs } : {})}
                  {...(epgTimeSpanHours !== undefined ? { epgTimeSpanHours } : {})}
                  {...(epgRowDensity !== undefined ? { epgRowDensity } : {})}
                  epgGenreTints={epgGenreTints}
                  epgShowClock={epgShowClock}
                  logoBackdropMode={logoBackdropMode}
                  sourceBadges={sourceBadges}
                  cleanChannelTitles={cleanChannelTitles}
                  onWatchChannel={handleWatchAndPlay}
                  onWatchCatchup={handleWatchCatchup}
                  reminderVersion={reminderVersion}
                  {...(onReminderChanged !== undefined ? { onReminderChanged } : {})}
                  onToggleFavorite={handleToggleFavorite}
                  onJumpPreviousChannel={handleJumpPreviousChannel}
                  {...hideChannelProps}
                  onGuideRefreshed={handleGuideRefreshed}
                  onEdgeTop={tvNav.handleChildEdgeTop}
                  isActiveScope={bodyActiveScope}
                />
              ) : (
                fallback
              )
            ) : (
              <LiveWatchStage
                activeChannel={activeFavoriteChannel}
                activeChannelIndex={Math.max(0, activeFavoriteIdx)}
                channelSource={stageFavoriteSource}
                sourceVersion={stageFavoritesVersion}
                hasAnyFavorites={live.favoriteChannels.length > 0}
                drawerHeader={
                  favFolders.supported ? (
                    <LiveFavoriteFolderStrip
                      folders={favFolders.folders}
                      activeFilter={favFolders.activeFolderFilter}
                      isTv={layout.isTv}
                      focusedSlotIndex={tvNav.focusedFolderIndex}
                      onSelectFilter={favFolders.setActiveFolderFilter}
                      onRequestCreate={() => setFolderModal({ kind: 'create' })}
                      onRequestManage={(folder) => setFolderModal({ kind: 'manage', folder })}
                    />
                  ) : null
                }
                emptyDrawerMessage={
                  favFolders.supported && favFolders.activeFolderFilter !== 'all'
                    ? i18n.t('live.folders.emptyFolder')
                    : null
                }
                nowNextByKey={live.nowNextByKey}
                nowNextVersion={live.nowNextVersion}
                zapDrawerOpen={activeMemory.zapDrawerOpen}
                favoriteKeys={live.favoriteKeys}
                isDesktop={viewport.formFactor === 'desktop'}
                preview={preview}
                layout={layout}
                logoBackdropMode={logoBackdropMode}
                sourceBadges={sourceBadges}
                cleanChannelTitles={cleanChannelTitles}
                hydrateNowNext={live.hydrateNowNext}
                onToggleFavorite={handleToggleFavorite}
                onBrowseChannels={handleBrowseChannels}
                onSelectChannel={live.tuneChannel}
                {...(favFolders.activeFolderFilter === 'all'
                  ? { onReorderFavorite: handleReorderFavorite }
                  : {})}
                onOpenContextMenu={handleOpenContextMenu}
                onWatchFullscreen={handleWatchFromFavorites}
                {...(onOpenMultiView !== undefined
                  ? { onOpenMultiView: handleMultiViewFromFavorites }
                  : {})}
                {...(onOpenPopout !== undefined ? { onOpenPopout: handlePopoutFromFavorites } : {})}
                activeOverlay={splitOverlay}
                onActiveOverlayChange={setSplitOverlay}
                keyboardShortcutsEnabled={mode === 'favorites' && !anyOverlayOpen && isActiveScope}
                focusedControl={tvNav.focusedWatchControl}
                focusedZapIndex={tvNav.focusedZapIndex}
                {...(clockFn !== undefined ? { now: clockFn } : {})}
              />
            )}
          </View>
        </View>
      )}

      <LiveScreenOverlays
        catalog={catalog}
        readySources={readySources}
        isTv={layout.isTv}
        cleanChannelTitles={cleanChannelTitles}
        nowMs={nowMs ?? Date.now()}
        favoriteKeys={live.favoriteKeys}
        favoriteCount={live.favoriteChannels.length}
        contextMenu={contextMenu}
        contextFavIndex={contextFavIndex}
        detailModal={detailModal}
        channelManagerOpen={channelManagerOpen}
        folderModal={folderModal}
        folders={favFolders.folders}
        assignmentByItemKey={favFolders.assignmentByItemKey}
        onPlay={mode === 'favorites' ? handleWatchFromFavorites : handleWatchAndPlay}
        {...(onOpenMultiView !== undefined ? { onOpenMultiView: handleContextMultiView } : {})}
        {...(onOpenPopout !== undefined ? { onOpenPopout: handleContextPopout } : {})}
        onToggleFavorite={handleToggleFavorite}
        {...(favFolders.supported ? { onMoveToFolder: handleOpenMoveToFolder } : {})}
        onMoveFavorite={handleMoveContextFavorite}
        onShowProgrammeDetails={handleShowProgrammeDetails}
        {...hideChannelProps}
        onWatchCatchup={handleWatchCatchup}
        {...(onReminderChanged !== undefined ? { onReminderChanged } : {})}
        onChannelsMutated={handleChannelsMutated}
        onAssignFolder={favFolders.moveChannelToFolder}
        onCreateFolder={favFolders.createFolder}
        onRenameFolder={favFolders.renameFolder}
        onDeleteFolder={favFolders.deleteFolder}
        onCloseContextMenu={() => setContextMenu(null)}
        onCloseDetailModal={() => setDetailModal(null)}
        onCloseChannelManager={() => setChannelManagerOpen(false)}
        onCloseFolderModal={() => setFolderModal(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chromeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 6,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { flex: 1, position: 'relative' },
  numpadAnchor: { position: 'absolute', top: 8, zIndex: 8 },
});
