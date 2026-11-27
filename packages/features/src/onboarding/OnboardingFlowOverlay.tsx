import type { CatalogService, ProfileAvatarToken, ProfileRecord } from '@elv/data';
import type { PreferencesPatch, PreferencesSnapshot } from '@elv/domain';
import {
  TextEntryBoundary,
  TvFocusGuideRegion,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';
import { OnboardingElvModeStep } from './OnboardingElvModeStep';
import { OnboardingDynamicFooter, OnboardingImportBar } from './OnboardingImportBar';
import {
  type OnboardingAvatarSlotProps,
  OnboardingPersonalizeStep,
} from './OnboardingPersonalizeStep';
import { OnboardingBackBridge } from './OnboardingPrimitives';
import { OnboardingSourceStep } from './OnboardingSourceStep';
import { OnboardingSyncingStep } from './OnboardingSyncingStep';
import { OnboardingWaitingStage } from './OnboardingWaitingStage';
import { type OnboardingTransferSlotProps, OnboardingWelcomeStep } from './OnboardingWelcomeStep';
import {
  createInitialOnboardingSourceDraft,
  type OnboardingImportSnapshot,
  type OnboardingSourceDraft,
  type OnboardingStep,
  type PersonalizeCardIndex,
} from './onboarding-model';
import { PrivacyPolicyModal } from './PrivacyPolicyModal';

/** Props of {@link OnboardingFlowOverlay}. */
export interface OnboardingFlowOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly preferences: PreferencesSnapshot;
  readonly onUpdatePreferences: (patch: PreferencesPatch) => void;
  readonly activeProfile: ProfileRecord;
  readonly onUpdateProfile: (
    id: string,
    patch: { readonly name?: string; readonly avatarToken?: ProfileAvatarToken },
  ) => void;
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly pendingPairUri?: string | null | undefined;
  readonly importState: OnboardingImportSnapshot;
  readonly onStartImport: (sourceId: string) => void;
  readonly onRetryImport: () => void;
  readonly onResetImport: () => void;
  readonly onCommitConsent: (diagnosticsOptIn: boolean) => void;
  readonly onPrepareFreshProfile: () => void;
  readonly onRefreshProfiles: () => Promise<void>;
  readonly onComplete: (result: { readonly restoredSources: boolean }) => void;
  readonly renderTransferPanel?:
    | ((slot: OnboardingTransferSlotProps) => ReactElement | null)
    | undefined;
  readonly renderAvatarPreview: (slot: OnboardingAvatarSlotProps) => ReactElement;
  readonly hasLanPairing?: boolean | undefined;
  readonly renderLanQrOverlay?:
    | ((slot: {
        readonly visible: boolean;
        readonly onSourceAdded: (sourceId: string) => void;
        readonly onClose: () => void;
      }) => ReactElement | null)
    | undefined;
  /** Optional test seed for initial step (defaults to `'welcome'`). */
  readonly initialStep?: OnboardingStep | undefined;
  /** Optional test seed for initial personalization card (defaults to `0`). */
  readonly initialPersonalizeCard?: PersonalizeCardIndex | undefined;
}

/**
 * Full-screen Cinema Quietude v2 Wave E3 Smart First-Run Onboarding overlay (`#513`).
 * Renders strictly in-tree (zero RN `<Modal>`), supports 10-ft TV D-pad `TvFocusGuideRegion`,
 * Escape/Back safety, and lifts background source imports cleanly above all step transitions.
 */
