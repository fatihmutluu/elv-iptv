import type { AppI18n } from '@elv/i18n';
import {
  type FormFactor,
  Icon,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Computed `16:9` bottom-right frame dimensions for the floating corner mini-player (`#233`). */
export interface MiniPlayerFrame {
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

const MIN_MINI_WIDTH = 220;
const MAX_MINI_WIDTH_DEFAULT = 320;
const MAX_MINI_WIDTH_TV = 360;
const PORTRAIT_BOTTOM_TAB_CLEARANCE = 68;

/**
 * Computes a `16:9` floating corner frame honoring `safeArea`, `overscan`, and portrait phone
 * bottom tab-bar clearance (`#233`).
 */
export function computeMiniPlayerFrame(input: {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly formFactor: FormFactor;
  readonly orientation: 'portrait' | 'landscape';
  readonly safeArea: { readonly right: number; readonly bottom: number };
  readonly overscan: { readonly x: number; readonly y: number };
}): MiniPlayerFrame {
  const safeW =
    Number.isFinite(input.viewportWidth) && input.viewportWidth > 0 ? input.viewportWidth : 1280;
  const maxWidth = input.formFactor === 'tv' ? MAX_MINI_WIDTH_TV : MAX_MINI_WIDTH_DEFAULT;
  const targetWidth = Math.round(safeW * (input.formFactor === 'phone' ? 0.56 : 0.28));
  const width = Math.max(MIN_MINI_WIDTH, Math.min(maxWidth, targetWidth));
  const height = Math.round((width * 9) / 16);
  const right = 16 + Math.max(0, input.safeArea.right) + Math.max(0, input.overscan.x);
  const portraitTabOffset =
    input.formFactor === 'phone' && input.orientation === 'portrait'
      ? PORTRAIT_BOTTOM_TAB_CLEARANCE
      : 0;
  const bottom =
    16 + portraitTabOffset + Math.max(0, input.safeArea.bottom) + Math.max(0, input.overscan.y);
  return { width, height, right, bottom };
}

/** Props of {@link FloatingMiniPlayerChrome}. */
export interface FloatingMiniPlayerChromeProps {
  readonly title: string;
  readonly subtitle?: string | null | undefined;
  readonly isLive: boolean;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  readonly onExpand: () => void;
  readonly onClose: () => void;
}

/**
 * Cinema Quietude v2 floating corner mini-player overlay controls (`#233`):
 * compact channel title pill + accessible Expand & Close actions layered over the
 * non-focusable persistent video surface so D-pad browsing is never trapped.
 */
export function FloatingMiniPlayerChrome({
  title,
  subtitle,
  isLive,
  isTv,
  i18n,
  onExpand,
  onClose,
}: FloatingMiniPlayerChromeProps): ReactElement {
  const theme = useTheme();
  const pointer = !isTv ? webCursorPointer() : undefined;
  const transition = webTransition(theme, 'background-color, border-color, opacity');

  return (
    <View testID="mini-player-chrome" pointerEvents="box-none" style={styles.overlay}>
      <View style={styles.topRow} pointerEvents="box-none">
        <Pressable
          testID="mini-player-surface-tap"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('player.miniPlayer.expand')}
          focusable={false}
          accessible={!isTv}
          onPress={onExpand}
          style={styles.tapArea}
        />
        <View style={styles.actionsRow}>
          <Pressable
            testID="mini-player-expand"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('player.miniPlayer.expand')}
            onPress={onExpand}
            style={({ pressed }) => [
              styles.iconButton,
              transition,
              pointer,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: pressed ? theme.colors.focusFill : theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
              },
              webBackdropBlur(12),
            ]}
          >
            <Icon name="fullscreen" size={16} color={theme.colors.textPrimary} />
          </Pressable>
          <Pressable
            testID="mini-player-close"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('player.miniPlayer.close')}
            onPress={onClose}
            style={({ pressed }) => [
              styles.iconButton,
              transition,
              pointer,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: pressed ? theme.colors.focusFill : theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
              },
              webBackdropBlur(12),
            ]}
          >
            <Icon name="close" size={16} color={theme.colors.textPrimary} />
          </Pressable>
        </View>
      </View>

      <View
        style={[
          styles.titleBar,
          {
            backgroundColor: theme.colors.glassBg,
            borderTopColor: theme.colors.glassBorder,
          },
          webBackdropBlur(14),
        ]}
      >
        {isLive ? (
          <View
            testID="mini-player-live-dot"
            style={[styles.liveDot, { backgroundColor: theme.colors.liveColor }]}
          />
        ) : null}
        <View style={styles.titleStack}>
          <Text
            testID="mini-player-title"
            numberOfLines={1}
            style={[
              theme.typography.caption,
              styles.titleText,
              { color: theme.colors.textPrimary },
            ]}
          >
            {title}
          </Text>
          {subtitle !== undefined && subtitle !== null && subtitle.trim().length > 0 ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.micro, { color: theme.colors.textSecondary }]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'space-between',
  },
  topRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    padding: 8,
  },
  tapArea: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 2,
  },
  iconButton: {
    width: 30,
    height: 30,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    flexShrink: 0,
  },
  titleStack: {
    flex: 1,
    minWidth: 0,
  },
  titleText: {
    fontWeight: '600',
  },
});
