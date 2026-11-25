import type { AppI18n } from '@elv/i18n';
import type { MultiViewTile } from '@elv/playback';
import {
  Icon,
  MicroPill,
  Tooltip,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { OpenVideoEngine } from '../ports/video-host';
import type { MultiViewTileAction } from './multiview-model';

/** Props of {@link MultiViewTileCard}. */
export interface MultiViewTileCardProps {
  readonly tile: MultiViewTile;
  readonly index: number;
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly isActiveAudio: boolean;
  readonly isTv: boolean;
  readonly tvFocused: boolean;
  /** Currently focused inline action button when TV D-pad tile-action mode is open on this tile. */
  readonly focusedAction?: MultiViewTileAction | null | undefined;
  readonly i18n: AppI18n;
  readonly onSelectAudio: (tileId: string) => void;
  readonly onRequestReplace: (tileId: string) => void;
  readonly onRemove: (tileId: string) => void;
}

/**
 * Single Cinema Quietude `16:9` Multi-View tile (`#34`, `#221`, `#232`, `Wave P3`):
 * renders the tile's live `VideoHost` surface with subtle active-audio border, hover/focus
 * top-right glass icon controls (Swap/Replace Channel + Close Tile) with tooltips, and a clean
 * bottom Swap Audio bar only on muted tiles.
 */
export function MultiViewTileCard({
  tile,
  index,
  openedEngine,
  isActiveAudio,
  isTv,
  tvFocused,
  focusedAction = null,
  i18n,
  onSelectAudio,
  onRequestReplace,
  onRemove,
}: MultiViewTileCardProps): ReactElement {
  const theme = useTheme();
  const isWeb = (Platform.OS as string) === 'web';
  const [hovered, setHovered] = useState(false);
  const actionModeActive = isTv && tvFocused && focusedAction !== null;
  const showChrome = isTv ? tvFocused : hovered || !isActiveAudio;
  const showActions = isTv ? tvFocused : hovered;
  const pointer = !isTv ? webCursorPointer() : undefined;
  const transition = webTransition(theme, 'border-color, background-color, opacity');

  const borderColor = isTv
    ? tvFocused && !actionModeActive
      ? theme.colors.focusRingColor
      : isActiveAudio
        ? theme.colors.accent
        : theme.colors.glassBorder
    : isActiveAudio
      ? theme.colors.accent
      : hovered
        ? theme.colors.textSecondary
        : theme.colors.glassBorder;

  const borderWidth = isTv
    ? tvFocused && !actionModeActive
      ? theme.focus.ringWidth
      : isActiveAudio
        ? 2
        : 1
    : isActiveAudio
      ? 2
      : 1;

  const cornerIconButtonStyle = (action: 'replace' | 'remove') => {
    const focused = actionModeActive && focusedAction === action;
    return [
      styles.cornerIconBtn,
      pointer,
      {
        backgroundColor: focused ? theme.colors.focusFill : theme.colors.glassBg,
        borderColor: focused ? theme.colors.focusRingColor : theme.colors.glassBorder,
        borderWidth: focused ? theme.focus.ringWidth : 1,
        borderRadius: theme.radius.pill,
      },
      webBackdropBlur(12),
    ];
  };

  const audioActionButtonStyle = () => {
    const focused = actionModeActive && focusedAction === 'audio';
    return [
      styles.actionBtn,
      pointer,
      {
        backgroundColor: focused ? theme.colors.focusFill : theme.colors.chipBg,
        borderColor: focused ? theme.colors.focusRingColor : theme.colors.chipBorder,
        borderWidth: focused ? theme.focus.ringWidth : 1,
        borderRadius: theme.radius.button,
      },
    ];
  };

  const statusText =
    tile.status === 'error'
      ? i18n.t('player.error.streamFailed')
      : tile.status === 'loading'
        ? i18n.t('player.status.tuning')
        : tile.title;

  const pointerHandlers = isWeb
    ? ({
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => setHovered(false),
      } as Record<string, unknown>)
    : undefined;

  return (
    <View
      {...pointerHandlers}
      style={[
        styles.card,
        transition,
        pointer,
        {
          backgroundColor: theme.colors.bgCard,
          borderColor,
          borderWidth,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <Pressable
        testID={`multiview-tile-${index}`}
        accessibilityRole="button"
        accessibilityLabel={`${tile.title} — ${
          isActiveAudio ? i18n.t('player.multiView.activeAudio') : i18n.t('player.multiView.muted')
        }`}
        accessibilityState={{ selected: isActiveAudio }}
        focusable={!isTv}
        onHoverIn={() => setHovered(true)}
        onHoverOut={!isWeb ? () => setHovered(false) : undefined}
        onPress={() => onSelectAudio(tile.tileId)}
        style={styles.cardPressArea}
      >
        <View
          testID={`multiview-tile-surface-${index}`}
          pointerEvents="none"
          focusable={false}
          style={styles.surfaceWrap}
        >
          {openedEngine !== undefined ? (
            openedEngine.renderSurface({
              statusText,
              failed: tile.status === 'error',
              osdVisible: false,
              testID: `multiview-surface-${tile.tileId}`,
            })
          ) : (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
          )}
        </View>

        {showChrome ? (
          <View
            testID={`multiview-tile-chrome-${index}`}
            pointerEvents="box-none"
            style={styles.chromeOverlay}
          >
            <View style={styles.topBar}>
              <View style={styles.topLeft}>
                <View
                  style={[
                    styles.titlePill,
                    {
                      backgroundColor: theme.colors.glassBg,
                      borderColor: theme.colors.glassBorder,
                      borderRadius: theme.radius.button,
                    },
                    webBackdropBlur(12),
                  ]}
                >
                  <Text
                    testID={`multiview-tile-title-${index}`}
                    numberOfLines={1}
                    style={[
                      theme.typography.caption,
                      styles.titleText,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {tile.title}
                  </Text>
                </View>
                <MicroPill
                  testID={`multiview-tile-audio-badge-${index}`}
                  label={
                    isActiveAudio
                      ? i18n.t('player.multiView.activeAudio')
                      : i18n.t('player.multiView.muted')
                  }
                  tone={isActiveAudio ? 'accent' : 'neutral'}
                />
              </View>

              {showActions ? (
                <View
                  testID={`multiview-tile-corner-actions-${index}`}
                  style={styles.cornerActions}
                >
                  <Tooltip
                    content={i18n.t('player.multiView.replaceChannel')}
                    placement="bottom"
                    disabled={isTv}
                  >
                    <Pressable
                      testID={`multiview-tile-replace-btn-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={i18n.t('player.multiView.replaceChannel')}
                      accessibilityState={{
                        selected: actionModeActive && focusedAction === 'replace',
                      }}
                      focusable={!isTv}
                      onPress={(event) => {
                        event.stopPropagation?.();
                        onRequestReplace(tile.tileId);
                      }}
                      style={cornerIconButtonStyle('replace')}
                    >
                      <Icon name="refresh" size={14} color={theme.colors.textPrimary} />
                    </Pressable>
                  </Tooltip>
                  <Tooltip
                    content={i18n.t('player.multiView.removeTile')}
                    placement="bottom"
                    disabled={isTv}
                  >
                    <Pressable
                      testID={`multiview-tile-remove-btn-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={i18n.t('player.multiView.removeTile')}
                      accessibilityState={{
                        selected: actionModeActive && focusedAction === 'remove',
                      }}
                      focusable={!isTv}
                      onPress={(event) => {
                        event.stopPropagation?.();
                        onRemove(tile.tileId);
                      }}
                      style={cornerIconButtonStyle('remove')}
                    >
                      <Icon name="close" size={14} color={theme.colors.textPrimary} />
                    </Pressable>
                  </Tooltip>
                </View>
              ) : null}
            </View>

            {showActions && !isActiveAudio ? (
              <View
                testID={`multiview-tile-actions-bar-${index}`}
                style={[
                  styles.actionsBar,
                  {
                    backgroundColor: theme.colors.glassBg,
                    borderTopColor: theme.colors.glassBorder,
                  },
                  webBackdropBlur(12),
                ]}
              >
                <Tooltip
                  content={i18n.t('player.multiView.swapAudio')}
                  placement="top"
                  disabled={isTv}
                >
                  <Pressable
                    testID={`multiview-tile-audio-btn-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={i18n.t('player.multiView.swapAudio')}
                    accessibilityState={{
                      selected: actionModeActive && focusedAction === 'audio',
                    }}
                    focusable={!isTv}
                    onPress={(event) => {
                      event.stopPropagation?.();
                      onSelectAudio(tile.tileId);
                    }}
                    style={audioActionButtonStyle()}
                  >
                    <Icon name="audio" size={14} color={theme.colors.textPrimary} />
                    <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
                      {i18n.t('player.multiView.swapAudio')}
                    </Text>
                  </Pressable>
                </Tooltip>
              </View>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    position: 'relative',
  },
  cardPressArea: {
    flex: 1,
    position: 'relative',
  },
  surfaceWrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chromeOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: 8,
  },
  topLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  titlePill: {
    flexShrink: 1,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  titleText: {
    fontWeight: '600',
  },
  cornerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  cornerIconBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
