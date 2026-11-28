import type { AppI18n } from '@elv/i18n';
import type { Theme } from '@elv/ui-kit';
import { Fragment, type ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { AudioDeviceInfo } from '../ports/video-host';
import { SettingsRadioRow, SettingsToggleRow } from './PlayerSettingsRows';
import { formatSyncDelayMs } from './settings-menu-nav';
import {
  buildAudioDeviceRadioItems,
  buildAudioNormalizationToggle,
  buildDelayStepperItems,
  buildPitchLockToggle,
  type SettingsToggleDescriptor,
} from './settings-sheet-items';

/** Props of {@link PlayerAudioSettingsView}. */
export interface PlayerAudioSettingsViewProps {
  readonly isVod: boolean;
  readonly showAudioDelay: boolean;
  readonly audioDelayMs: number;
  readonly showAudioDevice: boolean;
  readonly audioDevices: readonly AudioDeviceInfo[];
  readonly activeAudioDevice: string;
  readonly audioNormalization?: boolean | undefined;
  readonly pitchLock?: boolean | undefined;
  readonly focusedIndex: number;
  readonly showCursor: boolean;
  readonly isTv: boolean;
  readonly theme: Theme;
  readonly i18n: AppI18n;
  readonly onAdjustAudioDelay?: ((deltaMs: number, reset?: boolean) => void) | undefined;
  readonly onSelectAudioDevice?: ((name: string) => void) | undefined;
  readonly onToggleAudioNormalization?: (() => void) | undefined;
  readonly onTogglePitchLock?: (() => void) | undefined;
}

/**
 * Level-2 `Audio settings` sub-view inside `PlayerSettingsSheet` (`Wave R4`):
 * Audio sync delay stepper (`-500ms/-100ms/0/+100ms/+500ms`), output device selector,
 * loudness normalization, and VOD pitch lock.
 */
export function PlayerAudioSettingsView({
  isVod,
  showAudioDelay,
  audioDelayMs,
  showAudioDevice,
  audioDevices,
  activeAudioDevice,
  audioNormalization,
  pitchLock,
  focusedIndex,
  showCursor,
  isTv,
  theme,
  i18n,
  onAdjustAudioDelay,
  onSelectAudioDevice,
  onToggleAudioNormalization,
  onTogglePitchLock,
}: PlayerAudioSettingsViewProps): ReactElement {
  const delayItems = showAudioDelay
    ? buildDelayStepperItems({
        kind: 'audio',
        delayMs: audioDelayMs,
        i18n,
        onAdjust: onAdjustAudioDelay,
      })
    : [];
  const deviceItems = showAudioDevice
    ? buildAudioDeviceRadioItems({
        audioDevices,
        activeAudioDevice,
        i18n,
        onSelectAudioDevice,
      })
    : [];

  const toggles: SettingsToggleDescriptor[] = [];
  if (onToggleAudioNormalization !== undefined) {
    toggles.push(
      buildAudioNormalizationToggle(audioNormalization, i18n, onToggleAudioNormalization),
    );
  }
  if (isVod && onTogglePitchLock !== undefined) {
    toggles.push(buildPitchLockToggle(pitchLock, i18n, onTogglePitchLock));
  }

  const deviceStart = delayItems.length;
  const toggleStart = deviceStart + deviceItems.length;

  return (
    <>
      {delayItems.length > 0 ? (
        <>
          <Text
            testID="player-audio-delay-header"
            style={[
              theme.typography.caption,
              styles.sectionHeader,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${i18n.t('player.audioDelay')} · ${formatSyncDelayMs(audioDelayMs)}`}
          </Text>
          {delayItems.map((item, idx) => (
            <SettingsRadioRow
              key={item.key}
              item={item}
              focused={showCursor && focusedIndex === idx}
              isTv={isTv}
              theme={theme}
            />
          ))}
        </>
      ) : null}

      {deviceItems.map((item, idx) => (
        <Fragment key={item.key}>
          {item.sectionHeader !== undefined ? (
            <Text
              style={[
                theme.typography.caption,
                styles.sectionHeader,
                { color: theme.colors.textSecondary },
              ]}
            >
              {item.sectionHeader}
            </Text>
          ) : null}
          <SettingsRadioRow
            item={item}
            focused={showCursor && focusedIndex === deviceStart + idx}
            isTv={isTv}
            theme={theme}
          />
        </Fragment>
      ))}

      {toggles.map((toggle, idx) => (
        <SettingsToggleRow
          key={toggle.testID}
          {...toggle}
          focused={showCursor && focusedIndex === toggleStart + idx}
          isTv={isTv}
          theme={theme}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { paddingTop: 8, paddingBottom: 2, paddingHorizontal: 10 },
});
