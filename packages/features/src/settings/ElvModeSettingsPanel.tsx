import {
  DEFAULT_PREFERENCES,
  type ElvCategorySource,
  type ElvTitleFormat,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ElvModeInteractivePreview } from '../shared/ElvModeInteractivePreview';
import type { SettingsPreferencesController } from './appearance-controls';
import { ELV_CATEGORY_SOURCE_OPTIONS, ELV_TITLE_FORMAT_OPTIONS } from './elv-mode-controls';
import { type SettingsDropdownOption, SettingsDropdownRow } from './SettingsDropdownRow';
import { SettingsDivider, SettingsToggleRow } from './SettingsRowParts';
import type { ElvModeFocusId } from './useTvSettingsNavigation';

/** Props of {@link ElvModeSettingsPanel}. */
export interface ElvModeSettingsPanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused ELV Mode control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: ElvModeFocusId | null;
  /** Optional controlled TV dropdown modal id owned by `SettingsScreen`. */
  readonly openTvDropdownId?: 'elv-title-format-dropdown' | 'elv-category-source-dropdown' | null;
  /** Invoked when a TV dropdown modal opens or closes. */
  readonly onOpenTvDropdownChange?: (
    id: 'elv-title-format-dropdown' | 'elv-category-source-dropdown' | null,
  ) => void;
  /** Optional interactive preview slot rendered at the top of the panel (Wave E3 seam). */
  readonly previewSlot?: ReactNode;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;

/**
 * Cinema Quietude Settings -> ELV Mode preferences panel (`#511`):
 * optional top `previewSlot`, master ELV Mode switch, and all 8 independent enhancement controls
 * (multi-source merging, IMDb metadata enrichment, 7 title formats, category source, smart
 * recommendations, X-Ray, Live TV enhancement, and real quality verification).
 */
