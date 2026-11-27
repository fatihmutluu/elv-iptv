import type { CatalogService } from '@elv/data';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  useI18n,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { OnboardingTextField } from './OnboardingPrimitives';
import {
  type OnboardingSourceDraft,
  type OnboardingSourceValidationError,
  validateOnboardingSourceDraft,
} from './onboarding-model';

type SourceMode = OnboardingSourceDraft['mode'];

/** Props of {@link OnboardingSourceStep}. */
export interface OnboardingSourceStepProps {
  readonly catalog: CatalogService;
  readonly draft: OnboardingSourceDraft;
  readonly onDraftChange: (next: OnboardingSourceDraft) => void;
  /** Optional previously failed source ID to clean up when resubmitting edited source details. */
  readonly previousFailedSourceId?: string | null | undefined;
  readonly hasLanPairing?: boolean | undefined;
  readonly onOpenLanPairing?: (() => void) | undefined;
  /** Invoked immediately after `addSource*` succeeds so the lifted coordinator starts import in background. */
  readonly onSourceAdded: (sourceId: string) => void;
  /** Subtle escape link allowing users to browse into the app without adding a source yet. */
  readonly onBrowseWithoutSource: () => void;
}

const MODE_TABS: readonly { readonly id: SourceMode; readonly labelKey: MessageId }[] = [
  { id: 'm3u', labelKey: 'sources.mode.m3u' },
  { id: 'xtream', labelKey: 'sources.mode.xtream' },
  { id: 'stalker', labelKey: 'sources.mode.stalker' },
];

/**
 * Onboarding Screen 2 (`#513`): M3U-first (`M3U` default, `Xtream Codes`, `Stalker`) compact
 * add-source form with optional LAN QR phone pairing and subtle "Browse without a source" escape.
 */
