import type { ElvCategorySource, ElvTitleFormat } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { SettingsPreferencesController } from './appearance-controls';
import type { ElvModeFocusId } from './useTvSettingsNavigation';

export const ELV_TITLE_FORMAT_OPTIONS: ReadonlyArray<{
  readonly value: ElvTitleFormat;
  readonly labelKey: MessageId;
  readonly testID: string;
}> = [
  {
    value: 'original',
    labelKey: 'settings.elvMode.titleFormat.original',
    testID: 'settings-elv-title-format-original',
  },
  {
    value: 'system',
    labelKey: 'settings.elvMode.titleFormat.system',
    testID: 'settings-elv-title-format-system',
  },
  {
    value: 'english',
    labelKey: 'settings.elvMode.titleFormat.english',
    testID: 'settings-elv-title-format-english',
  },
  {
    value: 'english_system',
    labelKey: 'settings.elvMode.titleFormat.english_system',
    testID: 'settings-elv-title-format-english_system',
  },
  {
    value: 'original_system',
    labelKey: 'settings.elvMode.titleFormat.original_system',
    testID: 'settings-elv-title-format-original_system',
  },
  {
    value: 'system_english',
    labelKey: 'settings.elvMode.titleFormat.system_english',
    testID: 'settings-elv-title-format-system_english',
  },
  {
    value: 'system_original',
    labelKey: 'settings.elvMode.titleFormat.system_original',
    testID: 'settings-elv-title-format-system_original',
  },
];

export const ELV_CATEGORY_SOURCE_OPTIONS: ReadonlyArray<{
  readonly value: ElvCategorySource;
  readonly labelKey: MessageId;
  readonly testID: string;
}> = [
  {
    value: 'imdb',
    labelKey: 'settings.elvMode.categorySource.imdb',
    testID: 'settings-elv-category-source-imdb',
  },
  {
    value: 'provider',
    labelKey: 'settings.elvMode.categorySource.provider',
    testID: 'settings-elv-category-source-provider',
  },
];

/** Optional action callbacks used when activating ELV Mode controls via 10-ft TV D-pad. */
export interface ElvModeControlActions {
  readonly onOpenDropdown?: (
    id: 'elv-title-format-dropdown' | 'elv-category-source-dropdown',
  ) => void;
}

/** Applies a 10-ft TV D-pad activation on an ELV Mode settings control (`#511`). */
export function activateElvModeControl(
  controlId: ElvModeFocusId,
  preferences?: SettingsPreferencesController,
  actions?: ElvModeControlActions,
): void {
  if (!preferences) return;
  const current = preferences.preferences;
  if (controlId === 'elv-master') {
    void preferences.updatePreferences({ elvModeEnabled: !current.elvModeEnabled });
    return;
  }
  if (!current.elvModeEnabled) return;

  if (controlId === 'elv-title-format-dropdown' || controlId === 'elv-category-source-dropdown') {
    actions?.onOpenDropdown?.(controlId);
    return;
  }
  if (controlId === 'elv-merge-versions') {
    void preferences.updatePreferences({ elvMergeVersions: !current.elvMergeVersions });
    return;
  }
  if (controlId === 'elv-enrich-metadata') {
    void preferences.updatePreferences({ elvEnrichMetadata: !current.elvEnrichMetadata });
    return;
  }
  if (controlId === 'elv-smart-recs') {
    void preferences.updatePreferences({
      elvSmartRecommendations: !current.elvSmartRecommendations,
    });
    return;
  }
  if (controlId === 'elv-xray') {
    void preferences.updatePreferences({ elvXrayEnabled: !current.elvXrayEnabled });
    return;
  }
  if (controlId === 'elv-live-enhance') {
    void preferences.updatePreferences({ elvLiveEnhance: !current.elvLiveEnhance });
    return;
  }
  if (controlId === 'elv-verify-quality') {
    void preferences.updatePreferences({ elvVerifyRealQuality: !current.elvVerifyRealQuality });
  }
}
