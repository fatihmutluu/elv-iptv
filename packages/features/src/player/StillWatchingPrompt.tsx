import type { AppI18n } from '@elv/i18n';
import { CtaButton, TABULAR_NUMS_STYLE, useTheme, webBackdropBlur } from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';

/** Props of {@link StillWatchingPrompt}. */
export interface StillWatchingPromptProps {
  readonly visible: boolean;
  readonly remainingSeconds: number;
  readonly isTv: boolean;
  /** When true (desktop child-HWND docked layout), docks cleanly outside the video stage instead of overlaying with `position: 'absolute'`. */
  readonly docked?: boolean;
  /** Currently focused action on TV remote (`continue` default, navigated via `usePlayerControls`). */
  readonly focusedAction?: 'continue' | 'stop';
  readonly i18n: AppI18n;
  readonly onKeepWatching: () => void;
  readonly onStopNow: () => void;
}

/**
 * Cinema Quietude idle still-watching prompt (`#118`):
 * displays a 60-second countdown with `Keep watching` (default focus) and `Stop now`.
 * TV remote keys are routed exclusively through `usePlayerControls` (blocking back/scrub/zap leaks);
 * desktop web uses {@link useDesktopDialogTrap} for `Escape`, focus trap, and focus restoration.
 */
export function StillWatchingPrompt({
  visible,
  remainingSeconds,
  isTv,
  docked = false,
  focusedAction = 'continue',
  i18n,
  onKeepWatching,
  onStopNow,
}: StillWatchingPromptProps): ReactElement | null {
  const theme = useTheme();
  const dialogRef = useRef<ComponentRef<typeof View> | null>(null);

  useDesktopDialogTrap(dialogRef, visible && !isTv, onKeepWatching, { modal: true });

  if (!visible) return null;

  return (
    <View
      testID="player-still-watching-prompt"
      style={[
        docked ? styles.dockedBackdrop : styles.backdrop,
        {
          backgroundColor: docked ? theme.colors.bgElevated : theme.colors.scrimStrong,
          borderTopColor: docked ? theme.colors.surfaceBorder : undefined,
        },
      ]}
    >
      <View
        ref={dialogRef}
        accessibilityViewIsModal
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <Text
          testID="player-still-watching-title"
          style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('player.stillWatchingTitle')}
        </Text>
        <Text
          testID="player-still-watching-body"
          style={[theme.typography.body, TABULAR_NUMS_STYLE, { color: theme.colors.textSecondary }]}
        >
          {i18n.t('player.stillWatchingBody', { seconds: remainingSeconds })}
        </Text>
        <View style={styles.actions}>
          <CtaButton
            testID="player-still-watching-continue"
            variant="primary"
            label={i18n.t('player.stillWatchingContinue')}
            focusable={!isTv}
            focused={isTv && focusedAction === 'continue'}
            onPress={onKeepWatching}
          />
          <CtaButton
            testID="player-still-watching-stop"
            variant="secondary"
            label={i18n.t('player.stillWatchingStop')}
            focusable={!isTv}
            focused={isTv && focusedAction === 'stop'}
            onPress={onStopNow}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 60,
  },
  dockedBackdrop: {
    borderTopWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    padding: 24,
    gap: 12,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 6,
  },
});
