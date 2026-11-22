import type { CatalogService, ItemRow, ProgrammeRow, SourceRow } from '@elv/data';
import type { DefaultLiveModePref, EpgTimeSpanHoursPref, LogoBackdropModePref } from '@elv/domain';
import { IconButton, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { VideoHost } from '../ports/video-host';
import { computeCatalogLayout } from '../shared';
import { EpgGridView } from './EpgGridView';
import { EpgProgrammeDetailModal } from './EpgProgrammeDetailModal';
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
import { LiveContextMenu } from './LiveContextMenu';
import { LivePreviewBanner } from './LivePreviewBanner';
import { LiveWatchStage } from './LiveWatchStage';
import type { LiveMode, LiveTabMemory } from './live-model';
import { buildSourceBadgeMap } from './source-badge';
import { useLiveCatalog } from './useLiveCatalog';
import { useLiveNumpadOverlay } from './useLiveNumberJump';
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
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
  readonly videoHost?: VideoHost;
  readonly playbackGuard?: PlaybackGuard;
  /** Optional fixed epoch timestamp in milliseconds for deterministic EPG/progress rendering. */
  readonly nowMs?: number;
  readonly defaultLiveMode?: DefaultLiveModePref;
  readonly epgTimeSpanHours?: EpgTimeSpanHoursPref;
  readonly epgGenreTints?: boolean;
  readonly epgShowClock?: boolean;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly showSourceBadges?: boolean;
  readonly liveOkTwoStepPreview?: boolean;
  readonly cleanChannelTitles?: boolean;
  /** Called when embedded live preview playback (Favorites stage or two-step preview) starts or stops (`#160`). */
  readonly onEmbeddedPlaybackActiveChange?: (active: boolean) => void;
}

/**
 * Unified Cinema Quietude Live TV Hub (`UI_UX_PHILOSOPHY.md` §2.1 & §3): `Favorites` | `Channels` |
 * `TV Guide`, editorial category bar, `0–9` channel number pad (`Channels`), virtualized channels
 * grid, 1,000-channel × 7-day EPG grid, and real embedded-preview Favorites stage.
 */
