import type { AppI18n } from '@elv/i18n';
import type { MultiViewTile } from '@elv/playback';
import {
  Icon,
  MicroPill,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { OpenVideoEngine } from '../ports/video-host';

/** Props of {@link MultiViewTileCard}. */
export interface MultiViewTileCardProps {
  readonly tile: MultiViewTile;
  readonly index: number;
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly isActiveAudio: boolean;
  readonly isTv: boolean;
  readonly tvFocused: boolean;
  readonly i18n: AppI18n;
  readonly onSelectAudio: (tileId: string) => void;
  readonly onRequestReplace: (tileId: string) => void;
  readonly onRemove: (tileId: string) => void;
}

/**
 * Single Cinema Quietude `16:9` Multi-View tile (`#34`, `#221`, `#232`):
 * renders the tile's live `VideoHost` surface with subtle active-audio border and hover/focus-only
 * channel title, muted/audio-active badge, and Swap Audio / Replace / Remove actions.
 */
export function MultiViewTileCard({
  tile,
  index,
  openedEngine,
  isActiveAudio,
  isTv,
  tvFocused,
  i18n,
  onSelectAudio,
  onRequestReplace,
  onRemove,
}: MultiViewTileCardProps): ReactElement {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const showChrome = isTv ? tvFocused : hovered || !isActiveAudio;
  const showActions = isTv ? tvFocused : hovered;
  const pointer = !isTv ? webCursorPointer() : undefined;
  const transition = webTransition(theme, 'border-color, background-color, opacity');

  const borderColor = isTv
    ? tvFocused
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
    ? tvFocused
      ? theme.focus.ringWidth
      : isActiveAudio
        ? 2
        : 1
    : isActiveAudio
      ? 2
      : 1;

  const statusText =
    tile.status === 'error'
      ? i18n.t('player.error.streamFailed')
      : tile.status === 'loading'
        ? i18n.t('player.status.tuning')
        : tile.title;

  return (
    <Pressable
      testID={`multiview-tile-${index}`}
      accessibilityRole="button"
      accessibilityLabel={`${tile.title} — ${
        isActiveAudio ? i18n.t('player.multiView.activeAudio') : i18n.t('player.multiView.muted')
      }`}
      accessibilityState={{ selected: isActiveAudio }}
      focusable={!isTv}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => onSelectAudio(tile.tileId)}
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
              style={[
                styles.actionsBar,
                {
                  backgroundColor: theme.colors.glassBg,
                  borderTopColor: theme.colors.glassBorder,
                },
                webBackdropBlur(12),
              ]}
            >
              {!isActiveAudio ? (
                <Pressable
                  testID={`multiview-tile-audio-btn-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={i18n.t('player.multiView.swapAudio')}
                  focusable={!isTv}
                  onPress={() => onSelectAudio(tile.tileId)}
                  style={[
                    styles.actionBtn,
                    pointer,
                    {
                      backgroundColor: theme.colors.chipBg,
                      borderColor: theme.colors.chipBorder,
                      borderRadius: theme.radius.button,
                    },
                  ]}
                >
                  <Icon name="audio" size={14} color={theme.colors.textPrimary} />
                  <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
                    {i18n.t('player.multiView.swapAudio')}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                testID={`multiview-tile-replace-btn-${index}`}
                accessibilityRole="button"
                accessibilityLabel={i18n.t('player.multiView.replaceChannel')}
                focusable={!isTv}
                onPress={() => onRequestReplace(tile.tileId)}
                style={[
                  styles.actionBtn,
                  pointer,
                  {
                    backgroundColor: theme.colors.chipBg,
                    borderColor: theme.colors.chipBorder,
                    borderRadius: theme.radius.button,
                  },
                ]}
              >
                <Icon name="refresh" size={14} color={theme.colors.textPrimary} />
                <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
                  {i18n.t('player.multiView.replaceChannel')}
                </Text>
              </Pressable>
              <Pressable
                testID={`multiview-tile-remove-btn-${index}`}
                accessibilityRole="button"
                accessibilityLabel={i18n.t('player.multiView.removeTile')}
                focusable={!isTv}
                onPress={() => onRemove(tile.tileId)}
                style={[
                  styles.actionBtn,
                  pointer,
                  {
                    backgroundColor: theme.colors.chipBg,
                    borderColor: theme.colors.chipBorder,
                    borderRadius: theme.radius.button,
                  },
                ]}
              >
                <Icon name="close" size={14} color={theme.colors.textPrimary} />
                <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
                  {i18n.t('player.multiView.removeTile')}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    aspectRatio: 16 / 9,
    overflow: 'hidden',
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
  titlePill: {
    maxWidth: '68%',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  titleText: {
    fontWeight: '600',
  },
  actionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
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
