import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Props of {@link ExternalPlayerPromptOverlay}. */
export interface ExternalPlayerPromptOverlayProps {
  readonly visible: boolean;
  readonly title: string;
  readonly onChooseIntegrated: () => void;
  readonly onChooseExternal: () => void;
  readonly onCancel: () => void;
}

const BUTTON_COUNT = 3;

/**
 * Cinema Quietude in-tree overlay (never RN `<Modal>` on TV) prompting the user to play
 * inside ELV IPTV or hand off to an external player when External Player Mode is `'ask'` (`#406`).
 */
export function ExternalPlayerPromptOverlay({
  visible,
  title,
  onChooseIntegrated,
  onChooseExternal,
  onCancel,
}: ExternalPlayerPromptOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const isTv = formFactor === 'tv' || viewport.inputModality === 'tv';
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    if (visible) setFocusedIndex(0);
  }, [visible]);

  const stateRef = useRef({
    visible,
    focusedIndex,
    onChooseIntegrated,
    onChooseExternal,
    onCancel,
  });
  stateRef.current = {
    visible,
    focusedIndex,
    onChooseIntegrated,
    onChooseExternal,
    onCancel,
  };

  const handleKey = useCallback((event: KeyEvent): boolean => {
    const s = stateRef.current;
    if (!s.visible) return false;
    if (event.kind === 'press' && event.key === 'back') {
      s.onCancel();
      return true;
    }
    if (event.kind !== 'press' && event.kind !== 'repeat') return true;
    if (event.key === 'left' || event.key === 'up') {
      setFocusedIndex((prev) => (prev - 1 + BUTTON_COUNT) % BUTTON_COUNT);
      return true;
    }
    if (event.key === 'right' || event.key === 'down') {
      setFocusedIndex((prev) => (prev + 1) % BUTTON_COUNT);
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      if (s.focusedIndex === 0) s.onChooseIntegrated();
      else if (s.focusedIndex === 1) s.onChooseExternal();
      else s.onCancel();
      return true;
    }
    return true;
  }, []);

  useKeyInterpreter(handleKey);

  if (!visible) return null;

  return (
    <View
      testID="external-player-prompt-overlay"
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.bgCanvas,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      {isTv ? (
        <TvFocusAnchor testID="external-player-prompt-focus-anchor" hasTVPreferredFocus />
      ) : null}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.xl,
            gap: theme.spacing.md,
          },
          webBackdropBlur(16),
        ]}
      >
        <View style={{ gap: theme.spacing.xs }}>
          <Text
            testID="external-player-prompt-title"
            accessibilityRole="header"
            style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('player.externalPrompt.title')}
          </Text>
          {title.length > 0 ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.title, { color: theme.colors.textSecondary }]}
            >
              {title}
            </Text>
          ) : null}
          <Text style={[theme.typography.body, { color: theme.colors.textMuted }]}>
            {i18n.t('player.externalPrompt.subtitle')}
          </Text>
        </View>

        <View style={[styles.actionsRow, { gap: theme.spacing.sm }]}>
          <CtaButton
            testID="external-player-prompt-integrated"
            variant="primary"
            label={i18n.t('player.externalPrompt.integrated')}
            focused={isTv && focusedIndex === 0}
            focusable={!isTv}
            onPress={onChooseIntegrated}
          />
          <CtaButton
            testID="external-player-prompt-external"
            variant="secondary"
            label={i18n.t('player.externalPrompt.external')}
            focused={isTv && focusedIndex === 1}
            focusable={!isTv}
            onPress={onChooseExternal}
          />
          <CtaButton
            testID="external-player-prompt-cancel"
            variant="secondary"
            label={i18n.t('player.externalPrompt.cancel')}
            focused={isTv && focusedIndex === 2}
            focusable={!isTv}
            onPress={onCancel}
          />
        </View>
      </View>
    </View>
  );
}

/** Transient Cinema Quietude toast pill shown when external player handoff fails (`#406`). */
export function ExternalHandoffErrorToast({
  visible,
}: {
  readonly visible: boolean;
}): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  if (!visible) return null;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.toastWrap,
        {
          bottom: 28 + viewport.safeArea.bottom + viewport.overscan.y,
          left: viewport.overscan.x,
          right: viewport.overscan.x,
        },
      ]}
    >
      <View
        testID="external-player-handoff-error-toast"
        accessibilityLiveRegion="polite"
        style={[
          styles.toastPill,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.liveColor,
            borderRadius: theme.radius.pill,
          },
          webBackdropBlur(16),
        ]}
      >
        <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
          {i18n.t('player.externalHandoff.failed')}
        </Text>
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
    zIndex: 60,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.98,
  },
  card: {
    width: '100%',
    maxWidth: 520,
    borderWidth: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  toastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 28,
    zIndex: 65,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastPill: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderWidth: 1,
  },
});