export function LiveScreen(props: LiveScreenProps): ReactElement {
  const { catalog, sources, refreshToken, userStateVersion = 0, memory, onMemoryChange } = props;
  const { onPlay, onOpenSources, onFocusTopNav, isActiveScope = true, videoHost } = props;
  const { playbackGuard, nowMs, defaultLiveMode, epgTimeSpanHours } = props;
  const {
    epgGenreTints = true,
    epgShowClock = true,
    logoBackdropMode = 'plate',
    showSourceBadges = true,
    liveOkTwoStepPreview = false,
    cleanChannelTitles = false,
    onEmbeddedPlaybackActiveChange,
  } = props;
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const layout = useMemo(() => computeCatalogLayout(viewport, theme), [theme, viewport]);
  const tabMem = useLiveTabMemory(memory, onMemoryChange, defaultLiveMode);
  const { memory: activeMemory, memoryRef, updateMemory } = tabMem;
  const [guideRefreshTick, setGuideRefreshTick] = useState(0);
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
  const handleSelectCategory = useCallback(
    (categoryId: string | null) => {
      clearPreviewRef.current();
      updateMemory({ categoryId });
    },
    [updateMemory],
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
    userStateVersion,
    mode,
    selectedCategoryId: activeMemory.categoryId,
    activeChannelKey: activeMemory.activeChannelKey,
    previousChannelKey: activeMemory.previousChannelKey,
    onSelectCategoryId: handleSelectCategory,
    onChannelHistoryChange: handleChannelHistoryChange,
    ...(clockFn !== undefined ? { now: clockFn } : {}),
  });

  const numpad = useLiveNumpadOverlay(live);
  numpadResolvedRef.current = numpad.notifyChannelResolved;

  const activeFavoriteIdx = useMemo(() => {
    if (live.favoriteChannels.length === 0) return -1;
    const key = live.activeChannel?.key ?? activeMemory.activeChannelKey;
    const found = key ? live.favoriteChannels.findIndex((c) => c.key === key) : -1;
    return Math.max(found, 0);
  }, [activeMemory.activeChannelKey, live.activeChannel?.key, live.favoriteChannels]);
  const activeFavoriteChannel =
    activeFavoriteIdx >= 0 ? (live.favoriteChannels[activeFavoriteIdx] ?? null) : null;

  const {
    preview,
    previewedChannel,
    twoStepPreviewActive,
    clearTwoStepPreview,
    handleWatchAndPlay,
    handleWatchFromFavorites,
  } = useLiveTwoStepPreview({
    mode,
    liveOkTwoStepPreview,
    activeFavoriteChannel,
    readySources,
    catalog,
    live,
    memoryRef,
    onPlay,
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

  const handleSelectMode = useCallback(
    (nextMode: LiveMode) => {
      numpad.close();
      clearTwoStepPreview();
      setContextMenu(null);
      setDetailModal(null);
      updateMemory({ mode: nextMode });
    },
    [clearTwoStepPreview, numpad.close, updateMemory],
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

  useEffect(() => {
    if ((Platform.OS as string) !== 'web' || mode === 'favorites') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          target?: { tagName?: string };
          preventDefault?: () => void;
        }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          target?: { tagName?: string };
          preventDefault?: () => void;
        }) => void,
      ) => void;
    };
    const onKeyDown = (e: {
      key?: string;
      target?: { tagName?: string };
      preventDefault?: () => void;
    }) => {
      const tag = e.target?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.key === 'p' || e.key === 'P') && contextMenu === null && detailModal === null) {
        if (previousChannel !== null) {
          e.preventDefault?.();
          handleJumpPreviousChannel();
        }
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [contextMenu, detailModal, handleJumpPreviousChannel, mode, previousChannel]);
  const handleBrowseChannels = useCallback(() => handleSelectMode('channels'), [handleSelectMode]);
  const handleToggleZapDrawer = useCallback(
    () => updateMemory({ zapDrawerOpen: !memoryRef.current.zapDrawerOpen }),
    [memoryRef, updateMemory],
  );
  const handleToggleFavorite = useCallback(
    (ch: ItemRow) => void live.toggleFavorite(ch),
    [live.toggleFavorite],
  );
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
      if (ctrl === 'miniguide') return handleToggleZapDrawer();
      if (!activeFavoriteChannel) return;
      if (ctrl === 'favorite') handleToggleFavorite(activeFavoriteChannel);
      else if (ctrl === 'watch') {
        handleWatchFromFavorites(activeFavoriteChannel, Math.max(0, activeFavoriteIdx));
      }
    },
    [
      activeFavoriteChannel,
      activeFavoriteIdx,
      handleBrowseChannels,
      handleToggleFavorite,
      handleToggleZapDrawer,
      handleWatchFromFavorites,
    ],
  );
  const handleSelectZapIndex = useCallback(
    (idx: number) => {
      const ch = live.favoriteSource.get(idx);
      if (ch) live.tuneChannel(ch, idx);
    },
    [live.favoriteSource, live.tuneChannel],
  );
  const handleOpenZapContextMenu = useCallback(
    (idx: number) => {
      const ch = live.favoriteSource.get(idx);
      if (ch) handleOpenContextMenu(ch, idx, live.nowNextByKey.get(ch.key)?.now ?? null);
    },
    [handleOpenContextMenu, live.favoriteSource, live.nowNextByKey],
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
    channelCount: mode === 'favorites' ? live.favoriteChannels.length : live.channelCount,
    hasBody,
    zapDrawerOpen: activeMemory.zapDrawerOpen,
    numpadOpen: numpad.open,
    onSelectMode: handleSelectMode,
    onSelectCategoryIndex: handleSelectCategoryIndex,
    onToggleNumpad: numpad.toggle,
    onCloseNumpad: numpad.close,
    onPressNumpadKey: numpad.pressKey,
    onActivateWatchControl: handleActivateWatchControl,
    onSelectZapIndex: handleSelectZapIndex,
    onOpenZapContextMenu: handleOpenZapContextMenu,
    onJumpPreviousChannel: handleJumpPreviousChannel,
    onOpenSources,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const anyOverlayOpen = contextMenu !== null || detailModal !== null;
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
                  {...(nowMs !== undefined ? { nowMs } : {})}
                  {...(epgTimeSpanHours !== undefined ? { epgTimeSpanHours } : {})}
                  epgGenreTints={epgGenreTints}
                  epgShowClock={epgShowClock}
                  logoBackdropMode={logoBackdropMode}
                  sourceBadges={sourceBadges}
                  cleanChannelTitles={cleanChannelTitles}
                  onWatchChannel={handleWatchAndPlay}
                  onToggleFavorite={handleToggleFavorite}
                  onJumpPreviousChannel={handleJumpPreviousChannel}
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
                channelSource={live.favoriteSource}
                sourceVersion={live.favoritesVersion}
                nowNextByKey={live.nowNextByKey}
                nowNextVersion={live.nowNextVersion}
                zapDrawerOpen={activeMemory.zapDrawerOpen}
                isFavorite={
                  activeFavoriteChannel !== null && live.favoriteKeys.has(activeFavoriteChannel.key)
                }
                isDesktop={viewport.formFactor === 'desktop'}
                preview={preview}
                layout={layout}
                logoBackdropMode={logoBackdropMode}
                sourceBadges={sourceBadges}
                cleanChannelTitles={cleanChannelTitles}
                hydrateNowNext={live.hydrateNowNext}
                onToggleZapDrawer={handleToggleZapDrawer}
                onToggleFavorite={handleToggleFavorite}
                onBrowseChannels={handleBrowseChannels}
                onSelectChannel={live.tuneChannel}
                onOpenContextMenu={handleOpenContextMenu}
                onWatchFullscreen={handleWatchFromFavorites}
                focusedControl={tvNav.focusedWatchControl}
                focusedZapIndex={tvNav.focusedZapIndex}
                {...(clockFn !== undefined ? { now: clockFn } : {})}
              />
            )}
          </View>
        </View>
      )}

      <LiveContextMenu
        visible={contextMenu !== null}
        channel={contextMenu?.channel ?? null}
        channelIndex={contextMenu?.index ?? 0}
        programme={contextMenu?.programme ?? null}
        isFavorite={contextMenu !== null && live.favoriteKeys.has(contextMenu.channel.key)}
        isTv={layout.isTv}
        cleanChannelTitles={cleanChannelTitles}
        onPlay={mode === 'favorites' ? handleWatchFromFavorites : handleWatchAndPlay}
        onToggleFavorite={handleToggleFavorite}
        onShowProgrammeDetails={handleShowProgrammeDetails}
        onClose={() => setContextMenu(null)}
      />

      <EpgProgrammeDetailModal
        visible={detailModal !== null}
        channel={detailModal?.channel ?? null}
        channelIndex={detailModal?.index ?? 0}
        programme={detailModal?.programme ?? null}
        nowMs={nowMs ?? Date.now()}
        isFavorite={detailModal !== null && live.favoriteKeys.has(detailModal.channel.key)}
        isTv={layout.isTv}
        cleanChannelTitles={cleanChannelTitles}
        onTuneChannel={mode === 'favorites' ? handleWatchFromFavorites : handleWatchAndPlay}
        onToggleFavorite={handleToggleFavorite}
        onClose={() => setDetailModal(null)}
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  body: { flex: 1, position: 'relative' },
  numpadAnchor: { position: 'absolute', top: 8, zIndex: 8 },
});
