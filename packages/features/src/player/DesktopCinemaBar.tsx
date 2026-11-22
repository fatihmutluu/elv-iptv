import { useTheme, useViewport } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { JumpToLiveButton, OsdButton, OsdClock, PLAYER_KEY_SHORTCUTS } from './PlayerOsdButton';
import { DesktopPeekStrip, LiveNowNextStrip, PlayerFailureBanner } from './PlayerOsdChrome';
import { type PlayerOsdProps, PlayerOsdTopBar } from './PlayerOsdTopBar';
import type { TvOsdAction } from './usePlayerControls';
import { VodProgressBar } from './VodProgressBar';

export { type PlayerOsdProps, PlayerOsdTopBar };

/**
 * Unified borderless Minimalist Cinema bottom bar (`Product Decision #40`):
 * Row 1: full-width hairline timeline (`VodProgressBar` or `LiveNowNextStrip`).
 * Row 2: centered transport trio (`skipBack10` / translucent glass `Play/Pause` / `skipForward10`)
 * with balanced left utilities and bottom-right dark-glass CTA pill (`Next Episode` / `Channels`).
 */
export function PlayerOsdBottomBar(
  p: PlayerOsdProps & { readonly docked?: boolean },
): ReactElement {
  const viewport = useViewport();
  const {
    i18n,
    isTv,
    isVod,
    service,
    settingsOpen = false,
    infoOpen = false,
    channelListOpen = false,
    playbackSpeed = 1,
  } = p;
  const isDesktop = p.isDesktop ?? viewport.formFactor === 'desktop';
  const isPortrait = !isTv && viewport.orientation === 'portrait';
  const isNarrow =
    (!isTv && !isDesktop && isPortrait) || (!isTv && viewport.width > 0 && viewport.width < 540);
  const anySheetOpen = p.tracksOpen || settingsOpen || infoOpen || channelListOpen;
  const isFocused = (action: TvOsdAction): boolean =>
    isTv && p.tvOsdFocused && p.tvOsdAction === action;
  const showPrevChannelBtn =
    !isVod &&
    service !== null &&
    p.hasPreviousChannel === true &&
    p.onJumpPreviousChannel !== undefined;
  const hasChapters = isVod && (p.chapters?.length ?? 0) > 0;
  const showNextEpisodePill =
    isVod &&
    service !== null &&
    p.hasNextEpisodeAction === true &&
    p.onPlayNextEpisode !== undefined;
  const showChannelsPill = !isVod && p.canZap && p.onToggleChannelList !== undefined;
  const showAnyActionPill = showNextEpisodePill || showChannelsPill;

  const actionPillsNode = (
    <>
      {showNextEpisodePill && p.onPlayNextEpisode !== undefined ? (
        <OsdButton
          testID="player-next-episode-pill"
          variant="pill-cta"
          label={i18n.t('player.nextEpisodeCta')}
          accessibilityLabel={i18n.t('player.nextEpisodeCta')}
          onPress={p.onPlayNextEpisode}
          isTv={isTv}
          tvFocused={isFocused('nextEpisode') && p.nextEpisodeBannerVisible !== true}
        />
      ) : null}
      {showChannelsPill && p.onToggleChannelList !== undefined ? (
        <OsdButton
          testID="player-channel-list-button"
          variant="pill-cta"
          label={i18n.t('player.channelsCta')}
          accessibilityLabel={i18n.t('player.channelList')}
          {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.channelList } : {})}
          active={channelListOpen}
          onPress={p.onToggleChannelList}
          isTv={isTv}
          tvFocused={isFocused('channelList')}
        />
      ) : null}
    </>
  );

  return (
    <View style={styles.bottomStack}>
      {p.failure !== null ? (
        <PlayerFailureBanner failure={p.failure} i18n={i18n} compact={p.docked === true} />
      ) : null}

      {isNarrow && showAnyActionPill ? (
        <View testID="player-narrow-cta-row" style={styles.narrowCtaRow}>
          {actionPillsNode}
        </View>
      ) : null}

      {isVod ? (
        <VodProgressBar
          service={service}
          clock={p.clock}
          isTv={isTv}
          tvFocused={isTv && p.tvScrubberFocused === true}
          docked={p.docked === true}
          label={i18n.t('player.progressLabel')}
          previewPositionMs={p.previewPositionMs}
          dimmed={isPortrait && anySheetOpen}
          chapters={p.chapters}
          timeDisplayMode={p.timeDisplayMode}
          playbackSpeed={playbackSpeed}
          wallClock={p.wallClock}
          i18n={i18n}
          onCycleTimeDisplayMode={p.onCycleTimeDisplayMode}
          onFineScrubHaptic={p.onFineScrubHaptic}
          onSeekRatio={p.onSeekRatio}
          {...(p.onScrubbingChange !== undefined ? { onScrubbingChange: p.onScrubbingChange } : {})}
        />
      ) : (
        <LiveNowNextStrip
          nowNext={p.nowNext}
          nowMs={p.nowMs ?? Date.now()}
          i18n={i18n}
          timeDisplayMode={p.timeDisplayMode}
        />
      )}

      <View testID="player-bottom-transport" style={styles.transportRow}>
        <View style={styles.transportLeft}>
          {!isVod ? (
            <OsdClock service={service} clock={p.clock} previewPositionMs={p.previewPositionMs} />
          ) : null}
          <JumpToLiveButton
            isVod={isVod}
            service={service}
            clock={p.clock}
            i18n={i18n}
            isTv={isTv}
            compact
            {...(p.onJumpToLiveEdge !== undefined ? { onPress: p.onJumpToLiveEdge } : {})}
          />
          {showPrevChannelBtn && p.onJumpPreviousChannel !== undefined ? (
            <OsdButton
              testID="player-prev-channel"
              variant="bare"
              icon="prevChannel"
              size={38}
              accessibilityLabel={i18n.t('player.jumpPreviousChannel')}
              onPress={p.onJumpPreviousChannel}
              isTv={isTv}
              tvFocused={isFocused('prevChannel')}
            />
          ) : null}
          {!isNarrow && hasChapters && p.onPrevChapter !== undefined ? (
            <OsdButton
              testID="player-prev-chapter"
              variant="bare"
              icon="skipPrev"
              iconSize={18}
              size={36}
              accessibilityLabel={i18n.t('player.prevChapter')}
              onPress={p.onPrevChapter}
              isTv={isTv}
            />
          ) : null}
          {!isNarrow && hasChapters && p.onNextChapter !== undefined ? (
            <OsdButton
              testID="player-next-chapter"
              variant="bare"
              icon="skipNext"
              iconSize={18}
              size={36}
              accessibilityLabel={i18n.t('player.nextChapter')}
              onPress={p.onNextChapter}
              isTv={isTv}
            />
          ) : null}
          {p.showRetry ? (
            <OsdButton
              testID="player-retry"
              variant="pill-cta"
              icon="refresh"
              compact
              label={i18n.t('player.retry')}
              onPress={p.onRetry}
              isTv={isTv}
              tvFocused={
                p.tvOsdFocused
                  ? isFocused('retry')
                  : isTv && !anySheetOpen && p.tvScrubberFocused !== true
              }
            />
          ) : null}
        </View>

        <View style={[styles.transportCenter, { gap: isTv ? 24 : 20 }]}>
          {isVod && service !== null ? (
            <>
              <OsdButton
                testID="player-seek-back"
                icon="skipBack10"
                variant="bare"
                size={44}
                iconSize={26}
                accessibilityLabel={i18n.t('player.seekBack')}
                {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.seekBack } : {})}
                onPress={p.onSeekBack}
                isTv={isTv}
                tvFocused={isFocused('seekBack')}
              />
              <OsdButton
                testID="player-play-pause"
                variant="glass-primary"
                circular
                size={isTv ? 54 : 48}
                iconSize={isTv ? 24 : 20}
                loading={p.isBuffering === true}
                icon={p.isPausedOrEnded ? 'play' : 'pause'}
                accessibilityLabel={
                  p.isPausedOrEnded ? i18n.t('player.play') : i18n.t('player.pause')
                }
                {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.playPause } : {})}
                onPress={p.onTogglePlayPause}
                isTv={isTv}
                tvFocused={isFocused('playPause')}
              />
              <OsdButton
                testID="player-seek-forward"
                icon="skipForward10"
                variant="bare"
                size={44}
                iconSize={26}
                accessibilityLabel={i18n.t('player.seekForward')}
                {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.seekForward } : {})}
                onPress={p.onSeekForward}
                isTv={isTv}
                tvFocused={isFocused('seekForward')}
              />
            </>
          ) : !isVod && (service !== null || p.canZap) ? (
            <>
              {p.canZap ? (
                <OsdButton
                  testID="player-prev"
                  icon="chevronLeft"
                  variant="bare"
                  size={44}
                  iconSize={24}
                  accessibilityLabel={i18n.t('player.prevChannel')}
                  onPress={p.onPrev}
                  isTv={isTv}
                />
              ) : null}
              {service !== null ? (
                <OsdButton
                  testID="player-play-pause"
                  variant="glass-primary"
                  circular
                  size={isTv ? 54 : 48}
                  iconSize={isTv ? 24 : 20}
                  loading={p.isBuffering === true}
                  icon={p.isPausedOrEnded ? 'play' : 'pause'}
                  accessibilityLabel={
                    p.isPausedOrEnded ? i18n.t('player.play') : i18n.t('player.pause')
                  }
                  {...(isDesktop ? { keyShortcuts: PLAYER_KEY_SHORTCUTS.playPause } : {})}
                  onPress={p.onTogglePlayPause}
                  isTv={isTv}
                  tvFocused={isFocused('playPause')}
                />
              ) : null}
              {p.canZap ? (
                <OsdButton
                  testID="player-next"
                  icon="chevronRight"
                  variant="bare"
                  size={44}
                  iconSize={24}
                  accessibilityLabel={i18n.t('player.nextChannel')}
                  onPress={p.onNext}
                  isTv={isTv}
                />
              ) : null}
            </>
          ) : null}
        </View>

        <View style={styles.transportRight}>{!isNarrow ? actionPillsNode : null}</View>
      </View>
    </View>
  );
}

