import {
  AUDIO_PASSTHROUGH_CODECS,
  type AudioChannelLayout,
  type AudioPassthroughCodec,
} from '@elv/domain';
import { FilterChip, Surface, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toggleAudioPassthroughCodec } from './playback-controls';
import {
  type SettingsChipOption,
  SettingsDivider,
  SettingsOptionRow,
  SettingsToggleRow,
} from './SettingsRowParts';

const CODEC_LABELS: Readonly<Record<AudioPassthroughCodec, string>> = {
  ac3: 'AC3',
  eac3: 'E-AC3',
  dts: 'DTS',
  'dts-hd': 'DTS-HD',
  truehd: 'TrueHD',
};

/** Props of {@link DesktopAudioPassthroughSection}. */
export interface DesktopAudioPassthroughSectionProps {
  readonly audioPassthrough: boolean;
  readonly audioPassthroughCodecs: readonly AudioPassthroughCodec[];
  readonly audioExclusive: boolean;
  readonly audioAc3Encode: boolean;
  readonly audioChannelLayout: AudioChannelLayout;
  readonly channelLayoutOptions: readonly SettingsChipOption<AudioChannelLayout>[];
  readonly onTogglePassthrough: () => void;
  readonly onChangeCodecs: (next: readonly AudioPassthroughCodec[]) => void;
  readonly onToggleExclusive: () => void;
  readonly onToggleAc3Encode: () => void;
  readonly onSelectChannelLayout: (layout: AudioChannelLayout) => void;
}

/**
 * Desktop-only (`formFactor === 'desktop'`) Cinema Quietude audio output card (`#213`):
 * bitstream passthrough toggle, multi-select codec chips, exclusive device toggle,
 * real-time AC-3 encoding, and speaker channel layout selector.
 */
export function DesktopAudioPassthroughSection({
  audioPassthrough,
  audioPassthroughCodecs,
  audioExclusive,
  audioAc3Encode,
  audioChannelLayout,
  channelLayoutOptions,
  onTogglePassthrough,
  onChangeCodecs,
  onToggleExclusive,
  onToggleAc3Encode,
  onSelectChannelLayout,
}: DesktopAudioPassthroughSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <Surface
      testID="settings-section-desktop-audio"
      tone="surface"
      bordered
      rounded="modal"
      style={styles.sectionCard}
    >
      <SettingsToggleRow
        testID="settings-playback-toggle-audio-passthrough"
        title={i18n.t('settings.desktop.audioPassthroughTitle')}
        description={i18n.t('settings.desktop.audioPassthroughDescription')}
        checked={audioPassthrough}
        focused={false}
        isTv={false}
        onToggle={onTogglePassthrough}
      />

      <SettingsDivider />

      <View testID="settings-playback-passthrough-codecs" style={styles.rowHeader}>
        <View style={styles.rowText}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('settings.desktop.audioPassthroughCodecsTitle')}
          </Text>
        </View>
        <View style={[styles.chipRow, { gap: theme.spacing.xs }]}>
          {AUDIO_PASSTHROUGH_CODECS.map((codec) => {
            const selected = audioPassthroughCodecs.includes(codec);
            return (
              <FilterChip
                key={codec}
                testID={`settings-playback-passthrough-codec-${codec}`}
                label={CODEC_LABELS[codec]}
                selected={selected}
                focused={false}
                focusable={true}
                onPress={() =>
                  onChangeCodecs(toggleAudioPassthroughCodec(audioPassthroughCodecs, codec))
                }
              />
            );
          })}
        </View>
      </View>

      <SettingsDivider />

      <SettingsToggleRow
        testID="settings-playback-toggle-audio-exclusive"
        title={i18n.t('settings.desktop.audioExclusiveTitle')}
        description={i18n.t('settings.desktop.audioExclusiveDescription')}
        checked={audioExclusive}
        disabled={!audioPassthrough}
        focused={false}
        isTv={false}
        onToggle={onToggleExclusive}
      />

      <SettingsDivider />

      <SettingsToggleRow
        testID="settings-playback-toggle-audio-ac3-encode"
        title={i18n.t('settings.desktop.audioAc3EncodeTitle')}
        description={i18n.t('settings.desktop.audioAc3EncodeDescription')}
        checked={audioAc3Encode}
        focused={false}
        isTv={false}
        onToggle={onToggleAc3Encode}
      />

      <SettingsDivider />

      <SettingsOptionRow
        title={i18n.t('settings.desktop.audioChannelLayoutTitle')}
        options={channelLayoutOptions}
        selectedValue={audioChannelLayout}
        focusedControlId={null}
        isTv={false}
        onSelect={onSelectChannelLayout}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionCard: { padding: 18, gap: 14 },
  rowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 200, gap: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
