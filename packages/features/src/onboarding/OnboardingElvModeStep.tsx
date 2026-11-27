import type { PreferencesPatch, PreferencesSnapshot } from '@elv/domain';
import { useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ElvModeInteractivePreview } from '../shared/ElvModeInteractivePreview';
import { OnboardingSwitchRow } from './OnboardingPrimitives';

/** Props of {@link OnboardingElvModeStep}. */
export interface OnboardingElvModeStepProps {
  readonly preferences: PreferencesSnapshot;
  readonly elvEnabledEffective: boolean;
  readonly onUpdatePreferences: (patch: PreferencesPatch) => void;
}

/**
 * Onboarding Screen 3 (`#513`): Live 4-card interactive ELV Mode showcase using the shared
 * {@link ElvModeInteractivePreview} paired with master ELV Mode and 4 key sub-toggles.
 */
export function OnboardingElvModeStep({
  preferences,
  elvEnabledEffective,
  onUpdatePreferences,
}: OnboardingElvModeStepProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const imdbCategories = preferences.elvCategorySource === 'imdb';

  return (
    <View testID="onboarding-elv-step" style={styles.step}>
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('onboarding.elv.title')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('onboarding.elv.subtitle')}
        </Text>
      </View>

      <ElvModeInteractivePreview
        elvModeEnabled={elvEnabledEffective}
        mergeVersions={preferences.elvMergeVersions}
        enrichMetadata={preferences.elvEnrichMetadata}
        imdbCategories={imdbCategories}
      />

      <View style={styles.toggles}>
        <OnboardingSwitchRow
          testID="onboarding-elv-master-toggle"
          title={i18n.t('onboarding.elv.masterToggle')}
          checked={elvEnabledEffective}
          onToggle={() => onUpdatePreferences({ elvModeEnabled: !elvEnabledEffective })}
        />

        <View style={styles.subToggles}>
          <OnboardingSwitchRow
            testID="onboarding-elv-merge-toggle"
            title={i18n.t('onboarding.elv.mergeToggle')}
            checked={preferences.elvMergeVersions}
            disabled={!elvEnabledEffective}
            compact
            onToggle={() =>
              onUpdatePreferences({ elvMergeVersions: !preferences.elvMergeVersions })
            }
          />
          <OnboardingSwitchRow
            testID="onboarding-elv-posters-toggle"
            title={i18n.t('onboarding.elv.postersToggle')}
            checked={preferences.elvEnrichMetadata}
            disabled={!elvEnabledEffective}
            compact
            onToggle={() =>
              onUpdatePreferences({ elvEnrichMetadata: !preferences.elvEnrichMetadata })
            }
          />
          <OnboardingSwitchRow
            testID="onboarding-elv-categories-toggle"
            title={i18n.t('onboarding.elv.categoriesToggle')}
            checked={imdbCategories}
            disabled={!elvEnabledEffective}
            compact
            onToggle={() =>
              onUpdatePreferences({
                elvCategorySource: imdbCategories ? 'provider' : 'imdb',
              })
            }
          />
          <OnboardingSwitchRow
            testID="onboarding-elv-recs-toggle"
            title={i18n.t('onboarding.elv.recommendationsToggle')}
            checked={preferences.elvSmartRecommendations}
            disabled={!elvEnabledEffective}
            compact
            onToggle={() =>
              onUpdatePreferences({
                elvSmartRecommendations: !preferences.elvSmartRecommendations,
              })
            }
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  step: { width: '100%', gap: 14 },
  header: { gap: 4 },
  toggles: { gap: 10 },
  subToggles: { gap: 8, paddingLeft: 10 },
});
