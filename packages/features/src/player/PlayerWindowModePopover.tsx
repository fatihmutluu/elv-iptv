import type { AppI18n } from '@elv/i18n';
import { Icon, type IconName, useTheme, webBackdropBlur, webCursorPointer } from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';

/** Props of {@link PlayerWindowModePopover}. */
export interface PlayerWindowModePopoverProps {
  readonly visible: boolean;
  readonly i18n: AppI18n;
  readonly isTv: boolean;
  readonly docked?: boolean;
  readonly onMinimizeToMiniPlayer: () => void;
  readonly onPopoutPlayer: () => void;
  readonly onClose: () => void;
}

interface PopoverOption {
  readonly testID: string;
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
}

/**
 * Floating 2-option desktop Window Mode popover (`Mini player` / `Separate window`, `Wave R4`)
 * opened beneath `player-window-mode-button`, supporting backdrop click-outside and `Escape` dismiss.
 */
export function PlayerWindowModePopover({
  visible,
  i18n,
  isTv,
  docked = false,
  onMinimizeToMiniPlayer,
  onPopoutPlayer,
  onClose,
}: PlayerWindowModePopoverProps): ReactElement | null {
  const theme = useTheme();
  const isWeb = (Platform.OS as string) === 'web';
  const trapRef = useRef<ComponentRef<typeof View> | null>(null);
  useDesktopDialogTrap(trapRef, visible && !isTv, onClose);

  if (!visible) return null;

  const options: readonly PopoverOption[] = [
    {
      testID: 'player-window-mode-mini',
      icon: 'miniplayer',
      label: i18n.t('player.windowMode.mini'),
      onPress: () => {
        onClose();
        onMinimizeToMiniPlayer();
      },
    },
    {
      testID: 'player-window-mode-popout',
      icon: 'popout',
      label: i18n.t('player.windowMode.popout'),
      onPress: () => {
        onClose();
        onPopoutPlayer();
      },
    },
  ];

  const backdropWebProps = isWeb ? ({ tabIndex: -1 } as Record<string, unknown>) : undefined;
  const dialogA11yProps = isWeb
    ? ({
        role: 'dialog',
        'aria-modal': false,
        'aria-label': i18n.t('player.windowMode'),
      } as Record<string, unknown>)
    : undefined;

  return (
    <View ref={trapRef} pointerEvents="box-none" style={styles.overlayRoot}>
      <Pressable
        testID="player-window-mode-backdrop"
        accessible={false}
        aria-hidden
        focusable={false}
        {...backdropWebProps}
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View
        testID="player-window-mode-popover"
        {...dialogA11yProps}
        style={[
          docked ? styles.popoverDocked : styles.popoverFloating,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        {options.map((opt, idx) => (
          <Pressable
            key={opt.testID}
            testID={opt.testID}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            focusable={!isTv}
            onPress={opt.onPress}
            style={({ pressed }) => [
              styles.optionRow,
              idx > 0
                ? {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.surfaceBorder,
                  }
                : undefined,
              {
                borderRadius: theme.radius.button,
                backgroundColor: pressed ? theme.colors.focusFill : 'transparent',
              },
              !isTv ? webCursorPointer() : undefined,
            ]}
          >
            <Icon name={opt.icon} size={18} color={theme.colors.textPrimary} />
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlayRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 42,
  },
  popoverFloating: {
    position: 'absolute',
    top: 76,
    right: 76,
    minWidth: 210,
    borderWidth: 1,
    padding: 6,
  },
  popoverDocked: {
    position: 'absolute',
    top: 64,
    right: 68,
    minWidth: 210,
    borderWidth: 1,
    padding: 6,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