export function OnboardingSourceStep({
  catalog,
  draft,
  onDraftChange,
  previousFailedSourceId,
  hasLanPairing = false,
  onOpenLanPairing,
  onSourceAdded,
  onBrowseWithoutSource,
}: OnboardingSourceStepProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<OnboardingSourceValidationError | null>(null);

  const updateField = useCallback(
    <K extends keyof OnboardingSourceDraft>(key: K, value: OnboardingSourceDraft[K]) => {
      onDraftChange({ ...draft, [key]: value });
      if (error !== null) setError(null);
    },
    [draft, error, onDraftChange],
  );

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const validated = validateOnboardingSourceDraft(draft);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      if (previousFailedSourceId) {
        await catalog.removeSource(previousFailedSourceId).catch(() => undefined);
      }
      const added =
        validated.value.kind === 'link'
          ? await catalog.addSourceFromLink(validated.value.input)
          : await catalog.addSource(validated.value.input);
      if (!added.ok) {
        setError({
          messageId: 'source.error.storage',
          hintId: 'source.hint.storage',
        });
        return;
      }
      onSourceAdded(added.value.id);
    } catch {
      setError({
        messageId: 'source.error.storage',
        hintId: 'source.hint.storage',
      });
    } finally {
      setSubmitting(false);
    }
  }, [catalog, draft, onSourceAdded, previousFailedSourceId, submitting]);

  const cursorPointer = webCursorPointer();
  const tabTransition = webTransition(theme, 'color, border-color, background-color');

  return (
    <View testID="onboarding-source-step" style={styles.step}>
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('onboarding.source.title')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('onboarding.source.subtitle')}
        </Text>
      </View>

      <View
        testID="onboarding-source-tabs"
        accessibilityRole="tablist"
        style={[styles.tabRow, { borderBottomColor: theme.colors.surfaceBorder }]}
      >
        {MODE_TABS.map((tab) => {
          const selected = draft.mode === tab.id;
          return (
            <Pressable
              key={tab.id}
              testID={`onboarding-source-tab-${tab.id}`}
              accessibilityRole="tab"
              accessibilityLabel={i18n.t(tab.labelKey)}
              accessibilityState={{ selected }}
              aria-selected={selected}
              focusable
              onPress={() => updateField('mode', tab.id)}
              style={(state) => [
                styles.tabItem,
                cursorPointer,
                tabTransition,
                {
                  borderBottomColor: selected ? theme.colors.accent : 'transparent',
                  backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                  borderRadius: state.focused ? theme.radius.button : 0,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.title,
                  {
                    color: selected ? theme.colors.textPrimary : theme.colors.textSecondary,
                    fontWeight: selected ? '700' : '500',
                  },
                ]}
              >
                {i18n.t(tab.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.form}>
        {draft.mode === 'm3u' ? (
          <OnboardingTextField
            testID="onboarding-source-url"
            label={i18n.t('sources.field.playlistUrl')}
            value={draft.playlistUrl}
            onChangeText={(v) => updateField('playlistUrl', v)}
            placeholder={i18n.t('sources.placeholder.playlistUrl')}
            keyboardType="url"
            editable={!submitting}
            onSubmitEditing={() => {
              void handleSubmit();
            }}
          />
        ) : draft.mode === 'xtream' ? (
          <>
            <OnboardingTextField
              testID="onboarding-source-server"
              label={i18n.t('sources.field.server')}
              value={draft.server}
              onChangeText={(v) => updateField('server', v)}
              placeholder={i18n.t('sources.placeholder.server')}
              keyboardType="url"
              editable={!submitting}
            />
            <OnboardingTextField
              testID="onboarding-source-username"
              label={i18n.t('sources.field.username')}
              value={draft.username}
              onChangeText={(v) => updateField('username', v)}
              placeholder={i18n.t('sources.placeholder.username')}
              editable={!submitting}
            />
            <OnboardingTextField
              testID="onboarding-source-password"
              label={i18n.t('sources.field.password')}
              value={draft.password}
              onChangeText={(v) => updateField('password', v)}
              placeholder={i18n.t('sources.placeholder.password')}
              secureTextEntry
              editable={!submitting}
              onSubmitEditing={() => {
                void handleSubmit();
              }}
            />
          </>
        ) : (
          <>
            <OnboardingTextField
              testID="onboarding-source-portal"
              label={i18n.t('sources.stalker.portalUrlLabel')}
              value={draft.portalUrl}
              onChangeText={(v) => updateField('portalUrl', v)}
              placeholder={i18n.t('sources.stalker.portalUrlPlaceholder')}
              keyboardType="url"
              editable={!submitting}
            />
            <OnboardingTextField
              testID="onboarding-source-mac"
              label={i18n.t('sources.stalker.macLabel')}
              value={draft.macAddress}
              onChangeText={(v) => updateField('macAddress', v)}
              placeholder={i18n.t('sources.stalker.macPlaceholder')}
              editable={!submitting}
            />
            <OnboardingTextField
              testID="onboarding-source-serial"
              label={i18n.t('sources.stalker.serialLabel')}
              value={draft.serialNumber}
              onChangeText={(v) => updateField('serialNumber', v)}
              placeholder={i18n.t('sources.stalker.serialPlaceholder')}
              editable={!submitting}
            />
          </>
        )}

        <OnboardingTextField
          testID="onboarding-source-name"
          label={i18n.t('sources.field.name')}
          value={draft.name}
          onChangeText={(v) => updateField('name', v)}
          placeholder={i18n.t('sources.placeholder.name')}
          editable={!submitting}
        />

        {error !== null ? (
          <View testID="onboarding-source-error" style={styles.errorBox}>
            <Text style={[theme.typography.caption, { color: theme.colors.liveColor }]}>
              {i18n.t(error.messageId)}
            </Text>
            <Text style={[theme.typography.micro, { color: theme.colors.textSecondary }]}>
              {i18n.t(error.hintId)}
            </Text>
          </View>
        ) : null}

        <View style={styles.actionsRow}>
          <CtaButton
            testID="onboarding-source-submit"
            variant="primary"
            label={
              submitting
                ? i18n.t('sources.action.adding')
                : i18n.t('onboarding.source.continueAction')
            }
            disabled={submitting}
            hasTVPreferredFocus={isTv}
            onPress={() => {
              void handleSubmit();
            }}
          />
          {hasLanPairing && onOpenLanPairing !== undefined ? (
            <CtaButton
              testID="onboarding-source-lan-qr"
              variant="secondary"
              label={i18n.t('onboarding.source.pairPhoneAction')}
              disabled={submitting}
              onPress={onOpenLanPairing}
            />
          ) : null}
        </View>
      </View>

      <View style={[styles.escapeFooter, { borderTopColor: theme.colors.surfaceBorder }]}>
        <Pressable
          testID="onboarding-browse-without-source"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('onboarding.source.browseWithoutSource')}
          focusable
          onPress={onBrowseWithoutSource}
          style={(state) => [
            styles.escapeLink,
            cursorPointer,
            {
              borderRadius: theme.radius.button,
              backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
            },
          ]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
            {i18n.t('onboarding.source.browseWithoutSource')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  step: { width: '100%', gap: 16 },
  header: { gap: 6 },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, borderBottomWidth: 1 },
  tabItem: {
    minHeight: 40,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    justifyContent: 'center',
  },
  form: { gap: 12 },
  errorBox: { gap: 2 },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  escapeFooter: { paddingTop: 12, borderTopWidth: 1, alignItems: 'center' },
  escapeLink: { paddingHorizontal: 10, paddingVertical: 6 },
});
