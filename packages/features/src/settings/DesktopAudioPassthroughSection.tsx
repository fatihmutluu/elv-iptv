import {
  AUDIO_PASSTHROUGH_CODECS,
  type AudioChannelLayout,
  type AudioPassthroughCodec,
} from '@elv/domain';
import {
  FilterChip,
  Icon,
  Surface,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { toggleAudioPassthroughCodec } from './playback-controls';
import { type SettingsDropdownOption, SettingsDropdownRow } from './SettingsDropdownRow';
import { SettingsDivider, SettingsToggleRow } from './SettingsRowParts';

const CODEC_LABELS: Readonly<Record<AudioPassthroughCodec, string>> = {
  ac3: 'AC3',
  eac3: 'E-AC3',
  dts: 'DTS',
  'dts-hd': 'DTS-HD',
  truehd: 'TrueHD',
};

/** Props of {@link DesktopAudioPassthroughSection}. */
export interface DesktopAudioPassthroughSectionProps {
  readonly preferredAudioDevice: string;
  readonly audioPassthrough: boolean;
  readonly audioPassthroughCodecs: readonly AudioPassthroughCodec[];
  readonly audioExclusive: boolean;
  readonly audioAc3Encode: boolean;
  readonly audioChannelLayout: AudioChannelLayout;
  readonly channelLayoutOptions: readonly SettingsDropdownOption<AudioChannelLayout>[];
  readonly onSelectAudioDevice: (device: string) => void;
  readonly onTogglePassthrough: () => void;
  readonly onChangeCodecs: (next: readonly AudioPassthroughCodec[]) => void;
  readonly onToggleExclusive: () => void;
  readonly onToggleAc3Encode: () => void;
  readonly onSelectChannelLayout: (layout: AudioChannelLayout) => void;
}

/**
 * Desktop-only (`formFactor === 'desktop'`) collapsible Cinema Quietude "Advanced audio" card (`#213`):
 * collapsed by default; when expanded shows Audio output device dropdown, Speaker channel layout dropdown,
 * and Audio passthrough toggle revealing codec chips, exclusive device mode, and AC-3 encode only when enabled.
 */
export function DesktopAudioPassthroughSection({
  preferredAudioDevice,
  audioPassthrough,
  audioPassthroughCodecs,
  audioExclusive,
  audioAc3Encode,
  audioChannelLayout,
  channelLayoutOptions,
  onSelectAudioDevice,
  onTogglePassthrough,
  onChangeCodecs,
  onToggleExclusive,
  onToggleAc3Encode,
  onSelectChannelLayout,
}: DesktopAudioPassthroughSectionProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [openPopover, setOpenPopover] = useState<'device' | 'layout' | null>(null);

  const savedAudioDevice = preferredAudioDevice.trim();
  const hasCustomAudioDevice = savedAudioDevice.length > 0 && savedAudioDevice !== 'auto';
  const audioDeviceOptions = useMemo<readonly SettingsDropdownOption<string>[]>(() => {
    const list: SettingsDropdownOption<string>[] = [
      {
        value: 'auto',
        label: i18n.t('player.audioDeviceAuto'),
        testID: 'settings-playback-audio-device-auto',
      },
    ];
    if (hasCustomAudioDevice) {
      list.push({
        value: savedAudioDevice,
        label: savedAudioDevice,
        testID: 'settings-playback-audio-device-current',
      });
    }
    return list;
  }, [hasCustomAudioDevice, i18n, savedAudioDevice]);

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <Surface
      testID="settings-section-desktop-audio"
      tone="surface"
      bordered
      rounded="modal"
      style={[styles.sectionCard, openPopover !== null ? styles.elevatedCard : undefined]}
    >
      <Pressable
        testID="settings-desktop-advanced-audio-toggle"
        accessibilityRole="button"
        accessibilityLabel={i18n.t('settings.playback.advancedAudioTitle')}
        accessibilityState={{ expanded }}
        onPress={() => {
          setExpanded((prev) => {
            if (prev) setOpenPopover(null);
            return !prev;
          });
        }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={[
          styles.headerToggle,
          cursor,
          transition,
          {
            borderRadius: theme.radius.card,
            backgroundColor: hovered ? theme.colors.subtleHighlight : 'transparent',
          },
        ]}
      >
        <View style={styles.rowText}>
          <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
            {i18n.t('settings.playback.advancedAudioTitle')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('settings.playback.advancedAudioDescription')}
          </Text>
        </View>
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          size={18}
          color={theme.colors.textSecondary}
        />
      </Pressable>

      {expanded ? (
        <>
          <SettingsDivider />

          {/* 1. Audio output device */}
          <SettingsDropdownRow
            testID="settings-playback-audio-device-dropdown"
            title={i18n.t('settings.playback.audioDevice')}
            options={audioDeviceOptions}
            selectedValue={hasCustomAudioDevice ? savedAudioDevice : 'auto'}
            isTv={false}
            open={openPopover === 'device'}
            onOpenChange={(next) =>
              setOpenPopover((prev) => (next ? 'device' : prev === 'device' ? null : prev))
            }
            onSelect={onSelectAudioDevice}
          />

          <SettingsDivider />

          {/* 2. Speaker channel layout */}
          <SettingsDropdownRow
            testID="settings-playback-channel-layout-dropdown"
            title={i18n.t('settings.desktop.audioChannelLayoutTitle')}
            options={channelLayoutOptions}
            selectedValue={audioChannelLayout}
            isTv={false}
            open={openPopover === 'layout'}
            onOpenChange={(next) =>
              setOpenPopover((prev) => (next ? 'layout' : prev === 'layout' ? null : prev))
            }
            onSelect={onSelectChannelLayout}
          />

          <SettingsDivider />

          {/* 3. Audio passthrough */}
          <SettingsToggleRow
            testID="settings-playback-toggle-audio-passthrough"
            title={i18n.t('settings.desktop.audioPassthroughTitle')}
            description={i18n.t('settings.desktop.audioPassthroughDescription')}
            checked={audioPassthrough}
            focused={false}
            isTv={false}
            onToggle={onTogglePassthrough}
          />

          {audioPassthrough ? (
            <>
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
            </>
          ) : null}
        </>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  sectionCard: { padding: 18, gap: 14 },
  elevatedCard: { zIndex: 40 },
  headerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginHorizontal: -8,
  },
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
