import type { CatalogService, ItemRow, SourceRow } from '@elv/data';
import { IconButton, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../ports/play-target';
import { computeCatalogLayout } from '../shared';
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
import { LiveWatchStage } from './LiveWatchStage';
import type { LiveMode, LiveTabMemory } from './live-model';
import { useLiveCatalog } from './useLiveCatalog';
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
  readonly memory?: LiveTabMemory;
  readonly onMemoryChange?: (next: LiveTabMemory) => void;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenSources: () => void;
  readonly onFocusTopNav?: () => void;
  readonly isActiveScope?: boolean;
  /** Optional fixed epoch timestamp in milliseconds for deterministic EPG/progress rendering. */
  readonly nowMs?: number;
}

/**
 * Unified Cinema Quietude Live TV Hub (`UI_UX_PHILOSOPHY.md` §2.1 & §3): composes the top
 * `Watch` | `Channels` | `TV Guide` mode switcher, horizontal category filter bar, `0–9` channel
 * number pad, virtualized `LiveChannelsGrid`, 1,000-channel × 7-day `EpgGridView`, and
 * playback-first `LiveWatchStage` with 10-ft TV D-pad scope handoff.
 */
export function LiveScreen({
  catalog,
  sources,
  refreshToken,
  memory,
  onMemoryChange,
  onPlay,
  onOpenSources,
  onFocusTopNav,
  isActiveScope = true,
  nowMs,
}: LiveScreenProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const layout = useMemo(() => computeCatalogLayout(viewport, theme), [theme, viewport]);

  const {
    memory: activeMemory,
    memoryRef: activeMemoryRef,
    updateMemory,
  } = useLiveTabMemory(memory, onMemoryChange);

  const [numpadOpen, setNumpadOpen] = useState(false);
  const [guideRefreshTick, setGuideRefreshTick] = useState(0);
  const numpadPendingJumpRef = useRef(false);

  const readySources = useMemo(() => sources.filter((s) => !s.needsImport), [sources]);
  const clockFn = useMemo(() => (nowMs !== undefined ? () => nowMs : undefined), [nowMs]);

  const handleSelectCategory = useCallback(
    (categoryId: string | null) => updateMemory({ categoryId }),
    [updateMemory],
  );
  const handleChannelHistoryChange = useCallback(
    (next: {
      readonly activeChannelKey: string | null;
      readonly previousChannelKey: string | null;
    }) => {
      if (numpadPendingJumpRef.current) {
        numpadPendingJumpRef.current = false;
        setNumpadOpen(false);
        if (activeMemoryRef.current.mode === 'channels') {
          updateMemory({ ...next, mode: 'watch' });
          return;
        }
      }
      updateMemory(next);
    },
    [activeMemoryRef, updateMemory],
  );

  const live = useLiveCatalog({
    catalog,
    sources: readySources,
    refreshToken: refreshToken + guideRefreshTick,
    selectedCategoryId: activeMemory.categoryId,
    activeChannelKey: activeMemory.activeChannelKey,
    previousChannelKey: activeMemory.previousChannelKey,
    onSelectCategoryId: handleSelectCategory,
    onChannelHistoryChange: handleChannelHistoryChange,
    ...(clockFn !== undefined ? { now: clockFn } : {}),
  });
  useEffect(() => {
    if (live.numberFeedback !== null) numpadPendingJumpRef.current = false;
  }, [live.numberFeedback]);

  const handleSelectMode = useCallback(
    (mode: LiveMode) => {
      numpadPendingJumpRef.current = false;
      setNumpadOpen(false);
      updateMemory({ mode });
    },
    [updateMemory],
  );
  const handleToggleZapDrawer = useCallback(
    () => updateMemory({ zapDrawerOpen: !activeMemoryRef.current.zapDrawerOpen }),
    [activeMemoryRef, updateMemory],
  );
  const handlePressDigit = useCallback(
    (digit: string) => {
      numpadPendingJumpRef.current = true;
      live.pressDigit(digit);
    },
    [live.pressDigit],
  );
  const handleClearNumber = useCallback(() => {
    numpadPendingJumpRef.current = false;
    live.clearNumber();
  }, [live.clearNumber]);
  const handleCloseNumpad = useCallback(() => {
    handleClearNumber();
    setNumpadOpen(false);
  }, [handleClearNumber]);
  const handleToggleNumpad = useCallback(() => {
    setNumpadOpen((open) => {
      if (open) handleClearNumber();
      return !open;
    });
  }, [handleClearNumber]);
  const handleSubmitNumber = useCallback(() => {
    void live.submitNumberJump();
  }, [live.submitNumberJump]);
  const handlePressNumpadKey = useCallback(
    (key: string) => {
      if (key === 'C') handleClearNumber();
      else if (key === '↵') handleSubmitNumber();
      else handlePressDigit(key);
    },
    [handleClearNumber, handlePressDigit, handleSubmitNumber],
  );
  const handleWatchAndPlay = useCallback(
    (channel: ItemRow, index: number) => {
      live.tuneChannel(channel, index);
      onPlay(live.buildPlayTarget(channel, index));
    },
    [live.buildPlayTarget, live.tuneChannel, onPlay],
  );
  const handleGuideRefreshed = useCallback(() => setGuideRefreshTick((n) => n + 1), []);

  const hasReadySources = readySources.length > 0;
  const isInitialLoading =
    hasReadySources && live.loadingCategories && live.categories.length === 0;
  const hasCategories = live.categories.length > 0;
  const isEmpty = !isInitialLoading && (!hasReadySources || !hasCategories);
  const mode = activeMemory.mode;
  const hasBody =
    mode === 'watch' ? hasCategories : live.channelSource !== null && live.activeCategory !== null;

  const handleSelectCategoryIndex = useCallback(
    (idx: number) => {
      const cat = live.categories[idx];
      if (cat) handleSelectCategory(cat.row.id);
    },
    [handleSelectCategory, live.categories],
  );
  const handleActivateWatchControl = useCallback(
    (ctrl: LiveWatchControl) => {
      if (ctrl === 'miniguide') handleToggleZapDrawer();
      else if (ctrl === 'prev') live.tunePreviousChannel();
      else if (ctrl === 'numpad') handleToggleNumpad();
      else if (ctrl === 'watch' && live.activeChannel) {
        onPlay(live.buildPlayTarget(live.activeChannel, live.activeChannelIndex));
      }
    },
    [handleToggleNumpad, handleToggleZapDrawer, live, onPlay],
  );
  const handleSelectZapIndex = useCallback(
    (idx: number) => {
      const ch = live.channelSource?.get(idx);
      if (ch) live.tuneChannel(ch, idx);
      else void live.channelSource?.loadItem(idx).then((row) => row && live.tuneChannel(row, idx));
    },
    [live.channelSource, live.tuneChannel],
  );

  const tvNav = useTvLiveNavigation({
    isTv: layout.isTv,
    isActiveScope,
    isEmpty,
    hasOpenSourcesCta: !hasReadySources,
    mode,
    categoryCount: live.categories.length,
    channelCount: live.channelCount,
    hasBody,
    zapDrawerOpen: activeMemory.zapDrawerOpen,
    numpadOpen,
    hasPreviousChannel: live.previousChannel !== null,
    onSelectMode: handleSelectMode,
    onSelectCategoryIndex: handleSelectCategoryIndex,
    onToggleNumpad: handleToggleNumpad,
    onCloseNumpad: handleCloseNumpad,
    onPressNumpadKey: handlePressNumpadKey,
    onActivateWatchControl: handleActivateWatchControl,
    onSelectZapIndex: handleSelectZapIndex,
    onOpenSources,
    ...(onFocusTopNav !== undefined ? { onFocusTopNav } : {}),
  });

  const childOwnsTvKeys =
    !numpadOpen &&
    !isEmpty &&
    !isInitialLoading &&
    tvNav.tvZone === 'body' &&
    (mode === 'channels' || mode === 'epg') &&
    hasBody;

  const bodyActiveScope = isActiveScope && tvNav.tvZone === 'body' && !numpadOpen;
  const hasPendingItems = (live.activeCategory?.row.itemCount ?? 0) > 0;

  return (
    <View testID="live-screen" style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}>
      {layout.isTv && isActiveScope && !childOwnsTvKeys ? (
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
            {mode === 'channels' ? (
              <IconButton
                testID="live-channels-numpad-toggle"
                icon="keypad"
                accessibilityLabel={i18n.t('live.numberPad')}
                active={numpadOpen}
                focusable={!layout.isTv}
                focused={tvNav.focusedNumpadToggle}
                onPress={handleToggleNumpad}
              />
            ) : null}
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
            {mode === 'channels' && numpadOpen ? (
              <View style={[styles.numpadAnchor, { right: layout.padX }]}>
                <LiveNumberPad
                  visible
                  buffer={live.numberBuffer}
                  feedback={live.numberFeedback}
                  isTv={layout.isTv}
                  isTouch={layout.isTouch}
                  focusedKey={tvNav.focusedNumpadKey}
                  onDigit={handlePressDigit}
                  onClear={handleClearNumber}
                  onSubmit={handleSubmitNumber}
                  onClose={handleCloseNumpad}
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
                  layout={layout}
                  hydrateNowNext={live.hydrateNowNext}
                  onWatchChannel={handleWatchAndPlay}
                  onEdgeTop={tvNav.handleChildEdgeTop}
                  isActiveScope={bodyActiveScope}
                  {...(clockFn !== undefined ? { now: clockFn } : {})}
                />
              ) : (
                <LiveCategoryFallback
                  layout={layout}
                  hasPendingItems={hasPendingItems}
                  onOpenSources={onOpenSources}
                />
              )
            ) : mode === 'epg' ? (
              live.activeCategory && live.channelSource ? (
                <EpgGridView
                  catalog={catalog}
                  category={live.activeCategory}
                  channelSource={live.channelSource}
                  sourceVersion={live.sourceVersion}
                  refreshToken={refreshToken + guideRefreshTick}
                  {...(nowMs !== undefined ? { nowMs } : {})}
                  onWatchChannel={handleWatchAndPlay}
                  onGuideRefreshed={handleGuideRefreshed}
                  onEdgeTop={tvNav.handleChildEdgeTop}
                  isActiveScope={bodyActiveScope}
                />
              ) : (
                <LiveCategoryFallback
                  layout={layout}
                  hasPendingItems={hasPendingItems}
                  onOpenSources={onOpenSources}
                />
              )
            ) : (
              <LiveWatchStage
                activeChannel={live.activeChannel}
                activeChannelIndex={live.activeChannelIndex}
                previousChannel={live.previousChannel}
                channelSource={live.channelSource}
                sourceVersion={live.sourceVersion}
                nowNextByKey={live.nowNextByKey}
                nowNextVersion={live.nowNextVersion}
                zapDrawerOpen={activeMemory.zapDrawerOpen}
                numpadOpen={numpadOpen}
                numberBuffer={live.numberBuffer}
                numberFeedback={live.numberFeedback}
                layout={layout}
                hydrateNowNext={live.hydrateNowNext}
                onToggleZapDrawer={handleToggleZapDrawer}
                onPreviousChannel={live.tunePreviousChannel}
                onToggleNumpad={handleToggleNumpad}
                onPressDigit={handlePressDigit}
                onClearNumber={handleClearNumber}
                onSubmitNumber={handleSubmitNumber}
                onSelectChannel={live.tuneChannel}
                onWatchFullscreen={handleWatchAndPlay}
                focusedControl={tvNav.focusedWatchControl}
                focusedZapIndex={tvNav.focusedZapIndex}
                focusedNumpadKey={tvNav.focusedNumpadKey}
                {...(clockFn !== undefined ? { now: clockFn } : {})}
              />
            )}
          </View>
        </View>
      )}
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
  body: { flex: 1, position: 'relative' },
  numpadAnchor: { position: 'absolute', top: 8, zIndex: 8 },
});