export function OnboardingFlowOverlay({
  visible,
  catalog,
  preferences,
  onUpdatePreferences,
  activeProfile,
  onUpdateProfile,
  syncAccount,
  pendingPairUri,
  importState,
  onStartImport,
  onRetryImport,
  onResetImport,
  onCommitConsent,
  onPrepareFreshProfile,
  onRefreshProfiles,
  onComplete,
  renderTransferPanel,
  renderAvatarPreview,
  hasLanPairing = false,
  renderLanQrOverlay,
  initialStep = 'welcome',
  initialPersonalizeCard = 0,
}: OnboardingFlowOverlayProps): ReactElement | null {
  const theme = useTheme();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [personalizeCard, setPersonalizeCard] =
    useState<PersonalizeCardIndex>(initialPersonalizeCard);
  const [sourceDraft, setSourceDraft] = useState<OnboardingSourceDraft>(
    createInitialOnboardingSourceDraft,
  );
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [lanQrOpen, setLanQrOpen] = useState(false);
  const [elvDefaultPending, setElvDefaultPending] = useState(true);
  const [previousFailedSourceId, setPreviousFailedSourceId] = useState<string | null>(null);

  const elvDefaultAppliedRef = useRef(false);
  const welcomeBackRef = useRef<{ canGoBack: boolean; goBack: () => void }>({
    canGoBack: false,
    goBack: () => undefined,
  });

  useEffect(() => {
    if (importState.status === 'error' && importState.sourceId !== null) {
      setPreviousFailedSourceId(importState.sourceId);
    } else if (importState.status === 'ready') {
      setPreviousFailedSourceId(null);
    }
  }, [importState.sourceId, importState.status]);

  // Enable ELV Mode ON by default the first time Screen 3 is entered during onboarding (`#513`).
  useEffect(() => {
    if (!visible || step !== 'elvMode' || elvDefaultAppliedRef.current) return;
    elvDefaultAppliedRef.current = true;
    if (preferences.elvModeEnabled) {
      setElvDefaultPending(false);
    } else {
      onUpdatePreferences({ elvModeEnabled: true });
    }
  }, [onUpdatePreferences, preferences.elvModeEnabled, step, visible]);

  useEffect(() => {
    if (elvDefaultPending && preferences.elvModeEnabled) {
      setElvDefaultPending(false);
    }
  }, [elvDefaultPending, preferences.elvModeEnabled]);

  const handleElvModeUpdatePreferences = useCallback(
    (patch: PreferencesPatch) => {
      if (patch.elvModeEnabled !== undefined) {
        setElvDefaultPending(false);
      }
      onUpdatePreferences(patch);
    },
    [onUpdatePreferences],
  );

  const handleWelcomeSubPhaseChange = useCallback((canGoBack: boolean, goBack: () => void) => {
    welcomeBackRef.current = { canGoBack, goBack };
  }, []);

  const handleProceedExisting = useCallback(() => {
    setStep('syncing');
  }, []);

  const handleProceedFreshToSource = useCallback(() => {
    onPrepareFreshProfile();
    setStep('source');
  }, [onPrepareFreshProfile]);

  const handleSyncComplete = useCallback(
    (sourcesCount: number) => {
      if (sourcesCount > 0) {
        onComplete({ restoredSources: true });
      } else {
        onPrepareFreshProfile();
        setStep('source');
      }
    },
    [onComplete, onPrepareFreshProfile],
  );

  const handleSourceAdded = useCallback(
    (sourceId: string) => {
      const failedId =
        previousFailedSourceId ?? (importState.status === 'error' ? importState.sourceId : null);
      if (failedId !== null && sourceId !== failedId) {
        void catalog.removeSource(failedId).catch(() => {});
      }
      setPreviousFailedSourceId(null);
      setLanQrOpen(false);
      onStartImport(sourceId);
      setStep('elvMode');
    },
    [catalog, importState.sourceId, importState.status, onStartImport, previousFailedSourceId],
  );

  const handleBrowseWithoutSource = useCallback(() => {
    const failedId =
      previousFailedSourceId ?? (importState.status === 'error' ? importState.sourceId : null);
    if (failedId !== null) {
      void catalog.removeSource(failedId).catch(() => {});
    }
    setPreviousFailedSourceId(null);
    onResetImport();
    onComplete({ restoredSources: false });
  }, [
    catalog,
    importState.sourceId,
    importState.status,
    onComplete,
    onResetImport,
    previousFailedSourceId,
  ]);

  const handleEditSourceFromBar = useCallback(() => {
    setStep('source');
  }, []);

  const handleAdvanceStep = useCallback(() => {
    if (step === 'elvMode') {
      setPersonalizeCard(0);
      setStep('personalize');
      return;
    }
    if (step === 'personalize') {
      if (personalizeCard < 3) {
        setPersonalizeCard((personalizeCard + 1) as PersonalizeCardIndex);
        return;
      }
      if (importState.status === 'ready' || importState.status === 'idle') {
        onComplete({ restoredSources: false });
      } else {
        setStep('waiting');
      }
    }
  }, [importState.status, onComplete, personalizeCard, step]);

  const handleEnterApp = useCallback(() => {
    onComplete({ restoredSources: false });
  }, [onComplete]);

  const handleBack = useCallback(() => {
    if (privacyOpen) {
      setPrivacyOpen(false);
      return;
    }
    if (lanQrOpen) {
      setLanQrOpen(false);
      return;
    }
    if (step === 'welcome' && welcomeBackRef.current.canGoBack) {
      welcomeBackRef.current.goBack();
      return;
    }
    if (step === 'personalize') {
      if (personalizeCard > 0) {
        setPersonalizeCard((personalizeCard - 1) as PersonalizeCardIndex);
      } else {
        setStep('elvMode');
      }
    }
  }, [lanQrOpen, personalizeCard, privacyOpen, step]);

  if (!visible) return null;

  const showImportBar = step === 'elvMode' || step === 'personalize';
  const hasNextCustomStep = step === 'elvMode' || (step === 'personalize' && personalizeCard < 3);
  const elvEnabledEffective = elvDefaultPending ? true : preferences.elvModeEnabled;
  const maxWidth = step === 'elvMode' || step === 'personalize' ? 680 : 540;

  return (
    <TextEntryBoundary>
      <TvFocusGuideRegion
        testID="onboarding-focus-guide"
        enabled={isTv && !privacyOpen && !lanQrOpen}
        autoFocus
        trapFocusUp
        trapFocusDown
        trapFocusLeft
        trapFocusRight
        style={[
          styles.backdrop,
          {
            backgroundColor: theme.colors.scrimStrong,
            paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
            paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
          },
        ]}
      >
        <OnboardingBackBridge
          enabled={visible && !privacyOpen && !lanQrOpen}
          isTv={isTv}
          onBack={handleBack}
        />

        <View testID="onboarding-flow-overlay" style={styles.center}>
          <View
            style={[
              styles.panel,
              {
                maxWidth,
                backgroundColor: theme.colors.bgElevated,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.modal,
              },
              webBackdropBlur(20),
            ]}
          >
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {showImportBar ? (
                <OnboardingImportBar
                  importState={importState}
                  onRetry={onRetryImport}
                  onEditSource={handleEditSourceFromBar}
                />
              ) : null}

              {step === 'welcome' ? (
                <OnboardingWelcomeStep
                  syncAccount={syncAccount}
                  pendingPairUri={pendingPairUri}
                  renderTransferPanel={renderTransferPanel}
                  onOpenPrivacyPolicy={() => setPrivacyOpen(true)}
                  onCommitConsent={onCommitConsent}
                  onProceedExistingAccount={handleProceedExisting}
                  onProceedNewAccount={handleProceedFreshToSource}
                  onProceedGuest={handleProceedFreshToSource}
                  onSubPhaseChange={handleWelcomeSubPhaseChange}
                />
              ) : step === 'syncing' ? (
                <OnboardingSyncingStep
                  catalog={catalog}
                  syncAccount={syncAccount}
                  onRefreshProfiles={onRefreshProfiles}
                  onSyncComplete={handleSyncComplete}
                />
              ) : step === 'source' ? (
                <OnboardingSourceStep
                  catalog={catalog}
                  draft={sourceDraft}
                  onDraftChange={setSourceDraft}
                  hasLanPairing={hasLanPairing && renderLanQrOverlay !== undefined}
                  onOpenLanPairing={() => setLanQrOpen(true)}
                  onSourceAdded={handleSourceAdded}
                  onBrowseWithoutSource={handleBrowseWithoutSource}
                />
              ) : step === 'elvMode' ? (
                <OnboardingElvModeStep
                  preferences={preferences}
                  elvEnabledEffective={elvEnabledEffective}
                  onUpdatePreferences={handleElvModeUpdatePreferences}
                />
              ) : step === 'personalize' ? (
                <OnboardingPersonalizeStep
                  cardIndex={personalizeCard}
                  preferences={preferences}
                  onUpdatePreferences={onUpdatePreferences}
                  activeProfile={activeProfile}
                  onUpdateProfile={onUpdateProfile}
                  renderAvatarPreview={renderAvatarPreview}
                />
              ) : (
                <OnboardingWaitingStage
                  importState={importState}
                  onRetry={onRetryImport}
                  onEditSource={handleEditSourceFromBar}
                  onAutoEnterApp={handleEnterApp}
                />
              )}

              {showImportBar ? (
                <OnboardingDynamicFooter
                  importState={importState}
                  hasNextCustomStep={hasNextCustomStep}
                  onContinue={handleAdvanceStep}
                  onEnterApp={handleEnterApp}
                />
              ) : null}
            </ScrollView>
          </View>
        </View>
      </TvFocusGuideRegion>

      <PrivacyPolicyModal visible={privacyOpen} onClose={() => setPrivacyOpen(false)} />

      {renderLanQrOverlay?.({
        visible: lanQrOpen,
        onSourceAdded: handleSourceAdded,
        onClose: () => setLanQrOpen(false),
      }) ?? null}
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    width: '100%',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxHeight: '94%',
    borderWidth: 1,
    overflow: 'hidden',
  },
  scroll: { flexGrow: 0 },
  scrollContent: { padding: 24, gap: 16 },
});
