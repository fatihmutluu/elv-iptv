import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  TvFocusGuideRegion,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

/** Props of {@link PrivacyConsentOverlay}. */
export interface PrivacyConsentOverlayProps {
  readonly visible: boolean;
  /** Initial opt-in toggle state (defaults to `false`). */
  readonly initialOptIn?: boolean;
  /** Invoked once the user confirms their diagnostics preference. */
  readonly onComplete: (telemetryOptIn: boolean) => void;
}

function PrivacyConsentTvBridge({ onBack }: { readonly onBack: () => void }): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onBack();
        return true;
      }
      return false;
    },
    [onBack],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * Cinema Quietude v2 in-tree Privacy & Diagnostics consent overlay (`#509`, `[1.6]`).
 * Shown once for upgrading or sync-less users who have not yet answered consent.
 * Never uses React Native `<Modal>`; fully navigable on 10-foot TV D-pad, desktop, and touch.
 */
export function PrivacyConsentOverlay({
  visible,
  initialOptIn = false,
  onComplete,
}: PrivacyConsentOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [optedIn, setOptedIn] = useState(initialOptIn);

  useEffect(() => {
    if (visible) {
      setOptedIn(initialOptIn);
    }
  }, [initialOptIn, visible]);

  const handleConfirm = useCallback(() => {
    onComplete(optedIn);
  }, [onComplete, optedIn]);

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return undefined;
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
        handleConfirm();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [handleConfirm, visible]);

  if (!visible) return null;

  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <TvFocusGuideRegion
      testID="privacy-consent-focus-guide"
      enabled={isTv}
      autoFocus
      trapFocusUp
      trapFocusDown
      trapFocusLeft
      trapFocusRight
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.overlayBackdrop,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      <View testID="privacy-consent-overlay" style={styles.overlayCenter}>
        {isTv ? <PrivacyConsentTvBridge onBack={handleConfirm} /> : null}

        <View
          style={[
            styles.panel,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.glassBorder,
              borderRadius: theme.radius.modal,
            },
            webBackdropBlur(20),
          ]}
        >
          <View style={styles.header}>
            <Text
              testID="privacy-consent-title"
              accessibilityRole="header"
              style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('privacy.consent.title')}
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {i18n.t('privacy.consent.body')}
            </Text>
          </View>

          <Pressable
            testID="privacy-consent-telemetry-toggle"
            accessibilityRole="switch"
            accessibilityLabel={i18n.t('privacy.consent.telemetryToggle')}
            accessibilityState={{ checked: optedIn }}
            aria-checked={optedIn}
            focusable
            onPress={() => setOptedIn((prev) => !prev)}
            style={(state) => [
              styles.toggleRow,
              cursorPointer,
              transition,
              {
                borderRadius: theme.radius.card,
                backgroundColor: state.focused ? theme.colors.focusFill : theme.colors.bgCard,
                borderWidth: state.focused ? theme.focus.ringWidth : 1,
                borderColor: state.focused
                  ? theme.colors.focusRingColor
                  : theme.colors.surfaceBorder,
              },
            ]}
          >
            <Text
              style={[theme.typography.body, styles.flex1, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('privacy.consent.telemetryToggle')}
            </Text>
            <View
              style={[
                styles.switchTrack,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: optedIn ? theme.colors.accent : theme.colors.bgSurface,
                  borderColor: optedIn ? theme.colors.accent : theme.colors.chipBorder,
                },
              ]}
            >
              <View
                style={[
                  styles.switchThumb,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: optedIn
                      ? theme.colors.accentContrast
                      : theme.colors.textPrimary,
                    alignSelf: optedIn ? 'flex-end' : 'flex-start',
                  },
                ]}
              />
            </View>
          </Pressable>

          <CtaButton
            testID="privacy-consent-continue-btn"
            variant="primary"
            label={i18n.t('privacy.consent.continue')}
            hasTVPreferredFocus={isTv}
            onPress={handleConfirm}
          />
        </View>
      </View>
    </TvFocusGuideRegion>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayCenter: {
    width: '100%',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 480,
    borderWidth: 1,
    padding: 24,
    gap: 16,
  },
  header: { gap: 8 },
  flex1: { flex: 1 },
  toggleRow: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  switchTrack: {
    width: 38,
    height: 22,
    borderWidth: 1,
    padding: 2,
    justifyContent: 'center',
  },
  switchThumb: {
    width: 16,
    height: 16,
  },
});
