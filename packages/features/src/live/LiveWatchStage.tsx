import type { ItemRow, NowNextEntry } from '@elv/data';
import {
  ArtworkImage,
  CtaButton,
  IconButton,
  MicroPill,
  Scrim,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { OpenVideoEngine } from '../ports/video-host';
import type { CatalogLayoutMetrics, PagedListSource } from '../shared';
import { LiveZapDrawer, ZAP_DRAWER_WIDTH } from './LiveZapDrawer';
import { computeProgramProgress } from './live-model';

/** Embedded live preview slice rendered inside {@link LiveWatchStage}. */
export interface LiveStagePreview {
  readonly opened: OpenVideoEngine | null;
  readonly statusText: string;
  readonly failed: boolean;
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
  readonly isFavorite?: boolean;
  readonly isDesktop?: boolean;
  readonly preview?: LiveStagePreview;
  readonly layout: CatalogLayoutMetrics;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onToggleZapDrawer: () => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onBrowseChannels?: () => void;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
  readonly onWatchFullscreen: (channel: ItemRow, index: number) => void;
  readonly focusedControl?: 'miniguide' | 'favorite' | 'watch' | 'browse' | null;
  readonly focusedZapIndex?: number | null;
  /** Injectable epoch clock in milliseconds for live progress bars (defaults to `() => Date.now()`). */
  readonly now?: () => number;
}

/**
 * Cinema Quietude Live TV Favorites Stage (`UI_UX_PHILOSOPHY.md` §1 & §3): shows favorited live
 * channels only, renders real embedded live video preview (flex-flow HWND-safe on desktop,
 * full-bleed behind translucent scrims on TV/mobile), 1-click favorite toggle, Mini-Guide drawer,
 * and single-connection-safe fullscreen handoff — with zero Number Pad or Previous Channel clutter.
 */
export function LiveWatchStage(p: LiveWatchStageProps): ReactElement {
  const { activeChannel, activeChannelIndex, channelSource, sourceVersion } = p;
  const { nowNextByKey, nowNextVersion, zapDrawerOpen, layout, isFavorite = true } = p;
  const { isDesktop = false, preview, focusedControl = null, focusedZapIndex = null, now } = p;
  const { onWatchFullscreen, onToggleFavorite, onBrowseChannels } = p;

  const theme = useTheme();
  const i18n = useI18n();

  const handleWatchFullscreen = useCallback(() => {
    if (activeChannel) onWatchFullscreen(activeChannel, activeChannelIndex);
  }, [activeChannel, activeChannelIndex, onWatchFullscreen]);

  const handleToggleFavorite = useCallback(() => {
    if (activeChannel) onToggleFavorite?.(activeChannel);
  }, [activeChannel, onToggleFavorite]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh clock snapshot alongside schedule updates
  const nowMs = useMemo(() => (now ? now() : Date.now()), [now, nowNextVersion, sourceVersion]);

  const hasFavorites = (channelSource?.count() ?? 0) > 0 || activeChannel !== null;
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
          <CtaButton
            testID="live-browse-channels"
            label={i18n.t('live.browseChannels')}
            variant="primary"
            focusable={!layout.isTv}
            focused={layout.isTv && focusedControl === 'browse'}
            onPress={onBrowseChannels}
          />
        ) : null}
      </View>
    );
  }

  const activeNowNext = activeChannel ? nowNextByKey.get(activeChannel.key) : undefined;
  const nowProg = activeNowNext?.now ?? null;
  const nextProg = activeNowNext?.next ?? null;
  const ratio = nowProg ? computeProgramProgress(nowProg.start, nowProg.stop, nowMs) : 0;
  const pct = `${Math.round(ratio * 100)}%` as const;
  const channelHeading = activeChannel
    ? activeChannel.num !== null && activeChannel.num !== undefined
      ? `${activeChannel.num} · ${activeChannel.name}`
      : activeChannel.name
    : i18n.t('nav.live');
  const openedPreview = preview?.opened ?? null;
  const desktopHwndSafe = isDesktop;
  const landscapeDrawerActive = zapDrawerOpen && !layout.isPortrait;

  const actionBar = (
    <View
      testID="live-stage-actions"
      style={[
        styles.topActions,
        {
          paddingHorizontal: layout.padX,
          paddingVertical: desktopHwndSafe ? theme.spacing.xs : 0,
          paddingTop: desktopHwndSafe ? theme.spacing.xs : theme.spacing.sm,
        },
        desktopHwndSafe
          ? {
              backgroundColor: theme.colors.bgSurface,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.surfaceBorder,
            }
          : null,
      ]}
    >
      <View style={styles.actionGroup}>
        <IconButton
          testID="live-toggle-miniguide"
          icon="list"
          accessibilityLabel={i18n.t('live.miniGuide')}
          active={zapDrawerOpen}
          focusable={!layout.isTv}
          focused={layout.isTv && focusedControl === 'miniguide'}
          onPress={p.onToggleZapDrawer}
        />
        {onToggleFavorite ? (
          <IconButton
            testID="live-stage-favorite"
            icon={isFavorite ? 'starFilled' : 'star'}
            active={isFavorite}
            accessibilityLabel={i18n.t(isFavorite ? 'live.favoriteRemove' : 'live.favoriteAdd')}
            disabled={activeChannel === null}
            focusable={!layout.isTv}
            focused={layout.isTv && focusedControl === 'favorite'}
            onPress={handleToggleFavorite}
          />
        ) : null}
      </View>
      <CtaButton
        testID="live-watch-fullscreen"
        label={i18n.t('live.watchFullscreen')}
        icon="play"
        variant="primary"
        disabled={activeChannel === null}
        focusable={!layout.isTv}
        focused={layout.isTv && focusedControl === 'watch'}
        onPress={handleWatchFullscreen}
      />
    </View>
  );

  const programInfo = (
    <View
      testID="live-stage-program-info"
      style={[
        styles.programScrim,
        {
          paddingLeft:
            !desktopHwndSafe && landscapeDrawerActive
              ? layout.padX + ZAP_DRAWER_WIDTH + 20
              : layout.padX,
          paddingRight: layout.padX,
          paddingTop: desktopHwndSafe ? theme.spacing.sm : 0,
          paddingBottom: desktopHwndSafe
            ? theme.spacing.sm
            : layout.isPortrait && zapDrawerOpen
              ? 10
              : theme.spacing.lg,
        },
        desktopHwndSafe
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
      <Text
        testID="live-stage-now-title"
        numberOfLines={2}
        style={[theme.typography.h2, { color: theme.colors.textPrimary, marginTop: 4 }]}
      >
        {nowProg ? nowProg.title : i18n.t('live.noProgramInfo')}
      </Text>
      {nextProg ? (
        <Text
          testID="live-stage-next-title"
          numberOfLines={1}
          style={[theme.typography.caption, { color: theme.colors.textSecondary, marginTop: 2 }]}
        >
          {`${i18n.t('live.upNext')}: ${nextProg.title}`}
        </Text>
      ) : null}
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

  if (desktopHwndSafe) {
    return (
      <View
        testID="live-watch-stage"
        style={[styles.stageDesktop, { backgroundColor: theme.colors.bgCanvas }]}
      >
        {zapDrawerOpen ? (
          <LiveZapDrawer
            docked
            channelSource={channelSource}
            sourceVersion={sourceVersion}
            nowNextByKey={nowNextByKey}
            nowNextVersion={nowNextVersion}
            activeChannelKey={activeChannel?.key ?? null}
            focusedZapIndex={focusedZapIndex}
            layout={layout}
            hydrateNowNext={p.hydrateNowNext}
            onSelectChannel={p.onSelectChannel}
          />
        ) : null}
        <View style={styles.desktopMainCol}>
          {actionBar}
          <View
            testID="live-preview-surface-layer"
            style={[styles.previewSurfaceDesktop, { backgroundColor: theme.colors.bgCanvas }]}
          >
            {openedPreview !== null ? (
              openedPreview.renderSurface({
                statusText: preview?.statusText ?? '',
                failed: preview?.failed ?? false,
                testID: 'live-preview-surface',
              })
            ) : (
              <ArtworkImage
                testID="live-stage-backdrop"
                uri={activeChannel?.logo}
                label={activeChannel?.name ?? i18n.t('nav.live')}
                maxDecodePx={640}
                resizeMode="cover"
                borderRadius={0}
                decorative
                style={styles.flex1}
              />
            )}
          </View>
          {programInfo}
        </View>
      </View>
    );
  }

  return (
    <View
      testID="live-watch-stage"
      style={[styles.stage, { backgroundColor: theme.colors.bgCanvas }]}
    >
      {openedPreview !== null ? (
        <View testID="live-preview-surface-layer" style={StyleSheet.absoluteFill}>
          {openedPreview.renderSurface({
            statusText: preview?.statusText ?? '',
            failed: preview?.failed ?? false,
            testID: 'live-preview-surface',
          })}
        </View>
      ) : (
        <ArtworkImage
          testID="live-stage-backdrop"
          uri={activeChannel?.logo}
          label={activeChannel?.name ?? i18n.t('nav.live')}
          maxDecodePx={640}
          resizeMode="cover"
          borderRadius={0}
          decorative
          style={StyleSheet.absoluteFill}
        />
      )}
      <Scrim direction="top" intensity="default" />
      <Scrim direction="bottom" intensity="strong" />
      {actionBar}
      <View style={styles.flex1} />
      {programInfo}
      {zapDrawerOpen ? (
        <LiveZapDrawer
          channelSource={channelSource}
          sourceVersion={sourceVersion}
          nowNextByKey={nowNextByKey}
          nowNextVersion={nowNextVersion}
          activeChannelKey={activeChannel?.key ?? null}
          focusedZapIndex={focusedZapIndex}
          layout={layout}
          hydrateNowNext={p.hydrateNowNext}
          onSelectChannel={p.onSelectChannel}
        />
      ) : null}
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
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyBody: { maxWidth: 420 },
  centerText: { textAlign: 'center' },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    zIndex: 4,
  },
  actionGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  programScrim: { zIndex: 2 },
  programHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressTrack: {
    height: 3,
    width: '100%',
    maxWidth: 460,
    marginTop: 10,
    overflow: 'hidden',
  },
  progressFill: { height: 3 },
});
