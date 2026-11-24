import type { KeyInput } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import {
  CtaButton,
  TextEntryBoundary,
  TvFocusAnchor,
  TvTextInput,
  type TvTextInputInstance,
  useTextEntrySuspension,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { isValidExternalSubtitleHttpUrl } from './subtitle-style-helpers';

const NOOP_TV_SUBSCRIBER = (): boolean => false;

type UrlOverlaySlot = 'url' | 'label' | 'submit' | 'cancel';

/** Props of {@link ExternalSubtitleUrlOverlay}. */
export interface ExternalSubtitleUrlOverlayProps {
  readonly visible: boolean;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  /** Returns `true` when accepted by `PlaybackService.addExternalSubtitle`, or `false` on failure. */
  readonly onSubmit: (input: { readonly uri: string; readonly label?: string }) => boolean;
  readonly onClose: () => void;
}

function UrlOverlayTvKeyTrap({
  onBack,
  onNavigate,
}: {
  readonly onBack: () => void;
  readonly onNavigate: (key: KeyInput['key']) => void;
}): ReactElement {
  const textEntry = useTextEntrySuspension();
  const callbacksRef = useRef({ onBack, onNavigate });
  callbacksRef.current = { onBack, onNavigate };

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    if (textEntry.isActive()) return false;
    if (input.action !== 'down' && input.action !== 'press') return true;
    if (input.key === 'back') {
      callbacksRef.current.onBack();
      return true;
    }
    callbacksRef.current.onNavigate(input.key);
    return true;
  });

  return <TvFocusAnchor testID="external-subtitle-url-tv-anchor" hasTVPreferredFocus />;
}

function ExternalSubtitleUrlOverlayBody({
  visible,
  isTv,
  i18n,
  onSubmit,
  onClose,
}: ExternalSubtitleUrlOverlayProps): ReactElement | null {
  const theme = useTheme();
  const [urlDraft, setUrlDraft] = useState('');
  const [labelDraft, setLabelDraft] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [focusedSlot, setFocusedSlot] = useState<UrlOverlaySlot>('url');
  const urlInputRef = useRef<TvTextInputInstance | null>(null);
  const labelInputRef = useRef<TvTextInputInstance | null>(null);

  useEffect(() => {
    if (!visible) return;
    setUrlDraft('');
    setLabelDraft('');
    setErrorText(null);
    setFocusedSlot('url');
  }, [visible]);

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

  const handleSubmit = useCallback(() => {
    const trimmedUrl = urlDraft.trim();
    if (!isValidExternalSubtitleHttpUrl(trimmedUrl)) {
      setErrorText(i18n.t('player.externalSubtitle.invalidUrl'));
      return;
    }
    const trimmedLabel = labelDraft.trim();
    const accepted = onSubmit({
      uri: trimmedUrl,
      ...(trimmedLabel.length > 0 ? { label: trimmedLabel } : {}),
    });
    if (!accepted) {
      setErrorText(i18n.t('player.externalSubtitle.failed'));
      return;
    }
    setErrorText(null);
  }, [i18n, labelDraft, onSubmit, urlDraft]);

  const handleTvNavigate = useCallback(
    (key: KeyInput['key']) => {
      if (key === 'down') {
        setFocusedSlot((prev) => (prev === 'url' ? 'label' : prev === 'label' ? 'submit' : prev));
        return;
      }
      if (key === 'up') {
        setFocusedSlot((prev) =>
          prev === 'submit' || prev === 'cancel' ? 'label' : prev === 'label' ? 'url' : prev,
        );
        return;
      }
      if (key === 'right') {
        setFocusedSlot((prev) => (prev === 'submit' ? 'cancel' : prev));
        return;
      }
      if (key === 'left') {
        setFocusedSlot((prev) => (prev === 'cancel' ? 'submit' : prev));
        return;
      }
      if (key === 'select') {
        if (focusedSlot === 'url') urlInputRef.current?.focus();
        else if (focusedSlot === 'label') labelInputRef.current?.focus();
        else if (focusedSlot === 'submit') handleSubmit();
        else onClose();
      }
    },
    [focusedSlot, handleSubmit, onClose],
  );

  if (!visible) return null;

  return (
    <View testID="external-subtitle-url-overlay" style={styles.root}>
      {isTv ? <UrlOverlayTvKeyTrap onBack={onClose} onNavigate={handleTvNavigate} /> : null}
      <Pressable
        testID="external-subtitle-url-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        testID="external-subtitle-url-dialog"
        style={[
          styles.dialog,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <Text
          testID="external-subtitle-url-title"
          style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('player.externalSubtitle.urlTitle')}
        </Text>

        <TvTextInput
          ref={urlInputRef}
          testID="external-subtitle-url-input"
          value={urlDraft}
          onChangeText={(next) => {
            setUrlDraft(next);
            if (errorText !== null) setErrorText(null);
          }}
          placeholder={i18n.t('player.externalSubtitle.urlPlaceholder')}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={i18n.t('player.externalSubtitle.urlTitle')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[
            styles.input,
            theme.typography.body,
            {
              color: theme.colors.textPrimary,
              backgroundColor: theme.colors.bgSurface,
              borderColor:
                isTv && focusedSlot === 'url'
                  ? theme.colors.focusRingColor
                  : theme.colors.surfaceBorder,
              borderWidth: isTv && focusedSlot === 'url' ? theme.focus.ringWidth : 1,
              borderRadius: theme.radius.button,
            },
          ]}
        />

        <TvTextInput
          ref={labelInputRef}
          testID="external-subtitle-label-input"
          value={labelDraft}
          onChangeText={setLabelDraft}
          placeholder={i18n.t('player.externalSubtitle.labelPlaceholder')}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={i18n.t('player.externalSubtitle.labelPlaceholder')}
          style={[
            styles.input,
            theme.typography.body,
            {
              color: theme.colors.textPrimary,
              backgroundColor: theme.colors.bgSurface,
              borderColor:
                isTv && focusedSlot === 'label'
                  ? theme.colors.focusRingColor
                  : theme.colors.surfaceBorder,
              borderWidth: isTv && focusedSlot === 'label' ? theme.focus.ringWidth : 1,
              borderRadius: theme.radius.button,
            },
          ]}
        />

        {errorText !== null ? (
          <Text
            testID="external-subtitle-url-error"
            accessibilityRole="alert"
            style={[theme.typography.caption, { color: theme.colors.liveColor }]}
          >
            {errorText}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <CtaButton
            testID="external-subtitle-url-submit"
            variant="primary"
            label={i18n.t('player.externalSubtitle.load')}
            focusable={!isTv}
            focused={isTv && focusedSlot === 'submit'}
            onPress={handleSubmit}
          />
          <CtaButton
            testID="external-subtitle-url-cancel"
            variant="secondary"
            label={i18n.t('sources.action.cancel')}
            focusable={!isTv}
            focused={isTv && focusedSlot === 'cancel'}
            onPress={onClose}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Cinema Quietude v2 in-tree external subtitle URL input overlay (`#32`).
 * Never uses React Native `<Modal>`; integrates `TextEntryBoundary`, exclusive `useTvKeyInterceptor`,
 * `TvTextInput`, and strict `http://` / `https://` URI validation.
 */
export function ExternalSubtitleUrlOverlay(
  props: ExternalSubtitleUrlOverlayProps,
): ReactElement | null {
  if (!props.visible) return null;
  return (
    <TextEntryBoundary>
      <ExternalSubtitleUrlOverlayBody {...props} />
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  dialog: {
    width: '100%',
    maxWidth: 520,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
  },
});
