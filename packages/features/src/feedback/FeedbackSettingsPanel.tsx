import type { PreferencesPatch, PreferencesSnapshot } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  FilterChip,
  Surface,
  TABULAR_NUMS_STYLE,
  TextEntryBoundary,
  TvFocusGuideRegion,
  TvTextInput,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { FeedbackCategoryId, FeedbackPort, TelemetryPort } from '../ports/wave-f9-ports';
import { useRouteActive } from '../shared';

const MAX_FEEDBACK_LENGTH = 2_000;

const STATIC_REDACTED_TELEMETRY_EXAMPLE = JSON.stringify(
  {
    sessionId: 'anon-session-redacted',
    platform: 'tv-mobile',
    events: [
      {
        kind: 'screen_transition',
        screen: 'home',
        durationMs: 42,
      },
      {
        kind: 'media_decode_failure',
        engine: 'media3',
        container: 'mpegts',
        videoCodec: 'hevc',
        audioCodec: 'eac3',
        errorCode: 'DECODER_INIT_FAILED',
        isLive: true,
      },
    ],
  },
  null,
  2,
);

const FEEDBACK_CATEGORIES: readonly {
  readonly id: FeedbackCategoryId;
  readonly labelKey: MessageId;
}[] = [
  { id: 'playback_issue', labelKey: 'feedback.catPlayback' },
  { id: 'channel_epg', labelKey: 'feedback.catChannelEpg' },
  { id: 'ui_remote', labelKey: 'feedback.catUiRemote' },
  { id: 'sync_account', labelKey: 'feedback.catSyncAccount' },
  { id: 'feature_request', labelKey: 'feedback.catFeature' },
  { id: 'other', labelKey: 'feedback.catOther' },
];

/** Structural preferences slice consumed by {@link FeedbackSettingsPanel}. */
export interface FeedbackPreferencesSlice {
  readonly preferences: Pick<PreferencesSnapshot, 'telemetryOptIn'>;
  readonly updatePreferences: (patch: PreferencesPatch) => unknown;
}

/** Props of {@link FeedbackSettingsPanel}. */
export interface FeedbackSettingsPanelProps {
  readonly telemetry?: TelemetryPort;
  readonly feedback?: FeedbackPort;
  readonly preferences?: FeedbackPreferencesSlice;
  /** Whether this Settings detail pane currently owns 10-foot TV remote focus. */
  readonly isActiveScope?: boolean;
  /** Returns TV focus from this panel back to the Settings sidebar. */
  readonly onBack?: () => void;
  /** Routes TV focus directly to the top navigation bar. */
  readonly onFocusTopNav?: () => void;
}

function FeedbackPanelTvBridge({
  isAtLeftEdge,
  onBack,
  onFocusTopNav,
}: {
  readonly isAtLeftEdge: () => boolean;
  readonly onBack?: () => void;
  readonly onFocusTopNav?: () => void;
}): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        if (onBack !== undefined) {
          onBack();
          return true;
        }
        if (onFocusTopNav !== undefined) {
          onFocusTopNav();
          return true;
        }
      }
      if (event.kind === 'press' && event.key === 'left' && isAtLeftEdge()) {
        if (onBack !== undefined) {
          onBack();
          return true;
        }
      }
      return false;
    },
    [isAtLeftEdge, onBack, onFocusTopNav],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * Cinema Quietude v2 Settings panel for Opt-In Runtime Telemetry (with live JSON payload preview)
 * and Feedback & Report Issue submission (`#458`).
 */
