import type { ItemRow, ProgrammeRow } from '@elv/data';
import {
  Icon,
  type IconName,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatChannelDisplayName } from './source-badge';

/** Props of {@link LiveContextMenu}. */
export interface LiveContextMenuProps {
  readonly visible: boolean;
  readonly channel: ItemRow | null;
  readonly channelIndex: number;
  readonly programme: ProgrammeRow | null;
  readonly isFavorite: boolean;
  readonly isTv: boolean;
  readonly cleanChannelTitles?: boolean;
  readonly onPlay: (channel: ItemRow, index: number) => void;
  readonly onToggleFavorite?: (channel: ItemRow) => void;
  readonly onShowProgrammeDetails?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow,
  ) => void;
  /** Optional extension slot for hiding a channel from the list (`#400`). */
  readonly onHideChannel?: (channel: ItemRow) => void;
  readonly onClose: () => void;
}

interface ContextActionItem {
  readonly id: 'play' | 'favorite' | 'details' | 'hide';
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly run: () => void;
}

function ContextMenuTvKeyTrap({
  onInput,
}: {
  readonly onInput: Parameters<typeof useTvKeyInterceptor>[0];
}): null {
  useTvKeyInterceptor(onInput);
  return null;
}

/**
 * In-tree Cinema Quietude Long-Press / Right-Click Context Menu (`#400`) — never uses RN `<Modal>`.
 * Traps 10-ft TV D-pad keys via `useTvKeyInterceptor` and desktop `Escape`, restoring originating
 * row/cell focus on close.
 */
export function LiveContextMenu({
  visible,
  channel,
  channelIndex,
  programme,
  isFavorite,
  isTv,
  cleanChannelTitles = false,
  onPlay,
  onToggleFavorite,
  onShowProgrammeDetails,
  onHideChannel,
  onClose,
}: LiveContextMenuProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedIdxRef = useRef(0);
  focusedIdxRef.current = focusedIdx;

  const actions = useMemo<readonly ContextActionItem[]>(() => {
    if (channel === null) return [];
    const list: ContextActionItem[] = [
      {
        id: 'play',
        testID: 'live-context-play',
        icon: 'play',
        label: i18n.t('live.context.play'),
        run: () => {
          onClose();
          onPlay(channel, channelIndex);
        },
      },
    ];
    if (onToggleFavorite !== undefined) {
      list.push({
        id: 'favorite',
        testID: 'live-context-favorite',
        icon: isFavorite ? 'starFilled' : 'star',
        label: i18n.t(isFavorite ? 'live.context.removeFavorite' : 'live.context.addFavorite'),
        run: () => {
          onClose();
          onToggleFavorite(channel);
        },
      });
    }
    if (programme !== null && onShowProgrammeDetails !== undefined) {
      list.push({
        id: 'details',
        testID: 'live-context-details',
        icon: 'info',
        label: i18n.t('live.context.programmeDetails'),
        run: () => {
          onClose();
          onShowProgrammeDetails(channel, channelIndex, programme);
        },
      });
    }
    if (onHideChannel !== undefined) {
      list.push({
        id: 'hide',
        testID: 'live-context-hide',
        icon: 'close',
        label: i18n.t('live.context.hideChannel'),
        run: () => {
          onClose();
          onHideChannel(channel);
        },
      });
    }
    return list;
  }, [
    channel,
    channelIndex,
    i18n,
    isFavorite,
    onClose,
    onHideChannel,
    onPlay,
    onShowProgrammeDetails,
    onToggleFavorite,
    programme,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset focused action whenever opened for a channel
  useEffect(() => {
    if (visible) {
      focusedIdxRef.current = 0;
      setFocusedIdx(0);
    }
  }, [visible, channel?.key]);

  const activateFocused = useCallback(() => {
    actions[focusedIdxRef.current]?.run();
  }, [actions]);

  const handleTvTrap = useCallback(
    (input: Parameters<Parameters<typeof useTvKeyInterceptor>[0]>[0]): boolean => {
      if (input.action !== 'down' && input.action !== 'press') return true;
      if (input.key === 'back' || input.key === 'menu') {
        onClose();
        return true;
      }
      if (input.key === 'up') {
        const next = Math.max(0, focusedIdxRef.current - 1);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        return true;
      }
      if (input.key === 'down') {
        const next = Math.min(Math.max(0, actions.length - 1), focusedIdxRef.current + 1);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        return true;
      }
      if (input.key === 'select') {
        activateFocused();
        return true;
      }
      return true;
    },
    [actions.length, activateFocused, onClose],
  );

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        onClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [onClose, visible]);

  if (!visible || channel === null) return null;

  const displayName = formatChannelDisplayName(channel.name, cleanChannelTitles);
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  return (
    <View testID="live-context-menu" style={styles.root}>
      {isTv ? <ContextMenuTvKeyTrap onInput={handleTvTrap} /> : null}
      <Pressable
        testID="live-context-menu-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
            {i18n.t('live.contextMenuTitle')}
          </Text>
          <Text
            numberOfLines={1}
            style={[theme.typography.title, { color: theme.colors.textPrimary }]}
          >
            {displayName}
          </Text>
        </View>
        <View style={styles.actionList}>
          {actions.map((action, idx) => {
            const focused = isTv && idx === focusedIdx;
            return (
              <Pressable
                key={action.id}
                testID={action.testID}
                focusable={!isTv}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={action.run}
                style={({ pressed }) => [
                  styles.actionRow,
                  {
                    borderRadius: theme.radius.button,
                    backgroundColor: focused
                      ? theme.colors.focusFill
                      : pressed
                        ? theme.colors.subtleHighlight
                        : 'transparent',
                    borderWidth: focused ? theme.focus.ringWidth : 1,
                    borderColor: focused ? theme.colors.focusRingColor : 'transparent',
                  },
                  cursor,
                  transition,
                ]}
              >
                <Icon
                  name={action.icon}
                  size={18}
                  color={focused ? theme.colors.textPrimary : theme.colors.textSecondary}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.body,
                    styles.flex1,
                    { color: theme.colors.textPrimary, fontWeight: focused ? '700' : '500' },
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 48,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  header: {
    gap: 2,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionList: { gap: 4 },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  flex1: { flex: 1 },
});
