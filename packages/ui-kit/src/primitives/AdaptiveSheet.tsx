import type { ReactElement, ReactNode } from 'react';
import {
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { useViewport } from '../viewport';

/** Props of {@link AdaptiveSheet}. */
export interface AdaptiveSheetProps {
  visible: boolean;
  title?: string;
  onDismiss: () => void;
  /** Accessible label for the backdrop dismiss press area. */
  dismissLabel?: string;
  /** Optional popover width override on landscape viewports (defaults to `300`). */
  popoverWidth?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: ReactNode;
}

/**
 * TV-safe non-`Modal` adaptive overlay (`UI_UX_PHILOSOPHY.md` §3).
 * Renders as a right-anchored floating popover (`300px`) on Landscape (`TV`, `PC`, `Tablet-L`,
 * `Phone-L`) and as an inset slide-up bottom sheet with grab handle on Portrait (`Phone-P`, `Tablet-P`).
 */
export function AdaptiveSheet({
  visible,
  title,
  onDismiss,
  dismissLabel,
  popoverWidth = 300,
  style,
  testID,
  children,
}: AdaptiveSheetProps): ReactElement | null {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();

  if (!visible) return null;

  const resolvedDismissLabel = dismissLabel ?? i18n.t('ui.dismiss');
  const isTv = viewport.inputModality === 'tv';
  const webBackdropProps =
    Platform.OS === 'web' ? ({ tabIndex: -1 } as Record<string, unknown>) : {};
  const isPortrait = viewport.orientation === 'portrait';
  const webGlass =
    Platform.OS === 'web'
      ? ({
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
        } as unknown as ViewStyle)
      : undefined;

  const panelStyle: ViewStyle = isPortrait
    ? {
        position: 'absolute',
        left: 10 + viewport.safeArea.left,
        right: 10 + viewport.safeArea.right,
        bottom: 10 + viewport.safeArea.bottom,
        borderRadius: theme.radius.modal,
      }
    : {
        position: 'absolute',
        top: 60 + viewport.safeArea.top + viewport.overscan.y,
        right: 16 + viewport.safeArea.right + viewport.overscan.x,
        width: popoverWidth,
        borderRadius: theme.radius.modal,
      };

  return (
    <View testID={testID} accessibilityViewIsModal style={[StyleSheet.absoluteFill, styles.root]}>
      <Pressable
        testID={testID ? `${testID}-backdrop` : undefined}
        focusable={false}
        accessible={!isTv}
        accessibilityRole="button"
        accessibilityLabel={resolvedDismissLabel}
        onPress={onDismiss}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
        {...webBackdropProps}
      />
      <View
        testID={testID ? `${testID}-panel` : undefined}
        style={[
          styles.panel,
          panelStyle,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            padding: theme.spacing.md,
          },
          webGlass,
          style,
        ]}
      >
        {isPortrait ? (
          <View
            testID={testID ? `${testID}-handle` : undefined}
            style={[styles.grabHandle, { backgroundColor: theme.colors.textMuted }]}
          />
        ) : null}
        {title !== undefined ? (
          <Text
            numberOfLines={1}
            style={[
              theme.typography.title,
              styles.title,
              { color: theme.colors.textPrimary, marginBottom: theme.spacing.sm },
            ]}
          >
            {title}
          </Text>
        ) : null}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    zIndex: 40,
  },
  panel: {
    borderWidth: 1,
    maxHeight: '80%',
  },
  grabHandle: {
    width: 36,
    height: 4,
    borderRadius: 999,
    alignSelf: 'center',
    marginBottom: 10,
    opacity: 0.55,
  },
  title: {
    includeFontPadding: false,
  },
});