export function ElvModeSettingsPanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
  openTvDropdownId = null,
  onOpenTvDropdownChange,
  previewSlot,
}: ElvModeSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const featuresCardYRef = useRef<number | undefined>(undefined);
  const rowYRef = useRef<Partial<Record<ElvModeFocusId, number>>>({});
  const [openPopover, setOpenPopover] = useState<'titleFormat' | 'categorySource' | null>(null);

  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? DEFAULT_PREFERENCES;
  const elvEnabled = activePrefs.elvModeEnabled;

  const applyPatch = useCallback(
    (patch: PreferencesPatch): void => {
      if (suppliedPrefs) void suppliedPrefs.updatePreferences(patch);
    },
    [suppliedPrefs],
  );

  useEffect(() => {
    if (!elvEnabled) {
      if (openPopover !== null) setOpenPopover(null);
      if (openTvDropdownId !== null) onOpenTvDropdownChange?.(null);
    }
  }, [elvEnabled, onOpenTvDropdownChange, openPopover, openTvDropdownId]);

  useEffect(() => {
    if (!isTv || !focusedControlId) return;
    if (focusedControlId === 'elv-master') {
      scrollRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
      return;
    }
    const cardY = featuresCardYRef.current ?? 0;
    const rowY = rowYRef.current[focusedControlId];
    if (rowY !== undefined) {
      scrollRef.current?.scrollTo({
        y: Math.max(0, cardY + rowY - 12),
        animated: !theme.reduceMotion,
      });
    }
  }, [focusedControlId, isTv, theme.reduceMotion]);

  const titleFormatOptions = useMemo<readonly SettingsDropdownOption<ElvTitleFormat>[]>(
    () =>
      ELV_TITLE_FORMAT_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        testID: opt.testID,
      })),
    [i18n],
  );

  const categorySourceOptions = useMemo<readonly SettingsDropdownOption<ElvCategorySource>[]>(
    () =>
      ELV_CATEGORY_SOURCE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        testID: opt.testID,
      })),
    [i18n],
  );

  const recordRowY = useCallback((id: ElvModeFocusId) => {
    return (y: number) => {
      rowYRef.current[id] = y;
    };
  }, []);

  return (
    <ScrollView
      ref={scrollRef}
      testID="settings-panel-elvMode"
      {...(isTv ? { focusable: false } : {})}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
    >
      <View style={styles.headerBlock}>
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
          {i18n.t('settings.section.elvMode')}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('settings.elvMode.subtitle')}
        </Text>
      </View>

      {previewSlot !== undefined ? (
        previewSlot
      ) : (
        <ElvModeInteractivePreview
          elvModeEnabled={activePrefs.elvModeEnabled}
          mergeVersions={activePrefs.elvMergeVersions}
          enrichMetadata={activePrefs.elvEnrichMetadata}
          imdbCategories={activePrefs.elvCategorySource === 'imdb'}
          compact
        />
      )}

      <Surface tone="surface" bordered rounded="modal" style={styles.sectionCard}>
        <SettingsToggleRow
          testID="settings-elv-master-toggle"
          title={i18n.t('settings.elvMode.masterTitle')}
          description={i18n.t('settings.elvMode.masterDescription')}
          checked={elvEnabled}
          focused={focusedControlId === 'elv-master'}
          isTv={isTv}
          onToggle={() => applyPatch({ elvModeEnabled: !elvEnabled })}
        />
      </Surface>

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={[
          styles.sectionCard,
          openPopover !== null || openTvDropdownId !== null ? styles.elevatedCard : undefined,
        ]}
        onLayout={(e) => {
          featuresCardYRef.current = e.nativeEvent.layout.y;
        }}
      >
        <SettingsToggleRow
          testID="settings-elv-merge-versions"
          title={i18n.t('settings.elvMode.mergeVersions')}
          description={i18n.t('settings.elvMode.mergeVersionsDesc')}
          checked={activePrefs.elvMergeVersions}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-merge-versions'}
          isTv={isTv}
          onToggle={() => applyPatch({ elvMergeVersions: !activePrefs.elvMergeVersions })}
          onLayoutY={recordRowY('elv-merge-versions')}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-elv-enrich-metadata"
          title={i18n.t('settings.elvMode.enrichMetadata')}
          description={i18n.t('settings.elvMode.enrichMetadataDesc')}
          checked={activePrefs.elvEnrichMetadata}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-enrich-metadata'}
          isTv={isTv}
          onToggle={() => applyPatch({ elvEnrichMetadata: !activePrefs.elvEnrichMetadata })}
          onLayoutY={recordRowY('elv-enrich-metadata')}
        />

        <SettingsDivider />

        <SettingsDropdownRow
          testID="settings-elv-title-format"
          title={i18n.t('settings.elvMode.titleFormat')}
          description={i18n.t('settings.elvMode.titleFormatDesc')}
          options={titleFormatOptions}
          selectedValue={activePrefs.elvTitleFormat}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-title-format-dropdown'}
          isTv={isTv}
          open={
            elvEnabled &&
            (isTv && onOpenTvDropdownChange !== undefined
              ? openTvDropdownId === 'elv-title-format-dropdown'
              : openPopover === 'titleFormat')
          }
          onOpenChange={(next) => {
            if (!elvEnabled) return;
            if (isTv && onOpenTvDropdownChange !== undefined) {
              onOpenTvDropdownChange(next ? 'elv-title-format-dropdown' : null);
            } else {
              setOpenPopover((prev) =>
                next ? 'titleFormat' : prev === 'titleFormat' ? null : prev,
              );
            }
          }}
          onSelect={(elvTitleFormat) => applyPatch({ elvTitleFormat })}
          onLayoutY={recordRowY('elv-title-format-dropdown')}
        />

        <SettingsDivider />

        <SettingsDropdownRow
          testID="settings-elv-category-source"
          title={i18n.t('settings.elvMode.categorySource')}
          description={i18n.t('settings.elvMode.categorySourceDesc')}
          options={categorySourceOptions}
          selectedValue={activePrefs.elvCategorySource}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-category-source-dropdown'}
          isTv={isTv}
          open={
            elvEnabled &&
            (isTv && onOpenTvDropdownChange !== undefined
              ? openTvDropdownId === 'elv-category-source-dropdown'
              : openPopover === 'categorySource')
          }
          onOpenChange={(next) => {
            if (!elvEnabled) return;
            if (isTv && onOpenTvDropdownChange !== undefined) {
              onOpenTvDropdownChange(next ? 'elv-category-source-dropdown' : null);
            } else {
              setOpenPopover((prev) =>
                next ? 'categorySource' : prev === 'categorySource' ? null : prev,
              );
            }
          }}
          onSelect={(elvCategorySource) => applyPatch({ elvCategorySource })}
          onLayoutY={recordRowY('elv-category-source-dropdown')}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-elv-smart-recs"
          title={i18n.t('settings.elvMode.smartRecommendations')}
          description={i18n.t('settings.elvMode.smartRecommendationsDesc')}
          checked={activePrefs.elvSmartRecommendations}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-smart-recs'}
          isTv={isTv}
          onToggle={() =>
            applyPatch({ elvSmartRecommendations: !activePrefs.elvSmartRecommendations })
          }
          onLayoutY={recordRowY('elv-smart-recs')}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-elv-live-enhance"
          title={i18n.t('settings.elvMode.liveEnhance')}
          description={i18n.t('settings.elvMode.liveEnhanceDesc')}
          checked={activePrefs.elvLiveEnhance}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-live-enhance'}
          isTv={isTv}
          onToggle={() => applyPatch({ elvLiveEnhance: !activePrefs.elvLiveEnhance })}
          onLayoutY={recordRowY('elv-live-enhance')}
        />

        <SettingsDivider />

        <SettingsToggleRow
          testID="settings-elv-verify-quality"
          title={i18n.t('settings.elvMode.verifyRealQuality')}
          description={i18n.t('settings.elvMode.verifyRealQualityDesc')}
          checked={activePrefs.elvVerifyRealQuality}
          disabled={!elvEnabled}
          focused={focusedControlId === 'elv-verify-quality'}
          isTv={isTv}
          onToggle={() => applyPatch({ elvVerifyRealQuality: !activePrefs.elvVerifyRealQuality })}
          onLayoutY={recordRowY('elv-verify-quality')}
        />
      </Surface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  headerBlock: { gap: 4 },
  sectionCard: { padding: 18, gap: 14 },
  elevatedCard: { zIndex: 40 },
});
