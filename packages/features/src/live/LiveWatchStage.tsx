import type { ItemRow, NowNextEntry, ProgrammeRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackStatus,
  type StreamVideoInfo,
} from '@elv/playback';
import {
  ArtworkImage,
  CtaButton,
  MicroPill,
  Scrim,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { AudioDeviceInfo, OpenVideoEngine } from '../ports/video-host';
import type { CatalogLayoutMetrics, PagedListSource } from '../shared';
import {
  type LiveSplitOverlayKind,
  LiveSplitPlayerControls,
  useLiveSplitKeyboardShortcuts,
} from './LiveSplitPlayerControls';
import { LiveSplitPlayerOverlays } from './LiveSplitPlayerOverlays';
import { LiveZapDrawer, ZAP_DRAWER_WIDTH } from './LiveZapDrawer';
import { computeProgramProgress } from './live-model';
import { SourceBadgePill } from './SourceBadgePill';
import { formatChannelDisplayName, type SourceBadgeInfo } from './source-badge';
import { type LiveSplitResizeMode, toVideoResizeMode } from './useLiveEmbeddedPreview';
import type { LiveWatchControl } from './useTvLiveNavigation';

const FLOATING_AUTO_HIDE_MS = 3_500;
const DOUBLE_TAP_WINDOW_MS = 350;
const NOOP = () => undefined;

/** Embedded live preview slice rendered inside {@link LiveWatchStage} and {@link LivePreviewBanner}. */
export interface LiveStagePreview {
  readonly opened: OpenVideoEngine | null;
  readonly statusText: string;
  readonly failed: boolean;
  readonly status?: PlaybackStatus;
  readonly playing?: boolean;
  readonly paused?: boolean;
  readonly muted?: boolean;
  readonly volume?: number;
  readonly resizeMode?: LiveSplitResizeMode;
  readonly tracks?: MediaTracks;
  readonly videoInfo?: StreamVideoInfo | undefined;
  readonly overlayMode?: 'floating' | 'docked';
  readonly audioDevices?: readonly AudioDeviceInfo[];
  readonly activeAudioDevice?: string;
  readonly togglePlayPause?: () => void;
  readonly toggleMute?: () => void;
  readonly setVolume?: (volume: number) => void;
  readonly cycleResizeMode?: () => void;
  readonly selectAudio?: (id: string) => void;
  readonly selectSubtitle?: (id: string | null) => void;
  readonly selectAudioDevice?: (name: string) => void;
}

/** Props of {@link LiveWatchStage}. */
export interface LiveWatchStageProps {
  readonly activeChannel: ItemRow | null;
  readonly activeChannelIndex: number;
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly sourceVersion: number;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowNextVersion: number;
  readonly zapDrawerOpen: boolean;
  readonly favoriteKeys?: ReadonlySet<string>;
  readonly isDesktop?: boolean;
  readonly preview?: LiveStagePreview;
  readonly layout: CatalogLayoutMetrics;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onToggleZapDrawer?: () => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onBrowseChannels?: () => void;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
  readonly onReorderFavorite?: (fromIndex: number, toIndex: number) => void;
  readonly onOpenContextMenu?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow | null,
  ) => void;
  readonly onWatchFullscreen: (channel: ItemRow, index: number) => void;
  readonly onOpenMultiView?: (channel: ItemRow, index: number) => void;
  readonly onOpenPopout?: (channel: ItemRow, index: number) => void;
  readonly activeOverlay?: LiveSplitOverlayKind;
  readonly onActiveOverlayChange?: (next: LiveSplitOverlayKind) => void;
  readonly keyboardShortcutsEnabled?: boolean;
  readonly focusedControl?: LiveWatchControl | null;
  readonly focusedZapIndex?: number | null;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly sourceBadges?: ReadonlyMap<string, SourceBadgeInfo>;
  readonly cleanChannelTitles?: boolean;
  /** Optional header element rendered strictly inside `LiveZapDrawer` (e.g. `LiveFavoriteFolderStrip`). */
  readonly drawerHeader?: ReactElement | null;
  /** Optional quiet inline empty message displayed inside `LiveZapDrawer` when a filtered folder is empty. */
  readonly emptyDrawerMessage?: string | null;
  /** True when the profile has at least one favorite channel overall (keeps drawer visible when filtering empty folders). */
  readonly hasAnyFavorites?: boolean;
  /** Injectable epoch clock in milliseconds for live progress bars (defaults to `() => Date.now()`). */
  readonly now?: () => number;
}

