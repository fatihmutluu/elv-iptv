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
import type { CatalogLayoutMetrics, PagedListSource } from '../shared';
import { LiveNumberPad } from './LiveChrome';
import { LiveZapDrawer, ZAP_DRAWER_WIDTH } from './LiveZapDrawer';
import { computeProgramProgress } from './live-model';
import type { LiveNumberFeedback } from './useLiveCatalog';

/** Props of {@link LiveWatchStage}. */
export interface LiveWatchStageProps {
  readonly activeChannel: ItemRow | null;
  readonly activeChannelIndex: number;
  readonly previousChannel: ItemRow | null;
  readonly channelSource: PagedListSource<ItemRow> | null;
  readonly sourceVersion: number;
  readonly nowNextByKey: ReadonlyMap<string, NowNextEntry>;
  readonly nowNextVersion: number;
  readonly zapDrawerOpen: boolean;
  readonly numpadOpen: boolean;
  readonly numberBuffer: string;
  readonly numberFeedback: LiveNumberFeedback | null;
  readonly layout: CatalogLayoutMetrics;
  readonly hydrateNowNext: (channelKeys: readonly string[]) => void;
  readonly onToggleZapDrawer: () => void;
  readonly onPreviousChannel: () => void;
  readonly onToggleNumpad: () => void;
  readonly onPressDigit: (digit: string) => void;
  readonly onClearNumber: () => void;
  readonly onSubmitNumber: () => void;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
  readonly onWatchFullscreen: (channel: ItemRow, index: number) => void;
  readonly focusedControl?: 'miniguide' | 'prev' | 'numpad' | 'watch' | null;
  readonly focusedZapIndex?: number | null;
  readonly focusedNumpadKey?: string | null;
  /** Injectable epoch clock in milliseconds for live progress bars (defaults to `() => Date.now()`). */
  readonly now?: () => number;
}

/**
 * Playback-first Cinema Quietude Live TV Watch Stage (`UI_UX_PHILOSOPHY.md` §1 & §3): full-bleed
 * stage backdrop, top action cluster (`Mini-Guide`, `Previous channel`, `Number pad`, `Watch live`),
 * virtualized Mini-Guide Zap Drawer, floating `0–9` Number Pad, and collision-free bottom scrim.
 */
export function LiveWatchStage(p: LiveWatchStageProps): ReactElement {
  const { activeChannel, activeChannelIndex, previousChannel, channelSource, sourceVersion } = p;
  const { nowNextByKey, nowNextVersion, zapDrawerOpen, numpadOpen, layout } = p;
  const { focusedControl = null, focusedZapIndex = null, now, onWatchFullscreen } = p;

  const theme = useTheme();
  const i18n = useI18n();

  const handleWatchFullscreen = useCallback(() => {
    if (activeChannel) onWatchFullscreen(activeChannel, activeChannelIndex);
  }, [activeChannel, activeChannelIndex, onWatchFullscreen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh clock snapshot alongside schedule updates
  const nowMs = useMemo(() => (now ? now() : Date.now()), [now, nowNextVersion, sourceVersion]);
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
  const landscapeDrawerActive = zapDrawerOpen && !layout.isPortrait;

  return (
    <View
      testID="live-watch-stage"
      style={[styles.stage, { backgroundColor: theme.colors.bgCanvas }]}
    >
      <ArtworkImage
        testID="live-stage-backdrop"
        uri={activeChannel?.logo}
        label={activeChannel?.name ?? i18n.t('nav.live')}
        maxDecodePx={640}
        resizeMode="cover"
        borderRadius={0}
        style={StyleSheet.absoluteFill}
      />
      <Scrim direction="top" intensity="default" />
      <Scrim direction="bottom" intensity="strong" />

      <View
        testID="live-stage-actions"
        style={[
          styles.topActions,
          { paddingHorizontal: layout.padX, paddingTop: theme.spacing.sm },
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
          <IconButton
            testID="live-prev-channel"
            icon="prevChannel"
            accessibilityLabel={i18n.t('live.prevChannel')}
            disabled={previousChannel === null}
            focusable={!layout.isTv}
            focused={layout.isTv && focusedControl === 'prev'}
            onPress={p.onPreviousChannel}
          />
          <IconButton
            testID="live-toggle-numpad"
            icon="keypad"
            accessibilityLabel={i18n.t('live.numberPad')}
            active={numpadOpen}
            focusable={!layout.isTv}
            focused={layout.isTv && focusedControl === 'numpad'}
            onPress={p.onToggleNumpad}
          />
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

      {numpadOpen ? (
        <View style={[styles.numpadAnchor, { right: layout.padX }]}>
          <LiveNumberPad
            visible
            buffer={p.numberBuffer}
            feedback={p.numberFeedback}
            isTv={layout.isTv}
            isTouch={layout.isTouch}
            focusedKey={p.focusedNumpadKey ?? null}
            onDigit={p.onPressDigit}
            onClear={p.onClearNumber}
            onSubmit={p.onSubmitNumber}
            onClose={p.onToggleNumpad}
          />
        </View>
      ) : null}

      <View style={styles.flex1} />

      <View
        testID="live-stage-program-info"
        style={[
          styles.programScrim,
          {
            paddingLeft: landscapeDrawerActive ? layout.padX + ZAP_DRAWER_WIDTH + 20 : layout.padX,
            paddingRight: layout.padX,
            paddingBottom: layout.isPortrait && zapDrawerOpen ? 10 : theme.spacing.lg,
          },
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
              {
                backgroundColor: theme.colors.accent,
                width: pct,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        </View>
      </View>

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
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    zIndex: 4,
  },
  actionGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  numpadAnchor: { position: 'absolute', top: 64, zIndex: 6 },
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
