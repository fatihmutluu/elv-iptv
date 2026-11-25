import {
  type ExternalPlayerMode,
  isValidExternalPlayerScheme,
  normalizeExternalPlayerScheme,
} from '@elv/domain';
import { Surface, useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { type SettingsChipOption, SettingsDivider, SettingsOptionRow } from './SettingsRowParts';
import type { PlaybackFocusId } from './useTvSettingsNavigation';

/** Props of {@link ExternalPlayerSettingsSection}. */
export interface ExternalPlayerSettingsSectionProps {
  readonly mode: ExternalPlayerMode;
  readonly customScheme: string;
  readonly modeOptions: readonly SettingsChipOption<ExternalPlayerMode>[];
  readonly focusedControlId: PlaybackFocusId | null;
  readonly isTv: boolean;
  readonly onSelectMode: (mode: ExternalPlayerMode) => void;
  readonly onChangeCustomScheme: (scheme: string) => void;
  readonly onLayoutY?: (y: number) => void;
}

/**
 * Mobile/TV External Player handoff settings card (`#406`): mode selector (`Off` / `Ask` / `Always`)
 * plus an optional validated custom URI scheme field when enabled.
 */
export function ExternalPlayerSettingsSection({
  mode,
  customScheme,
  modeOptions,
  focusedControlId,
  isTv,
  onSelectMode,
  onChangeCustomScheme,
  onLayoutY,
}: ExternalPlayerSettingsSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [draftScheme, setDraftScheme] = useState(customScheme);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraftScheme(customScheme);
    setInvalid(false);
  }, [customScheme]);

  const commitScheme = (raw: string): void => {
    const trimmed = raw.trim();
    if (!isValidExternalPlayerScheme(trimmed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const normalized = normalizeExternalPlayerScheme(trimmed, '');
    setDraftScheme(normalized);
    if (normalized !== customScheme) {
      onChangeCustomScheme(normalized);
    }
  };

  return (
    <Surface
      testID="settings-section-external-player"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.sectionCard}
      onLayout={onLayoutY !== undefined ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
    >
      <SettingsOptionRow
        title={i18n.t('settings.playback.externalPlayerTitle')}
        description={i18n.t('settings.playback.externalPlayerHint')}
        options={modeOptions}
        selectedValue={mode}
        focusedControlId={focusedControlId}
        isTv={isTv}
        onSelect={onSelectMode}
      />
      {mode !== 'off' && !isTv ? (
        <>
          <SettingsDivider />
          <View style={styles.schemeRow}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('settings.playback.externalPlayerSchemeLabel')}
            </Text>
            <TextInput
              testID="settings-playback-external-player-scheme-input"
              value={draftScheme}
              onChangeText={(text) => {
                setDraftScheme(text);
                if (isValidExternalPlayerScheme(text.trim())) {
                  setInvalid(false);
                }
              }}
              onBlur={() => commitScheme(draftScheme)}
              onSubmitEditing={() => commitScheme(draftScheme)}
              placeholder={i18n.t('settings.playback.externalPlayerSchemePlaceholder')}
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={i18n.t('settings.playback.externalPlayerSchemeLabel')}
              style={[
                theme.typography.body,
                styles.schemeInput,
                {
                  color: theme.colors.textPrimary,
                  backgroundColor: theme.colors.bgElevated,
                  borderColor: invalid ? theme.colors.liveColor : theme.colors.surfaceBorder,
                  borderRadius: theme.radius.button,
                },
              ]}
            />
          </View>
        </>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionCard: { padding: 18, gap: 14 },
  schemeRow: { gap: 8 },
  schemeInput: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
  },
});