/**
 * Cinema Quietude Live TV Favorites Full Split Player (`UI_UX_PHILOSOPHY.md` §1 & §3):
 * removes top actionBar clutter so the embedded video fills upward cleanly, keeps `LiveZapDrawer`
 * beside the player with per-row right-edge `★` favorite toggles, equips the embedded player with
 * full Cinema Quietude controls (Play/Pause, Mute + Volume, Fullscreen + double-click video,
 * Aspect, Audio/Subtitles, Multi-View, Popout, `⋮` settings, desktop shortcuts), and maintains
 * strict desktop HWND docked safety plus `max_connections = 1` single-connection handoff.
 */
export function LiveWatchStage(p: LiveWatchStageProps): ReactElement {
  const { activeChannel, activeChannelIndex, channelSource, sourceVersion } = p;
  const { nowNextByKey, nowNextVersion, zapDrawerOpen, favoriteKeys, layout } = p;
  const { isDesktop = false, preview, focusedControl = null, focusedZapIndex = null, now } = p;
  const { logoBackdropMode = 'plate', sourceBadges, cleanChannelTitles = false } = p;
  const { onWatchFullscreen, onOpenMultiView, onOpenPopout, onToggleFavorite, onBrowseChannels } =
    p;

  const theme = useTheme();
  const i18n = useI18n();
  const [localOverlay, setLocalOverlay] = useState<LiveSplitOverlayKind>(null);
  const [floatingVisible, setFloatingVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSurfaceTapRef = useRef(0);

  const activeOverlay = p.activeOverlay !== undefined ? p.activeOverlay : localOverlay;
  const setActiveOverlay = useCallback(
    (next: LiveSplitOverlayKind) => {
      if (p.onActiveOverlayChange) p.onActiveOverlayChange(next);
      else setLocalOverlay(next);
    },
    [p.onActiveOverlayChange],
  );

  const openedPreview = preview?.opened ?? null;
  const overlayMode = preview?.overlayMode ?? (isDesktop ? 'docked' : 'floating');
  const isDocked = overlayMode === 'docked';
  const playing = preview?.playing ?? false;
  const paused = preview?.paused ?? false;
  const muted = preview?.muted ?? false;
  const volume = preview?.volume ?? 1;
  const resizeMode: LiveSplitResizeMode = preview?.resizeMode ?? 'contain';
  const tracks = preview?.tracks ?? EMPTY_TRACKS;
  const videoInfo = preview?.videoInfo;
  const audioDevices = preview?.audioDevices ?? [];
  const activeAudioDevice = preview?.activeAudioDevice ?? 'auto';

  const togglePlayPause = preview?.togglePlayPause ?? NOOP;
  const toggleMute = preview?.toggleMute ?? NOOP;
  const setVolume = preview?.setVolume ?? NOOP;
  const cycleResizeMode = preview?.cycleResizeMode ?? NOOP;
  const selectAudio = preview?.selectAudio ?? NOOP;
  const selectSubtitle = preview?.selectSubtitle ?? NOOP;
  const selectAudioDevice = preview?.selectAudioDevice ?? NOOP;

  const handleWatchFullscreen = useCallback(() => {
    if (activeChannel) onWatchFullscreen(activeChannel, activeChannelIndex);
  }, [activeChannel, activeChannelIndex, onWatchFullscreen]);

  const handleOpenMultiView = useMemo(
    () =>
      onOpenMultiView && activeChannel
        ? () => onOpenMultiView(activeChannel, activeChannelIndex)
        : undefined,
    [activeChannel, activeChannelIndex, onOpenMultiView],
  );

  const handleOpenPopout = useMemo(
    () =>
      onOpenPopout && activeChannel
        ? () => onOpenPopout(activeChannel, activeChannelIndex)
        : undefined,
    [activeChannel, activeChannelIndex, onOpenPopout],
  );

  const handleToggleTracks = useCallback(() => {
    setActiveOverlay(activeOverlay === 'tracks' ? null : 'tracks');
  }, [activeOverlay, setActiveOverlay]);

  const handleToggleOverflow = useCallback(() => {
    setActiveOverlay(activeOverlay === 'overflow' ? null : 'overflow');
  }, [activeOverlay, setActiveOverlay]);

  const handleCloseOverlay = useCallback(() => setActiveOverlay(null), [setActiveOverlay]);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const keepFloatingVisible =
    isDocked || !playing || activeOverlay !== null || (layout.isTv && focusedControl !== null);

  const revealFloatingControls = useCallback(() => {
    if (isDocked) return;
    setFloatingVisible(true);
    clearHideTimer();
    if (!keepFloatingVisible) {
      hideTimerRef.current = setTimeout(() => {
        setFloatingVisible(false);
      }, FLOATING_AUTO_HIDE_MS);
    }
  }, [clearHideTimer, isDocked, keepFloatingVisible]);

  useEffect(() => {
    if (keepFloatingVisible) {
      clearHideTimer();
      setFloatingVisible(true);
      return clearHideTimer;
    }
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      setFloatingVisible(false);
    }, FLOATING_AUTO_HIDE_MS);
    return clearHideTimer;
  }, [clearHideTimer, keepFloatingVisible]);

  const handleSurfaceInteraction = useCallback(() => {
    revealFloatingControls();
    const nowStamp = Date.now();
    if (nowStamp - lastSurfaceTapRef.current <= DOUBLE_TAP_WINDOW_MS) {
      lastSurfaceTapRef.current = 0;
      handleWatchFullscreen();
    } else {
      lastSurfaceTapRef.current = nowStamp;
    }
  }, [handleWatchFullscreen, revealFloatingControls]);

  const shortcutsEnabled = p.keyboardShortcutsEnabled ?? isDesktop;

  useLiveSplitKeyboardShortcuts({
    enabled: shortcutsEnabled && !layout.isTv && activeChannel !== null && openedPreview !== null,
    volume,
    activeOverlay,
    onTogglePlayPause: togglePlayPause,
    onToggleMute: toggleMute,
    onSetVolume: setVolume,
    onWatchFullscreen: handleWatchFullscreen,
    onCloseOverlay: handleCloseOverlay,
  });

  useEffect(() => {
    if (!shortcutsEnabled || !openedPreview?.onHostKey) return;
    return openedPreview.onHostKey((key) => {
      if (key === 'play-pause') togglePlayPause();
      else if (key === 'mute') toggleMute();
      else if (key === 'fullscreen') handleWatchFullscreen();
      else if (key === 'aspect') cycleResizeMode();
      else if (key === 'tracks') handleToggleTracks();
      else if (key === 'volume-up') setVolume(Math.min(1, Math.round((volume + 0.1) * 100) / 100));
      else if (key === 'volume-down')
        setVolume(Math.max(0, Math.round((volume - 0.1) * 100) / 100));
    });
  }, [
    cycleResizeMode,
    handleToggleTracks,
    handleWatchFullscreen,
    openedPreview,
    setVolume,
    shortcutsEnabled,
    toggleMute,
    togglePlayPause,
    volume,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh clock snapshot alongside schedule updates
  const nowMs = useMemo(() => (now ? now() : Date.now()), [now, nowNextVersion, sourceVersion]);

  const hasFavorites =
    p.hasAnyFavorites ?? ((channelSource?.count() ?? 0) > 0 || activeChannel !== null);
  if (!hasFavorites) {
    return (
      <View
        testID="live-favorites-empty"
        style={[
          styles.emptyWrap,
          { backgroundColor: theme.colors.bgCanvas, paddingHorizontal: layout.padX },
        ]}
      >
        <Text style={[theme.typography.h2, styles.centerText, { color: theme.colors.textPrimary }]}>
          {i18n.t('live.favoritesEmptyTitle')}
        </Text>
        <Text
          style={[
            theme.typography.body,
            styles.centerText,
            styles.emptyBody,
            { color: theme.colors.textSecondary },
          ]}
        >
          {i18n.t('live.favoritesEmptyBody')}
        </Text>
        {onBrowseChannels ? (
          <View
            testID="live-favorites-empty-actions"
            style={[styles.emptyActions, { marginTop: theme.spacing.sm }]}
          >
            <CtaButton
              testID="live-browse-channels"
              label={i18n.t('live.browseChannels')}
              variant="primary"
              focusable={!layout.isTv}
              focused={layout.isTv && focusedControl === 'browse'}
              onPress={onBrowseChannels}
              style={styles.emptyBrowseCta}
            />
          </View>
        ) : null}
      </View>
    );
  }

  const activeNowNext = activeChannel ? nowNextByKey.get(activeChannel.key) : undefined;
  const nowProg = activeNowNext?.now ?? null;
  const nextProg = activeNowNext?.next ?? null;
  const ratio = nowProg ? computeProgramProgress(nowProg.start, nowProg.stop, nowMs) : 0;
  const pct = `${Math.round(ratio * 100)}%` as const;
  const activeChannelName = activeChannel
    ? formatChannelDisplayName(activeChannel.name, cleanChannelTitles)
    : i18n.t('nav.live');
  const activeSourceBadge = activeChannel
    ? (sourceBadges?.get(activeChannel.sourceId) ?? null)
    : null;
  const channelHeading = activeChannel
    ? activeChannel.num !== null && activeChannel.num !== undefined
      ? `${activeChannel.num} · ${activeChannelName}`
      : activeChannelName
    : i18n.t('nav.live');
  const landscapeFloatingDrawer = !isDesktop && zapDrawerOpen && !layout.isPortrait;
  const isWeb = (Platform.OS as string) === 'web';

  const surfaceInteractionProps: Record<string, unknown> = {
    ...(isWeb ? { onDoubleClick: handleWatchFullscreen } : {}),
    onTouchStart: handleSurfaceInteraction,
  };

  const videoPanePointerProps: Record<string, unknown> = !isDocked
    ? { onPointerMove: revealFloatingControls }
    : {};

  const drawerElement = zapDrawerOpen ? (
    <LiveZapDrawer
      docked={isDesktop}
      channelSource={channelSource}
      sourceVersion={sourceVersion}
      nowNextByKey={nowNextByKey}
      nowNextVersion={nowNextVersion}
      activeChannelKey={activeChannel?.key ?? null}
      {...(favoriteKeys !== undefined ? { favoriteKeys } : {})}
      focusedZapIndex={focusedZapIndex}
      layout={layout}
      logoBackdropMode={logoBackdropMode}
      {...(sourceBadges !== undefined ? { sourceBadges } : {})}
      cleanChannelTitles={cleanChannelTitles}
      hydrateNowNext={p.hydrateNowNext}
      onSelectChannel={p.onSelectChannel}
      {...(onToggleFavorite !== undefined ? { onToggleFavorite } : {})}
      {...(p.onReorderFavorite !== undefined ? { onReorderFavorite: p.onReorderFavorite } : {})}
      {...(p.onOpenContextMenu !== undefined ? { onOpenContextMenu: p.onOpenContextMenu } : {})}
      {...(p.drawerHeader !== undefined ? { header: p.drawerHeader } : {})}
      {...(p.emptyDrawerMessage !== undefined ? { emptyMessage: p.emptyDrawerMessage } : {})}
    />
  ) : null;

  const controlsElement = (
    <LiveSplitPlayerControls
      paused={paused}
      muted={muted}
      volume={volume}
      resizeMode={resizeMode}
      docked={isDocked}
      isTv={layout.isTv}
      isPortrait={layout.isPortrait}
      disabled={activeChannel === null}
      activeOverlay={activeOverlay}
      focusedControl={focusedControl}
      padX={isDocked ? layout.padX : theme.spacing.sm}
      onTogglePlayPause={togglePlayPause}
      onToggleMute={toggleMute}
      onSetVolume={setVolume}
      onCycleResizeMode={cycleResizeMode}
      onToggleTracks={handleToggleTracks}
      onToggleOverflow={handleToggleOverflow}
      onWatchFullscreen={handleWatchFullscreen}
      {...(handleOpenMultiView !== undefined ? { onOpenMultiView: handleOpenMultiView } : {})}
      {...(handleOpenPopout !== undefined ? { onOpenPopout: handleOpenPopout } : {})}
    />
  );

  const overlaysElement = (
    <LiveSplitPlayerOverlays
      activeOverlay={activeOverlay}
      docked={isDocked}
      isTv={layout.isTv}
      tracks={tracks}
      videoInfo={videoInfo}
      resizeMode={resizeMode}
      audioDevices={audioDevices}
      activeAudioDevice={activeAudioDevice}
      onSelectAudio={selectAudio}
      onSelectSubtitle={selectSubtitle}
      onSelectAudioDevice={selectAudioDevice}
      onCycleResizeMode={cycleResizeMode}
      onOpenTracks={() => setActiveOverlay('tracks')}
      {...(handleOpenMultiView !== undefined ? { onOpenMultiView: handleOpenMultiView } : {})}
      {...(handleOpenPopout !== undefined ? { onOpenPopout: handleOpenPopout } : {})}
      onClose={handleCloseOverlay}
    />
  );

  const programInfo = (
    <View
      testID="live-stage-program-info"
      style={[
        styles.programScrim,
        {
          paddingLeft: landscapeFloatingDrawer ? layout.padX + ZAP_DRAWER_WIDTH + 20 : layout.padX,
          paddingRight: layout.padX,
          paddingTop: isDocked ? theme.spacing.xs : 0,
          paddingBottom: isDocked ? theme.spacing.sm : theme.spacing.sm,
        },
        isDocked
          ? {
              backgroundColor: theme.colors.bgSurface,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.colors.surfaceBorder,
            }
          : null,
      ]}
    >
      <View style={styles.programHeadingRow}>
        <MicroPill label={i18n.t('ui.liveBadge')} tone="live" />
        <SourceBadgePill badge={activeSourceBadge} testID="live-stage-source-badge" />
        <Text
          testID="live-stage-channel-title"
          numberOfLines={1}
          style={[
            theme.typography.title,
            TABULAR_NUMS_STYLE,
            styles.shrink1,
            { color: theme.colors.textPrimary },
          ]}
        >
          {channelHeading}
        </Text>
      </View>
      <View style={styles.programDetailsRow}>
        <Text
          testID="live-stage-now-title"
          numberOfLines={1}
          style={[
            theme.typography.body,
            styles.shrink1,
            { color: theme.colors.textPrimary, fontWeight: '600' },
          ]}
        >
          {nowProg ? nowProg.title : i18n.t('live.noProgramInfo')}
        </Text>
        {nextProg ? (
          <Text
            testID="live-stage-next-title"
            numberOfLines={1}
            style={[
              theme.typography.caption,
              styles.shrink1,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${i18n.t('live.upNext')}: ${nextProg.title}`}
          </Text>
        ) : null}
      </View>
      <View
        style={[
          styles.progressTrack,
          { backgroundColor: theme.colors.subtleHighlight, borderRadius: theme.radius.pill },
        ]}
      >
        <View
          testID="live-stage-progress"
          style={[
            styles.progressFill,
            { backgroundColor: theme.colors.accent, width: pct, borderRadius: theme.radius.pill },
          ]}
        />
      </View>
    </View>
  );

  const surfaceContent =
    openedPreview !== null ? (
      openedPreview.renderSurface({
        statusText: preview?.statusText ?? '',
        failed: preview?.failed ?? false,
        resizeMode: toVideoResizeMode(resizeMode),
        testID: 'live-preview-surface',
      })
    ) : (
      <ArtworkImage
        testID="live-stage-backdrop"
        uri={activeChannel?.logo}
        label={activeChannelName}
        maxDecodePx={640}
        resizeMode="cover"
        logoBackdropMode={logoBackdropMode}
        borderRadius={0}
        decorative
        style={isDocked ? styles.flex1 : StyleSheet.absoluteFill}
      />
    );

  // Legacy child-HWND / docked mode: strict flex-flow, zero position: 'absolute' over video
  if (isDocked) {
    return (
      <View
        testID="live-watch-stage"
        style={[styles.stageDesktop, { backgroundColor: theme.colors.bgCanvas }]}
      >
        {drawerElement}
        <View testID="live-video-pane" style={styles.desktopMainCol}>
          <View
            testID="live-preview-surface-layer"
            style={[styles.previewSurfaceDesktop, { backgroundColor: theme.colors.bgCanvas }]}
            {...surfaceInteractionProps}
          >
            {surfaceContent}
          </View>
          {overlaysElement}
          {controlsElement}
          {programInfo}
        </View>
      </View>
    );
  }

  // Floating overlay mode (web/mobile/TV/modern composited desktop)
  const floatingFadeTransition = webTransition(theme, 'opacity');
  const floatingStage = (
    <View
      testID="live-video-pane"
      style={[styles.stage, { backgroundColor: theme.colors.bgCanvas }]}
      {...videoPanePointerProps}
    >
      <View
        testID="live-preview-surface-layer"
        style={StyleSheet.absoluteFill}
        {...surfaceInteractionProps}
      >
        {surfaceContent}
      </View>
      <Scrim direction="top" intensity="default" />
      <Scrim direction="bottom" intensity="strong" />
      <View style={styles.flex1} pointerEvents="none" />
      {overlaysElement}
      <View
        testID="live-split-controls-overlay"
        pointerEvents={floatingVisible ? 'box-none' : 'none'}
        style={[
          styles.floatingOverlayChrome,
          {
            opacity: floatingVisible ? 1 : 0,
            paddingLeft: landscapeFloatingDrawer
              ? layout.padX + ZAP_DRAWER_WIDTH + 20
              : layout.padX,
            paddingRight: layout.padX,
            paddingBottom: layout.isPortrait && zapDrawerOpen ? 8 : theme.spacing.md,
          },
          floatingFadeTransition,
        ]}
      >
        {controlsElement}
        <View style={styles.floatingProgramWrap}>{programInfo}</View>
      </View>
      {!isDesktop ? drawerElement : null}
    </View>
  );

  if (isDesktop) {
    return (
      <View
        testID="live-watch-stage"
        style={[styles.stageDesktop, { backgroundColor: theme.colors.bgCanvas }]}
      >
        {drawerElement}
        {floatingStage}
      </View>
    );
  }

  return (
    <View
      testID="live-watch-stage"
      style={[styles.stage, { backgroundColor: theme.colors.bgCanvas }]}
    >
      {floatingStage}
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  shrink1: { flexShrink: 1 },
  stage: { flex: 1, position: 'relative', overflow: 'hidden' },
  stageDesktop: { flex: 1, flexDirection: 'row', overflow: 'hidden' },
  desktopMainCol: { flex: 1, minWidth: 0 },
  previewSurfaceDesktop: { flex: 1, minHeight: 160, overflow: 'hidden' },
  emptyWrap: {
    flex: 1,
    width: '100%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyBody: { maxWidth: 420 },
  emptyActions: { width: '100%', alignItems: 'center', justifyContent: 'center' },
  emptyBrowseCta: { alignSelf: 'center' },
  centerText: { textAlign: 'center' },
  floatingOverlayChrome: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: 8,
    zIndex: 6,
  },
  floatingProgramWrap: { marginHorizontal: -16 },
  programScrim: { zIndex: 2 },
  programHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  programDetailsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 4,
  },
  progressTrack: {
    height: 3,
    width: '100%',
    maxWidth: 460,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressFill: { height: 3 },
});