export function FeedbackSettingsPanel({
  telemetry,
  feedback,
  preferences,
  isActiveScope = true,
  onBack,
  onFocusTopNav,
}: FeedbackSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const routeActive = useRouteActive();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [localOptIn, setLocalOptIn] = useState<boolean>(
    () => preferences?.preferences.telemetryOptIn ?? telemetry?.isOptedIn() ?? false,
  );
  const [previewOpen, setPreviewOpen] = useState(false);

  const [category, setCategory] = useState<FeedbackCategoryId>('playback_issue');
  const [message, setMessage] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [messageFocused, setMessageFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'sent' | 'empty' | 'error'>('idle');

  const atLeftEdgeRef = useRef(true);
  useEffect(() => {
    if (isActiveScope) atLeftEdgeRef.current = true;
  }, [isActiveScope]);
  const isAtLeftEdge = useCallback(() => atLeftEdgeRef.current, []);

  const telemetryOptIn =
    preferences !== undefined ? preferences.preferences.telemetryOptIn : localOptIn;
  const queuedCount = telemetry?.queuedCount() ?? 0;
  const payloadPreview = telemetry?.getPayloadPreviewJson() ?? STATIC_REDACTED_TELEMETRY_EXAMPLE;

  const handleToggleTelemetry = useCallback(() => {
    const next = !telemetryOptIn;
    setLocalOptIn(next);
    telemetry?.setOptIn(next);
    void preferences?.updatePreferences({ telemetryOptIn: next });
  }, [preferences, telemetry, telemetryOptIn]);

  const handleSubmitFeedback = useCallback(async () => {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setSubmitStatus('empty');
      return;
    }
    if (!feedback) {
      setSubmitStatus('error');
      return;
    }
    setSending(true);
    setSubmitStatus('idle');
    try {
      const res = await feedback.submit({
        category,
        message: trimmed,
        includeDiagnostics,
      });
      if (res.ok) {
        setMessage('');
        setSubmitStatus('sent');
      } else {
        setSubmitStatus('error');
      }
    } catch {
      setSubmitStatus('error');
    } finally {
      setSending(false);
    }
  }, [category, feedback, includeDiagnostics, message]);

  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  return (
    <TextEntryBoundary>
      <TvFocusGuideRegion
        testID="settings-panel-feedback-focus-guide"
        enabled={isTv && routeActive}
        autoFocus={isActiveScope}
        style={styles.scroll}
      >
        <ScrollView
          testID="settings-panel-feedback"
          style={styles.scroll}
          contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
          keyboardShouldPersistTaps="handled"
        >
          {isTv && isActiveScope && (onBack !== undefined || onFocusTopNav !== undefined) ? (
            <FeedbackPanelTvBridge
              isAtLeftEdge={isAtLeftEdge}
              {...(onBack !== undefined ? { onBack } : {})}
              {...(onFocusTopNav !== undefined ? { onFocusTopNav } : {})}
            />
          ) : null}

          <Surface
            testID="telemetry-settings-card"
            tone="surface"
            bordered
            rounded="modal"
            style={styles.card}
          >
            <View style={styles.headerBlock}>
              <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
                {i18n.t('telemetry.title')}
              </Text>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('telemetry.subtitle')}
              </Text>
            </View>

            <Pressable
              testID="telemetry-opt-in-toggle"
              accessibilityRole="switch"
              accessibilityLabel={i18n.t('telemetry.optInLabel')}
              accessibilityState={{ checked: telemetryOptIn }}
              aria-checked={telemetryOptIn}
              focusable
              hasTVPreferredFocus={isTv && isActiveScope}
              onFocus={() => {
                atLeftEdgeRef.current = true;
              }}
              onPress={handleToggleTelemetry}
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
                style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
              >
                {i18n.t('telemetry.optInLabel')}
              </Text>
              <View
                style={[
                  styles.switchTrack,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: telemetryOptIn ? theme.colors.accent : theme.colors.bgSurface,
                    borderColor: telemetryOptIn ? theme.colors.accent : theme.colors.chipBorder,
                  },
                ]}
              >
                <View
                  style={[
                    styles.switchThumb,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: telemetryOptIn
                        ? theme.colors.accentContrast
                        : theme.colors.textPrimary,
                      alignSelf: telemetryOptIn ? 'flex-end' : 'flex-start',
                    },
                  ]}
                />
              </View>
            </Pressable>

            <View style={styles.telemetryMetaRow}>
              <Text
                testID="telemetry-queued-count"
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {`${i18n.t('telemetry.queuedLabel')}: ${queuedCount}`}
              </Text>
              <CtaButton
                testID="telemetry-preview-toggle"
                variant="secondary"
                label={
                  previewOpen
                    ? i18n.t('telemetry.hidePreviewAction')
                    : i18n.t('telemetry.previewAction')
                }
                onPress={() => setPreviewOpen((prev) => !prev)}
              />
            </View>

            {previewOpen ? (
              <View
                testID="telemetry-payload-preview"
                style={[
                  styles.previewBox,
                  {
                    backgroundColor: theme.colors.bgCanvas,
                    borderColor: theme.colors.surfaceBorder,
                    borderRadius: theme.radius.card,
                  },
                ]}
              >
                <Text
                  testID="telemetry-payload-preview-text"
                  selectable
                  style={[
                    theme.typography.caption,
                    { color: theme.colors.textSecondary, fontFamily: monoFont },
                  ]}
                >
                  {payloadPreview}
                </Text>
              </View>
            ) : null}
          </Surface>

          <Surface
            testID="feedback-form-card"
            tone="surface"
            bordered
            rounded="modal"
            style={styles.card}
          >
            <View style={styles.headerBlock}>
              <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
                {i18n.t('feedback.title')}
              </Text>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('feedback.subtitle')}
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('feedback.categoryLabel')}
              </Text>
              <View style={styles.chipRow}>
                {FEEDBACK_CATEGORIES.map((item) => (
                  <FilterChip
                    key={item.id}
                    testID={`feedback-cat-${item.id}`}
                    label={i18n.t(item.labelKey)}
                    selected={category === item.id}
                    onPress={() => setCategory(item.id)}
                  />
                ))}
              </View>
            </View>

            <View style={styles.field}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('feedback.messageLabel')}
              </Text>
              <View
                style={[
                  styles.textareaFrame,
                  transition,
                  {
                    backgroundColor: messageFocused ? theme.colors.focusFill : theme.colors.bgCard,
                    borderColor: messageFocused
                      ? theme.colors.focusRingColor
                      : theme.colors.chipBorder,
                    borderWidth: messageFocused ? theme.focus.ringWidth : 1,
                    borderRadius: theme.radius.button,
                  },
                ]}
              >
                <TvTextInput
                  testID="feedback-message-input"
                  value={message}
                  onChangeText={(next) => {
                    setMessage(next);
                    if (submitStatus === 'empty') setSubmitStatus('idle');
                  }}
                  placeholder={i18n.t('feedback.messagePlaceholder')}
                  placeholderTextColor={theme.colors.textMuted}
                  accessibilityLabel={i18n.t('feedback.messageLabel')}
                  multiline
                  maxLength={MAX_FEEDBACK_LENGTH}
                  editable={!sending}
                  onFocus={() => {
                    atLeftEdgeRef.current = true;
                    setMessageFocused(true);
                  }}
                  onBlur={() => setMessageFocused(false)}
                  style={[
                    theme.typography.body,
                    styles.textarea,
                    { color: theme.colors.textPrimary },
                  ]}
                />
              </View>
            </View>

            <Pressable
              testID="feedback-attach-diagnostics-toggle"
              accessibilityRole="switch"
              accessibilityLabel={i18n.t('feedback.attachDiagnosticsLabel')}
              accessibilityState={{ checked: includeDiagnostics }}
              aria-checked={includeDiagnostics}
              focusable
              onFocus={() => {
                atLeftEdgeRef.current = true;
              }}
              onPress={() => setIncludeDiagnostics((prev) => !prev)}
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
                {i18n.t('feedback.attachDiagnosticsLabel')}
              </Text>
              <View
                style={[
                  styles.switchTrack,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: includeDiagnostics
                      ? theme.colors.accent
                      : theme.colors.bgSurface,
                    borderColor: includeDiagnostics ? theme.colors.accent : theme.colors.chipBorder,
                  },
                ]}
              >
                <View
                  style={[
                    styles.switchThumb,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: includeDiagnostics
                        ? theme.colors.accentContrast
                        : theme.colors.textPrimary,
                      alignSelf: includeDiagnostics ? 'flex-end' : 'flex-start',
                    },
                  ]}
                />
              </View>
            </Pressable>

            {submitStatus === 'empty' ? (
              <Text
                testID="feedback-error"
                accessibilityLiveRegion="polite"
                style={[theme.typography.caption, { color: theme.colors.liveColor }]}
              >
                {i18n.t('feedback.errorEmpty')}
              </Text>
            ) : submitStatus === 'error' ? (
              <Text
                testID="feedback-error"
                accessibilityLiveRegion="polite"
                style={[theme.typography.caption, { color: theme.colors.liveColor }]}
              >
                {i18n.t('feedback.errorFailed')}
              </Text>
            ) : submitStatus === 'sent' ? (
              <Text
                testID="feedback-success"
                accessibilityLiveRegion="polite"
                style={[theme.typography.caption, { color: theme.colors.successColor }]}
              >
                {i18n.t('feedback.sentSuccess')}
              </Text>
            ) : null}

            <CtaButton
              testID="feedback-submit-btn"
              variant="primary"
              label={sending ? i18n.t('feedback.sendingStatus') : i18n.t('feedback.submitAction')}
              disabled={sending}
              onPress={() => {
                void handleSubmitFeedback();
              }}
            />
          </Surface>
        </ScrollView>
      </TvFocusGuideRegion>
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  card: { padding: 18, gap: 14 },
  headerBlock: { gap: 4 },
  flex1: { flex: 1 },
  toggleRow: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
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
  telemetryMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  previewBox: {
    borderWidth: 1,
    padding: 12,
  },
  field: { gap: 8 },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  textareaFrame: {
    minHeight: 96,
    borderWidth: 1,
  },
  textarea: {
    minHeight: 94,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
});