/** Flex-docked minimalist top bar rendered above `player-desktop-stage` in legacy child-HWND mode. */
export function DesktopDockedTopBar(p: PlayerOsdProps): ReactElement | null {
  const theme = useTheme();
  if ((p.osdTier ?? 'controls') === 'progress') return null;
  return (
    <View
      testID="player-osd-top"
      style={[styles.dockedTopBar, { backgroundColor: theme.colors.bgCanvas }]}
    >
      <PlayerOsdTopBar {...p} docked />
    </View>
  );
}

/**
 * Native-HWND flex-safe Desktop Cinema Bar docked cleanly below `player-desktop-stage`
 * when `overlayMode === 'docked'` (never uses `position: 'absolute'`).
 */
export function DesktopCinemaBar(p: PlayerOsdProps): ReactElement {
  const theme = useTheme();
  const {
    i18n,
    isVod,
    service,
    osdTier = 'controls',
    muted = false,
    volume = 100,
    playbackSpeed = 1,
  } = p;

  if (osdTier === 'progress') {
    return (
      <View
        testID="player-osd"
        style={[styles.dockedBottomBar, { backgroundColor: theme.colors.bgCanvas }]}
      >
        <DesktopPeekStrip
          title={p.title}
          channelDigits={p.channelDigits}
          isVod={isVod}
          isTv={false}
          muted={muted}
          volume={volume}
          playbackSpeed={playbackSpeed}
          chapters={p.chapters}
          timeDisplayMode={p.timeDisplayMode}
          wallClock={p.wallClock}
          nowNext={p.nowNext}
          nowMs={p.nowMs}
          previewPositionMs={p.previewPositionMs}
          service={service}
          clock={p.clock}
          i18n={i18n}
          onCycleTimeDisplayMode={p.onCycleTimeDisplayMode}
          onSeekRatio={p.onSeekRatio}
          onScrubbingChange={p.onScrubbingChange}
        />
      </View>
    );
  }

  return (
    <View
      testID="player-osd"
      style={[styles.dockedBottomBar, { backgroundColor: theme.colors.bgCanvas }]}
    >
      <View testID="player-osd-bottom">
        <PlayerOsdBottomBar {...p} docked />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dockedTopBar: { paddingHorizontal: 20, paddingVertical: 10 },
  dockedBottomBar: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 },
  bottomStack: { gap: 10 },
  narrowCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  transportLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  transportCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  transportRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    minWidth: 0,
  },
});
