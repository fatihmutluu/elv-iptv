import type { CatalogService, SourceRow } from '@elv/data';
import type { DeinterlaceMode } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import type { ConnectionTracker, PlaybackClock, PlaybackTimers } from '@elv/playback';
import {
  Icon,
  IconButton,
  MicroPill,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useSafeHoverBridge,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { AdoptedPlaybackSession, ThermalDevicePort, VideoHost } from '../ports/video-host';
import { MultiViewChannelPicker } from './MultiViewChannelPicker';
import { MultiViewTileCard } from './MultiViewTileCard';
import {
  computeMultiViewGridLayout,
  formatMultiViewBannerText,
  getMultiViewTileActions,
  type MultiViewTileAction,
  moveMultiViewGridFocus,
  moveMultiViewTileActionFocus,
} from './multiview-model';
import { OsdVolumeSlider } from './OsdVolumeSlider';
import { OsdButton } from './PlayerOsdButton';
import { useMultiViewSession } from './useMultiViewSession';

/** Props of {@link MultiViewStage}. */
export interface MultiViewStageProps {
  readonly catalog: Pick<
    CatalogService,
    'resolveStream' | 'categories' | 'items' | 'allSourcesItems'
  > &
    Partial<Pick<CatalogService, 'seasons' | 'episodes' | 'itemDetail'>>;
  readonly videoHost: VideoHost;
  readonly tracker: ConnectionTracker;
  readonly sources: readonly SourceRow[];
  readonly thermalDevice?: ThermalDevicePort | undefined;
  readonly initialSeed?: PlayableEntry | undefined;
  readonly initialAdoptedSession?: AdoptedPlaybackSession | undefined;
  readonly onConsumeAdoptedSession?: ((session: AdoptedPlaybackSession) => void) | undefined;
  readonly playerVolume?: number | undefined;
  readonly onPersistPlayerVolume?: ((volume: number) => void) | undefined;
  readonly preferredAudioDevice?: string | undefined;
  readonly audioNormalization?: boolean | undefined;
  readonly pitchLock?: boolean | undefined;
  readonly deinterlaceMode?: DeinterlaceMode | undefined;
  readonly clock?: PlaybackClock;
  readonly timers?: PlaybackTimers;
  readonly onOnlineStreamActiveChange?: ((active: boolean) => void) | undefined;
  readonly onExit: (
    resumeTarget: PlayTarget | null,
    adoptedSession?: AdoptedPlaybackSession | null,
  ) => void;
}

type PickerMode =
  | { readonly kind: 'add' }
  | { readonly kind: 'replace'; readonly tileId: string }
  | null;

/**
 * Full-screen Cinema Quietude Multi-View Grid (`#34`, `#221`, `#232`, `Wave P3`):
 * pure `16:9` 2-tile / 4-tile grid (`gap: 6`), zero-reload entry & auto-solo exit handoff,
 * interactive header Volume + Mute control (`OsdVolumeSlider` + `useSafeHoverBridge`),
 * top-right tile Replace/Close controls, inline channel picker, and full 2D TV D-pad + desktop
 * Escape support.
 */
export function MultiViewStage({
  catalog,
  videoHost,
  tracker,
  sources,
  thermalDevice,
  initialSeed,
  initialAdoptedSession,
  onConsumeAdoptedSession,
  playerVolume,
  onPersistPlayerVolume,
  preferredAudioDevice,
  audioNormalization,
  pitchLock,
  deinterlaceMode,
  clock,
  timers,
  onOnlineStreamActiveChange,
  onExit,
}: MultiViewStageProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const isDesktop = viewport.formFactor === 'desktop';
  const pointer = !isTv ? webCursorPointer() : undefined;

  const session = useMultiViewSession({
    catalog,
    videoHost,
    tracker,
    sources,
    thermalDevice,
    initialSeed,
    initialAdoptedSession,
    onConsumeAdoptedSession,
    initialVolume: playerVolume,
    onPersistVolume: onPersistPlayerVolume,
    preferredAudioDevice,
    audioNormalization,
    pitchLock,
    deinterlaceMode,
    ...(clock !== undefined ? { clock } : {}),
    ...(timers !== undefined ? { timers } : {}),
  });

  const volumeBridge = useSafeHoverBridge({ disabled: !isDesktop });
  const handleVolumeDragStateChange = useCallback(
    (dragging: boolean) => {
      volumeBridge.setLocked(dragging);
    },
    [volumeBridge.setLocked],
  );

  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [focusedSlot, setFocusedSlot] = useState(0);
  const [tileActionFocus, setTileActionFocus] = useState<{
    readonly tileId: string;
    readonly actionIndex: number;
  } | null>(null);
  const exitingRef = useRef(false);

  const handleExit = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    void session.exitMultiView().then(({ resumeTarget, adoptedSession }) => {
      onExit(resumeTarget, adoptedSession);
    });
  }, [onExit, session]);

  const handleRemoveTile = useCallback(
    (tileId: string) => {
      if (exitingRef.current) return;
      void session.removeTile(tileId).then(({ removed, remainingCount }) => {
        if (!removed || exitingRef.current) return;
        if (remainingCount === 1) {
          exitingRef.current = true;
          void session.exitMultiView().then(({ resumeTarget, adoptedSession }) => {
            onExit(resumeTarget, adoptedSession);
          });
        } else if (remainingCount === 0) {
          exitingRef.current = true;
          onExit(null, null);
        }
      });
    },
    [onExit, session],
  );

  const { state, banner } = session;
  const hasOnlineTile = state.tiles.some((tile) => tile.isLocalOffline !== true);
  useEffect(() => {
    if (state.tiles.length === 0) return;
    onOnlineStreamActiveChange?.(hasOnlineTile);
  }, [hasOnlineTile, onOnlineStreamActiveChange, state.tiles.length]);

  useEffect(() => {
    return () => {
      onOnlineStreamActiveChange?.(false);
    };
  }, [onOnlineStreamActiveChange]);

  const grid = computeMultiViewGridLayout(
    state.tiles.length,
    state.effectiveMaxTiles,
    state.canAddTile,
  );
  const totalSlots = state.tiles.length + (grid.showEmptySlot ? 1 : 0);
  const clampedFocus = Math.max(0, Math.min(Math.max(0, totalSlots - 1), focusedSlot));

  const excludeItemKeys = useMemo(() => new Set(state.tiles.map((t) => t.itemKey)), [state.tiles]);

  const handlePickerSelect = useCallback(
    (entry: PlayableEntry) => {
      const mode = pickerMode;
      setPickerMode(null);
      if (mode?.kind === 'replace') {
        void session.replaceChannel(mode.tileId, entry);
      } else {
        session.addChannel(entry);
      }
    },
    [pickerMode, session],
  );

  const pickerOpenRef = useRef(false);
  pickerOpenRef.current = pickerMode !== null;
  const tilesRef = useRef(state.tiles);
  tilesRef.current = state.tiles;
  const activeAudioTileIdRef = useRef(state.activeAudioTileId);
  activeAudioTileIdRef.current = state.activeAudioTileId;
  const totalSlotsRef = useRef(totalSlots);
  totalSlotsRef.current = totalSlots;
  const focusRef = useRef(clampedFocus);
  focusRef.current = clampedFocus;
  const tileActionFocusRef = useRef(tileActionFocus);
  tileActionFocusRef.current = tileActionFocus;

  useEffect(() => {
    if (tileActionFocus === null) return;
    const focusedTile = state.tiles[clampedFocus];
    if (pickerMode !== null || focusedTile?.tileId !== tileActionFocus.tileId) {
      setTileActionFocus(null);
    }
  }, [clampedFocus, pickerMode, state.tiles, tileActionFocus]);

  const resolveFocusedAction = (tileId: string): MultiViewTileAction | null => {
    if (tileActionFocus === null || tileActionFocus.tileId !== tileId) return null;
    const actions = getMultiViewTileActions(state.activeAudioTileId === tileId);
    const idx = Math.max(0, Math.min(actions.length - 1, tileActionFocus.actionIndex));
    return actions[idx] ?? null;
  };

  useEffect(() => {
    if ((Platform.OS as string) !== 'web') return;
    const onKeyDown = (event: { key?: string; preventDefault?: () => void }) => {
      if (event.key === 'Escape' && !pickerOpenRef.current) {
        event.preventDefault?.();
        handleExit();
      }
    };
    const win = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
    };
    win.addEventListener?.('keydown', onKeyDown as (e: unknown) => void);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown as (e: unknown) => void);
    };
  }, [handleExit]);

  useKeyInterpreter((event: KeyEvent) => {
    if (pickerOpenRef.current) return false;
    const activeActionBar = tileActionFocusRef.current;
    if (activeActionBar !== null) {
      const tile = tilesRef.current.find((t) => t.tileId === activeActionBar.tileId);
      if (tile === undefined) {
        setTileActionFocus(null);
      } else {
        const actions = getMultiViewTileActions(activeAudioTileIdRef.current === tile.tileId);
        if (
          event.kind === 'press' &&
          (event.key === 'back' || event.key === 'menu' || event.key === 'up')
        ) {
          setTileActionFocus(null);
          return true;
        }
        if (
          (event.kind === 'press' || event.kind === 'repeat') &&
          (event.key === 'left' || event.key === 'right')
        ) {
          setTileActionFocus((prev) =>
            prev === null
              ? null
              : {
                  ...prev,
                  actionIndex: moveMultiViewTileActionFocus(
                    prev.actionIndex,
                    actions.length,
                    event.key,
                  ),
                },
          );
          return true;
        }
        if (event.kind === 'press' && event.key === 'select') {
          const clampedIdx = Math.max(0, Math.min(actions.length - 1, activeActionBar.actionIndex));
          const chosen = actions[clampedIdx];
          setTileActionFocus(null);
          if (chosen === 'audio') {
            session.selectAudioTile(tile.tileId);
          } else if (chosen === 'replace') {
            setPickerMode({ kind: 'replace', tileId: tile.tileId });
          } else if (chosen === 'remove') {
            handleRemoveTile(tile.tileId);
          }
          return true;
        }
        return true;
      }
    }
    if (event.kind === 'press' && event.key === 'back') {
      handleExit();
      return true;
    }
    if (
      (event.kind === 'press' && event.key === 'menu') ||
      (event.kind === 'long' && event.key === 'select')
    ) {
      const tile = tilesRef.current[focusRef.current];
      if (tile !== undefined) {
        setTileActionFocus({ tileId: tile.tileId, actionIndex: 0 });
        return true;
      }
      return false;
    }
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'left' || event.key === 'right' || event.key === 'up' || event.key === 'down')
    ) {
      setFocusedSlot((prev) => moveMultiViewGridFocus(prev, totalSlotsRef.current, event.key));
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const tile = tilesRef.current[focusRef.current];
      if (tile !== undefined) {
        session.selectAudioTile(tile.tileId);
      } else if (state.canAddTile) {
        setPickerMode({ kind: 'add' });
      }
      return true;
    }
    return false;
  });

  const bannerCopy = banner !== null ? formatMultiViewBannerText(banner, i18n) : null;
  const padH = (isTv ? 32 : 16) + viewport.overscan.x;
  const padTop = (isTv ? 20 : 12) + viewport.safeArea.top + viewport.overscan.y;
  const padBottom = (isTv ? 20 : 12) + viewport.safeArea.bottom + viewport.overscan.y;

  const row1Items = state.tiles.slice(0, 2);
  const row2Items = state.tiles.slice(2, 4);
  const emptyInRow1 = grid.showEmptySlot && row1Items.length < 2;
  const emptyInRow2 = grid.showEmptySlot && !emptyInRow1;

  return (
    <View
      testID="multiview-stage"
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.bgCanvas,
          paddingTop: padTop,
          paddingBottom: padBottom,
          paddingLeft: padH + viewport.safeArea.left,
          paddingRight: padH + viewport.safeArea.right,
        },
      ]}
    >
      {isTv && pickerMode === null ? (
        <TvFocusAnchor testID="multiview-tv-focus-anchor" hasTVPreferredFocus />
      ) : null}

      <View style={styles.header}>
        <IconButton
          testID="multiview-exit-button"
          icon="back"
          size={38}
          accessibilityLabel={i18n.t('player.multiView.exit')}
          focusable={!isTv}
          onPress={handleExit}
        />
        <Text
          testID="multiview-title"
          style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('player.multiView.title')}
        </Text>
        <MicroPill
          testID="multiview-tile-count"
          label={i18n.t('player.multiView.tileCount', { count: state.tiles.length })}
          tone="neutral"
        />
        {isTv ? (
          <MicroPill
            testID="multiview-tv-actions-hint"
            label={`${i18n.t('remote.longPressBadge')} · ${i18n.t('live.contextMenuTitle')}`}
            tone="neutral"
          />
        ) : null}
        <View style={styles.flex1} />

        {!isTv ? (
          <View testID="multiview-volume-control" style={styles.volumeWrap}>
            <View
              ref={volumeBridge.triggerRef as never}
              {...(isDesktop ? (volumeBridge.triggerProps as Record<string, unknown>) : {})}
            >
              <OsdButton
                testID="multiview-mute-button"
                icon={session.muted ? 'volumeMute' : 'audio'}
                variant="bare"
                size={38}
                accessibilityLabel={session.muted ? i18n.t('player.unmute') : i18n.t('player.mute')}
                tooltipPlacement="bottom"
                tooltipDisabled={volumeBridge.open}
                active={session.muted}
                onHoverIn={isDesktop ? () => volumeBridge.setOpen(true) : undefined}
                onPress={session.toggleMute}
                isTv={isTv}
              />
            </View>
            {isDesktop && volumeBridge.open ? (
              <View
                ref={volumeBridge.panelRef as never}
                testID="multiview-volume-popover-bridge"
                {...(volumeBridge.panelProps as Record<string, unknown>)}
                style={styles.volumePopoverBridge}
              >
                <View
                  testID="multiview-volume-popover"
                  style={[
                    styles.volumePopover,
                    {
                      backgroundColor: theme.colors.glassBg,
                      borderColor: theme.colors.glassBorder,
                      borderRadius: theme.radius.card,
                    },
                    webBackdropBlur(16),
                  ]}
                >
                  <OsdVolumeSlider
                    testID="multiview-volume-slider"
                    volume={session.volume}
                    muted={session.muted}
                    onChange={session.setVolume}
                    onDragStateChange={handleVolumeDragStateChange}
                    i18n={i18n}
                  />
                </View>
              </View>
            ) : !isDesktop ? (
              <View style={styles.volumeInline}>
                <OsdVolumeSlider
                  testID="multiview-volume-slider"
                  volume={session.volume}
                  muted={session.muted}
                  onChange={session.setVolume}
                  i18n={i18n}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        {!grid.showEmptySlot ? (
          <Pressable
            testID="multiview-add-button"
            disabled={!state.canAddTile}
            focusable={!isTv && state.canAddTile}
            accessibilityRole="button"
            accessibilityLabel={i18n.t('player.multiView.addChannel')}
            accessibilityState={{ disabled: !state.canAddTile }}
            onPress={() => {
              if (state.canAddTile) setPickerMode({ kind: 'add' });
            }}
            style={[
              styles.addButton,
              pointer,
              {
                borderRadius: theme.radius.button,
                backgroundColor: state.canAddTile ? theme.colors.ctaBg : theme.colors.chipBg,
                borderColor: theme.colors.glassBorder,
                opacity: state.canAddTile ? 1 : 0.45,
              },
            ]}
          >
            <Icon
              name="plus"
              size={16}
              color={state.canAddTile ? theme.colors.ctaFg : theme.colors.textMuted}
            />
            <Text
              style={[
                theme.typography.caption,
                styles.addLabel,
                { color: state.canAddTile ? theme.colors.ctaFg : theme.colors.textMuted },
              ]}
            >
              {i18n.t('player.multiView.addChannel')}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {bannerCopy !== null && banner !== null ? (
        <View
          testID={`multiview-banner-${banner.kind}`}
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor:
                bannerCopy.tone === 'danger' ? theme.colors.liveColor : theme.colors.accent,
              borderRadius: theme.radius.card,
            },
            webBackdropBlur(14),
          ]}
        >
          <Icon
            name="warning"
            size={18}
            color={bannerCopy.tone === 'danger' ? theme.colors.liveColor : theme.colors.accent}
          />
          <View style={styles.bannerCopy}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {bannerCopy.title}
            </Text>
            {bannerCopy.body !== undefined ? (
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {bannerCopy.body}
              </Text>
            ) : null}
          </View>
          <IconButton
            testID="multiview-banner-dismiss"
            icon="close"
            size={32}
            accessibilityLabel={i18n.t('player.close')}
            focusable={!isTv}
            onPress={session.dismissBanner}
          />
        </View>
      ) : null}

      <View testID="multiview-grid" style={styles.grid}>
        <View style={styles.gridRow}>
          {row1Items.map((tile, idx) => (
            <MultiViewTileCard
              key={tile.tileId}
              tile={tile}
              index={idx}
              openedEngine={session.getTileEngine(tile.tileId)}
              isActiveAudio={state.activeAudioTileId === tile.tileId}
              isTv={isTv}
              tvFocused={isTv && clampedFocus === idx}
              focusedAction={
                isTv && clampedFocus === idx ? resolveFocusedAction(tile.tileId) : null
              }
              i18n={i18n}
              onSelectAudio={session.selectAudioTile}
              onRequestReplace={(id) => setPickerMode({ kind: 'replace', tileId: id })}
              onRemove={handleRemoveTile}
            />
          ))}
          {emptyInRow1 ? (
            <Pressable
              testID="multiview-empty-slot"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('player.multiView.emptySlot')}
              focusable={!isTv}
              onPress={() => setPickerMode({ kind: 'add' })}
              style={[
                styles.emptySlot,
                pointer,
                {
                  backgroundColor: theme.colors.bgSurface,
                  borderColor:
                    isTv && clampedFocus === row1Items.length
                      ? theme.colors.focusRingColor
                      : theme.colors.glassBorder,
                  borderWidth:
                    isTv && clampedFocus === row1Items.length ? theme.focus.ringWidth : 1,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              <Icon name="plus" size={24} color={theme.colors.textSecondary} />
              <Text style={[theme.typography.title, { color: theme.colors.textSecondary }]}>
                {i18n.t('player.multiView.emptySlot')}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {grid.rows === 2 ? (
          <View style={styles.gridRow}>
            {row2Items.map((tile, offset) => {
              const idx = 2 + offset;
              return (
                <MultiViewTileCard
                  key={tile.tileId}
                  tile={tile}
                  index={idx}
                  openedEngine={session.getTileEngine(tile.tileId)}
                  isActiveAudio={state.activeAudioTileId === tile.tileId}
                  isTv={isTv}
                  tvFocused={isTv && clampedFocus === idx}
                  focusedAction={
                    isTv && clampedFocus === idx ? resolveFocusedAction(tile.tileId) : null
                  }
                  i18n={i18n}
                  onSelectAudio={session.selectAudioTile}
                  onRequestReplace={(id) => setPickerMode({ kind: 'replace', tileId: id })}
                  onRemove={handleRemoveTile}
                />
              );
            })}
            {emptyInRow2 ? (
              <Pressable
                testID="multiview-empty-slot"
                accessibilityRole="button"
                accessibilityLabel={i18n.t('player.multiView.emptySlot')}
                focusable={!isTv}
                onPress={() => setPickerMode({ kind: 'add' })}
                style={[
                  styles.emptySlot,
                  pointer,
                  {
                    backgroundColor: theme.colors.bgSurface,
                    borderColor:
                      isTv && clampedFocus === state.tiles.length
                        ? theme.colors.focusRingColor
                        : theme.colors.glassBorder,
                    borderWidth:
                      isTv && clampedFocus === state.tiles.length ? theme.focus.ringWidth : 1,
                    borderRadius: theme.radius.card,
                  },
                ]}
              >
                <Icon name="plus" size={24} color={theme.colors.textSecondary} />
                <Text style={[theme.typography.title, { color: theme.colors.textSecondary }]}>
                  {i18n.t('player.multiView.emptySlot')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      <MultiViewChannelPicker
        visible={pickerMode !== null}
        title={
          pickerMode?.kind === 'replace'
            ? i18n.t('player.multiView.replaceChannel')
            : i18n.t('player.multiView.addChannel')
        }
        catalog={catalog}
        sources={sources}
        excludeItemKeys={excludeItemKeys}
        isTv={isTv}
        i18n={i18n}
        onSelect={handlePickerSelect}
        onClose={() => setPickerMode(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 20,
  },
  flex1: { flex: 1 },
  volumeWrap: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  volumePopoverBridge: {
    position: 'absolute',
    top: 38,
    right: 0,
    paddingTop: 6,
    zIndex: 40,
  },
  volumePopover: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
  },
  volumeInline: {
    paddingHorizontal: 4,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addLabel: {
    fontWeight: '600',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerCopy: {
    flex: 1,
    gap: 2,
  },
  grid: {
    flex: 1,
    justifyContent: 'center',
    gap: 6,
  },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  emptySlot: {
    flex: 1,
    aspectRatio: 16 / 9,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
});
